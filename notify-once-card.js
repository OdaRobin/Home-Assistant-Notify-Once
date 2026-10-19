/*! notify-once-card v1.1.0
 *
 * Dashboard card: pick an entity, pick a state or threshold, pick a notification
 * target, start the watch. The card starts script.notify_once, which waits once
 * and then sends exactly one notification.
 *
 * Card configuration (everything optional):
 *   type: custom:notify-once-card
 *   title: Notify once
 *   script: script.notify_once
 *   default_notifier: notify.mobile_app_my_phone
 *   default_hours: 24
 *   notifiers:                      # empty = all notify services automatically
 *     - service: notify.mobile_app_my_phone
 *       name: My phone
 *
 * Listing and cancelling single watches reads the script traces and needs an
 * administrator account. Without admin rights the card still starts watches and
 * shows how many are active.
 */

const CARD_TAG = "notify-once-card";
const LEGACY_TAG = "einmalige-benachrichtigung-card";
const CARD_VERSION = "1.1.0";
const CUSTOM = "__custom__";
const EXTRA_STATES = ["unavailable", "unknown"];
const STORAGE_KEY = "notify-once-card:notifier";
const CANCEL_EVENT = "notify_once_cancel";
const HISTORY_DAYS = 30;
const MAX_OBSERVED = 30;

const STRINGS = {
  de: {
    title: "Notify once",
    entity: "Entität",
    entity_ph: "Entität wählen …",
    condition: "Bedingung",
    c_state: "Zustand ist gleich",
    c_above: "Wert wird größer als",
    c_below: "Wert wird kleiner als",
    state: "Zustand",
    threshold: "Schwellwert",
    custom: "Eigener Wert …",
    custom_ph: "Zustand eingeben",
    seen_hint: "Enthält Zustände, die in den letzten 30 Tagen aufgetreten sind.",
    current: "Aktuell",
    notifier: "Benachrichtigen über",
    message: "Eigene Nachricht (optional)",
    message_ph: "Leer lassen für automatischen Text",
    hours: "Max. Wartezeit (h)",
    start: "Überwachung starten",
    started: "Überwachung gestartet",
    active: "Aktive Überwachungen",
    none_active: "Keine aktiven Überwachungen",
    cancel_all: "Alle abbrechen",
    cancel_all_confirm: "Alle laufenden Überwachungen abbrechen?",
    cancel_one: "Überwachung abbrechen",
    cancelled: "Überwachung abgebrochen",
    cancelled_all: "Alle Überwachungen abgebrochen",
    until: "bis",
    list_unavailable: "Die Liste der Überwachungen braucht ein Administrator-Konto.",
    missing_script: "Script nicht gefunden",
    pick_entity: "Bitte eine Entität wählen.",
    pick_state: "Bitte einen Zustand wählen.",
    pick_value: "Bitte einen Schwellwert eingeben.",
    pick_notifier: "Bitte ein Ziel für die Benachrichtigung wählen.",
    failed: "Fehlgeschlagen",
    ha_notifications: "Home Assistant (Benachrichtigungen)",
    phone: "Handy",
  },
  en: {
    title: "Notify once",
    entity: "Entity",
    entity_ph: "Choose an entity …",
    condition: "Condition",
    c_state: "State equals",
    c_above: "Value rises above",
    c_below: "Value falls below",
    state: "State",
    threshold: "Threshold",
    custom: "Custom value …",
    custom_ph: "Enter a state",
    seen_hint: "Includes states seen in the last 30 days.",
    current: "Current",
    notifier: "Notify via",
    message: "Custom message (optional)",
    message_ph: "Leave empty for an automatic text",
    hours: "Max. wait (h)",
    start: "Start watching",
    started: "Watch started",
    active: "Active watches",
    none_active: "No active watches",
    cancel_all: "Cancel all",
    cancel_all_confirm: "Cancel all running watches?",
    cancel_one: "Cancel watch",
    cancelled: "Watch cancelled",
    cancelled_all: "All watches cancelled",
    until: "until",
    list_unavailable: "Listing watches needs an administrator account.",
    missing_script: "Script not found",
    pick_entity: "Please choose an entity.",
    pick_state: "Please choose a state.",
    pick_value: "Please enter a threshold.",
    pick_notifier: "Please choose where to send the notification.",
    failed: "Failed",
    ha_notifications: "Home Assistant (notifications)",
    phone: "Phone",
  },
};

