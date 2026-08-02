import json
from pathlib import Path
from urllib.error import HTTPError

import pytest

from watcher import cli
from watcher.cli import NotificationDeliveryError
from watcher.discord import DiscordError, send_discord
from watcher.github_state import GitHubIssueStore, LoadedState
from watcher.line import LineError
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


def test_failed_discord_notification_persists_state_for_retry(monkeypatch) -> None:
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
    with pytest.raises(NotificationDeliveryError, match="discord"):
        cli.run_normal()
    assert fake_store.saved


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


def _run_delivery_case(monkeypatch, *, discord_fails: bool, line_fails: bool):
    observed = {slot.key: SlotStatus.AVAILABLE.value for slot in SLOTS}

    class FakeStore:
        def __init__(self):
            self.state = default_state()
            self.saved_states = []

        def load(self):
            return LoadedState(self.state, 1)

        def save(self, state, issue_number):
            self.state = json.loads(json.dumps(state))
            self.saved_states.append(self.state)
            return issue_number

    store = FakeStore()
    discord_calls = []
    line_calls = []
    monkeypatch.setenv("DISCORD_WEBHOOK_URL", "discord-secret")
    monkeypatch.setenv("GITHUB_TOKEN", "github-token")
    monkeypatch.setenv("GITHUB_REPOSITORY", "owner/repo")
    monkeypatch.setenv("LINE_ENABLED", "true")
    monkeypatch.setenv("LINE_CHANNEL_ACCESS_TOKEN", "line-token")
    monkeypatch.setenv("LINE_USER_ID", "line-user")
    monkeypatch.setattr("watcher.live.observe_live_page", lambda: {"statuses": observed})
    monkeypatch.setattr(cli, "GitHubIssueStore", lambda **_kwargs: store)

    def discord_sender(*args):
        discord_calls.append(args)
        if discord_fails:
            raise DiscordError("failed")

    def line_sender(*args):
        line_calls.append(args)
        if line_fails:
            raise LineError("failed")

    monkeypatch.setattr(cli, "send_discord", discord_sender)
    monkeypatch.setattr(cli, "send_line", line_sender)
    if discord_fails or line_fails:
        with pytest.raises(NotificationDeliveryError):
            cli.run_normal()
    else:
        assert cli.run_normal() == 0
    return store, discord_calls, line_calls


@pytest.mark.parametrize(
    ("discord_fails", "line_fails", "expected_channels"),
    [
        (False, False, None),
        (False, True, {"discord": True, "line": False}),
        (True, False, {"discord": False, "line": True}),
        (True, True, {"discord": False, "line": False}),
    ],
)
def test_discord_and_line_delivery_are_independent(
    monkeypatch, discord_fails, line_fails, expected_channels
) -> None:
    store, discord_calls, line_calls = _run_delivery_case(
        monkeypatch, discord_fails=discord_fails, line_fails=line_fails
    )
    assert len(discord_calls) == 1
    assert len(line_calls) == 1
    assert store.saved_states[-1]["slots"][SLOTS[0].key]["status"] == "AVAILABLE"
    pending = store.saved_states[-1]["pending_notifications"]
    if expected_channels is None:
        assert pending == []
    else:
        assert pending[0]["channels"] == expected_channels


def test_successful_discord_is_not_resent_when_line_retries(monkeypatch) -> None:
    store, _, line_calls = _run_delivery_case(
        monkeypatch, discord_fails=False, line_fails=True
    )
    retry_key = line_calls[0][3]
    monkeypatch.setattr(
        cli,
        "send_discord",
        lambda *_args: pytest.fail("Discord must not be resent"),
    )
    retried = []
    monkeypatch.setattr(cli, "send_line", lambda *args: retried.append(args))
    assert cli.run_normal() == 0
    assert len(retried) == 1
    assert retried[0][3] == retry_key
    assert store.state["pending_notifications"] == []


def test_successful_line_is_not_resent_when_discord_retries(monkeypatch) -> None:
    store, _, _ = _run_delivery_case(
        monkeypatch, discord_fails=True, line_fails=False
    )
    monkeypatch.setattr(cli, "send_line", lambda *_args: pytest.fail("LINE must not be resent"))
    discord_retries = []
    monkeypatch.setattr(cli, "send_discord", lambda *args: discord_retries.append(args))
    assert cli.run_normal() == 0
    assert len(discord_retries) == 1
    assert store.state["pending_notifications"] == []


