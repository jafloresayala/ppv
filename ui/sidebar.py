"""
ui/sidebar.py
Sidebar filters (Material Group, Vendor). Returns the filtered DataFrame.
"""

import pandas as pd
import streamlit as st


def render_sidebar(df: pd.DataFrame, params: dict) -> pd.DataFrame:
    """Render sidebar filters and return the filtered dataframe."""
    with st.sidebar:
        st.markdown("### Filters")

        # ── Material Group ────────────────────────────────────────────────
        mat_groups = (
            sorted(df["Material_Group_Description"].unique())
            if "Material_Group_Description" in df.columns else []
        )
        all_mg = st.checkbox("All Material Groups", value=True, key="chk_all_mg")
        if all_mg:
            sel_mgroup = mat_groups
        else:
            sel_mgroup = st.multiselect(
                "Material Group", mat_groups,
                default=mat_groups, key="sel_mgroup",
                placeholder="Select groups...",
            )

        st.markdown("")

        # ── Vendor ────────────────────────────────────────────────────────
        vendors = (
            sorted(df["Vendor_Name"].unique())
            if "Vendor_Name" in df.columns else []
        )
        all_vend = st.checkbox("All Vendors", value=True, key="chk_all_vend")
        if all_vend:
            sel_vendor = vendors
        else:
            sel_vendor = st.multiselect(
                "Vendor", vendors,
                default=vendors, key="sel_vendor",
                placeholder="Select vendors...",
            )

        st.markdown("---")
        st.caption(f"Plant: {params.get('Plant', '')}")
        st.caption(
            f"Period: {params.get('PostingStartDate', '')} > {params.get('PostingEndDate', '')}"
        )

    # Apply filters
    mask = pd.Series([True] * len(df), index=df.index)
    if sel_mgroup and "Material_Group_Description" in df.columns:
        mask &= df["Material_Group_Description"].isin(sel_mgroup)
    if sel_vendor and "Vendor_Name" in df.columns:
        mask &= df["Vendor_Name"].isin(sel_vendor)

    return df[mask].copy()
