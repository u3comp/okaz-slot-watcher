from __future__ import annotations

import pytest

from watcher.line_destination import LineDestinationError, resolve_line_destination


def test_missing_mode_defaults_to_personal() -> None:
    destination = resolve_line_destination(None, "personal-fixture", "group-fixture")
    assert destination.mode == "personal"
    assert destination.destination_id == "personal-fixture"


@pytest.mark.parametrize(
    ("mode", "expected"),
    [("personal", "personal-fixture"), ("group", "group-fixture")],
)
def test_explicit_mode_selects_destination(mode: str, expected: str) -> None:
    assert resolve_line_destination(mode, "personal-fixture", "group-fixture").destination_id == expected


def test_invalid_mode_fails_closed_without_id_values() -> None:
    with pytest.raises(LineDestinationError) as error:
        resolve_line_destination("unexpected", "private-personal", "private-group")
    message = str(error.value)
    assert "invalid" in message
    assert "private-personal" not in message
    assert "private-group" not in message


@pytest.mark.parametrize("mode", ["personal", "group"])
def test_missing_selected_destination_fails_closed(mode: str) -> None:
    with pytest.raises(LineDestinationError):
        resolve_line_destination(mode, "personal-fixture" if mode == "group" else "", "" if mode == "group" else "group-fixture")


def test_override_is_reserved_for_manual_test_path() -> None:
    assert resolve_line_destination("personal", "personal-fixture", "group-fixture", "group").mode == "group"
    with pytest.raises(LineDestinationError):
        resolve_line_destination("personal", "personal-fixture", "group-fixture", "unexpected")


def test_line_test_uses_group_override_without_logging_id(monkeypatch, capsys) -> None:
    from watcher import cli

    calls: list[tuple] = []
    monkeypatch.setenv("LINE_CHANNEL_ACCESS_TOKEN", "token-fixture")
    monkeypatch.setenv("LINE_USER_ID", "personal-fixture")
    monkeypatch.setenv("LINE_GROUP_ID", "group-fixture")
    monkeypatch.setenv("LINE_DESTINATION_MODE", "personal")
    monkeypatch.setenv("LINE_TEST_DESTINATION", "group")
    monkeypatch.setattr(cli, "send_line", lambda *args: calls.append(args))
    assert cli.run_line_test() == 0
    assert calls[0][1] == "group-fixture"
    output = capsys.readouterr().out
    assert "personal-fixture" not in output
    assert "group-fixture" not in output


def test_line_test_default_is_backward_compatible(monkeypatch) -> None:
    from watcher import cli

    calls: list[tuple] = []
    monkeypatch.setenv("LINE_CHANNEL_ACCESS_TOKEN", "token-fixture")
    monkeypatch.setenv("LINE_USER_ID", "personal-fixture")
    monkeypatch.delenv("LINE_GROUP_ID", raising=False)
    monkeypatch.delenv("LINE_DESTINATION_MODE", raising=False)
    monkeypatch.delenv("LINE_TEST_DESTINATION", raising=False)
    monkeypatch.setattr(cli, "send_line", lambda *args: calls.append(args))
    assert cli.run_line_test() == 0
    assert calls[0][1] == "personal-fixture"


def test_workflow_scopes_routing_only_to_line_test_and_normal() -> None:
    workflow = open(".github/workflows/availability-watcher.yml", encoding="utf-8").read()
    line_test = workflow.split("  line-test:", 1)[1].split("  normal:", 1)[0]
    normal = workflow.split("  normal:", 1)[1].split("  disable-after-cutoff:", 1)[0]
    diagnostic = workflow.split("  diagnostic:", 1)[1].split("  discord-test:", 1)[0]
    discord = workflow.split("  discord-test:", 1)[1].split("  line-test:", 1)[0]
    assert "LINE_GROUP_ID" in line_test
    assert "LINE_DESTINATION_MODE" in line_test
    assert "LINE_TEST_DESTINATION" in line_test
    assert "LINE_GROUP_ID" in normal
    assert "LINE_DESTINATION_MODE" in normal
    assert "LINE_TEST_DESTINATION" not in normal
    assert "LINE_GROUP_ID" not in diagnostic
    assert "LINE_GROUP_ID" not in discord
