"""
ui/kpis.py
Executive Summary KPI row.
"""

import streamlit as st


def render_kpis(dff, PPV: str) -> None:
    total_ppv    = dff[PPV].sum()   if PPV in dff.columns else 0.0
    favorable    = dff.loc[dff[PPV] <= 0, PPV].sum() if PPV in dff.columns else 0.0
    desfavorable = dff.loc[dff[PPV] > 0,  PPV].sum() if PPV in dff.columns else 0.0
    n_vendors    = dff["Vendor_Name"].nunique()     if "Vendor_Name"     in dff.columns else 0
    n_materials  = dff["Material_Number"].nunique() if "Material_Number" in dff.columns else 0

    st.markdown('<div class="section-title">Executive Summary</div>', unsafe_allow_html=True)
    k1, k2, k3, k4, k5, k6 = st.columns(6)

    _ppv_bg    = "#16a34a" if total_ppv <= 0 else "#dc2626"
    k1.markdown(
        f"""<div style="background:{_ppv_bg};border-radius:8px;padding:14px 16px;text-align:center;">
            <p style="margin:0;font-size:0.78rem;font-weight:700;color:white;opacity:0.88;letter-spacing:0.03em;">Net PPV (USD)</p>
            <p style="margin:4px 0 0;font-size:1.35rem;font-weight:800;color:white;">${total_ppv:,.0f}</p>
        </div>""",
        unsafe_allow_html=True,
    )
    k2.metric("Favorable (USD)",    f"${favorable:,.0f}")
    k3.metric("Unfavorable (USD)",  f"${desfavorable:,.0f}")
    k4.metric("Records",            f"{len(dff):,}")
    k5.metric("Vendors",            f"{n_vendors:,}")
    k6.metric("Materials",          f"{n_materials:,}")
