import os
import pathlib
import signal
import subprocess
import sys
import tempfile
import time
import unittest

supervisor = pathlib.Path(__file__).resolve().parents[1] / "rehearsal-process.py"


class RehearsalProcessTest(unittest.TestCase):
    def test_detached_descendant_cannot_outlive_abort_or_parent_exit(self):
        for cancel in (True, False):
            with self.subTest(cancel=cancel), tempfile.TemporaryDirectory() as directory:
                marker = pathlib.Path(directory) / "late-write"
                ready = pathlib.Path(directory) / "ready"
                grandchild = "import time,pathlib;time.sleep(0.7);pathlib.Path(%r).write_text('escaped')" % str(marker)
                script = "import subprocess,sys,pathlib,time;subprocess.Popen([sys.executable,'-c',%r],start_new_session=True);pathlib.Path(%r).write_text('ready');time.sleep(%s)" % (grandchild, str(ready), 30 if cancel else 0)
                child = subprocess.Popen([sys.executable, str(supervisor), sys.executable, "-c", script])
                deadline = time.monotonic() + 5
                while not ready.exists() and child.poll() is None and time.monotonic() < deadline:
                    time.sleep(0.01)
                self.assertTrue(ready.exists())
                if cancel:
                    os.kill(child.pid, signal.SIGTERM)
                self.assertEqual(child.wait(timeout=5), 130 if cancel else 0)
                time.sleep(0.8)
                self.assertFalse(marker.exists(), "Detached descendant escaped cleanup")


if __name__ == "__main__":
    unittest.main()
