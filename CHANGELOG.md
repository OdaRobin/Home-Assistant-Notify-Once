# Changelog

## 1.0.0

- First release as an integration. Replaces the script-based version.
- Watches live in the integration: they survive restarts, are listed in the
  `Active watches` sensor and can be cancelled one by one without an
  administrator account.
- The dashboard card ships with the integration and loads automatically.
- Services: `notify_once.watch`, `notify_once.cancel`, `notify_once.cancel_all`.
- Events: `notify_once_fired`, `notify_once_expired`, `notify_once_cancelled`.
