"""
backend/batch_job.py — daily massive MPN pre-compute job (SAP only).

Reads the latest .xlsx in DBQUERY_DIR, filters rows whose "Total EAU" is 0/empty,
takes the unique MPNs from "Manufacturer Part No." and, for each one, computes the
best SAP supplier price two ways (direct MPN search and via its Internal Part Number /
Multi-Component) then stores the cheaper of the two in the SQLite cache.

Designed to run in a background thread; live progress is exposed via `get_state()`.
No Nexar / Lytica calls are made here.
"""

from __future__ import annotations

import glob
import logging
import os
import threading
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime

import pandas as pd
import requests

import mpn_store as store
import db_registry
from config import (
    PRICECALC_API_URL, DBQUERY_DIR, LOGS_DIR, MPN_DB_PATH,
    DBQUERY_MPN_COL, DBQUERY_EAU_COL, DBJOB_WINDOW_DAYS, DBJOB_MAX_WORKERS,
)
from mpn_store import compute_best_row, resolve_last_po_price, _f

logger = logging.getLogger(__name__)

# ── Live job state (thread-safe) ──────────────────────────────────────────────
_STATE_LOCK = threading.Lock()
_CANCEL = threading.Event()
_STATE: dict = {
    "running": False,
    "run_id": None,
    "trigger": None,
    "total": 0,
    "processed": 0,
    "success": 0,
    "errors": 0,
    "conn_errors": 0,
    "started_at": None,
    "finished_at": None,
    "status": "idle",          # idle | running | done | failed | cancelled
    "source_file": None,
    "message": "",
    "build_file": None,        # set when a Force full re-run built a new DB
}


def get_state() -> dict:
    with _STATE_LOCK:
        return dict(_STATE)


def _set_state(**kwargs) -> None:
    with _STATE_LOCK:
        _STATE.update(kwargs)


def is_running() -> bool:
    with _STATE_LOCK:
        return _STATE["running"]


def request_cancel() -> None:
    _CANCEL.set()


# ── Upstream HTTP (direct; classifies connection errors for retry) ────────────

class _ConnectionFail(Exception):
    """Marks a connection/timeout error so the MPN can be retried later."""


# Signatures of transient "remote forcibly closed the connection" resets.
_TRANSIENT_CONN_SIGNS = (
    "connection aborted", "connection reset", "forcibly closed",
    "remote end closed", "connectionreseterror", "10054", "broken pipe",
    "error consultando nexar",
)


def _is_transient(text: str) -> bool:
    t = (text or "").lower()
    return any(s in t for s in _TRANSIENT_CONN_SIGNS)


def _build_session() -> requests.Session:
    from requests.adapters import HTTPAdapter
    try:
        from urllib3.util.retry import Retry
    except ImportError:  # pragma: no cover
        from requests.packages.urllib3.util.retry import Retry  # type: ignore
    retry = Retry(
        total=3, connect=3, read=3, backoff_factor=0.4,
        status_forcelist=(502, 503, 504),
        allowed_methods=frozenset(["GET", "POST"]),
        raise_on_status=False,
    )
    adapter = HTTPAdapter(max_retries=retry, pool_connections=DBJOB_MAX_WORKERS + 4,
                          pool_maxsize=DBJOB_MAX_WORKERS + 4)
    sess = requests.Session()
    sess.mount("http://", adapter)
    sess.mount("https://", adapter)
    return sess


_SESSION = _build_session()


