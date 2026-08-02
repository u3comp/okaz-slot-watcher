import json
from uuid import UUID
from urllib.error import HTTPError, URLError

import pytest

from watcher import cli
from watcher.line import LINE_PUSH_URL, LineError, send_line


class FakeResponse:
    def __init__(self, status=200):
        self.status = status

    def __enter__(self):
        return self

    def __exit__(self, *_args):
        return False


def _headers(request) -> dict[str, str]:
    return {key.lower(): value for key, value in request.header_items()}


def test_line_push_request_url_method_json_and_headers(monkeypatch) -> None:
    captured = {}

    def fake_urlopen(request, timeout):
        captured["request"] = request
        captured["timeout"] = timeout
        return FakeResponse()

    monkeypatch.setattr("watcher.line.urlopen", fake_urlopen)
    retry_key = "00000000-0000-4000-8000-000000000001"
    send_line("channel-token", "user-id", "通知本文", retry_key)
    request = captured["request"]
    headers = _headers(request)
    assert request.full_url == LINE_PUSH_URL
    assert request.get_method() == "POST"
    assert json.loads(request.data.decode("utf-8")) == {
        "to": "user-id",
        "messages": [{"type": "text", "text": "通知本文"}],
    }
    assert headers["authorization"] == "Bearer channel-token"
    assert headers["content-type"] == "application/json"
    assert headers["x-line-retry-key"] == retry_key
    assert captured["timeout"] == 20


def test_line_http_200_is_success(monkeypatch) -> None:
    monkeypatch.setattr("watcher.line.urlopen", lambda *_args, **_kwargs: FakeResponse(200))
    send_line("token", "user", "text", "00000000-0000-4000-8000-000000000002")


def test_line_rejects_invalid_retry_key_without_network(monkeypatch) -> None:
    monkeypatch.setattr(
        "watcher.line.urlopen",
        lambda *_args, **_kwargs: pytest.fail("invalid retry key must not be sent"),
    )
    with pytest.raises(LineError, match="retry key is invalid"):
        send_line("token", "user", "text", "not-a-uuid")


@pytest.mark.parametrize("status", [400, 401, 403, 429, 500])
def test_line_http_errors_are_safe(monkeypatch, status) -> None:
    secret_token = "never-print-token"
    secret_user = "never-print-user"

    def fail(_request, timeout):
        raise HTTPError(
            f"{LINE_PUSH_URL}?token={secret_token}&user={secret_user}",
            status,
            "failure",
            {},
            None,
        )

    monkeypatch.setattr("watcher.line.urlopen", fail)
    with pytest.raises(LineError, match=f"HTTP {status}") as error:
        send_line(
            secret_token,
            secret_user,
            "text",
            "00000000-0000-4000-8000-000000000003",
        )
    assert secret_token not in str(error.value)
    assert secret_user not in str(error.value)


def test_line_unexpected_non_200_is_safe(monkeypatch) -> None:
    monkeypatch.setattr("watcher.line.urlopen", lambda *_args, **_kwargs: FakeResponse(201))
    with pytest.raises(LineError, match="HTTP 201"):
        send_line("token", "user", "text", "00000000-0000-4000-8000-000000000004")


def test_line_timeout_is_safe(monkeypatch) -> None:
    monkeypatch.setattr(
        "watcher.line.urlopen",
        lambda *_args, **_kwargs: (_ for _ in ()).throw(TimeoutError("secret")),
    )
    with pytest.raises(LineError, match="timed out") as error:
        send_line(
            "private-token",
            "private-user",
            "text",
            "00000000-0000-4000-8000-000000000005",
        )
    assert "private-token" not in str(error.value)
    assert "private-user" not in str(error.value)


def test_line_connection_failure_is_safe(monkeypatch) -> None:
    monkeypatch.setattr(
        "watcher.line.urlopen",
        lambda *_args, **_kwargs: (_ for _ in ()).throw(URLError("private-token")),
    )
    with pytest.raises(LineError, match="request failed") as error:
        send_line(
            "private-token",
            "private-user",
            "text",
            "00000000-0000-4000-8000-000000000006",
        )
    assert "private-token" not in str(error.value)
    assert "private-user" not in str(error.value)


def test_line_test_sends_exactly_one_message_without_state_or_page(monkeypatch) -> None:
    calls = []
    monkeypatch.setenv("LINE_CHANNEL_ACCESS_TOKEN", "token")
    monkeypatch.setenv("LINE_USER_ID", "user")
    monkeypatch.setattr(cli, "send_line", lambda *args: calls.append(args))
    monkeypatch.setattr(
        cli,
        "send_discord",
        lambda *_args: pytest.fail("line_test must not call Discord"),
    )
    monkeypatch.setattr(
        cli,
        "GitHubIssueStore",
        lambda **_kwargs: pytest.fail("line_test must not access Issue state"),
    )
    assert cli.run_line_test() == 0
    assert len(calls) == 1
    assert calls[0][2].startswith(
        "【テスト通知】Personal Ops\nLINE通知経路は正常です。\n送信時刻: "
    )
    UUID(calls[0][3])


def test_line_cli_error_does_not_log_token_or_user_id(monkeypatch, capsys) -> None:
    token = "private-line-token"
    user_id = "private-line-user"
    monkeypatch.setenv("LINE_CHANNEL_ACCESS_TOKEN", token)
    monkeypatch.setenv("LINE_USER_ID", user_id)
    monkeypatch.setattr(
        cli,
        "send_line",
        lambda *_args: (_ for _ in ()).throw(LineError("LINE API returned HTTP 401")),
    )
    assert cli.main(["line_test"]) == 1
    output = capsys.readouterr()
    assert token not in output.out + output.err
    assert user_id not in output.out + output.err
