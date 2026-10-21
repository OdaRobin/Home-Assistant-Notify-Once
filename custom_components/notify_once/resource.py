"""Register the card as a Lovelace resource.

Home Assistant waits for dashboard resources before it draws a dashboard.
Scripts added with add_extra_js_url carry no such guarantee, so a card can be
drawn before its element exists and then shows "Custom element doesn't exist".

This module has no Home Assistant imports so that it can be tested on its own.
"""

from __future__ import annotations

import logging
from typing import Any

_LOGGER = logging.getLogger(__name__)

RESOURCE_TYPE = "module"


def _find_resources(hass: Any) -> Any | None:
    """Return the Lovelace resource collection, or None.

    Current Home Assistant keeps it as an attribute of the Lovelace data object,
    older versions as an entry of a dict.
    """
    lovelace = hass.data.get("lovelace")
    resources = getattr(lovelace, "resources", None)
    if resources is None and isinstance(lovelace, dict):
        resources = lovelace.get("resources")
    return resources


async def async_ensure_card_resource(hass: Any, url: str) -> str:
    """Create or update the dashboard resource for the card.

    Returns one of: created, updated, unchanged, unavailable, failed.
    Never raises: the extra JS fallback still works when this does not.
    """
    try:
        resources = _find_resources(hass)
        if resources is None or not hasattr(resources, "async_create_item"):
            _LOGGER.debug("Lovelace resources are not editable (YAML mode), skipping")
            return "unavailable"

        if not getattr(resources, "loaded", True):
            await resources.async_load()
            resources.loaded = True

        base = url.split("?")[0]
        for item in resources.async_items():
            if str(item.get("url", "")).split("?")[0] != base:
                continue
            if item.get("url") == url and item.get("type") == RESOURCE_TYPE:
                return "unchanged"
            await resources.async_update_item(
                item["id"], {"res_type": RESOURCE_TYPE, "url": url}
            )
            return "updated"

        await resources.async_create_item({"res_type": RESOURCE_TYPE, "url": url})
        return "created"
    except Exception:  # noqa: BLE001 - registering the resource is best effort
        _LOGGER.warning(
            "Could not register the Notify once card as a dashboard resource; "
            "it is still loaded as an extra module",
            exc_info=True,
        )
        return "failed"
