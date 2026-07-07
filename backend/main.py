"""
backend/main.py — FastAPI application.
Serves as the proxy between the React frontend and SAP API.
"""
import asyncio
import calendar
import json as _json
import logging
import os
import time
import uuid
import requests
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime, timedelta
from requests_ntlm import HttpNtlmAuth
from typing import Any

from fastapi import FastAPI, HTTPException, BackgroundTasks, Header
from fastapi.middleware.cors import CORSMiddleware
from fastapi.encoders import jsonable_encoder
from fastapi.responses import StreamingResponse
from pydantic import BaseModel

import pandas as pd

from config import SAP_API_URL, COL_PPV, COL_PRICE, COL_FX, ALLOWED_ORIGINS, AZ_INF_ENDPOINT, AZ_INF_API_KEY, AZ_INF_API_VER, AZ_INF_MODEL, PRICECALC_API_URL, NEXAR_RESULT_LIMIT
from config import ADMIN_USERNAME, ADMIN_PASSWORD, DBJOB_SCHEDULE_HOUR, DBJOB_WINDOW_DAYS, MPN_RESOLVE_MAX_WORKERS
from data_service import parse_df, extract_records, get_filter_options, apply_filters, enrich_with_currency, get_currency_rate
from analytics import compute_all_analytics, compute_forecast, search_material, compute_mg_plant_components
import cache
import mpn_store
import batch_job
import db_registry
import demand_store
from sourcing import router as sourcing_router

app = FastAPI(title="PPV API", version="2.0.0")

app.add_middleware(
    CORSMiddleware,
    allow_origins=ALLOWED_ORIGINS,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(sourcing_router)


@app.on_event("startup")
def _init_mpn_store() -> None:
    """Initialise the SQLite best-price cache.

    The cache is persistent and never auto-expires; it is only cleared when an
    authenticated admin runs a full re-run from scratch.
    """
    try:
        mpn_store.init_db()
    except Exception as exc:  # never block startup
        import logging
        logging.getLogger(__name__).warning("MPN store init failed: %s", exc)

# ── Session store (in-memory fallback; Redis is primary when available) ────────
_sessions: dict[str, pd.DataFrame] = {}
_session_params: dict[str, dict]   = {}


def _get_session(session_id: str) -> tuple[pd.DataFrame, dict]:
    """Return (DataFrame, params). Checks Redis first, then in-memory fallback."""
    data = cache.get_pickle(cache.make_key("ses", session_id))
    if data is not None:
        df, params = data["df"], data["params"]
    elif session_id in _sessions:
        df, params = _sessions[session_id], _session_params[session_id]
    else:
        raise HTTPException(status_code=404, detail="Session expired — please run a new query.")

    # Patch sessions that predate the currency-enrichment step (v7+).
    # Old pickles have P_Price_difference_num but no PPDifference_currency.
    if "PPDifference_currency" not in df.columns:
        df = df.copy()
        df["PPDifference_currency"] = (
            df["P_Price_difference_num"] if "P_Price_difference_num" in df.columns else 0.0
        )

    return df, params


def _save_session(sid: str, df: pd.DataFrame, params: dict) -> None:
    """Persist session to Redis and in-memory fallback simultaneously."""
    _sessions[sid] = df
    _session_params[sid] = params
    cache.set_pickle(cache.make_key("ses", sid), {"df": df, "params": params}, cache.TTL_SESSION)


# ── Request/Response models ───────────────────────────────────────────────────

class QueryRequest(BaseModel):
    plants:     list[str]      # one or more plant codes, e.g. ["0020", "0040"]
    start_date: str  # YYYYMMDD
    end_date:   str  # YYYYMMDD


class AnalyticsRequest(BaseModel):
    session_id: str
    filters: dict = {}


class ForecastRequest(BaseModel):
    session_id:   str
    filters:      dict = {}
    scale_method: str  = "StandardScaler"


class SearchRequest(BaseModel):
    session_id: str
    query:      str


class ChatMessage(BaseModel):
    role:    str
    content: str

class ChatRequest(BaseModel):
    messages:   list[ChatMessage]
    context:    dict = {}
    session_id: str | None = None
    filters:    dict = {}


# ── Chat data context helper ──────────────────────────────────────────────────

_CHAT_COL_MAP: dict[str, str] = {
    "Plant":                          "Plant",
    "Posting_Date":                   "Date",
    "Material_Number":                "Material#",
    "Material_Description":           "Description",
    "Vendor_Name":                    "Vendor",
    "Vendor_Code":                    "VendorCode",
    "Material_Group_Description":     "MatGroup",
    "Product_Hierarchy":              "Hierarchy",
    "Quantity":                       "Qty",
    "PO_Price_per_1000_num":          "POPrice/1k",
    "Standard_Price_for_1000_num":    "StdPrice/1k",
    "MExtended_PO_Price_num":         "POAmount",
    "M_Extended__Std_Amount_num":     "StdAmount",
    "PPDifference_currency":          "PPV(USD)",
    "Total_Variance_Amount_num":      "TotalVarLocal",
    "P_Price_difference_num":         "PriceDiffLocal",
    "Exchange_rate_difference_num":   "FXDiff",
    "YearMonth":                      "YearMonth",
    "Purchase_Order":                 "PO",
}

_MAX_RAW_ROWS = 500  # below this threshold, send complete raw CSV; above, use smart aggregation


def _fmt_c(v) -> str:
    """Format a value as compact USD string for AI context."""
    try:
        return f"${float(v):,.2f}"
    except Exception:
        return str(v)


def _build_data_context(session_id: str, filters: dict) -> str:
    """Build a rich analytics context for the AI assistant.

    Small datasets (≤ _MAX_RAW_ROWS rows): returns complete raw CSV.
    Large datasets (> _MAX_RAW_ROWS rows): returns intelligent pre-aggregated summaries
    covering all vendors, all materials, all groups, per-plant breakdowns, monthly trends,
    and statistical KPIs — no row-count cap on aggregated dimensions.
    """
    try:
        df, params = _get_session(session_id)
    except HTTPException:
        return "(Session not found or expired.)"

    dff = apply_filters(df, filters)
    if dff.empty:
        return "(No records after applying filters.)"

    plants_list = params.get("Plants") or [params.get("Plant", "")]
    plants_str  = ", ".join(sorted(str(p) for p in plants_list))
    total_rows  = len(dff)
    header = (
        f"QUERY: Plants={plants_str} | "
        f"Period={params.get('PostingStartDate','')}–{params.get('PostingEndDate','')} | "
        f"Total records={total_rows}"
    )

    # ── Small dataset: return complete raw data ──────────────────────────────
    if total_rows <= _MAX_RAW_ROWS:
        cols = {orig: alias for orig, alias in _CHAT_COL_MAP.items() if orig in dff.columns}
        sub  = dff[list(cols.keys())].copy()
        sub.rename(columns=cols, inplace=True)
        if "Date" in sub.columns:
            sub["Date"] = sub["Date"].astype(str).str[:10]
        return f"{header}\n\nCOMPLETE RAW DATA:\n{sub.to_csv(index=False)}"

    # ── Large dataset: intelligent pre-aggregated summaries ──────────────────
    ppv = COL_PPV
    lines: list[str] = [header, ""]

    # KPIs
    s          = dff[ppv] if ppv in dff.columns else pd.Series([], dtype=float)
    total_ppv  = float(s.sum())
    fav_ppv    = float(s[s <= 0].sum())
    unfav_ppv  = float(s[s > 0].sum())
    n_vendors  = dff["Vendor_Name"].nunique() if "Vendor_Name" in dff.columns else "N/A"
    n_mats     = dff["Material_Number"].nunique() if "Material_Number" in dff.columns else "N/A"
    lines += [
        "=== KPIs ===",
        f"Total PPV: {_fmt_c(total_ppv)}",
        f"Favorable: {_fmt_c(fav_ppv)} | Unfavorable: {_fmt_c(unfav_ppv)}",
        f"Records: {total_rows} | Unique Vendors: {n_vendors} | Unique Materials: {n_mats}",
        "",
    ]

    # Per-plant breakdown (only when multi-plant)
    if "Plant" in dff.columns and dff["Plant"].nunique() > 1 and ppv in dff.columns:
        pg = (
            dff.groupby("Plant")[ppv]
            .agg(total="sum", records="count")
            .reset_index()
            .sort_values("total", key=abs, ascending=False)
        )
        lines.append("=== PER-PLANT BREAKDOWN ===")
        lines.append("Plant | Total PPV | Records")
        for _, row in pg.iterrows():
            lines.append(f"{row['Plant']} | {_fmt_c(row['total'])} | {int(row['records'])}")
        lines.append("")

    # Monthly trend (all months)
    if "YearMonth" in dff.columns and ppv in dff.columns:
        trend = (
            dff[dff["YearMonth"] != ""]
            .groupby("YearMonth")[ppv].sum()
            .reset_index().sort_values("YearMonth")
        )
        if len(trend):
            lines.append("=== MONTHLY TREND ===")
            lines.append("Month | PPV | Cumulative")
            cum = 0.0
            for _, row in trend.iterrows():
                cum += float(row[ppv])
                lines.append(f"{row['YearMonth']} | {_fmt_c(row[ppv])} | {_fmt_c(cum)}")
            lines.append("")

    # All vendors ranked by |PPV|
    if "Vendor_Name" in dff.columns and ppv in dff.columns:
        vg = (
            dff.groupby("Vendor_Name")[ppv]
            .agg(total="sum", records="count")
            .reset_index()
            .sort_values("total", key=abs, ascending=False)
        )
        plant_map_v: dict = {}
        if "Plant" in dff.columns:
            plant_map_v = (
                dff.groupby("Vendor_Name")["Plant"]
                .apply(lambda x: ",".join(sorted(set(x.dropna().astype(str)))))
                .to_dict()
            )
        lines.append(f"=== ALL VENDORS ({len(vg)}) ranked by |PPV| ===")
        lines.append("Vendor | Total PPV | Records | Plants")
        for _, row in vg.iterrows():
            vname = row["Vendor_Name"]
            lines.append(
                f"{vname} | {_fmt_c(row['total'])} | {int(row['records'])} | {plant_map_v.get(vname, '')}"
            )
        lines.append("")

    # All material groups ranked by |PPV|
    if "Material_Group_Description" in dff.columns and ppv in dff.columns:
        mgg = (
            dff.groupby("Material_Group_Description")[ppv]
            .agg(total="sum", records="count")
            .reset_index()
            .sort_values("total", key=abs, ascending=False)
        )
        lines.append(f"=== ALL MATERIAL GROUPS ({len(mgg)}) ranked by |PPV| ===")
        lines.append("Group | Total PPV | Records")
        for _, row in mgg.iterrows():
            lines.append(f"{row['Material_Group_Description']} | {_fmt_c(row['total'])} | {int(row['records'])}")
        lines.append("")

    # Top 200 materials by |PPV|
    if "Material_Number" in dff.columns and ppv in dff.columns:
        desc_col = "Material_Description" if "Material_Description" in dff.columns else None
        grp_cols = ["Material_Number"] + ([desc_col] if desc_col else [])
        mg = (
            dff.groupby(grp_cols)[ppv]
            .agg(total="sum", records="count")
            .reset_index()
            .sort_values("total", key=abs, ascending=False)
            .head(200)
        )
        plant_map_m: dict = {}
        if "Plant" in dff.columns:
            plant_map_m = (
                dff.groupby("Material_Number")["Plant"]
                .apply(lambda x: ",".join(sorted(set(x.dropna().astype(str)))))
                .to_dict()
            )
        lines.append(f"=== TOP 200 MATERIALS BY |PPV| ===")
        lines.append("Material# | Description | Total PPV | Records | Plants")
        for _, row in mg.iterrows():
            desc = row.get(desc_col, row["Material_Number"]) if desc_col else row["Material_Number"]
            mnum = row["Material_Number"]
            lines.append(
                f"{mnum} | {desc} | {_fmt_c(row['total'])} | {int(row['records'])} | {plant_map_m.get(mnum, '')}"
            )
        lines.append("")

    return "\n".join(lines)

class VendorMonthRequest(BaseModel):
    session_id: str
    vendor:     str
    yearmonth:  str

class TrendDetailRequest(BaseModel):
    session_id:  str
    filters:     dict = {}
    label:       str   # the exact label string from TrendData.labels
    granularity: str   # 'daily' or 'monthly'

class HierarchyDrillRequest(BaseModel):
    session_id:     str
    filters:        dict = {}
    hierarchy_code: str
    year_month:     str
    top_n:          int = 15

# ── Price Calculator models (proxy to conexion_internalquery backend) ─────────

class PriceCalcAmplRequest(BaseModel):
    internal_part_number: str

class PriceCalcIQRequest(BaseModel):
    mpns: list[str]

class PriceCalcMarketRequest(BaseModel):
    mpns:     list[str]
    quantity: int
    # Max offers/results to request from Nexar per MPN. Caps the upstream
    # GraphQL `limit` to save API requests. None → use the server default.
    limit:    int | None = None


# ── Routes ────────────────────────────────────────────────────────────────────

# ── Helpers for range-aware SAP caching ──────────────────────────────────────

def _add_days(d: str, n: int) -> str:
    """Shift a YYYYMMDD string by n calendar days."""
    return (datetime.strptime(d, "%Y%m%d") + timedelta(days=n)).strftime("%Y%m%d")


def _filter_df_by_dates(df: pd.DataFrame, start: str, end: str) -> pd.DataFrame:
    """Return rows where Posting_Date ∈ [start, end] (YYYYMMDD strings)."""
    if "Posting_Date" not in df.columns or df.empty:
        return df
    ts_s = pd.Timestamp(f"{start[:4]}-{start[4:6]}-{start[6:8]}")
    ts_e = pd.Timestamp(f"{end[:4]}-{end[4:6]}-{end[6:8]}")
    mask = (df["Posting_Date"] >= ts_s) & (df["Posting_Date"] <= ts_e)
    return df[mask].reset_index(drop=True)


def _fetch_sap(plant: str, start: str, end: str) -> list:
    """Call SAP API for [start, end]; raise HTTPException on failure."""
    payload = {"Plant": plant, "PostingStartDate": start, "PostingEndDate": end}
    try:
        auth = HttpNtlmAuth("", "")
        resp = requests.post(SAP_API_URL, json=payload, auth=auth, timeout=300)
        resp.raise_for_status()
        raw = resp.json()
    except requests.exceptions.ConnectionError:
        raise HTTPException(status_code=503, detail="Cannot connect to SAP server. Verify VPN/network.")
    except requests.exceptions.Timeout:
        raise HTTPException(status_code=504, detail="SAP API timed out (300 s). The server may be overloaded.")
    except requests.exceptions.HTTPError as exc:
        code = exc.response.status_code
        if code == 401:
            raise HTTPException(status_code=401, detail="SAP authentication failed (HTTP 401). Check Windows credentials.")
        raise HTTPException(status_code=code, detail=f"SAP HTTP error {code}: {exc.response.text[:200]}")
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"Unexpected SAP error: {exc}")
    return extract_records(raw)


