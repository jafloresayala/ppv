"""backend/data_service.py — SAP response parsing and DataFrame construction."""

import pandas as pd
import requests as _http
from concurrent.futures import ThreadPoolExecutor, as_completed
from requests_ntlm import HttpNtlmAuth as _NtlmAuth

_NTLM = _NtlmAuth("", "")  # Windows pass-through — same as main SAP calls

try:
    import cache as _cache   # Redis-backed cache (graceful fallback to memory)
    _CACHE_OK = True
except Exception:
    _CACHE_OK = False


def sap_amount(val) -> float:
    """Parse SAP amounts: '0.01-' → -0.01, '1000.50' → 1000.50"""
    s = str(val).strip()
    if not s or s in ("", "0"):
        return 0.0
    if s.endswith("-"):
        try:
            return -float(s[:-1])
        except ValueError:
            return 0.0
    try:
        return float(s)
    except ValueError:
        return 0.0


def parse_df(records: list) -> pd.DataFrame:
    df = pd.DataFrame(records)
    if df.empty:
        return df

    if "Posting_Date_in_the_Document" in df.columns:
        raw = df["Posting_Date_in_the_Document"].astype(str).str.strip()
        df["Posting_Date"] = pd.to_datetime(raw, errors="coerce")

    for col in [
        "Total_Variance_Amount", "P_Price_difference", "Exchange_rate_difference",
        "MExtended_PO_Price", "M_Extended__Std_Amount",
        "P_Extended_PO_Price_cost_planning", "P_Extended__Std_Amount",
        "PO_Price_per_1000", "Standard_Price_for_1000",
    ]:
        if col in df.columns:
            df[col + "_num"] = df[col].apply(sap_amount)

    if "Quantity" in df.columns:
        df["Quantity_num"] = pd.to_numeric(df["Quantity"], errors="coerce").fillna(0)

    for col in df.select_dtypes(include="object").columns:
        df[col] = df[col].fillna("").astype(str)

    if "Posting_Date" in df.columns:
        valid = df["Posting_Date"].notna()
        df["YearMonth"] = ""
        df.loc[valid, "YearMonth"] = (
            df.loc[valid, "Posting_Date"].dt.to_period("M").astype(str)
        )
        df["PostingDay"] = None
        df.loc[valid, "PostingDay"] = df.loc[valid, "Posting_Date"].dt.normalize()

    return df


def extract_records(raw) -> list:
    if isinstance(raw, list):
        return raw
    if isinstance(raw, dict):
        for key in ("application/json", "value", "data", "result", "results"):
            if key in raw and isinstance(raw[key], list):
                return raw[key]
        return [raw]
    return []


def get_filter_options(df: pd.DataFrame) -> dict:
    opts: dict = {}
    if "Material_Group_Description" in df.columns:
        opts["material_groups"] = sorted(
            g for g in df["Material_Group_Description"].unique() if g
        )
    else:
        opts["material_groups"] = []
    if "Vendor_Name" in df.columns:
        opts["vendors"] = sorted(v for v in df["Vendor_Name"].unique() if v)
    else:
        opts["vendors"] = []
    return opts


def apply_filters(df: pd.DataFrame, filters: dict) -> pd.DataFrame:
    """Apply sidebar filters (material groups, vendors, plants, date range) to dataframe."""
    dff = df.copy()
    mgs = filters.get("material_groups")
    if mgs and "Material_Group_Description" in dff.columns:
        dff = dff[dff["Material_Group_Description"].isin(mgs)]
    vendors = filters.get("vendors")
    if vendors and "Vendor_Name" in dff.columns:
        dff = dff[dff["Vendor_Name"].isin(vendors)]
    plants = filters.get("plants")
    if plants and "Plant" in dff.columns:
        dff = dff[dff["Plant"].isin(plants)]
    date_start = filters.get("date_start")  # "YYYY-MM"
    date_end   = filters.get("date_end")    # "YYYY-MM"
    if (date_start or date_end) and "YearMonth" in dff.columns:
        if date_start:
            dff = dff[dff["YearMonth"] >= date_start]
        if date_end:
            dff = dff[dff["YearMonth"] <= date_end]
    return dff


# ─── Currency enrichment ──────────────────────────────────────────────────────

_SAP_CURRENCY_API = "http://nts5102/SapGeneralApi/api/Financials/FetchCurrencyRates"

# In-process cache: {(from_currency_upper, date_str): rate_float}
# Historical rates are immutable so this dict lives for the process lifetime.
_rate_cache: dict[tuple[str, str], float] = {}


