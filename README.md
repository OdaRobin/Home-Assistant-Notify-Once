# Notify once

Get notified **exactly once** when an entity reaches a state or crosses a threshold. No automation to create, no automation to delete afterwards.

Pick an entity on a dashboard card, say what you are waiting for ("the rain sensor reports rain", "the temperature rises above 25"), choose where to be notified, press start. When it happens you get one notification and the watch is gone.

## Features

- Dashboard card with an entity picker, a **dropdown of the states the entity can have**, a threshold field for numbers, and a device picker for all your notify services.
- Works with any entity. For entities without a fixed state list (for example a text sensor), the card offers the states seen in the last 30 days.
- Every active watch is listed on the card and can be **cancelled individually**.
- Watches **survive restarts** of Home Assistant.
- Each watch ends by itself after a maximum wait (default 24 h, up to 30 days).
- Services and events for use in automations and scripts.
- English and German.

## Installation

### HACS (recommended)

1. HACS, three-dot menu, **Custom repositories**.
2. Add `https://github.com/OdaRobin/Home-Assistant-Notify-Once` with the type **Integration**.
3. Install **Notify once** and restart Home Assistant.
4. **Settings, Devices & services, Add integration, Notify once.** There is nothing to configure.

### Manual

Copy `custom_components/notify_once` into your `config/custom_components` folder, restart, then add the integration as above.

## The card

The integration loads the card in every dashboard by itself. You do not have to add a resource. Add the card from the card picker ("Notify once") or in YAML:

```yaml
type: custom:notify-once-card
```

Optional settings:

```yaml
type: custom:notify-once-card
title: Notify once
default_notifier: notify.mobile_app_my_phone   # preselected device
default_hours: 24                              # preselected maximum wait
notifiers:                                     # limit the device list (default: all notify services)
  - service: notify.mobile_app_my_phone
    name: My phone
sensor: sensor.notify_once_active_watches      # only if you renamed the sensor
```

The last used device is remembered per browser.

## How a watch behaves

- It fires when the condition **becomes** true. If the condition is already true when you start the watch, it waits until the value has left the condition and entered it again.
- An entity that goes `unavailable` or `unknown` does not count as leaving the condition, so a short connection drop cannot cause a false notification. If you want to be notified about `unavailable` itself, use it as the target state.
- It sends one notification and is removed. It can never fire twice.
- If the maximum wait runs out first, the watch ends silently (the event `notify_once_expired` is fired).
- After a restart, a watch whose condition became true while Home Assistant was down fires once Home Assistant has started.
- Watches that expired while Home Assistant was down are dropped.
- If the chosen notify service does not exist or fails, the message is shown as a persistent notification in Home Assistant instead of getting lost.
- At most 50 watches can be active at the same time.

## Services

### `notify_once.watch`

| Field | Description |
| --- | --- |
| `entity_id` | Entity to watch (required). |
| `condition` | `state` (default), `above` or `below`. |
| `state` | Target state, required for `condition: state`. Quote values like `"on"` in YAML. |
| `threshold` | Number, required for `above` and `below`. |
| `notifier` | Notify service or notify entity, for example `notify.mobile_app_my_phone`. Default: persistent notification. |
| `message` | Custom text. Default: an automatic text such as "Rain is now raining". |
| `hours` | Maximum wait in hours, default 24, maximum 720. |
| `language` | `de` or `en` for the automatic text. Default: Home Assistant language. |

The service returns the `id` and `expires` of the new watch when called with a response.

```yaml
action: notify_once.watch
data:
  entity_id: sensor.rain
  state: raining
  notifier: notify.mobile_app_my_phone
```

```yaml
action: notify_once.watch
data:
  entity_id: sensor.living_room_temperature
  condition: above
  threshold: 25
  message: Open the windows
  hours: 6
```

### `notify_once.cancel`

Cancels one watch by `id` without a notification. The IDs are in the `watches` attribute of the sensor.

### `notify_once.cancel_all`

Cancels every active watch without a notification.

## Sensor

`sensor.notify_once_active_watches` shows the number of active watches. Its attribute `watches` lists them (id, entity, condition, target state or threshold, notifier, creation and expiry time). The card reads this sensor, so it works for every user, not only administrators.

## Events

`notify_once_fired`, `notify_once_expired` and `notify_once_cancelled`, each with `id`, `entity_id`, `condition`, `target_state`, `threshold` and `notifier`. Use them as automation triggers, for example to log or chain actions.

## Migrating from the script version

If you used the earlier `script.notify_once` together with the card:

1. Install the integration and add it.
2. In the card configuration, remove the `script:` line.
3. Delete the old script. Its running watches are not transferred, start new ones.

## Development

```bash
python -m unittest discover -s tests -p "test_*.py" -v   # logic tests, no Home Assistant needed
node tests/card.test.js                                    # card helper tests
```

The integration code that talks to Home Assistant (`manager.py`, `__init__.py`, `sensor.py`) is kept thin; the decision logic lives in `logic.py` so it can be tested on its own.

## License

MIT