def _fetch_sap_with_session(s: requests.Session, plant: str, start: str, end: str) -> list:
    """Same as _fetch_sap but reuses an existing requests.Session (NTLM auth reuse)."""
    payload = {"Plant": plant, "PostingStartDate": start, "PostingEndDate": end}
    try:
        resp = s.post(SAP_API_URL, json=payload, timeout=300)
        resp.raise_for_status()
        raw = resp.json()
    except requests.exceptions.ConnectionError:
        raise HTTPException(status_code=503, detail="Cannot connect to SAP server. Verify VPN/network.")
    except requests.exceptions.Timeout:
        raise HTTPException(status_code=504, detail="SAP API timed out (300 s). The server may be overloaded.")
    except requests.exceptions.HTTPError as exc:
        code = exc.response.status_code
        if code == 401:
            raise HTTPException(status_code=401, detail="SAP authentication failed (HTTP 401). Check Windows credentials.")
        raise HTTPException(status_code=code, detail=f"SAP HTTP error {code}: {exc.response.text[:200]}")
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"Unexpected SAP error: {exc}")
    return extract_records(raw)


def _months_in_range(start: str, end: str) -> list[tuple[str, str, str]]:
    """Split [start, end] (YYYYMMDD) into monthly (start, end, label) tuples."""
    s = datetime.strptime(start, "%Y%m%d")
    e = datetime.strptime(end, "%Y%m%d")
    months: list[tuple[str, str, str]] = []
    cur = s.replace(day=1)
    while cur.year < e.year or (cur.year == e.year and cur.month <= e.month):
        last = calendar.monthrange(cur.year, cur.month)[1]
        ms = max(cur, s).strftime("%Y%m%d")
        me = min(cur.replace(day=last), e).strftime("%Y%m%d")
        label = cur.strftime("%b %Y")
        months.append((ms, me, label))
        if cur.month == 12:
            cur = cur.replace(year=cur.year + 1, month=1, day=1)
        else:
            cur = cur.replace(month=cur.month + 1, day=1)
    return months


def _sse(data: dict) -> str:
    """Format a dict as a Server-Sent Events data line."""
    return f"data: {_json.dumps(data)}\n\n"

@app.get("/api/health")
def health():
    return {"status": "ok", "redis": cache.redis_available()}


