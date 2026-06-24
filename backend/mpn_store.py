"""
backend/mpn_store.py — SQLite store for pre-computed best SAP prices per MPN.

Holds:
  • mpn_best   — best supplier price per MPN (valid for a single day)
  • job_runs   — history of every batch-job execution
  • job_errors — per-MPN errors captured during a run (for the admin dashboard)
  • job_meta   — key/value (e.g. last successful run timestamp)

The best-price computation (`compute_best_row`) is a faithful Python port of the
frontend `buildPlantSummaries()` / `resolveLastPoPrice()` logic so that batch and
real-time results are identical.
"""

from __future__ import annotations

import json
import os
import sqlite3
import threading
from contextlib import contextmanager
from datetime import datetime, date
from typing import Any, Iterable

from config import MPN_DB_PATH

# SQLite from multiple threads → single connection guarded by a lock.
_LOCK = threading.RLock()
_conn: sqlite3.Connection | None = None


# ── Connection ────────────────────────────────────────────────────────────────

def _connect() -> sqlite3.Connection:
    global _conn
    if _conn is None:
        os.makedirs(os.path.dirname(MPN_DB_PATH), exist_ok=True)
        _conn = sqlite3.connect(MPN_DB_PATH, check_same_thread=False)
        _conn.row_factory = sqlite3.Row
        _conn.execute("PRAGMA journal_mode=WAL;")
    return _conn


@contextmanager
def _cursor():
    with _LOCK:
        conn = _connect()
        cur = conn.cursor()
        try:
            yield cur
            conn.commit()
        finally:
            cur.close()


def init_db() -> None:
    """Create tables if they don't exist. Safe to call on every startup."""
    with _cursor() as cur:
        cur.execute(
            """
            CREATE TABLE IF NOT EXISTS mpn_best (
                mpn             TEXT PRIMARY KEY,
                internal_pn     TEXT,
                best_source     TEXT,            -- 'MPN' | 'Internal'
                best_price_usd  REAL,
                std_price_usd   REAL,
                best_supplier   TEXT,
                best_plant      TEXT,
                best_mpn        TEXT,
                last_po_date    TEXT,
                window_days     INTEGER,
                computed_at     TEXT,            -- ISO timestamp
                valid_date      TEXT,            -- YYYY-MM-DD the entry is valid for
                origin          TEXT,            -- 'job' | 'realtime'
                payload_json    TEXT             -- raw IQ rows + AMPL blocked/deleted (JSON)
            )
            """
        )
        # ── Migration: add payload_json to pre-existing DBs that lack it ──────
        cols = {r["name"] for r in cur.execute("PRAGMA table_info(mpn_best)").fetchall()}
        if "payload_json" not in cols:
            cur.execute("ALTER TABLE mpn_best ADD COLUMN payload_json TEXT")
        cur.execute(
            """
            CREATE TABLE IF NOT EXISTS job_runs (
                id            INTEGER PRIMARY KEY AUTOINCREMENT,
                started_at    TEXT,
                finished_at   TEXT,
                status        TEXT,              -- running | done | failed | cancelled
                trigger       TEXT,              -- manual | retry | scheduled
                total_mpns    INTEGER DEFAULT 0,
                processed     INTEGER DEFAULT 0,
                success_count INTEGER DEFAULT 0,
                error_count   INTEGER DEFAULT 0,
                conn_errors   INTEGER DEFAULT 0,
                source_file   TEXT,
                log_path      TEXT
            )
            """
        )
        cur.execute(
            """
            CREATE TABLE IF NOT EXISTS job_errors (
                id          INTEGER PRIMARY KEY AUTOINCREMENT,
                run_id      INTEGER,
                mpn         TEXT,
                internal_pn TEXT,
                error_type  TEXT,                -- 'connection' | 'other'
                message     TEXT,
                created_at  TEXT
            )
            """
        )
        cur.execute(
            """
            CREATE TABLE IF NOT EXISTS job_meta (
                key   TEXT PRIMARY KEY,
                value TEXT
            )
            """
        )


