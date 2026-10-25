"""Keep module-level app initialization away from a user's practice records."""

import os
import tempfile
from pathlib import Path


_runtime = tempfile.TemporaryDirectory(prefix="stat-pytest-")
_previous = {name: os.environ.get(name) for name in ("STAT_DB_PATH", "STAT_EXPORT_PATH")}
os.environ["STAT_DB_PATH"] = str(Path(_runtime.name) / "module.db")
os.environ["STAT_EXPORT_PATH"] = str(Path(_runtime.name) / "module-export.json")


def pytest_unconfigure(config):
    for name, value in _previous.items():
        if value is None:
            os.environ.pop(name, None)
        else:
            os.environ[name] = value
    _runtime.cleanup()