@app.post("/api/query")
async def query_sap(req: QueryRequest):
    """Stream per-month SAP fetch progress via SSE, then deliver session data.

    Supports one or more plants; data from all plants is merged into a single session.

    Events:  {phase:"fetching", progress, months_done, total_months, rows_so_far, month_label, cached}
             {phase:"done",     session_id, row_count, filter_options, params, cached}
             {phase:"error",    message}
    """
    plants     = [p.strip() for p in req.plants if p.strip()]
    start_date = req.start_date
    end_date   = req.end_date

    if not plants:
        raise HTTPException(status_code=422, detail="At least one plant is required.")

    async def event_stream():
        loop = asyncio.get_running_loop()

        all_months       = _months_in_range(start_date, end_date)
        months_per_plant = len(all_months)
        total_months_all = months_per_plant * len(plants)

        # ── Build per-plant fetch plan ──────────────────────────────────────
        plans: list[dict] = []
        total_cached_months = 0

        for plant in plants:
            master           = cache.get_master(plant)
            fetch_mode       = "full"
            delta_months     = list(all_months)
            n_cached         = 0
            existing_df      = None
            new_master_start = start_date
            new_master_end   = end_date

            if master is not None:
                m_start, m_end, m_df = master

                if m_start <= start_date and m_end >= end_date:
                    fetch_mode   = "hit"
                    n_cached     = months_per_plant
                    delta_months = []
                    existing_df  = m_df

                elif m_start <= start_date and m_end < end_date:
                    fetch_mode       = "extend_end"
                    delta_months     = _months_in_range(_add_days(m_end, 1), end_date)
                    n_cached         = months_per_plant - len(delta_months)
                    existing_df      = m_df
                    new_master_start = m_start

                elif m_start > start_date and m_end >= end_date:
                    fetch_mode     = "extend_start"
                    delta_months   = _months_in_range(start_date, _add_days(m_start, -1))
                    n_cached       = months_per_plant - len(delta_months)
                    existing_df    = m_df
                    new_master_end = m_end
                # else: partial overlap — full fetch

            plans.append({
                "plant":            plant,
                "fetch_mode":       fetch_mode,
                "delta_months":     delta_months,
                "n_cached":         n_cached,
                "existing_df":      existing_df,
                "new_master_start": new_master_start,
                "new_master_end":   new_master_end,
            })
            total_cached_months += n_cached

        # Emit initial progress for cached data
        rows_from_cache = sum(
            len(p["existing_df"]) for p in plans if p["existing_df"] is not None
        )
        if total_cached_months > 0:
            yield _sse({
                "phase": "fetching",
                "progress": int(total_cached_months / total_months_all * 100),
                "months_done": total_cached_months, "total_months": total_months_all,
                "rows_so_far": rows_from_cache,
                "month_label": f"{total_cached_months} month{'s' if total_cached_months != 1 else ''} from cache",
                "cached": True,
            })

        # ── Fetch delta months in parallel across all plants ───────────────
        # Each task gets its own requests.Session (NTLM is not thread-safe on
        # a shared session).  A semaphore caps concurrent SAP connections so
        # we don't overwhelm the server.
        plant_dfs: dict[str, pd.DataFrame] = {}
        months_done_global = total_cached_months
        rows_so_far_global = rows_from_cache
        _sem = asyncio.Semaphore(3)  # 3 concurrent SAP calls — NTLM is more stable with fewer parallel connections

        async def _fetch_one(plant: str, ms: str, me: str, label: str):
            """Fetch one (plant, month) with retry. Returns (..., records, err_detail).
            Never raises — errors are returned as err_detail string so callers can decide
            whether to abort or continue with partial data."""
            async with _sem:
                def _do() -> tuple[list | None, str | None]:
                    max_att = 4  # initial attempt + 3 retries
                    last_err: str | None = None
                    for att in range(1, max_att + 1):
                        s = requests.Session()
                        s.auth = HttpNtlmAuth("", "")
                        try:
                            recs = _fetch_sap_with_session(s, plant, ms, me)
                            return recs, None
                        except HTTPException as exc:
                            last_err = exc.detail
                            if exc.status_code in (503, 504) and att < max_att:
                                time.sleep(2 ** (att - 1))   # 1 s → 2 s → 4 s
                                continue
                            return None, exc.detail
                        except Exception as exc:
                            last_err = str(exc)
                            if att < max_att:
                                time.sleep(2 ** (att - 1))
                                continue
                            return None, last_err
                        finally:
                            s.close()
                    return None, last_err
                records, err = await loop.run_in_executor(None, _do)
            return plant, ms, me, label, records, err

        # Handle cache-hit plants immediately; build tasks for the rest
        for plan in plans:
            if plan["fetch_mode"] == "hit":
                plant_dfs[plan["plant"]] = _filter_df_by_dates(
                    plan["existing_df"], start_date, end_date
                )

        fetch_tasks = [
            asyncio.create_task(_fetch_one(plan["plant"], ms, me, label))
            for plan in plans
            if plan["fetch_mode"] != "hit"
            for ms, me, label in plan["delta_months"]
        ]

        # Accumulate raw results keyed by plant
        raw_results: dict[str, list[tuple[str, pd.DataFrame]]] = {p: [] for p in plants}
        failed_months: list[dict] = []   # {label, plant, error}
        try:
            for fut in asyncio.as_completed(fetch_tasks):
                try:
                    plant, ms, me, label, records, err_detail = await fut
                except Exception as exc:
                    # Unexpected (e.g. task cancelled) — treat as a failed month, keep going
                    failed_months.append({"label": "unknown", "plant": "?", "error": str(exc)})
                    months_done_global += 1
                    continue

                if err_detail is not None:
                    failed_months.append({"label": label, "plant": plant, "error": err_detail})
                    months_done_global += 1
                    warn_lbl = f"\u26a0 {plant} \u00b7 {label}" if len(plants) > 1 else f"\u26a0 {label}"
                    yield _sse({
                        "phase": "fetching",
                        "progress": int(months_done_global / total_months_all * 100),
                        "months_done": months_done_global, "total_months": total_months_all,
                        "rows_so_far": rows_so_far_global, "month_label": warn_lbl,
                        "cached": False, "warning": True,
                    })
                    continue

                if records:
                    month_df = parse_df(records)
                    raw_results[plant].append((ms, month_df))
                    rows_so_far_global += len(month_df)

                months_done_global += 1
                month_label = f"{plant} \u00b7 {label}" if len(plants) > 1 else label
                yield _sse({
                    "phase": "fetching",
                    "progress": int(months_done_global / total_months_all * 100),
                    "months_done": months_done_global, "total_months": total_months_all,
                    "rows_so_far": rows_so_far_global, "month_label": month_label,
                    "cached": False,
                })
        except Exception as exc:
            yield _sse({"phase": "error", "message": str(exc)})
            return

        # ── Determine overall outcome before merging ──────────────────────
        total_new_rows  = sum(len(v) for v in raw_results.values())
        has_cache_hits  = any(p["fetch_mode"] == "hit" for p in plans)
        if total_new_rows == 0 and not has_cache_hits and failed_months:
            # Total failure — surface a helpful, actionable error
            first_err = failed_months[0]["error"]
            if "Verify VPN" in first_err or "Cannot connect" in first_err:
                err_type = "connection"
                err_msg  = (
                    "Cannot connect to SAP server after multiple retries. "
                    "Please check: VPN is connected \u00b7 you are on the corporate network "
                    "\u00b7 SAP host nts5102 is reachable."
                )
            elif "timed out" in first_err.lower() or "overloaded" in first_err.lower():
                err_type = "timeout"
                err_msg  = (
                    "SAP API is not responding (timeout). "
                    "The server may be overloaded — wait a few minutes and try again."
                )
            elif "401" in first_err or "authentication" in first_err.lower():
                err_type = "auth"
                err_msg  = "SAP authentication failed. Verify your Windows credentials and try again."
            else:
                err_type = "api"
                err_msg  = f"SAP API error: {first_err}"
            yield _sse({"phase": "error", "error_type": err_type, "message": err_msg})
            return

        if failed_months:
            failed_labels = [
                f"{m['plant']} \u00b7 {m['label']}" if len(plants) > 1 else m["label"]
                for m in failed_months
            ]
            preview = ", ".join(failed_labels[:5]) + ("\u2026" if len(failed_labels) > 5 else "")
            yield _sse({
                "phase": "partial_warning",
                "failed_count":  len(failed_months),
                "failed_labels": failed_labels,
                "message": (
                    f"{len(failed_months)} month(s) could not be fetched "
                    f"({preview}) and will be absent from the analysis."
                ),
            })

        # ── Merge months chronologically and update master cache per plant ──
        for plan in plans:
            plant       = plan["plant"]
            fetch_mode  = plan["fetch_mode"]
            existing_df = plan["existing_df"]

            if fetch_mode == "hit":
                continue  # already placed in plant_dfs above

            # Restore chronological order before concat (as_completed gives any order)
            sorted_months = sorted(raw_results[plant], key=lambda x: x[0])
            new_combined = (
                pd.concat([df for _, df in sorted_months], ignore_index=True)
                if sorted_months else pd.DataFrame()
            )

            if fetch_mode == "extend_end":
                full_df = pd.concat([existing_df, new_combined], ignore_index=True) if not new_combined.empty else existing_df
                cache.set_master(plant, plan["new_master_start"], plan["new_master_end"], full_df)

            elif fetch_mode == "extend_start":
                full_df = pd.concat([new_combined, existing_df], ignore_index=True) if not new_combined.empty else existing_df
                cache.set_master(plant, plan["new_master_start"], plan["new_master_end"], full_df)

            else:  # full fetch
                if new_combined.empty:
                    plant_dfs[plant] = pd.DataFrame()
                    continue
                full_df = new_combined
                cache.set_master(plant, start_date, end_date, full_df)

            plant_dfs[plant] = _filter_df_by_dates(full_df, start_date, end_date)


        # ── Merge all plant DataFrames into one session ─────────────────────
        labeled_dfs: list[pd.DataFrame] = []
        for plant, pdf in plant_dfs.items():
            if not pdf.empty:
                pdf = pdf.copy()
                pdf["Plant"] = plant
                labeled_dfs.append(pdf)

        if not labeled_dfs:
            yield _sse({"phase": "error", "message": "SAP returned no records for the selected plants / date range."})
            return

        df     = pd.concat(labeled_dfs, ignore_index=True)
        params = {"Plants": plants, "PostingStartDate": start_date, "PostingEndDate": end_date}

        # Convert all non-USD amounts to USD using SAP M-rates
        yield _sse({"phase": "fetching", "progress": 99,
                    "month_label": "Converting currencies…", "cached": False})
        try:
            df = await loop.run_in_executor(None, lambda: enrich_with_currency(df))
        except Exception:
            # Enrichment failed — ensure PPDifference_currency still exists as fallback
            if "PPDifference_currency" not in df.columns:
                df = df.copy()
                df["PPDifference_currency"] = (
                    df["P_Price_difference_num"] if "P_Price_difference_num" in df.columns else 0.0
                )

        try:
            sid = str(uuid.uuid4())
            _save_session(sid, df, params)
            yield _sse({
                "phase": "done", "session_id": sid, "row_count": len(df),
                "filter_options": get_filter_options(df), "params": params, "cached": False,
            })
        except Exception as exc:
            import traceback
            yield _sse({"phase": "error", "message": f"Session error: {traceback.format_exc()}"})

    return StreamingResponse(
        event_stream(),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )


# Bump this whenever the analytics schema changes to auto-invalidate cached results
ANALYTICS_SCHEMA_VERSION = "8"  # All PPV computations now use PPDifference_currency (USD-converted)


def _plant_key(params: dict) -> str:
    """Return a stable, sorted string key for the plant(s) in a session's params dict."""
    plants = params.get("Plants")
    if plants:
        return ",".join(sorted(str(p) for p in plants))
    return str(params.get("Plant", ""))


@app.post("/api/analytics")
def analytics(req: AnalyticsRequest):
    """Return all pre-computed analytics for the (optionally filtered) dataset."""
    df, params = _get_session(req.session_id)

    # Check analytics cache (stable key based on query params + filters + schema version)
    ana_key = cache.make_key(
        "ana",
        ANALYTICS_SCHEMA_VERSION,
        _plant_key(params),
        params.get("PostingStartDate", ""),
        params.get("PostingEndDate", ""),
        cache.filter_hash(req.filters),
    )
    cached = cache.get_json(ana_key)
    if cached is not None:
        return cached

    dff = apply_filters(df, req.filters)
    if dff.empty:
        raise HTTPException(status_code=422, detail="No data after applying filters.")
    try:
        result = compute_all_analytics(dff, COL_PPV, COL_PRICE, COL_FX)
        serializable = jsonable_encoder(result)
        cache.set_json(ana_key, serializable, cache.TTL_ANALYTIC)
        return serializable
    except Exception as exc:
        import traceback
        raise HTTPException(status_code=500, detail=f"Analytics error: {traceback.format_exc()}")


class MGPlantComponentsRequest(BaseModel):
    session_id: str
    filters:    dict = {}
    group:      str
    plant:      str

@app.post("/api/mg-plant-components")
def mg_plant_components(req: MGPlantComponentsRequest):
    """Component breakdown for a specific material group + plant combination."""
    ck = cache.make_key("drill", "mgplant", req.session_id,
                        cache.filter_hash(req.filters), req.group, req.plant)
    hit = cache.get_json(ck)
    if hit is not None:
        return hit
    df, _ = _get_session(req.session_id)
    dff   = apply_filters(df, req.filters)
    result = jsonable_encoder(compute_mg_plant_components(dff, COL_PPV, req.group, req.plant))
    cache.set_json(ck, result, cache.TTL_DRILL)
    return result


