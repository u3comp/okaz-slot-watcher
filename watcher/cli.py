from __future__ import annotations

import argparse
import json
import os
import sys
from pathlib import Path
from uuid import uuid4

from .discord import DiscordError, send_discord
from .github_state import GitHubIssueStore, GitHubStateError
from .line import LineError, send_line
from .line_destination import LineDestinationError, resolve_line_destination
from .model import CUTOFF_JST, PRODUCT_URL, SLOTS, is_after_cutoff, now_jst
from .state import enqueue_notification, remove_delivered_notifications, transition


class NotificationDeliveryError(RuntimeError):
    pass


def _timestamp() -> str:
    return now_jst().isoformat(timespec="seconds")


def _format_notification(change) -> str:
    lines: list[str] = []
    if change.available_slots:
        labels = {slot.key: slot.label for slot in SLOTS}
        slots = "\n".join(f"- {labels[key]}" for key in change.available_slots)
        lines.append(f"【空き枠復活】茶と果実\n{slots}\n{PRODUCT_URL}")
    if change.outage_started:
        lines.append("【監視障害】3回連続で全4枠を判定できませんでした。")
    if change.outage_recovered:
        lines.append("【監視復旧】全枠判定不能の状態から復旧しました。")
    lines.append(f"確認時刻: {_timestamp()} (Asia/Tokyo)")
    return "\n\n".join(lines)


def run_diagnostic() -> int:
    from .live import observe_live_page

    observation = observe_live_page()
    report = {
        "checked_at_jst": _timestamp(),
        "product_url": PRODUCT_URL,
        "parser_ok": observation["parser_ok"],
        "error_class": observation.get("error_class"),
        "statuses": observation["statuses"],
        "evidence": observation["evidence"],
    }
    print(json.dumps(report, ensure_ascii=False, indent=2, sort_keys=True))
    return 0 if observation["parser_ok"] else 2


def run_discord_test() -> int:
    webhook = os.environ.get("DISCORD_WEBHOOK_URL", "")
    send_discord(
        webhook,
        f"【テスト通知】Okaz slot watcher\n送信時刻: {_timestamp()} (Asia/Tokyo)",
    )
    print("Discord test notification delivered.")
    return 0


def run_line_test() -> int:
    token = os.environ.get("LINE_CHANNEL_ACCESS_TOKEN", "")
    personal_id = os.environ.get("LINE_USER_ID", "")
    group_id = os.environ.get("LINE_GROUP_ID", "")
    try:
        destination = resolve_line_destination(
            os.environ.get("LINE_DESTINATION_MODE"),
            personal_id,
            group_id,
            os.environ.get("LINE_TEST_DESTINATION", "configured"),
        )
    except LineDestinationError as exc:
        raise LineError(str(exc)) from None
    route_label = os.environ.get("LINE_TEST_DESTINATION", "configured")
    delivery_id = str(uuid4())
    test_id = f"LINE-{route_label.upper()}-{delivery_id}"
    send_line(
        token,
        destination.destination_id,
        "【テスト通知】Personal Ops\n"
        "Production切替前テスト\n"
        f"{route_label}経路確認\n"
        "実際の空き枠通知ではありません。\n"
        "申込み・応答は不要です。\n"
        f"Test ID: {test_id}\n"
        f"送信時刻: {_timestamp()} (Asia/Tokyo)",
        delivery_id,
    )
    print(f"LINE test notification delivered. Test ID: {test_id}")
    return 0


