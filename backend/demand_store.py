"""
backend/demand_store.py — convert the dbquery .xlsx demand files into fast SQLite
databases and expose per-MPN / per-plant demand for the app.

For every .xlsx in DBQUERY_DIR this builds a sibling .db file (the original
.xlsx is kept). Each .db has a single `demand` table holding ALL of the Excel
columns plus three derived helper columns for fast joins:
  • mpn_key    — uppercased, trimmed 'Manufacturer Part No.'
  • plant_code — the Excel 'Plant' value normalised to a 4-digit code (e.g. 20→'0020')
  • plant_name — mapped plant short name (KEMX, KETL, …) or '' when unknown

A small JSON registry (dbquery/demand_registry.json) tracks every demand .db and
which one is "active". An admin chooses the active demand database; the Supplier
Savings Analysis modal then joins demand by MPN + plant.
"""

from __future__ import annotations

import json
import os
import re
import sqlite3
import threading
from datetime import datetime
from typing import Iterable

import pandas as pd

from config import DBQUERY_DIR

# ── Plant code → short name mapping (per business definition) ──────────────────
PLANT_CODE_TO_NAME: dict[str, str] = {
    "0005": "KETA",
    "0010": "KEJ",
    "0020": "KEMX",
    "0040": "KEPS",
    "0045": "KERO",
    "0050": "KETL",
    "0070": "KECN",
}

# Source-file column names we care about for the integration.
MPN_COL          = "Manufacturer Part No."
PLANT_COL        = "Plant"
TOTAL_EAU_COL    = "Total EAU"
ONHAND_COL       = "Onhand Qty"
GROSS_DEMAND_COL = "Gross Demand"

_LOCK = threading.RLock()
REGISTRY_PATH = os.path.join(DBQUERY_DIR, "demand_registry.json")

# ── Background convert-job state ──────────────────────────────────────────────
_CONVERT_LOCK = threading.Lock()
_CONVERT_STATE: dict = {
    "running": False,
    "started_at": None,
    "finished_at": None,
    "results": [],
    "message": "",
}


def convert_state() -> dict:
    with _CONVERT_LOCK:
        return dict(_CONVERT_STATE)


def _set_convert(**kw) -> None:
    with _CONVERT_LOCK:
        _CONVERT_STATE.update(kw)


def is_converting() -> bool:
    with _CONVERT_LOCK:
        return _CONVERT_STATE["running"]


def start_convert(force: bool = False) -> dict:
    """Launch the Excel→.db conversion of all dbquery files in a background thread."""
    if is_converting():
        return {"started": False, "reason": "A conversion is already running."}
    _set_convert(running=True, started_at=_now(), finished_at=None,
                 results=[], message="Converting…")

    def _work():
        try:
            results = convert_all(force=force)
            _set_convert(running=False, finished_at=_now(), results=results,
                         message=f"Converted {sum(1 for r in results if not r.get('skipped') and not r.get('error'))} file(s).")
        except Exception as exc:  # noqa: BLE001
            _set_convert(running=False, finished_at=_now(),
                         message=f"Conversion failed: {exc}")

    threading.Thread(target=_work, daemon=True).start()
    return {"started": True}


def _now() -> str:
    return datetime.now().isoformat()


def _normalise_plant_code(value) -> str:
    """Normalise a raw 'Plant' value to a 4-digit zero-padded code ('20' → '0020')."""
    if value is None:
        return ""
    s = str(value).strip()
    if s == "" or s.lower() == "nan":
        return ""
    # Keep only digits, then zero-pad to 4. '20' → '0020', '0020' → '0020'.
    digits = re.sub(r"\D", "", s)
    if not digits:
        return s.upper()
    return digits.zfill(4)


def _db_path_for(xlsx_path: str) -> str:
    base = os.path.splitext(os.path.basename(xlsx_path))[0]
    return os.path.join(DBQUERY_DIR, base + ".db")


# ── Excel → SQLite conversion ─────────────────────────────────────────────────

def list_xlsx_files() -> list[str]:
    """Absolute paths of every .xlsx in DBQUERY_DIR (excludes temp ~$ lock files)."""
    if not os.path.isdir(DBQUERY_DIR):
        return []
    out = []
    for name in os.listdir(DBQUERY_DIR):
        if name.lower().endswith(".xlsx") and not name.startswith("~$"):
            out.append(os.path.join(DBQUERY_DIR, name))
    return sorted(out)