def _post(path: str, body: dict, timeout: int = 60, max_attempts: int = 3) -> dict:
    """POST with transparent retry on stale-socket connection resets."""
    import time as _time
    last: Exception | None = None
    for attempt in range(1, max_attempts + 1):
        try:
            r = _SESSION.post(f"{PRICECALC_API_URL}{path}", json=body, timeout=timeout)
            r.raise_for_status()
            return r.json()
        except (requests.exceptions.ConnectionError,
                requests.exceptions.Timeout,
                requests.exceptions.ChunkedEncodingError) as e:
            last = e
            if attempt < max_attempts and _is_transient(str(e)):
                _time.sleep(0.4 * attempt)
                continue
            raise _ConnectionFail(str(e)) from e
        except requests.exceptions.HTTPError as e:
            status = e.response.status_code if e.response is not None else 0
            detail = ""
            try:
                detail = e.response.json().get("detail", "") if e.response is not None else ""
            except Exception:
                pass
            # 5xx from the upstream proxy is usually a transient backend/SAP/Nexar issue
            if status in (502, 503, 504) or _is_transient(detail):
                if attempt < max_attempts:
                    _time.sleep(0.4 * attempt)
                    continue
                raise _ConnectionFail(f"HTTP {status}: {detail or e}") from e
            raise
    raise _ConnectionFail(f"Connection failed after {max_attempts} attempts: {last}")


# ── Core per-MPN computation (reused by realtime fallback) ────────────────────

def process_mpn(mpn: str, window_days: int = DBJOB_WINDOW_DAYS) -> dict:
    """
    Compute the best SAP price for a single MPN.
    Returns an entry dict ready for store.upsert_best(). Raises _ConnectionFail /
    other exceptions on failure (caller decides how to record them).
    """
    mpn = (mpn or "").strip().upper()
    window_ms = window_days * 86_400_000

    # 1 — Direct MPN search (Multi-MPN style)
    iq = _post("/internal-query", {"mpns": [mpn]})
    rows = iq.get("data") or []
    best_mpn_row = compute_best_row(rows, window_ms)

    # 2 — Resolve Internal PN and run Multi-Component search
    internal_pn = (best_mpn_row or {}).get("internalPN") if best_mpn_row else None
    if not internal_pn:
        for r in rows:
            if r.get("internalPN"):
                internal_pn = r["internalPN"]
                break

    ampl_data: dict | None = None
    mc_rows: list = []
    best_internal_row = None
    if internal_pn:
        ampl = _post("/ampl-by-material", {"internal_part_number": internal_pn})
        ampl_data = ampl
        query_mpns = ampl.get("mpns_list") or []
        if not query_mpns:
            query_mpns = list({
                i.get("MfgPartNumber")
                for i in (ampl.get("blocked") or []) + (ampl.get("deleted") or [])
                if i.get("MfgPartNumber")
            })
        if query_mpns:
            iq2 = _post("/internal-query", {"mpns": query_mpns})
            mc_rows = iq2.get("data") or []
            best_internal_row = compute_best_row(mc_rows, window_ms)

    # 3 — Compare and pick the cheaper source
    p_mpn = resolve_last_po_price(best_mpn_row) if best_mpn_row else None
    p_int = resolve_last_po_price(best_internal_row) if best_internal_row else None

    candidates = []
    if p_mpn is not None:
        candidates.append(("MPN", p_mpn, best_mpn_row))
    if p_int is not None:
        candidates.append(("Internal", p_int, best_internal_row))

    if candidates:
        candidates.sort(key=lambda c: c[1])
        chosen_src, chosen_price, chosen_row = candidates[0]
    else:
        # No usable price — keep whichever row exists (price stays None)
        if best_mpn_row is not None:
            chosen_src, chosen_price, chosen_row = "MPN", None, best_mpn_row
        elif best_internal_row is not None:
            chosen_src, chosen_price, chosen_row = "Internal", None, best_internal_row
        else:
            chosen_src, chosen_price, chosen_row = "None", None, None

    now = datetime.now().isoformat()
    # ── Deep-analysis side: keep the BEST Multi-MPN and BEST Multi-Component
    #    rows SEPARATELY so a Deep Analysis can be served instantly from cache. ──
    deep = {
        "internal_pn": internal_pn,
        "mpn": mpn,
        "window_days": window_days,
        "computed_at": now,
        "origin": "job",
        "status": "ok" if (p_mpn is not None or p_int is not None) else "no_price",
        # Best Multi-MPN side
        "mpn_price_usd":    p_mpn,
        "mpn_std_usd":      _f(best_mpn_row.get("standardPriceUsd")) if best_mpn_row else None,
        "mpn_supplier":     (best_mpn_row.get("supplierName") or best_mpn_row.get("englishName")) if best_mpn_row else None,
        "mpn_plant":        best_mpn_row.get("siteName") if best_mpn_row else None,
        "mpn_best_mpn":     best_mpn_row.get("mpn") if best_mpn_row else None,
        "mpn_last_po_date": best_mpn_row.get("lastPoDate") if best_mpn_row else None,
        # Best Multi-Component (Internal PN / AMPL) side
        "mc_price_usd":     p_int,
        "mc_std_usd":       _f(best_internal_row.get("standardPriceUsd")) if best_internal_row else None,
        "mc_supplier":      (best_internal_row.get("supplierName") or best_internal_row.get("englishName")) if best_internal_row else None,
        "mc_plant":         best_internal_row.get("siteName") if best_internal_row else None,
        "mc_best_mpn":      best_internal_row.get("mpn") if best_internal_row else None,
        "mc_internal_pn":   best_internal_row.get("internalPN") if best_internal_row else internal_pn,
        "mc_last_po_date":  best_internal_row.get("lastPoDate") if best_internal_row else None,
    }
    return {
        "mpn": mpn,
        "internal_pn": internal_pn,
        "best_source": chosen_src,
        "best_price_usd": chosen_price,
        "std_price_usd": _f(chosen_row.get("standardPriceUsd")) if chosen_row else None,
        "best_supplier": (chosen_row.get("supplierName") or chosen_row.get("englishName")) if chosen_row else None,
        "best_plant": chosen_row.get("siteName") if chosen_row else None,
        "best_mpn": chosen_row.get("mpn") if chosen_row else None,
        "last_po_date": chosen_row.get("lastPoDate") if chosen_row else None,
        "window_days": window_days,
        "computed_at": now,
        "origin": "job",
        # 'ok' when a usable price was found, otherwise 'no_price' (SAP had no
        # usable price). Connection/other failures are recorded separately via
        # store.mark_error() by the caller.
        "status": "ok" if chosen_price is not None else "no_price",
        # Full payload so the Multi-MPN / AMPL tabs (All Records, Blocked/Deleted,
        # Multi-Component) can be reconstructed instantly from the cache.
        "payload": {
            "raw_rows": rows,
            "ampl": ampl_data,
            "mc_rows": mc_rows,
        },
        # Structured per-Internal-PN deep-analysis row (separate MPN + MC bests).
        "deep": deep,
    }


