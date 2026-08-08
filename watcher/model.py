from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime
import re
import unicodedata
from enum import StrEnum
from zoneinfo import ZoneInfo


PRODUCT_URL = (
    "https://shop.okaz-design.jp/store/"
    "%E8%8C%B6%E3%81%A8%E6%9E%9C%E5%AE%9F-p850942259"
)
PRODUCT_ID = "850942259"
PRODUCT_TITLE = "茶と果実"
STATE_ISSUE_TITLE = "Okaz slot watcher state (machine-managed)"
STATE_MARKER = "<!-- okaz-slot-watcher-state:v1 -->"
JST = ZoneInfo("Asia/Tokyo")
CUTOFF_JST = datetime(2026, 8, 23, 16, 30, tzinfo=JST)


class SlotStatus(StrEnum):
    AVAILABLE = "AVAILABLE"
    SOLD_OUT = "SOLD_OUT"
    MISSING = "MISSING"
    UNKNOWN = "UNKNOWN"


@dataclass(frozen=True)
class Slot:
    key: str
    label: str


SLOTS = (
    Slot("2026-08-22_1030", "8/22（土）10:30-12:30"),
    Slot("2026-08-22_1400", "8/22（土）14:00-16:00"),
    Slot("2026-08-23_1030", "8/23（日）10:30-12:30"),
    Slot("2026-08-23_1400", "8/23（日）14:00-16:00"),
)


def normalize_slot_label(label: str) -> str:
    return " ".join(unicodedata.normalize("NFKC", label).replace("\u3000", " ").split())


def stable_slot_key(label: str, reference: datetime | None = None) -> str | None:
    normalized = normalize_slot_label(label)
    match = re.search(
        r"(\d{1,2})\s*/\s*(\d{1,2})[^0-9]{0,12}(\d{1,2})\s*:\s*(\d{2})\s*-\s*(\d{1,2})\s*:\s*(\d{2})",
        normalized,
    )
    if not match:
        return None
    year = (reference or now_jst()).year
    month, day, hour, minute = match.group(1), match.group(2), match.group(3), match.group(4)
    return f"{year:04d}-{int(month):02d}-{int(day):02d}_{int(hour):02d}{minute}"


def now_jst() -> datetime:
    return datetime.now(tz=JST)


def is_after_cutoff(at: datetime | None = None) -> bool:
    current = at or now_jst()
    if current.tzinfo is None:
        raise ValueError("cutoff comparison requires a timezone-aware datetime")
    return current.astimezone(JST) >= CUTOFF_JST