@app.post("/api/hierarchy-drill")
def hierarchy_drill(req: HierarchyDrillRequest):
    """Top materials by PPV impact for a specific hierarchy + month."""
    ck = cache.make_key("drill", "hdrll", req.session_id,
                        cache.filter_hash(req.filters),
                        req.hierarchy_code, req.year_month, str(req.top_n))
    hit = cache.get_json(ck)
    if hit is not None:
        return hit
    df, _ = _get_session(req.session_id)
    dff = apply_filters(df, req.filters)
    PH = "Product_Hierarchy"
    if PH not in dff.columns or "YearMonth" not in dff.columns:
        return {"items": [], "hierarchy": req.hierarchy_code, "month": req.year_month}
    mask = (
        (dff[PH].astype(str) == req.hierarchy_code) &
        (dff["YearMonth"].astype(str) == req.year_month)
    )
    sub = dff[mask]
    if sub.empty:
        return {"items": [], "hierarchy": req.hierarchy_code, "month": req.year_month}
    desc_col = "Material_Description" if "Material_Description" in sub.columns else None
    grp = sub.groupby("Material_Number")[COL_PPV].sum().reset_index()
    grp = grp.reindex(grp[COL_PPV].abs().sort_values(ascending=False).index)
    grp = grp.head(req.top_n)
    desc_map: dict = {}
    if desc_col:
        desc_map = sub.groupby("Material_Number")[desc_col].first().to_dict()
    items = [
        {
            "material":    str(row["Material_Number"]),
            "description": desc_map.get(str(row["Material_Number"]), str(row["Material_Number"])),
            "ppv":         float(row[COL_PPV]),
        }
        for _, row in grp.iterrows()
    ]
    result = {"items": items, "hierarchy": req.hierarchy_code, "month": req.year_month}
    cache.set_json(ck, result, cache.TTL_DRILL)
    return result


class MaterialTrendRequest(BaseModel):
    session_id:      str
    filters:         dict = {}
    material_number: str

class VendorPriceTrendRequest(BaseModel):
    session_id:      str
    material_number: str
    filters:         dict = {}


@app.post("/api/material-trend")
def material_trend(req: MaterialTrendRequest):
    """Monthly Standard Price vs PO Price trend for a single material."""
    ck = cache.make_key("drill", "mattrend", req.session_id,
                        cache.filter_hash(req.filters), req.material_number)
    hit = cache.get_json(ck)
    if hit is not None:
        return hit
    import math
    df, _ = _get_session(req.session_id)
    dff   = apply_filters(df, req.filters)

    mask = dff["Material_Number"].astype(str) == req.material_number
    sub  = dff[mask]

    if sub.empty or "YearMonth" not in sub.columns:
        return {"material": req.material_number, "desc": "", "labels": [],
                "std_price": [], "po_price": [], "ppv": [], "records": []}

    STD_COL = "Standard_Price_for_1000_num"
    PO_COL  = "PO_Price_per_1000_num"

    agg_dict: dict = {
        "ppv":     (COL_PPV, "sum"),
        "records": ("Material_Number", "count"),
    }
    if STD_COL in sub.columns:
        agg_dict["std_price"] = (STD_COL, "mean")
    if PO_COL in sub.columns:
        agg_dict["po_price"] = (PO_COL, "mean")

    grp = sub.groupby("YearMonth").agg(**agg_dict).reset_index().sort_values("YearMonth")

    def safe(v):
        if v is None:
            return None
        try:
            return None if math.isnan(v) else float(v)
        except Exception:
            return None

    desc = ""
    if "Material_Description" in sub.columns:
        desc = str(sub["Material_Description"].dropna().iloc[0]) if not sub["Material_Description"].dropna().empty else ""

    result = {
        "material":  req.material_number,
        "desc":      desc,
        "labels":    grp["YearMonth"].astype(str).tolist(),
        "std_price": [safe(v) for v in (grp["std_price"].tolist() if "std_price" in grp.columns else [])],
        "po_price":  [safe(v) for v in (grp["po_price"].tolist()  if "po_price"  in grp.columns else [])],
        "ppv":       [safe(v) for v in grp["ppv"].tolist()],
        "records":   [int(v) for v in grp["records"].tolist()],
    }
    cache.set_json(ck, result, cache.TTL_DRILL)
    return result


@app.post("/api/vendor-price-trend")
def vendor_price_trend(req: VendorPriceTrendRequest):
    """Monthly PO Price /1k per vendor for a single material."""
    ck = cache.make_key("drill", "vndtrend", req.session_id,
                        cache.filter_hash(req.filters), req.material_number)
    hit = cache.get_json(ck)
    if hit is not None:
        return hit
    import math
    df, _ = _get_session(req.session_id)
    dff   = apply_filters(df, req.filters)

    mask = dff["Material_Number"].astype(str) == req.material_number
    sub  = dff[mask]

    if sub.empty or "YearMonth" not in sub.columns or "Vendor_Name" not in sub.columns:
        return {"material": req.material_number, "labels": [], "vendors": []}

    PO_COL = "PO_Price_per_1000_num"
    if PO_COL not in sub.columns:
        return {"material": req.material_number, "labels": [], "vendors": []}

    def safe(v):
        if v is None:
            return None
        try:
            return None if math.isnan(v) else float(v)
        except Exception:
            return None

    all_months = sorted(sub["YearMonth"].astype(str).unique().tolist())
    grp = (
        sub.groupby(["Vendor_Name", "YearMonth"])[PO_COL]
        .mean()
        .reset_index()
    )

    vendors = []
    for vendor_name, vgrp in grp.groupby("Vendor_Name"):
        month_price = dict(zip(vgrp["YearMonth"].astype(str), vgrp[PO_COL]))
        po_series = [safe(month_price.get(m)) for m in all_months]
        vendors.append({"name": str(vendor_name), "po_price": po_series})

    vendors.sort(key=lambda x: x["name"])

    result = {"material": req.material_number, "labels": all_months, "vendors": vendors}
    cache.set_json(ck, result, cache.TTL_DRILL)
    return result


@app.post("/api/forecast")
def forecast(req: ForecastRequest):
    """Compute time-series forecast (can be slow, separated from main analytics)."""
    df, params = _get_session(req.session_id)

    # Check forecast cache (stable key based on query params + filters + scale)
    fore_key = cache.make_key(
        "fore",
        _plant_key(params),
        params.get("PostingStartDate", ""),
        params.get("PostingEndDate", ""),
        cache.filter_hash(req.filters),
        req.scale_method,
    )
    cached = cache.get_json(fore_key)
    if cached is not None:
        return cached

    dff = apply_filters(df, req.filters)
    if dff.empty:
        raise HTTPException(status_code=422, detail="No data after applying filters.")
    try:
        result = compute_forecast(dff, COL_PPV, req.scale_method)
        serializable = jsonable_encoder(result)
        cache.set_json(fore_key, serializable, cache.TTL_FORECAST)
        return serializable
    except Exception as exc:
        import traceback
        raise HTTPException(status_code=500, detail=f"Forecast error: {traceback.format_exc()}")


@app.post("/api/search")
def search(req: SearchRequest):
    """Search for a material by number or description and return detailed analytics."""
    df, _ = _get_session(req.session_id)
    return search_material(df, COL_PPV, COL_PRICE, req.query)


@app.post("/api/vendor-month")
def vendor_month_records(req: VendorMonthRequest):
    """Return all individual records for a given vendor + month."""
    ck = cache.make_key("drill", "vndmon", req.session_id,
                        cache.filter_hash({"v": req.vendor}), req.yearmonth)
    hit = cache.get_json(ck)
    if hit is not None:
        return hit
    df, _ = _get_session(req.session_id)
    if "Vendor_Name" not in df.columns or "YearMonth" not in df.columns:
        return {"records": [], "columns": []}
    sub = df[(df["Vendor_Name"] == req.vendor) & (df["YearMonth"] == req.yearmonth)].copy()
    if sub.empty:
        return {"records": [], "columns": []}

    want = [
        "Material_Number", "Material_Description",
        "Posting_Date", "Quantity",
        "MExtended_PO_Price_num", "M_Extended__Std_Amount_num",
        "PPDifference_currency",
        "PO_Price_per_1000_num", "Standard_Price_for_1000_num",
    ]
    cols = [c for c in want if c in sub.columns]
    sub  = sub[cols].copy()

    rename = {
        "Material_Number":            "Material",
        "Material_Description":       "Description",
        "Posting_Date":               "Date",
        "Quantity":                   "Qty",
        "MExtended_PO_Price_num":     "PO Amount",
        "M_Extended__Std_Amount_num": "Std Amount",
        "PPDifference_currency":      "PPV (USD)",
        "PO_Price_per_1000_num":      "PO Price/1k",
        "Standard_Price_for_1000_num":"Std Price/1k",
    }
    sub.rename(columns={k: v for k, v in rename.items() if k in sub.columns}, inplace=True)
    if "Date" in sub.columns:
        sub["Date"] = sub["Date"].astype(str).str[:10]
    records = sub.where(sub.notna(), None).to_dict("records")
    result = {"records": records, "columns": list(sub.columns)}
    cache.set_json(ck, result, cache.TTL_DRILL)
    return result


class RawDataRequest(BaseModel):
    session_id: str
    filters:    dict = {}
    page:       int  = 1     # 1-based
    page_size:  int  = 100   # rows per page, max 500