def run_normal() -> int:
    from .live import observe_live_page

    webhook = os.environ.get("DISCORD_WEBHOOK_URL", "")
    token = os.environ.get("GITHUB_TOKEN", "")
    repository = os.environ.get("GITHUB_REPOSITORY", "")
    line_enabled = os.environ.get("LINE_ENABLED", "") == "true"
    line_token = os.environ.get("LINE_CHANNEL_ACCESS_TOKEN", "") if line_enabled else ""
    line_personal_id = os.environ.get("LINE_USER_ID", "") if line_enabled else ""
    line_group_id = os.environ.get("LINE_GROUP_ID", "") if line_enabled else ""
    line_destination_error: LineDestinationError | None = None
    line_destination = None
    if line_enabled:
        try:
            line_destination = resolve_line_destination(
                os.environ.get("LINE_DESTINATION_MODE"),
                line_personal_id,
                line_group_id,
            )
        except LineDestinationError as exc:
            line_destination_error = exc
    if not webhook:
        raise DiscordError("DISCORD_WEBHOOK_URL is not configured")
    if not token or not repository:
        raise GitHubStateError("GitHub Actions state environment is not configured")

    observation = observe_live_page()
    store = GitHubIssueStore(
        repository=repository,
        token=token,
        api_url=os.environ.get("GITHUB_API_URL", "https://api.github.com"),
    )
    loaded = store.load()
    if loaded.recovered_from_corruption:
        print("WARNING: state issue was corrupt; resetting to safe UNKNOWN state.")

    change = transition(loaded.state, observation["statuses"])
    if change.notification_required:
        enqueue_notification(
            change.next_state,
            _format_notification(change),
            include_line=line_enabled,
        )

    delivery_errors: set[str] = set()
    sent = {"discord": 0, "line": 0}
    for notification in change.next_state.get("pending_notifications", []):
        channels = notification.get("channels", {})
        if not channels.get("discord", True):
            try:
                send_discord(webhook, notification["message"])
                channels["discord"] = True
                sent["discord"] += 1
            except DiscordError:
                delivery_errors.add("discord")
        if "line" in channels and not channels["line"] and line_enabled:
            try:
                if line_destination_error is not None or line_destination is None:
                    raise LineError(str(line_destination_error or "LINE destination is not configured"))
                send_line(
                    line_token,
                    line_destination.destination_id,
                    notification["message"],
                    notification["id"],
                )
                channels["line"] = True
                sent["line"] += 1
            except LineError:
                delivery_errors.add("line")

    remove_delivered_notifications(change.next_state)
    issue_number = store.save(change.next_state, loaded.issue_number)

    summary = {
        "checked_at_jst": _timestamp(),
        "statuses": observation["statuses"],
        "consecutive_total_failures": change.next_state["consecutive_total_failures"],
        "state_issue_number": issue_number,
        "notification_queued": change.notification_required,
        "discord_notifications_sent": sent["discord"],
        "line_notifications_sent": sent["line"],
        "delivery_errors": sorted(delivery_errors),
    }
    print(json.dumps(summary, ensure_ascii=False, sort_keys=True))
    if delivery_errors:
        channels = ", ".join(sorted(delivery_errors))
        raise NotificationDeliveryError(f"notification delivery failed: {channels}")
    return 0


def write_cutoff_output(path: str | None) -> int:
    ended = is_after_cutoff()
    print(
        json.dumps(
            {
                "checked_at_jst": _timestamp(),
                "cutoff_jst": CUTOFF_JST.isoformat(timespec="minutes"),
                "ended": ended,
            },
            ensure_ascii=False,
        )
    )
    if path:
        with Path(path).open("a", encoding="utf-8") as output:
            output.write(f"ended={'true' if ended else 'false'}\n")
    return 0


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser()
    subparsers = parser.add_subparsers(dest="mode", required=True)
    subparsers.add_parser("normal")
    subparsers.add_parser("diagnostic")
    subparsers.add_parser("discord_test")
    subparsers.add_parser("line_test")
    cutoff = subparsers.add_parser("cutoff")
    cutoff.add_argument("--github-output")
    args = parser.parse_args(argv)

    try:
        if args.mode == "normal":
            return run_normal()
        if args.mode == "diagnostic":
            return run_diagnostic()
        if args.mode == "discord_test":
            return run_discord_test()
        if args.mode == "line_test":
            return run_line_test()
        return write_cutoff_output(args.github_output)
    except (DiscordError, LineError, GitHubStateError, NotificationDeliveryError) as exc:
        print(f"ERROR: {exc}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
