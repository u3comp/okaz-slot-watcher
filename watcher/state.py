from __future__ import annotations

import copy
import json
from dataclasses import dataclass

from .model import SLOTS, STATE_MARKER, SlotStatus, now_jst


FAILURE_STATUSES = {SlotStatus.MISSING.value, SlotStatus.UNKNOWN.value}


def default_state() -> dict:
    return {
        "schema_version": 1,
        "slots": {
            slot.key: {"label": slot.label, "status": SlotStatus.UNKNOWN.value}
            for slot in SLOTS
        },
        "consecutive_total_failures": 0,
        "outage_notified": False,
        "updated_at_jst": None,
    }


def encode_issue_body(state: dict) -> str:
    payload = json.dumps(state, ensure_ascii=False, indent=2, sort_keys=True)
    return (
        f"{STATE_MARKER}\n"
        "This issue is updated automatically. Do not store credentials here.\n\n"
        f"```json\n{payload}\n```\n"
    )


def decode_issue_body(body: str | None) -> dict:
    if not body or STATE_MARKER not in body:
        raise ValueError("state marker is missing")
    start = body.find("```json")
    end = body.find("```", start + len("```json"))
    if start < 0 or end < 0:
        raise ValueError("state JSON fence is missing")
    data = json.loads(body[start + len("```json") : end].strip())
    if data.get("schema_version") != 1 or not isinstance(data.get("slots"), dict):
        raise ValueError("unsupported state schema")
    return data


@dataclass(frozen=True)
class Transition:
    next_state: dict
    available_slots: tuple[str, ...]
    outage_started: bool
    outage_recovered: bool

    @property
    def notification_required(self) -> bool:
        return bool(self.available_slots or self.outage_started or self.outage_recovered)


def transition(previous: dict, observed_statuses: dict[str, str]) -> Transition:
    next_state = copy.deepcopy(previous)
    next_state.setdefault("slots", {})
    available: list[str] = []

    for slot in SLOTS:
        observed = observed_statuses.get(slot.key, SlotStatus.UNKNOWN.value)
        if observed not in {status.value for status in SlotStatus}:
            observed = SlotStatus.UNKNOWN.value
        old = (
            previous.get("slots", {})
            .get(slot.key, {})
            .get("status", SlotStatus.UNKNOWN.value)
        )
        if observed == SlotStatus.AVAILABLE.value and old != SlotStatus.AVAILABLE.value:
            available.append(slot.key)
        next_state["slots"][slot.key] = {"label": slot.label, "status": observed}

    total_failure = all(
        next_state["slots"][slot.key]["status"] in FAILURE_STATUSES for slot in SLOTS
    )
    old_count = int(previous.get("consecutive_total_failures", 0) or 0)
    next_count = old_count + 1 if total_failure else 0
    was_outage = bool(previous.get("outage_notified", False))
    outage_started = total_failure and next_count >= 3 and not was_outage
    outage_recovered = not total_failure and was_outage

    next_state["consecutive_total_failures"] = next_count
    next_state["outage_notified"] = (was_outage or outage_started) and not outage_recovered
    next_state["updated_at_jst"] = now_jst().isoformat(timespec="seconds")

    return Transition(
        next_state=next_state,
        available_slots=tuple(available),
        outage_started=outage_started,
        outage_recovered=outage_recovered,
    )
