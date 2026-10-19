"""Sensor that lists the active Notify once watches."""

from __future__ import annotations

from typing import Any

from homeassistant.components.sensor import SensorEntity
from homeassistant.config_entries import ConfigEntry
from homeassistant.core import HomeAssistant, callback
from homeassistant.helpers.device_registry import DeviceEntryType, DeviceInfo
from homeassistant.helpers.dispatcher import async_dispatcher_connect
from homeassistant.helpers.entity_platform import AddEntitiesCallback

from .const import DOMAIN, SIGNAL_UPDATED, TITLE
from .manager import NotifyOnceManager


async def async_setup_entry(
    hass: HomeAssistant,
    entry: ConfigEntry,
    async_add_entities: AddEntitiesCallback,
) -> None:
    """Set up the sensor."""
    async_add_entities([ActiveWatchesSensor(hass.data[DOMAIN]["manager"], entry)])


class ActiveWatchesSensor(SensorEntity):
    """Number of active watches; the attribute 'watches' holds the details."""

    _attr_has_entity_name = True
    _attr_should_poll = False
    _attr_translation_key = "active_watches"
    _unrecorded_attributes = frozenset({"watches"})

    def __init__(self, manager: NotifyOnceManager, entry: ConfigEntry) -> None:
        """Initialise the sensor."""
        self._manager = manager
        self._attr_unique_id = f"{entry.entry_id}_active_watches"
        self._attr_device_info = DeviceInfo(
            identifiers={(DOMAIN, entry.entry_id)},
            name=TITLE,
            entry_type=DeviceEntryType.SERVICE,
        )

    @property
    def native_value(self) -> int:
        """Return the number of active watches."""
        return len(self._manager.watches)

    @property
    def extra_state_attributes(self) -> dict[str, Any]:
        """Return the active watches for the dashboard card."""
        return {"watches": [watch.to_attributes() for watch in self._manager.watches]}

    async def async_added_to_hass(self) -> None:
        """Update whenever the manager changes."""
        self.async_on_remove(
            async_dispatcher_connect(self.hass, SIGNAL_UPDATED, self._handle_update)
        )

    @callback
    def _handle_update(self) -> None:
        """Write the new state."""
        self.async_write_ha_state()
