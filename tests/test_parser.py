from pathlib import Path

import pytest

from watcher.model import SLOTS, SlotStatus
from watcher.parser import parse_rendered_html


FIXTURES = Path(__file__).parent / "fixtures"


def parse_fixture(name: str) -> dict:
    return parse_rendered_html((FIXTURES / name).read_text(encoding="utf-8"))


def test_sold_out_fixture() -> None:
    result = parse_fixture("sold_out.html")
    assert set(result["statuses"].values()) == {SlotStatus.SOLD_OUT.value}


def test_one_available_fixture() -> None:
    result = parse_fixture("one_available.html")
    assert result["statuses"][SLOTS[1].key] == SlotStatus.AVAILABLE.value
    assert sum(value == SlotStatus.AVAILABLE.value for value in result["statuses"].values()) == 1


def test_multiple_available_fixture() -> None:
    result = parse_fixture("multiple_available.html")
    assert [result["statuses"][slot.key] for slot in SLOTS[:2]] == [
        SlotStatus.AVAILABLE.value,
        SlotStatus.AVAILABLE.value,
    ]


def test_missing_slot_fixture() -> None:
    result = parse_fixture("missing.html")
    assert result["statuses"][SLOTS[3].key] == SlotStatus.MISSING.value
    assert all(
        result["statuses"][slot.key] == SlotStatus.SOLD_OUT.value for slot in SLOTS[:3]
    )


def test_dom_change_never_becomes_available() -> None:
    result = parse_fixture("dom_changed.html")
    assert not result["parser_ok"]
    assert set(result["statuses"].values()) == {SlotStatus.UNKNOWN.value}


def test_stale_ssr_root_is_ignored() -> None:
    stale = """
    <div class="ec-storefront-v3-ssr">
      <h1 class="product-details__product-title">茶と果実</h1>
      <input id="stale" name="ご希望の日時" value="8/22（土）10:30-12:30">
      <label for="stale">8/22（土）10:30-12:30</label>
    </div>
    """
    live = (FIXTURES / "sold_out.html").read_text(encoding="utf-8")
    result = parse_rendered_html(stale + live)
    assert set(result["statuses"].values()) == {SlotStatus.SOLD_OUT.value}
