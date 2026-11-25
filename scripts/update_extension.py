#!/usr/bin/env python3
"""Install and update the unpacked Chrome extension on macOS using GitHub releases."""

import argparse
import base64
import ctypes
import fcntl
import hashlib
import io
import json
import os
from pathlib import Path, PurePosixPath
import plistlib
import re
import shutil
import stat
import subprocess
import sys
import tempfile
import time
from urllib.request import Request, urlopen
import zipfile

REPO = "NikoVonLas/codex-chrome-task-groups"
EXTENSION_ID = "mmlmfjhmonkocbjadbfplnigmagldckm"
EXTENSION_NAME = "Playwright — task groups (local)"
LABEL = "com.github.nikovonlas.chrome-task-groups.updater"
CHECK_INTERVAL = 4 * 60 * 60
RETRY_INTERVAL = 5 * 60
MAX_BYTES = 16 * 1024 * 1024
ROOT = Path.home() / ".local/share/codex-chrome-cli"
PLIST = Path.home() / "Library/LaunchAgents" / (LABEL + ".plist")


def version(value):
    if not re.fullmatch(r"(0|[1-9][0-9]{0,4})(\.(0|[1-9][0-9]{0,4})){2}", value):
        raise ValueError("Expected a three-part release version")
    parts = tuple(map(int, value.split(".")))
    if max(parts) > 65535:
        raise ValueError("Version exceeds Chrome's component limit")
    return parts


def read_manifest(directory):
    if directory.is_symlink():
        raise ValueError("Unexpected symlink at the extension directory")
    manifest = json.loads((directory / "manifest.json").read_text())
    key_hash = hashlib.sha256(base64.b64decode(manifest["key"], validate=True)).hexdigest()[:32]
    identifier = key_hash.translate(str.maketrans("0123456789abcdef", "abcdefghijklmnop"))
    if identifier != EXTENSION_ID or manifest["name"] != EXTENSION_NAME or manifest["manifest_version"] != 3:
        raise ValueError("Directory does not contain this project's Chrome extension")
    version(manifest["version"])
    return manifest


def download(url, limit):
    req = Request(url, headers={"User-Agent": "Chrome-Task-Groups-Updater", "Accept": "*/*"})
    with urlopen(req, timeout=30) as response:
        data = response.read(limit + 1)
    if len(data) > limit:
        raise ValueError("Download exceeded size limit")
    return data


def latest_release():
    release = json.loads(download(f"https://api.github.com/repos/{REPO}/releases/latest", 1_048_576))
    tag = release["tag_name"]
    if release["draft"] or release["prerelease"] or not tag.startswith("v"):
        raise ValueError("Expected a published stable release")
    number = tag[1:]
    version(number)
    name = f"chrome-task-groups-{number}.zip"
    url = f"https://github.com/{REPO}/releases/download/{tag}/{name}"
    for asset in release["assets"]:
        if asset["name"] == name and asset["state"] == "uploaded" and asset["browser_download_url"] == url:
            digest = asset.get("digest") or ""
            if re.fullmatch(r"sha256:[0-9a-f]{64}", digest):
                return number, url, digest
    raise ValueError("Verified ZIP is not yet available on this release")


def unpack(payload, digest, number, directory):
    if "sha256:" + hashlib.sha256(payload).hexdigest() != digest:
        raise ValueError("Release ZIP checksum mismatch")
    with zipfile.ZipFile(io.BytesIO(payload)) as archive:
        entries = archive.infolist()
        if len(entries) > 512 or sum(e.file_size for e in entries) > MAX_BYTES:
            raise ValueError("Extension contents exceed size limit")
        for entry in entries:
            path = PurePosixPath(entry.filename)
            kind = stat.S_IFMT(entry.external_attr >> 16)
            if (not path.parts or path.is_absolute() or ".." in path.parts or "\\" in entry.filename
                    or kind not in (0, stat.S_IFREG, stat.S_IFDIR)):
                raise ValueError("Unexpected path or file type in ZIP")
            target = directory / path
            if entry.is_dir():
                target.mkdir(parents=True, exist_ok=True)
                continue
            target.parent.mkdir(parents=True, exist_ok=True)
            with archive.open(entry) as source, target.open("xb") as dest:
                shutil.copyfileobj(source, dest)
    manifest = read_manifest(directory)
    worker = PurePosixPath(manifest["background"]["service_worker"])
    if (manifest["version"] != number or worker.is_absolute() or ".." in worker.parts
            or not (directory / worker).is_file()):
        raise ValueError("Release manifest does not match the ZIP")


