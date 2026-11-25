"""Provision the official Playwright token through hidden terminal input.

The file is a protected runtime secret for the MCP process, outside Git.
Never pass the token in command arguments or print it.
"""
import getpass
import os
from pathlib import Path
import re

os.umask(0o077)
directory = Path.home() / '.codex-chrome-task-groups'
directory.mkdir(mode=0o700, exist_ok=True)
destination = directory / 'extension-token'
if destination.exists():
    raise SystemExit('Runtime token already exists; refusing to overwrite it.')
try:
    token = getpass.getpass('Codex CLI: paste Playwright token (hidden), then Return: ').strip()
except (EOFError, KeyboardInterrupt):
    raise SystemExit('Cancelled; no token saved.')
if token.startswith('PLAYWRIGHT_MCP_EXTENSION_TOKEN='):
    token = token.split('=', 1)[1].strip()
if not re.fullmatch(r'[A-Za-z0-9_-]{32,256}', token):
    raise SystemExit('Invalid token format; nothing saved.')
fd = os.open(destination, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
with os.fdopen(fd, 'w') as stream:
    stream.write(token + '\n')
token = None
print('Saved the token in your user profile.')
