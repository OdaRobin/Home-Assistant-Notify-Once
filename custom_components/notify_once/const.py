"""Constants for Notify once."""

from __future__ import annotations

DOMAIN = "notify_once"
TITLE = "Notify once"

STORAGE_KEY = f"{DOMAIN}.watches"
STORAGE_VERSION = 1
SAVE_DELAY = 1

CARD_FILENAME = "notify-once-card.js"
CARD_URL = f"/{DOMAIN}/{CARD_FILENAME}"

SERVICE_WATCH = "watch"
SERVICE_CANCEL = "cancel"
SERVICE_CANCEL_ALL = "cancel_all"

EVENT_FIRED = f"{DOMAIN}_fired"
EVENT_EXPIRED = f"{DOMAIN}_expired"
EVENT_CANCELLED = f"{DOMAIN}_cancelled"

SIGNAL_UPDATED = f"{DOMAIN}_updated"

DEFAULT_HOURS = 24
MAX_HOURS = 720
MAX_WATCHES = 50
DEFAULT_NOTIFIER = "notify.persistent_notification"
