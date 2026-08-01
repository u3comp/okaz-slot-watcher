from __future__ import annotations

import json
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen


class DiscordError(RuntimeError):
    pass


def send_discord(webhook_url: str, content: str) -> None:
    if not webhook_url:
        raise DiscordError("DISCORD_WEBHOOK_URL is not configured")
    payload = json.dumps(
        {"content": content, "allowed_mentions": {"parse": []}}, ensure_ascii=False
    ).encode("utf-8")
    request = Request(
        webhook_url,
        data=payload,
        method="POST",
        headers={"Content-Type": "application/json", "User-Agent": "okaz-slot-watcher"},
    )
    try:
        with urlopen(request, timeout=20) as response:
            if response.status not in (200, 204):
                raise DiscordError(f"Discord returned HTTP {response.status}")
    except HTTPError as exc:
        raise DiscordError(f"Discord returned HTTP {exc.code}") from None
    except (URLError, TimeoutError):
        raise DiscordError("Discord request failed") from None
