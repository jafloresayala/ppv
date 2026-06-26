"""
backend/mpn_store.py — SQLite store for pre-computed best SAP prices per MPN.

Holds:
  • mpn_best   — best supplier price per MPN (persistent until an admin re-runs
                 the job from scratch; entries do not auto-expire)
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
import db_registry

# SQLite from multiple threads → single connection guarded by a lock.
_LOCK = threading.RLock()
_conn: sqlite3.Connection | None = None
_conn_path: str | None = None   # absolute path the live connection points at


# ── Connection ────────────────────────────────────────────────────────────────

def _connect() -> sqlite3.Connection:
    """Open (or reuse) the connection to the *active* database file.

    The active database is resolved from the version registry, so an admin can
    hot-swap which local DB is in use without restarting the backend. If the
    active file changed since the connection was opened, it is transparently
    reopened against the new file.
    """
    global _conn, _conn_path
    target = db_registry.active_db_path()
    if _conn is not None and _conn_path == target:
        return _conn
    # Active DB changed (or first open) → (re)connect.
    if _conn is not None:
        try:
            _conn.close()
        except Exception:
            pass
        _conn = None
    os.makedirs(os.path.dirname(target), exist_ok=True)
    _conn = sqlite3.connect(target, check_same_thread=False)
    _conn.row_factory = sqlite3.Row
    _conn.execute("PRAGMA journal_mode=WAL;")
    _conn_path = target
    # Make sure the freshly-opened DB has all tables.
    _ensure_schema(_conn)
    return _conn


def reopen() -> str:
    """Force the connection to point at the current active DB (hot-swap).

    Returns the absolute path now in use. Safe to call after an admin changes
    the active database in the registry.
    """
    global _conn, _conn_path
    with _LOCK:
        if _conn is not None:
            try:
                _conn.close()
            except Exception:
                pass
            _conn = None
            _conn_path = None
        return db_registry.active_db_path()


# Thread-local "build target": when set, _cursor() writes to a dedicated DB file
# (a fresh versioned cache being built by a Force full re-run) instead of the
# active one. This keeps the live/active DB untouched so users see no data loss
# while a rebuild runs in the background.
_BUILD = threading.local()


def set_build_target(db_path: str) -> None:
    """Route all store reads/writes on THIS thread to `db_path` (a fresh build DB).

    Used by a Force full re-run so the active/live DB is never touched. Call
    clear_build_target() when done. All batch-job DB writes happen on the job's
    main thread, so a thread-local override is sufficient and safe.
    """
    os.makedirs(os.path.dirname(db_path), exist_ok=True)
    conn = sqlite3.connect(db_path, check_same_thread=False)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode=WAL;")
    _ensure_schema(conn)
    _BUILD.conn = conn


def clear_build_target() -> None:
    conn = getattr(_BUILD, "conn", None)
    _BUILD.conn = None
    if conn is not None:
        try:
            conn.commit()
        finally:
            conn.close()


@contextmanager
def build_into(db_path: str):
    """Within this thread + block, route all store reads/writes to `db_path`."""
    set_build_target(db_path)
    try:
        yield getattr(_BUILD, "conn", None)
    finally:
        clear_build_target()


@contextmanager
def _cursor():
    build_conn = getattr(_BUILD, "conn", None)
    if build_conn is not None:
        # Build-target path: dedicated connection, no global lock (its own file).
        cur = build_conn.cursor()
        try:
            yield cur
            build_conn.commit()
        finally:
            cur.close()
        return
    with _LOCK:
        conn = _connect()
        cur = conn.cursor()
        try:
            yield cur
            conn.commit()
        finally:
            cur.close()


def init_db() -> None:
    """Ensure the active database has its schema. Safe to call on every startup."""
    # Triggers _connect(), which calls _ensure_schema() on the active file.
    with _LOCK:
        _connect()


def _ensure_schema(conn: sqlite3.Connection) -> None:
    """Create all tables on the given connection if they don't exist.

    Operates directly on `conn` (not via _cursor) so it can be called from
    inside _connect() without recursing.
    """
    cur = conn.cursor()
    try:
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
                payload_json    TEXT,            -- raw IQ rows + AMPL blocked/deleted (JSON)
                status          TEXT,            -- 'ok' | 'no_price' | 'error'
                error_detail    TEXT             -- message when status='error'
            )
            """
        )
        # ── Migration: add columns to pre-existing DBs that lack them ────────
        cols = {r["name"] for r in cur.execute("PRAGMA table_info(mpn_best)").fetchall()}
        if "payload_json" not in cols:
            cur.execute("ALTER TABLE mpn_best ADD COLUMN payload_json TEXT")
        if "status" not in cols:
            cur.execute("ALTER TABLE mpn_best ADD COLUMN status TEXT")
            # Backfill: rows with a price are 'ok', rows without are 'no_price'
            cur.execute(
                "UPDATE mpn_best SET status = CASE "
                "WHEN best_price_usd IS NOT NULL THEN 'ok' ELSE 'no_price' END "
                "WHERE status IS NULL"
            )
        if "error_detail" not in cols:
            cur.execute("ALTER TABLE mpn_best ADD COLUMN error_detail TEXT")
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
        # ── Deep-analysis cache: best Multi-MPN AND Multi-Component stored
        #    SEPARATELY per MPN, so a Deep Analysis can be served instantly from
        #    the DB instead of re-querying SAP. Populated by the batch job and by
        #    real-time misses. Keyed by internal_pn (the Deep Analysis unit) with
        #    the searched MPN kept for traceability.
        cur.execute(
            """
            CREATE TABLE IF NOT EXISTS mpn_deep (
                internal_pn        TEXT PRIMARY KEY,
                mpn                TEXT,            -- a representative searched MPN
                window_days        INTEGER,
                computed_at        TEXT,
                valid_date         TEXT,
                origin             TEXT,            -- 'job' | 'realtime'
                status             TEXT,            -- 'ok' | 'no_price' | 'error'
                error_detail       TEXT,
                -- Best Multi-MPN side
                mpn_price_usd      REAL,
                mpn_std_usd        REAL,
                mpn_supplier       TEXT,
                mpn_plant          TEXT,
                mpn_best_mpn       TEXT,
                mpn_last_po_date   TEXT,
                -- Best Multi-Component (Internal PN / AMPL) side
                mc_price_usd       REAL,
                mc_std_usd         REAL,
                mc_supplier        TEXT,
                mc_plant           TEXT,
                mc_best_mpn        TEXT,
                mc_internal_pn     TEXT,
                mc_last_po_date    TEXT
            )
            """
        )
        conn.commit()
    finally:
        cur.close()


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
    # Derive a status when the caller didn't set one explicitly:
    #   • 'ok'        — a usable best price was found
    #   • 'no_price'  — SAP returned data but no usable price (or no data at all)
    status = entry.get("status")
    if not status:
        status = "ok" if entry.get("best_price_usd") is not None else "no_price"
    with _cursor() as cur:
        cur.execute(
            """
            INSERT INTO mpn_best
                (mpn, internal_pn, best_source, best_price_usd, std_price_usd,
                 best_supplier, best_plant, best_mpn, last_po_date, window_days,
                 computed_at, valid_date, origin, payload_json, status, error_detail)
            VALUES
                (:mpn, :internal_pn, :best_source, :best_price_usd, :std_price_usd,
                 :best_supplier, :best_plant, :best_mpn, :last_po_date, :window_days,
                 :computed_at, :valid_date, :origin, :payload_json, :status, :error_detail)
            ON CONFLICT(mpn) DO UPDATE SET
                internal_pn=excluded.internal_pn, best_source=excluded.best_source,
                best_price_usd=excluded.best_price_usd, std_price_usd=excluded.std_price_usd,
                best_supplier=excluded.best_supplier, best_plant=excluded.best_plant,
                best_mpn=excluded.best_mpn, last_po_date=excluded.last_po_date,
                window_days=excluded.window_days, computed_at=excluded.computed_at,
                valid_date=excluded.valid_date, origin=excluded.origin,
                payload_json=excluded.payload_json, status=excluded.status,
                error_detail=excluded.error_detail
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
                "status": status,
                "error_detail": entry.get("error_detail"),
            },
        )


def mark_error(mpn: str, detail: str, internal_pn: str | None = None) -> None:
    """Record a connection/other failure for an MPN in the persistent cache.

    A good cached price ('ok') is never overwritten by an error — a transient
    connection reset must not destroy a previously-resolved price. New or
    previously-failed MPNs are stored with status='error' so an admin can find
    and re-query them later.
    """
    key = (mpn or "").strip().upper()
    if not key:
        return
    now = datetime.now().isoformat()
    with _cursor() as cur:
        cur.execute("SELECT status FROM mpn_best WHERE mpn = ?", (key,))
        row = cur.fetchone()
        if row and row["status"] == "ok":
            return  # keep the good price
        cur.execute(
            """
            INSERT INTO mpn_best
                (mpn, internal_pn, best_source, best_price_usd, computed_at,
                 valid_date, origin, status, error_detail)
            VALUES (?, ?, 'None', NULL, ?, ?, 'realtime', 'error', ?)
            ON CONFLICT(mpn) DO UPDATE SET
                internal_pn=COALESCE(excluded.internal_pn, mpn_best.internal_pn),
                computed_at=excluded.computed_at, status='error',
                error_detail=excluded.error_detail
            """,
            (key, internal_pn, now, _today(), (detail or "")[:1000]),
        )



def get_best(mpn: str) -> dict | None:
    """Return the cached best for an MPN, or None if it isn't cached.

    The cache is persistent: entries never expire on their own. They are only
    removed when an admin runs a full re-run from scratch (`clear_all`).
    """
    key = (mpn or "").strip().upper()
    with _cursor() as cur:
        cur.execute("SELECT * FROM mpn_best WHERE mpn = ?", (key,))
        row = cur.fetchone()
    return dict(row) if row else None


def get_best_many(mpns: Iterable[str]) -> dict[str, dict]:
    """Return {MPN_UPPER: entry} for the given MPNs that are cached (any age)."""
    keys = list({(m or "").strip().upper() for m in mpns if m})
    if not keys:
        return {}
    out: dict[str, dict] = {}
    with _cursor() as cur:
        # Chunk to stay under SQLite's variable limit
        for i in range(0, len(keys), 400):
            chunk = keys[i : i + 400]
            placeholders = ",".join("?" * len(chunk))
            cur.execute(
                f"SELECT * FROM mpn_best WHERE mpn IN ({placeholders})",
                tuple(chunk),
            )
            for row in cur.fetchall():
                out[row["mpn"]] = dict(row)
    return out


def clear_all() -> int:
    """Wipe the entire cache (admin 'from scratch' re-run). Returns rows removed."""
    with _cursor() as cur:
        cur.execute("DELETE FROM mpn_best")
        return cur.rowcount


def count_cached() -> int:
    with _cursor() as cur:
        cur.execute("SELECT COUNT(*) AS c FROM mpn_best")
        return int(cur.fetchone()["c"])


def all_cached() -> list[dict]:
    with _cursor() as cur:
        cur.execute("SELECT * FROM mpn_best ORDER BY mpn")
        return [dict(r) for r in cur.fetchall()]


def cached_mpns() -> set[str]:
    """Return the set of MPN keys already cached (any age)."""
    with _cursor() as cur:
        cur.execute("SELECT mpn FROM mpn_best")
        return {row["mpn"] for row in cur.fetchall()}


def search_best(query: str, limit: int = 200) -> list[dict]:
    """Search cached entries by MPN or internal PN (case-insensitive substring)."""
    q = (query or "").strip().upper()
    with _cursor() as cur:
        if q:
            like = f"%{q}%"
            cur.execute(
                "SELECT * FROM mpn_best "
                "WHERE UPPER(mpn) LIKE ? OR UPPER(IFNULL(internal_pn,'')) LIKE ? "
                "OR UPPER(IFNULL(best_mpn,'')) LIKE ? "
                "ORDER BY mpn LIMIT ?",
                (like, like, like, limit),
            )
        else:
            cur.execute("SELECT * FROM mpn_best ORDER BY mpn LIMIT ?", (limit,))
        return [dict(r) for r in cur.fetchall()]


def list_by_status(statuses: Iterable[str], limit: int = 5000) -> list[dict]:
    """Return entries whose status is in the given set (e.g. no_price/error)."""
    sset = [s for s in {(s or "").strip() for s in statuses} if s]
    if not sset:
        return []
    placeholders = ",".join("?" * len(sset))
    with _cursor() as cur:
        cur.execute(
            f"SELECT * FROM mpn_best WHERE status IN ({placeholders}) ORDER BY mpn LIMIT ?",
            (*sset, limit),
        )
        return [dict(r) for r in cur.fetchall()]


def mpns_by_status(statuses: Iterable[str]) -> list[str]:
    """Return just the MPN keys whose status is in the given set."""
    return [r["mpn"] for r in list_by_status(statuses)]


def status_counts() -> dict[str, int]:
    """Counts of cached entries grouped by status ('ok'/'no_price'/'error')."""
    with _cursor() as cur:
        cur.execute(
            "SELECT COALESCE(status,'unknown') AS s, COUNT(*) AS c FROM mpn_best GROUP BY s"
        )
        return {r["s"]: int(r["c"]) for r in cur.fetchall()}


# ── mpn_deep CRUD (Deep Analysis cache) ───────────────────────────────────────

def upsert_deep(entry: dict) -> None:
    """Insert/replace the per-Internal-PN deep-analysis result.

    `entry` carries the best Multi-MPN row and the best Multi-Component row
    separately so a Deep Analysis can be reconstructed without hitting SAP.
    Keyed by internal_pn; ignored if no internal_pn is available.
    """
    ip = (entry.get("internal_pn") or "").strip().upper()
    if not ip:
        return
    status = entry.get("status")
    if not status:
        has_price = entry.get("mpn_price_usd") is not None or entry.get("mc_price_usd") is not None
        status = "ok" if has_price else "no_price"
    with _cursor() as cur:
        cur.execute(
            """
            INSERT INTO mpn_deep
                (internal_pn, mpn, window_days, computed_at, valid_date, origin,
                 status, error_detail,
                 mpn_price_usd, mpn_std_usd, mpn_supplier, mpn_plant, mpn_best_mpn, mpn_last_po_date,
                 mc_price_usd, mc_std_usd, mc_supplier, mc_plant, mc_best_mpn, mc_internal_pn, mc_last_po_date)
            VALUES
                (:internal_pn, :mpn, :window_days, :computed_at, :valid_date, :origin,
                 :status, :error_detail,
                 :mpn_price_usd, :mpn_std_usd, :mpn_supplier, :mpn_plant, :mpn_best_mpn, :mpn_last_po_date,
                 :mc_price_usd, :mc_std_usd, :mc_supplier, :mc_plant, :mc_best_mpn, :mc_internal_pn, :mc_last_po_date)
            ON CONFLICT(internal_pn) DO UPDATE SET
                mpn=excluded.mpn, window_days=excluded.window_days,
                computed_at=excluded.computed_at, valid_date=excluded.valid_date,
                origin=excluded.origin, status=excluded.status, error_detail=excluded.error_detail,
                mpn_price_usd=excluded.mpn_price_usd, mpn_std_usd=excluded.mpn_std_usd,
                mpn_supplier=excluded.mpn_supplier, mpn_plant=excluded.mpn_plant,
                mpn_best_mpn=excluded.mpn_best_mpn, mpn_last_po_date=excluded.mpn_last_po_date,
                mc_price_usd=excluded.mc_price_usd, mc_std_usd=excluded.mc_std_usd,
                mc_supplier=excluded.mc_supplier, mc_plant=excluded.mc_plant,
                mc_best_mpn=excluded.mc_best_mpn, mc_internal_pn=excluded.mc_internal_pn,
                mc_last_po_date=excluded.mc_last_po_date
            """,
            {
                "internal_pn": ip,
                "mpn": (entry.get("mpn") or "").strip().upper() or None,
                "window_days": entry.get("window_days"),
                "computed_at": entry.get("computed_at") or datetime.now().isoformat(),
                "valid_date": entry.get("valid_date") or _today(),
                "origin": entry.get("origin") or "job",
                "status": status,
                "error_detail": entry.get("error_detail"),
                "mpn_price_usd": entry.get("mpn_price_usd"),
                "mpn_std_usd": entry.get("mpn_std_usd"),
                "mpn_supplier": entry.get("mpn_supplier"),
                "mpn_plant": entry.get("mpn_plant"),
                "mpn_best_mpn": entry.get("mpn_best_mpn"),
                "mpn_last_po_date": entry.get("mpn_last_po_date"),
                "mc_price_usd": entry.get("mc_price_usd"),
                "mc_std_usd": entry.get("mc_std_usd"),
                "mc_supplier": entry.get("mc_supplier"),
                "mc_plant": entry.get("mc_plant"),
                "mc_best_mpn": entry.get("mc_best_mpn"),
                "mc_internal_pn": entry.get("mc_internal_pn"),
                "mc_last_po_date": entry.get("mc_last_po_date"),
            },
        )


def get_deep_many(internal_pns: Iterable[str]) -> dict[str, dict]:
    """Return {INTERNAL_PN_UPPER: deep entry} for the cached internal PNs."""
    keys = list({(p or "").strip().upper() for p in internal_pns if p})
    if not keys:
        return {}
    out: dict[str, dict] = {}
    with _cursor() as cur:
        for i in range(0, len(keys), 400):
            chunk = keys[i : i + 400]
            placeholders = ",".join("?" * len(chunk))
            cur.execute(
                f"SELECT * FROM mpn_deep WHERE internal_pn IN ({placeholders})",
                tuple(chunk),
            )
            for row in cur.fetchall():
                out[row["internal_pn"]] = dict(row)
    return out


def count_deep() -> int:
    with _cursor() as cur:
        cur.execute("SELECT COUNT(*) AS c FROM mpn_deep")
        return int(cur.fetchone()["c"])


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
