from __future__ import annotations

import json
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen
from uuid import UUID


LINE_PUSH_URL = "https://api.line.me/v2/bot/message/push"


class LineError(RuntimeError):
    pass


def send_line(
    channel_access_token: str,
    destination_id: str,
    content: str,
    retry_key: str,
) -> None:
    if not channel_access_token:
        raise LineError("LINE_CHANNEL_ACCESS_TOKEN is not configured")
    if not destination_id:
        raise LineError("LINE destination is not configured")
    if not retry_key:
        raise LineError("LINE retry key is not configured")
    try:
        UUID(retry_key)
    except (ValueError, AttributeError):
        raise LineError("LINE retry key is invalid") from None

    payload = json.dumps(
        {
            "to": destination_id,
            "messages": [{"type": "text", "text": content}],
        },
        ensure_ascii=False,
    ).encode("utf-8")
    request = Request(
        LINE_PUSH_URL,
        data=payload,
        method="POST",
        headers={
            "Authorization": f"Bearer {channel_access_token}",
            "Content-Type": "application/json",
            "User-Agent": "okaz-slot-watcher",
            "X-Line-Retry-Key": retry_key,
        },
    )
    try:
        with urlopen(request, timeout=20) as response:
            if response.status != 200:
                raise LineError(f"LINE API returned HTTP {response.status}")
    except HTTPError as exc:
        raise LineError(f"LINE API returned HTTP {exc.code}") from None
    except TimeoutError:
        raise LineError("LINE API request timed out") from None
    except URLError:
        raise LineError("LINE API request failed") from None
