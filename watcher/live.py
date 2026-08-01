from __future__ import annotations

import os

from playwright.sync_api import TimeoutError as PlaywrightTimeoutError
from playwright.sync_api import sync_playwright

from .model import PRODUCT_ID, PRODUCT_URL
from .parser import parse_rendered_html, unknown_observation


HYDRATED_PRODUCT_SELECTOR = (
    f".ec-storefront-v3:not(.ec-storefront-v3-ssr) "
    f".ecwid-productBrowser-ProductPage-{PRODUCT_ID}"
)


def observe_live_page() -> dict:
    channel = os.environ.get("PLAYWRIGHT_CHANNEL", "chrome")
    with sync_playwright() as playwright:
        browser = playwright.chromium.launch(channel=channel, headless=True)
        try:
            context = browser.new_context(locale="ja-JP", timezone_id="Asia/Tokyo")
            page = context.new_page()
            page.goto(PRODUCT_URL, wait_until="domcontentloaded", timeout=60_000)
            locator = page.locator(HYDRATED_PRODUCT_SELECTOR)
            try:
                locator.first.wait_for(state="attached", timeout=30_000)
                locator.locator('input[name="ご希望の日時"]').first.wait_for(
                    state="attached", timeout=30_000
                )
            except PlaywrightTimeoutError:
                return unknown_observation("hydrated product DOM did not appear")
            count = locator.count()
            if count != 1:
                return unknown_observation(f"expected one hydrated product DOM; found {count}")
            source = locator.first.evaluate(
                "element => element.closest('.ec-storefront-v3').outerHTML"
            )
            return parse_rendered_html(source)
        finally:
            browser.close()