# ── Best-price computation (port of frontend logic) ───────────────────────────

def _f(v: Any) -> float | None:
    try:
        if v is None or v == "":
            return None
        return float(v)
    except (TypeError, ValueError):
        return None


def resolve_last_po_price(row: dict) -> float | None:
    """Port of frontend resolveLastPoPrice()."""
    last_usd = _f(row.get("lastPoPriceUsd"))
    if last_usd is not None:
        return last_usd
    raw = _f(row.get("rawLastPoPrice"))
    per = _f(row.get("rawLastPoPer"))
    if raw is None or not per:
        return None
    fx = _f(row.get("localCurrencyExchangeRateUsd"))
    return raw / per * fx if fx else None


def _epoch_ms(date_str: Any) -> float:
    """Parse an ISO-ish date string to epoch ms; 0 on failure (matches JS new Date(x||0))."""
    if not date_str:
        return 0.0
    s = str(date_str).strip()
    for fmt in ("%Y-%m-%dT%H:%M:%S", "%Y-%m-%d %H:%M:%S", "%Y-%m-%d", "%m/%d/%Y", "%Y/%m/%d"):
        try:
            return datetime.strptime(s[: len(fmt) + 4], fmt).timestamp() * 1000.0
        except ValueError:
            continue
    try:
        return datetime.fromisoformat(s.replace("Z", "")).timestamp() * 1000.0
    except ValueError:
        return 0.0


def compute_best_row(rows: list[dict], window_ms: float) -> dict | None:
    """
    Port of frontend buildPlantSummaries(rows, windowMs)[0].bestRow.
    Returns the single best IQItem dict across all plants, or None.
    """
    if not rows:
        return None

    # Group by plant
    by_plant: dict[str, list[dict]] = {}
    for r in rows:
        by_plant.setdefault(r.get("siteName") or "", []).append(r)

    max_time = max((_epoch_ms(r.get("lastPoDate")) for r in rows), default=0.0)
    window_start = (max_time - window_ms) if max_time > 0 else 0.0

    summaries: list[dict] = []
    for site, site_rows in by_plant.items():
        in_window = [r for r in site_rows if _epoch_ms(r.get("lastPoDate")) >= window_start]
        had_in_window = len(in_window) > 0
        candidates = in_window if had_in_window else site_rows

        best: dict | None = None
        best_p = float("inf")
        for r in candidates:
            p = resolve_last_po_price(r)
            if p is not None and p < best_p:
                best_p = p
                best = r
        if best is None:
            best = max(candidates, key=lambda r: _epoch_ms(r.get("lastPoDate")))

        summaries.append({
            "bestRow": best,
            "bestPrice": resolve_last_po_price(best),
            "hadInWindowData": had_in_window,
        })

    # Sort: in-window plants first, then by price ascending
    summaries.sort(key=lambda s: (
        0 if s["hadInWindowData"] else 1,
        s["bestPrice"] if s["bestPrice"] is not None else float("inf"),
    ))
    return summaries[0]["bestRow"] if summaries else None


# ── mpn_best CRUD ─────────────────────────────────────────────────────────────

def _today() -> str:
    return date.today().isoformat()


