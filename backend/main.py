"""
backend/main.py — FastAPI application.
Serves as the proxy between the React frontend and SAP API.
"""
import asyncio
import calendar
import json as _json
import uuid
import requests
from datetime import datetime, timedelta
from requests_ntlm import HttpNtlmAuth
from typing import Any

from fastapi import FastAPI, HTTPException, BackgroundTasks
from fastapi.middleware.cors import CORSMiddleware
from fastapi.encoders import jsonable_encoder
from fastapi.responses import StreamingResponse
from pydantic import BaseModel

import pandas as pd

from config import SAP_API_URL, COL_PPV, COL_PRICE, COL_FX, ALLOWED_ORIGINS, AZ_INF_ENDPOINT, AZ_INF_API_KEY, AZ_INF_API_VER, AZ_INF_MODEL, PRICECALC_API_URL
from data_service import parse_df, extract_records, get_filter_options, apply_filters
from analytics import compute_all_analytics, compute_forecast, search_material, compute_mg_plant_components
import cache
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

# ── Session store (in-memory fallback; Redis is primary when available) ────────
_sessions: dict[str, pd.DataFrame] = {}
_session_params: dict[str, dict]   = {}


def _get_session(session_id: str) -> tuple[pd.DataFrame, dict]:
    """Return (DataFrame, params). Checks Redis first, then in-memory fallback."""
    data = cache.get_pickle(cache.make_key("ses", session_id))
    if data is not None:
        return data["df"], data["params"]
    # In-memory fallback (e.g. when Redis was unavailable at startup)
    if session_id in _sessions:
        return _sessions[session_id], _session_params[session_id]
    raise HTTPException(status_code=404, detail="Session expired — please run a new query.")


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
    "Total_Variance_Amount_num":      "PPV",
    "P_Price_difference_num":         "PriceDiff",
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
        raise HTTPException(status_code=503, detail="Cannot connect to SAP server. Check network/VPN.")
    except requests.exceptions.Timeout:
        raise HTTPException(status_code=504, detail="SAP API timeout (300 s).")
    except requests.exceptions.HTTPError as exc:
        raise HTTPException(status_code=exc.response.status_code,
                            detail=f"SAP HTTP error: {exc.response.text[:300]}")
    except Exception as exc:
        raise HTTPException(status_code=500, detail=str(exc))
    return extract_records(raw)


def _fetch_sap_with_session(s: requests.Session, plant: str, start: str, end: str) -> list:
    """Same as _fetch_sap but reuses an existing requests.Session (NTLM auth reuse)."""
    payload = {"Plant": plant, "PostingStartDate": start, "PostingEndDate": end}
    try:
        resp = s.post(SAP_API_URL, json=payload, timeout=300)
        resp.raise_for_status()
        raw = resp.json()
    except requests.exceptions.ConnectionError:
        raise HTTPException(status_code=503, detail="Cannot connect to SAP server. Check network/VPN.")
    except requests.exceptions.Timeout:
        raise HTTPException(status_code=504, detail="SAP API timeout (300 s).")
    except requests.exceptions.HTTPError as exc:
        raise HTTPException(status_code=exc.response.status_code,
                            detail=f"SAP HTTP error: {exc.response.text[:300]}")
    except Exception as exc:
        raise HTTPException(status_code=500, detail=str(exc))
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

        # ── Fetch delta months per plant (sequential, shared NTLM session) ──
        plant_dfs: dict[str, pd.DataFrame] = {}
        months_done_global = total_cached_months
        rows_so_far_global = rows_from_cache
        sap_session        = requests.Session()
        sap_session.auth   = HttpNtlmAuth("", "")

        try:
            for plan in plans:
                plant        = plan["plant"]
                fetch_mode   = plan["fetch_mode"]
                delta_months = plan["delta_months"]
                existing_df  = plan["existing_df"]

                if fetch_mode == "hit":
                    plant_dfs[plant] = _filter_df_by_dates(existing_df, start_date, end_date)
                    continue

                new_dfs: list[pd.DataFrame] = []

                for ms, me, label in delta_months:
                    try:
                        records = await loop.run_in_executor(
                            None,
                            lambda s=ms, e=me, pl=plant: _fetch_sap_with_session(sap_session, pl, s, e),
                        )
                    except HTTPException as exc:
                        yield _sse({"phase": "error", "message": exc.detail})
                        return
                    except Exception as exc:
                        yield _sse({"phase": "error", "message": str(exc)})
                        return

                    if records:
                        month_df = parse_df(records)
                        new_dfs.append(month_df)
                        rows_so_far_global += len(month_df)

                    months_done_global += 1
                    month_label = f"{plant} · {label}" if len(plants) > 1 else label
                    yield _sse({
                        "phase": "fetching",
                        "progress": int(months_done_global / total_months_all * 100),
                        "months_done": months_done_global, "total_months": total_months_all,
                        "rows_so_far": rows_so_far_global, "month_label": month_label,
                        "cached": False,
                    })

                # Merge and update master cache for this plant
                new_combined = pd.concat(new_dfs, ignore_index=True) if new_dfs else pd.DataFrame()

                if fetch_mode == "extend_end":
                    full_df = pd.concat([existing_df, new_combined], ignore_index=True) if not new_combined.empty else existing_df
                    cache.set_master(plant, plan["new_master_start"], plan["new_master_end"], full_df)

                elif fetch_mode == "extend_start":
                    full_df = pd.concat([new_combined, existing_df], ignore_index=True) if not new_combined.empty else existing_df
                    cache.set_master(plant, plan["new_master_start"], plan["new_master_end"], full_df)

                else:  # full fetch
                    if new_combined.empty:
                        # No records for this plant — skip gracefully
                        plant_dfs[plant] = pd.DataFrame()
                        continue
                    full_df = new_combined
                    cache.set_master(plant, start_date, end_date, full_df)

                plant_dfs[plant] = _filter_df_by_dates(full_df, start_date, end_date)

        finally:
            sap_session.close()

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
ANALYTICS_SCHEMA_VERSION = "4"  # added by_plant per-group to material_groups


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
    df, _ = _get_session(req.session_id)
    dff   = apply_filters(df, req.filters)
    return compute_mg_plant_components(dff, COL_PPV, req.group, req.plant)


