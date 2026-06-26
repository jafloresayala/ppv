"""
backend/db_registry.py — version control for the local MPN cache databases.

The app can keep multiple SQLite cache files side by side (e.g. while a Force
full re-run is rebuilding a fresh one in the background). A small JSON registry
tracks every known database file and which one is currently "active" (the one
mpn_store reads/writes). An admin can switch the active database at any time
(hot-swap), so the previous, fully-populated cache keeps serving users while a
new build finishes — no data loss on a Force full re-run.

Registry file lives next to the databases:  <data_dir>/db_registry.json
{
  "active": "mpn_cache.db",
  "databases": [
     {"file": "mpn_cache.db",          "label": "default",  "created_at": "..."},
     {"file": "mpn_cache_20260626.db", "label": "rebuild",  "created_at": "..."}
  ]
}
"""

from __future__ import annotations

import json
import os
import threading
from datetime import datetime

from config import MPN_DB_PATH

_LOCK = threading.RLock()

DATA_DIR = os.path.dirname(os.path.abspath(MPN_DB_PATH))
DEFAULT_DB_FILE = os.path.basename(MPN_DB_PATH)
REGISTRY_PATH = os.path.join(DATA_DIR, "db_registry.json")


def _now() -> str:
    return datetime.now().isoformat()


def _ensure_dir() -> None:
    os.makedirs(DATA_DIR, exist_ok=True)


def _read() -> dict:
    """Load the registry, creating a default one (pointing at the legacy DB)."""
    _ensure_dir()
    if not os.path.exists(REGISTRY_PATH):
        reg = {
            "active": DEFAULT_DB_FILE,
            "databases": [
                {"file": DEFAULT_DB_FILE, "label": "default", "created_at": _now()}
            ],
        }
        _write(reg)
        return reg
    try:
        with open(REGISTRY_PATH, "r", encoding="utf-8") as fh:
            reg = json.load(fh)
    except (ValueError, OSError):
        reg = {"active": DEFAULT_DB_FILE, "databases": []}
    # Self-heal: make sure the active file is always listed.
    if not reg.get("databases"):
        reg["databases"] = [{"file": reg.get("active", DEFAULT_DB_FILE),
                             "label": "default", "created_at": _now()}]
    if not reg.get("active"):
        reg["active"] = reg["databases"][0]["file"]
    return reg


def _write(reg: dict) -> None:
    _ensure_dir()
    tmp = REGISTRY_PATH + ".tmp"
    with open(tmp, "w", encoding="utf-8") as fh:
        json.dump(reg, fh, indent=2)
    os.replace(tmp, REGISTRY_PATH)


def _abspath(file_name: str) -> str:
    return os.path.join(DATA_DIR, file_name)


# ── Public API ────────────────────────────────────────────────────────────────

def active_db_path() -> str:
    """Absolute path of the currently active database file."""
    with _LOCK:
        reg = _read()
        return _abspath(reg["active"])


def active_db_file() -> str:
    with _LOCK:
        return _read()["active"]


def list_databases() -> list[dict]:
    """Return registry entries enriched with on-disk presence and size."""
    with _LOCK:
        reg = _read()
        active = reg["active"]
        out = []
        for d in reg["databases"]:
            path = _abspath(d["file"])
            exists = os.path.exists(path)
            out.append({
                **d,
                "active": d["file"] == active,
                "exists": exists,
                "size_bytes": os.path.getsize(path) if exists else 0,
            })
        return out


def register_database(file_name: str, label: str | None = None) -> dict:
    """Add a database file to the registry if not already present."""
    with _LOCK:
        reg = _read()
        if not any(d["file"] == file_name for d in reg["databases"]):
            reg["databases"].append({
                "file": file_name,
                "label": label or file_name,
                "created_at": _now(),
            })
            _write(reg)
        return reg


def new_version_file(prefix: str = "mpn_cache") -> str:
    """Return a fresh, unused database file name (not yet on disk)."""
    stamp = datetime.now().strftime("%Y%m%d_%H%M%S")
    base = f"{prefix}_{stamp}.db"
    candidate = base
    i = 1
    while os.path.exists(_abspath(candidate)):
        candidate = f"{prefix}_{stamp}_{i}.db"
        i += 1
    return candidate


def set_active(file_name: str) -> dict:
    """Switch the active database. Raises ValueError if the file is unknown."""
    with _LOCK:
        reg = _read()
        if not any(d["file"] == file_name for d in reg["databases"]):
            raise ValueError(f"Database '{file_name}' is not registered.")
        if not os.path.exists(_abspath(file_name)):
            raise ValueError(f"Database file '{file_name}' does not exist on disk.")
        reg["active"] = file_name
        _write(reg)
        return reg


def remove_database(file_name: str, delete_file: bool = False) -> dict:
    """Remove a database from the registry (cannot remove the active one)."""
    with _LOCK:
        reg = _read()
        if reg["active"] == file_name:
            raise ValueError("Cannot remove the active database.")
        reg["databases"] = [d for d in reg["databases"] if d["file"] != file_name]
        _write(reg)
        if delete_file:
            path = _abspath(file_name)
            for p in (path, path + "-wal", path + "-shm"):
                try:
                    if os.path.exists(p):
                        os.remove(p)
                except OSError:
                    pass
        return reg


def abspath(file_name: str) -> str:
    return _abspath(file_name)
