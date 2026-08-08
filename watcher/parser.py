from __future__ import annotations

import re
from dataclasses import dataclass
from html.parser import HTMLParser

from .model import PRODUCT_TITLE, SLOTS, SlotStatus, stable_slot_key, normalize_slot_label


_SPACE_RE = re.compile(r"\s+")
_SOLD_OUT_RE = re.compile(r"(?:sold\s*out|売り切れ|完売)", re.IGNORECASE)


def normalize(text: str) -> str:
    return _SPACE_RE.sub(" ", text).strip()


@dataclass
class ParsedRoot:
    title: str | None
    inputs: list[tuple[str | None, str | None]]
    labels: dict[str, str]


class _StorefrontParser(HTMLParser):
    """Extract only hydrated storefronts, never the stale SSR storefront."""

    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self.roots: list[ParsedRoot] = []
        self._root_depth = 0
        self._current: ParsedRoot | None = None
        self._title_depth = 0
        self._title_parts: list[str] = []
        self._label_depth = 0
        self._label_for: str | None = None
        self._label_parts: list[str] = []

    def handle_starttag(self, tag: str, attrs_list: list[tuple[str, str | None]]) -> None:
        attrs = dict(attrs_list)
        classes = set((attrs.get("class") or "").split())

        if self._root_depth and tag == "div":
            self._root_depth += 1
        elif tag == "div" and "ec-storefront-v3" in classes and "ec-storefront-v3-ssr" not in classes:
            self._root_depth = 1
            self._current = ParsedRoot(title=None, inputs=[], labels={})

        if not self._root_depth or self._current is None:
            return

        if tag == "h1" and "product-details__product-title" in classes:
            self._title_depth = 1
            self._title_parts = []

        if tag == "input" and attrs.get("name") == "ご希望の日時":
            self._current.inputs.append((attrs.get("id"), attrs.get("value")))

        if tag == "label" and attrs.get("for"):
            self._label_depth = 1
            self._label_for = attrs["for"]
            self._label_parts = []

    def handle_endtag(self, tag: str) -> None:
        if not self._root_depth:
            return

        if self._title_depth and tag == "h1":
            self._title_depth = 0
            if self._current is not None:
                self._current.title = normalize("".join(self._title_parts))

        if self._label_depth and tag == "label":
            self._label_depth = 0
            if self._current is not None and self._label_for:
                self._current.labels[self._label_for] = normalize("".join(self._label_parts))
            self._label_for = None

        if tag == "div":
            self._root_depth -= 1
            if self._root_depth == 0 and self._current is not None:
                self.roots.append(self._current)
                self._current = None

    def handle_data(self, data: str) -> None:
        if self._title_depth:
            self._title_parts.append(data)
        if self._label_depth:
            self._label_parts.append(data)


def unknown_observation(reason: str) -> dict:
    return {
        "statuses": {slot.key: SlotStatus.UNKNOWN.value for slot in SLOTS},
        "evidence": {slot.key: reason for slot in SLOTS},
        "slots": {},
        "slot_set": [],
        "parser_ok": False,
        "error_class": reason,
    }


def parse_rendered_html(source: str) -> dict:
    parser = _StorefrontParser()
    try:
        parser.feed(source)
        parser.close()
    except (TypeError, ValueError):
        return unknown_observation("html_parser_error")

    product_roots = [root for root in parser.roots if root.title == PRODUCT_TITLE]
    if len(product_roots) != 1:
        return unknown_observation("hydrated_product_root_mismatch")

    root = product_roots[0]
    by_value: dict[str, list[tuple[str | None, str | None]]] = {}
    for input_id, value in root.inputs:
        if value:
            by_value.setdefault(normalize(value), []).append((input_id, value))

    statuses: dict[str, str] = {slot.key: SlotStatus.MISSING.value for slot in SLOTS}
    evidence: dict[str, str] = {slot.key: "slot_missing" for slot in SLOTS}
    discovered: dict[str, dict[str, str]] = {}
    for input_id, value in root.inputs:
        if not value:
            return unknown_observation("slot_label_missing")
        key = stable_slot_key(value)
        if not key or key in discovered:
            return unknown_observation("duplicate_slot" if key else "slot_unparseable")
        label = normalize(value)
        label_text = root.labels.get(input_id or "")
        if not label_text:
            status = SlotStatus.UNKNOWN.value
            proof = "slot_label_missing"
        elif _SOLD_OUT_RE.search(label_text):
            status = SlotStatus.SOLD_OUT.value
            proof = label_text
        elif normalize_slot_label(label_text) == normalize_slot_label(label):
            status = SlotStatus.AVAILABLE.value
            proof = label_text
        else:
            status = SlotStatus.UNKNOWN.value
            proof = "slot_label_unrecognized"
        discovered[key] = {"label": label, "status": status}
        statuses[key] = status
        evidence[key] = proof

    if not discovered:
        return unknown_observation("zero_slots")
    return {
        "statuses": statuses,
        "evidence": evidence,
        "slots": discovered,
        "slot_set": list(discovered),
        "parser_ok": True,
    }