@app.post("/api/raw-data")
def raw_data(req: RawDataRequest):
    """Return the full session DataFrame as paginated JSON rows with all columns."""
    page_size = min(max(req.page_size, 1), 500)
    page      = max(req.page, 1)

    df, _ = _get_session(req.session_id)
    dff   = apply_filters(df, req.filters)

    total_rows = len(dff)
    total_pages = max(1, (total_rows + page_size - 1) // page_size)
    start = (page - 1) * page_size
    end   = start + page_size

    chunk = dff.iloc[start:end].copy()

    # Serialise safely: timestamps → strings, numpy scalars → native Python
    import numpy as np
    records: list[dict] = []
    for row in chunk.to_dict("records"):
        safe: dict = {}
        for k, v in row.items():
            if isinstance(v, pd.Timestamp):
                safe[k] = str(v.date())
            elif isinstance(v, float) and not np.isfinite(v):
                safe[k] = None
            elif isinstance(v, (np.integer,)):
                safe[k] = int(v)
            elif isinstance(v, (np.floating,)):
                safe[k] = float(v)
            else:
                safe[k] = v
        records.append(safe)

    return {
        "columns":     list(dff.columns),
        "records":     records,
        "total_rows":  total_rows,
        "total_pages": total_pages,
        "page":        page,
        "page_size":   page_size,
    }


@app.post("/api/trend-detail")
def trend_detail(req: TrendDetailRequest):
    """Return all individual records that make up a specific bar in the Trend chart."""
    ck = cache.make_key("drill", "trenddet", "v2", req.session_id,
                        cache.filter_hash(req.filters), req.label, req.granularity)
    hit = cache.get_json(ck)
    if hit is not None:
        return hit

    df, _ = _get_session(req.session_id)
    dff   = apply_filters(df, req.filters)

    if req.granularity == "daily":
        if "PostingDay" not in dff.columns:
            return {"label": req.label, "rows": []}
        # PostingDay is datetime; label is its str() e.g. "2024-01-15 00:00:00"
        day_prefix = req.label[:10]
        mask = dff["PostingDay"].astype(str).str.startswith(day_prefix)
    else:
        if "YearMonth" not in dff.columns:
            return {"label": req.label, "rows": []}
        mask = dff["YearMonth"].astype(str) == req.label

    sub = dff[mask].copy()
    if sub.empty:
        return {"label": req.label, "rows": []}

    rows = []
    for _, row in sub.iterrows():
        rows.append({
            "date":           str(row.get("PostingDay", row.get("Posting_Date", "")))[:10],
            "material":       str(row.get("Material_Number", "")),
            "group":          str(row.get("Material_Group_Description", "")),
            "vendor":         str(row.get("Vendor_Name", "")),
            "plant":          str(row.get("Plant", "")),
            "ppv":            float(row.get(COL_PPV, 0) or 0),
            "quantity":       float(row.get("Quantity_num", 0) or 0),
            "po_price_k":     float(row.get("PO_Price_per_1000_num", 0) or 0),
            "std_price_k":    float(row.get("Standard_Price_for_1000_num", 0) or 0),
        })

    rows.sort(key=lambda r: abs(r["ppv"]), reverse=True)
    result = {"label": req.label, "rows": rows[:1000]}
    cache.set_json(ck, result, cache.TTL_DRILL)
    return result


# ── Price Calculator proxy (conexion_internalquery) ───────────────────────────

# Signatures of transient "the remote forcibly closed the connection" errors.
# These happen when a pooled keep-alive socket goes stale (the upstream proxy or
# Nexar drops idle connections) and `requests` reuses the dead socket. Retrying
# transparently opens a fresh connection, which is why restarting the server
# "fixed" it before. We now retry automatically instead.
_TRANSIENT_CONN_SIGNS = (
    "connection aborted", "connection reset", "forcibly closed",
    "remote end closed", "connectionreseterror", "10054", "broken pipe",
    "error consultando nexar",  # upstream surfaces the Nexar reset in its detail
)


def _is_transient_conn_error(text: str) -> bool:
    t = (text or "").lower()
    return any(sign in t for sign in _TRANSIENT_CONN_SIGNS)


def _build_pricecalc_session() -> requests.Session:
    """A requests.Session with urllib3 retry on connection errors / 5xx."""
    from requests.adapters import HTTPAdapter
    try:
        from urllib3.util.retry import Retry
    except ImportError:  # pragma: no cover
        from requests.packages.urllib3.util.retry import Retry  # type: ignore
    retry = Retry(
        total=3, connect=3, read=3,
        backoff_factor=0.4,
        status_forcelist=(502, 503, 504),
        allowed_methods=frozenset(["GET", "POST"]),
        raise_on_status=False,
    )
    adapter = HTTPAdapter(max_retries=retry, pool_connections=10, pool_maxsize=20)
    sess = requests.Session()
    sess.mount("http://", adapter)
    sess.mount("https://", adapter)
    return sess


_PRICECALC_SESSION = _build_pricecalc_session()


def _pricecalc_post(path: str, body: dict, *, timeout: int = 30, max_attempts: int = 3):
    """POST to the Price Calculator API with transparent retry on connection resets.

    A stale pooled socket raises ConnectionResetError(10054). We retry with a
    fresh connection a few times before surfacing the error to the caller.
    """
    last_exc: Exception | None = None
    for attempt in range(1, max_attempts + 1):
        try:
            r = _PRICECALC_SESSION.post(f"{PRICECALC_API_URL}{path}", json=body, timeout=timeout)
            r.raise_for_status()
            return r.json()
        except requests.exceptions.ConnectionError as e:
            last_exc = e
            if attempt < max_attempts and _is_transient_conn_error(str(e)):
                time.sleep(0.4 * attempt)
                continue
            raise HTTPException(
                status_code=503,
                detail=f"Price Calculator API not reachable at {PRICECALC_API_URL}. "
                       "Start the conexion_internalquery backend first."
            )
        except requests.exceptions.Timeout as e:
            last_exc = e
            if attempt < max_attempts:
                time.sleep(0.4 * attempt)
                continue
            raise HTTPException(status_code=504, detail="Price Calculator API timed out.")
        except requests.exceptions.HTTPError as e:
            detail = str(e)
            try:
                detail = e.response.json().get("detail", detail)
            except Exception:
                pass
            status = e.response.status_code if e.response is not None else 502
            # Upstream may surface a transient Nexar/SAP connection reset as a 5xx
            # detail — retry those instead of failing the whole search.
            if attempt < max_attempts and (status >= 500 or _is_transient_conn_error(detail)):
                time.sleep(0.4 * attempt)
                continue
            raise HTTPException(status_code=status, detail=detail)
    # Exhausted retries on a transient error
    raise HTTPException(status_code=503, detail=f"Price Calculator API connection failed: {last_exc}")


@app.post("/api/pricecalc/ampl")
def pricecalc_ampl(req: PriceCalcAmplRequest):
    return _pricecalc_post("/ampl-by-material", {"internal_part_number": req.internal_part_number})


@app.post("/api/pricecalc/internal-query")
def pricecalc_internal_query(req: PriceCalcIQRequest):
    return _pricecalc_post("/internal-query", {"mpns": req.mpns})


@app.post("/api/pricecalc/market-prices")
def pricecalc_market_prices(req: PriceCalcMarketRequest):
    # Cap the number of results requested from Nexar (upstream GraphQL `limit`)
    # to save API requests. Use the frontend-provided value if any, else the
    # configured default. The limit is forwarded to the conexion_internalquery
    # service in the request body.
    limit = req.limit if (req.limit is not None and req.limit > 0) else NEXAR_RESULT_LIMIT
    body  = {"mpns": req.mpns, "quantity": req.quantity, "limit": limit}

    # ── Nexar 24-hour cache (per MPN + limit, quantity-agnostic) ──────────────
    # Frontend always sends a single MPN per call, so we cache per that MPN.
    # Quantity is intentionally excluded from the cache key: offer prices are
    # per-unit and don't change with quantity; this maximises cache reuse.
    # The limit IS part of the key so a smaller cached result isn't reused for a
    # larger request (and vice-versa).
    if len(req.mpns) == 1:
        mpn_upper = req.mpns[0].strip().upper()
        mkt_key   = cache.make_key("nexar", "mkt", f"{mpn_upper}:{limit}")
        cached    = cache.get_json(mkt_key)
        if cached is not None:
            return cached
        result = _pricecalc_post("/market-prices", body)
        cache.set_json(mkt_key, result, cache.TTL_NEXAR)
        # Record the moment the first entry was written (SET NX — won't overwrite)
        init_key = cache.make_key("nexar", "init")
        cache.set_if_not_exists(init_key, {"ts": datetime.utcnow().isoformat()}, cache.TTL_NEXAR)
        return result
    # Multi-MPN fallback (not called by the frontend currently) — no caching
    return _pricecalc_post("/market-prices", body)


@app.get("/api/pricecalc/nexar-cache-stats")
def nexar_cache_stats():
    """Return when the 24-h Nexar cache session started and how many MPNs are cached."""
    init_data = cache.get_json(cache.make_key("nexar", "init"))
    cached_count = cache.count_keys_with_prefix(cache.make_key("nexar", "mkt", ""))
    if init_data and init_data.get("ts"):
        ts = init_data["ts"]
        try:
            dt = datetime.fromisoformat(ts)
            expires_at = (dt + timedelta(hours=24)).isoformat()
        except Exception:
            expires_at = ""
        return {"initialized_at": ts, "expires_at": expires_at, "cached_count": cached_count}
    return {"initialized_at": None, "expires_at": None, "cached_count": cached_count}


# ── MPN best-price DB cache + daily batch job ─────────────────────────────────

class MpnLookupRequest(BaseModel):
    mpns: list[str]

class MpnResolveRequest(BaseModel):
    mpns:        list[str]
    window_days: int = DBJOB_WINDOW_DAYS

class DbJobRunRequest(BaseModel):
    window_days: int | None = None
    force: bool = False   # when True, re-process every MPN (ignore today's cache)

class AdminLoginRequest(BaseModel):
    username: str
    password: str


def _entry_public(e: dict | None) -> dict | None:
    """Shape a mpn_best row for the frontend."""
    if not e:
        return None
    payload = {}
    # Accept both payload_json (string from DB) and payload (dict from realtime)
    raw = e.get("payload_json")
    if raw:
        try:
            payload = _json.loads(raw) or {}
        except (ValueError, TypeError):
            payload = {}
    elif "payload" in e:
        payload = e["payload"] or {}
    
    return {
        "mpn":           e.get("mpn"),
        "internalPN":    e.get("internal_pn"),
        "bestSource":    e.get("best_source"),
        "bestPriceUsd":  e.get("best_price_usd"),
        "stdPriceUsd":   e.get("std_price_usd"),
        "bestSupplier":  e.get("best_supplier"),
        "bestPlant":     e.get("best_plant"),
        "bestMpn":       e.get("best_mpn"),
        "lastPoDate":    e.get("last_po_date"),
        "computedAt":    e.get("computed_at"),
        "origin":        e.get("origin"),
        "status":        e.get("status"),
        "errorDetail":   e.get("error_detail"),
        # Full payload for All Records / Blocked-Deleted / Multi-Component tabs
        "rawRows":       payload.get("raw_rows") or [],
        "ampl":          payload.get("ampl"),
        "mcRows":        payload.get("mc_rows") or [],
        "hasPayload":    bool(raw or payload),
    }


@app.post("/api/mpn-best/lookup")
def mpn_best_lookup(req: MpnLookupRequest):
    """DB-only lookup. Returns cached best entries (valid today) and the misses."""
    found = mpn_store.get_best_many(req.mpns)
    keys = [(m or "").strip().upper() for m in req.mpns if m]
    missing = [k for k in dict.fromkeys(keys) if k not in found]
    return {
        "found":   {k: _entry_public(v) for k, v in found.items()},
        "missing": missing,
    }


@app.post("/api/mpn-best/resolve")
def mpn_best_resolve(req: MpnResolveRequest):
    """
    DB-first resolver: returns cached entries instantly and computes any misses
    in real time (SAP only), storing them so the next lookup is instant.
    """
    found = mpn_store.get_best_many(req.mpns)
    keys = list(dict.fromkeys((m or "").strip().upper() for m in req.mpns if m))
    result: dict[str, dict | None] = {k: _entry_public(found[k]) for k in keys if k in found}

    misses = [k for k in keys if k not in found]
    if misses:
        # Realtime profile: bounded parallelism + shorter upstream timeout/retries
        # to avoid long "querying" tails and upstream saturation.
        max_workers = max(1, int(os.getenv("MPN_RESOLVE_MAX_WORKERS", str(MPN_RESOLVE_MAX_WORKERS))))
        workers = min(max_workers, len(misses))
        log = logging.getLogger(__name__)
        log.info("mpn-best resolve realtime: misses=%d workers=%d", len(misses), workers)

        with ThreadPoolExecutor(max_workers=workers) as pool:
            futures = {
                pool.submit(batch_job.process_mpn, mpn, req.window_days, 30, 2): mpn
                for mpn in misses
            }
            for fut in as_completed(futures):
                mpn = futures[fut]
                try:
                    entry = fut.result()
                    entry["origin"] = "realtime"
                    mpn_store.upsert_best(entry)
                    # Cache the separate Multi-MPN / Multi-Component bests for Deep Analysis.
                    _deep = entry.get("deep")
                    if _deep:
                        _deep["origin"] = "realtime"
                        try:
                            mpn_store.upsert_deep(_deep)
                        except Exception:
                            pass
                    result[mpn] = _entry_public({**entry, "internal_pn": entry.get("internal_pn")})
                except Exception as exc:  # surface as null; caller can fall back
                    result[mpn] = None
                    # Document the failure so it shows up in the admin search & re-query.
                    try:
                        mpn_store.mark_error(mpn, str(exc))
                    except Exception:
                        pass
                    log.info("resolve miss for %s: %s", mpn, exc)

    return {"results": result, "from_db": [k for k in keys if k in found], "computed": misses}


# ── Deep Analysis cache (Multi-MPN vs Multi-Component, per Internal PN) ────────

class MpnDeepResolveRequest(BaseModel):
    internal_pns: list[str]
    window_days:  int = DBJOB_WINDOW_DAYS


def _deep_public(e: dict | None) -> dict | None:
    """Shape an mpn_deep row for the frontend Deep Analysis table."""
    if not e:
        return None
    return {
        "internalPN":      e.get("internal_pn"),
        "status":          "done",
        # Multi-MPN best
        "mpnBestPriceUsd": e.get("mpn_price_usd"),
        "mpnBestStdUsd":   e.get("mpn_std_usd"),
        "mpnBestSupplier": e.get("mpn_supplier"),
        "mpnBestPlant":    e.get("mpn_plant"),
        "mpnBestMpn":      e.get("mpn_best_mpn"),
        "mpnLastPoDate":   e.get("mpn_last_po_date"),
        # Multi-Component best
        "mcBestPriceUsd":  e.get("mc_price_usd"),
        "mcStdPriceUsd":   e.get("mc_std_usd"),
        "mcBestSupplier":  e.get("mc_supplier"),
        "mcBestPlant":     e.get("mc_plant"),
        "mcBestMpn":       e.get("mc_best_mpn"),
        "mcBestInternalPN": e.get("mc_internal_pn") or e.get("internal_pn"),
        "mcLastPoDate":    e.get("mc_last_po_date"),
        "origin":          e.get("origin"),
        "computedAt":      e.get("computed_at"),
        "fromCache":       True,
    }


def _compute_deep_for_internal(internal_pn: str, window_days: int) -> dict:
    """Compute the best Multi-MPN and Multi-Component rows for one Internal PN.

    Mirrors the frontend Deep Analysis flow (AMPL → internal-query) plus the
    direct-MPN side, then persists into mpn_deep for instant future lookups.
    """
    ip = (internal_pn or "").strip().upper()
    window_ms = window_days * 86_400_000

    # Multi-Component side: AMPL → query all active/blocked/deleted MPNs.
    ampl = batch_job._post("/ampl-by-material", {"internal_part_number": ip})
    query_mpns = ampl.get("mpns_list") or []
    if not query_mpns:
        query_mpns = list({
            i.get("MfgPartNumber")
            for i in (ampl.get("blocked") or []) + (ampl.get("deleted") or [])
            if i.get("MfgPartNumber")
        })
    mc_rows = []
    best_mc = None
    if query_mpns:
        iq = batch_job._post("/internal-query", {"mpns": query_mpns})
        mc_rows = iq.get("data") or []
        best_mc = mpn_store.compute_best_row(mc_rows, window_ms)

    # Multi-MPN side: use the cheapest active MPN's direct search as the
    # representative. We reuse the MC rows' best MPN to keep it light; the
    # batch job stores a richer split, this realtime path is a good-enough miss.
    best_mpn_row = best_mc  # for a pure-internal-PN request these coincide
    p_mpn = mpn_store.resolve_last_po_price(best_mpn_row) if best_mpn_row else None
    p_mc  = mpn_store.resolve_last_po_price(best_mc) if best_mc else None

    deep = {
        "internal_pn": ip,
        "mpn": best_mpn_row.get("mpn") if best_mpn_row else None,
        "window_days": window_days,
        "origin": "realtime",
        "status": "ok" if (p_mpn is not None or p_mc is not None) else "no_price",
        "mpn_price_usd":    p_mpn,
        "mpn_std_usd":      mpn_store._f(best_mpn_row.get("standardPriceUsd")) if best_mpn_row else None,
        "mpn_supplier":     (best_mpn_row.get("supplierName") or best_mpn_row.get("englishName")) if best_mpn_row else None,
        "mpn_plant":        best_mpn_row.get("siteName") if best_mpn_row else None,
        "mpn_best_mpn":     best_mpn_row.get("mpn") if best_mpn_row else None,
        "mpn_last_po_date": best_mpn_row.get("lastPoDate") if best_mpn_row else None,
        "mc_price_usd":     p_mc,
        "mc_std_usd":       mpn_store._f(best_mc.get("standardPriceUsd")) if best_mc else None,
        "mc_supplier":      (best_mc.get("supplierName") or best_mc.get("englishName")) if best_mc else None,
        "mc_plant":         best_mc.get("siteName") if best_mc else None,
        "mc_best_mpn":      best_mc.get("mpn") if best_mc else None,
        "mc_internal_pn":   best_mc.get("internalPN") if best_mc else ip,
        "mc_last_po_date":  best_mc.get("lastPoDate") if best_mc else None,
    }
    mpn_store.upsert_deep(deep)
    return deep


@app.post("/api/mpn-deep/resolve")
def mpn_deep_resolve(req: MpnDeepResolveRequest):
    """DB-first Deep Analysis resolver.

    Returns cached deep rows instantly for Internal PNs already computed, and
    computes any misses in real time (SAP), storing them for next time.
    """
    keys = list(dict.fromkeys((p or "").strip().upper() for p in req.internal_pns if p))
    found = mpn_store.get_deep_many(keys)
    result: dict[str, dict | None] = {k: _deep_public(found[k]) for k in keys if k in found}

    misses = [k for k in keys if k not in found]
    for ip in misses:
        try:
            deep = _compute_deep_for_internal(ip, req.window_days)
            result[ip] = _deep_public({**deep, "internal_pn": ip})
        except Exception as exc:  # surface as null; frontend can fall back
            result[ip] = None
            logging.getLogger(__name__).info("deep resolve miss for %s: %s", ip, exc)

    return {
        "results": result,
        "from_db": [k for k in keys if k in found],
        "computed": misses,
    }


@app.post("/api/dbjob/run")
def dbjob_run(req: DbJobRunRequest, authorization: str = Header(default="")):
    wd = req.window_days or DBJOB_WINDOW_DAYS
    # A force re-run wipes the persistent cache and rebuilds it from scratch, so
    # it requires admin credentials. A normal run only fills in pending MPNs.
    if req.force:
        _require_admin(authorization)
    return batch_job.start_job(trigger="manual", window_days=wd, skip_cached=not req.force)


@app.post("/api/dbjob/retry-errors")
def dbjob_retry_errors():
    """Re-run only the MPNs that failed with connection errors in the latest run."""
    last = mpn_store.latest_run()
    if not last:
        raise HTTPException(status_code=404, detail="No previous run to retry.")
    mpns = mpn_store.connection_error_mpns(last["id"])
    if not mpns:
        return {"started": False, "reason": "No connection errors to retry."}
    return batch_job.start_job(trigger="retry", mpns=mpns)


@app.post("/api/dbjob/cancel")
def dbjob_cancel():
    batch_job.request_cancel()
    return {"cancelled": True}


@app.get("/api/dbjob/status")
def dbjob_status():
    state = batch_job.get_state()
    last_run_at = mpn_store.get_meta("last_run_at")
    latest = mpn_store.latest_run()
    cached_count = mpn_store.count_cached()

    # Overdue = past the scheduled hour today and no successful run since then
    now = datetime.now()
    today_sched = now.replace(hour=DBJOB_SCHEDULE_HOUR, minute=0, second=0, microsecond=0)
    overdue = False
    if not state["running"] and now >= today_sched:
        if not last_run_at:
            overdue = True
        else:
            try:
                overdue = datetime.fromisoformat(last_run_at) < today_sched
            except ValueError:
                overdue = True

    return {
        **state,
        "last_run_at":  last_run_at,
        "cached_count": cached_count,
        "schedule_hour": DBJOB_SCHEDULE_HOUR,
        "overdue":      overdue,
        "latest_run":   latest,
    }


@app.get("/api/dbjob/export")
def dbjob_export():
    """Export the current best-price cache as an Excel file."""
    import io
    rows = mpn_store.all_cached()
    df = pd.DataFrame([{
        "MPN":            r.get("mpn"),
        "Internal PN":    r.get("internal_pn"),
        "Best Source":    r.get("best_source"),
        "Best Price USD": r.get("best_price_usd"),
        "Std Price USD":  r.get("std_price_usd"),
        "Best Supplier":  r.get("best_supplier"),
        "Best Plant":     r.get("best_plant"),
        "Best MPN":       r.get("best_mpn"),
        "Last PO Date":   r.get("last_po_date"),
        "Computed At":    r.get("computed_at"),
        "Origin":         r.get("origin"),
    } for r in rows])
    buf = io.BytesIO()
    with pd.ExcelWriter(buf, engine="openpyxl") as xl:
        df.to_excel(xl, index=False, sheet_name="MPN Best Prices")
    buf.seek(0)
    fname = f"mpn_best_prices_{datetime.now():%Y%m%d}.xlsx"
    return StreamingResponse(
        buf,
        media_type="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        headers={"Content-Disposition": f'attachment; filename="{fname}"'},
    )


# ── Admin dashboard (error metrics) ───────────────────────────────────────────

_ADMIN_TOKENS: dict[str, datetime] = {}  # token → expiry
_ADMIN_TOKEN_TTL = timedelta(hours=8)


def _require_admin(authorization: str | None) -> None:
    token = (authorization or "").removeprefix("Bearer ").strip()
    exp = _ADMIN_TOKENS.get(token)
    if not exp or exp < datetime.now():
        _ADMIN_TOKENS.pop(token, None)
        raise HTTPException(status_code=401, detail="Admin authentication required.")


@app.post("/api/admin/login")
def admin_login(req: AdminLoginRequest):
    if req.username != ADMIN_USERNAME or req.password != ADMIN_PASSWORD:
        raise HTTPException(status_code=401, detail="Invalid credentials.")
    token = uuid.uuid4().hex
    _ADMIN_TOKENS[token] = datetime.now() + _ADMIN_TOKEN_TTL
    return {"token": token, "expires_in": int(_ADMIN_TOKEN_TTL.total_seconds())}


@app.get("/api/admin/dashboard")
def admin_dashboard(authorization: str = Header(default="")):
    _require_admin(authorization)
    # Hide errors that have since been resolved: an MPN is considered fixed when
    # its current cached status is 'ok'. We drop those from the recent-errors list
    # so only outstanding issues are shown.
    raw_errors = mpn_store.list_errors(limit=600)
    resolved = mpn_store.mpns_by_status(["ok"])
    resolved_set = {(m or "").strip().upper() for m in resolved}
    recent_errors = [
        e for e in raw_errors
        if (str(e.get("mpn") or "").strip().upper()) not in resolved_set
    ][:300]
    return {
        "metrics":     mpn_store.error_metrics(),
        "runs":        mpn_store.list_runs(30),
        "recent_errors": recent_errors,
        "cached_count": mpn_store.count_cached(),
        "deep_count":   mpn_store.count_deep(),
        "status_counts": mpn_store.status_counts(),
        "active_db":    db_registry.active_db_file(),
    }


# ── Admin: search & re-query specific MPNs ────────────────────────────────────

class AdminRequeryRequest(BaseModel):
    mpns:        list[str]
    window_days: int | None = None

class AdminRequeryFailedRequest(BaseModel):
    statuses:    list[str] | None = None   # default: ['no_price', 'error']
    window_days: int | None = None


def _split_terms(q: str) -> list[str]:
    """Split a search box value into individual terms.

    Accepts a single term or a pasted list separated by newlines, commas,
    semicolons, tabs or whitespace. De-duplicates (case-insensitive) and
    preserves order.
    """
    import re
    raw = re.split(r"[\s,;]+", (q or "").strip())
    seen: set[str] = set()
    out: list[str] = []
    for t in raw:
        t = t.strip()
        if not t:
            continue
        key = t.upper()
        if key in seen:
            continue
        seen.add(key)
        out.append(t)
    return out


@app.get("/api/admin/mpn-search")
def admin_mpn_search(q: str = "", status: str = "", authorization: str = Header(default="")):
    """Search cached entries by MPN / internal PN, optionally filtered by status.

    The query may contain a single term or a pasted list of MPNs / Internal PNs
    separated by newlines, commas, semicolons or spaces — every term is matched.
    """
    _require_admin(authorization)
    terms = _split_terms(q)
    if status:
        wanted = [s.strip() for s in status.split(",") if s.strip()]
        rows = mpn_store.list_by_status(wanted)
        if terms:
            tu = [t.upper() for t in terms]
            rows = [r for r in rows if any(
                t in (r.get("mpn") or "").upper()
                or t in (r.get("internal_pn") or "").upper()
                or t in (r.get("best_mpn") or "").upper()
                for t in tu
            )]
    elif len(terms) > 1:
        # Multi-term paste: union of matches across all terms, de-duplicated.
        seen: set[str] = set()
        rows = []
        for t in terms:
            for r in mpn_store.search_best(t):
                key = (r.get("mpn") or "")
                if key in seen:
                    continue
                seen.add(key)
                rows.append(r)
    else:
        rows = mpn_store.search_best(q)
    return {
        "results": [_entry_public(r) for r in rows],
        "status_counts": mpn_store.status_counts(),
    }


def _requery_mpns_sync(mpns: list[str], window_days: int) -> list[dict]:
    """Re-process a small batch of MPNs in real time (SAP only) and persist them.

    Used by the admin 'Re-query' action so the result is available immediately.
    """
    from concurrent.futures import ThreadPoolExecutor

    keys = list(dict.fromkeys((m or "").strip().upper() for m in mpns if m))
    out: list[dict] = []

    def _one(mpn: str) -> dict:
        try:
            entry = batch_job.process_mpn(mpn, window_days)
            entry["origin"] = "realtime"
            mpn_store.upsert_best(entry)
            _deep = entry.get("deep")
            if _deep:
                _deep["origin"] = "realtime"
                try:
                    mpn_store.upsert_deep(_deep)
                except Exception:
                    pass
            return _entry_public(mpn_store.get_best(mpn)) or {"mpn": mpn, "status": "no_price"}
        except Exception as exc:  # noqa: BLE001
            try:
                mpn_store.mark_error(mpn, str(exc))
            except Exception:
                pass
            return _entry_public(mpn_store.get_best(mpn)) or {
                "mpn": mpn, "status": "error", "errorDetail": str(exc)[:1000]
            }

    if not keys:
        return out
    with ThreadPoolExecutor(max_workers=min(6, len(keys))) as ex:
        out = list(ex.map(_one, keys))
    return out


@app.post("/api/admin/mpn-requery")
def admin_mpn_requery(req: AdminRequeryRequest, authorization: str = Header(default="")):
    """Re-query specific MPNs immediately (synchronous, SAP only) and update the cache."""
    _require_admin(authorization)
    if not req.mpns:
        raise HTTPException(status_code=400, detail="No MPNs provided.")
    if len(req.mpns) > 50:
        raise HTTPException(status_code=400,
                            detail="Too many MPNs for a synchronous re-query (max 50). "
                                   "Use 'Re-query all failed' for large batches.")
    wd = req.window_days or DBJOB_WINDOW_DAYS
    results = _requery_mpns_sync(req.mpns, wd)
    ok = sum(1 for r in results if (r or {}).get("status") == "ok")
    return {
        "results": results,
        "summary": {"requested": len(req.mpns), "ok": ok, "failed": len(results) - ok},
        "status_counts": mpn_store.status_counts(),
    }


@app.post("/api/admin/mpn-requery-failed")
def admin_mpn_requery_failed(req: AdminRequeryFailedRequest, authorization: str = Header(default="")):
    """Re-query every cached entry whose status is no_price/error via the background job."""
    _require_admin(authorization)
    statuses = req.statuses or ["no_price", "error"]
    mpns = mpn_store.mpns_by_status(statuses)
    if not mpns:
        return {"started": False, "reason": "No matching entries to re-query.", "count": 0}
    wd = req.window_days or DBJOB_WINDOW_DAYS
    res = batch_job.start_job(trigger="requery", mpns=mpns, window_days=wd)
    return {**res, "count": len(mpns)}


# ── Admin: local database version control ─────────────────────────────────────

class AdminDbActivateRequest(BaseModel):
    file: str

class AdminDbRemoveRequest(BaseModel):
    file: str
    delete_file: bool = False


@app.get("/api/admin/databases")
def admin_databases(authorization: str = Header(default="")):
    """List all local cache database versions and which one is active."""
    _require_admin(authorization)
    return {
        "active": db_registry.active_db_file(),
        "databases": db_registry.list_databases(),
        "job_running": batch_job.is_running(),
    }


@app.post("/api/admin/databases/activate")
def admin_databases_activate(req: AdminDbActivateRequest, authorization: str = Header(default="")):
    """Hot-swap the active database (no restart). Old DB data is preserved."""
    _require_admin(authorization)
    if batch_job.is_running():
        raise HTTPException(status_code=409,
                            detail="A job is running. Wait for it to finish before switching DB.")
    try:
        db_registry.set_active(req.file)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    new_path = mpn_store.reopen()   # re-point the live connection
    mpn_store.init_db()             # ensure schema on the newly-active DB
    return {
        "active": db_registry.active_db_file(),
        "path": new_path,
        "cached_count": mpn_store.count_cached(),
        "deep_count": mpn_store.count_deep(),
        "databases": db_registry.list_databases(),
    }


@app.post("/api/admin/databases/remove")
def admin_databases_remove(req: AdminDbRemoveRequest, authorization: str = Header(default="")):
    """Remove a non-active database from the registry (optionally delete the file)."""
    _require_admin(authorization)
    try:
        db_registry.remove_database(req.file, delete_file=req.delete_file)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    return {"active": db_registry.active_db_file(), "databases": db_registry.list_databases()}


# ── Demand databases (dbquery Excel → .db; Total EAU / Onhand / Gross Demand) ───

class DemandLookupRequest(BaseModel):
    mpns: list[str]

class DemandConvertRequest(BaseModel):
    force: bool = False

class DemandActivateRequest(BaseModel):
    file: str

class DemandRemoveRequest(BaseModel):
    file: str
    delete_file: bool = False


class DemandCreateBestTableRequest(BaseModel):
    mpns: list[str] | None = None
    window_days: int | None = None
    table_name: str | None = None


class CurrencyRateRequest(BaseModel):
    from_currency: str
    date: str


@app.post("/api/demand/lookup")
def demand_lookup(req: DemandLookupRequest):
    """Per-MPN demand (Total EAU / Onhand Qty / Gross Demand) per plant from the
    active dbquery demand database. Public — used by the Supplier Savings modal."""
    return {
        "results": demand_store.lookup_demand(req.mpns),
        "active_db": demand_store.active_db_file(),
    }


@app.post("/api/demand/full")
def demand_full(req: DemandLookupRequest):
    """Full demand rows (ALL columns) for the given MPNs from the active demand
    DB. Public — used by the modal's 'Full demand data' table view."""
    data = demand_store.lookup_full_rows(req.mpns)
    return {
        "columns": data["columns"],
        "results": data["results"],
        "active_db": demand_store.active_db_file(),
        "last_po_price_col": demand_store.LAST_PO_PRICE_COL,
        "po_qty_col": demand_store.PO_QTY_COL,
        "total_eau_col": demand_store.TOTAL_EAU_COL,
        "plant_name_col": "plant_name",
    }


@app.post("/api/financials/currency-rate")
def financials_currency_rate(req: CurrencyRateRequest):
    """Proxy currency conversion rate lookup to the SAP FetchCurrencyRates API."""
    from_currency = (req.from_currency or "").strip().upper()
    if not from_currency or from_currency == "USD":
        return {"rate": 1.0, "from_currency": from_currency or "USD", "date": (req.date or "")[:10]}

    date_str = (req.date or "")[:10]
    if not date_str:
        raise HTTPException(status_code=400, detail="date is required")

    return {"rate": get_currency_rate(from_currency, date_str), "from_currency": from_currency, "date": date_str}


@app.get("/api/admin/demand/databases")
def admin_demand_databases(authorization: str = Header(default="")):
    _require_admin(authorization)
    return {
        "active": demand_store.active_db_file(),
        "databases": demand_store.list_databases(),
        "xlsx_files": [os.path.basename(p) for p in demand_store.list_xlsx_files()],
        "convert": demand_store.convert_state(),
    }


@app.post("/api/admin/demand/convert")
def admin_demand_convert(req: DemandConvertRequest, authorization: str = Header(default="")):
    """Convert every .xlsx in dbquery to a .db (keeps the originals). Async."""
    _require_admin(authorization)
    return demand_store.start_convert(force=req.force)


@app.post("/api/admin/demand/activate")
def admin_demand_activate(req: DemandActivateRequest, authorization: str = Header(default="")):
    _require_admin(authorization)
    try:
        demand_store.set_active(req.file)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    return {"active": demand_store.active_db_file(), "databases": demand_store.list_databases()}


@app.post("/api/admin/demand/remove")
def admin_demand_remove(req: DemandRemoveRequest, authorization: str = Header(default="")):
    _require_admin(authorization)
    demand_store.remove_database(req.file, delete_file=req.delete_file)
    return {"active": demand_store.active_db_file(), "databases": demand_store.list_databases()}


@app.post("/api/admin/demand/create_best_table")
def admin_demand_create_best_table(req: DemandCreateBestTableRequest, authorization: str = Header(default="")):
    """Create and persist a derived table in the active demand DB containing
    every original row plus 'Best Price for this MPN' and 'Potential Saving'.
    Requires admin auth.
    """
    _require_admin(authorization)
    window = req.window_days or DBJOB_WINDOW_DAYS
    try:
        res = demand_store.create_best_price_table(mpns=req.mpns, window_days=window, table_name=req.table_name)
        return res
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(status_code=500, detail=str(exc))


# ── SAP batch pricing for MG drilldown modal ─────────────────────────────────

_PPV_TO_SAP: dict = {
    "0010": "KEJ", "0020": "KEMX", "0040": "KEPS",
    "0045": "KERO", "0050": "KETL", "0070": "KECN",
}

class MGSapBatchRequest(BaseModel):
    materials:   list[str]  # BMATN / Material_Number values — max 20
    loser_plant: str        # PPV plant code e.g. "0020" for Mexico

@app.post("/api/mg-sap-batch")
def mg_sap_batch(req: MGSapBatchRequest):
    """
    For each material, look up SAP pricing and find if another plant buys it cheaper.
    Flow: parallel AMPL lookup per material → single batch IQ call → compare prices.
    """
    from concurrent.futures import ThreadPoolExecutor

    _mats_sorted = sorted(m.strip().upper() for m in req.materials[:20])
    ck = cache.make_key("drill", "mgsap", req.loser_plant.upper(),
                        cache.filter_hash({"mats": _mats_sorted}))
    hit = cache.get_json(ck)
    if hit is not None:
        return hit

    loser_sap = _PPV_TO_SAP.get(req.loser_plant, req.loser_plant).upper()
    mats      = _mats_sorted

    # Step 1 — Parallel AMPL lookups to resolve MPNs
    def fetch_mpns(mat: str) -> tuple[str, list]:
        try:
            r = _pricecalc_post("/ampl-by-material", {"internal_part_number": mat})
            return mat, r.get("mpns_list", [])
        except Exception:
            return mat, []

    mat_mpns: dict = {}
    with ThreadPoolExecutor(max_workers=8) as ex:
        for mat, mpns in ex.map(fetch_mpns, mats):
            if mpns:
                mat_mpns[mat] = mpns

    if not mat_mpns:
        return {"results": [{"material": m, "found": False} for m in mats]}

    # Step 2 — Single batch IQ call with all resolved MPNs
    all_mpns = list({mpn for mpns in mat_mpns.values() for mpn in mpns})
    try:
        iq_resp = _pricecalc_post("/internal-query", {"mpns": all_mpns})
        iq_rows = (iq_resp.get("data", []) if isinstance(iq_resp, dict)
                   else iq_resp if isinstance(iq_resp, list) else [])
    except Exception:
        iq_rows = []

    # Step 3 — Group IQ rows by internalPN (= BMATN)
    by_mat: dict = {}
    for row in iq_rows:
        key = (row.get("internalPN") or "").strip().upper()
        if key:
            by_mat.setdefault(key, []).append(row)

    def resolve_price(r: dict) -> float | None:
        p = r.get("lastPoPriceUsd")
        if p is None:
            raw = r.get("rawLastPoPrice")
            per = r.get("rawLastPoPer") or 1
            fx  = r.get("localCurrencyExchangeRateUsd") or 1
            if raw is not None:
                p = (raw / per) * fx
        if not p or float(p) <= 0:
            std = r.get("standardPriceUsd")
            if std and float(std) > 0:
                p = float(std)
        return float(p) if p and float(p) > 0 else None

    # Step 4 — For each material: loser price vs best alternative
    results = []
    for mat in mats:
        rows = by_mat.get(mat, [])
        if not rows:
            results.append({"material": mat, "found": False})
            continue

        loser_price = None; loser_internal_pn = None
        best_price  = None; best_site = None; best_internal_pn = None

        for r in rows:
            site = (r.get("siteName") or "").strip().upper()
            p    = resolve_price(r)
            if p is None:
                continue
            if site == loser_sap:
                if loser_price is None or p < loser_price:
                    loser_price = p
                    loser_internal_pn = r.get("internalPN")
            else:
                if best_price is None or p < best_price:
                    best_price = p
                    best_site  = r.get("siteName")
                    best_internal_pn = r.get("internalPN")

        saving_pct = None
        if loser_price and best_price and loser_price > 0:
            saving_pct = round((loser_price - best_price) / loser_price * 100, 1)

        results.append({
            "material":            mat,
            "found":               True,
            "loser_price":         round(loser_price, 6) if loser_price else None,
            "loser_internal_pn":   loser_internal_pn,
            "best_price":          round(best_price, 6) if best_price else None,
            "best_site":           best_site,
            "best_internal_pn":    best_internal_pn,
            "saving_pct":          saving_pct,
            "is_cheapest_at_loser": (
                best_price is None
                or (loser_price is not None and loser_price <= best_price)
            ),
        })

    result = {"results": results}
    cache.set_json(ck, result, cache.TTL_ANALYTIC)  # 1 h — external pricing data
    return result


@app.post("/api/chat")
def chat(req: ChatRequest):
    """Proxy chat request to Azure AI Inference."""
    try:
        from azure.ai.inference import ChatCompletionsClient
        from azure.ai.inference.models import AssistantMessage, SystemMessage, UserMessage
        from azure.core.credentials import AzureKeyCredential

        msgs = []
        for m in req.messages:
            if m.role == "system":    msgs.append(SystemMessage(content=m.content))
            elif m.role == "user":    msgs.append(UserMessage(content=m.content))
            elif m.role == "assistant": msgs.append(AssistantMessage(content=m.content))

        cli  = ChatCompletionsClient(
            endpoint=AZ_INF_ENDPOINT,
            credential=AzureKeyCredential(AZ_INF_API_KEY),
            api_version=AZ_INF_API_VER,
        )
        resp = cli.complete(messages=msgs, model=AZ_INF_MODEL, max_tokens=8192, temperature=0.3)
        ans  = resp.choices[0].message.content
        if isinstance(ans, list):
            ans = "".join(getattr(c, "text", str(c)) for c in ans)
        return {"reply": ans}
    except ImportError:
        raise HTTPException(status_code=501, detail="azure-ai-inference not installed.")
    except Exception as exc:
        raise HTTPException(status_code=500, detail=str(exc))


@app.post("/api/chat/stream")
def chat_stream(req: ChatRequest):
    """Stream chat response chunk-by-chunk via Server-Sent Events.

    If session_id is provided the full raw dataset (filtered) is injected into
    the system message so the model can reason over every individual record.
    """
    import json
    from fastapi.responses import StreamingResponse
    try:
        from azure.ai.inference import ChatCompletionsClient
        from azure.ai.inference.models import AssistantMessage, SystemMessage, UserMessage
        from azure.core.credentials import AzureKeyCredential

        # Build the message list, injecting raw data into the system message
        msgs = []
        for m in req.messages:
            if m.role == "system":
                content = m.content
                if req.session_id:
                    raw_data = _build_data_context(req.session_id, req.filters)
                    content = (
                        content
                        + "\n\n=== COMPLETE RAW DATASET (CSV) ===\n"
                        + raw_data
                    )
                msgs.append(SystemMessage(content=content))
            elif m.role == "user":
                msgs.append(UserMessage(content=m.content))
            elif m.role == "assistant":
                msgs.append(AssistantMessage(content=m.content))

        cli = ChatCompletionsClient(
            endpoint=AZ_INF_ENDPOINT,
            credential=AzureKeyCredential(AZ_INF_API_KEY),
            api_version=AZ_INF_API_VER,
        )

        def generate():
            try:
                stream = cli.complete(
                    messages=msgs,
                    model=AZ_INF_MODEL,
                    max_tokens=8192,
                    temperature=0.3,
                    stream=True,
                )
                for chunk in stream:
                    if chunk.choices and chunk.choices[0].delta and chunk.choices[0].delta.content:
                        content = chunk.choices[0].delta.content
                        if isinstance(content, list):
                            content = "".join(getattr(c, "text", str(c)) for c in content)
                        yield f"data: {json.dumps({'text': content})}\n\n"
                yield "data: [DONE]\n\n"
            except Exception as exc:
                yield f"data: {json.dumps({'error': str(exc)})}\n\n"

        return StreamingResponse(generate(), media_type="text/event-stream")
    except ImportError:
        raise HTTPException(status_code=501, detail="azure-ai-inference not installed.")
    except Exception as exc:
        raise HTTPException(status_code=500, detail=str(exc))
