from pathlib import Path

import pytest
from playwright.sync_api import Error as PlaywrightError
from playwright.sync_api import TimeoutError as PlaywrightTimeoutError

from watcher import live
from watcher.model import SlotStatus


FIXTURE = (Path(__file__).parent / "fixtures" / "sold_out.html").read_text(
    encoding="utf-8"
)


class FakeLocator:
    def __init__(self, failures: set[str]):
        self.failures = failures

    @property
    def first(self):
        return self

    def locator(self, _selector):
        return self

    def wait_for(self, **_kwargs):
        if "wait" in self.failures:
            raise PlaywrightTimeoutError("sensitive timeout details")

    def count(self):
        if "count" in self.failures:
            raise PlaywrightError("sensitive count details")
        return 1

    def evaluate(self, _script):
        if "evaluate" in self.failures:
            raise PlaywrightError("sensitive evaluate details")
        return FIXTURE


class FakePage:
    def __init__(self, failures: set[str]):
        self.failures = failures

    def goto(self, *_args, **_kwargs):
        if "goto_timeout" in self.failures:
            raise PlaywrightTimeoutError("sensitive URL details")
        if "goto" in self.failures:
            raise PlaywrightError("sensitive network details")
        if "fatal" in self.failures:
            raise MemoryError("do not swallow")

    def locator(self, _selector):
        return FakeLocator(self.failures)


class FakeContext:
    def __init__(self, failures: set[str]):
        self.failures = failures

    def new_page(self):
        if "page" in self.failures:
            raise PlaywrightError("sensitive page details")
        return FakePage(self.failures)


class FakeBrowser:
    def __init__(self, failures: set[str]):
        self.failures = failures

    def new_context(self, **_kwargs):
        if "context" in self.failures:
            raise PlaywrightError("sensitive context details")
        return FakeContext(self.failures)

    def close(self):
        if "close" in self.failures:
            raise PlaywrightError("sensitive close details")


class FakeChromium:
    def __init__(self, runtime):
        self.runtime = runtime

    def launch(self, **kwargs):
        self.runtime.launch_options = kwargs
        if "launch" in self.runtime.failures:
            raise PlaywrightError("sensitive launch details")
        if "launch_io" in self.runtime.failures:
            raise OSError("sensitive executable path")
        return FakeBrowser(self.runtime.failures)


class FakePlaywright:
    def __init__(self, runtime):
        self.runtime = runtime
        self.chromium = FakeChromium(runtime)

    def stop(self):
        if "stop" in self.runtime.failures:
            raise PlaywrightError("sensitive stop details")


class FakeManager:
    def __init__(self, failures: set[str]):
        self.failures = failures
        self.launch_options = None

    def start(self):
        if "start" in self.failures:
            raise PlaywrightError("sensitive runtime details")
        return FakePlaywright(self)


def install_runtime(monkeypatch, *failures: str) -> FakeManager:
    runtime = FakeManager(set(failures))
    monkeypatch.setattr(live, "sync_playwright", lambda: runtime)
    return runtime


@pytest.mark.parametrize(
    ("failure", "classification"),
    [
        ("start", "playwright_error"),
        ("launch", "playwright_error"),
        ("launch_io", "browser_io_error"),
        ("context", "playwright_error"),
        ("page", "playwright_error"),
        ("goto", "playwright_error"),
        ("goto_timeout", "playwright_timeout"),
        ("wait", "playwright_timeout"),
        ("count", "playwright_error"),
        ("evaluate", "playwright_error"),
        ("close", "browser_close_error"),
        ("stop", "playwright_stop_error"),
    ],
)
def test_playwright_failures_become_safe_unknown(monkeypatch, failure, classification) -> None:
    install_runtime(monkeypatch, failure)
    result = live.observe_live_page()
    assert result["error_class"] == classification
    assert set(result["statuses"].values()) == {SlotStatus.UNKNOWN.value}
    assert "sensitive" not in str(result)


def test_close_failure_does_not_replace_original_failure(monkeypatch) -> None:
    install_runtime(monkeypatch, "goto", "close")
    result = live.observe_live_page()
    assert result["error_class"] == "playwright_error"


def test_default_uses_playwright_managed_chromium(monkeypatch) -> None:
    monkeypatch.delenv("PLAYWRIGHT_CHANNEL", raising=False)
    runtime = install_runtime(monkeypatch)
    result = live.observe_live_page()
    assert result["parser_ok"]
    assert runtime.launch_options == {"headless": True}


def test_explicit_channel_is_supported(monkeypatch) -> None:
    monkeypatch.setenv("PLAYWRIGHT_CHANNEL", "chrome")
    runtime = install_runtime(monkeypatch)
    live.observe_live_page()
    assert runtime.launch_options == {"headless": True, "channel": "chrome"}


def test_fatal_runtime_errors_are_not_swallowed(monkeypatch) -> None:
    install_runtime(monkeypatch, "fatal")
    with pytest.raises(MemoryError):
        live.observe_live_page()
