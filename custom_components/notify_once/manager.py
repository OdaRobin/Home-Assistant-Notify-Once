"""Manager for Notify once watches."""

from __future__ import annotations

import asyncio
import logging
from typing import Any

from homeassistant.core import CALLBACK_TYPE, CoreState, Event, HomeAssistant, callback
from homeassistant.exceptions import ServiceValidationError
from homeassistant.helpers.dispatcher import async_dispatcher_send
from homeassistant.helpers.event import (
    async_track_point_in_utc_time,
    async_track_state_change_event,
)
from homeassistant.helpers.start import async_at_started
from homeassistant.helpers.storage import Store
from homeassistant.helpers.template import Template
from homeassistant.util import dt as dt_util

from .const import (
    DOMAIN,
    EVENT_CANCELLED,
    EVENT_EXPIRED,
    EVENT_FIRED,
    MAX_WATCHES,
    SAVE_DELAY,
    SIGNAL_UPDATED,
    STORAGE_KEY,
    STORAGE_VERSION,
    TITLE,
)
from .logic import Watch, build_message, create_watch, evaluate, transition

_LOGGER = logging.getLogger(__name__)


class NotifyOnceManager:
    """Keeps all pending watches, arms them and sends the one notification."""

    def __init__(self, hass: HomeAssistant) -> None:
        """Initialise the manager."""
        self.hass = hass
        self._store: Store[dict[str, Any]] = Store(hass, STORAGE_VERSION, STORAGE_KEY)
        self._watches: dict[str, Watch] = {}
        self._unsub_state: dict[str, CALLBACK_TYPE] = {}
        self._unsub_expiry: dict[str, CALLBACK_TYPE] = {}

    # ----- public API -------------------------------------------------

    @property
    def watches(self) -> list[Watch]:
        """Return pending watches, oldest first."""
        return sorted(self._watches.values(), key=lambda watch: watch.created)

    async def async_load(self) -> None:
        """Restore watches from storage and arm the ones that are still valid."""
        data = await self._store.async_load() or {}
        now = dt_util.utcnow()
        for raw in data.get("watches", []):
            try:
                watch = Watch.from_storage(raw)
            except (KeyError, TypeError, ValueError) as err:
                _LOGGER.warning("Dropping unreadable watch %s: %s", raw, err)
                continue
            if watch.is_expired(now):
                self._fire_event(EVENT_EXPIRED, watch)
                continue
            self._watches[watch.id] = watch
            self._arm(watch)
        if self._watches:
            # Entities and notify services may not exist yet during startup.
            async_at_started(self.hass, self._evaluate_restored)
        self._schedule_save()

    async def async_unload(self) -> None:
        """Stop listening and write everything to storage."""
        for watch_id in list(self._unsub_state):
            self._disarm(watch_id)
        await self._store.async_save(self._data_to_save())

    @callback
    def async_add(
        self,
        *,
        entity_id: str,
        condition: str,
        target_state: str | None,
        threshold: float | None,
        notifier: str,
        message: str | None,
        language: str,
        hours: float,
    ) -> Watch:
        """Create and arm a new watch."""
        if len(self._watches) >= MAX_WATCHES:
            raise ServiceValidationError(
                translation_domain=DOMAIN,
                translation_key="too_many_watches",
                translation_placeholders={"max": str(MAX_WATCHES)},
            )
        state = self.hass.states.get(entity_id)
        if state is None:
            raise ServiceValidationError(
                translation_domain=DOMAIN,
                translation_key="entity_not_found",
                translation_placeholders={"entity_id": entity_id},
            )
        watch = create_watch(
            entity_id=entity_id,
            condition=condition,
            notifier=notifier,
            hours=hours,
            now=dt_util.utcnow(),
            target_state=target_state,
            threshold=threshold,
            message=message,
            language=language,
            last_matched=bool(evaluate(condition, state.state, target_state, threshold)),
        )
        self._watches[watch.id] = watch
        self._arm(watch)
        self._changed()
        return watch

    @callback
    def async_cancel(self, watch_id: str) -> None:
        """Cancel one watch without notification."""
        watch = self._remove(watch_id)
        if watch is None:
            raise ServiceValidationError(
                translation_domain=DOMAIN,
                translation_key="watch_not_found",
                translation_placeholders={"id": watch_id},
            )
        self._fire_event(EVENT_CANCELLED, watch)

    @callback
    def async_cancel_all(self) -> int:
        """Cancel every watch without notification and return how many."""
        watches = [self._remove(watch_id) for watch_id in list(self._watches)]
        cancelled = [watch for watch in watches if watch is not None]
        for watch in cancelled:
            self._fire_event(EVENT_CANCELLED, watch)
        return len(cancelled)

    # ----- arming / evaluation ----------------------------------------

    @callback
    def _arm(self, watch: Watch) -> None:
        """Listen for state changes and for the end of the watch."""
        watch_id = watch.id

        @callback
        def _on_state(event: Event) -> None:
            new_state = event.data.get("new_state")
            self._handle_state(watch_id, new_state.state if new_state else None)

        @callback
        def _on_expiry(_now: Any) -> None:
            self._expire(watch_id)

        self._unsub_state[watch_id] = async_track_state_change_event(
            self.hass, [watch.entity_id], _on_state
        )
        self._unsub_expiry[watch_id] = async_track_point_in_utc_time(
            self.hass, _on_expiry, watch.expires
        )

    @callback
    def _disarm(self, watch_id: str) -> None:
        """Remove the listeners of a watch."""
        if unsub := self._unsub_state.pop(watch_id, None):
            unsub()
        if unsub := self._unsub_expiry.pop(watch_id, None):
            unsub()

    @callback
    def _evaluate_restored(self, _hass: HomeAssistant) -> None:
        """Check restored watches once Home Assistant has started."""
        for watch in list(self._watches.values()):
            state = self.hass.states.get(watch.entity_id)
            self._check(watch, state.state if state else None)

    @callback
    def _handle_state(self, watch_id: str, state: str | None) -> None:
        """Handle a state change of a watched entity."""
        if (watch := self._watches.get(watch_id)) is not None:
            self._check(watch, state)

    @callback
    def _check(self, watch: Watch, state: str | None) -> None:
        """Evaluate the condition and fire when it just became true."""
        result = evaluate(watch.condition, state, watch.target_state, watch.threshold)
        last_matched, should_fire = transition(watch.last_matched, result)
        if last_matched != watch.last_matched:
            watch.last_matched = last_matched
            self._schedule_save()
        if should_fire:
            self._trigger(watch)

    @callback
    def _trigger(self, watch: Watch) -> None:
        """Finish a watch: remove it first so it can never fire twice, then notify."""
        self._remove(watch.id)
        self._fire_event(EVENT_FIRED, watch)
        self.hass.async_create_task(
            self._async_send(watch), name=f"{DOMAIN}_send_{watch.id}"
        )

    @callback
    def _expire(self, watch_id: str) -> None:
        """End a watch that ran out of time."""
        if (watch := self._remove(watch_id)) is not None:
            self._fire_event(EVENT_EXPIRED, watch)

    @callback
    def _remove(self, watch_id: str) -> Watch | None:
        """Forget a watch and stop its listeners."""
        self._disarm(watch_id)
        watch = self._watches.pop(watch_id, None)
        if watch is not None:
            self._changed()
        return watch

    # ----- notification -----------------------------------------------

    async def _async_wait_started(self) -> None:
        """Wait until Home Assistant has finished starting (notify services exist)."""
        if self.hass.state is CoreState.running:
            return
        done = asyncio.Event()

        @callback
        def _set(_hass: HomeAssistant) -> None:
            done.set()

        async_at_started(self.hass, _set)
        await done.wait()

    async def _async_send(self, watch: Watch) -> None:
        """Send the one notification of a finished watch."""
        await self._async_wait_started()
        state = self.hass.states.get(watch.entity_id)
        name = state.name if state else watch.entity_id
        state_text = ""
        unit = ""
        if state is not None:
            state_text = state.state
            unit = str(state.attributes.get("unit_of_measurement") or "")
            try:
                state_text = str(
                    Template("{{ state_translated(entity_id) }}", self.hass).async_render(
                        {"entity_id": watch.entity_id}
                    )
                )
            except Exception:  # noqa: BLE001 - fall back to the raw state
                _LOGGER.debug("state_translated failed for %s", watch.entity_id)
        message = build_message(watch.language, name, state_text, unit, watch.message)
        await self._async_notify(watch.notifier, message)

    async def _async_notify(self, notifier: str, message: str) -> None:
        """Send via a notify service or notify entity; fall back to a persistent notification."""
        object_id = notifier.partition(".")[2]
        try:
            if self.hass.services.has_service("notify", object_id):
                await self.hass.services.async_call(
                    "notify",
                    object_id,
                    {"title": TITLE, "message": message},
                    blocking=True,
                )
                return
            if self.hass.states.get(notifier) is not None:
                await self.hass.services.async_call(
                    "notify",
                    "send_message",
                    {"entity_id": notifier, "title": TITLE, "message": message},
                    blocking=True,
                )
                return
            _LOGGER.warning("Notifier %s not found, using a persistent notification", notifier)
        except Exception:  # noqa: BLE001 - never lose the notification
            _LOGGER.exception("Sending via %s failed, using a persistent notification", notifier)
        await self.hass.services.async_call(
            "persistent_notification",
            "create",
            {"title": TITLE, "message": message},
            blocking=False,
        )

    # ----- helpers ----------------------------------------------------

    @callback
    def _fire_event(self, event_type: str, watch: Watch) -> None:
        """Fire a bus event that automations can use."""
        self.hass.bus.async_fire(
            event_type,
            {
                "id": watch.id,
                "entity_id": watch.entity_id,
                "condition": watch.condition,
                "target_state": watch.target_state,
                "threshold": watch.threshold,
                "notifier": watch.notifier,
            },
        )

    @callback
    def _changed(self) -> None:
        """Persist and tell the sensor."""
        self._schedule_save()
        async_dispatcher_send(self.hass, SIGNAL_UPDATED)

    @callback
    def _schedule_save(self) -> None:
        """Write to storage soon."""
        self._store.async_delay_save(self._data_to_save, SAVE_DELAY)

    def _data_to_save(self) -> dict[str, Any]:
        """Return the data written to storage."""
        return {"watches": [watch.to_storage() for watch in self.watches]}
