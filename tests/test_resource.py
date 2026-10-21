"""Tests for the Lovelace resource registration (no Home Assistant needed)."""

import importlib.util
from pathlib import Path
import sys
import types
import unittest

_PATH = Path(__file__).parent.parent / "custom_components" / "notify_once" / "resource.py"
_SPEC = importlib.util.spec_from_file_location("notify_once_resource", _PATH)
resource = importlib.util.module_from_spec(_SPEC)
sys.modules["notify_once_resource"] = resource
_SPEC.loader.exec_module(resource)

URL = "/notify_once/notify-once-card.js?v=1.0.2"


class FakeCollection:
    def __init__(self, items=None, loaded=True):
        self.items = list(items or [])
        self.loaded = loaded
        self.load_calls = 0
        self.created = []
        self.updated = []

    async def async_load(self):
        self.load_calls += 1

    def async_items(self):
        return list(self.items)

    async def async_create_item(self, data):
        self.created.append(data)
        self.items.append({"id": "new", "type": data["res_type"], "url": data["url"]})

    async def async_update_item(self, item_id, data):
        self.updated.append((item_id, data))


class FakeYamlCollection:
    """The YAML collection cannot be edited."""

    def async_items(self):
        return []


def hass_with_attribute(collection):
    return types.SimpleNamespace(data={"lovelace": types.SimpleNamespace(resources=collection)})


def hass_with_dict(collection):
    return types.SimpleNamespace(data={"lovelace": {"resources": collection}})


class EnsureCardResourceTests(unittest.IsolatedAsyncioTestCase):
    async def test_creates_when_missing(self):
        collection = FakeCollection([{"id": "x", "type": "module", "url": "/local/other.js"}])
        result = await resource.async_ensure_card_resource(hass_with_attribute(collection), URL)
        self.assertEqual(result, "created")
        self.assertEqual(collection.created, [{"res_type": "module", "url": URL}])
        self.assertEqual(collection.updated, [])

    async def test_dict_layout_of_older_versions(self):
        collection = FakeCollection()
        result = await resource.async_ensure_card_resource(hass_with_dict(collection), URL)
        self.assertEqual(result, "created")

    async def test_unchanged_when_present(self):
        collection = FakeCollection([{"id": "a", "type": "module", "url": URL}])
        result = await resource.async_ensure_card_resource(hass_with_attribute(collection), URL)
        self.assertEqual(result, "unchanged")
        self.assertEqual((collection.created, collection.updated), ([], []))

    async def test_updates_old_version_and_keeps_the_id(self):
        old = "/notify_once/notify-once-card.js?v=1.0.1"
        collection = FakeCollection([{"id": "a", "type": "module", "url": old}])
        result = await resource.async_ensure_card_resource(hass_with_attribute(collection), URL)
        self.assertEqual(result, "updated")
        self.assertEqual(collection.updated, [("a", {"res_type": "module", "url": URL})])
        self.assertEqual(collection.created, [])

    async def test_fixes_wrong_type(self):
        collection = FakeCollection([{"id": "a", "type": "js", "url": URL}])
        result = await resource.async_ensure_card_resource(hass_with_attribute(collection), URL)
        self.assertEqual(result, "updated")

    async def test_loads_collection_first(self):
        collection = FakeCollection(loaded=False)
        await resource.async_ensure_card_resource(hass_with_attribute(collection), URL)
        self.assertEqual(collection.load_calls, 1)
        self.assertTrue(collection.loaded)

    async def test_yaml_mode_is_skipped(self):
        result = await resource.async_ensure_card_resource(hass_with_attribute(FakeYamlCollection()), URL)
        self.assertEqual(result, "unavailable")

    async def test_no_lovelace_is_skipped(self):
        hass = types.SimpleNamespace(data={})
        self.assertEqual(await resource.async_ensure_card_resource(hass, URL), "unavailable")

    async def test_errors_never_escape(self):
        class Broken(FakeCollection):
            async def async_create_item(self, data):
                raise RuntimeError("boom")

        with self.assertLogs("notify_once_resource", level="WARNING"):
            result = await resource.async_ensure_card_resource(hass_with_attribute(Broken()), URL)
        self.assertEqual(result, "failed")


if __name__ == "__main__":
    unittest.main()
