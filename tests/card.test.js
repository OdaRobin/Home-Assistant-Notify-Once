// Plain Node test for the pure helpers of the card: node tests/card.test.js
const assert = require("assert");
const path = require("path");
const m = require(path.join(__dirname, "..", "custom_components", "notify_once", "www", "notify-once-card.js"));

const so = (id, state, attributes = {}) => ({ entity_id: id, state, attributes });

// text sensor without options (rain sensor): states come from the history
const rain = so("sensor.regen_rainwater", "raining", { friendly_name: "Regen Rainwater" });
assert(!m.isNumericEntity(rain));
assert(m.needsObserved(rain));
assert.deepStrictEqual(m.stateValuesFor({}, rain), ["raining", "unavailable", "unknown"]);
const observed = m.observedFromHistory([{ s: "none" }, { s: "raining" }, { s: "none" }, { s: "unavailable" }, { state: "raining" }]);
assert.deepStrictEqual(observed, ["none", "raining"]);
assert.deepStrictEqual(m.stateValuesFor({}, rain, observed), ["raining", "none", "unavailable", "unknown"]);
assert.strictEqual(m.observedFromHistory(Array.from({ length: 40 }, (_, i) => ({ s: "v" + i }))), null);
assert.deepStrictEqual(m.observedFromHistory(null), []);

// known domains need no history
assert(!m.needsObserved(so("binary_sensor.x", "off")));
assert(!m.needsObserved(so("select.s", "a", { options: ["a", "b"] })));
assert(!m.needsObserved(so("person.p", "home")));
assert(!m.needsObserved(so("sensor.temp", "21", { unit_of_measurement: "°C" })));
assert(m.isNumericEntity(so("sensor.power", "unavailable", { unit_of_measurement: "W" })));
assert(m.isNumericEntity(so("input_number.x", "5")));
assert(!m.isNumericEntity(so("input_text.t", "123")));
assert(!m.isNumericEntity(so("sensor.ts", "2025-01-01T00:00:00+00:00")));

// state lists
assert.deepStrictEqual(m.stateValuesFor({}, so("binary_sensor.x", "off")), ["on", "off", "unavailable", "unknown"]);
assert.deepStrictEqual(m.stateValuesFor({}, so("climate.c", "heat", { hvac_modes: ["off", "heat"] })), ["off", "heat", "unavailable", "unknown"]);
const zones = { "zone.work": so("zone.work", "0", { friendly_name: "Arbeit" }), "zone.home": so("zone.home", "1") };
assert.deepStrictEqual(m.stateValuesFor(zones, so("person.p", "home")), ["home", "not_home", "Arbeit", "unavailable", "unknown"]);

// labels
const hass = { formatEntityState: (s, v) => ({ on: "Ein", off: "Aus" })[v ?? s.state] };
assert.strictEqual(m.labelFor(hass, so("binary_sensor.x", "off"), "on"), "Ein (on)");
assert.strictEqual(m.labelFor({}, so("x.y", "a"), "a"), "a");
assert.strictEqual(m.labelFor({ formatEntityState() { throw new Error("x"); } }, so("x.y", "a"), "a"), "a");

// notifiers
const S = m.STRINGS.de;
const h2 = { services: { notify: { send_message: {}, mobile_app_ip1337: {}, persistent_notification: {}, robin_telegram: {} } } };
const list = m.notifierList(h2, {}, S);
assert(!list.some((n) => n.value === "notify.send_message"));
assert.strictEqual(list.find((n) => n.value === "notify.mobile_app_ip1337").label, "Handy: ip1337");
assert.deepStrictEqual(
  m.notifierList(h2, { notifiers: ["mobile_app_ip1337", { service: "notify.robin_telegram", name: "TG" }] }, S),
  [{ value: "notify.mobile_app_ip1337", label: "mobile_app_ip1337" }, { value: "notify.robin_telegram", label: "TG" }]
);

// sensor lookup
assert.strictEqual(m.findSensorId({}, { sensor: "sensor.custom" }), "sensor.custom");
assert.strictEqual(m.findSensorId({ entities: { "sensor.my_renamed": { platform: "notify_once" }, "sensor.other": { platform: "x" } } }, {}), "sensor.my_renamed");
assert.strictEqual(m.findSensorId({ entities: {} }, {}), "sensor.notify_once_active_watches");
assert.strictEqual(m.findSensorId(undefined, {}), "sensor.notify_once_active_watches");

// watches from the sensor attribute
const w1 = { id: "a1", entity_id: "sensor.regen_rainwater", condition: "state", target_state: "raining", threshold: null, notifier: "notify.mobile_app_ip1337", expires: "2026-10-19T19:45:00+00:00" };
const w2 = { id: "b2", entity_id: "sensor.power", condition: "above", target_state: null, threshold: 100000, notifier: "notify.persistent_notification", expires: "2026-10-19T19:45:00+00:00" };
assert.deepStrictEqual(m.watchesFromState(so("sensor.notify_once_active_watches", "2", { watches: [w1, w2, null, { id: "broken" }] })), [w1, w2]);
assert.deepStrictEqual(m.watchesFromState(undefined), []);
assert.deepStrictEqual(m.watchesFromState(so("sensor.x", "0", {})), []);

// condition text
const h3 = { states: { "sensor.regen_rainwater": rain, "sensor.power": so("sensor.power", "2500", { unit_of_measurement: "W" }) } };
assert.strictEqual(m.describeCondition(h3, w1, S), "= raining");
assert.strictEqual(m.describeCondition(h3, w2, S), "> 100000 W");
assert.strictEqual(m.describeCondition(h3, { entity_id: "sensor.gone", condition: "below", threshold: 3 }, S), "< 3");

console.log("card tests passed");
