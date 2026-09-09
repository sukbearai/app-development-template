"""Own and reap one rehearsal command, including detached Docker CLI descendants."""
import ctypes
import os
import signal
import subprocess
import sys
import time

if ctypes.CDLL(None, use_errno=True).prctl(36, 1, 0, 0, 0) != 0:
    raise OSError(ctypes.get_errno(), "Cannot become a child subreaper")

stopping = False


def stop(_signum, _frame):
    global stopping
    stopping = True


for name in (signal.SIGTERM, signal.SIGINT):
    signal.signal(name, stop)

child = subprocess.Popen(sys.argv[1:], stdin=subprocess.DEVNULL)
while child.poll() is None and not stopping:
    time.sleep(0.05)
status = child.poll()


def descendants():
    parents = {}
    for entry in os.scandir("/proc"):
        if not entry.name.isdigit():
            continue
        try:
            with open(entry.path + "/stat", encoding="utf8") as source:
                fields = source.read().rsplit(")", 1)[1].split()
            parents[int(entry.name)] = int(fields[1])
        except (FileNotFoundError, ProcessLookupError):
            pass
    owned = {os.getpid()}
    while True:
        expanded = owned | {pid for pid, parent in parents.items() if parent in owned}
        if expanded == owned:
            return owned - {os.getpid()}
        owned = expanded


# Freeze before killing so a child cannot fork after the final ownership census.
handles = {}
deadline = time.monotonic() + 5
while time.monotonic() < deadline:
    found = descendants()
    for pid in found - handles.keys():
        try:
            descriptor = os.pidfd_open(pid)
            signal.pidfd_send_signal(descriptor, signal.SIGSTOP)
            handles[pid] = descriptor
        except ProcessLookupError:
            pass
    if descendants() <= handles.keys():
        break
for descriptor in handles.values():
    try:
        signal.pidfd_send_signal(descriptor, signal.SIGKILL)
    except ProcessLookupError:
        pass
    os.close(descriptor)
while True:
    try:
        pid, _ = os.waitpid(-1, os.WNOHANG)
        if pid == 0:
            if time.monotonic() >= deadline:
                sys.exit(125)
            time.sleep(0.01)
    except ChildProcessError:
        break
sys.exit(130 if stopping else status if status is not None else 125)