# ── Source-file reading ───────────────────────────────────────────────────────

def find_latest_source_file() -> str | None:
    """Return the most recently modified .xlsx in DBQUERY_DIR, or None."""
    if not os.path.isdir(DBQUERY_DIR):
        return None
    files = [
        f for f in glob.glob(os.path.join(DBQUERY_DIR, "*.xls*"))
        if not os.path.basename(f).startswith("~$")
    ]
    if not files:
        return None
    return max(files, key=os.path.getmtime)


def read_mpns_from_file(path: str) -> list[str]:
    """Read the source file, drop Total EAU == 0/empty rows, return unique MPNs."""
    df = pd.read_excel(path, engine="openpyxl")

    if DBQUERY_MPN_COL not in df.columns:
        raise ValueError(
            f'Column "{DBQUERY_MPN_COL}" not found in {os.path.basename(path)}. '
            f"Available columns: {list(df.columns)[:30]}"
        )

    # Filter out rows whose Total EAU is 0, empty, or non-numeric
    if DBQUERY_EAU_COL in df.columns:
        eau = pd.to_numeric(df[DBQUERY_EAU_COL], errors="coerce").fillna(0)
        df = df[eau != 0]

    mpns = (
        df[DBQUERY_MPN_COL]
        .astype(str)
        .str.strip()
        .str.upper()
    )
    mpns = mpns[(mpns != "") & (mpns != "NAN")]
    # Unique, preserving order
    seen: set[str] = set()
    unique: list[str] = []
    for m in mpns:
        if m not in seen:
            seen.add(m)
            unique.append(m)
    return unique


# ── Logging helper ────────────────────────────────────────────────────────────

