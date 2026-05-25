"""backend/data_service.py — SAP response parsing and DataFrame construction."""

import pandas as pd


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
    """Apply sidebar filters (material groups, vendors) to dataframe."""
    dff = df.copy()
    mgs = filters.get("material_groups")
    if mgs and "Material_Group_Description" in dff.columns:
        dff = dff[dff["Material_Group_Description"].isin(mgs)]
    vendors = filters.get("vendors")
    if vendors and "Vendor_Name" in dff.columns:
        dff = dff[dff["Vendor_Name"].isin(vendors)]
    return dff
