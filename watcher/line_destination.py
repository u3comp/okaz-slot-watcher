from __future__ import annotations

from dataclasses import dataclass


class LineDestinationError(RuntimeError):
    """Safe configuration error that never contains a destination value."""


@dataclass(frozen=True)
class LineDestination:
    mode: str
    destination_id: str


def resolve_line_destination(
    mode: str | None,
    personal_id: str,
    group_id: str,
    override: str = "configured",
) -> LineDestination:
    """Resolve a LINE destination without exposing its value.

    ``override`` is accepted only by the manual line_test path. Normal and
    scheduled execution must use ``configured`` so a workflow input cannot
    silently change the production route.
    """

    selected = (mode or "personal").strip().lower() or "personal"
    if override != "configured":
        if override not in {"personal", "group"}:
            raise LineDestinationError("LINE destination override is invalid")
        selected = override
    if selected not in {"personal", "group"}:
        raise LineDestinationError("LINE destination mode is invalid")

    destination_id = personal_id if selected == "personal" else group_id
    if not destination_id:
        raise LineDestinationError(f"LINE {selected} destination is not configured")
    return LineDestination(mode=selected, destination_id=destination_id)
