"""Pure logic of Notify once.

This module deliberately has no Home Assistant imports so that it can be unit
tested with plain Python.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
import math
import re
from typing import Any
import uuid

UNAVAILABLE_STATES = ("unavailable", "unknown")
CONDITIONS = ("state", "above", "below")
NOTIFIER_RE = re.compile(r"^notify\.[a-z0-9_]+$")

MESSAGE_TEMPLATES = {
    "de": "{name} ist jetzt {state}",
    "en": "{name} is now {state}",
}


def to_number(value: Any) -> float | None:
    """Return value as a finite float, or None."""
    if value is None or isinstance(value, bool):
        return None
    try:
        number = float(value)
    except (TypeError, ValueError):
        return None
    return number if math.isfinite(number) else None


def normalize_state_value(value: Any) -> str:
    """Return a state value as string (YAML turns on/off into booleans)."""
    if value is True:
        return "on"
    if value is False:
        return "off"
    return str(value).strip()


def normalize_notifier(value: Any) -> str:
    """Return a notifier as 'notify.<name>' or raise ValueError."""
    text = str(value).strip().lower()
    if not text.startswith("notify."):
        text = f"notify.{text}"
    if not NOTIFIER_RE.match(text):
        raise ValueError(f"Invalid notifier: {value!r}")
    return text


def evaluate(
    condition: str,
    state: str | None,
    target_state: str | None,
    threshold: float | None,
) -> bool | None:
    """Evaluate a condition against a state.

    Returns True or False, or None when the state says nothing about the
    condition (entity unavailable or unknown, non-numeric value for a numeric
    condition). None never counts as leaving or entering the condition.
    """
    if state is None:
        return None
    if condition == "state":
        if state == target_state:
            return True
        if state in UNAVAILABLE_STATES:
            return None
        return False
    if state in UNAVAILABLE_STATES:
        return None
    number = to_number(state)
    limit = to_number(threshold)
    if number is None or limit is None:
        return None
    if condition == "above":
        return number > limit
    if condition == "below":
        return number < limit
    return None


def transition(last_matched: bool, result: bool | None) -> tuple[bool, bool]:
    """Return (new_last_matched, should_fire).

    A watch fires when the condition becomes true, never while it already was.
    """
    if result is None:
        return last_matched, False
    if result and not last_matched:
        return True, True
    return result, False


def parse_datetime(value: Any) -> datetime:
    """Parse an ISO datetime; naive values are treated as UTC."""
    parsed = datetime.fromisoformat(str(value))
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=timezone.utc)
    return parsed


@dataclass
class Watch:
    """One pending one-time watch."""

    id: str
    entity_id: str
    condition: str
    notifier: str
    created: datetime
    expires: datetime
    target_state: str | None = None
    threshold: float | None = None
    message: str | None = None
    language: str = "en"
    last_matched: bool = False

    def to_storage(self) -> dict[str, Any]:
        """Serialise for persistent storage."""
        return {
            "id": self.id,
            "entity_id": self.entity_id,
            "condition": self.condition,
            "notifier": self.notifier,
            "created": self.created.isoformat(),
            "expires": self.expires.isoformat(),
            "target_state": self.target_state,
            "threshold": self.threshold,
            "message": self.message,
            "language": self.language,
            "last_matched": self.last_matched,
        }

    def to_attributes(self) -> dict[str, Any]:
        """Serialise for the sensor attribute that the card reads."""
        return {
            "id": self.id,
            "entity_id": self.entity_id,
            "condition": self.condition,
            "target_state": self.target_state,
            "threshold": self.threshold,
            "notifier": self.notifier,
            "message": self.message,
            "created": self.created.isoformat(),
            "expires": self.expires.isoformat(),
        }

    @classmethod
    def from_storage(cls, data: dict[str, Any]) -> Watch:
        """Restore from persistent storage or raise KeyError/TypeError/ValueError."""
        condition = str(data["condition"])
        if condition not in CONDITIONS:
            raise ValueError(f"Unknown condition: {condition}")
        return cls(
            id=str(data["id"]),
            entity_id=str(data["entity_id"]),
            condition=condition,
            notifier=normalize_notifier(data["notifier"]),
            created=parse_datetime(data["created"]),
            expires=parse_datetime(data["expires"]),
            target_state=data.get("target_state"),
            threshold=to_number(data.get("threshold")),
            message=data.get("message"),
            language=str(data.get("language") or "en"),
            last_matched=bool(data.get("last_matched", False)),
        )

    def is_expired(self, now: datetime) -> bool:
        """Return True when the watch has run out."""
        return self.expires <= now


def create_watch(
    *,
    entity_id: str,
    condition: str,
    notifier: str,
    hours: float,
    now: datetime,
    target_state: str | None = None,
    threshold: float | None = None,
    message: str | None = None,
    language: str = "en",
    last_matched: bool = False,
) -> Watch:
    """Build a new watch."""
    return Watch(
        id=uuid.uuid4().hex[:12],
        entity_id=entity_id,
        condition=condition,
        notifier=notifier,
        created=now,
        expires=now + timedelta(hours=hours),
        target_state=target_state,
        threshold=threshold,
        message=message or None,
        language=language,
        last_matched=last_matched,
    )


def build_message(
    language: str,
    name: str,
    state_text: str,
    unit: str,
    custom: str | None = None,
) -> str:
    """Return the notification text."""
    if custom:
        return custom
    lang = "de" if str(language).lower().startswith("de") else "en"
    value = f"{state_text} {unit}".strip() if unit else state_text
    return MESSAGE_TEMPLATES[lang].format(name=name, state=value)