def _fetch_one_rate(from_currency: str, date_str: str) -> float:
    """POST to FetchCurrencyRates and return abs(CurrencyRate).
    date_str must be 'YYYY-MM-DD'. Raises on any failure.
    """
    payload = {
        "RateType":     "M",
        "FromCurrency": from_currency,
        "ToCurrency":   "USD",
        "FromDate":     f"{date_str}T00:00:00",
        "ToDate":       f"{date_str}T00:00:00",
    }
    resp = _http.post(_SAP_CURRENCY_API, json=payload, auth=_NTLM, timeout=30)
    resp.raise_for_status()
    data = resp.json()
    if not data:
        raise ValueError(f"No rate returned for {from_currency} on {date_str}")
    rate = abs(sap_amount(str(data[0].get("CurrencyRate", "0"))))
    if rate == 0:
        raise ValueError(f"Zero rate for {from_currency} on {date_str}")
    return rate


def _get_rate(from_currency: str, date_str: str) -> float:
    """Return the M-rate (from_currency → USD) with multi-tier caching:
    in-process dict → Redis → SAP API. Falls back to 1.0 on any error.
    """
    key = (from_currency.strip().upper(), date_str[:10])
    if key in _rate_cache:
        return _rate_cache[key]

    # Redis lookup (survives process restarts; rates are immutable)
    if _CACHE_OK:
        rk = _cache.make_key("fxrate", key[0], key[1])
        cached = _cache.get_json(rk)
        if cached is not None:
            try:
                _rate_cache[key] = float(cached)
                return _rate_cache[key]
            except (TypeError, ValueError):
                pass

    # Network fetch
    try:
        rate = _fetch_one_rate(key[0], key[1])
    except Exception:
        rate = 1.0  # fallback: no conversion

    _rate_cache[key] = rate
    if _CACHE_OK:
        # 30-day TTL — historical M-rates don't change
        _cache.set_json(_cache.make_key("fxrate", key[0], key[1]), rate, 30 * 86400)
    return rate


def enrich_with_currency(df: pd.DataFrame) -> pd.DataFrame:
    """Add column 'PPDifference_currency' = P_Price_difference_num converted to USD.

    Formula per row:
        rate = FetchCurrencyRates(FromCurrency=Report_Currency, ToCurrency=USD, date=PostingDate)
        PPDifference_currency = P_Price_difference_num / rate

    Rows where Report_Currency == 'USD': rate = 1.0 (no API call, no division).
    Any other currency triggers the SAP call. On failure the row falls back to
    P_Price_difference_num unchanged (rate = 1.0).
    """
    COL_OUT = "PPDifference_currency"

    if "P_Price_difference_num" not in df.columns:
        df = df.copy()
        df[COL_OUT] = 0.0
        return df

    df = df.copy()
    # Default: same as source (handles USD rows and fallback cases)
    df[COL_OUT] = df["P_Price_difference_num"]

    if "Report_Currency" not in df.columns:
        return df

    # Resolve date column
    if "Posting_Date_in_the_Document" in df.columns:
        date_s = df["Posting_Date_in_the_Document"].astype(str).str[:10]
    elif "Posting_Date" in df.columns:
        date_s = df["Posting_Date"].astype(str).str[:10]
    else:
        return df

    curr_s     = df["Report_Currency"].astype(str).str.strip().str.upper()
    needs_conv = curr_s != "USD"   # MXN, THB, CNY, EUR, etc. — any non-USD triggers conversion

    if not needs_conv.any():
        return df

    # Collect unique (currency, date) pairs that aren't already cached
    pairs       = set(zip(curr_s[needs_conv].values, date_s[needs_conv].values))
    pairs_todo  = [(c, d) for c, d in pairs if (c.strip().upper(), d[:10]) not in _rate_cache]

    # Pre-warm cache in PARALLEL (network-bound → ThreadPoolExecutor scales well)
    if pairs_todo:
        max_workers = min(32, len(pairs_todo))
        with ThreadPoolExecutor(max_workers=max_workers) as pool:
            futures = {pool.submit(_get_rate, c, d): (c, d) for c, d in pairs_todo}
            for fut in as_completed(futures):
                try:
                    fut.result()
                except Exception:
                    pass  # _get_rate already handles fallback to 1.0

    # Vectorized conversion using the now-warm cache (pure dict lookups, no network)
    rates = pd.Series(
        [_get_rate(c, d) for c, d in zip(curr_s[needs_conv].values, date_s[needs_conv].values)],
        index=df[needs_conv].index,
        dtype=float,
    )
    df.loc[needs_conv, COL_OUT] = df.loc[needs_conv, "P_Price_difference_num"] / rates

    return df
