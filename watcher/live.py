from __future__ import annotations

import os

from playwright.sync_api import Error as PlaywrightError
from playwright.sync_api import TimeoutError as PlaywrightTimeoutError
from playwright.sync_api import sync_playwright

from .model import PRODUCT_ID, PRODUCT_URL
from .parser import parse_rendered_html, unknown_observation


HYDRATED_PRODUCT_SELECTOR = (
    f".ec-storefront-v3:not(.ec-storefront-v3-ssr) "
    f".ecwid-productBrowser-ProductPage-{PRODUCT_ID}"
)


def observe_live_page() -> dict:
    manager = None
    playwright = None
    browser = None
    observation = None

    try:
        manager = sync_playwright()
        playwright = manager.start()
        launch_options = {"headless": True}
        channel = os.environ.get("PLAYWRIGHT_CHANNEL", "").strip()
        if channel:
            launch_options["channel"] = channel
        browser = playwright.chromium.launch(**launch_options)
        context = browser.new_context(locale="ja-JP", timezone_id="Asia/Tokyo")
        page = context.new_page()
        page.goto(PRODUCT_URL, wait_until="domcontentloaded", timeout=60_000)
        locator = page.locator(HYDRATED_PRODUCT_SELECTOR)
        locator.first.wait_for(state="attached", timeout=30_000)
        locator.locator('input[name="ご希望の日時"]').first.wait_for(
            state="attached", timeout=30_000
        )
        count = locator.count()
        if count != 1:
            observation = unknown_observation("hydrated_dom_ambiguous")
        else:
            source = locator.first.evaluate(
                "element => element.closest('.ec-storefront-v3').outerHTML"
            )
            observation = parse_rendered_html(source)
    except PlaywrightTimeoutError:
        observation = unknown_observation("playwright_timeout")
    except PlaywrightError:
        observation = unknown_observation("playwright_error")
    except OSError:
        observation = unknown_observation("browser_io_error")
    finally:
        if browser is not None:
            try:
                browser.close()
            except (PlaywrightError, OSError):
                if observation is None or observation.get("parser_ok", False):
                    observation = unknown_observation("browser_close_error")
        if playwright is not None:
            try:
                playwright.stop()
            except (PlaywrightError, OSError):
                if observation is None or observation.get("parser_ok", False):
                    observation = unknown_observation("playwright_stop_error")

    return observation or unknown_observation("playwright_error")
