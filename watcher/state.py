from __future__ import annotations

import copy
import json
from dataclasses import dataclass
from uuid import UUID, uuid4

from .model import SLOTS, STATE_MARKER, SlotStatus, now_jst


FAILURE_STATUSES = {SlotStatus.MISSING.value, SlotStatus.UNKNOWN.value}


def default_state() -> dict:
    return {
        "schema_version": 2,
        "slots": {
            slot.key: {"label": slot.label, "status": SlotStatus.UNKNOWN.value}
            for slot in SLOTS
        },
        "consecutive_total_failures": 0,
        "outage_notified": False,
        "pending_notifications": [],
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
    if data.get("schema_version") not in (1, 2) or not isinstance(
        data.get("slots"), dict
    ):
        raise ValueError("unsupported state schema")
    return migrate_state(data)


def migrate_state(state: dict) -> dict:
    migrated = copy.deepcopy(state)
    version = migrated.get("schema_version")
    if version not in (1, 2):
        raise ValueError("unsupported state schema")
    pending = migrated.get("pending_notifications", [])
    if not isinstance(pending, list):
        raise ValueError("pending notifications must be a list")
    for item in pending:
        if not isinstance(item, dict):
            raise ValueError("pending notification must be an object")
        if not isinstance(item.get("id"), str) or not isinstance(
            item.get("message"), str
        ):
            raise ValueError("pending notification fields are invalid")
        try:
            UUID(item["id"])
        except (ValueError, AttributeError):
            raise ValueError("pending notification id is invalid") from None
        channels = item.get("channels")
        if (
            not isinstance(channels, dict)
            or "discord" not in channels
            or any(channel not in {"discord", "line"} for channel in channels)
            or any(not isinstance(delivered, bool) for delivered in channels.values())
        ):
            raise ValueError("pending notification channels are invalid")
    migrated["schema_version"] = 2
    migrated["pending_notifications"] = pending
    return migrated


def enqueue_notification(
    state: dict,
    message: str,
    *,
    include_line: bool,
    notification_id: str | None = None,
) -> str:
    event_id = notification_id or str(uuid4())
    channels = {"discord": False}
    if include_line:
        channels["line"] = False
    state.setdefault("pending_notifications", []).append(
        {"id": event_id, "message": message, "channels": channels}
    )
    return event_id


def remove_delivered_notifications(state: dict) -> None:
    state["pending_notifications"] = [
        item
        for item in state.get("pending_notifications", [])
        if not all(item.get("channels", {}).values())
    ]


@dataclass(frozen=True)
class Transition:
    next_state: dict
    available_slots: tuple[str, ...]
    outage_started: bool
    outage_recovered: bool
    new_slots: tuple[str, ...] = ()
    new_slot_available: tuple[str, ...] = ()
    removed_confirmed: tuple[str, ...] = ()
    reappeared_slots: tuple[str, ...] = ()
    structural_anomaly: str | None = None

    @property
    def notification_required(self) -> bool:
        return bool(
            self.available_slots
            or self.new_slots
            or self.new_slot_available
            or self.removed_confirmed
            or self.reappeared_slots
            or self.structural_anomaly
            or self.outage_started
            or self.outage_recovered
        )


def transition(
    previous: dict,
    observed_statuses: dict[str, str],
    observed_slots: dict[str, dict] | None = None,
    structural_anomaly: str | None = None,
) -> Transition:
    next_state = migrate_state(previous)
    next_state.setdefault("slots", {})
    next_state.setdefault("opportunity_events", {})
    available: list[str] = []
    new_slots: list[str] = []
    new_slot_available: list[str] = []
    removed_confirmed: list[str] = []
    reappeared_slots: list[str] = []

    if observed_slots is not None and structural_anomaly is None:
        previous_slots = previous.get("slots", {})
        for key, observed in observed_slots.items():
            if not isinstance(observed, dict):
                continue
            label = str(observed.get("label", key))
            status = str(observed.get("status", SlotStatus.UNKNOWN.value))
            if status not in {status.value for status in SlotStatus}:
                status = SlotStatus.UNKNOWN.value
            old = previous_slots.get(key, {})
            is_new = key not in previous_slots
            is_reappeared = old.get("active") is False
            if is_new:
                new_slots.append(key)
            if is_reappeared:
                reappeared_slots.append(key)
            if status == SlotStatus.AVAILABLE.value and old.get("status") != SlotStatus.AVAILABLE.value:
                if is_new or is_reappeared:
                    new_slot_available.append(key)
                else:
                    available.append(key)
            next_state["slots"][key] = {
                **old,
                "label": label,
                "status": status,
                "first_seen_at_utc": old.get("first_seen_at_utc") or now_jst().isoformat(),
                "last_seen_at_utc": now_jst().isoformat(),
                "active": True,
                "missing_observation_count": 0,
            }
            fingerprint = f"new:{key}" if is_new else f"reappeared:{key}"
            if is_new or is_reappeared:
                next_state["opportunity_events"].setdefault(fingerprint, {"kind": "new_slot" if is_new else "reappeared", "first_seen_at_jst": now_jst().isoformat()})
        current_keys = set(observed_slots)
        for key, old in previous_slots.items():
            if key in current_keys or old.get("active") is False:
                continue
            missing_count = int(old.get("missing_observation_count", 0) or 0) + 1
            confirmed = missing_count >= 2
            next_state["slots"][key] = {
                **old,
                "status": SlotStatus.MISSING.value if confirmed else old.get("status", SlotStatus.UNKNOWN.value),
                "reason": "removed_confirmed" if confirmed else "removal_candidate",
                "active": not confirmed,
                "missing_observation_count": missing_count,
            }
            if confirmed and f"removed:{key}" not in next_state["opportunity_events"]:
                removed_confirmed.append(key)
                next_state["opportunity_events"][f"removed:{key}"] = {"kind": "removed_confirmed", "first_seen_at_jst": now_jst().isoformat()}
    elif structural_anomaly is not None:
        next_state["structural_anomaly"] = structural_anomaly
        observed_slots = None

    for slot in SLOTS if observed_slots is None else ():
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

    slot_values = list(next_state["slots"].values())
    total_failure = bool(slot_values) and all(
        item.get("status") in FAILURE_STATUSES for item in slot_values
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
        new_slots=tuple(new_slots),
        new_slot_available=tuple(new_slot_available),
        removed_confirmed=tuple(removed_confirmed),
        reappeared_slots=tuple(reappeared_slots),
        structural_anomaly=structural_anomaly,
    )