def test_line_disabled_keeps_discord_only(monkeypatch) -> None:
    monkeypatch.setenv("LINE_ENABLED", "false")
    observed = {slot.key: SlotStatus.AVAILABLE.value for slot in SLOTS}

    class FakeStore:
        saved_state = None

        def load(self):
            return LoadedState(default_state(), 1)

        def save(self, state, issue_number):
            self.saved_state = state
            return issue_number

    store = FakeStore()
    monkeypatch.setenv("DISCORD_WEBHOOK_URL", "discord-secret")
    monkeypatch.setenv("GITHUB_TOKEN", "github-token")
    monkeypatch.setenv("GITHUB_REPOSITORY", "owner/repo")
    monkeypatch.setattr("watcher.live.observe_live_page", lambda: {"statuses": observed})
    monkeypatch.setattr(cli, "GitHubIssueStore", lambda **_kwargs: store)
    monkeypatch.setattr(cli, "send_discord", lambda *_args: None)
    monkeypatch.setattr(cli, "send_line", lambda *_args: pytest.fail("LINE must be disabled"))
    assert cli.run_normal() == 0
    assert store.saved_state["pending_notifications"] == []


def test_line_enabled_with_missing_secrets_fails_safely_after_state_save(
    monkeypatch,
) -> None:
    observed = {slot.key: SlotStatus.AVAILABLE.value for slot in SLOTS}

    class FakeStore:
        saved_state = None

        def load(self):
            return LoadedState(default_state(), 1)

        def save(self, state, issue_number):
            self.saved_state = state
            return issue_number

    store = FakeStore()
    monkeypatch.setenv("DISCORD_WEBHOOK_URL", "discord-secret")
    monkeypatch.setenv("GITHUB_TOKEN", "github-token")
    monkeypatch.setenv("GITHUB_REPOSITORY", "owner/repo")
    monkeypatch.setenv("LINE_ENABLED", "true")
    monkeypatch.delenv("LINE_CHANNEL_ACCESS_TOKEN", raising=False)
    monkeypatch.delenv("LINE_USER_ID", raising=False)
    monkeypatch.setattr("watcher.live.observe_live_page", lambda: {"statuses": observed})
    monkeypatch.setattr(cli, "GitHubIssueStore", lambda **_kwargs: store)
    monkeypatch.setattr(cli, "send_discord", lambda *_args: None)
    with pytest.raises(NotificationDeliveryError, match="line") as error:
        cli.run_normal()
    assert "discord-secret" not in str(error.value)
    assert store.saved_state["pending_notifications"][0]["channels"] == {
        "discord": True,
        "line": False,
    }


def test_sold_out_observation_sends_neither_channel(monkeypatch) -> None:
    observed = {slot.key: SlotStatus.SOLD_OUT.value for slot in SLOTS}

    class FakeStore:
        saved_state = None

        def load(self):
            return LoadedState(default_state(), 1)

        def save(self, state, issue_number):
            self.saved_state = state
            return issue_number

    store = FakeStore()
    monkeypatch.setenv("DISCORD_WEBHOOK_URL", "discord-secret")
    monkeypatch.setenv("GITHUB_TOKEN", "github-token")
    monkeypatch.setenv("GITHUB_REPOSITORY", "owner/repo")
    monkeypatch.setenv("LINE_ENABLED", "true")
    monkeypatch.setenv("LINE_CHANNEL_ACCESS_TOKEN", "line-token")
    monkeypatch.setenv("LINE_USER_ID", "line-user")
    monkeypatch.setattr("watcher.live.observe_live_page", lambda: {"statuses": observed})
    monkeypatch.setattr(cli, "GitHubIssueStore", lambda **_kwargs: store)
    monkeypatch.setattr(cli, "send_discord", lambda *_args: pytest.fail("no notification"))
    monkeypatch.setattr(cli, "send_line", lambda *_args: pytest.fail("no notification"))
    assert cli.run_normal() == 0
    assert store.saved_state["pending_notifications"] == []