const ON_OFF = ["on", "off"];
const DOMAIN_STATES = {
  binary_sensor: ON_OFF,
  switch: ON_OFF,
  light: ON_OFF,
  fan: ON_OFF,
  input_boolean: ON_OFF,
  siren: ON_OFF,
  remote: ON_OFF,
  humidifier: ON_OFF,
  automation: ON_OFF,
  script: ON_OFF,
  update: ON_OFF,
  calendar: ON_OFF,
  schedule: ON_OFF,
  lock: ["locked", "unlocked", "locking", "unlocking", "jammed", "open", "opening"],
  cover: ["open", "closed", "opening", "closing"],
  valve: ["open", "closed", "opening", "closing"],
  alarm_control_panel: [
    "disarmed", "armed_home", "armed_away", "armed_night", "armed_vacation",
    "armed_custom_bypass", "pending", "arming", "disarming", "triggered",
  ],
  media_player: ["playing", "paused", "idle", "buffering", "standby", "on", "off"],
  vacuum: ["cleaning", "docked", "idle", "paused", "returning", "error"],
  lawn_mower: ["mowing", "docked", "paused", "returning", "error"],
  sun: ["above_horizon", "below_horizon"],
  timer: ["idle", "active", "paused"],
  camera: ["idle", "recording", "streaming"],
  weather: [
    "clear-night", "cloudy", "exceptional", "fog", "hail", "lightning",
    "lightning-rainy", "partlycloudy", "pouring", "rainy", "snowy",
    "snowy-rainy", "sunny", "windy", "windy-variant",
  ],
};

function domainOf(entityId) {
  return String(entityId).split(".")[0];
}

/** True when the entity's possible states are known without looking at the history. */
function hasKnownStates(stateObj) {
  const a = stateObj.attributes || {};
  const d = domainOf(stateObj.entity_id);
  if (Array.isArray(a.options) && a.options.length) return true;
  if (d === "climate" && Array.isArray(a.hvac_modes)) return true;
  if (d === "water_heater" && Array.isArray(a.operation_list)) return true;
  if (d === "person" || d === "device_tracker") return true;
  return d in DOMAIN_STATES;
}

/** Numeric entity (threshold makes sense) or state entity (dropdown)? */
function isNumericEntity(stateObj) {
  const a = stateObj.attributes || {};
  const d = domainOf(stateObj.entity_id);
  if (hasKnownStates(stateObj)) return false;
  if (["climate", "water_heater", "input_text", "text"].includes(d)) return false;
  if (["input_number", "number", "counter"].includes(d)) return true;
  if (a.unit_of_measurement || a.state_class) return true;
  const s = stateObj.state;
  return s !== "" && s != null && !EXTRA_STATES.includes(s) && Number.isFinite(Number(s));
}

/** Entities whose states can only be learned from the recorder history. */
function needsObserved(stateObj) {
  return !isNumericEntity(stateObj) && !hasKnownStates(stateObj);
}

/** Raw state values that can be chosen for the entity. */
function stateValuesFor(states, stateObj, observed) {
  const a = stateObj.attributes || {};
  const d = domainOf(stateObj.entity_id);
  let base = [];
  if (Array.isArray(a.options) && a.options.length) {
    base = a.options.map(String);
  } else if (d === "climate" && Array.isArray(a.hvac_modes)) {
    base = a.hvac_modes.map(String);
  } else if (d === "water_heater" && Array.isArray(a.operation_list)) {
    base = a.operation_list.map(String);
  } else if (d === "person" || d === "device_tracker") {
    base = ["home", "not_home"];
    for (const [id, z] of Object.entries(states || {})) {
      if (id.startsWith("zone.") && id !== "zone.home") {
        base.push((z.attributes && z.attributes.friendly_name) || id.slice(5));
      }
    }
  } else if (DOMAIN_STATES[d]) {
    base = DOMAIN_STATES[d].slice();
  }
  const cur = stateObj.state;
  if (cur && !EXTRA_STATES.includes(cur) && !base.includes(cur)) base.push(cur);
  for (const o of observed || []) {
    if (!EXTRA_STATES.includes(o) && !base.includes(o)) base.push(o);
  }
  for (const e of EXTRA_STATES) if (!base.includes(e)) base.push(e);
  return base;
}