def convert_one(xlsx_path: str, *, force: bool = False) -> dict:
    """Convert a single .xlsx into a sibling .db. Keeps the original .xlsx.

    Returns a summary dict. Skips work when an up-to-date .db already exists,
    unless `force` is True.
    """
    db_path = _db_path_for(xlsx_path)
    db_file = os.path.basename(db_path)
    # Skip when the .db is newer than the .xlsx (already converted).
    if not force and os.path.exists(db_path):
        if os.path.getmtime(db_path) >= os.path.getmtime(xlsx_path):
            return {"file": db_file, "rows": None, "skipped": True,
                    "reason": "up-to-date", "source": os.path.basename(xlsx_path)}

    df = pd.read_excel(xlsx_path, sheet_name=0)
    # Derived helper columns for fast joins.
    if MPN_COL in df.columns:
        df["mpn_key"] = df[MPN_COL].astype(str).str.strip().str.upper()
    else:
        df["mpn_key"] = ""
    if PLANT_COL in df.columns:
        df["plant_code"] = df[PLANT_COL].map(_normalise_plant_code)
    else:
        df["plant_code"] = ""
    df["plant_name"] = df["plant_code"].map(lambda c: PLANT_CODE_TO_NAME.get(c, ""))

    # Write to a temp file first, then atomically replace, so readers never see
    # a half-written DB.
    tmp_path = db_path + ".building"
    for p in (tmp_path, tmp_path + "-wal", tmp_path + "-shm"):
        try:
            if os.path.exists(p):
                os.remove(p)
        except OSError:
            pass
    conn = sqlite3.connect(tmp_path)
    try:
        df.to_sql("demand", conn, if_exists="replace", index=False)
        conn.execute("CREATE INDEX IF NOT EXISTS idx_demand_mpn ON demand(mpn_key)")
        conn.execute("CREATE INDEX IF NOT EXISTS idx_demand_mpn_plant ON demand(mpn_key, plant_code)")
        conn.commit()
    finally:
        conn.close()
    # Atomic swap.
    for p in (db_path, db_path + "-wal", db_path + "-shm"):
        try:
            if os.path.exists(p):
                os.remove(p)
        except OSError:
            pass
    os.replace(tmp_path, db_path)

    register_database(db_file, label=os.path.basename(xlsx_path), rows=len(df))
    return {"file": db_file, "rows": len(df), "skipped": False,
            "source": os.path.basename(xlsx_path)}


def convert_all(*, force: bool = False) -> list[dict]:
    """Convert every .xlsx in DBQUERY_DIR to a .db. Returns per-file summaries."""
    results = []
    for xlsx in list_xlsx_files():
        try:
            results.append(convert_one(xlsx, force=force))
        except Exception as exc:  # noqa: BLE001
            results.append({"file": os.path.basename(_db_path_for(xlsx)),
                            "source": os.path.basename(xlsx),
                            "error": str(exc)[:500], "skipped": False})
    # Default the active DB to the first one if none set yet.
    reg = _read()
    if not reg.get("active") and reg.get("databases"):
        reg["active"] = reg["databases"][0]["file"]
        _write(reg)
    return results


# ── Registry (which demand DB is active) ──────────────────────────────────────

def _read() -> dict:
    with _LOCK:
        if not os.path.exists(REGISTRY_PATH):
            return {"active": None, "databases": []}
        try:
            with open(REGISTRY_PATH, "r", encoding="utf-8") as fh:
                return json.load(fh)
        except (ValueError, OSError):
            return {"active": None, "databases": []}


def _write(reg: dict) -> None:
    with _LOCK:
        os.makedirs(DBQUERY_DIR, exist_ok=True)
        tmp = REGISTRY_PATH + ".tmp"
        with open(tmp, "w", encoding="utf-8") as fh:
            json.dump(reg, fh, indent=2)
        os.replace(tmp, REGISTRY_PATH)


def register_database(file_name: str, label: str | None = None, rows: int | None = None) -> None:
    with _LOCK:
        reg = _read()
        entry = next((d for d in reg["databases"] if d["file"] == file_name), None)
        if entry is None:
            reg["databases"].append({
                "file": file_name, "label": label or file_name,
                "rows": rows, "created_at": _now(),
            })
        else:
            entry["label"] = label or entry.get("label") or file_name
            entry["rows"] = rows if rows is not None else entry.get("rows")
            entry["created_at"] = _now()
        if not reg.get("active"):
            reg["active"] = file_name
        _write(reg)


