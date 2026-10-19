"""Unit tests for the pure logic of Notify once (no Home Assistant needed)."""

from datetime import datetime, timedelta, timezone
import importlib.util
from pathlib import Path
import sys
import unittest

_PATH = Path(__file__).parent.parent / "custom_components" / "notify_once" / "logic.py"
_SPEC = importlib.util.spec_from_file_location("notify_once_logic", _PATH)
logic = importlib.util.module_from_spec(_SPEC)
sys.modules["notify_once_logic"] = logic  # needed by dataclasses
_SPEC.loader.exec_module(logic)

NOW = datetime(2026, 10, 18, 12, 0, tzinfo=timezone.utc)


class EvaluateTests(unittest.TestCase):
    def test_state_equals(self):
        self.assertTrue(logic.evaluate("state", "raining", "raining", None))
        self.assertFalse(logic.evaluate("state", "none", "raining", None))

    def test_unavailable_is_no_information(self):
        self.assertIsNone(logic.evaluate("state", "unavailable", "raining", None))
        self.assertIsNone(logic.evaluate("state", "unknown", "raining", None))
        self.assertIsNone(logic.evaluate("above", "unavailable", None, 10))
        self.assertIsNone(logic.evaluate("state", None, "raining", None))

    def test_unavailable_can_be_the_target(self):
        self.assertTrue(logic.evaluate("state", "unavailable", "unavailable", None))

    def test_numeric(self):
        self.assertTrue(logic.evaluate("above", "25.5", None, 25))
        self.assertFalse(logic.evaluate("above", "25", None, 25))
        self.assertTrue(logic.evaluate("below", "-1", None, 0))
        self.assertFalse(logic.evaluate("below", "0", None, 0))

    def test_non_numeric_state_for_numeric_condition(self):
        self.assertIsNone(logic.evaluate("above", "heating", None, 10))
        self.assertIsNone(logic.evaluate("above", "nan", None, 10))
        self.assertIsNone(logic.evaluate("above", "5", None, None))


class TransitionTests(unittest.TestCase):
    def test_fires_only_when_becoming_true(self):
        self.assertEqual(logic.transition(False, True), (True, True))
        self.assertEqual(logic.transition(True, True), (True, False))
        self.assertEqual(logic.transition(True, False), (False, False))
        self.assertEqual(logic.transition(False, False), (False, False))

    def test_no_information_changes_nothing(self):
        self.assertEqual(logic.transition(True, None), (True, False))
        self.assertEqual(logic.transition(False, None), (False, False))

    def test_already_true_at_start_waits_for_reentry(self):
        matched = bool(logic.evaluate("state", "raining", "raining", None))
        sequence = ["raining", "unavailable", "raining", "none", "raining"]
        fired = []
        for state in sequence:
            matched, fire = logic.transition(
                matched, logic.evaluate("state", state, "raining", None)
            )
            fired.append(fire)
        # only the re-entry after 'none' fires; the unavailable blip does not count
        self.assertEqual(fired, [False, False, False, False, True])


class NormalizeTests(unittest.TestCase):
    def test_notifier(self):
        self.assertEqual(logic.normalize_notifier("mobile_app_ip1337"), "notify.mobile_app_ip1337")
        self.assertEqual(logic.normalize_notifier(" Notify.Telegram "), "notify.telegram")
        for bad in ("notify.", "notify.a b", "script.turn_on", "notify.x; evil", ""):
            with self.assertRaises(ValueError, msg=bad):
                logic.normalize_notifier(bad)

    def test_state_value(self):
        self.assertEqual(logic.normalize_state_value(True), "on")
        self.assertEqual(logic.normalize_state_value(False), "off")
        self.assertEqual(logic.normalize_state_value(" raining "), "raining")
        self.assertEqual(logic.normalize_state_value(5), "5")

    def test_to_number(self):
        self.assertEqual(logic.to_number("3.5"), 3.5)
        self.assertIsNone(logic.to_number("abc"))
        self.assertIsNone(logic.to_number(None))
        self.assertIsNone(logic.to_number(True))
        self.assertIsNone(logic.to_number(float("inf")))


class WatchTests(unittest.TestCase):
    def make(self, **kwargs):
        defaults = dict(
            entity_id="sensor.rain",
            condition="state",
            notifier="notify.mobile_app_ip1337",
            hours=24,
            now=NOW,
            target_state="raining",
        )
        defaults.update(kwargs)
        return logic.create_watch(**defaults)

    def test_create(self):
        watch = self.make()
        self.assertEqual(len(watch.id), 12)
        self.assertEqual(watch.expires, NOW + timedelta(hours=24))
        self.assertFalse(watch.last_matched)
        self.assertIsNone(watch.message)

    def test_unique_ids(self):
        self.assertEqual(len({self.make().id for _ in range(200)}), 200)

    def test_storage_roundtrip(self):
        watch = self.make(
            condition="above", target_state=None, threshold=25.5,
            message="Hot", language="de", last_matched=True,
        )
        restored = logic.Watch.from_storage(watch.to_storage())
        self.assertEqual(restored, watch)

    def test_from_storage_rejects_bad_data(self):
        good = self.make().to_storage()
        for patch in ({"condition": "nope"}, {"notifier": "script.x"}, {"expires": "garbage"}):
            with self.assertRaises(ValueError):
                logic.Watch.from_storage({**good, **patch})
        with self.assertRaises(KeyError):
            logic.Watch.from_storage({"id": "x"})

    def test_naive_datetime_is_utc(self):
        parsed = logic.parse_datetime("2026-10-18T12:00:00")
        self.assertEqual(parsed.tzinfo, timezone.utc)

    def test_expiry(self):
        watch = self.make(hours=1)
        self.assertFalse(watch.is_expired(NOW + timedelta(minutes=59)))
        self.assertTrue(watch.is_expired(NOW + timedelta(hours=1)))

    def test_attributes_do_not_leak_internal_state(self):
        attrs = self.make().to_attributes()
        self.assertNotIn("last_matched", attrs)
        self.assertNotIn("language", attrs)
        self.assertEqual(attrs["entity_id"], "sensor.rain")


class MessageTests(unittest.TestCase):
    def test_custom_wins(self):
        self.assertEqual(logic.build_message("de", "Regen", "Regen", "", "Schirm mitnehmen"), "Schirm mitnehmen")

    def test_languages(self):
        self.assertEqual(logic.build_message("de", "Regen", "raining", ""), "Regen ist jetzt raining")
        self.assertEqual(logic.build_message("de-DE", "Regen", "x", ""), "Regen ist jetzt x")
        self.assertEqual(logic.build_message("en", "Rain", "raining", ""), "Rain is now raining")
        self.assertEqual(logic.build_message("fr", "Rain", "raining", ""), "Rain is now raining")

    def test_unit(self):
        self.assertEqual(logic.build_message("en", "Power", "2500", "W"), "Power is now 2500 W")


if __name__ == "__main__":
    unittest.main()