@app.post("/api/hierarchy-drill")
def hierarchy_drill(req: HierarchyDrillRequest):
    """Top materials by PPV impact for a specific hierarchy + month."""
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
    return {"items": items, "hierarchy": req.hierarchy_code, "month": req.year_month}


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

    return {
        "material":  req.material_number,
        "desc":      desc,
        "labels":    grp["YearMonth"].astype(str).tolist(),
        "std_price": [safe(v) for v in (grp["std_price"].tolist() if "std_price" in grp.columns else [])],
        "po_price":  [safe(v) for v in (grp["po_price"].tolist()  if "po_price"  in grp.columns else [])],
        "ppv":       [safe(v) for v in grp["ppv"].tolist()],
        "records":   [int(v) for v in grp["records"].tolist()],
    }


@app.post("/api/vendor-price-trend")
def vendor_price_trend(req: VendorPriceTrendRequest):
    """Monthly PO Price /1k per vendor for a single material."""
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

    return {"material": req.material_number, "labels": all_months, "vendors": vendors}


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
        "Total_Variance_Amount_num",
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
        "Total_Variance_Amount_num":  "PPV",
        "PO_Price_per_1000_num":      "PO Price/1k",
        "Standard_Price_for_1000_num":"Std Price/1k",
    }
    sub.rename(columns={k: v for k, v in rename.items() if k in sub.columns}, inplace=True)
    if "Date" in sub.columns:
        sub["Date"] = sub["Date"].astype(str).str[:10]
    records = sub.where(sub.notna(), None).to_dict("records")
    return {"records": records, "columns": list(sub.columns)}


# ── Price Calculator proxy (conexion_internalquery) ───────────────────────────

def _pricecalc_post(path: str, body: dict):
    try:
        r = requests.post(f"{PRICECALC_API_URL}{path}", json=body, timeout=30)
        r.raise_for_status()
        return r.json()
    except requests.exceptions.ConnectionError:
        raise HTTPException(
            status_code=503,
            detail=f"Price Calculator API not reachable at {PRICECALC_API_URL}. "
                   "Start the conexion_internalquery backend first."
        )
    except requests.exceptions.Timeout:
        raise HTTPException(status_code=504, detail="Price Calculator API timed out.")
    except requests.exceptions.HTTPError as e:
        detail = str(e)
        try:
            detail = e.response.json().get("detail", detail)
        except Exception:
            pass
        raise HTTPException(status_code=e.response.status_code if e.response else 502, detail=detail)


@app.post("/api/pricecalc/ampl")
def pricecalc_ampl(req: PriceCalcAmplRequest):
    return _pricecalc_post("/ampl-by-material", {"internal_part_number": req.internal_part_number})


@app.post("/api/pricecalc/internal-query")
def pricecalc_internal_query(req: PriceCalcIQRequest):
    return _pricecalc_post("/internal-query", {"mpns": req.mpns})


@app.post("/api/pricecalc/market-prices")
def pricecalc_market_prices(req: PriceCalcMarketRequest):
    return _pricecalc_post("/market-prices", {"mpns": req.mpns, "quantity": req.quantity})


# ── SAP batch pricing for MG drilldown modal ──────────────────────────────────

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

    loser_sap = _PPV_TO_SAP.get(req.loser_plant, req.loser_plant).upper()
    mats      = [m.strip().upper() for m in req.materials[:20]]

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

    return {"results": results}


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
