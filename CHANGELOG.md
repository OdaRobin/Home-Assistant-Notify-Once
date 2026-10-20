# Changelog

## 1.0.1

Security and robustness release.

- Messages are escaped before they reach notify services and persistent notifications. Notify services render messages as Jinja templates, so an entity state, entity name or custom message containing template syntax could have been evaluated. It is now sent as plain text.
- Custom messages are no longer exposed in the attributes of the active watches sensor.
- Input limits for state, message, language and id; thresholds and hours must be finite numbers (`nan` and `inf` used to slip through).
- The notifier check uses a full match.
- Unreadable stored watches are logged by id only.
- Manifest points to the real repository.

## 1.0.0

- First release as an integration. Replaces the script-based version.
- Watches live in the integration: they survive restarts, are listed in the
  `Active watches` sensor and can be cancelled one by one without an
  administrator account.
- The dashboard card ships with the integration and loads automatically.
- Services: `notify_once.watch`, `notify_once.cancel`, `notify_once.cancel_all`.
- Events: `notify_once_fired`, `notify_once_expired`, `notify_once_cancelled`.