def exchange(first, second):
    # Both directories must be on the same volume. RENAME_SWAP preserves the old tree.
    libc = ctypes.CDLL(None, use_errno=True)
    if libc.renamex_np(os.fsencode(first), os.fsencode(second), 0x00000002):
        err = ctypes.get_errno()
        raise OSError(err, os.strerror(err))


def chrome_running():
    check = subprocess.run(["/usr/bin/pgrep", "-u", str(os.getuid()), "-x", "Google Chrome"],
                           stdout=subprocess.DEVNULL)
    if check.returncode not in (0, 1):
        raise RuntimeError("Could not determine whether Chrome is running")
    return check.returncode == 0


def sync(root, force=False):
    state = root / "task-updates"
    state.mkdir(parents=True, exist_ok=True, mode=0o700)
    with (state / "update.lock").open("a") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        return sync_locked(root, state, force)


def sync_locked(root, state, force):
    current = root / "task-extension"
    installed = read_manifest(current) if current.exists() else None
    installed_version = version(installed["version"]) if installed else (-1,)
    pending = state / "pending"
    staged_version = version(read_manifest(pending)["version"]) if pending.exists() else (-1,)
    due = state / "next-check"
    now = int(time.time())
    # Apply an already verified download even if GitHub is offline.
    if staged_version > installed_version and (not installed or not chrome_running()):
        if installed:
            exchange(current, pending)
            previous = state / "previous"
            if previous.exists():
                shutil.rmtree(previous)
            pending.rename(previous)
        else:
            pending.rename(current)
        return "Installed " + read_manifest(current)["version"]
    if not force and due.exists() and now < int(due.read_text() or 0):
        return "Waiting for Chrome to quit" if staged_version > installed_version else "Up to date"

    def next_check(delay):
        temp = state / "next-check.tmp"
        temp.write_text(str(now + delay))
        temp.replace(due)

    next_check(RETRY_INTERVAL)
    number, url, digest = latest_release()
    if version(number) > max(installed_version, staged_version):
        with tempfile.TemporaryDirectory(dir=state) as tmp:
            candidate = Path(tmp) / "extension"
            candidate.mkdir()
            unpack(download(url, MAX_BYTES), digest, number, candidate)
            if installed:
                new = read_manifest(candidate)
                for field in ("permissions", "host_permissions"):
                    if set(new.get(field, [])) - set(installed.get(field, [])):
                        raise ValueError("New Chrome permissions require a manual update")
            if pending.exists():
                exchange(candidate, pending)
            else:
                candidate.rename(pending)
        next_check(CHECK_INTERVAL)
        return sync_locked(root, state, False)
    next_check(CHECK_INTERVAL)
    return "Waiting for Chrome to quit" if staged_version > installed_version else "Up to date"


def install():
    message = sync(ROOT, force=True)
    state = ROOT / "task-updates"
    program = state / "update_extension.py"
    if Path(__file__).resolve() != program.resolve():
        temporary = state / "installer.tmp"
        shutil.copyfile(__file__, temporary)
        temporary.replace(program)
    PLIST.parent.mkdir(parents=True, exist_ok=True)
    config = {"Label": LABEL, "ProgramArguments": [sys.executable, str(program), "tick"],
              "RunAtLoad": True, "StartInterval": 60, "ProcessType": "Background",
              "StandardErrorPath": str(state / "errors.log")}
    domain = f"gui/{os.getuid()}"
    service = f"{domain}/{LABEL}"
    if subprocess.run(["launchctl", "print", service], capture_output=True).returncode == 0:
        subprocess.run(["launchctl", "bootout", service], check=True)
    temporary = PLIST.with_suffix(".tmp")
    temporary.write_bytes(plistlib.dumps(config))
    temporary.replace(PLIST)
    subprocess.run(["launchctl", "bootstrap", domain, str(PLIST)], check=True)
    print(message)
    print("Automatic updates enabled. Load this unpacked directory in Chrome:", ROOT / "task-extension")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("action", choices=("install", "check", "disable", "tick"))
    action = parser.parse_args().action
    if sys.platform != "darwin":
        parser.error("This updater requires macOS")
    os.umask(0o077)
    if action == "install":
        install()
    elif action == "disable":
        domain = f"gui/{os.getuid()}/{LABEL}"
        if subprocess.run(["launchctl", "print", domain], capture_output=True).returncode == 0:
            subprocess.run(["launchctl", "bootout", domain], check=True)
        PLIST.unlink(missing_ok=True)
        print("Automatic updates disabled")
    else:
        result = sync(ROOT, force=action == "check")
        if action == "check":
            print(result)


if __name__ == "__main__":
    try:
        main()
    except (OSError, ValueError, KeyError, zipfile.BadZipFile, RuntimeError, subprocess.SubprocessError) as error:
        sys.exit(str(error))
