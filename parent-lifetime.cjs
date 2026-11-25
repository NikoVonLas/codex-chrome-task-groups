'use strict';

// Stdio servers belong to a single client. On macOS a surviving child is
// reparented to launchd, even if another process still holds its pipes open.
const parent = process.ppid;
if (parent === 1) process.exit(0);

const check = setInterval(() => {
  if (process.ppid === parent) return;
  clearInterval(check);
  // Allow the server's normal signal handler to finish its own cleanup.
  // The Chrome wrapper may spend up to 12 seconds closing tabs and its backend.
  setTimeout(() => process.kill(process.pid, 'SIGKILL'), 15000).unref();
  process.kill(process.pid, 'SIGTERM');
}, 1000);
check.unref();
