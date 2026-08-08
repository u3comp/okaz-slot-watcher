from datetime import datetime, timedelta

from watcher.model import CUTOFF_JST, JST, SLOTS, SlotStatus, is_after_cutoff
from watcher.state import decode_issue_body, default_state, encode_issue_body, transition


def statuses(value: SlotStatus) -> dict[str, str]:
    return {slot.key: value.value for slot in SLOTS}


def test_available_continuation_suppresses_duplicate() -> None:
    initial = transition(default_state(), statuses(SlotStatus.AVAILABLE))
    assert len(initial.available_slots) == 4
    again = transition(initial.next_state, statuses(SlotStatus.AVAILABLE))
    assert again.available_slots == ()
    assert not again.notification_required


def test_sold_out_then_available_again_notifies_again() -> None:
    first = transition(default_state(), statuses(SlotStatus.AVAILABLE))
    sold_out = transition(first.next_state, statuses(SlotStatus.SOLD_OUT))
    restored = transition(sold_out.next_state, statuses(SlotStatus.AVAILABLE))
    assert len(restored.available_slots) == 4


def test_outage_on_third_total_failure_and_one_recovery() -> None:
    state = default_state()
    for attempt in range(1, 4):
        change = transition(state, statuses(SlotStatus.UNKNOWN))
        assert change.outage_started is (attempt == 3)
        state = change.next_state
    still_down = transition(state, statuses(SlotStatus.MISSING))
    assert not still_down.outage_started
    recovered = transition(still_down.next_state, statuses(SlotStatus.SOLD_OUT))
    assert recovered.outage_recovered
    stable = transition(recovered.next_state, statuses(SlotStatus.SOLD_OUT))
    assert not stable.outage_recovered


def test_cutoff_boundary() -> None:
    assert not is_after_cutoff(CUTOFF_JST - timedelta(seconds=1))
    assert is_after_cutoff(CUTOFF_JST)
    assert is_after_cutoff(datetime(2026, 8, 23, 16, 31, tzinfo=JST))


def test_schema_v1_migrates_without_queuing_notifications() -> None:
    legacy = default_state()
    legacy["schema_version"] = 1
    legacy.pop("pending_notifications")
    legacy["slots"][SLOTS[0].key]["status"] = SlotStatus.SOLD_OUT.value
    migrated = decode_issue_body(encode_issue_body(legacy))
    assert migrated["schema_version"] == 2
    assert migrated["pending_notifications"] == []
    assert migrated["slots"][SLOTS[0].key]["status"] == SlotStatus.SOLD_OUT.value


def test_dynamic_slot_addition_is_one_shot_and_order_independent() -> None:
    previous = default_state()
    added_key = "2026-08-22_1700"
    observed_slots = {
        **{slot.key: {"label": slot.label, "status": SlotStatus.SOLD_OUT.value} for slot in reversed(SLOTS)},
        added_key: {"label": "8/22（土）17:00-19:00", "status": SlotStatus.SOLD_OUT.value},
    }
    observed_statuses = {key: value["status"] for key, value in observed_slots.items()}
    first = transition(previous, observed_statuses, observed_slots)
    assert first.new_slots == (added_key,)
    assert len(first.next_state["slots"]) == 5
    second = transition(first.next_state, observed_statuses, observed_slots)
    assert second.new_slots == ()
    assert second.available_slots == ()