def upsert_best(entry: dict) -> None:
    """Insert/replace the best result for a single MPN. `entry` keys map to columns."""
    payload = entry.get("payload")
    payload_json = (
        json.dumps(payload, default=str)
        if payload is not None
        else entry.get("payload_json")
    )
    with _cursor() as cur:
        cur.execute(
            """
            INSERT INTO mpn_best
                (mpn, internal_pn, best_source, best_price_usd, std_price_usd,
                 best_supplier, best_plant, best_mpn, last_po_date, window_days,
                 computed_at, valid_date, origin, payload_json)
            VALUES
                (:mpn, :internal_pn, :best_source, :best_price_usd, :std_price_usd,
                 :best_supplier, :best_plant, :best_mpn, :last_po_date, :window_days,
                 :computed_at, :valid_date, :origin, :payload_json)
            ON CONFLICT(mpn) DO UPDATE SET
                internal_pn=excluded.internal_pn, best_source=excluded.best_source,
                best_price_usd=excluded.best_price_usd, std_price_usd=excluded.std_price_usd,
                best_supplier=excluded.best_supplier, best_plant=excluded.best_plant,
                best_mpn=excluded.best_mpn, last_po_date=excluded.last_po_date,
                window_days=excluded.window_days, computed_at=excluded.computed_at,
                valid_date=excluded.valid_date, origin=excluded.origin,
                payload_json=excluded.payload_json
            """,
            {
                "mpn": (entry.get("mpn") or "").strip().upper(),
                "internal_pn": entry.get("internal_pn"),
                "best_source": entry.get("best_source"),
                "best_price_usd": entry.get("best_price_usd"),
                "std_price_usd": entry.get("std_price_usd"),
                "best_supplier": entry.get("best_supplier"),
                "best_plant": entry.get("best_plant"),
                "best_mpn": entry.get("best_mpn"),
                "last_po_date": entry.get("last_po_date"),
                "window_days": entry.get("window_days"),
                "computed_at": entry.get("computed_at") or datetime.now().isoformat(),
                "valid_date": entry.get("valid_date") or _today(),
                "origin": entry.get("origin") or "job",
                "payload_json": payload_json,
            },
        )


def get_best(mpn: str) -> dict | None:
    """Return today's cached best for an MPN, or None if missing/stale."""
    key = (mpn or "").strip().upper()
    with _cursor() as cur:
        cur.execute(
            "SELECT * FROM mpn_best WHERE mpn = ? AND valid_date = ?",
            (key, _today()),
        )
        row = cur.fetchone()
    return dict(row) if row else None


def get_best_many(mpns: Iterable[str]) -> dict[str, dict]:
    """Return {MPN_UPPER: entry} for the given MPNs that are valid today."""
    keys = list({(m or "").strip().upper() for m in mpns if m})
    if not keys:
        return {}
    out: dict[str, dict] = {}
    today = _today()
    with _cursor() as cur:
        # Chunk to stay under SQLite's variable limit
        for i in range(0, len(keys), 400):
            chunk = keys[i : i + 400]
            placeholders = ",".join("?" * len(chunk))
            cur.execute(
                f"SELECT * FROM mpn_best WHERE valid_date = ? AND mpn IN ({placeholders})",
                (today, *chunk),
            )
            for row in cur.fetchall():
                out[row["mpn"]] = dict(row)
    return out


def purge_stale() -> int:
    """Delete entries not valid for today. Returns rows removed."""
    with _cursor() as cur:
        cur.execute("DELETE FROM mpn_best WHERE valid_date <> ?", (_today(),))
        return cur.rowcount


def count_valid_today() -> int:
    with _cursor() as cur:
        cur.execute("SELECT COUNT(*) AS c FROM mpn_best WHERE valid_date = ?", (_today(),))
        return int(cur.fetchone()["c"])


def all_valid_today() -> list[dict]:
    with _cursor() as cur:
        cur.execute("SELECT * FROM mpn_best WHERE valid_date = ? ORDER BY mpn", (_today(),))
        return [dict(r) for r in cur.fetchall()]


def valid_today_mpns() -> set[str]:
    """Return the set of MPN keys already cached and valid for today."""
    with _cursor() as cur:
        cur.execute("SELECT mpn FROM mpn_best WHERE valid_date = ?", (_today(),))
        return {row["mpn"] for row in cur.fetchall()}


# ── job_runs CRUD ─────────────────────────────────────────────────────────────

def create_run(trigger: str, total_mpns: int, source_file: str | None) -> int:
    with _cursor() as cur:
        cur.execute(
            """
            INSERT INTO job_runs (started_at, status, trigger, total_mpns, source_file)
            VALUES (?, 'running', ?, ?, ?)
            """,
            (datetime.now().isoformat(), trigger, total_mpns, source_file),
        )
        return int(cur.lastrowid)