def _write_log(run_id: int, source_file: str | None, summary: dict, errors: list[dict]) -> str:
    os.makedirs(LOGS_DIR, exist_ok=True)
    stamp = datetime.now().strftime("%Y%m%d_%H%M%S")
    path = os.path.join(LOGS_DIR, f"dbjob_{stamp}_run{run_id}.log")
    lines = [
        "=" * 70,
        f"PPV DB Pre-Compute Job — run #{run_id}",
        f"Finished:    {datetime.now().isoformat()}",
        f"Source file: {source_file or '(none)'}",
        f"Trigger:     {summary.get('trigger')}",
        "=" * 70,
        f"Total MPNs:        {summary.get('total', 0)}",
        f"Succeeded:         {summary.get('success', 0)}",
        f"Errors (total):    {summary.get('errors', 0)}",
        f"  · connection:    {summary.get('conn_errors', 0)}",
        f"  · other:         {summary.get('errors', 0) - summary.get('conn_errors', 0)}",
        f"Status:            {summary.get('status')}",
        "=" * 70,
    ]
    if errors:
        lines.append("ERRORS:")
        for e in errors:
            lines.append(f"  [{e['error_type']:>10}] {e['mpn']:<32} {e['message']}")
    else:
        lines.append("No errors — all MPNs processed successfully. ✅")
    lines.append("")
    with open(path, "w", encoding="utf-8") as fh:
        fh.write("\n".join(lines))
    return path


# ── Job runner ────────────────────────────────────────────────────────────────