/** Distinct states from a recorder history response; null when there are too many. */
function observedFromHistory(rows) {
  const set = new Set();
  for (const r of rows || []) {
    const s = r && (r.s !== undefined ? r.s : r.state);
    if (typeof s === "string" && s !== "" && !EXTRA_STATES.includes(s)) set.add(s);
  }
  if (set.size > MAX_OBSERVED) return null;
  return Array.from(set).sort((x, y) => x.localeCompare(y));
}

/** Display name of a state: translated, with the raw value in brackets. */
function labelFor(hass, stateObj, value) {
  let label = value;
  try {
    if (hass && typeof hass.formatEntityState === "function") {
      const t = hass.formatEntityState(stateObj, value);
      if (t) label = String(t);
    }
  } catch (e) {
    /* use the raw value */
  }
  return label.toLowerCase() === String(value).toLowerCase() ? label : `${label} (${value})`;
}

function normNotify(s) {
  if (!s) return "";
  return String(s).startsWith("notify.") ? String(s) : `notify.${s}`;
}

function prettyNotifier(key, S) {
  if (key === "persistent_notification") return S.ha_notifications;
  if (key.startsWith("mobile_app_")) return `${S.phone}: ${key.slice(11).replace(/_/g, " ")}`;
  return key.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

function notifierList(hass, config, S) {
  if (Array.isArray(config.notifiers) && config.notifiers.length) {
    return config.notifiers.map((n) =>
      typeof n === "string"
        ? { value: normNotify(n), label: n }
        : { value: normNotify(n.service), label: n.name || n.service }
    );
  }
  const svc = (hass && hass.services && hass.services.notify) || {};
  return Object.keys(svc)
    .filter((k) => k !== "send_message")
    .sort()
    .map((k) => ({ value: `notify.${k}`, label: prettyNotifier(k, S) }));
}

/** Turns a trace/get response of one running script run into a watch description. */
function parseWatch(trace, summary) {
  const vars = {};
  for (const elements of Object.values((trace && trace.trace) || {})) {
    for (const el of elements) {
      if (el && el.changed_variables) Object.assign(vars, el.changed_variables);
    }
  }
  if (!vars.watch_entity) return null;
  const ts = (summary && summary.timestamp) || (trace && trace.timestamp) || {};
  const runId = (trace && trace.context && trace.context.id) || vars.run_id;
  if (!runId) return null;
  return {
    runId,
    start: ts.start,
    entity: vars.watch_entity,
    cond: vars.condition_type || "state",
    target: vars.target_state,
    threshold: vars.threshold,
    notifier: vars.notifier,
    hours: Number(vars.max_hours) || 24,
  };
}

function describeCondition(hass, w, S) {
  const so = hass && hass.states ? hass.states[w.entity] : null;
  if (w.cond === "state") {
    return `= ${so ? labelFor(hass, so, String(w.target)) : w.target}`;
  }
  const unit = so && so.attributes ? so.attributes.unit_of_measurement : "";
  const op = w.cond === "above" ? ">" : "<";
  return `${op} ${w.threshold}${unit ? ` ${unit}` : ""}`;
}

function withTimeout(promise, ms) {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error("timeout")), ms)),
  ]);
}