def list_databases() -> list[dict]:
    """Registry entries enriched with on-disk presence + the active flag."""
    with _LOCK:
        reg = _read()
        active = reg.get("active")
        out = []
        for d in reg.get("databases", []):
            path = os.path.join(DBQUERY_DIR, d["file"])
            exists = os.path.exists(path)
            out.append({
                **d,
                "active": d["file"] == active,
                "exists": exists,
                "size_bytes": os.path.getsize(path) if exists else 0,
            })
        return out


def active_db_file() -> str | None:
    with _LOCK:
        return _read().get("active")


def active_db_path() -> str | None:
    f = active_db_file()
    return os.path.join(DBQUERY_DIR, f) if f else None


def set_active(file_name: str) -> dict:
    with _LOCK:
        reg = _read()
        if not any(d["file"] == file_name for d in reg.get("databases", [])):
            raise ValueError(f"Demand DB '{file_name}' is not registered.")
        if not os.path.exists(os.path.join(DBQUERY_DIR, file_name)):
            raise ValueError(f"Demand DB file '{file_name}' does not exist on disk.")
        reg["active"] = file_name
        _write(reg)
        return reg


def remove_database(file_name: str, delete_file: bool = False) -> dict:
    with _LOCK:
        reg = _read()
        reg["databases"] = [d for d in reg.get("databases", []) if d["file"] != file_name]
        if reg.get("active") == file_name:
            reg["active"] = reg["databases"][0]["file"] if reg["databases"] else None
        _write(reg)
        if delete_file:
            path = os.path.join(DBQUERY_DIR, file_name)
            for p in (path, path + "-wal", path + "-shm"):
                try:
                    if os.path.exists(p):
                        os.remove(p)
                except OSError:
                    pass
        return reg


# ── Per-MPN demand lookup ─────────────────────────────────────────────────────

def _f(v) -> float | None:
    try:
        if v is None or v == "":
            return None
        return float(v)
    except (TypeError, ValueError):
        return None


def lookup_demand(mpns: Iterable[str]) -> dict[str, list[dict]]:
    """Return {MPN_UPPER: [ {plant_code, plant_name, total_eau, onhand_qty,
    gross_demand}, … ]} for the given MPNs from the ACTIVE demand DB.

    One entry per plant row found for that MPN. Empty dict when no active DB.
    """
    path = active_db_path()
    if not path or not os.path.exists(path):
        return {}
    keys = list({(m or "").strip().upper() for m in mpns if m})
    if not keys:
        return {}

    # Quote the spaced Excel column names.
    def q(c: str) -> str:
        return '"' + c.replace('"', '""') + '"'

    conn = sqlite3.connect(path)
    conn.row_factory = sqlite3.Row
    # Discover which of the demand columns actually exist in this DB.
    cols = {r["name"] for r in conn.execute("PRAGMA table_info(demand)").fetchall()}
    sel_total = q(TOTAL_EAU_COL)    if TOTAL_EAU_COL    in cols else "NULL"
    sel_onh   = q(ONHAND_COL)       if ONHAND_COL       in cols else "NULL"
    sel_gross = q(GROSS_DEMAND_COL) if GROSS_DEMAND_COL in cols else "NULL"

    out: dict[str, list[dict]] = {}
    try:
        for i in range(0, len(keys), 400):
            chunk = keys[i : i + 400]
            placeholders = ",".join("?" * len(chunk))
            sql = (
                f"SELECT mpn_key, plant_code, plant_name, "
                f"{sel_total} AS total_eau, {sel_onh} AS onhand_qty, {sel_gross} AS gross_demand "
                f"FROM demand WHERE mpn_key IN ({placeholders})"
            )
            for row in conn.execute(sql, tuple(chunk)).fetchall():
                key = row["mpn_key"]
                out.setdefault(key, []).append({
                    "plantCode": row["plant_code"] or "",
                    "plantName": row["plant_name"] or "",
                    "totalEau": _f(row["total_eau"]),
                    "onhandQty": _f(row["onhand_qty"]),
                    "grossDemand": _f(row["gross_demand"]),
                })
    finally:
        conn.close()
    return out