def _run(trigger: str, mpns: list[str] | None, window_days: int, skip_cached: bool = True) -> None:
    _CANCEL.clear()
    store.init_db()

    source_file = None
    from_file = mpns is None
    if mpns is None:
        source_file = find_latest_source_file()
        if not source_file:
            _set_state(running=False, status="failed",
                       message=f"No .xlsx file found in {DBQUERY_DIR}")
            return
        try:
            mpns = read_mpns_from_file(source_file)
        except Exception as e:
            _set_state(running=False, status="failed", message=str(e))
            return

    # ── Force full re-run: build into a NEW versioned DB so the active cache is
    #    never wiped. Users keep hitting the old DB while this runs in the
    #    background; an admin switches to the new DB when ready. ──
    is_force = from_file and not skip_cached
    build_file = None
    build_path = None
    if is_force:
        build_file = db_registry.new_version_file()
        build_path = db_registry.abspath(build_file)
        # Register up front (inactive) so it shows up in the admin DB list as
        # "building". It only becomes active when the admin switches to it.
        db_registry.register_database(
            build_file, label=f"rebuild {datetime.now():%Y-%m-%d %H:%M}"
        )

    # Resume support: when running from the source file, skip MPNs already cached
    # so a re-run only processes the pending ones (no restart from 0).
    skipped = 0
    file_total = len(mpns)
    if skip_cached and from_file:
        cached = store.cached_mpns()
        if cached:
            pending = [m for m in mpns if m not in cached]
            skipped = len(mpns) - len(pending)
            mpns = pending

    if from_file and not mpns:
        _set_state(running=False, status="done",
                   total=file_total, processed=0, success=0, errors=0, conn_errors=0,
                   started_at=datetime.now().isoformat(),
                   finished_at=datetime.now().isoformat(),
                   source_file=os.path.basename(source_file) if source_file else None,
                   message=f"All {file_total} MPNs already cached — nothing to do.")
        return

    total = len(mpns)

    # For a Force full re-run, redirect ALL store writes (run history, prices,
    # deep rows, meta) into the fresh versioned DB. The active DB is untouched.
    if build_path:
        store.set_build_target(build_path)
        _set_state(message=f"Building new database {build_file} (active DB stays live)…")

    run_id = store.create_run(trigger, total, os.path.basename(source_file) if source_file else None)

    _set_state(running=True, run_id=run_id, trigger=trigger, total=total,
               processed=0, success=0, errors=0, conn_errors=0,
               started_at=datetime.now().isoformat(), finished_at=None,
               status="running", source_file=os.path.basename(source_file) if source_file else None,
               message=(f"Resuming — {skipped} already cached, {total} pending." if skipped else ""))

    processed = success = errors = conn_errors = 0
    error_records: list[dict] = []

    def _handle_result(mpn: str, entry: dict | None, exc: Exception | None):
        nonlocal processed, success, errors, conn_errors
        if exc is None and entry is not None:
            try:
                store.upsert_best(entry)
                # Persist the separate Multi-MPN / Multi-Component bests for Deep
                # Analysis (no-op when there's no internal_pn).
                deep = entry.get("deep")
                if deep:
                    try:
                        store.upsert_deep(deep)
                    except Exception:  # never let deep-cache bookkeeping break the job
                        pass
                success += 1
            except Exception as db_exc:  # storing failed → treat as 'other' error
                errors += 1
                rec = {"mpn": mpn, "internal_pn": None, "error_type": "other",
                       "message": f"DB store failed: {db_exc}"}
                error_records.append(rec)
                store.add_error(run_id, mpn, None, "other", rec["message"])
        else:
            etype = "connection" if isinstance(exc, _ConnectionFail) else "other"
            msg = str(exc) if exc else "unknown error"
            errors += 1
            if etype == "connection":
                conn_errors += 1
            rec = {"mpn": mpn, "internal_pn": None, "error_type": etype, "message": msg}
            error_records.append(rec)
            store.add_error(run_id, mpn, None, etype, msg)
            # Also document the failure in the persistent cache so it can be
            # found and re-queried later from the admin search (without losing a
            # previously-good price).
            try:
                store.mark_error(mpn, msg)
            except Exception:  # never let bookkeeping break the job
                pass
        processed += 1
        if processed % 25 == 0 or processed == total:
            store.update_run_progress(run_id, processed, success, errors, conn_errors)
            _set_state(processed=processed, success=success, errors=errors, conn_errors=conn_errors)

    try:
        with ThreadPoolExecutor(max_workers=DBJOB_MAX_WORKERS) as pool:
            futures = {pool.submit(process_mpn, m, window_days): m for m in mpns}
            for fut in as_completed(futures):
                if _CANCEL.is_set():
                    break
                mpn = futures[fut]
                try:
                    entry = fut.result()
                    _handle_result(mpn, entry, None)
                except Exception as e:  # noqa: BLE001 — classified in handler
                    _handle_result(mpn, None, e)
    except Exception as e:  # catastrophic
        _set_state(message=f"Fatal: {e}")

    status = "cancelled" if _CANCEL.is_set() else "done"
    summary = {
        "trigger": trigger, "total": total, "success": success,
        "errors": errors, "conn_errors": conn_errors, "status": status,
    }
    log_path = _write_log(run_id, source_file, summary, error_records)

    store.update_run_progress(run_id, processed, success, errors, conn_errors)
    store.finish_run(run_id, status, log_path)
    if status == "done":
        store.set_meta("last_run_at", datetime.now().isoformat())
    store.set_meta("last_run_id", str(run_id))

    # Stop redirecting writes to the build DB (back to the active one).
    if build_path:
        store.clear_build_target()

    build_msg = ""
    if build_file:
        build_msg = (f" New database '{build_file}' is ready — switch to it from the "
                     f"admin DB-version panel when you want it live.")

    _set_state(running=False, status=status, finished_at=datetime.now().isoformat(),
               processed=processed, success=success, errors=errors, conn_errors=conn_errors,
               build_file=build_file,
               message=(get_state().get("message", "") + build_msg).strip() or None)


def start_job(trigger: str = "manual", mpns: list[str] | None = None,
              window_days: int = DBJOB_WINDOW_DAYS, skip_cached: bool = True) -> dict:
    """Launch the job in a background thread. Returns the initial state."""
    if is_running():
        return {"started": False, "reason": "A job is already running.", **get_state()}
    _set_state(running=True, status="running", message="Starting…")
    t = threading.Thread(target=_run, args=(trigger, mpns, window_days, skip_cached), daemon=True)
    t.start()
    return {"started": True, **get_state()}
