"""
sap_utils.py
SAP-specific parsing helpers: amount strings, DataFrame construction, record extraction.
"""

import pandas as pd


def _sap_amount(val) -> float:
    """Parse SAP amounts: '0.01-' → -0.01, '100.50' → 100.50"""
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


def _parse_df(records: list) -> pd.DataFrame:
    """Convert JSON records list to a clean typed DataFrame."""
    df = pd.DataFrame(records)
    if df.empty:
        return df

    # Dates — auto-detect format (supports YYYY-MM-DD and YYYYMMDD)
    if "Posting_Date_in_the_Document" in df.columns:
        raw_dates = df["Posting_Date_in_the_Document"].astype(str).str.strip()
        df["Posting_Date"] = pd.to_datetime(raw_dates, errors="coerce")

    # SAP amounts (trailing '-' = negative)
    for col in ["Total_Variance_Amount", "P_Price_difference",
                "Exchange_rate_difference", "MExtended_PO_Price",
                "M_Extended__Std_Amount", "P_Extended_PO_Price_cost_planning",
                "P_Extended__Std_Amount", "PO_Price_per_1000",
                "Standard_Price_for_1000"]:
        if col in df.columns:
            df[col + "_num"] = df[col].apply(_sap_amount)

    # Direct numerics
    if "Quantity" in df.columns:
        df["Quantity_num"] = pd.to_numeric(df["Quantity"], errors="coerce").fillna(0)

    # Text columns: fill NaN
    for col in df.select_dtypes(include="object").columns:
        df[col] = df[col].fillna("").astype(str)

    # Month and day columns (for trend) — only rows with valid date
    if "Posting_Date" in df.columns:
        valid = df["Posting_Date"].notna()
        df["YearMonth"] = ""
        df.loc[valid, "YearMonth"] = (
            df.loc[valid, "Posting_Date"].dt.to_period("M").astype(str)
        )
        df["PostingDay"] = pd.NaT
        df.loc[valid, "PostingDay"] = df.loc[valid, "Posting_Date"].dt.normalize()

    return df


def _extract_records(raw) -> list:
    """Handle response with or without 'application/json' wrapper."""
    if isinstance(raw, list):
        return raw
    if isinstance(raw, dict):
        for key in ("application/json", "value", "data", "result", "results"):
            if key in raw and isinstance(raw[key], list):
                return raw[key]
        return [raw]
    return []
