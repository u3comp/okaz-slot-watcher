from __future__ import annotations

import argparse
import json
import os
import sys
from pathlib import Path

from .discord import DiscordError, send_discord
from .github_state import GitHubIssueStore, GitHubStateError
from .model import CUTOFF_JST, PRODUCT_URL, SLOTS, is_after_cutoff, now_jst
from .state import transition


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


def run_normal() -> int:
    from .live import observe_live_page

    webhook = os.environ.get("DISCORD_WEBHOOK_URL", "")
    token = os.environ.get("GITHUB_TOKEN", "")
    repository = os.environ.get("GITHUB_REPOSITORY", "")
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
        # Persist only after Discord accepts the message. A failed notification is retried.
        send_discord(webhook, _format_notification(change))
    issue_number = store.save(change.next_state, loaded.issue_number)

    summary = {
        "checked_at_jst": _timestamp(),
        "statuses": observation["statuses"],
        "consecutive_total_failures": change.next_state["consecutive_total_failures"],
        "state_issue_number": issue_number,
        "notification_sent": change.notification_required,
    }
    print(json.dumps(summary, ensure_ascii=False, sort_keys=True))
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
        return write_cutoff_output(args.github_output)
    except (DiscordError, GitHubStateError) as exc:
        print(f"ERROR: {exc}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