const CSS = `
  :host { display: block; }
  [hidden] { display: none !important; }
  ha-card { padding: 16px 16px 12px; }
  .title { margin: 0 0 12px; font-size: var(--ha-card-header-font-size, 20px); font-weight: 500; line-height: 1.2; }
  .field { margin-bottom: 12px; min-width: 0; }
  label { display: block; margin: 0 0 4px; font-size: 12px; color: var(--secondary-text-color); }
  select, input {
    display: block; width: 100%; box-sizing: border-box; min-height: 44px; padding: 8px 12px;
    border: 1px solid var(--divider-color); border-radius: 8px;
    background: var(--card-background-color); color: var(--primary-text-color); font: inherit;
  }
  .stack > * + * { margin-top: 8px; }
  select:focus-visible, input:focus-visible, button:focus-visible { outline: 2px solid var(--primary-color); outline-offset: 1px; }
  ha-entity-picker { display: block; }
  .hint { margin-top: 4px; font-size: 12px; color: var(--secondary-text-color); }
  .row { display: flex; gap: 12px; }
  .row .grow { flex: 1 1 auto; min-width: 0; }
  .row .narrow { flex: 0 0 7.5em; }
  button { font: inherit; cursor: pointer; }
  .primary {
    width: 100%; min-height: 44px; border: 0; border-radius: 8px;
    background: var(--primary-color); color: var(--text-primary-color, #fff); font-weight: 500;
  }
  .primary:disabled { opacity: 0.6; cursor: default; }
  .watches { margin-top: 16px; padding-top: 12px; border-top: 1px solid var(--divider-color); }
  .w-head { display: flex; align-items: center; justify-content: space-between; font-size: 14px; font-weight: 500; }
  .link { border: 0; background: none; padding: 6px 4px; color: var(--primary-color); font-size: 13px; font-weight: 400; }
  .link:disabled { color: var(--disabled-text-color); cursor: default; }
  .watch { display: flex; align-items: center; gap: 8px; padding: 8px 0; border-bottom: 1px solid var(--divider-color); }
  .watch:last-child { border-bottom: 0; }
  .w-main { flex: 1 1 auto; min-width: 0; }
  .w-title { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .w-sub { font-size: 12px; color: var(--secondary-text-color); overflow-wrap: anywhere; }
  .w-x {
    flex: 0 0 auto; width: 36px; height: 36px; border: 0; border-radius: 50%;
    background: none; color: var(--secondary-text-color); font-size: 16px; line-height: 1;
  }
  .w-x:hover { background: var(--secondary-background-color); color: var(--error-color, #db4437); }
  .empty { padding: 8px 0; font-size: 13px; color: var(--secondary-text-color); }
  .warn { margin-bottom: 12px; padding: 8px 12px; border-radius: 8px; background: var(--error-color, #db4437); color: #fff; font-size: 13px; }
`;