@pytest.mark.parametrize(
    ("previous", "observed", "expected_text"),
    [
        (SlotStatus.UNKNOWN, SlotStatus.UNKNOWN, "【監視障害】"),
        (SlotStatus.UNKNOWN, SlotStatus.SOLD_OUT, "【監視復旧】"),
    ],
)
def test_outage_and_recovery_notifications_target_line(
    monkeypatch, previous, observed, expected_text
) -> None:
    state = default_state()
    if expected_text == "【監視障害】":
        state["consecutive_total_failures"] = 2
    else:
        state["outage_notified"] = True
    for slot in SLOTS:
        state["slots"][slot.key]["status"] = previous.value

    class FakeStore:
        def load(self):
            return LoadedState(state, 1)

        def save(self, next_state, issue_number):
            return issue_number

    messages = []
    monkeypatch.setenv("DISCORD_WEBHOOK_URL", "discord-secret")
    monkeypatch.setenv("GITHUB_TOKEN", "github-token")
    monkeypatch.setenv("GITHUB_REPOSITORY", "owner/repo")
    monkeypatch.setenv("LINE_ENABLED", "true")
    monkeypatch.setenv("LINE_CHANNEL_ACCESS_TOKEN", "line-token")
    monkeypatch.setenv("LINE_USER_ID", "line-user")
    monkeypatch.setattr(
        "watcher.live.observe_live_page",
        lambda: {"statuses": {slot.key: observed.value for slot in SLOTS}},
    )
    monkeypatch.setattr(cli, "GitHubIssueStore", lambda **_kwargs: FakeStore())
    monkeypatch.setattr(cli, "send_discord", lambda *_args: None)
    monkeypatch.setattr(cli, "send_line", lambda *args: messages.append(args[2]))
    assert cli.run_normal() == 0
    assert len(messages) == 1
    assert expected_text in messages[0]


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
    discord_test = workflow.split("\n  discord-test:", 1)[1].split("\n  line-test:", 1)[0]
    line_test = workflow.split("\n  line-test:", 1)[1].split("\n  normal:", 1)[0]
    normal = workflow.split("\n  normal:", 1)[1].split("\n  disable-after-cutoff:", 1)[0]
    disable = workflow.split("\n  disable-after-cutoff:", 1)[1]

    assert "contents: read" in diagnostic
    assert "issues: write" not in diagnostic
    assert "DISCORD_WEBHOOK_URL" not in diagnostic
    assert "GITHUB_TOKEN" not in diagnostic
    assert "LINE_CHANNEL_ACCESS_TOKEN" not in diagnostic
    assert "LINE_USER_ID" not in diagnostic

    assert "contents: read" in discord_test
    assert "issues: write" not in discord_test
    assert "DISCORD_WEBHOOK_URL" in discord_test
    assert "GITHUB_TOKEN" not in discord_test
    assert "LINE_CHANNEL_ACCESS_TOKEN" not in discord_test
    assert "LINE_USER_ID" not in discord_test

    assert "contents: read" in line_test
    assert "issues: write" not in line_test
    assert "LINE_CHANNEL_ACCESS_TOKEN" in line_test
    assert "LINE_USER_ID" in line_test
    assert "DISCORD_WEBHOOK_URL" not in line_test
    assert "GITHUB_TOKEN" not in line_test
    assert "LINE_ENABLED" not in line_test
    assert "watcher.cli line_test" in line_test
    assert line_test.count("python -m watcher.cli line_test") == 1
    assert "playwright" not in line_test.lower()

    assert "contents: read" in normal
    assert "issues: write" in normal
    assert "DISCORD_WEBHOOK_URL" in normal
    assert "GITHUB_TOKEN" in normal
    assert "LINE_CHANNEL_ACCESS_TOKEN" in normal
    assert "LINE_USER_ID" in normal
    assert "LINE_ENABLED" in normal

    assert "actions: write" in disable
    assert "github.event_name == 'schedule'" in disable
    assert "vars.WATCHER_ENABLED == 'true'" in disable
    assert "LINE_CHANNEL_ACCESS_TOKEN" not in disable
    assert "LINE_USER_ID" not in disable
    assert "actions: write" not in workflow.split("\n  disable-after-cutoff:", 1)[0]
    assert workflow.count("issues: write") == 1


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
