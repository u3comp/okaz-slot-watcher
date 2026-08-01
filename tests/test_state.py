from datetime import datetime, timedelta

from watcher.model import CUTOFF_JST, JST, SLOTS, SlotStatus, is_after_cutoff
from watcher.state import default_state, transition


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
