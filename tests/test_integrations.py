import json
from pathlib import Path
from urllib.error import HTTPError

import pytest

from watcher import cli
from watcher.discord import DiscordError, send_discord
from watcher.github_state import GitHubIssueStore, LoadedState
from watcher.model import SLOTS, STATE_ISSUE_TITLE, SlotStatus
from watcher.state import default_state, encode_issue_body


class FakeResponse:
    def __init__(self, payload, status=200):
        self.status = status
        self.payload = payload

    def __enter__(self):
        return self

    def __exit__(self, *_args):
        return False

    def read(self):
        return json.dumps(self.payload).encode("utf-8")


def test_state_issue_absent_is_created(monkeypatch) -> None:
    calls = []

    def fake_urlopen(request, timeout):
        calls.append((request.get_method(), request.full_url))
        if request.get_method() == "GET":
            return FakeResponse([])
        return FakeResponse({"number": 17})

    monkeypatch.setattr("watcher.github_state.urlopen", fake_urlopen)
    store = GitHubIssueStore("owner/repo", "token")
    loaded = store.load()
    assert loaded.issue_number is None
    assert store.save(loaded.state, loaded.issue_number) == 17
    assert calls[1][0] == "POST"
    assert calls[1][1].endswith("/repos/owner/repo/issues")


def test_corrupt_state_issue_resets_safely(monkeypatch) -> None:
    issue = {
        "number": 9,
        "title": STATE_ISSUE_TITLE,
        "body": "broken",
        "user": {"login": "github-actions[bot]"},
    }
    monkeypatch.setattr(
        "watcher.github_state.urlopen", lambda request, timeout: FakeResponse([issue])
    )
    loaded = GitHubIssueStore("owner/repo", "token").load()
    assert loaded.issue_number == 9
    assert loaded.recovered_from_corruption
    assert all(
        item["status"] == SlotStatus.UNKNOWN.value for item in loaded.state["slots"].values()
    )


def test_third_party_same_title_issue_is_ignored(monkeypatch) -> None:
    malicious = {
        "number": 3,
        "title": STATE_ISSUE_TITLE,
        "body": encode_issue_body(default_state()),
        "user": {"login": "untrusted-user"},
    }
    monkeypatch.setattr(
        "watcher.github_state.urlopen", lambda request, timeout: FakeResponse([malicious])
    )
    loaded = GitHubIssueStore("owner/repo", "token").load()
    assert loaded.issue_number is None


def test_discord_failure_does_not_expose_webhook(monkeypatch) -> None:
    secret_url = "https://example.invalid/api/webhooks/123/top-secret"

    def fail(_request, timeout):
        raise HTTPError(secret_url, 500, "failure", {}, None)

    monkeypatch.setattr("watcher.discord.urlopen", fail)
    with pytest.raises(DiscordError) as error:
        send_discord(secret_url, "test")
    assert "top-secret" not in str(error.value)
    assert "HTTP 500" in str(error.value)


def test_discord_test_sends_exactly_one_message(monkeypatch) -> None:
    calls = []
    monkeypatch.setenv("DISCORD_WEBHOOK_URL", "secret")
    monkeypatch.setattr(cli, "send_discord", lambda *args: calls.append(args))
    assert cli.run_discord_test() == 0
    assert len(calls) == 1


def test_failed_discord_notification_prevents_state_save(monkeypatch) -> None:
    observed = {slot.key: SlotStatus.AVAILABLE.value for slot in SLOTS}

    class FakeStore:
        saved = False

        def __init__(self, **_kwargs):
            pass

        def load(self):
            return LoadedState(default_state(), 1)

        def save(self, state, issue_number):
            self.saved = True
            return issue_number

    fake_store = FakeStore()
    monkeypatch.setenv("DISCORD_WEBHOOK_URL", "secret")
    monkeypatch.setenv("GITHUB_TOKEN", "token")
    monkeypatch.setenv("GITHUB_REPOSITORY", "owner/repo")
    monkeypatch.setattr("watcher.live.observe_live_page", lambda: {"statuses": observed})
    monkeypatch.setattr(cli, "GitHubIssueStore", lambda **_kwargs: fake_store)
    monkeypatch.setattr(
        cli, "send_discord", lambda *_args: (_ for _ in ()).throw(DiscordError("failed"))
    )
    with pytest.raises(DiscordError):
        cli.run_normal()
    assert not fake_store.saved


def test_page_failure_is_persisted_by_normal_mode(monkeypatch) -> None:
    observed = {slot.key: SlotStatus.UNKNOWN.value for slot in SLOTS}

    class FakeStore:
        saved_state = None

        def load(self):
            return LoadedState(default_state(), 1)

        def save(self, state, issue_number):
            self.saved_state = state
            return issue_number

    fake_store = FakeStore()
    monkeypatch.setenv("DISCORD_WEBHOOK_URL", "secret")
    monkeypatch.setenv("GITHUB_TOKEN", "token")
    monkeypatch.setenv("GITHUB_REPOSITORY", "owner/repo")
    monkeypatch.setattr("watcher.live.observe_live_page", lambda: {"statuses": observed})
    monkeypatch.setattr(cli, "GitHubIssueStore", lambda **_kwargs: fake_store)

    assert cli.run_normal() == 0
    assert fake_store.saved_state["consecutive_total_failures"] == 1


def test_workflow_has_concurrency_timeout_and_minimal_permissions() -> None:
    workflow = (
        Path(__file__).parents[1] / ".github" / "workflows" / "availability-watcher.yml"
    ).read_text(encoding="utf-8")
    assert "group: okaz-slot-watcher" in workflow
    assert "cancel-in-progress: false" in workflow
    assert "timeout-minutes: 4" in workflow
    assert "permissions: {}" in workflow
    assert "python -m playwright install --with-deps chromium" in workflow

    diagnostic = workflow.split("\n  diagnostic:", 1)[1].split("\n  discord-test:", 1)[0]
    discord_test = workflow.split("\n  discord-test:", 1)[1].split("\n  normal:", 1)[0]
    normal = workflow.split("\n  normal:", 1)[1].split("\n  disable-after-cutoff:", 1)[0]
    disable = workflow.split("\n  disable-after-cutoff:", 1)[1]

    assert "contents: read" in diagnostic
    assert "issues: write" not in diagnostic
    assert "DISCORD_WEBHOOK_URL" not in diagnostic
    assert "GITHUB_TOKEN" not in diagnostic

    assert "contents: read" in discord_test
    assert "issues: write" not in discord_test
    assert "DISCORD_WEBHOOK_URL" in discord_test
    assert "GITHUB_TOKEN" not in discord_test

    assert "contents: read" in normal
    assert "issues: write" in normal
    assert "DISCORD_WEBHOOK_URL" in normal
    assert "GITHUB_TOKEN" in normal

    assert "actions: write" in disable
    assert "github.event_name == 'schedule'" in disable
    assert "vars.WATCHER_ENABLED == 'true'" in disable
    assert "actions: write" not in workflow.split("\n  disable-after-cutoff:", 1)[0]


def test_workflow_exposes_only_safe_triggers() -> None:
    workflow = (
        Path(__file__).parents[1] / ".github" / "workflows" / "availability-watcher.yml"
    ).read_text(encoding="utf-8")
    assert "  schedule:" in workflow
    assert "  workflow_dispatch:" in workflow
    for forbidden in (
        "pull_request_target",
        "pull_request:",
        "issue_comment",
        "workflow_run",
        "repository_dispatch",
    ):
        assert forbidden not in workflow