def update_run_progress(run_id: int, processed: int, success: int, errors: int, conn_errors: int) -> None:
    with _cursor() as cur:
        cur.execute(
            """
            UPDATE job_runs SET processed=?, success_count=?, error_count=?, conn_errors=?
            WHERE id=?
            """,
            (processed, success, errors, conn_errors, run_id),
        )


def finish_run(run_id: int, status: str, log_path: str | None) -> None:
    with _cursor() as cur:
        cur.execute(
            "UPDATE job_runs SET status=?, finished_at=?, log_path=? WHERE id=?",
            (status, datetime.now().isoformat(), log_path, run_id),
        )


def get_run(run_id: int) -> dict | None:
    with _cursor() as cur:
        cur.execute("SELECT * FROM job_runs WHERE id=?", (run_id,))
        row = cur.fetchone()
    return dict(row) if row else None


def latest_run() -> dict | None:
    with _cursor() as cur:
        cur.execute("SELECT * FROM job_runs ORDER BY id DESC LIMIT 1")
        row = cur.fetchone()
    return dict(row) if row else None


def latest_successful_run() -> dict | None:
    with _cursor() as cur:
        cur.execute("SELECT * FROM job_runs WHERE status='done' ORDER BY id DESC LIMIT 1")
        row = cur.fetchone()
    return dict(row) if row else None


def list_runs(limit: int = 30) -> list[dict]:
    with _cursor() as cur:
        cur.execute("SELECT * FROM job_runs ORDER BY id DESC LIMIT ?", (limit,))
        return [dict(r) for r in cur.fetchall()]


# ── job_errors CRUD ───────────────────────────────────────────────────────────

def add_error(run_id: int, mpn: str, internal_pn: str | None, error_type: str, message: str) -> None:
    with _cursor() as cur:
        cur.execute(
            """
            INSERT INTO job_errors (run_id, mpn, internal_pn, error_type, message, created_at)
            VALUES (?, ?, ?, ?, ?, ?)
            """,
            (run_id, mpn, internal_pn, error_type, message[:1000], datetime.now().isoformat()),
        )


def list_errors(run_id: int | None = None, limit: int = 500) -> list[dict]:
    with _cursor() as cur:
        if run_id is not None:
            cur.execute(
                "SELECT * FROM job_errors WHERE run_id=? ORDER BY id DESC LIMIT ?",
                (run_id, limit),
            )
        else:
            cur.execute("SELECT * FROM job_errors ORDER BY id DESC LIMIT ?", (limit,))
        return [dict(r) for r in cur.fetchall()]


def connection_error_mpns(run_id: int) -> list[str]:
    with _cursor() as cur:
        cur.execute(
            "SELECT DISTINCT mpn FROM job_errors WHERE run_id=? AND error_type='connection'",
            (run_id,),
        )
        return [r["mpn"] for r in cur.fetchall()]


def error_metrics() -> dict:
    """Aggregate counts for the admin dashboard."""
    with _cursor() as cur:
        cur.execute(
            "SELECT error_type, COUNT(*) AS c FROM job_errors GROUP BY error_type"
        )
        by_type = {r["error_type"]: int(r["c"]) for r in cur.fetchall()}
        cur.execute("SELECT COUNT(*) AS c FROM job_errors")
        total = int(cur.fetchone()["c"])
    return {"total": total, "by_type": by_type}


# ── job_meta ──────────────────────────────────────────────────────────────────

def set_meta(key: str, value: str) -> None:
    with _cursor() as cur:
        cur.execute(
            "INSERT INTO job_meta (key, value) VALUES (?, ?) "
            "ON CONFLICT(key) DO UPDATE SET value=excluded.value",
            (key, value),
        )


def get_meta(key: str) -> str | None:
    with _cursor() as cur:
        cur.execute("SELECT value FROM job_meta WHERE key=?", (key,))
        row = cur.fetchone()
    return row["value"] if row else None
