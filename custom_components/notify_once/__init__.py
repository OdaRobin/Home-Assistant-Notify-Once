"""Notify once: get notified exactly once when an entity reaches a state or threshold."""

from __future__ import annotations

import logging
from pathlib import Path
from typing import Any

import voluptuous as vol

from homeassistant.components.frontend import add_extra_js_url
from homeassistant.components.http import StaticPathConfig
from homeassistant.config_entries import ConfigEntry
from homeassistant.const import Platform
from homeassistant.core import (
    HomeAssistant,
    ServiceCall,
    ServiceResponse,
    SupportsResponse,
)
from homeassistant.exceptions import ServiceValidationError
from homeassistant.helpers import config_validation as cv
from homeassistant.helpers.storage import Store
from homeassistant.helpers.typing import ConfigType
from homeassistant.loader import async_get_integration

from .const import (
    CARD_FILENAME,
    CARD_URL,
    DEFAULT_HOURS,
    DEFAULT_NOTIFIER,
    DOMAIN,
    MAX_HOURS,
    SERVICE_CANCEL,
    SERVICE_CANCEL_ALL,
    SERVICE_WATCH,
    STORAGE_KEY,
    STORAGE_VERSION,
)
from .logic import CONDITIONS, normalize_notifier, normalize_state_value
from .manager import NotifyOnceManager

_LOGGER = logging.getLogger(__name__)

PLATFORMS = [Platform.SENSOR]

CONFIG_SCHEMA = cv.config_entry_only_config_schema(DOMAIN)


def _notifier(value: Any) -> str:
    """Validate a notify service or notify entity."""
    try:
        return normalize_notifier(value)
    except ValueError as err:
        raise vol.Invalid(str(err)) from err


def _check_request(data: dict[str, Any]) -> dict[str, Any]:
    """Make sure the fields that belong to the chosen condition are present."""
    if data["condition"] == "state":
        if "state" not in data:
            raise vol.Invalid("'state' is required when condition is 'state'")
    elif "threshold" not in data:
        raise vol.Invalid("'threshold' is required when condition is 'above' or 'below'")
    return data


WATCH_SCHEMA = vol.All(
    vol.Schema(
        {
            vol.Required("entity_id"): cv.entity_id,
            vol.Optional("condition", default="state"): vol.In(CONDITIONS),
            vol.Optional("state"): vol.All(normalize_state_value, vol.Length(min=1)),
            vol.Optional("threshold"): vol.Coerce(float),
            vol.Optional("notifier", default=DEFAULT_NOTIFIER): _notifier,
            vol.Optional("message"): cv.string,
            vol.Optional("hours", default=DEFAULT_HOURS): vol.All(
                vol.Coerce(float), vol.Range(min=0.01, max=MAX_HOURS)
            ),
            vol.Optional("language"): cv.string,
        }
    ),
    _check_request,
)

CANCEL_SCHEMA = vol.Schema({vol.Required("id"): cv.string})


def _manager(hass: HomeAssistant) -> NotifyOnceManager:
    """Return the running manager or raise a helpful error."""
    manager = hass.data.get(DOMAIN, {}).get("manager")
    if manager is None:
        raise ServiceValidationError(
            translation_domain=DOMAIN, translation_key="not_loaded"
        )
    return manager


async def async_setup(hass: HomeAssistant, config: ConfigType) -> bool:
    """Register the dashboard card and the services."""
    hass.data.setdefault(DOMAIN, {})
    await _async_register_card(hass)
    _async_register_services(hass)
    return True


async def _async_register_card(hass: HomeAssistant) -> None:
    """Serve the card and load it in every dashboard, no resource entry needed."""
    card_path = Path(__file__).parent / "www" / CARD_FILENAME
    await hass.http.async_register_static_paths(
        [StaticPathConfig(CARD_URL, str(card_path), False)]
    )
    integration = await async_get_integration(hass, DOMAIN)
    add_extra_js_url(hass, f"{CARD_URL}?v={integration.version}")


def _async_register_services(hass: HomeAssistant) -> None:
    """Register the services."""

    async def handle_watch(call: ServiceCall) -> ServiceResponse:
        data = call.data
        watch = _manager(hass).async_add(
            entity_id=data["entity_id"],
            condition=data["condition"],
            target_state=data.get("state"),
            threshold=data.get("threshold"),
            notifier=data["notifier"],
            message=data.get("message") or None,
            language=data.get("language") or hass.config.language,
            hours=data["hours"],
        )
        return {"id": watch.id, "expires": watch.expires.isoformat()}

    async def handle_cancel(call: ServiceCall) -> None:
        _manager(hass).async_cancel(call.data["id"])

    async def handle_cancel_all(call: ServiceCall) -> ServiceResponse:
        return {"cancelled": _manager(hass).async_cancel_all()}

    hass.services.async_register(
        DOMAIN,
        SERVICE_WATCH,
        handle_watch,
        schema=WATCH_SCHEMA,
        supports_response=SupportsResponse.OPTIONAL,
    )
    hass.services.async_register(
        DOMAIN, SERVICE_CANCEL, handle_cancel, schema=CANCEL_SCHEMA
    )
    hass.services.async_register(
        DOMAIN,
        SERVICE_CANCEL_ALL,
        handle_cancel_all,
        schema=vol.Schema({}),
        supports_response=SupportsResponse.OPTIONAL,
    )


async def async_setup_entry(hass: HomeAssistant, entry: ConfigEntry) -> bool:
    """Set up Notify once from a config entry."""
    manager = NotifyOnceManager(hass)
    await manager.async_load()
    hass.data[DOMAIN]["manager"] = manager
    await hass.config_entries.async_forward_entry_setups(entry, PLATFORMS)
    return True


async def async_unload_entry(hass: HomeAssistant, entry: ConfigEntry) -> bool:
    """Unload the config entry; pending watches stay in storage."""
    if not await hass.config_entries.async_unload_platforms(entry, PLATFORMS):
        return False
    manager: NotifyOnceManager | None = hass.data[DOMAIN].pop("manager", None)
    if manager is not None:
        await manager.async_unload()
    return True


async def async_remove_entry(hass: HomeAssistant, entry: ConfigEntry) -> None:
    """Delete the stored watches when the integration is removed."""
    await Store(hass, STORAGE_VERSION, STORAGE_KEY).async_remove()
