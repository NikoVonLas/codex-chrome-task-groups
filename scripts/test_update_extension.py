import hashlib
import io
import json
from pathlib import Path
import shutil
import stat
import sys
import tempfile
import unittest
from unittest.mock import patch
import zipfile

import update_extension as updater

SOURCE = Path(__file__).resolve().parents[1] / "extension"


class UpdateTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        self.current = self.root / "task-extension"
        shutil.copytree(SOURCE, self.current)
        self.write_old_manifest()

    def write_old_manifest(self):
        path = self.current / "manifest.json"
        manifest = json.loads(path.read_text())
        manifest["version"] = "1.2.1"
        path.write_text(json.dumps(manifest))

    def archive(self, number="1.3.0", extra=None, permissions=None):
        buffer = io.BytesIO()
        with zipfile.ZipFile(buffer, "w") as zipped:
            for path in SOURCE.rglob("*"):
                if not path.is_file():
                    continue
                data = path.read_bytes()
                if path.name == "manifest.json":
                    manifest = json.loads(data)
                    manifest["version"] = number
                    if permissions:
                        manifest["permissions"].extend(permissions)
                    data = json.dumps(manifest).encode()
                zipped.writestr(str(path.relative_to(SOURCE)), data)
            if extra:
                zipped.writestr(extra, b"unexpected")
        payload = buffer.getvalue()
        return payload, "sha256:" + hashlib.sha256(payload).hexdigest()

    def sync_release(self, number, payload, digest, running):
        with patch.object(updater, "latest_release", return_value=(number, "mock", digest)), \
                patch.object(updater, "download", return_value=payload), \
                patch.object(updater, "chrome_running", return_value=running):
            return updater.sync(self.root, force=True)

    @unittest.skipUnless(sys.platform == "darwin", "Requires the macOS atomic directory swap")
    def test_stages_while_running_then_swaps_offline_and_preserves_previous_version(self):
        data, digest = self.archive()
        self.assertIn("Waiting", self.sync_release("1.3.0", data, digest, True))
        self.assertEqual(updater.read_manifest(self.current)["version"], "1.2.1")
        with patch.object(updater, "chrome_running", return_value=False), \
                patch.object(updater, "latest_release", side_effect=AssertionError("network access")):
            self.assertEqual(updater.sync(self.root), "Installed 1.3.0")
            self.assertEqual(updater.sync(self.root), "Up to date")
        self.assertEqual(updater.read_manifest(self.root / "task-updates/previous")["version"], "1.2.1")
        self.assertEqual(updater.read_manifest(self.current)["version"], "1.3.0")

    def test_fresh_install(self):
        shutil.rmtree(self.current)
        data, digest = self.archive()
        self.assertEqual(self.sync_release("1.3.0", data, digest, True), "Installed 1.3.0")
        self.assertEqual(updater.read_manifest(self.current)["version"], "1.3.0")

    def test_rollbacks_and_unchanged_releases_do_not_download(self):
        with patch.object(updater, "download", side_effect=AssertionError("download")):
            for number in ("1.2.0", "1.2.1"):
                with patch.object(updater, "latest_release", return_value=(number, "mock", "unused")):
                    self.assertEqual(updater.sync(self.root, force=True), "Up to date")

    def test_rejects_corruption_and_invalid_assets_without_touching_installation(self):
        data, digest = self.archive()
        symlink = zipfile.ZipInfo("symlink")
        symlink.external_attr = (stat.S_IFLNK | 0o777) << 16
        for payload, sha in [(data, "sha256:wrong"), self.archive(number="1.3.1"),
                             self.archive(extra="../outside"), self.archive(extra=symlink),
                             self.archive(permissions=["history"])]:
            with self.assertRaises(ValueError):
                self.sync_release("1.3.0", payload, sha, False)
            self.assertEqual(updater.read_manifest(self.current)["version"], "1.2.1")
            self.assertFalse((self.root / "task-updates/pending").exists())