if (typeof customElements !== "undefined") {
  class NotifyOnceCard extends HTMLElement {
    constructor() {
      super();
      this.attachShadow({ mode: "open" });
      this._hass = null;
      this._config = null;
      this._built = false;
      this._entity = "";
      this._numeric = false;
      this._notifSig = "";
      this._notifLabels = new Map();
      this._picker = null;
      this._pickerMounted = false;
      this._lastPickerUpdate = 0;
      this._observed = new Map();
      this._watches = [];
      this._watchCache = new Map();
      this._watchSig = null;
      this._watchBusy = false;
      this._watchAgain = false;
      this._watchError = false;
    }

    static getStubConfig() {
      return {};
    }

    setConfig(config) {
      this._config = {
        script: "script.notify_once",
        default_hours: 24,
        ...config,
      };
      if (this._hass) {
        this._built = false;
        this._pickerMounted = false;
        this._picker = null;
        this._notifSig = "";
        this._watchSig = null;
        this._build();
        this._onHass();
      }
    }

    set hass(hass) {
      this._hass = hass;
      if (!this._config) return;
      if (!this._built) this._build();
      this._onHass();
    }

    getCardSize() {
      return 8;
    }

    getGridOptions() {
      return { columns: 12, rows: "auto", min_columns: 6 };
    }

    _q(sel) {
      return this.shadowRoot.querySelector(sel);
    }

    _lang() {
      const l = String((this._hass && this._hass.language) || "en").toLowerCase();
      return l.startsWith("de") ? "de" : "en";
    }

    _build() {
      const S = (this._S = STRINGS[this._lang()]);
      this.shadowRoot.innerHTML = `
        <style>${CSS}</style>
        <ha-card>
          <h2 class="title" id="title"></h2>
          <div class="warn" id="missing" hidden></div>
          <div class="field">
            <label>${S.entity}</label>
            <div id="picker"></div>
            <div class="hint" id="current" hidden></div>
          </div>
          <div class="field" id="f-cond" hidden>
            <label for="cond">${S.condition}</label>
            <select id="cond"></select>
          </div>
          <div class="field" id="f-value" hidden>
            <label for="state-sel" id="value-label">${S.state}</label>
            <div class="stack">
              <select id="state-sel"></select>
              <input id="state-custom" type="text" autocomplete="off" />
              <input id="num" type="number" step="any" inputmode="decimal" />
            </div>
            <div class="hint" id="state-hint" hidden>${S.seen_hint}</div>
          </div>
          <div class="field">
            <label for="notifier">${S.notifier}</label>
            <select id="notifier"></select>
          </div>
          <div class="row">
            <div class="field grow">
              <label for="msg">${S.message}</label>
              <input id="msg" type="text" autocomplete="off" placeholder="${S.message_ph}" />
            </div>
            <div class="field narrow">
              <label for="hours">${S.hours}</label>
              <input id="hours" type="number" min="1" max="720" step="1" inputmode="numeric" />
            </div>
          </div>
          <button class="primary" id="start" type="button">${S.start}</button>
          <div class="watches">
            <div class="w-head">
              <span>${S.active}: <span id="active-n">0</span></span>
              <button class="link" id="cancel" type="button">${S.cancel_all}</button>
            </div>
            <div id="w-list"></div>
            <div class="hint" id="w-hint" hidden></div>
          </div>
        </ha-card>`;

      this._q("#title").textContent = this._config.title || S.title;
      this._q("#hours").value = String(this._config.default_hours);

      this._q("#cond").addEventListener("change", () => this._updateValueUI());
      this._q("#state-sel").addEventListener("change", () => this._updateValueUI());
      this._q("#notifier").addEventListener("change", (ev) => {
        try {
          localStorage.setItem(STORAGE_KEY, ev.target.value);
        } catch (e) {
          /* continue without storage */
        }
      });
      this._q("#start").addEventListener("click", () => this._start());
      this._q("#cancel").addEventListener("click", () => this._cancelAll());

      this._built = true;
      this._entity = "";
      this._renderWatches();
    }

    _onHass() {
      const h = this._hass;
      const S = this._S;

      const list = notifierList(h, this._config, S);
      const sig = list.map((n) => n.value).join("|");
      if (sig !== this._notifSig) {
        this._fillNotifiers(list);
        this._notifSig = sig;
      }

      const scriptState = h.states[this._config.script];
      const missing = this._q("#missing");
      missing.hidden = !!scriptState;
      if (!scriptState) missing.textContent = `${S.missing_script}: ${this._config.script}`;
      const current = scriptState ? Number(scriptState.attributes.current || 0) : 0;
      this._q("#active-n").textContent = String(current);
      this._q("#cancel").hidden = current === 0;

      const watchSig = `${current}|${scriptState ? scriptState.attributes.last_triggered : ""}`;
      if (watchSig !== this._watchSig) {
        this._watchSig = watchSig;
        this._refreshWatches();
      }

      if (!this._pickerMounted) {
        this._pickerMounted = true;
        this._mountPicker();
      } else if (this._picker && Date.now() - this._lastPickerUpdate > 30000) {
        this._picker.hass = h;
        this._lastPickerUpdate = Date.now();
      }

      this._updateCurrent();
    }

    _fillNotifiers(list) {
      const sel = this._q("#notifier");
      let preferred = sel.value;
      if (!preferred) {
        try {
          preferred = localStorage.getItem(STORAGE_KEY) || "";
        } catch (e) {
          preferred = "";
        }
      }
      const values = list.map((n) => n.value);
      if (!values.includes(preferred)) preferred = normNotify(this._config.default_notifier);
      if (!values.includes(preferred)) {
        const phone = values.find((v) => v.startsWith("notify.mobile_app_"));
        preferred = phone || values[0] || "";
      }
      sel.innerHTML = "";
      this._notifLabels = new Map();
      for (const n of list) {
        const o = document.createElement("option");
        o.value = n.value;
        o.textContent = n.label;
        sel.appendChild(o);
        this._notifLabels.set(n.value, n.label);
      }
      sel.value = preferred;
      this._renderWatches();
    }

    /* ---------- entity picker ---------- */

    async _mountPicker() {
      const S = this._S;
      const host = this._q("#picker");
      let mounted = false;
      try {
        if (!customElements.get("ha-entity-picker")) {
          const helpers = await (window.loadCardHelpers && window.loadCardHelpers());
          if (helpers) {
            const c = await helpers.createCardElement({ type: "entities", entities: [] });
            if (c && c.constructor && c.constructor.getConfigElement) await c.constructor.getConfigElement();
          }
          await Promise.race([
            customElements.whenDefined("ha-entity-picker"),
            new Promise((r) => setTimeout(r, 3000)),
          ]);
        }
        if (customElements.get("ha-entity-picker")) {
          const p = document.createElement("ha-entity-picker");
          p.hass = this._hass;
          p.label = S.entity_ph;
          p.value = "";
          p.addEventListener("value-changed", (ev) => {
            ev.stopPropagation();
            this._setEntity((ev.detail && ev.detail.value) || "");
          });
          host.appendChild(p);
          this._picker = p;
          this._lastPickerUpdate = Date.now();
          mounted = true;
        }
      } catch (e) {
        mounted = false;
      }
      if (!mounted) this._mountFallbackPicker(host);
    }

    _mountFallbackPicker(host) {
      const S = this._S;
      const input = document.createElement("input");
      input.type = "text";
      input.setAttribute("list", "nob-entities");
      input.placeholder = S.entity_ph;
      input.autocomplete = "off";
      const dl = document.createElement("datalist");
      dl.id = "nob-entities";
      for (const id of Object.keys(this._hass.states).sort()) {
        const o = document.createElement("option");
        o.value = id;
        o.label = (this._hass.states[id].attributes || {}).friendly_name || id;
        dl.appendChild(o);
      }
      input.addEventListener("change", () => {
        const v = input.value.trim();
        this._setEntity(this._hass.states[v] ? v : "");
      });
      host.appendChild(input);
      host.appendChild(dl);
    }

    /* ---------- entity dependent form ---------- */

    _setEntity(entityId) {
      this._entity = entityId && this._hass.states[entityId] ? entityId : "";
      this._refreshEntityDependent();
      this._updateCurrent();
      const so = this._entity ? this._hass.states[this._entity] : null;
      if (so && needsObserved(so)) this._loadObserved(this._entity);
    }

    _fillStateOptions(so, observed) {
      const S = this._S;
      const h = this._hass;
      const stateSel = this._q("#state-sel");
      const previous = stateSel.value;
      stateSel.innerHTML = "";
      for (const v of stateValuesFor(h.states, so, observed)) {
        const o = document.createElement("option");
        o.value = v;
        o.textContent = labelFor(h, so, v);
        stateSel.appendChild(o);
      }
      const custom = document.createElement("option");
      custom.value = CUSTOM;
      custom.textContent = S.custom;
      stateSel.appendChild(custom);
      const values = Array.from(stateSel.options).map((o) => o.value);
      if (previous && values.includes(previous)) stateSel.value = previous;
      else stateSel.selectedIndex = 0;
    }

    async _loadObserved(entityId) {
      let observed = this._observed.get(entityId);
      if (observed === undefined) {
        try {
          const end = new Date();
          const start = new Date(end.getTime() - HISTORY_DAYS * 86400000);
          const res = await withTimeout(
            this._hass.callWS({
              type: "history/history_during_period",
              start_time: start.toISOString(),
              end_time: end.toISOString(),
              entity_ids: [entityId],
              include_start_time_state: true,
              significant_changes_only: false,
              minimal_response: true,
              no_attributes: true,
            }),
            10000
          );
          observed = observedFromHistory(res && res[entityId]);
        } catch (e) {
          observed = null;
        }
        this._observed.set(entityId, observed);
      }
      if (!observed || this._entity !== entityId) return;
      const so = this._hass.states[entityId];
      if (!so) return;
      this._fillStateOptions(so, observed);
      this._q("#state-hint").hidden = false;
      this._updateValueUI();
    }

    _refreshEntityDependent() {
      const S = this._S;
      const h = this._hass;
      const so = this._entity ? h.states[this._entity] : null;
      const condSel = this._q("#cond");
      this._q("#state-custom").value = "";
      this._q("#num").value = "";
      this._q("#state-hint").hidden = true;
      if (!so) {
        this._q("#f-cond").hidden = true;
        this._q("#f-value").hidden = true;
        return;
      }
      this._numeric = isNumericEntity(so);

      condSel.innerHTML = "";
      const conds = this._numeric
        ? [["above", S.c_above], ["below", S.c_below], ["state", S.c_state]]
        : [["state", S.c_state]];
      for (const [value, label] of conds) {
        const o = document.createElement("option");
        o.value = value;
        o.textContent = label;
        condSel.appendChild(o);
      }
      condSel.value = conds[0][0];
      this._q("#f-cond").hidden = !this._numeric;

      const cached = this._observed.get(this._entity);
      this._fillStateOptions(so, cached || []);
      if (cached) this._q("#state-hint").hidden = false;

      this._updateValueUI();
    }

    _updateValueUI() {
      const S = this._S;
      const so = this._entity ? this._hass.states[this._entity] : null;
      this._q("#f-value").hidden = !so;
      if (!so) return;
      const cond = this._q("#cond").value;
      const sel = this._q("#state-sel");
      const cust = this._q("#state-custom");
      const num = this._q("#num");
      const label = this._q("#value-label");
      if (cond === "state") {
        label.textContent = S.state;
        num.hidden = true;
        if (this._numeric) {
          sel.hidden = true;
          cust.hidden = false;
          cust.placeholder = so.state;
        } else {
          sel.hidden = false;
          cust.hidden = sel.value !== CUSTOM;
          cust.placeholder = S.custom_ph;
        }
      } else {
        const unit = (so.attributes || {}).unit_of_measurement;
        label.textContent = unit ? `${S.threshold} (${unit})` : S.threshold;
        sel.hidden = true;
        cust.hidden = true;
        num.hidden = false;
        num.placeholder = so.state;
      }
    }

    _updateCurrent() {
      const S = this._S;
      const el = this._q("#current");
      const so = this._entity ? this._hass.states[this._entity] : null;
      if (!so) {
        el.hidden = true;
        return;
      }
      let text = so.state;
      try {
        if (typeof this._hass.formatEntityState === "function") text = this._hass.formatEntityState(so);
      } catch (e) {
        text = so.state;
      }
      el.textContent = `${S.current}: ${text}`;
      el.hidden = false;
    }

    _toast(message) {
      this.dispatchEvent(
        new CustomEvent("hass-notification", { detail: { message }, bubbles: true, composed: true })
      );
    }

    /* ---------- start / cancel ---------- */

    async _start() {
      const S = this._S;
      const so = this._entity ? this._hass.states[this._entity] : null;
      if (!so) return this._toast(S.pick_entity);

      const notifier = this._q("#notifier").value;
      if (!notifier) return this._toast(S.pick_notifier);

      const cond = this._q("#cond").value;
      const data = {
        watch_entity: this._entity,
        condition_type: cond,
        notifier,
        language: this._lang(),
        max_hours: Math.min(720, Math.max(1, Number(this._q("#hours").value) || this._config.default_hours)),
      };

      if (cond === "state") {
        const sel = this._q("#state-sel");
        const value =
          this._numeric || sel.value === CUSTOM ? this._q("#state-custom").value.trim() : sel.value;
        if (!value) return this._toast(S.pick_state);
        data.target_state = value;
      } else {
        const raw = this._q("#num").value.trim();
        if (raw === "" || !Number.isFinite(Number(raw))) return this._toast(S.pick_value);
        data.threshold = Number(raw);
      }

      const msg = this._q("#msg").value.trim();
      if (msg) data.message = msg;

      const btn = this._q("#start");
      btn.disabled = true;
      try {
        // script.turn_on returns at once; calling script.<id> directly would wait for the end of the watch
        await this._hass.callService("script", "turn_on", {
          entity_id: this._config.script,
          variables: data,
        });
        btn.textContent = S.started;
        this._toast(S.started);
      } catch (e) {
        this._toast(`${S.failed}: ${(e && e.message) || e}`);
      }
      setTimeout(() => {
        btn.textContent = S.start;
        btn.disabled = false;
      }, 1800);
    }

    async _cancelOne(runId) {
      const S = this._S;
      try {
        await this._hass.callWS({
          type: "fire_event",
          event_type: CANCEL_EVENT,
          event_data: { id: runId },
        });
        this._watches = this._watches.filter((w) => w.runId !== runId);
        this._renderWatches();
        this._toast(S.cancelled);
      } catch (e) {
        this._toast(`${S.failed}: ${(e && e.message) || e}`);
      }
    }

    async _cancelAll() {
      const S = this._S;
      if (!window.confirm(S.cancel_all_confirm)) return;
      try {
        await this._hass.callService("script", "turn_off", { entity_id: this._config.script });
        this._toast(S.cancelled_all);
      } catch (e) {
        this._toast(`${S.failed}: ${(e && e.message) || e}`);
      }
    }

    /* ---------- list of active watches ---------- */

    async _refreshWatches() {
      if (this._watchBusy) {
        this._watchAgain = true;
        return;
      }
      this._watchBusy = true;
      try {
        const sState = this._hass.states[this._config.script];
        const current = sState ? Number(sState.attributes.current || 0) : 0;
        if (!current) {
          this._watches = [];
          this._watchError = false;
        } else {
          const itemId = String(this._config.script).split(".")[1];
          const list = await this._hass.callWS({ type: "trace/list", domain: "script", item_id: itemId });
          const running = list
            .filter((t) => t.state === "running")
            .sort((a, b) => String(b.timestamp.start).localeCompare(String(a.timestamp.start)))
            .slice(0, current);
          const out = [];
          for (const t of running) {
            let w = this._watchCache.get(t.run_id);
            if (!w) {
              const tr = await this._hass.callWS({
                type: "trace/get",
                domain: "script",
                item_id: itemId,
                run_id: t.run_id,
              });
              w = parseWatch(tr, t);
              if (w) this._watchCache.set(t.run_id, w);
            }
            if (w) out.push(w);
          }
          this._watches = out;
          this._watchError = false;
        }
      } catch (e) {
        this._watches = [];
        this._watchError = true;
      } finally {
        this._watchBusy = false;
        this._renderWatches();
        if (this._watchAgain) {
          this._watchAgain = false;
          this._refreshWatches();
        }
      }
    }

    _renderWatches() {
      if (!this._built) return;
      const S = this._S;
      const h = this._hass;
      const list = this._q("#w-list");
      const hint = this._q("#w-hint");
      list.textContent = "";

      const sState = h ? h.states[this._config.script] : null;
      const current = sState ? Number(sState.attributes.current || 0) : 0;

      if (!this._watches.length) {
        if (current === 0) {
          const empty = document.createElement("div");
          empty.className = "empty";
          empty.textContent = S.none_active;
          list.appendChild(empty);
        }
        hint.hidden = !(this._watchError && current > 0);
        hint.textContent = S.list_unavailable;
        return;
      }
      hint.hidden = true;

      for (const w of this._watches) {
        const so = h.states[w.entity];
        const name = (so && so.attributes && so.attributes.friendly_name) || w.entity;
        const end = new Date(new Date(w.start).getTime() + w.hours * 3600000);
        const endText = end.toLocaleString((h && h.language) || undefined, {
          day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit",
        });
        const via = this._notifLabels.get(w.notifier) || (w.notifier ? prettyNotifier(String(w.notifier).replace(/^notify\./, ""), S) : "");

        const row = document.createElement("div");
        row.className = "watch";
        const main = document.createElement("div");
        main.className = "w-main";
        const title = document.createElement("div");
        title.className = "w-title";
        title.textContent = name;
        const sub = document.createElement("div");
        sub.className = "w-sub";
        sub.textContent = [describeCondition(h, w, S), via, `${S.until} ${endText}`].filter(Boolean).join(" · ");
        main.append(title, sub);
        const x = document.createElement("button");
        x.className = "w-x";
        x.type = "button";
        x.textContent = "✕";
        x.title = S.cancel_one;
        x.setAttribute("aria-label", `${S.cancel_one}: ${name}`);
        x.addEventListener("click", () => this._cancelOne(w.runId));
        row.append(main, x);
        list.appendChild(row);
      }
    }
  }

  // Old card name (v1.0): keeps existing dashboards working until the card type is renamed
  class LegacyNotifyOnceCard extends NotifyOnceCard {}

  if (!customElements.get(CARD_TAG)) customElements.define(CARD_TAG, NotifyOnceCard);
  if (!customElements.get(LEGACY_TAG)) customElements.define(LEGACY_TAG, LegacyNotifyOnceCard);
  window.customCards = window.customCards || [];
  window.customCards.push({
    type: CARD_TAG,
    name: "Notify once",
    description: "Get notified exactly once when an entity reaches a state or threshold.",
  });
  console.info(`%c NOTIFY-ONCE-CARD %c v${CARD_VERSION} `, "background:#03a9f4;color:#fff", "");
} else if (typeof module !== "undefined") {
  module.exports = {
    isNumericEntity, hasKnownStates, needsObserved, stateValuesFor, observedFromHistory,
    labelFor, notifierList, prettyNotifier, normNotify, parseWatch, describeCondition, STRINGS,
  };
}
