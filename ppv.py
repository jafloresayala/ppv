"""
ppv.py
Corporate Purchase Price Variance (PPV) Dashboard — SAP General API.
"""

import json
import requests
import pandas as pd
import numpy as np
import plotly.express as px
import plotly.graph_objects as go
from plotly.subplots import make_subplots
import streamlit as st
import streamlit.components.v1 as _stc
from datetime import date, timedelta
from requests_ntlm import HttpNtlmAuth
import os

# ─── Configuracion ────────────────────────────────────────────────────────────
API_URL = "http://nts5102/SapGeneralApi/api/Financials/PPV"

st.set_page_config(
    page_title="PPV Dashboard",
    layout="wide",
    initial_sidebar_state="collapsed",
)

st.markdown("""
<style>
    .stApp { background: #f0f4f9; }
    .block-container { padding-top: 3.5rem; padding-bottom: 2rem; max-width: 1400px; }
    div[data-testid="stMetric"] {
        background: #fff;
        border: 1px solid #dde5f0;
        border-radius: 14px;
        padding: 0.85rem 1.1rem;
        box-shadow: 0 4px 14px rgba(0,0,0,0.05);
    }
    div[data-testid="stMetricValue"] { font-size: 1.6rem !important; }
    div[data-testid="stMetricLabel"] { font-size: 0.8rem !important; color: #667; }
    .section-title {
        font-size: 1.05rem;
        font-weight: 700;
        color: #1a2a44;
        margin: 1.2rem 0 0.4rem 0;
        padding-bottom: 0.25rem;
        border-bottom: 2px solid #dde5f0;
    }
    [data-testid="stTabs"] button { font-size: 0.9rem; font-weight: 600; }
</style>
""", unsafe_allow_html=True)


# ─── Utilidades de parseo SAP ─────────────────────────────────────────────────
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


# ─── Colores corporativos ──────────────────────────────────────────────────────
COLOR_GOOD    = "#16a34a"
COLOR_BAD     = "#dc2626"
COLOR_NEUTRAL = "#3b82f6"


# ─── Helpers de graficas ───────────────────────────────────────────────────────
def _bar(df_agg, x, y, title, color_by_sign=True, top_n=None, orientation="v"):
    if top_n:
        df_agg = df_agg.nlargest(top_n, y) if orientation == "v" else df_agg.nlargest(top_n, x)
    if orientation == "h":
        df_agg = df_agg.sort_values(x, ascending=True)
    if color_by_sign:
        df_agg = df_agg.copy()
        col_val = x if orientation == "h" else y
        df_agg["_color"] = df_agg[col_val].apply(
            lambda v: "Favorable" if v <= 0 else "Unfavorable"
        )
        color_map = {"Favorable": COLOR_GOOD, "Unfavorable": COLOR_BAD}
        fig = px.bar(
            df_agg, x=x, y=y, color="_color", color_discrete_map=color_map,
            title=title, orientation=orientation, labels={"_color": ""},
        )
    else:
        fig = px.bar(df_agg, x=x, y=y, title=title, orientation=orientation,
                     color_discrete_sequence=[COLOR_NEUTRAL])
    fig.update_layout(
        plot_bgcolor="white", paper_bgcolor="white",
        margin=dict(t=40, b=10, l=10, r=10), title_font_size=14,
        showlegend=color_by_sign,
        legend=dict(orientation="h", yanchor="bottom", y=1.01, xanchor="right", x=1),
    )
    fig.update_traces(marker_line_width=0)
    return fig


def _line(df_ts, x, y, title):
    fig = px.line(df_ts, x=x, y=y, markers=True, title=title,
                  color_discrete_sequence=[COLOR_NEUTRAL])
    fig.add_hline(y=0, line_dash="dash", line_color="#9ca3af", line_width=1)
    fig.update_layout(
        plot_bgcolor="white", paper_bgcolor="white",
        margin=dict(t=40, b=10, l=10, r=10), title_font_size=14,
    )
    return fig


def _best_outlier_model(values: np.ndarray):
    """
    Compare IQR, Z-Score, MAD Z-Score and Isolation Forest.
    Choose the model whose inlier set is most normal (lowest KS statistic).
    Returns: (mask_bool, model_name, dict_scores)
    """
    from scipy import stats as _stats

    n = len(values)
    if n < 4:
        return np.zeros(n, dtype=bool), "Datos insuficientes", {}

    def _ks_score(mask, vals):
        inliers = vals[~mask]
        if len(inliers) < 4:
            return float("inf")
        normalized = (inliers - inliers.mean()) / (inliers.std() + 1e-9)
        stat, _ = _stats.kstest(normalized, "norm")
        return round(float(stat), 5)

    # IQR
    Q1, Q3 = np.percentile(values, [25, 75])
    IQR_val = Q3 - Q1
    iqr_mask = (values < Q1 - 1.5 * IQR_val) | (values > Q3 + 1.5 * IQR_val)

    # Z-Score
    mu, sigma = values.mean(), values.std()
    z_mask = np.abs((values - mu) / (sigma + 1e-9)) > 2.5

    # Z-Score MAD (Modified Z-Score)
    med = np.median(values)
    mad = np.median(np.abs(values - med))
    mz_mask = np.abs(0.6745 * (values - med) / (mad + 1e-9)) > 3.5

    candidates = {
        "IQR": iqr_mask,
        "Z-Score": z_mask,
        "Z-Score MAD": mz_mask,
    }

    # Isolation Forest (opcional)
    try:
        from sklearn.ensemble import IsolationForest as _IF
        _if_pred = _IF(contamination="auto", random_state=42, n_estimators=100).fit_predict(
            values.reshape(-1, 1)
        )
        candidates["Isolation Forest"] = _if_pred == -1
    except Exception:
        pass

    scores = {name: _ks_score(mask, values) for name, mask in candidates.items()}
    best_name = min(scores, key=lambda k: scores[k])
    return candidates[best_name].astype(bool), best_name, scores


# ─── Interfaz de consulta ─────────────────────────────────────────────────────
_script_dir = os.path.dirname(os.path.abspath(__file__))
_logo_path = os.path.join(_script_dir, "img", "kim-logo.png")

_hdr_logo, _hdr_title = st.columns([0.80, 0.92])
with _hdr_logo:
    if os.path.exists(_logo_path):
        st.image(_logo_path, width=1200)
    else:
        st.warning("Logo no encontrado")
with _hdr_title:
    st.markdown("## PPV - Purchase Price Variance")
    st.caption("Corporate statistical analysis of purchase price variance.")

with st.form("ppv_form"):
    c1, c2, c3, c_btn = st.columns([0.8, 1, 1, 0.7])
    with c1:
        st.markdown("**Plant**")
        plant = st.text_input(" ", value="0020", label_visibility="collapsed", placeholder="0020")
    with c2:
        st.markdown("**Posting Start Date**")
        start_date = st.date_input(" ", value=date.today() - timedelta(days=7),
                                   label_visibility="collapsed", key="ppv_start")
    with c3:
        st.markdown("**Posting End Date**")
        end_date = st.date_input(" ", value=date.today(),
                                 label_visibility="collapsed", key="ppv_end")
    with c_btn:
        st.markdown("&nbsp;", unsafe_allow_html=True)
        submitted = st.form_submit_button("Query", use_container_width=True, type="primary")

# ─── Consulta & carga ─────────────────────────────────────────────────────────
if submitted:
    if not plant.strip():
        st.warning("Enter a plant.")
        st.stop()
    if start_date > end_date:
        st.warning("Start date cannot be greater than end date.")
        st.stop()

    payload = {
        "Plant": plant.strip(),
        "PostingStartDate": start_date.strftime("%Y%m%d"),
        "PostingEndDate": end_date.strftime("%Y%m%d"),
    }

    with st.spinner("Querying API..."):
        try:
            auth = HttpNtlmAuth("", "")
            resp = requests.post(API_URL, json=payload, auth=auth, timeout=90)
            resp.raise_for_status()
            raw = resp.json()
        except requests.exceptions.ConnectionError:
            st.error("Cannot connect to nts5102. Check network / VPN.")
            st.stop()
        except requests.exceptions.Timeout:
            st.error("Timeout (90s). API took too long.")
            st.stop()
        except requests.exceptions.HTTPError as exc:
            st.error(f"Error HTTP {exc.response.status_code}: {exc.response.text[:400]}")
            st.stop()
        except Exception as exc:
            st.error(f"Unexpected error: {exc}")
            st.stop()

    records = _extract_records(raw)
    if not records:
        st.info("API responded successfully but returned no records.")
        st.stop()

    df = _parse_df(records)
    st.session_state["ppv_df"]     = df
    st.session_state["ppv_params"] = payload

# ─── Dashboard ─────────────────────────────────────────────────────────────────
if "ppv_df" not in st.session_state:
    st.stop()

df: pd.DataFrame = st.session_state["ppv_df"]
params            = st.session_state["ppv_params"]

PPV   = "Total_Variance_Amount_num"
PRICE = "P_Price_difference_num"
FX    = "Exchange_rate_difference_num"

# ─── Filtros laterales ─────────────────────────────────────────────────────────
with st.sidebar:
    st.markdown("### Filters")

    # ── Material Group ────────────────────────────────────────────────────────
    mat_groups = sorted(df["Material_Group_Description"].unique()) if "Material_Group_Description" in df.columns else []
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

    # ── Proveedor ──────────────────────────────────────────────────────────────
    vendors = sorted(df["Vendor_Name"].unique()) if "Vendor_Name" in df.columns else []
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
    st.caption(f"Plant: {params['Plant']}")
    st.caption(f"Period: {params['PostingStartDate']} > {params['PostingEndDate']}")

# Aplicar filtros
mask = pd.Series([True] * len(df), index=df.index)
if sel_mgroup and "Material_Group_Description" in df.columns:
    mask &= df["Material_Group_Description"].isin(sel_mgroup)
if sel_vendor and "Vendor_Name" in df.columns:
    mask &= df["Vendor_Name"].isin(sel_vendor)
dff = df[mask].copy()

if dff.empty:
    st.warning("No data with current filters.")
    st.stop()

# ─── KPIs ─────────────────────────────────────────────────────────────────────
total_ppv    = dff[PPV].sum() if PPV in dff.columns else 0.0
favorable    = dff.loc[dff[PPV] <= 0, PPV].sum() if PPV in dff.columns else 0.0
desfavorable = dff.loc[dff[PPV] > 0,  PPV].sum() if PPV in dff.columns else 0.0
n_vendors    = dff["Vendor_Name"].nunique()        if "Vendor_Name" in dff.columns else 0
n_materials  = dff["Material_Number"].nunique()    if "Material_Number" in dff.columns else 0

st.markdown('<div class="section-title">Executive Summary</div>', unsafe_allow_html=True)
k1, k2, k3, k4, k5, k6 = st.columns(6)
_ppv_bg    = "#16a34a" if total_ppv <= 0 else "#dc2626"
_ppv_label = "Net PPV (USD)"
_ppv_val   = f"${total_ppv:,.0f}"
k1.markdown(
    f"""<div style="background:{_ppv_bg};border-radius:8px;padding:14px 16px;text-align:center;">
        <p style="margin:0;font-size:0.78rem;font-weight:700;color:white;opacity:0.88;letter-spacing:0.03em;">{_ppv_label}</p>
        <p style="margin:4px 0 0;font-size:1.35rem;font-weight:800;color:white;">{_ppv_val}</p>
    </div>""",
    unsafe_allow_html=True,
)
k2.metric("Favorable (USD)",    f"${favorable:,.0f}")
k3.metric("Unfavorable (USD)",  f"${desfavorable:,.0f}")
k4.metric("Records",            f"{len(dff):,}")
k5.metric("Vendors",            f"{n_vendors:,}")
k6.metric("Materials",          f"{n_materials:,}")

# ─── Session state ─────────────────────────────────────────────────────────────────────
for _k, _v in [
    ("ppv_sel_mat",        None),
    ("ppv_sel_mg_dist",    None),
    ("ppv_sel_trend_per",  None),
    ("ppv_sel_mg_tree",    None),
    ("ppv_sel_mg_trend",   None),
    ("ppv_ph_sel",         []),
]:
    if _k not in st.session_state:
        st.session_state[_k] = _v

# ─── Tabs ──────────────────────────────────────────────────────────────────────
tabs = st.tabs([
    "Time Trend",
    "Material Group",
    "Vendors",
    "Materials",
    "Product Hierarchy",
    "Distribution",
    "Impact",
    "Search",
    "🤖 AI",
])

# ── Tab 1: Tendencia temporal ─────────────────────────────────────────────────
with tabs[0]:
    has_dates = "YearMonth" in dff.columns and PPV in dff.columns
    ts_data   = dff[dff["YearMonth"] != ""].copy() if has_dates else pd.DataFrame()

    if ts_data.empty:
        st.info("No date data available or all dates are invalid.")
    else:
        unique_months = ts_data["YearMonth"].nunique()

        if unique_months <= 1 and "PostingDay" in ts_data.columns:
            # Short range: group by day
            ts = (
                ts_data[ts_data["PostingDay"].notna()]
                .groupby("PostingDay")[PPV]
                .sum().reset_index()
                .rename(columns={"PostingDay": "Date", PPV: "PPV_Total"})
                .sort_values("Date")
            )
            ts["Date"] = ts["Date"].astype(str)
            x_col       = "Date"
            lbl_detail  = "Daily detail"
            title_line  = "Net PPV by Day"
            title_area  = "Cumulative PPV by Day"
        else:
            # Long range: group by month
            ts = (
                ts_data.groupby("YearMonth")[PPV]
                .sum().reset_index()
                .rename(columns={"YearMonth": "Month", PPV: "PPV_Total"})
                .sort_values("Month")
            )
            x_col      = "Month"
            lbl_detail = "Monthly detail"
            title_line = "Net PPV by Month"
            title_area = "Cumulative PPV"

        ts["PPV_Acumulado"] = ts["PPV_Total"].cumsum()
        _bar_colors = ["#ef4444" if v > 0 else "#22c55e" for v in ts["PPV_Total"]]

        fig_combined = make_subplots(specs=[[{"secondary_y": True}]])

        # Bars Net PPV (left axis)
        fig_combined.add_trace(
            go.Bar(
                x=ts[x_col], y=ts["PPV_Total"],
                name="Net PPV",
                marker_color=_bar_colors,
                opacity=0.85,
            ),
            secondary_y=False,
        )

        # Line + area Cumulative PPV (right axis)
        fig_combined.add_trace(
            go.Scatter(
                x=ts[x_col], y=ts["PPV_Acumulado"],
                name="Cumulative PPV",
                mode="lines+markers",
                line=dict(color=COLOR_NEUTRAL, width=2),
                marker=dict(size=6),
                fill="tozeroy",
                fillcolor="rgba(107,114,128,0.12)",
            ),
            secondary_y=True,
        )

        fig_combined.add_hline(y=0, line_dash="dash", line_color="#9ca3af", line_width=1)
        fig_combined.update_layout(
            title=title_line + " + " + title_area,
            plot_bgcolor="white",
            paper_bgcolor="white",
            margin=dict(t=40, b=10, l=10, r=10),
            title_font_size=14,
            legend=dict(orientation="h", yanchor="bottom", y=1.02, xanchor="right", x=1),
            bargap=0.25,
        )
        fig_combined.update_yaxes(title_text="Net PPV (USD)", secondary_y=False, showgrid=True, gridcolor="#f3f4f6")
        fig_combined.update_yaxes(title_text="Cumulative PPV (USD)", secondary_y=True, showgrid=False)
        st.plotly_chart(fig_combined, use_container_width=True)
        with st.expander(f"{lbl_detail}", expanded=False):
            ts_fmt = ts.copy()
            ts_fmt["PPV_Total"]     = ts_fmt["PPV_Total"].map("${:,.2f}".format)
            ts_fmt["PPV_Acumulado"] = ts_fmt["PPV_Acumulado"].map("${:,.2f}".format)
            st.dataframe(ts_fmt, use_container_width=True, hide_index=True)

# ── Tab 2: Material Group ─────────────────────────────────────────────────────
with tabs[1]:
    if "Material_Group_Description" in dff.columns and PPV in dff.columns:
        col_l, col_r = st.columns(2)
        mg = (
            dff.groupby("Material_Group_Description")[PPV]
            .sum().reset_index()
            .rename(columns={PPV: "PPV_Total"})
            .sort_values("PPV_Total", ascending=False)
        )
        with col_l:
            _mg_bar_fig = _bar(mg, "Material_Group_Description", "PPV_Total",
                               "PPV by Material Group (Top 20)", top_n=20)
            ev_mg_bar = st.plotly_chart(
                _mg_bar_fig,
                use_container_width=True,
                on_select="rerun",
                key="mg_bar_sel",
            )
            # Detectar seleccion en la barra
            _sel_from_bar = None
            if ev_mg_bar and ev_mg_bar.selection and ev_mg_bar.selection.points:
                _sel_from_bar = ev_mg_bar.selection.points[0].get("x")
            # Siempre sincronizar session_state con el estado actual del chart
            st.session_state["ppv_sel_mg_tree"] = _sel_from_bar
            _sel_mg_tree = _sel_from_bar
        with col_r:
            df_tree = mg.copy()
            df_tree["Abs_PPV"] = df_tree["PPV_Total"].abs()
            df_tree["Type"] = df_tree["PPV_Total"].apply(lambda v: "Favorable" if v <= 0 else "Unfavorable")
            fig_tree = px.treemap(
                df_tree, path=["Type", "Material_Group_Description"],
                values="Abs_PPV", color="PPV_Total",
                color_continuous_scale=["#16a34a", "#f9fafb", "#dc2626"],
                color_continuous_midpoint=0,
                title="PPV Proportion by Material Group",
            )
            fig_tree.update_layout(margin=dict(t=40, b=5))
            st.plotly_chart(fig_tree, use_container_width=True)

        # ── Drill-down del grupo seleccionado en el treemap ────────────────
        if _sel_mg_tree:
            st.markdown("---")
            st.markdown(f"#### Detail — `{_sel_mg_tree}`")
            _df_tree_sel = dff[dff["Material_Group_Description"] == _sel_mg_tree]
            _t1, _t2, _t3, _t4 = st.columns(4)
            _t1.metric("Records",           f"{len(_df_tree_sel):,}")
            _mg_total_ppv = _df_tree_sel[PPV].sum()
            _mg_ppv_bg    = "#16a34a" if _mg_total_ppv <= 0 else "#dc2626"
            _t2.markdown(
                f"""<div style="background:{_mg_ppv_bg};border-radius:8px;padding:14px 16px;text-align:center;">
                    <p style="margin:0;font-size:0.78rem;font-weight:700;color:white;opacity:0.88;letter-spacing:0.03em;">Total PPV (USD)</p>
                    <p style="margin:4px 0 0;font-size:1.35rem;font-weight:800;color:white;">${_mg_total_ppv:,.2f}</p>
                </div>""",
                unsafe_allow_html=True,
            )
            _t3.metric("Unfavorable (USD)",  f"${_df_tree_sel.loc[_df_tree_sel[PPV]>0, PPV].sum():,.2f}")
            _t4.metric("Favorable (USD)",    f"${_df_tree_sel.loc[_df_tree_sel[PPV]<=0, PPV].sum():,.2f}")

            if "Material_Number" in _df_tree_sel.columns:
                _by_mat = (
                    _df_tree_sel.groupby(["Material_Number", "Material_Description"])
                    .agg(PPV_Total=(PPV, "sum"), Records=(PPV, "count"))
                    .reset_index()
                )
                _desf = _by_mat[_by_mat["PPV_Total"] > 0].sort_values("PPV_Total", ascending=False).head(10).copy()
                _fav  = _by_mat[_by_mat["PPV_Total"] <= 0].sort_values("PPV_Total").head(10).copy()

                _col_desf, _col_fav = st.columns(2)
                with _col_desf:
                    _hd_desf, _tg_desf = st.columns([3, 1])
                    _hd_desf.markdown("**Top 10 unfavorable components 🔴**")
                    _show_tbl_desf = _tg_desf.toggle("Table", value=False, key="tg_desf")
                    if not _desf.empty:
                        if _show_tbl_desf:
                            _desf_fmt = _desf.copy()
                            _desf_fmt["PPV_Total"] = _desf_fmt["PPV_Total"].map("${:,.2f}".format)
                            st.dataframe(_desf_fmt, use_container_width=True, hide_index=True)
                        else:
                            _fig_desf = go.Figure(go.Bar(
                                x=_desf["PPV_Total"],
                                y=_desf["Material_Number"],
                                orientation="h",
                                marker_color="#dc2626",
                                text=_desf["PPV_Total"].map("${:,.2f}".format),
                                textposition="outside",
                                hovertemplate="%{y}<br>PPV: %{x:$,.2f}<extra></extra>",
                            ))
                            _fig_desf.update_layout(
                                plot_bgcolor="white", paper_bgcolor="white",
                                margin=dict(t=10, b=10, l=10, r=80),
                                yaxis=dict(autorange="reversed"),
                                height=320,
                            )
                            st.plotly_chart(_fig_desf, use_container_width=True)
                    else:
                        st.caption("No unfavorable components.")
                with _col_fav:
                    _hd_fav, _tg_fav = st.columns([3, 1])
                    _hd_fav.markdown("**Top 10 favorable components 🟢**")
                    _show_tbl_fav = _tg_fav.toggle("Table", value=False, key="tg_fav")
                    if not _fav.empty:
                        if _show_tbl_fav:
                            _fav_fmt = _fav.copy()
                            _fav_fmt["PPV_Total"] = _fav_fmt["PPV_Total"].map("${:,.2f}".format)
                            st.dataframe(_fav_fmt, use_container_width=True, hide_index=True)
                        else:
                            _fig_fav = go.Figure(go.Bar(
                                x=_fav["PPV_Total"],
                                y=_fav["Material_Number"],
                                orientation="h",
                                marker_color="#16a34a",
                                text=_fav["PPV_Total"].map("${:,.2f}".format),
                                textposition="outside",
                                hovertemplate="%{y}<br>PPV: %{x:$,.2f}<extra></extra>",
                            ))
                            _fig_fav.update_layout(
                                plot_bgcolor="white", paper_bgcolor="white",
                                margin=dict(t=10, b=10, l=10, r=80),
                                yaxis=dict(autorange="reversed"),
                                height=320,
                            )
                            st.plotly_chart(_fig_fav, use_container_width=True)
                    else:
                        st.caption("No favorable components.")

                # Group trend over time
                if "YearMonth" in _df_tree_sel.columns:
                    _ts_tree = (
                        _df_tree_sel[_df_tree_sel["YearMonth"] != ""]
                        .groupby("YearMonth")[PPV].sum()
                        .reset_index().sort_values("YearMonth")
                    )
                    if not _ts_tree.empty:
                        # ── Trend line + anomaly rings (2σ) + bands ───────────
                        import numpy as np
                        _ts_tree = _ts_tree.reset_index(drop=True)
                        _ts_x       = np.arange(len(_ts_tree))
                        _ts_y       = _ts_tree[PPV].values
                        _ts_z       = np.polyfit(_ts_x, _ts_y, 1)
                        _ts_trend_y = np.polyval(_ts_z, _ts_x)
                        _ts_resid   = _ts_y - _ts_trend_y
                        _ts_sigma   = _ts_resid.std()
                        _ts_upper   = _ts_trend_y + 2 * _ts_sigma
                        _ts_lower   = _ts_trend_y - 2 * _ts_sigma
                        _ts_anom    = _ts_tree[np.abs(_ts_resid) > 2 * _ts_sigma]

                        # Trend direction badge
                        _slope       = _ts_z[0]
                        _range       = _ts_y.max() - _ts_y.min() if len(_ts_y) > 1 else 1
                        _slope_norm  = abs(_slope) / (_range if _range != 0 else 1)
                        if _slope_norm < 0.03:
                            _trend_lbl, _trend_bg, _trend_icon = "Normal", "#6b7280", "➡️"
                        elif _slope > 0:
                            _trend_lbl, _trend_bg, _trend_icon = "Upward", "#dc2626", "📈"
                        else:
                            _trend_lbl, _trend_bg, _trend_icon = "Downward", "#16a34a", "📉"

                        st.markdown("**Group PPV Trend**")
                        _fig_mg_trend = _line(_ts_tree, "YearMonth", PPV, f"Trend — {_sel_mg_tree}")
                        # Badge inside chart as annotation
                        _fig_mg_trend.add_annotation(
                            text=f"{_trend_icon} {_trend_lbl}",
                            xref="paper", yref="paper",
                            x=0.01, y=0.97,
                            showarrow=False,
                            font=dict(size=13, color="white"),
                            bgcolor=_trend_bg,
                            bordercolor=_trend_bg,
                            borderwidth=1,
                            borderpad=6,
                            opacity=0.92,
                        )

                        # Upper band
                        _fig_mg_trend.add_trace(go.Scatter(
                            x=_ts_tree["YearMonth"], y=_ts_upper.tolist(),
                            mode="lines", name="Upper (2σ)",
                            line=dict(color="#f97316", width=1.5, dash="dash"),
                            hovertemplate="Upper 2σ: %{y:$,.0f}<extra></extra>",
                        ))
                        # Lower band
                        _fig_mg_trend.add_trace(go.Scatter(
                            x=_ts_tree["YearMonth"], y=_ts_lower.tolist(),
                            mode="lines", name="Lower (2σ)",
                            line=dict(color="#3b82f6", width=1.5, dash="dash"),
                            fill="tonexty",
                            fillcolor="rgba(99,102,241,0.07)",
                            hovertemplate="Lower 2σ: %{y:$,.0f}<extra></extra>",
                        ))
                        # Trend line
                        _fig_mg_trend.add_trace(go.Scatter(
                            x=_ts_tree["YearMonth"], y=_ts_trend_y.tolist(),
                            mode="lines", name="Trend",
                            line=dict(color="#6366f1", width=2, dash="dot"),
                            hovertemplate="Trend: %{y:$,.0f}<extra></extra>",
                        ))
                        # Anomaly rings
                        if not _ts_anom.empty:
                            _fig_mg_trend.add_trace(go.Scatter(
                                x=_ts_anom["YearMonth"],
                                y=_ts_anom[PPV],
                                mode="markers",
                                name="Anomaly (>2σ)",
                                marker=dict(
                                    symbol="circle-open", size=20,
                                    color="#dc2626", line=dict(width=2.5, color="#dc2626"),
                                ),
                                hovertemplate="Anomaly: %{y:$,.0f}<extra></extra>",
                            ))
                        _ev_mg_trend = st.plotly_chart(
                            _fig_mg_trend, use_container_width=True,
                            on_select="rerun", key="mg_trend_sel",
                        )
                        # Detectar punto seleccionado — siempre sincronizar
                        _sel_mg_per = None
                        if _ev_mg_trend and _ev_mg_trend.selection and _ev_mg_trend.selection.points:
                            _raw_x_mg = _ev_mg_trend.selection.points[0].get("x", "")
                            _sel_mg_per = str(_raw_x_mg)[:7]  # normalizar a YYYY-MM
                        st.session_state["ppv_sel_mg_trend"] = _sel_mg_per

                        if _sel_mg_per:
                            _df_mg_per = _df_tree_sel[_df_tree_sel["YearMonth"] == _sel_mg_per]
                            st.markdown(f"##### Records — `{_sel_mg_tree}` · `{_sel_mg_per}`")
                            _rp1, _rp2, _rp3 = st.columns(3)
                            _rp1.metric("Records",        f"{len(_df_mg_per):,}")
                            _rp2_val = _df_mg_per[PPV].sum()
                            _rp2_bg  = "#16a34a" if _rp2_val <= 0 else "#dc2626"
                            _rp2.markdown(
                                f"""<div style="background:{_rp2_bg};border-radius:8px;padding:14px 16px;text-align:center;">
                                    <p style="margin:0;font-size:0.78rem;font-weight:700;color:white;opacity:0.88;">Total PPV (USD)</p>
                                    <p style="margin:4px 0 0;font-size:1.35rem;font-weight:800;color:white;">${_rp2_val:,.2f}</p>
                                </div>""", unsafe_allow_html=True,
                            )
                            _rp3.metric("Materials",       f"{_df_mg_per['Material_Number'].nunique():,}" if 'Material_Number' in _df_mg_per.columns else "—")

                            # Top contribuidores del periodo
                            if "Material_Number" in _df_mg_per.columns:
                                _per_mat = (
                                    _df_mg_per.groupby(["Material_Number", "Material_Description"])
                                    .agg(PPV_Total=(PPV, "sum"), Records=(PPV, "count"))
                                    .reset_index()
                                    .sort_values("PPV_Total", ascending=False)
                                )
                                _per_mat["% of month"] = (
                                    _per_mat["PPV_Total"] / _df_mg_per[PPV].sum() * 100
                                ).map("{:.1f}%".format)
                                _per_mat["PPV_Total"] = _per_mat["PPV_Total"].map("${:,.2f}".format)
                                st.markdown("**Period contributors (by material)**")
                                st.dataframe(_per_mat, use_container_width=True, hide_index=True)

                            # Registros individuales del periodo
                            _show_per_cols = [c for c in [
                                "Posting_Date_in_the_Document", "Material_Number",
                                "Material_Description", "Vendor_Name",
                                "Total_Variance_Amount",
                                "MExtended_PO_Price", "M_Extended__Std_Amount",
                            ] if c in _df_mg_per.columns]
                            if _show_per_cols:
                                st.markdown("**Individual records for the period**")
                                _heat_df = (
                                    _df_mg_per[_show_per_cols]
                                    .sort_values("Posting_Date_in_the_Document")
                                    .reset_index(drop=True)
                                )
                                # Usar columna _num para calcular el gradiente
                                if "Total_Variance_Amount_num" in _df_mg_per.columns:
                                    _heat_vals = (
                                        _df_mg_per
                                        .sort_values("Posting_Date_in_the_Document")
                                        .reset_index(drop=True)["Total_Variance_Amount_num"]
                                    )
                                    _v_min = _heat_vals.min()
                                    _v_max = _heat_vals.max()
                                    def _heat_color(row_idx, vals=_heat_vals, vmin=_v_min, vmax=_v_max):
                                        v = vals.iloc[row_idx] if row_idx < len(vals) else 0
                                        # Normalizar: negativo=verde, positivo=rojo, 0=blanco
                                        if vmax == vmin:
                                            t = 0.5
                                        elif v < 0:
                                            t = max(0.0, v / vmin)  # 0=blanco, 1=verde intenso
                                            r = int(255 - t * (255 - 22))
                                            g = int(255 - t * (255 - 163))
                                            b = int(255 - t * (255 - 74))
                                            return f"background-color: rgb({r},{g},{b})"
                                        else:
                                            t = min(1.0, v / vmax) if vmax > 0 else 0
                                            r = int(255 - t * (255 - 220))
                                            g = int(255 - t * 255)
                                            b = int(255 - t * 255)
                                            return f"background-color: rgb({r},{g},{b})"
                                    def _apply_heat(df_s, vals=_heat_vals):
                                        styles = pd.DataFrame("", index=df_s.index, columns=df_s.columns)
                                        for _ri in range(len(df_s)):
                                            _bg = _heat_color(_ri)
                                            styles.iloc[_ri] = _bg
                                        return styles
                                    st.dataframe(
                                        _heat_df.style.apply(_apply_heat, axis=None),
                                        use_container_width=True, height=340, hide_index=True,
                                    )
                                else:
                                    st.dataframe(
                                        _heat_df,
                                        use_container_width=True, height=320, hide_index=True,
                                    )
                        else:
                            st.caption("Click a point on the trend to see records for the period.")
        else:
            st.caption("Click a group in the treemap to see details.")

# ── Tab 3: Proveedores ────────────────────────────────────────────────────────
with tabs[2]:
    if "Vendor_Name" in dff.columns and PPV in dff.columns:
        n_top = st.slider("Top N vendors", 5, 30, 15, key="top_vendor")
        vend_all = (
            dff.groupby(["Vendor_Name", "Account_Number_of_Vendor_or_Creditor"])
            .agg(PPV_Total=(PPV, "sum"), Records=(PPV, "count"), PPV_Average=(PPV, "mean"))
            .reset_index()
            .sort_values("PPV_Total", key=abs, ascending=False)
        )
        vend = vend_all.head(n_top)
        col_l, col_r = st.columns(2)
        with col_l:
            _ev_vend = st.plotly_chart(
                _bar(vend, "PPV_Total", "Vendor_Name",
                     f"Top {n_top} Vendors by Total PPV", orientation="h"),
                use_container_width=True,
                on_select="rerun",
                key="vendor_bar_chart",
                selection_mode="points",
            )
            st.caption("Click a vendor bar to see its component breakdown below.")
        with col_r:
            # ── KNN decision-region heatmap ──────────────────────────────────
            try:
                from sklearn.neighbors import KNeighborsClassifier as _KNC
                from sklearn.preprocessing import StandardScaler as _SS

                _X_knn = vend_all[["Records", "PPV_Total"]].values.astype(float)
                # Labels: 0=Favorable (PPV<0), 1=Normal (band ~0), 2=Unfavorable (PPV>0)
                # "Normal" threshold: inner quartiles of PPV_Total
                _q25_k = float(vend_all["PPV_Total"].quantile(0.25))
                _q75_k = float(vend_all["PPV_Total"].quantile(0.75))
                def _klabel(v):
                    if v < min(_q25_k, 0):   return 0   # Favorable
                    if v > max(_q75_k, 0):   return 2   # Unfavorable
                    return 1                             # Normal
                _lab_knn = np.array([_klabel(v) for v in vend_all["PPV_Total"]])

                _has_knn = len(np.unique(_lab_knn)) >= 2
                if _has_knn:
                    _ss  = _SS()
                    _Xsc = _ss.fit_transform(_X_knn)
                    _k_n = min(5, max(1, len(vend_all) - 1))
                    _clf = _KNC(n_neighbors=_k_n)
                    _clf.fit(_Xsc, _lab_knn)

                    _xp = (float(vend_all["Records"].max()) - float(vend_all["Records"].min())) * 0.20 + 1
                    _yp = (float(vend_all["PPV_Total"].max())  - float(vend_all["PPV_Total"].min()))  * 0.22 + 1
                    _xx_k, _yy_k = np.meshgrid(
                        np.linspace(float(vend_all["Records"].min()) - _xp,
                                    float(vend_all["Records"].max()) + _xp, 160),
                        np.linspace(float(vend_all["PPV_Total"].min())  - _yp,
                                    float(vend_all["PPV_Total"].max())  + _yp, 160),
                    )
                    _Z_k = _clf.predict(
                        _ss.transform(np.c_[_xx_k.ravel(), _yy_k.ravel()])
                    ).reshape(_xx_k.shape).astype(float)

                    # Colorscale: 0→green, 1→gray, 2→red
                    _kcs = [
                        [0.00, "rgba(34,197,94,0.28)"],  [0.32, "rgba(34,197,94,0.28)"],
                        [0.34, "rgba(156,163,175,0.20)"], [0.65, "rgba(156,163,175,0.20)"],
                        [0.67, "rgba(239,68,68,0.28)"],  [1.00, "rgba(239,68,68,0.28)"],
                    ]
                    fig_sc = go.Figure()
                    fig_sc.add_trace(go.Heatmap(
                        x=_xx_k[0], y=_yy_k[:, 0], z=_Z_k,
                        colorscale=_kcs, zmin=0, zmax=2,
                        showscale=False, hoverinfo="skip",
                    ))
                else:
                    fig_sc = go.Figure()
                    _has_knn = False
            except Exception:
                fig_sc = go.Figure()
                _has_knn = False

            # ── Puntos de proveedores sobre el fondo (todos) ─────────────────
            _dot_colors = [
                "#22c55e" if v < 0 else ("#ef4444" if v > 0 else "#9ca3af")
                for v in vend_all["PPV_Total"]
            ]
            fig_sc.add_trace(go.Scatter(
                x=vend_all["Records"], y=vend_all["PPV_Total"],
                mode="markers+text",
                text=vend_all["Vendor_Name"],
                textposition="top center",
                textfont=dict(size=9),
                marker=dict(color=_dot_colors, size=10,
                            line=dict(color="white", width=1)),
                customdata=vend_all[["PPV_Total", "Records"]].values,
                hovertemplate=(
                    "<b>%{text}</b><br>"
                    "PPV: $%{customdata[0]:,.0f}<br>"
                    "Records: %{customdata[1]}<extra></extra>"
                ),
                showlegend=False,
            ))
            fig_sc.add_hline(y=0, line_dash="dash", line_color="#9ca3af", line_width=1)

            # Manual zone legend
            for _zl, _zc in [("Favorable", "#22c55e"), ("Normal", "#9ca3af"), ("Unfavorable", "#ef4444")]:
                fig_sc.add_trace(go.Scatter(
                    x=[None], y=[None], mode="markers",
                    marker=dict(color=_zc, size=11, symbol="square"),
                    name=_zl, showlegend=True,
                ))

            fig_sc.update_layout(
                title="Frequency vs Total PPV by Vendor",
                plot_bgcolor="white", paper_bgcolor="white",
                margin=dict(t=40, b=10),
                xaxis_title="Number of records",
                yaxis_title="PPV Total (USD)",
                legend=dict(orientation="h", yanchor="bottom", y=1.02, xanchor="right", x=1),
            )
            st.plotly_chart(fig_sc, use_container_width=True)
        # ── Vendor drill-down: component breakdown ────────────────────────────
        _vend_sel_pts = (
            (_ev_vend.get("selection") or {}).get("points", [])
            if isinstance(_ev_vend, dict) else []
        )
        _sel_vendor = _vend_sel_pts[0].get("y") if _vend_sel_pts else None

        if _sel_vendor:
            st.markdown(f"#### Detail — {_sel_vendor}")
            _df_vd = dff[dff["Vendor_Name"] == _sel_vendor]
            if "Material_Number" in _df_vd.columns and not _df_vd.empty:
                _vd_mat = (
                    _df_vd.groupby(["Material_Number", "Material_Description"])
                    .agg(PPV_Total=(PPV, "sum"), Records=(PPV, "count"), PPV_Average=(PPV, "mean"))
                    .reset_index()
                    .sort_values("PPV_Total", ascending=False)
                )
                # KPIs
                _vd_k1, _vd_k2, _vd_k3, _vd_k4, _vd_k5 = st.columns(5)
                _vd_k1.metric("Materials",        f"{len(_vd_mat):,}")
                _vd_k2_val = _df_vd[PPV].sum()
                _vd_k2_bg  = "#16a34a" if _vd_k2_val <= 0 else "#dc2626"
                _vd_k2.markdown(
                    f"""<div style="background:{_vd_k2_bg};border-radius:8px;padding:14px 16px;text-align:center;">
                        <p style="margin:0;font-size:0.78rem;font-weight:700;color:white;opacity:0.88;">Total PPV (USD)</p>
                        <p style="margin:4px 0 0;font-size:1.35rem;font-weight:800;color:white;">${_vd_k2_val:,.2f}</p>
                    </div>""", unsafe_allow_html=True,
                )
                _vd_k3.metric("Unfavorable (USD)", f"${_df_vd.loc[_df_vd[PPV]>0, PPV].sum():,.2f}")
                _vd_k4.metric("Favorable (USD)",   f"${_df_vd.loc[_df_vd[PPV]<=0, PPV].sum():,.2f}")
                _vd_k5.metric("Records",           f"{len(_df_vd):,}")

                # Most-to-least expensive components chart
                _fig_vd = _bar(
                    _vd_mat, "PPV_Total", "Material_Number",
                    f"Components — {_sel_vendor}  (most to least expensive → favorable)",
                    orientation="h",
                )
                # Add material description as hover
                _fig_vd.update_traces(
                    customdata=_vd_mat[["Material_Description", "Records", "PPV_Average"]].values,
                    hovertemplate=(
                        "<b>%{y}</b><br>"
                        "%{customdata[0]}<br>"
                        "PPV Total: $%{x:,.2f}<br>"
                        "Records: %{customdata[1]}<br>"
                        "PPV Avg: $%{customdata[2]:,.2f}<extra></extra>"
                    ),
                )
                _hd_vd, _tg_vd = st.columns([5, 1])
                _hd_vd.markdown(f"**Components — {_sel_vendor}**")
                _show_tbl_vd = _tg_vd.toggle("Table", value=False, key="tg_vd_comp")
                if _show_tbl_vd:
                    _vd_fmt = _vd_mat.copy()
                    for _c in ["PPV_Total", "PPV_Average"]:
                        _vd_fmt[_c] = _vd_fmt[_c].map("${:,.2f}".format)
                    st.dataframe(_vd_fmt, use_container_width=True, hide_index=True)
                else:
                    st.plotly_chart(_fig_vd, use_container_width=True)
            else:
                st.info("No material data available for this vendor.")

# ── Tab 4: Materiales ─────────────────────────────────────────────────────────
with tabs[3]:
    if "Material_Number" in dff.columns and PPV in dff.columns:
        n_top_mat = st.slider("Top N materials", 5, 40, 20, key="top_mat")
        mat = (
            dff.groupby(["Material_Number", "Material_Description"])
            .agg(PPV_Total=(PPV, "sum"), Records=(PPV, "count"), PPV_Average=(PPV, "mean"))
            .reset_index()
            .sort_values("PPV_Total", key=abs, ascending=False)
            .head(n_top_mat)
        )

        col_l, col_r = st.columns(2)
        with col_l:
            ev_bar = st.plotly_chart(
                _bar(mat, "PPV_Total", "Material_Number",
                     f"Top {n_top_mat} Materials by Total PPV", orientation="h"),
                use_container_width=True,
                on_select="rerun",
                key="mat_bar_sel",
            )
        with col_r:
            mat_desf = (
                dff.loc[dff[PPV] > 0]
                .groupby(["Material_Number", "Material_Description"])[PPV]
                .sum().reset_index()
                .sort_values(PPV, ascending=False)
                .head(n_top_mat)
            )
            ev_par = None
            if not mat_desf.empty:
                # Forzar Material_Number a string (evita que Plotly lo trate como eje numérico continuo)
                mat_desf["Material_Number"] = mat_desf["Material_Number"].astype(str)
                mat_desf["_label"] = mat_desf["Material_Number"]

                mat_desf["Acumulado_%"] = mat_desf[PPV].cumsum() / mat_desf[PPV].sum() * 100
                fig_par = go.Figure()
                fig_par.add_trace(go.Bar(
                    x=mat_desf["_label"], y=mat_desf[PPV],
                    name="Unfavorable PPV", marker_color=COLOR_BAD,
                    customdata=mat_desf["Material_Number"],
                    hovertemplate="<b>%{customdata}</b><br>PPV: $%{y:,.2f}<extra></extra>",
                ))
                fig_par.add_trace(go.Scatter(
                    x=mat_desf["_label"], y=mat_desf["Acumulado_%"],
                    mode="lines+markers", name="Cumulative %",
                    yaxis="y2", line_color="#f59e0b",
                ))
                fig_par.update_layout(
                    title=f"Pareto — Unfavorable Materials (Top {n_top_mat})",
                    yaxis=dict(title="PPV (USD)"),
                    yaxis2=dict(title="Cumulative %", overlaying="y", side="right",
                                range=[0, 105], ticksuffix="%"),
                    plot_bgcolor="white", paper_bgcolor="white",
                    margin=dict(t=40, b=10, l=10, r=10),
                    xaxis=dict(tickangle=-30, tickfont=dict(size=10), type="category"),
                    legend=dict(orientation="h", y=1.02),
                )
                ev_par = st.plotly_chart(
                    fig_par, use_container_width=True,
                    on_select="rerun",
                    key="mat_par_sel",
                )

        # ── Detalle por proveedor del material seleccionado ────────────────────
        selected_mat = None
        # Detectar seleccion en grafica de barras horizontales (y = Material_Number)
        if ev_bar and ev_bar.selection and ev_bar.selection.points:
            pt = ev_bar.selection.points[0]
            selected_mat = pt.get("y")
        # Detectar seleccion en Pareto (customdata = Material_Number; x = label combinado)
        if selected_mat is None and ev_par and ev_par.selection and ev_par.selection.points:
            pt = ev_par.selection.points[0]
            _cd = pt.get("customdata")
            selected_mat = _cd[0] if isinstance(_cd, (list, tuple)) else (_cd if _cd is not None else pt.get("x"))
        # Siempre sincronizar session_state con el estado actual del chart
        st.session_state["ppv_sel_mat"] = selected_mat

        if selected_mat:
            st.markdown("---")
            st.markdown(f"#### Detail by vendor — `{selected_mat}`")
            df_mat_sel = dff[dff["Material_Number"] == selected_mat]
            desc_sel   = df_mat_sel["Material_Description"].iloc[0] if not df_mat_sel.empty else ""
            if desc_sel:
                st.caption(desc_sel)

            if "Vendor_Name" in df_mat_sel.columns:
                vend_det = (
                    df_mat_sel.groupby(["Vendor_Name", "Account_Number_of_Vendor_or_Creditor"])
                    .agg(PPV_Total=(PPV, "sum"), Records=(PPV, "count"))
                    .reset_index()
                    .sort_values("PPV_Total", key=abs, ascending=False)
                )
                kv1, kv2 = st.columns(2)
                _kv1_val = vend_det["PPV_Total"].sum()
                _kv1_bg  = "#16a34a" if _kv1_val <= 0 else "#dc2626"
                kv1.markdown(
                    f"""<div style="background:{_kv1_bg};border-radius:8px;padding:14px 16px;text-align:center;">
                        <p style="margin:0;font-size:0.78rem;font-weight:700;color:white;opacity:0.88;">Total PPV for material</p>
                        <p style="margin:4px 0 0;font-size:1.35rem;font-weight:800;color:white;">${_kv1_val:,.2f}</p>
                    </div>""", unsafe_allow_html=True,
                )
                kv2.metric("Vendors involved", len(vend_det))

                # Grafica de barras por proveedor
                fig_vdet = _bar(
                    vend_det, "PPV_Total", "Vendor_Name",
                    f"PPV by Vendor — {selected_mat}", orientation="h",
                )
                st.plotly_chart(fig_vdet, use_container_width=True)

                # ── Tendencia P_Price_difference por proveedor en el tiempo ──
                if PRICE in df_mat_sel.columns and "Posting_Date" in df_mat_sel.columns:
                    ts_vend = df_mat_sel[df_mat_sel["Posting_Date"].notna()].copy()

                    # Auto-granularidad: dia si <= 1 mes, mes si > 1 mes
                    unique_m = ts_vend["YearMonth"].nunique() if "YearMonth" in ts_vend.columns else 0
                    if unique_m <= 1:
                        ts_vend["_period"] = ts_vend["Posting_Date"].dt.normalize().astype(str)
                        period_label = "Day"
                    else:
                        ts_vend["_period"] = ts_vend["YearMonth"]
                        period_label = "Month"
                    ts_price = (
                        ts_vend.groupby(["_period", "Vendor_Name"])
                        .agg(
                            P_Price_Difference=(PRICE, "sum"),
                            Records=(PPV, "count"),
                            PPV_Total=(PPV, "sum"),
                        )
                        .reset_index()
                        .rename(columns={"_period": period_label})
                        .sort_values(period_label)
                    )

                    if not ts_price.empty:
                        n_vendors = ts_price["Vendor_Name"].nunique()

                        # ── Deteccion de outliers ────────────────────────────
                        all_vals = ts_price["P_Price_Difference"].values
                        outlier_mask, best_model_name, model_scores = _best_outlier_model(all_vals)
                        ts_price["_is_outlier"] = outlier_mask

                        # ── Candidate outlier models for animation ───────────
                        from scipy import stats as _stats_anim
                        _anim_arr = all_vals
                        _aQ1, _aQ3 = np.percentile(_anim_arr, [25, 75])
                        _aIQR = _aQ3 - _aQ1
                        _iqr_am = (_anim_arr < _aQ1 - 1.5*_aIQR) | (_anim_arr > _aQ3 + 1.5*_aIQR)
                        _amu, _asig = _anim_arr.mean(), _anim_arr.std()
                        _z_am = np.abs((_anim_arr - _amu) / (_asig + 1e-9)) > 2.5
                        _amed = np.median(_anim_arr)
                        _amad = np.median(np.abs(_anim_arr - _amed))
                        _mz_am = np.abs(0.6745 * (_anim_arr - _amed) / (_amad + 1e-9)) > 3.5
                        _anim_cands = {
                            "IQR":         {"mask": _iqr_am, "lower": float(_aQ1 - 1.5*_aIQR), "upper": float(_aQ3 + 1.5*_aIQR), "color": "#6366f1"},
                            "Z-Score":     {"mask": _z_am,   "lower": float(_amu - 2.5*_asig),  "upper": float(_amu + 2.5*_asig),  "color": "#f59e0b"},
                            "Z-Score MAD": {"mask": _mz_am,  "lower": float(_amed - 3.5*_amad/0.6745), "upper": float(_amed + 3.5*_amad/0.6745), "color": "#8b5cf6"},
                        }
                        try:
                            from sklearn.ensemble import IsolationForest as _IFanim
                            _if_am = _IFanim(contamination="auto", random_state=42, n_estimators=100).fit_predict(
                                _anim_arr.reshape(-1, 1)) == -1
                            _anim_cands["Isolation Forest"] = {"mask": _if_am, "lower": None, "upper": None, "color": "#ec4899"}
                        except Exception:
                            pass

                        def _ks_anim(mask, vals):
                            inliers = vals[~mask]
                            if len(inliers) < 4: return float("inf")
                            _n = (inliers - inliers.mean()) / (inliers.std() + 1e-9)
                            return round(float(_stats_anim.kstest(_n, "norm")[0]), 4)
                        _anim_ks = {k: _ks_anim(v["mask"], _anim_arr) for k, v in _anim_cands.items()}

                        # x/y lists aligned with ts_price (sorted)
                        _anim_sorted = ts_price.sort_values(period_label).reset_index(drop=True)
                        _anim_x = _anim_sorted[period_label].tolist()
                        _anim_y = _anim_sorted["P_Price_Difference"].tolist()

                        # ── Figura principal ──────────────────────────────────
                        fig_ts_price = px.line(
                            ts_price,
                            x=period_label,
                            y="P_Price_Difference",
                            color="Vendor_Name",
                            markers=True,
                            title=f"P_Price_Difference by Vendor — {selected_mat}",
                            labels={"P_Price_Difference": "Price Diff. (USD)", "Vendor_Name": "Vendor"},
                        )
                        fig_ts_price.add_hline(y=0, line_dash="dash", line_color="#9ca3af", line_width=1)

                        # ── Static: best vendor annotation or trend line ───────
                        _base_annotations = []
                        if n_vendors > 1:
                            vend_summary_score = (
                                ts_price.groupby("Vendor_Name")
                                .agg(P_Price_Total=("P_Price_Difference", "sum"),
                                     Records_Total=("Records", "sum"))
                                .reset_index()
                            )
                            vend_summary_score["P_Price_Per_Record"] = (
                                vend_summary_score["P_Price_Total"] / vend_summary_score["Records_Total"]
                            )
                            best_vend = vend_summary_score.loc[
                                vend_summary_score["P_Price_Per_Record"].idxmin(), "Vendor_Name"
                            ]
                            df_best = ts_price[ts_price["Vendor_Name"] == best_vend].sort_values(period_label)
                            if not df_best.empty:
                                last_row = df_best.iloc[-1]
                                _base_annotations.append(dict(
                                    x=last_row[period_label],
                                    y=last_row["P_Price_Difference"],
                                    text=f"<b>✅ {best_vend}</b><br>Best price",
                                    showarrow=True, arrowhead=3,
                                    arrowcolor="#16a34a", arrowwidth=2, arrowsize=1.4,
                                    ax=0, ay=-48,
                                    bgcolor="rgba(220,252,231,0.9)",
                                    bordercolor="#16a34a", borderwidth=1.5,
                                    font=dict(color="#15803d", size=11),
                                ))
                        else:
                            ts_single = ts_price.sort_values(period_label).copy()
                            y_vals = ts_single["P_Price_Difference"].values
                            x_num  = np.arange(len(y_vals))
                            if len(x_num) >= 2:
                                coeffs  = np.polyfit(x_num, y_vals, 1)
                                trend_y = np.polyval(coeffs, x_num)
                                fig_ts_price.add_trace(go.Scatter(
                                    x=ts_single[period_label], y=trend_y,
                                    mode="lines", name="Trend",
                                    line=dict(color="#f59e0b", dash="dot", width=2),
                                    hoverinfo="skip",
                                ))

                        # ── Placeholder overlay traces (animated) ─────────────
                        _n_base = len(fig_ts_price.data)
                        fig_ts_price.add_trace(go.Scatter(
                            x=[], y=[], mode="lines", showlegend=False, name="Threshold Upper",
                            line=dict(color="gray", dash="dash", width=2),
                        ))
                        fig_ts_price.add_trace(go.Scatter(
                            x=[], y=[], mode="lines", showlegend=False, name="Threshold Lower",
                            line=dict(color="gray", dash="dash", width=2),
                            fill="tonexty", fillcolor="rgba(150,150,150,0.06)",
                        ))
                        fig_ts_price.add_trace(go.Scatter(
                            x=[], y=[], mode="markers", showlegend=False, name="Outliers",
                            marker=dict(symbol="circle-open", size=20, color="#dc2626",
                                        line=dict(width=2.5, color="#dc2626")),
                        ))
                        _ov_idx = [_n_base, _n_base + 1, _n_base + 2]

                        # ── Build animation frames ────────────────────────────
                        _anim_frames = []
                        for _mname, _mdata in _anim_cands.items():
                            _mask    = _mdata["mask"]
                            _col     = _mdata["color"]
                            _is_best = _mname == best_model_name
                            _ks_val  = _anim_ks.get(_mname, 0)
                            _ox = [_anim_x[i] for i, m in enumerate(_mask) if m]
                            _oy = [_anim_y[i] for i, m in enumerate(_mask) if m]
                            if _mdata["lower"] is not None:
                                _ux = [_anim_x[0], _anim_x[-1]]
                                _uy = [_mdata["upper"], _mdata["upper"]]
                                _lx = [_anim_x[0], _anim_x[-1]]
                                _ly = [_mdata["lower"], _mdata["lower"]]
                            else:
                                _ux = _uy = _lx = _ly = []
                            _badge = (
                                f"<b>{'✅ ' if _is_best else ''}{_mname}</b>"
                                f"  KS={_ks_val:.4f}"
                                f"{'  ← SELECTED' if _is_best else ''}"
                            )
                            _frame_anns = _base_annotations + [dict(
                                text=_badge,
                                xref="paper", yref="paper", x=0.01, y=0.97,
                                bgcolor="#16a34a" if _is_best else "#e5e7eb",
                                font=dict(color="white" if _is_best else "#374151", size=12),
                                borderpad=7, showarrow=False, align="left",
                            )]
                            _anim_frames.append(go.Frame(
                                data=[
                                    go.Scatter(x=_ux, y=_uy, mode="lines", showlegend=False,
                                               line=dict(color=_col, dash="dash", width=2)),
                                    go.Scatter(x=_lx, y=_ly, mode="lines", showlegend=False,
                                               line=dict(color=_col, dash="dash", width=2),
                                               fill="tonexty", fillcolor="rgba(99,102,241,0.06)"),
                                    go.Scatter(x=_ox, y=_oy, mode="markers", showlegend=False,
                                               marker=dict(symbol="circle-open", size=20, color="#dc2626",
                                                           line=dict(width=2.5, color="#dc2626"))),
                                ],
                                traces=_ov_idx,
                                name=_mname,
                                layout=go.Layout(annotations=_frame_anns),
                            ))

                        # ── Initialize with best model ────────────────────────
                        _best_idx = list(_anim_cands.keys()).index(best_model_name) if best_model_name in _anim_cands else 0
                        # Play order: all models in sequence, then return to best at the end
                        _play_order = list(_anim_cands.keys()) + [best_model_name]
                        _init_frame = _anim_frames[_best_idx]
                        for _ti, _nd in zip(_ov_idx, _init_frame.data):
                            fig_ts_price.data[_ti].update(_nd)

                        _init_badge_ann = dict(
                            text=f"<b>✅ {best_model_name}</b>  KS={_anim_ks.get(best_model_name, 0):.4f}  ← SELECTED",
                            xref="paper", yref="paper", x=0.01, y=0.97,
                            bgcolor="#16a34a", font=dict(color="white", size=12),
                            borderpad=7, showarrow=False, align="left",
                        )
                        _init_annotations = _base_annotations + [_init_badge_ann]

                        # ── Animation controls ────────────────────────────────
                        fig_ts_price.frames = _anim_frames
                        fig_ts_price.update_layout(
                            plot_bgcolor="white", paper_bgcolor="white",
                            margin=dict(t=80, b=70, l=10, r=10),
                            legend=dict(orientation="h", yanchor="top", y=-0.28, xanchor="left", x=0),
                            height=500,
                            annotations=_init_annotations,
                            updatemenus=[dict(
                                type="buttons", showactive=False,
                                y=1.12, x=0.5, xanchor="center",
                                buttons=[
                                    dict(label="▶ Play models", method="animate",
                                         args=[_play_order, dict(frame=dict(duration=1500, redraw=True),
                                                                  fromcurrent=False, mode="immediate")]),
                                    dict(label="⏸ Pause", method="animate",
                                         args=[[None], dict(frame=dict(duration=0, redraw=False),
                                                            mode="immediate")]),
                                ],
                            )],
                            sliders=[dict(
                                steps=[dict(
                                    method="animate",
                                    args=[[f.name], dict(mode="immediate", frame=dict(duration=0, redraw=True))],
                                    label=f.name,
                                ) for f in _anim_frames],
                                currentvalue=dict(prefix="Model: ", font=dict(size=13)),
                                pad=dict(t=50), len=0.85, x=0.075,
                                active=_best_idx,
                            )],
                        )
                        st.plotly_chart(fig_ts_price, use_container_width=True)

                        # ── Info del modelo de outliers ───────────────────────
                        # ── Veredicto para proveedor unico ────────────────────
                        if n_vendors == 1 and len(ts_price) >= 2:
                            ts_single2 = ts_price.sort_values(period_label).copy()
                            y_vals2 = ts_single2["P_Price_Difference"].values
                            x_num2 = np.arange(len(y_vals2))
                            coeffs2 = np.polyfit(x_num2, y_vals2, 1)
                            slope2 = coeffs2[0]
                            vend_name_single = ts_price["Vendor_Name"].iloc[0]
                            if slope2 > 0:
                                st.warning(
                                    f"⚠️ **Upward trend detected** for `{vend_name_single}` "
                                    f"(+${slope2:,.2f} per period). "
                                    "It is recommended to **negotiate the price** or look for an alternative vendor."
                                )
                            else:
                                st.success(
                                    f"✅ **OK** — `{vend_name_single}` shows a stable or downward trend "
                                    f"(${slope2:,.2f} per period). You may continue purchasing from this vendor."
                                )

                        # ── Desglose detallado por proveedor (registros individuales) ──
                        st.markdown("##### Breakdown by vendor and period")
                        _cv = lambda s: (
                            f"{(s.std() / abs(s.mean()) * 100):.1f}%" if abs(s.mean()) > 1e-9 else "N/A"
                        )
                        # Mapa de columnas raw → etiqueta de visualización
                        _RAW_COLS_MAP = {
                            "Posting_Date_in_the_Document": "Fecha Doc.",
                            "Quantity_num":                 "Cantidad",
                            "Unit_of_entry":                "Unit",
                            "P_Extended_PO_Price_cost_planning_num": "PO Ext. (USD)",
                            "P_Extended__Std_Amount_num":   "Std Ext. (USD)",
                            "PO_Price_per_1000_num":        "PO/1000",
                            "Standard_Price_for_1000_num":  "Std/1000",
                            "P_Price_difference_num":       "Price Diff. (USD)",
                        }
                        _MONEY_LABELS = {
                            "PO Ext. (USD)", "Std Ext. (USD)",
                            "PO/1000", "Std/1000", "Price Diff. (USD)",
                        }
                        _STATS_COLS_MAP = {
                            "P_Price_difference_num":                "Price Diff. (USD)",
                            "P_Extended_PO_Price_cost_planning_num": "PO Ext. (USD)",
                            "P_Extended__Std_Amount_num":            "Std Ext. (USD)",
                        }
                        # Sort vendors by price performance (best price first)
                        _vend_order = (
                            ts_price.groupby("Vendor_Name")
                            .agg(_P=("P_Price_Difference", "sum"), _R=("Records", "sum"))
                            .reset_index()
                        )
                        _vend_order["_score"] = _vend_order["_P"] / _vend_order["_R"].replace(0, 1)
                        _sorted_vendors = _vend_order.sort_values("_score")["Vendor_Name"].tolist()
                        _rank_styles = [
                            ("🥇", "#15803d", "#dcfce7", "#16a34a"),  # 1st — green
                            ("🥈", "#92400e", "#fef3c7", "#d97706"),  # 2nd — amber
                            ("🥉", "#991b1b", "#fee2e2", "#dc2626"),  # 3rd — red
                        ]
                        for _rank_i, _vname in enumerate(_sorted_vendors):
                            _df_raw = ts_vend[ts_vend["Vendor_Name"] == _vname].copy()
                            _df_raw = _df_raw.sort_values("Posting_Date").reset_index(drop=True)
                            _total_regs = len(_df_raw)
                            _r_icon, _r_txt, _r_bg, _r_border = (
                                _rank_styles[_rank_i] if _rank_i < len(_rank_styles)
                                else (f"#{_rank_i+1}", "#374151", "#f3f4f6", "#9ca3af")
                            )
                            with st.container():
                                st.markdown(
                                    f"""
<div style="margin-top:1.2rem;padding:8px 14px;background:{_r_bg};
border-left:4px solid {_r_border};border-radius:6px;display:flex;
align-items:center;gap:10px;">
  <span style="font-size:1.4rem;">{_r_icon}</span>
  <span style="font-size:1rem;font-weight:700;color:{_r_txt};">#{_rank_i+1} — {_vname}</span>
  <span style="font-size:0.82rem;color:{_r_txt};opacity:0.75;margin-left:auto;">{_total_regs} records</span>
</div>""",
                                    unsafe_allow_html=True,
                                )
                                # ── Gráfica: Cantidad (barras) + PO Price / Std Price (líneas) ──
                                _qty_col  = "Quantity_num"
                                _po_col   = "MExtended_PO_Price"
                                _std_col  = "M_Extended__Std_Amount"
                                _ym_col_v = "YearMonth" if "YearMonth" in _df_raw.columns else None
                                # Asegurar que las columnas sean numéricas antes de agregar
                                for _nc in [_qty_col, _po_col, _std_col]:
                                    if _nc in _df_raw.columns:
                                        _df_raw[_nc] = pd.to_numeric(_df_raw[_nc], errors="coerce")
                                if _ym_col_v:
                                    _agg_spec_v = {}
                                    if _qty_col in _df_raw.columns:
                                        _agg_spec_v[_qty_col] = "sum"
                                    if _po_col in _df_raw.columns:
                                        _agg_spec_v[_po_col] = "sum"
                                    if _std_col in _df_raw.columns:
                                        _agg_spec_v[_std_col] = "sum"
                                    if _agg_spec_v:
                                        _grp_v = (
                                            _df_raw.groupby(_ym_col_v)
                                            .agg(_agg_spec_v)
                                            .reset_index()
                                            .sort_values(_ym_col_v)
                                        )
                                        # Calcular rangos sincronizados: ambos ejes desde 0,
                                        # sus máximos alineados para que las proporciones
                                        # visuales sean comparables entre barras y líneas.
                                        _max_qty_v = float(_grp_v[_qty_col].max()) if _qty_col in _grp_v.columns else 1.0
                                        _max_price_v = max(
                                            float(_grp_v[_po_col].max()) if _po_col in _grp_v.columns else 0.0,
                                            float(_grp_v[_std_col].max()) if _std_col in _grp_v.columns else 0.0,
                                        )
                                        _pad = 1.20  # 20 % de espacio superior
                                        _r_qty   = [0, (_max_qty_v   or 1) * _pad]
                                        _r_price = [0, (_max_price_v or 1) * _pad]

                                        # ── Outliers: marcar cuando |PO - Std| / Std > 5% ──
                                        _has_both = _po_col in _grp_v.columns and _std_col in _grp_v.columns
                                        if _has_both:
                                            _diff_v    = _grp_v[_po_col] - _grp_v[_std_col]
                                            _pct_diff_v = (_diff_v / _grp_v[_std_col].replace(0, np.nan)).abs()
                                            _out_mask_v = _pct_diff_v > 0.05
                                            _out_rows_v = _grp_v[_out_mask_v].copy()
                                            _out_rows_v["_pct_diff"] = _pct_diff_v[_out_mask_v]

                                        _fig_vd = make_subplots(specs=[[{"secondary_y": True}]])
                                        if _qty_col in _grp_v.columns:
                                            _fig_vd.add_trace(
                                                go.Bar(
                                                    x=_grp_v[_ym_col_v], y=_grp_v[_qty_col],
                                                    name="Cantidad", marker_color="#60a5fa",
                                                    opacity=0.75,
                                                ),
                                                secondary_y=False,
                                            )
                                        if _po_col in _grp_v.columns:
                                            _fig_vd.add_trace(
                                                go.Scatter(
                                                    x=_grp_v[_ym_col_v], y=_grp_v[_po_col],
                                                    name="PO Ext. (USD)", mode="lines+markers",
                                                    line=dict(color="#f97316", width=2),
                                                    marker=dict(size=6),
                                                ),
                                                secondary_y=True,
                                            )
                                        if _std_col in _grp_v.columns:
                                            _fig_vd.add_trace(
                                                go.Scatter(
                                                    x=_grp_v[_ym_col_v], y=_grp_v[_std_col],
                                                    name="Std Ext. (USD)", mode="lines+markers",
                                                    line=dict(color="#8b5cf6", width=2, dash="dot"),
                                                    marker=dict(size=6),
                                                ),
                                                secondary_y=True,
                                            )

                                        # ── Anotaciones de outliers: segmento vertical entre PO y Std ──
                                        if _has_both and not _out_rows_v.empty:
                                            _shown_leg_red   = False
                                            _shown_leg_green = False
                                            for _, _ov in _out_rows_v.iterrows():
                                                _ox = _ov[_ym_col_v]
                                                _oy_po  = float(_ov[_po_col])
                                                _oy_std = float(_ov[_std_col])
                                                _oy_mid = (_oy_po + _oy_std) / 2
                                                _odiff  = _oy_po - _oy_std
                                                _is_gain   = _odiff < 0
                                                _seg_color = "#22c55e" if _is_gain else "#ef4444"
                                                _leg_name  = ("Outlier ganancia" if _is_gain else "Outlier pérdida")
                                                _shown_ref = _shown_leg_green if _is_gain else _shown_leg_red
                                                # Segmento vertical entre los dos puntos
                                                _fig_vd.add_trace(
                                                    go.Scatter(
                                                        x=[_ox, _ox],
                                                        y=[_oy_std, _oy_po],
                                                        mode="lines",
                                                        line=dict(color=_seg_color, width=3),
                                                        name=_leg_name if not _shown_ref else None,
                                                        showlegend=not _shown_ref,
                                                        legendgroup=f"outlier_{'gain' if _is_gain else 'loss'}",
                                                    ),
                                                    secondary_y=True,
                                                )
                                                if _is_gain:
                                                    _shown_leg_green = True
                                                else:
                                                    _shown_leg_red = True
                                                # Etiqueta con la diferencia absoluta y el % respecto al Std
                                                _opct = float(_ov["_pct_diff"]) * 100
                                                _fig_vd.add_annotation(
                                                    x=_ox, y=_oy_mid,
                                                    xref="x", yref="y2",
                                                    text=f"<b>Δ {_odiff:+,.0f}<br>({_opct:.1f}%)</b>",
                                                    showarrow=False,
                                                    font=dict(color=_seg_color, size=11),
                                                    bgcolor="rgba(255,255,255,0.75)",
                                                    bordercolor=_seg_color,
                                                    borderwidth=1,
                                                    xanchor="left",
                                                    yanchor="middle",
                                                )

                                        _fig_vd.update_layout(
                                            plot_bgcolor="white", paper_bgcolor="white",
                                            margin=dict(t=30, b=10, l=10, r=10),
                                            legend=dict(orientation="h", yanchor="bottom", y=1.02, xanchor="right", x=1),
                                            bargap=0.3, height=350,
                                        )
                                        _fig_vd.update_yaxes(
                                            title_text="Quantity (sum)",
                                            range=_r_qty,
                                            secondary_y=False,
                                            showgrid=True, gridcolor="#f3f4f6",
                                        )
                                        _fig_vd.update_yaxes(
                                            title_text="Ext. Price (USD, sum)",
                                            range=_r_price,
                                            secondary_y=True, showgrid=False,
                                        )
                                        st.plotly_chart(_fig_vd, use_container_width=True)
                                else:
                                    st.caption("No YearMonth column available for plotting.")

        else:
            st.caption("Click on a material in any of the charts to see the breakdown by vendor.")

# ── Tab 5: Product Hierarchy ──────────────────────────────────────────────────
with tabs[4]:
    _ph_col = "Product_Hierarchy"
    if _ph_col in dff.columns and PPV in dff.columns:
        ph = (
            dff[dff[_ph_col].notna() & (dff[_ph_col].astype(str).str.strip() != "")]
            .groupby(_ph_col)
            .agg(PPV_Total=(PPV, "sum"), Records=(PPV, "count"))
            .reset_index()
            .sort_values("PPV_Total", ascending=False)
        )
        ph[_ph_col] = ph[_ph_col].astype(str)

        if ph.empty:
            st.info("No data with Product_Hierarchy for the current filter.")
        else:
            # KPIs
            _k1, _k2, _k3, _k4 = st.columns(4)
            _k1.metric("Distinct Hierarchies", f"{len(ph):,}")
            _ph_total_val = ph['PPV_Total'].sum()
            _ph_total_bg  = "#16a34a" if _ph_total_val <= 0 else "#dc2626"
            _k2.markdown(
                f"""<div style="background:{_ph_total_bg};border-radius:8px;padding:14px 16px;text-align:center;">
                    <p style="margin:0;font-size:0.78rem;font-weight:700;color:white;opacity:0.88;">Total PPV (USD)</p>
                    <p style="margin:4px 0 0;font-size:1.35rem;font-weight:800;color:white;">${_ph_total_val:,.2f}</p>
                </div>""", unsafe_allow_html=True,
            )
            _k3.metric("Unfavorable",           f"${ph.loc[ph['PPV_Total']>0,'PPV_Total'].sum():,.2f}")
            _k4.metric("Favorable",             f"${ph.loc[ph['PPV_Total']<=0,'PPV_Total'].sum():,.2f}")

            # ── Per-hierarchy trend classification ────────────────────────
            _ph_trend = {}
            if "YearMonth" in dff.columns:
                _ph_ts_all = (
                    dff[
                        dff[_ph_col].notna()
                        & (dff[_ph_col].astype(str).str.strip() != "")
                        & (dff["YearMonth"] != "")
                    ]
                    .groupby([_ph_col, "YearMonth"])[PPV]
                    .sum().reset_index()
                )
                for _phn in ph[_ph_col].tolist():
                    _sub = _ph_ts_all[
                        _ph_ts_all[_ph_col].astype(str) == str(_phn)
                    ].sort_values("YearMonth")
                    if len(_sub) >= 2:
                        _sy = _sub[PPV].values
                        _sx = np.arange(len(_sy))
                        _sc = np.polyfit(_sx, _sy, 1)[0]
                        _pct = abs(_sc) / (abs(_sy.mean()) + 1e-9) * 100
                        if _sc > 0 and _pct > 5:
                            _ph_trend[str(_phn)] = "up"
                        elif _sc < 0 and _pct > 5:
                            _ph_trend[str(_phn)] = "down"
                        else:
                            _ph_trend[str(_phn)] = "stable"
                    else:
                        _ph_trend[str(_phn)] = "stable"

            _TREND_ICON   = {"up": "⬆", "down": "⬇", "stable": "➡"}
            _TREND_BORDER = {"up": "#f97316", "down": "#10b981", "stable": "#9ca3af"}
            _TREND_LABEL  = {"up": "Rising ⚠", "down": "Falling ✅", "stable": "Stable"}

            # ── Barra vertical interactiva a todo el ancho ─────────────────
            _ph_colors      = ["#22c55e" if v <= 0 else "#ef4444" for v in ph["PPV_Total"]]
            _ph_trend_list  = [_ph_trend.get(str(h), "stable") for h in ph[_ph_col]]
            _ph_borders     = [_TREND_BORDER[t] for t in _ph_trend_list]
            _ph_labels      = [
                f"{_TREND_ICON[_ph_trend.get(str(h), 'stable')]} ${v:,.0f}"
                for h, v in zip(ph[_ph_col], ph["PPV_Total"])
            ]
            _ph_customdata  = np.column_stack([
                ph["Records"].values,
                [_TREND_LABEL[_ph_trend.get(str(h), "stable")] for h in ph[_ph_col]],
            ])
            fig_ph_bar = go.Figure(go.Bar(
                x=ph[_ph_col], y=ph["PPV_Total"],
                marker_color=_ph_colors,
                marker_line_color=_ph_borders,
                marker_line_width=3,
                text=_ph_labels,
                textposition="outside",
                customdata=_ph_customdata,
                hovertemplate=(
                    "<b>%{x}</b><br>"
                    "PPV: $%{y:,.2f}<br>"
                    "Records: %{customdata[0]}<br>"
                    "Trend: <b>%{customdata[1]}</b><extra></extra>"
                ),
            ))
            fig_ph_bar.add_hline(y=0, line_dash="dash", line_color="#9ca3af", line_width=1)
            fig_ph_bar.add_annotation(
                xref="paper", yref="paper", x=1.0, y=1.10,
                text="<b>Border = trend:</b>  🟠 Rising  🟢 Falling  ⚫ Stable",
                showarrow=False, xanchor="right",
                font=dict(size=11, color="#374151"),
                bgcolor="rgba(243,244,246,0.9)",
                bordercolor="#d1d5db", borderwidth=1, borderpad=6,
            )
            fig_ph_bar.update_layout(
                title="PPV Total by Product Hierarchy — use Box Select or Lasso Select to see trend",
                plot_bgcolor="white", paper_bgcolor="white",
                margin=dict(t=70, b=80, l=10, r=10),
                yaxis_title="Total Variance Amount (USD)",
                xaxis=dict(tickangle=-30, type="category", tickfont=dict(size=11)),
                height=480,
                dragmode="select",
            )
            _ph_hd, _ph_tg = st.columns([5, 1])
            _ph_hd.markdown("**PPV Total by Product Hierarchy**")
            _ph_show_tbl = _ph_tg.toggle("Table", value=False, key="tg_ph_bar")
            if _ph_show_tbl:
                _ph_fmt = ph.copy()
                _ph_fmt["PPV_Total"] = _ph_fmt["PPV_Total"].map("${:,.2f}".format)
                _ph_fmt["Trend"] = [_TREND_LABEL[_ph_trend.get(str(h), "stable")] for h in ph[_ph_col]]
                st.dataframe(_ph_fmt, use_container_width=True, hide_index=True)
                _ev_ph = None
            else:
                _ev_ph = st.plotly_chart(
                    fig_ph_bar, use_container_width=True,
                    on_select="rerun", key="ph_bar_sel",
                )

            # Leer jerarquías seleccionadas directamente del evento (box/lasso)
            _ph_sel_active = []
            if _ev_ph and _ev_ph.selection and _ev_ph.selection.points:
                _ph_sel_active = [pt.get("x") for pt in _ev_ph.selection.points if pt.get("x")]

            if _ph_sel_active:
                st.caption(f"Selected: **{', '.join(_ph_sel_active)}**")
            else:
                st.caption("Use Box Select ⬜ or Lasso Select in the toolbar to select hierarchies.")

            # ── Tendencia temporal por jerarquías seleccionadas ───────────────
            if "YearMonth" in dff.columns and _ph_sel_active:
                st.markdown("---")
                _ts_ph = (
                    dff[dff[_ph_col].astype(str).isin(_ph_sel_active) & (dff["YearMonth"] != "")]
                    .groupby(["YearMonth", _ph_col])[PPV]
                    .sum().reset_index()
                    .rename(columns={PPV: "PPV_Total", "YearMonth": "Mes"})
                    .sort_values("Mes")
                )
                if not _ts_ph.empty:
                    fig_ph_ts = px.line(
                        _ts_ph, x="Mes", y="PPV_Total",
                        color=_ph_col, markers=True,
                        title="Time Trend — Selected Product Hierarchies",
                        labels={"PPV_Total": "Total Variance Amount (USD)"},
                    )
                    fig_ph_ts.add_hline(y=0, line_dash="dash", line_color="#9ca3af", line_width=1)

                    # ── Trend line over all selected hierarchies combined ─────
                    _ts_ph_agg = (
                        _ts_ph.groupby("Mes")["PPV_Total"].sum().reset_index().sort_values("Mes")
                    )
                    _tr_y = _ts_ph_agg["PPV_Total"].values
                    _tr_x = np.arange(len(_tr_y))
                    if len(_tr_x) >= 2:
                        _tr_coeffs = np.polyfit(_tr_x, _tr_y, 1)
                        _tr_slope  = _tr_coeffs[0]
                        _tr_line   = np.polyval(_tr_coeffs, _tr_x)
                        fig_ph_ts.add_trace(go.Scatter(
                            x=_ts_ph_agg["Mes"], y=_tr_line,
                            mode="lines", name="Trend (combined)",
                            line=dict(color="#f59e0b", dash="dot", width=2),
                            hoverinfo="skip",
                        ))
                        # Badge: trend direction
                        _tr_pct = abs(_tr_slope) / (abs(_tr_y.mean()) + 1e-9) * 100
                        if _tr_slope > 0 and _tr_pct > 5:
                            _tr_label = "⬆ Trending UP"
                            _tr_bg    = "#dc2626"
                        elif _tr_slope < 0 and _tr_pct > 5:
                            _tr_label = "⬇ Trending DOWN"
                            _tr_bg    = "#16a34a"
                        else:
                            _tr_label = "➡ Stable"
                            _tr_bg    = "#3b82f6"
                        fig_ph_ts.add_annotation(
                            xref="paper", yref="paper", x=0.5, y=0.5,
                            text=f"<b>{_tr_label}</b>",
                            showarrow=False,
                            font=dict(color="white", size=16),
                            bgcolor=_tr_bg,
                            bordercolor="white",
                            borderwidth=2,
                            borderpad=10,
                            opacity=0.82,
                        )

                    fig_ph_ts.update_layout(
                        plot_bgcolor="white", paper_bgcolor="white",
                        margin=dict(t=40, b=10),
                        legend=dict(orientation="h", yanchor="bottom", y=1.02, xanchor="right", x=1),
                        height=400,
                    )
                    st.plotly_chart(fig_ph_ts, use_container_width=True)


    else:
        st.info("Column `Product_Hierarchy` not found in data. Verify the API includes it.")

# ── Tab 6: Distribucion estadistica ──────────────────────────────────────────
with tabs[5]:
    if PPV in dff.columns:
        if "Material_Group_Description" in dff.columns:
            top_groups = (
                dff.groupby("Material_Group_Description")[PPV]
                .sum().abs().nlargest(10).index.tolist()
            )
            df_box = dff[dff["Material_Group_Description"].isin(top_groups)]

            # Ordenar grupos por PPV sum descendente para asignar posicion en eje X
            _mg_order = (
                df_box.groupby("Material_Group_Description")[PPV]
                .sum()
                .sort_values(ascending=False)
                .index.tolist()
            )
            # Top 3 que mas generan perdidas (PPV sum mas alto = mas desfavorable)
            _mg_ppv_sum = (
                df_box.groupby("Material_Group_Description")[PPV]
                .sum()
            )
            _top3_loss = _mg_ppv_sum.nlargest(3).index.tolist()

            fig_box = px.box(
                df_box, x="Material_Group_Description", y=PPV,
                title="Variance by Material Group (Top 10)",
                color_discrete_sequence=[COLOR_NEUTRAL],
                labels={PPV: "PPV (USD)", "Material_Group_Description": ""},
                category_orders={"Material_Group_Description": _mg_order},
            )
            fig_box.add_hline(y=0, line_dash="dash", line_color="#dc2626", line_width=1)

            # Rectangulos de resalte para top 3 (posicion por indice en eje categorico)
            _rect_colors = {0: "rgba(220,38,38,0.18)", 1: "rgba(251,146,60,0.14)", 2: "rgba(250,204,21,0.12)"}
            _border_colors = {0: "#dc2626", 1: "#f97316", 2: "#eab308"}
            _annotations_added = []
            for _rank, _gname in enumerate(_top3_loss):
                if _gname not in _mg_order:
                    continue
                _xi = _mg_order.index(_gname)
                _label = ["#1 Biggest loss", "#2", "#3"][_rank]
                fig_box.add_shape(
                    type="rect",
                    x0=_xi - 0.48, x1=_xi + 0.48,
                    y0=0, y1=1,
                    xref="x", yref="paper",
                    fillcolor=_rect_colors[_rank],
                    line=dict(color=_border_colors[_rank], width=2.5 if _rank == 0 else 1.5),
                    layer="below",
                )
                fig_box.add_annotation(
                    x=_xi, y=1.0,
                    xref="x", yref="paper",
                    text=f"<b>{_label}</b>",
                    showarrow=False,
                    yanchor="bottom",
                    font=dict(color=_border_colors[_rank], size=11),
                    bgcolor="rgba(255,255,255,0.75)",
                )

            fig_box.update_layout(
                plot_bgcolor="white", paper_bgcolor="white",
                margin=dict(t=55, b=10),
            )
            ev_box = st.plotly_chart(
                fig_box, use_container_width=True,
                on_select="rerun", key="dist_box_sel",
            )
            # Deteccion de seleccion en box plot
            _sel_mg = None
            if ev_box and ev_box.selection and ev_box.selection.points:
                _pt_box = ev_box.selection.points[0]
                _sel_mg = _pt_box.get("x")
            st.session_state["ppv_sel_mg_dist"] = _sel_mg

            if _sel_mg:
                st.markdown(f"#### Detail — `{_sel_mg}`")
                _df_mg = dff[dff["Material_Group_Description"] == _sel_mg]
                _dm1, _dm2, _dm3, _dm4 = st.columns(4)
                _dm1.metric("Records",          f"{len(_df_mg):,}")
                _dm2_val = _df_mg[PPV].sum()
                _dm2_bg  = "#16a34a" if _dm2_val <= 0 else "#dc2626"
                _dm2.markdown(
                    f"""<div style="background:{_dm2_bg};border-radius:8px;padding:14px 16px;text-align:center;">
                        <p style="margin:0;font-size:0.78rem;font-weight:700;color:white;opacity:0.88;">Total PPV (USD)</p>
                        <p style="margin:4px 0 0;font-size:1.35rem;font-weight:800;color:white;">${_dm2_val:,.2f}</p>
                    </div>""", unsafe_allow_html=True,
                )
                _dm3.metric("PPV Average (USD)",  f"${_df_mg[PPV].mean():,.2f}")
                _dm4.metric("Materials",          f"{_df_mg['Material_Number'].nunique():,}" if 'Material_Number' in _df_mg.columns else "—")

                # Top materiales dentro del grupo
                if "Material_Number" in _df_mg.columns:
                    _mg_mat = (
                        _df_mg.groupby(["Material_Number", "Material_Description"])
                        .agg(PPV_Total=(PPV, "sum"), Records=(PPV, "count"))
                        .reset_index()
                        .sort_values("PPV_Total", key=abs, ascending=False)
                    )
                    st.markdown("**PPV by material within the group**")
                    fig_mg_detail = _bar(
                        _mg_mat.head(15), "PPV_Total", "Material_Number",
                        f"Top materials — {_sel_mg}", orientation="h",
                    )
                    st.plotly_chart(fig_mg_detail, use_container_width=True)

                # Tendencia del grupo en el tiempo
                if "YearMonth" in _df_mg.columns:
                    _ts_mg = (
                        _df_mg[_df_mg["YearMonth"] != ""]
                        .groupby("YearMonth")[PPV].sum()
                        .reset_index()
                        .sort_values("YearMonth")
                    )
                    if not _ts_mg.empty:
                        st.markdown("**Group PPV Trend**")
                        _fig_trend_mg = _line(_ts_mg, "YearMonth", PPV, f"PPV Trend — {_sel_mg}")
                        _ev_trend = st.plotly_chart(
                            _fig_trend_mg, use_container_width=True,
                            on_select="rerun", key="dist_trend_sel",
                        )
                        # Detectar punto seleccionado en la tendencia
                        _sel_period = None
                        if _ev_trend and _ev_trend.selection and _ev_trend.selection.points:
                            _raw_x = _ev_trend.selection.points[0].get("x", "")
                            # Normalizar a YYYY-MM sin importar lo que devuelva Plotly
                            _sel_period = str(_raw_x)[:7]
                        if _sel_period is not None:
                            if _sel_period != st.session_state["ppv_sel_trend_per"]:
                                st.session_state["ppv_sel_trend_per"] = _sel_period
                        else:
                            _sel_period = st.session_state["ppv_sel_trend_per"]

                        if _sel_period:
                            _df_per = _df_mg[_df_mg["YearMonth"] == _sel_period]
                            st.markdown(f"##### Main contributors — `{_sel_mg}` · `{_sel_period}`")
                            _pc1, _pc2, _pc3 = st.columns(3)
                            _pc1.metric("Records in the month",  f"{len(_df_per):,}")
                            _pc2_val = _df_per[PPV].sum()
                            _pc2_bg  = "#16a34a" if _pc2_val <= 0 else "#dc2626"
                            _pc2.markdown(
                                f"""<div style="background:{_pc2_bg};border-radius:8px;padding:14px 16px;text-align:center;">
                                    <p style="margin:0;font-size:0.78rem;font-weight:700;color:white;opacity:0.88;">Total PPV (USD)</p>
                                    <p style="margin:4px 0 0;font-size:1.35rem;font-weight:800;color:white;">${_pc2_val:,.2f}</p>
                                </div>""", unsafe_allow_html=True,
                            )
                            _pc3.metric("Unique materials",       f"{_df_per['Material_Number'].nunique():,}" if 'Material_Number' in _df_per.columns else "—")

                            # By material + By vendor — pie charts side by side
                            _has_mat = "Material_Number" in _df_per.columns
                            _has_vend = "Vendor_Name" in _df_per.columns
                            if _has_mat or _has_vend:
                                _pie_col_l, _pie_col_r = st.columns(2)

                            if _has_mat:
                                _contrib_mat = (
                                    _df_per.groupby(["Material_Number", "Material_Description"])
                                    .agg(PPV_Total=(PPV, "sum"), Records=(PPV, "count"))
                                    .reset_index()
                                    .sort_values("PPV_Total", key=abs, ascending=False)
                                )
                                # Use absolute values for pie slices; label sign with color
                                _cm_abs = _contrib_mat["PPV_Total"].abs()
                                _cm_labels = [
                                    f"{m}<br>{d}" for m, d in zip(
                                        _contrib_mat["Material_Number"].astype(str),
                                        _contrib_mat["Material_Description"],
                                    )
                                ]
                                _cm_colors = ["#22c55e" if v <= 0 else "#ef4444" for v in _contrib_mat["PPV_Total"]]
                                _fig_cm = go.Figure(go.Pie(
                                    labels=_contrib_mat["Material_Number"].astype(str),
                                    values=_cm_abs,
                                    marker=dict(colors=_cm_colors, line=dict(color="white", width=2)),
                                    textinfo="label+percent",
                                    hovertemplate=(
                                        "<b>%{label}</b><br>"
                                        "PPV: $%{customdata[0]:,.2f}<br>"
                                        "Share (abs): %{percent}<br>"
                                        "Records: %{customdata[1]}<extra></extra>"
                                    ),
                                    customdata=np.column_stack([
                                        _contrib_mat["PPV_Total"].values,
                                        _contrib_mat["Records"].values,
                                    ]),
                                    hole=0.35,
                                ))
                                _fig_cm.update_layout(
                                    title=f"By material — {_sel_period}",
                                    paper_bgcolor="white",
                                    margin=dict(t=50, b=10, l=10, r=10),
                                    height=400,
                                    legend=dict(orientation="v", font=dict(size=10)),
                                )
                                with _pie_col_l:
                                    st.plotly_chart(_fig_cm, use_container_width=True)

                            if _has_vend:
                                _contrib_vend = (
                                    _df_per.groupby("Vendor_Name")
                                    .agg(PPV_Total=(PPV, "sum"), Records=(PPV, "count"))
                                    .reset_index()
                                    .sort_values("PPV_Total", key=abs, ascending=False)
                                )
                                _cv_abs = _contrib_vend["PPV_Total"].abs()
                                _cv_colors = ["#22c55e" if v <= 0 else "#ef4444" for v in _contrib_vend["PPV_Total"]]
                                _fig_cv = go.Figure(go.Pie(
                                    labels=_contrib_vend["Vendor_Name"],
                                    values=_cv_abs,
                                    marker=dict(colors=_cv_colors, line=dict(color="white", width=2)),
                                    textinfo="label+percent",
                                    hovertemplate=(
                                        "<b>%{label}</b><br>"
                                        "PPV: $%{customdata[0]:,.2f}<br>"
                                        "Share (abs): %{percent}<br>"
                                        "Records: %{customdata[1]}<extra></extra>"
                                    ),
                                    customdata=np.column_stack([
                                        _contrib_vend["PPV_Total"].values,
                                        _contrib_vend["Records"].values,
                                    ]),
                                    hole=0.35,
                                ))
                                _fig_cv.update_layout(
                                    title=f"By vendor — {_sel_period}",
                                    paper_bgcolor="white",
                                    margin=dict(t=50, b=10, l=10, r=10),
                                    height=400,
                                    legend=dict(orientation="v", font=dict(size=10)),
                                )
                                with _pie_col_r:
                                    st.plotly_chart(_fig_cv, use_container_width=True)
                        else:
                            st.caption("Click on a trend point to see contributors for the period.")

            else:
                st.caption("Click on an element in the box plot to see group details.")

# ── Tab 7: Datos completos ─────────────────────────────────────────────────────
with tabs[6]:
    # ── PPV Impact by Component ───────────────────────────────────────────────
    if "Material_Number" in dff.columns and PPV in dff.columns:
        st.markdown("#### PPV Impact by Component")

        _corr_df = (
            dff.groupby(["Material_Number",
                         dff.get("Material_Description", pd.Series(dtype=str)).name
                         if "Material_Description" in dff.columns else "Material_Number"])
            .agg(PPV_Total=(PPV, "sum"), Records=(PPV, "count"), PPV_Average=(PPV, "mean"))
            .reset_index()
        ) if "Material_Description" in dff.columns else (
            dff.groupby("Material_Number")
            .agg(PPV_Total=(PPV, "sum"), Records=(PPV, "count"), PPV_Average=(PPV, "mean"))
            .reset_index()
            .assign(Material_Description=lambda d: d["Material_Number"])
        )

        _corr_df = (
            _corr_df
            .assign(Abs_PPV=lambda d: d["PPV_Total"].abs())
            .sort_values("Abs_PPV", ascending=False)
        )
        _corr_df["Color"] = _corr_df["PPV_Total"].apply(
            lambda v: "Unfavorable" if v > 0 else "Favorable"
        )

        # ── Symmetric 5th / 95th percentile thresholds (both computed over all values) ──
        # Lower: bottom 5% of the full distribution → most favorable (green ring)
        # Upper: top 5% of the full distribution  → most unfavorable (red ring)
        _p05 = float(_corr_df["PPV_Total"].quantile(0.05))
        _p95 = float(_corr_df["PPV_Total"].quantile(0.95))

        def _outlier_zone(v):
            if v > _p95:  return "Outlier +"
            if v < _p05:  return "Outlier −"
            return "Within range"

        _corr_df["Zone"] = _corr_df["PPV_Total"].apply(_outlier_zone)

        _fig_corr = go.Figure()

        # Colour and opacity per zone
        _zone_cfg = {
            "Outlier +":    (COLOR_BAD,  1.00),
            "Outlier −":    (COLOR_GOOD, 1.00),
            "Within range": ("#6b7280",  0.70),
        }

        for _zone, (_zclr, _zopa) in _zone_cfg.items():
            _sub = _corr_df[_corr_df["Zone"] == _zone]
            if _sub.empty:
                continue
            _sizes    = (_sub["Abs_PPV"] / (_corr_df["Abs_PPV"].max() or 1) * 42 + 8).clip(8, 50)
            _is_outlier = _zone != "Within range"
            _fig_corr.add_trace(go.Scattergl(
                x=_sub["PPV_Total"],
                y=_sub["Records"],
                mode="markers",
                name=_zone,
                marker=dict(
                    color="white",
                    size=_sizes,
                    opacity=_zopa,
                    line=dict(color=_zclr, width=4 if _is_outlier else 1.5),
                ),
                customdata=_sub[["Material_Number", "Material_Description", "PPV_Average", "Abs_PPV", "Zone"]].values,
                hovertemplate=(
                    "<b>%{customdata[0]}</b>  %{customdata[4]}<br>"
                    "%{customdata[1]}<br>"
                    "PPV Total: $%{x:,.2f}<br>"
                    "Records: %{y}<br>"
                    "PPV Avg: $%{customdata[2]:,.2f}<extra></extra>"
                ),
            ))

        # 5th / 95th percentile reference lines
        _fig_corr.add_vline(x=_p05, line_dash="dot", line_color=COLOR_GOOD, line_width=1.5,
                            annotation_text="5th pct (bottom 5%)", annotation_position="top left",
                            annotation_font=dict(size=9, color=COLOR_GOOD))
        _fig_corr.add_vline(x=_p95, line_dash="dot", line_color=COLOR_BAD,  line_width=1.5,
                            annotation_text="95th pct (top 5%)", annotation_position="top right",
                            annotation_font=dict(size=9, color=COLOR_BAD))

        _fig_corr.add_vline(x=0, line_dash="dash", line_color="#9ca3af", line_width=1)
        _fig_corr.update_layout(
            plot_bgcolor="white", paper_bgcolor="white",
            margin=dict(t=40, b=10, l=10, r=10),
            xaxis_title="Total PPV Contribution (USD)  ← Favorable | Unfavorable →",
            yaxis_title="Number of Records (Frequency)",
            legend=dict(orientation="h", yanchor="bottom", y=1.02, xanchor="right", x=1),
            height=480,
        )
        _ev_corr = st.plotly_chart(
            _fig_corr,
            use_container_width=True,
            on_select="rerun",
            key="ppv_impact_chart",
            selection_mode="points",
        )


        # ── Vendor network for selected component ─────────────────────────────
        _corr_sel_pts = (
            (_ev_corr.get("selection") or {}).get("points", [])
            if isinstance(_ev_corr, dict) else []
        )
        _sel_comp = (
            _corr_sel_pts[0].get("customdata", [None])[0]
            if _corr_sel_pts else None
        )

        if _sel_comp and "Vendor_Name" in dff.columns:
            _df_comp = dff[dff["Material_Number"].astype(str) == str(_sel_comp)]
            if not _df_comp.empty:
                _mat_desc = (
                    _df_comp["Material_Description"].iloc[0]
                    if "Material_Description" in _df_comp.columns else _sel_comp
                )
                st.markdown(f"#### Vendor Network — `{_sel_comp}` · {_mat_desc}")

                # Aggregate vendors
                _vend_net = (
                    _df_comp.groupby("Vendor_Name")
                    .agg(PPV_Total=(PPV, "sum"), Records=(PPV, "count"), PPV_Average=(PPV, "mean"))
                    .reset_index()
                    .sort_values("PPV_Average")          # ascending: cheapest first
                )
                _global_avg_net = _df_comp[PPV].mean()
                _best_vendor    = _vend_net.iloc[0]["Vendor_Name"]   # lowest avg PPV
                _worst_vendor   = _vend_net.iloc[-1]["Vendor_Name"]

                # Circular layout: vendors on ring, component at centre
                _n_v    = len(_vend_net)
                _angles = [2 * np.pi * i / _n_v for i in range(_n_v)]
                _vx     = [np.cos(a) for a in _angles]
                _vy     = [np.sin(a) for a in _angles]

                _max_rec_net = float(_vend_net["Records"].max()) or 1.0

                _fig_net = go.Figure()

                # Edges (one trace per vendor so width varies)
                for _vi, (_vrow_idx, _vrow) in enumerate(_vend_net.iterrows()):
                    _ew = max(1.0, _vrow["Records"] / _max_rec_net * 7)
                    _ec = "#22c55e" if _vrow["Vendor_Name"] == _best_vendor else "#e5e7eb"
                    _fig_net.add_trace(go.Scatter(
                        x=[0, _vx[_vi], None],
                        y=[0, _vy[_vi], None],
                        mode="lines",
                        line=dict(color=_ec, width=_ew),
                        hoverinfo="skip",
                        showlegend=False,
                    ))

                # Vendor node colours
                def _net_color(vname, pavg):
                    if vname == _best_vendor:   return "#22c55e"   # green  – best
                    if pavg > _global_avg_net:  return "#ef4444"   # red    – above avg
                    return "#f59e0b"                                # amber  – below avg

                _dot_clrs  = [_net_color(r["Vendor_Name"], r["PPV_Average"])
                               for _, r in _vend_net.iterrows()]
                _dot_sizes = (_vend_net["Records"] / _max_rec_net * 28 + 16).clip(16, 44).tolist()

                # Vendor nodes
                _fig_net.add_trace(go.Scatter(
                    x=_vx, y=_vy,
                    mode="markers+text",
                    text=_vend_net["Vendor_Name"],
                    textposition="top center",
                    textfont=dict(size=9),
                    marker=dict(
                        color=_dot_clrs,
                        size=_dot_sizes,
                        line=dict(color="white", width=2),
                    ),
                    customdata=_vend_net[["PPV_Average", "Records", "PPV_Total"]].values,
                    hovertemplate=(
                        "<b>%{text}</b><br>"
                        "PPV Avg: $%{customdata[0]:,.2f}<br>"
                        "Records: %{customdata[1]}<br>"
                        "PPV Total: $%{customdata[2]:,.2f}<extra></extra>"
                    ),
                    showlegend=False,
                ))

                # Central component node
                _fig_net.add_trace(go.Scatter(
                    x=[0], y=[0],
                    mode="markers+text",
                    text=[_sel_comp],
                    textposition="bottom center",
                    textfont=dict(size=11, color="#1e40af"),
                    marker=dict(color="#3b82f6", size=32,
                                line=dict(color="white", width=3)),
                    hovertemplate=(
                        f"<b>{_sel_comp}</b><br>"
                        f"{_mat_desc}<br>"
                        f"Global avg PPV: ${_global_avg_net:,.2f}<extra></extra>"
                    ),
                    showlegend=False,
                ))

                # Global avg annotation below chart
                _fig_net.add_annotation(
                    x=0, y=-1.42, xref="x", yref="y",
                    text=f"Global avg PPV across all vendors: <b>${_global_avg_net:,.2f}</b>",
                    showarrow=False, font=dict(size=11, color="#6b7280"),
                )

                # Legend
                for _lbl, _lclr in [
                    (f"✅ Best price — {_best_vendor}", "#22c55e"),
                    ("Above global avg (unfavorable)", "#ef4444"),
                    ("Below global avg (favorable)",   "#f59e0b"),
                ]:
                    _fig_net.add_trace(go.Scatter(
                        x=[None], y=[None], mode="markers",
                        marker=dict(color=_lclr, size=11),
                        name=_lbl, showlegend=True,
                    ))

                _fig_net.update_layout(
                    plot_bgcolor="white", paper_bgcolor="white",
                    margin=dict(t=50, b=60, l=10, r=10),
                    xaxis=dict(visible=False, range=[-1.65, 1.65]),
                    yaxis=dict(visible=False, range=[-1.65, 1.65]),
                    height=540,
                    legend=dict(orientation="h", yanchor="bottom", y=1.02,
                                xanchor="right", x=1),
                )
                st.plotly_chart(_fig_net, use_container_width=True)

                # Summary table
                _net_fmt = _vend_net.copy()
                _net_fmt.insert(0, "Best Price?",
                                _net_fmt["Vendor_Name"].apply(
                                    lambda v: "✅ Best" if v == _best_vendor else ""))
                _net_fmt["Global Avg"] = f"${_global_avg_net:,.2f}"
                for _c in ["PPV_Average", "PPV_Total"]:
                    _net_fmt[_c] = _net_fmt[_c].map("${:,.2f}".format)
                st.dataframe(_net_fmt, use_container_width=True, hide_index=True)

        st.divider()

    # ══════════════════════════════════════════════════════════════════════════
    # ── CORRELATION MATRIX ────────────────────────────────────────────────────
    st.markdown("### Variable Impact Analysis — Correlation Matrix")

    def _clean_lbl(col):
        return col.replace("_num", "").replace("_", " ").title()

    _ia_num_cols = [
        c for c in dff.columns
        if c.endswith("_num") and dff[c].notna().sum() > 5
    ]
    if len(_ia_num_cols) >= 2:
        _corr_matrix = dff[_ia_num_cols].corr()
        _corr_labels = [_clean_lbl(c) for c in _ia_num_cols]
        _corr_vals   = _corr_matrix.values.tolist()
        _ppv_idx     = _ia_num_cols.index(PPV) if PPV in _ia_num_cols else None

        _fig_cm = go.Figure(go.Heatmap(
            z=_corr_vals,
            x=_corr_labels,
            y=_corr_labels,
            colorscale="RdBu",
            zmid=0, zmin=-1, zmax=1,
            text=[[f"{v:.2f}" for v in row] for row in _corr_vals],
            texttemplate="%{text}",
            textfont=dict(size=10),
            hovertemplate="<b>%{y}</b> × <b>%{x}</b><br>r = %{z:.3f}<extra></extra>",
            colorbar=dict(title="Pearson r", tickvals=[-1, -0.5, 0, 0.5, 1]),
        ))
        if _ppv_idx is not None:
            _nc = len(_ia_num_cols)
            _fig_cm.add_shape(
                type="rect", xref="x", yref="y",
                x0=-0.5, x1=_nc - 0.5,
                y0=_ppv_idx - 0.5, y1=_ppv_idx + 0.5,
                line=dict(color="#1e40af", width=3), fillcolor="rgba(0,0,0,0)",
            )
            _fig_cm.add_shape(
                type="rect", xref="x", yref="y",
                x0=_ppv_idx - 0.5, x1=_ppv_idx + 0.5,
                y0=-0.5, y1=_nc - 0.5,
                line=dict(color="#1e40af", width=3), fillcolor="rgba(0,0,0,0)",
            )
        _fig_cm.update_layout(
            title="Correlation Matrix — Numeric Variables (Net PPV highlighted in blue)",
            plot_bgcolor="white", paper_bgcolor="white",
            margin=dict(t=60, b=10, l=10, r=10),
            xaxis=dict(tickangle=-40),
            height=max(420, 38 * len(_ia_num_cols) + 120),
        )
        st.plotly_chart(_fig_cm, use_container_width=True)
    else:
        st.info("Need at least 2 numeric columns to build a correlation matrix.")

    st.divider()

    # ══════════════════════════════════════════════════════════════════════════
    # ── PREDICTIVE MODEL — AUTO MODEL SELECTION + 3-MONTH FORECAST ───────────
    st.markdown("### Predictive Model — 3-Month Forecast")

    if "YearMonth" in dff.columns and PPV in dff.columns:
        import warnings as _warn, io as _io, contextlib as _ctx

        _ts_pred = (
            dff.groupby("YearMonth")[PPV]
            .sum().reset_index().sort_values("YearMonth")
            .rename(columns={"YearMonth": "Month", PPV: "Net_PPV"})
        )

        if len(_ts_pred) >= 4:
            try:
                _ts_pred["ds"] = pd.PeriodIndex(_ts_pred["Month"], freq="M").to_timestamp()
            except Exception:
                _ts_pred["ds"] = pd.to_datetime(_ts_pred["Month"], format="%Y-%m", errors="coerce")

            _vals          = _ts_pred["Net_PPV"].values.astype(float)
            _n_fcast       = 3
            _n_test        = min(3, max(1, len(_ts_pred) // 3))
            _n_train       = len(_ts_pred) - _n_test
            _train_vals    = _vals[:_n_train]
            _test_vals     = _vals[_n_train:]
            _train_dates   = _ts_pred["ds"].iloc[:_n_train]
            _current_val   = float(_vals[-1])
            _current_month = str(_ts_pred["Month"].iloc[-1])
            _ytd_total     = float(_ts_pred["Net_PPV"].sum())

            try:
                _base_period = pd.Period(_current_month, freq="M")
                _future_lbls = [(_base_period + i).strftime("%Y-%m")
                                for i in range(1, _n_fcast + 1)]
            except Exception:
                _future_lbls = [f"Month+{i}" for i in range(1, _n_fcast + 1)]

            # ── Scaling selector ──────────────────────────────────────────────
            _scale_method = st.radio(
                "Data scaling before model fitting",
                ["StandardScaler", "Min-Max Scaling", "None"],
                index=0, horizontal=True, key="ppv_scale_method",
                help=(
                    "**StandardScaler**: centers to mean=0, std=1 — best for PPV with sign changes.\n\n"
                    "**Min-Max Scaling**: maps to [0,1] range.\n\n"
                    "**None**: raw USD values (may cause high MASE for models sensitive to scale)."
                ),
            )

            from sklearn.preprocessing import StandardScaler as _StdScl, MinMaxScaler as _MmScl
            if _scale_method == "StandardScaler":
                _scaler = _StdScl()
            elif _scale_method == "Min-Max Scaling":
                _scaler = _MmScl()
            else:
                _scaler = None

            # Fit scaler on training data only (no look-ahead bias)
            if _scaler is not None:
                _tv_sc = _scaler.fit_transform(_train_vals.reshape(-1, 1)).ravel()
                _vv_sc = _scaler.transform(_vals.reshape(-1, 1)).ravel()
                def _inv(arr):
                    return _scaler.inverse_transform(
                        np.array(arr, dtype=float).reshape(-1, 1)).ravel()
            else:
                _tv_sc = _train_vals.copy()
                _vv_sc = _vals.copy()
                def _inv(arr):
                    return np.array(arr, dtype=float)

            def _mase_fn(actual_orig, predicted_orig):
                """
                Mean Absolute Scaled Error — scale-free, correct for negatives/sign-changes.
                Benchmark = naive random-walk (last value). < 1 beats naive.
                """
                a = np.array(actual_orig, dtype=float)
                p = np.array(predicted_orig, dtype=float)
                mae = np.mean(np.abs(a - p))
                naive_mae = np.mean(np.abs(np.diff(_train_vals)))
                if naive_mae < 1e-10:
                    naive_mae = max(np.mean(np.abs(_train_vals)), 1e-10)
                return float(mae / naive_mae)

            def _make_lag_X(series, n_lags):
                """Lag + linear/quadratic trend feature matrix for ML models."""
                _rows = []
                for _i in range(n_lags, len(series)):
                    _row = [series[_i - _l - 1] for _l in range(n_lags)]
                    _row += [float(_i), float(_i) ** 2]
                    _rows.append(_row)
                return np.array(_rows)

            _model_results = {}

            with st.spinner("⏳ Evaluating 11 models — please wait ..."):

                # ── 1. Prophet ────────────────────────────────────────────────
                try:
                    from prophet import Prophet as _PHM
                    _sbuf = _io.StringIO()
                    with _ctx.redirect_stdout(_sbuf), _ctx.redirect_stderr(_sbuf), \
                         _warn.catch_warnings():
                        _warn.simplefilter("ignore")
                        _ph_tr = pd.DataFrame({"ds": _train_dates.values, "y": _tv_sc})
                        _ph_m  = _PHM(yearly_seasonality=False, weekly_seasonality=False,
                                      daily_seasonality=False)
                        _ph_m.fit(_ph_tr)
                        _ph_ft = _ph_m.make_future_dataframe(
                            periods=_n_test, freq="MS", include_history=False)
                        _ph_tp = _inv(_ph_m.predict(_ph_ft)["yhat"].values)
                        # Refit on all data → 3-month forecast
                        _ph_full = pd.DataFrame({"ds": _ts_pred["ds"].values, "y": _vv_sc})
                        _ph_m2   = _PHM(yearly_seasonality=False, weekly_seasonality=False,
                                        daily_seasonality=False)
                        _ph_m2.fit(_ph_full)
                        _ph_fut = _ph_m2.make_future_dataframe(
                            periods=_n_fcast, freq="MS", include_history=False)
                        _ph_fc3 = _inv(_ph_m2.predict(_ph_fut)["yhat"].values).tolist()
                    _model_results["Prophet"] = {
                        "mape": _mase_fn(_test_vals, _ph_tp), "pred_3m": _ph_fc3,
                        "test_pred": _ph_tp.tolist(), "error": None,
                    }
                except Exception as _e:
                    _model_results["Prophet"] = {
                        "mape": float("inf"), "pred_3m": [0.0] * _n_fcast,
                        "test_pred": [0.0] * _n_test, "error": str(_e)[:120],
                    }

                # ── 2. NeuralProphet ──────────────────────────────────────────
                # Patch 1: NumPy 2.0 removed np.NaN — restore it for NeuralProphet
                # Patch 2: PyTorch >=2.0 defaults weights_only=True — force False
                try:
                    import numpy as _np_compat
                    if not hasattr(_np_compat, "NaN"):
                        _np_compat.NaN = _np_compat.nan

                    import torch as _tch
                    _orig_tload = _tch.load
                    def _tload_patched(*_a, **_kw):
                        _kw.setdefault("weights_only", False)
                        return _orig_tload(*_a, **_kw)
                    _tch.load = _tload_patched

                    import neuralprophet as _NPL
                    _NPL.set_log_level("ERROR")
                    _sbuf = _io.StringIO()
                    with _ctx.redirect_stdout(_sbuf), _ctx.redirect_stderr(_sbuf), \
                         _warn.catch_warnings():
                        _warn.simplefilter("ignore")
                        _np_tr = pd.DataFrame({
                            "ds": _train_dates.values, "y": _tv_sc.tolist()
                        })
                        _np_m = _NPL.NeuralProphet(
                            epochs=60, batch_size=min(16, max(1, _n_train)),
                            yearly_seasonality=False, weekly_seasonality=False,
                            daily_seasonality=False,
                        )
                        _np_m.fit(_np_tr, freq="MS")
                        _np_ft = _np_m.make_future_dataframe(_np_tr, periods=_n_test)
                        _np_tp = _inv(_np_m.predict(_np_ft)["yhat1"].iloc[-_n_test:].values)
                        _np_full = pd.DataFrame({
                            "ds": _ts_pred["ds"].values, "y": _vv_sc.tolist()
                        })
                        _np_m2 = _NPL.NeuralProphet(
                            epochs=60, batch_size=min(16, max(1, len(_vals))),
                            yearly_seasonality=False, weekly_seasonality=False,
                            daily_seasonality=False,
                        )
                        _np_m2.fit(_np_full, freq="MS")
                        _np_fut = _np_m2.make_future_dataframe(_np_full, periods=_n_fcast)
                        _np_fc3 = _inv(_np_m2.predict(_np_fut)["yhat1"].iloc[-_n_fcast:].values).tolist()
                    _model_results["NeuralProphet"] = {
                        "mape": _mase_fn(_test_vals, _np_tp), "pred_3m": _np_fc3,
                        "test_pred": _np_tp.tolist(), "error": None,
                    }
                except Exception as _e:
                    _model_results["NeuralProphet"] = {
                        "mape": float("inf"), "pred_3m": [0.0] * _n_fcast,
                        "test_pred": [0.0] * _n_test, "error": str(_e)[:120],
                    }
                finally:
                    try:
                        _tch.load = _orig_tload
                    except Exception:
                        pass

                # ── 3. SARIMA ─────────────────────────────────────────────────
                try:
                    from statsmodels.tsa.statespace.sarimax import SARIMAX as _SARX
                    with _warn.catch_warnings():
                        _warn.simplefilter("ignore")
                        _sar_kw = {"order": (1, 1, 1)}
                        if _n_train >= 24:
                            _sar_kw["seasonal_order"] = (1, 0, 1, 12)
                        _sar_r   = _SARX(_tv_sc, **_sar_kw).fit(disp=False)
                        _sar_tp  = _inv(_sar_r.forecast(steps=_n_test))
                        _sar_r2  = _SARX(_vv_sc, **_sar_kw).fit(disp=False)
                        _sar_fc3 = _inv(_sar_r2.forecast(steps=_n_fcast)).tolist()
                    _model_results["SARIMA"] = {
                        "mape": _mase_fn(_test_vals, _sar_tp), "pred_3m": _sar_fc3,
                        "test_pred": list(_sar_tp), "error": None,
                    }
                except Exception as _e:
                    _model_results["SARIMA"] = {
                        "mape": float("inf"), "pred_3m": [0.0] * _n_fcast,
                        "test_pred": [0.0] * _n_test, "error": str(_e)[:120],
                    }

                # ── 5. Holt-Winters ETS ───────────────────────────────────────
                try:
                    from statsmodels.tsa.holtwinters import ExponentialSmoothing as _HW
                    with _warn.catch_warnings():
                        _warn.simplefilter("ignore")
                        _hw_kw = dict(
                            trend="add",
                            seasonal="add" if _n_train >= 24 else None,
                            seasonal_periods=12 if _n_train >= 24 else None,
                            initialization_method="estimated",
                        )
                        _hw_r   = _HW(_tv_sc, **_hw_kw).fit(optimized=True)
                        _hw_tp  = _inv(_hw_r.forecast(_n_test))
                        _hw_r2  = _HW(_vv_sc, **_hw_kw).fit(optimized=True)
                        _hw_fc3 = _inv(_hw_r2.forecast(_n_fcast)).tolist()
                    _model_results["Holt-Winters"] = {
                        "mape": _mase_fn(_test_vals, _hw_tp), "pred_3m": _hw_fc3,
                        "test_pred": list(_hw_tp), "error": None,
                    }
                except Exception as _e:
                    _model_results["Holt-Winters"] = {
                        "mape": float("inf"), "pred_3m": [0.0] * _n_fcast,
                        "test_pred": [0.0] * _n_test, "error": str(_e)[:120],
                    }

                # ── 6. Holt Linear (Double Exp Smoothing) ─────────────────────
                try:
                    from statsmodels.tsa.holtwinters import Holt as _Holt
                    with _warn.catch_warnings():
                        _warn.simplefilter("ignore")
                        _holt_r  = _Holt(_tv_sc, initialization_method="estimated").fit(optimized=True)
                        _holt_tp = _inv(_holt_r.forecast(_n_test))
                        _holt_r2 = _Holt(_vv_sc, initialization_method="estimated").fit(optimized=True)
                        _holt_fc = _inv(_holt_r2.forecast(_n_fcast)).tolist()
                    _model_results["Holt Linear"] = {
                        "mape": _mase_fn(_test_vals, _holt_tp), "pred_3m": _holt_fc,
                        "test_pred": list(_holt_tp), "error": None,
                    }
                except Exception as _e:
                    _model_results["Holt Linear"] = {
                        "mape": float("inf"), "pred_3m": [0.0] * _n_fcast,
                        "test_pred": [0.0] * _n_test, "error": str(_e)[:120],
                    }

                # ── 7. Simple Exponential Smoothing ───────────────────────────
                try:
                    from statsmodels.tsa.holtwinters import SimpleExpSmoothing as _SES
                    with _warn.catch_warnings():
                        _warn.simplefilter("ignore")
                        _ses_r  = _SES(_tv_sc, initialization_method="estimated").fit(optimized=True)
                        _ses_tp = _inv(_ses_r.forecast(_n_test))
                        _ses_r2 = _SES(_vv_sc, initialization_method="estimated").fit(optimized=True)
                        _ses_fc = _inv(_ses_r2.forecast(_n_fcast)).tolist()
                    _model_results["Exp Smoothing"] = {
                        "mape": _mase_fn(_test_vals, _ses_tp), "pred_3m": _ses_fc,
                        "test_pred": list(_ses_tp), "error": None,
                    }
                except Exception as _e:
                    _model_results["Exp Smoothing"] = {
                        "mape": float("inf"), "pred_3m": [0.0] * _n_fcast,
                        "test_pred": [0.0] * _n_test, "error": str(_e)[:120],
                    }

                # ── 8. Theta method ────────────────────────────────────────────
                try:
                    from statsmodels.tsa.forecasting.theta import ThetaModel as _Theta
                    with _warn.catch_warnings():
                        _warn.simplefilter("ignore")
                        _th_r  = _Theta(_tv_sc, period=12).fit()
                        _th_tp = _inv(_th_r.forecast(_n_test))
                        _th_r2 = _Theta(_vv_sc, period=12).fit()
                        _th_fc = _inv(_th_r2.forecast(_n_fcast)).tolist()
                    _model_results["Theta"] = {
                        "mape": _mase_fn(_test_vals, _th_tp), "pred_3m": _th_fc,
                        "test_pred": list(_th_tp), "error": None,
                    }
                except Exception as _e:
                    _model_results["Theta"] = {
                        "mape": float("inf"), "pred_3m": [0.0] * _n_fcast,
                        "test_pred": [0.0] * _n_test, "error": str(_e)[:120],
                    }

                # ── 9. ARIMA Grid Search (best AIC order) ─────────────────────
                _arima_best_name = "ARIMA Grid"
                try:
                    from statsmodels.tsa.arima.model import ARIMA as _ARIMA2
                    with _warn.catch_warnings():
                        _warn.simplefilter("ignore")
                        _best_aic, _best_ari_ord = float("inf"), (1, 1, 1)
                        for _p in range(4):
                            for _d in range(3):
                                for _q in range(4):
                                    try:
                                        _aic = _ARIMA2(
                                            _tv_sc, order=(_p, _d, _q)
                                        ).fit().aic
                                        if _aic < _best_aic:
                                            _best_aic = _aic
                                            _best_ari_ord = (_p, _d, _q)
                                    except Exception:
                                        pass
                        _arima_best_name = f"ARIMA{_best_ari_ord}"
                        _ag_r  = _ARIMA2(_tv_sc, order=_best_ari_ord).fit()
                        _ag_tp = _inv(_ag_r.forecast(_n_test))
                        _ag_r2 = _ARIMA2(_vv_sc, order=_best_ari_ord).fit()
                        _ag_fc = _inv(_ag_r2.forecast(_n_fcast)).tolist()
                    _model_results[_arima_best_name] = {
                        "mape": _mase_fn(_test_vals, _ag_tp), "pred_3m": _ag_fc,
                        "test_pred": list(_ag_tp), "error": None,
                    }
                except Exception as _e:
                    _model_results[_arima_best_name] = {
                        "mape": float("inf"), "pred_3m": [0.0] * _n_fcast,
                        "test_pred": [0.0] * _n_test, "error": str(_e)[:120],
                    }

                # ── 10. Ridge Regression (lag + trend features) ───────────────
                try:
                    from sklearn.linear_model import Ridge as _Ridge2
                    with _warn.catch_warnings():
                        _warn.simplefilter("ignore")
                        _n_lags_r = min(3, max(1, _n_train - 2))
                        if _n_train < _n_lags_r + 2:
                            raise ValueError("Too few data points for Ridge lag model")
                        _Xl  = _make_lag_X(_tv_sc, _n_lags_r)
                        _yl  = _tv_sc[_n_lags_r:]
                        _rg  = _Ridge2(alpha=10.0).fit(_Xl, _yl)
                        _rg_buf   = list(_tv_sc)
                        _rg_tp_sc = []
                        for _si in range(_n_test):
                            _xi = np.array([[_rg_buf[-_l - 1] for _l in range(_n_lags_r)]
                                            + [float(len(_rg_buf)), float(len(_rg_buf)) ** 2]])
                            _pv = float(_rg.predict(_xi)[0])
                            _rg_tp_sc.append(_pv)
                            _rg_buf.append(_pv)
                        _rg_tp = _inv(_rg_tp_sc)
                        _Xl2 = _make_lag_X(_vv_sc, _n_lags_r)
                        _rg2 = _Ridge2(alpha=10.0).fit(_Xl2, _vv_sc[_n_lags_r:])
                        _rg_buf2, _rg_fc_sc = list(_vv_sc), []
                        for _si in range(_n_fcast):
                            _xi2 = np.array([[_rg_buf2[-_l - 1] for _l in range(_n_lags_r)]
                                             + [float(len(_rg_buf2)), float(len(_rg_buf2)) ** 2]])
                            _pv2 = float(_rg2.predict(_xi2)[0])
                            _rg_fc_sc.append(_pv2)
                            _rg_buf2.append(_pv2)
                        _rg_fc = _inv(_rg_fc_sc).tolist()
                    _model_results["Ridge (lags)"] = {
                        "mape": _mase_fn(_test_vals, _rg_tp), "pred_3m": _rg_fc,
                        "test_pred": list(_rg_tp), "error": None,
                    }
                except Exception as _e:
                    _model_results["Ridge (lags)"] = {
                        "mape": float("inf"), "pred_3m": [0.0] * _n_fcast,
                        "test_pred": [0.0] * _n_test, "error": str(_e)[:120],
                    }

                # ── 11. Gradient Boosting (lag + trend features) ──────────────
                try:
                    from sklearn.ensemble import GradientBoostingRegressor as _GBR
                    with _warn.catch_warnings():
                        _warn.simplefilter("ignore")
                        _n_lags_gb = min(4, max(1, _n_train - 2))
                        if _n_train < _n_lags_gb + 4:
                            raise ValueError("Too few data points for Gradient Boost model")
                        _Xgb = _make_lag_X(_tv_sc, _n_lags_gb)
                        _ygb = _tv_sc[_n_lags_gb:]
                        _gb  = _GBR(n_estimators=200, max_depth=2,
                                    learning_rate=0.1, random_state=42).fit(_Xgb, _ygb)
                        _gb_buf   = list(_tv_sc)
                        _gb_tp_sc = []
                        for _si in range(_n_test):
                            _xi = np.array([[_gb_buf[-_l - 1] for _l in range(_n_lags_gb)]
                                            + [float(len(_gb_buf)), float(len(_gb_buf)) ** 2]])
                            _pv = float(_gb.predict(_xi)[0])
                            _gb_tp_sc.append(_pv)
                            _gb_buf.append(_pv)
                        _gb_tp = _inv(_gb_tp_sc)
                        _Xgb2 = _make_lag_X(_vv_sc, _n_lags_gb)
                        _gb2  = _GBR(n_estimators=200, max_depth=2,
                                     learning_rate=0.1, random_state=42).fit(
                                         _Xgb2, _vv_sc[_n_lags_gb:])
                        _gb_buf2, _gb_fc_sc = list(_vv_sc), []
                        for _si in range(_n_fcast):
                            _xi2 = np.array([[_gb_buf2[-_l - 1] for _l in range(_n_lags_gb)]
                                             + [float(len(_gb_buf2)), float(len(_gb_buf2)) ** 2]])
                            _pv2 = float(_gb2.predict(_xi2)[0])
                            _gb_fc_sc.append(_pv2)
                            _gb_buf2.append(_pv2)
                        _gb_fc = _inv(_gb_fc_sc).tolist()
                    _model_results["Gradient Boost"] = {
                        "mape": _mase_fn(_test_vals, _gb_tp), "pred_3m": _gb_fc,
                        "test_pred": list(_gb_tp), "error": None,
                    }
                except Exception as _e:
                    _model_results["Gradient Boost"] = {
                        "mape": float("inf"), "pred_3m": [0.0] * _n_fcast,
                        "test_pred": [0.0] * _n_test, "error": str(_e)[:120],
                    }

            # ── Model competition results ──────────────────────────────────────
            _valid     = {k: v for k, v in _model_results.items()
                          if v["mape"] < float("inf")}
            _best_name = min(_valid, key=lambda k: _valid[k]["mape"]) if _valid else None
            _winner_md = f"🏆 Winner: **{_best_name}**" if _best_name else "⚠️ All models failed"
            st.markdown(f"#### Model Competition — {_winner_md}")

            with st.expander("📊 View model scores", expanded=False):
                _comp_df = pd.DataFrame([
                    {
                        "":       "🏆" if m == _best_name else "",
                        "Model":  m,
                        "MASE":   f"{r['mape']:.3f}" if r["mape"] < float("inf") else "—",
                        "Status": "✅ OK" if r["error"] is None else f"❌ {r['error'][:80]}",
                    }
                    for m, r in sorted(_model_results.items(), key=lambda x: x[1]["mape"])
                ])
                st.caption("MASE < 1 = beats naive forecast · Lower is better · Scale-free (correct for negative PPV values)")
                st.dataframe(_comp_df, use_container_width=True, hide_index=True)

            # ── Pick predictions from winner ───────────────────────────────────
            if _best_name:
                _pred_vals = _model_results[_best_name]["pred_3m"]
                _resid_std = float(np.std(
                    np.array(_test_vals) - np.array(_model_results[_best_name]["test_pred"])
                )) if len(_test_vals) > 0 else float(np.std(_vals) * 0.3)
            else:
                from sklearn.preprocessing import PolynomialFeatures as _PF2
                from sklearn.linear_model import Ridge as _RDG
                _pf2   = _PF2(degree=2, include_bias=False)
                _Xp2   = _pf2.fit_transform(np.arange(len(_vals)).reshape(-1, 1))
                _mdlpf = _RDG(alpha=1.0).fit(_Xp2, _vals)
                _Xp2fc = _pf2.transform(
                    np.arange(len(_vals), len(_vals) + _n_fcast).reshape(-1, 1))
                _pred_vals = _mdlpf.predict(_Xp2fc).tolist()
                _resid_std = float(np.std(_vals - _mdlpf.predict(_Xp2)))

            # ── KPI cards row 1: current month + 3 predicted ─────────────────
            _kc_cols = st.columns(1 + _n_fcast)
            for _ci, (_lbl_kpi, _val_kpi) in enumerate([
                (f"Current<br>({_current_month})", _current_val),
                *[(f"Predicted<br>({_future_lbls[i]})", _pred_vals[i])
                  for i in range(_n_fcast)],
            ]):
                _bg_kpi = COLOR_BAD if _val_kpi > 0 else COLOR_GOOD
                _kc_cols[_ci].markdown(
                    f'<div style="background:{_bg_kpi};border-radius:10px;padding:14px;text-align:center;">'
                    f'<p style="margin:0;font-size:0.75rem;font-weight:700;color:white;opacity:.85;">{_lbl_kpi}</p>'
                    f'<p style="margin:6px 0 0;font-size:1.25rem;font-weight:800;color:white;">${_val_kpi:,.0f}</p>'
                    f'</div>', unsafe_allow_html=True,
                )
            st.markdown("")

            # ── KPI cards row 2: current YTD cumulative + 3 predicted YTD ─────
            _ytd_cum_cards = [
                (_ytd_total + sum(_pred_vals[:i+1])) for i in range(_n_fcast)
            ]
            _kc2_cols = st.columns(1 + _n_fcast)
            for _ci2, (_lbl2, _val2) in enumerate([
                (f"Cumulative YTD<br>({_current_month})", _ytd_total),
                *[(f"Pred. Cumulative YTD<br>({_future_lbls[i]})", _ytd_cum_cards[i])
                  for i in range(_n_fcast)],
            ]):
                _bg2 = COLOR_BAD if _val2 > 0 else COLOR_GOOD
                _kc2_cols[_ci2].markdown(
                    f'<div style="background:{_bg2};border-radius:10px;padding:14px;text-align:center;opacity:0.85;">'
                    f'<p style="margin:0;font-size:0.75rem;font-weight:700;color:white;opacity:.85;">{_lbl2}</p>'
                    f'<p style="margin:6px 0 0;font-size:1.25rem;font-weight:800;color:white;">${_val2:,.0f}</p>'
                    f'</div>', unsafe_allow_html=True,
                )
            st.markdown("")

            # ── Fully-animated forecast chart ─────────────────────────────────
            _H   = len(_ts_pred)
            _S   = 12
            _TOT = _H + _n_fcast * _S

            _hist_months = list(_ts_pred["Month"].astype(str))
            _all_months  = _hist_months + _future_lbls
            _cum_hist    = [float(_ts_pred["Net_PPV"].iloc[:i+1].sum()) for i in range(_H)]

            # Smooth polyfit trend line for visual display
            _tr_poly     = np.polyfit(np.arange(_H), _vals, 2)
            _fitted_hist = list(np.polyval(_tr_poly, np.arange(_H)))
            _fitted_fc   = list(np.polyval(_tr_poly, np.arange(_H, _H + _n_fcast)))
            # Prediction shadow: poly-trend for history + model forecast for future
            _all_pred_y  = _fitted_hist + list(_pred_vals)

            def _build_frame_data(n_hist_shown, partial_preds):
                _bar_x   = _hist_months[:n_hist_shown]
                _bar_y   = list(_ts_pred["Net_PPV"].iloc[:n_hist_shown])
                _bar_clr = [COLOR_BAD if v > 0 else COLOR_GOOD for v in _bar_y]
                _pbar_x  = _future_lbls
                _pbar_y  = list(partial_preds)
                _tr_x    = _all_months[:max(n_hist_shown, 1)]
                _tr_y    = (_fitted_hist + _fitted_fc)[:max(n_hist_shown, 1)]
                _cum_x   = _hist_months[:n_hist_shown] + [
                    _future_lbls[i] for i, p in enumerate(partial_preds) if p != 0
                ]
                _cum_y   = _cum_hist[:n_hist_shown] + [
                    _ytd_total + sum(partial_preds[:i+1])
                    for i, p in enumerate(partial_preds) if p != 0
                ]
                _band_x, _band_y = [], []
                for i, p in enumerate(partial_preds):
                    if p != 0:
                        _band_x += [_future_lbls[i], _future_lbls[i], None]
                        _band_y += [_fitted_fc[i] - 1.5 * _resid_std,
                                    _fitted_fc[i] + 1.5 * _resid_std, None]
                # Purple shadow: grows with history, snaps to full prediction on forecast
                _purp_x = list(_all_months[:n_hist_shown])
                _purp_y = list(_all_pred_y[:n_hist_shown])
                for _pi, _pp2 in enumerate(partial_preds):
                    if _pp2 != 0:
                        _purp_x.append(_future_lbls[_pi])
                        _purp_y.append(_pred_vals[_pi])  # full value, not partial
                return _bar_x, _bar_y, _bar_clr, _pbar_x, _pbar_y, \
                       _tr_x, _tr_y, _cum_x, _cum_y, _band_x, _band_y, _purp_x, _purp_y

            # Pre-populate with final frame so axes auto-range correctly on first render
            _bx0, _by0, _bc0, _px0, _py0, _tx0, _ty0, _cx0, _cy0, _sx0, _sy0, _purp_x0, _purp_y0 = \
                _build_frame_data(_H, _pred_vals)

            _fig_fc = go.Figure(data=[
                go.Bar(x=_bx0, y=_by0, name="Actual", marker_color=_bc0, opacity=0.85),
                go.Bar(x=_px0, y=_py0,
                       name=f"Predicted ({_best_name or 'Model'})",
                       marker_color="rgba(59,130,246,0.50)",
                       marker_line=dict(color=COLOR_NEUTRAL, width=2)),
                go.Scatter(x=_tx0, y=_ty0, mode="lines", name="Trend",
                           line=dict(color=COLOR_NEUTRAL, width=2, dash="dot")),
                go.Scatter(x=_cx0, y=_cy0, mode="lines+markers",
                           name="Cumulative (YTD)",
                           line=dict(color="#f59e0b", width=2),
                           marker=dict(size=6), yaxis="y2"),
                go.Scatter(x=_sx0, y=_sy0, mode="lines", name="±1.5σ range",
                           line=dict(color="rgba(59,130,246,0.40)", width=8)),
                go.Scatter(x=_purp_x0, y=_purp_y0, mode="lines",
                           name="Prediction curve",
                           line=dict(color="rgba(147,51,234,0.30)", width=14)),
            ])

            _frames = []
            for _fi in range(_TOT):
                if _fi < _H:
                    _nh, _pp = _fi + 1, [0.0] * _n_fcast
                else:
                    _nh  = _H
                    _idx = _fi - _H
                    _bi  = _idx // _S
                    _si  = _idx % _S + 1
                    _pp  = [
                        _pred_vals[j] * min(_si, _S) / _S if j < _bi
                        else (_pred_vals[j] * _si / _S if j == _bi else 0.0)
                        for j in range(_n_fcast)
                    ]
                _bx, _by, _bc, _px, _py, _tx, _ty, _cx, _cy, _sx, _sy, _purp_x, _purp_y = \
                    _build_frame_data(_nh, _pp)
                _frames.append(go.Frame(
                    data=[
                        go.Bar(x=_bx, y=_by, marker_color=_bc, opacity=0.85),
                        go.Bar(x=_px, y=_py),
                        go.Scatter(x=_tx, y=_ty, mode="lines"),
                        go.Scatter(x=_cx, y=_cy, mode="lines+markers", yaxis="y2"),
                        go.Scatter(x=_sx, y=_sy, mode="lines"),
                        go.Scatter(x=_purp_x, y=_purp_y, mode="lines"),
                    ],
                    traces=[0, 1, 2, 3, 4, 5],
                    name=str(_fi),
                ))
            _fig_fc.frames = _frames

            _fig_fc.update_layout(
                uirevision="ppv_forecast",
                barmode="overlay",
                plot_bgcolor="white", paper_bgcolor="white",
                margin=dict(t=80, b=20, l=10, r=80),
                yaxis=dict(title="Net PPV (USD)",
                           zeroline=True, zerolinecolor="#9ca3af", zerolinewidth=1.5),
                yaxis2=dict(title="Cumulative (USD)", overlaying="y", side="right",
                            showgrid=False, zeroline=False),
                xaxis=dict(categoryorder="array", categoryarray=_all_months),
                height=500,
                legend=dict(orientation="h", yanchor="bottom", y=1.05,
                            xanchor="right", x=1),
                updatemenus=[dict(
                    type="buttons", showactive=False, y=1.22, x=0.0, xanchor="left",
                    buttons=[
                        dict(label="▶ Animate", method="animate",
                             args=[None, dict(frame=dict(duration=60, redraw=True),
                                             transition=dict(duration=15, easing="cubic-in-out"),
                                             fromcurrent=False, mode="immediate")]),
                        dict(label="⏸ Stop", method="animate",
                             args=[[None], dict(frame=dict(duration=0, redraw=False),
                                               mode="immediate")]),
                    ],
                )],
                sliders=[dict(
                    active=0, y=0,
                    currentvalue=dict(prefix="Frame: ", font=dict(size=10),
                                      visible=True, xanchor="right"),
                    len=0.88, x=0.12,
                    steps=[dict(
                        method="animate",
                        args=[[str(i)], dict(mode="immediate",
                                             frame=dict(duration=60, redraw=True),
                                             transition=dict(duration=0))],
                        label="" if i % 5 != 0 else str(i),
                    ) for i in range(_TOT)],
                )],
            )
            st.plotly_chart(_fig_fc, use_container_width=True)

        else:
            st.info("At least 4 months of data are required for the predictive model.")
    else:
        st.info("YearMonth column not available for time-series forecasting.")

# ── Tab 8: Search ────────────────────────────────────────────────────────────────
with tabs[7]:
    _mat_col = "Material_Number"
    _desc_col = "Material_Description"

    _search_q = st.text_input(
        "🔍 Search component",
        placeholder="Enter material number or description...",
        key="search_component",
    )

    if not _search_q or not _search_q.strip():
        st.info("Enter the name or number of a component to see its full analysis.")
    else:
        _q = _search_q.strip()
        _mask_search = (
            dff[_mat_col].str.contains(_q, case=False, na=False, regex=False)
            | dff[_desc_col].str.contains(_q, case=False, na=False, regex=False)
        ) if _mat_col in dff.columns and _desc_col in dff.columns else pd.Series(False, index=dff.index)

        _df_s = dff[_mask_search].copy()

        if _df_s.empty:
            st.warning(f"No records found for `{_q}`.")
        else:
            # Si hay multiples materiales coincidentes mostrar selector
            _found_mats = _df_s[_mat_col].unique().tolist() if _mat_col in _df_s.columns else []
            if len(_found_mats) > 1:
                _sel_mat_s = st.selectbox(
                    f"{len(_found_mats)} materials found — select one:",
                    _found_mats,
                    key="search_mat_pick",
                )
                _df_s = _df_s[_df_s[_mat_col] == _sel_mat_s]
            else:
                _sel_mat_s = _found_mats[0] if _found_mats else _search_q

            _desc_s = _df_s[_desc_col].iloc[0] if _desc_col in _df_s.columns and not _df_s.empty else ""
            st.markdown(f"## {_sel_mat_s}")
            if _desc_s:
                st.caption(_desc_s)
            st.markdown("---")

            # ─ KPIs ──────────────────────────────────────────────────────────
            _sk1, _sk2, _sk3, _sk4, _sk5 = st.columns(5)
            _sk1.metric("Records",           f"{len(_df_s):,}")
            _sk2_val = _df_s[PPV].sum()
            _sk2_bg  = "#16a34a" if _sk2_val <= 0 else "#dc2626"
            _sk2.markdown(
                f"""<div style="background:{_sk2_bg};border-radius:8px;padding:14px 16px;text-align:center;">
                    <p style="margin:0;font-size:0.78rem;font-weight:700;color:white;opacity:0.88;">Total PPV (USD)</p>
                    <p style="margin:4px 0 0;font-size:1.35rem;font-weight:800;color:white;">${_sk2_val:,.2f}</p>
                </div>""", unsafe_allow_html=True,
            )
            _sk3.metric("PPV Average (USD)",  f"${_df_s[PPV].mean():,.2f}")
            _sk4.metric("Unfavorable (USD)",  f"${_df_s.loc[_df_s[PPV]>0, PPV].sum():,.2f}")
            _sk5.metric("Favorable (USD)",    f"${_df_s.loc[_df_s[PPV]<=0, PPV].sum():,.2f}")

            st.markdown("")

            # ─ Tendencia PPV en el tiempo ─────────────────────────────────
            if "YearMonth" in _df_s.columns:
                _ts_s = (
                    _df_s[_df_s["YearMonth"] != ""]
                    .groupby("YearMonth")[PPV].sum()
                    .reset_index().sort_values("YearMonth")
                )
                if not _ts_s.empty:
                    _fig_ts_s = _line(_ts_s, "YearMonth", PPV, f"Net PPV by Month — {_sel_mat_s}")
                    # Agregar barras de favorable/desfavorable como area rellena
                    _ts_s["Unfavorable"] = _df_s[_df_s[PPV] > 0].groupby("YearMonth")[PPV].sum().reindex(_ts_s["YearMonth"]).values
                    _ts_s["Favorable"]   = _df_s[_df_s[PPV] <= 0].groupby("YearMonth")[PPV].sum().reindex(_ts_s["YearMonth"]).values
                    st.plotly_chart(_fig_ts_s, use_container_width=True)

            # ─ PPV por Proveedor (barra 2D) ──────────────────────────────
            _sc_l, _sc_r = st.columns(2)
            if "Vendor_Name" in _df_s.columns:
                _vend_s = (
                    _df_s.groupby("Vendor_Name")
                    .agg(PPV_Total=(PPV, "sum"), Records=(PPV, "count"))
                    .reset_index().sort_values("PPV_Total", ascending=True)
                )
                _colors_v = ["#ef4444" if v > 0 else "#22c55e" for v in _vend_s["PPV_Total"]]
                _fig_vbar = go.Figure(go.Bar(
                    x=_vend_s["PPV_Total"],
                    y=_vend_s["Vendor_Name"],
                    orientation="h",
                    marker_color=_colors_v,
                    text=[f"${v:,.0f}" for v in _vend_s["PPV_Total"]],
                    textposition="outside",
                    hovertemplate="<b>%{y}</b><br>PPV: $%{x:,.2f}<extra></extra>",
                ))
                _fig_vbar.add_vline(x=0, line_color="#6b7280", line_width=1)
                _fig_vbar.update_layout(
                    title="PPV by Vendor",
                    plot_bgcolor="white", paper_bgcolor="white",
                    margin=dict(t=40, b=10, l=10, r=80),
                    xaxis=dict(title="PPV (USD)", showgrid=True, gridcolor="#e5e7eb"),
                    yaxis=dict(title=""),
                    height=420,
                )
                with _sc_l:
                    st.plotly_chart(_fig_vbar, use_container_width=True)

            # ─ Tendencia P_Price_Difference por proveedor (outliers + mejor proveedor) ─
            if PRICE in _df_s.columns and "Vendor_Name" in _df_s.columns and "YearMonth" in _df_s.columns:
                _ts_price_s = (
                    _df_s[_df_s["YearMonth"] != ""]
                    .groupby(["YearMonth", "Vendor_Name"])
                    .agg(P_Price_Difference=(PRICE, "sum"), Records=(PRICE, "count"))
                    .reset_index()
                    .sort_values("YearMonth")
                )
                if not _ts_price_s.empty:
                    # Outlier detection
                    _all_pp = _ts_price_s["P_Price_Difference"].values
                    _pp_out_mask, _pp_model, _pp_scores = _best_outlier_model(_all_pp)
                    _ts_price_s["_is_outlier"] = _pp_out_mask

                    _fig_pp_s = px.line(
                        _ts_price_s, x="YearMonth", y="P_Price_Difference",
                        color="Vendor_Name", markers=True,
                        title="P_Price_Difference by Vendor Over Time",
                        labels={"P_Price_Difference": "Price Diff. (USD)", "Vendor_Name": "Vendor"},
                    )
                    _fig_pp_s.add_hline(y=0, line_dash="dash", line_color="#9ca3af", line_width=1)

                    # Outliers en rojo
                    _df_pp_out = _ts_price_s[_ts_price_s["_is_outlier"]]
                    if not _df_pp_out.empty:
                        _fig_pp_s.add_trace(go.Scatter(
                            x=_df_pp_out["YearMonth"],
                            y=_df_pp_out["P_Price_Difference"],
                            mode="markers",
                            name="Outlier",
                            marker=dict(color="red", size=13, symbol="circle-open",
                                        line=dict(width=2.5, color="red")),
                            hovertemplate="<b>⚠ OUTLIER</b><br>Month: %{x}<br>Price Diff.: $%{y:,.2f}<extra></extra>",
                        ))

                    # Mejor proveedor (multi) o tendencia (single)
                    _n_vend_s = _ts_price_s["Vendor_Name"].nunique()
                    if _n_vend_s > 1:
                        _vend_score = (
                            _ts_price_s.groupby("Vendor_Name")
                            .agg(P_Total=("P_Price_Difference", "sum"),
                                 Reg_Total=("Records", "sum"))
                            .reset_index()
                        )
                        _vend_score["Score"] = _vend_score["P_Total"] / _vend_score["Reg_Total"]
                        _best_s = _vend_score.loc[_vend_score["Score"].idxmin(), "Vendor_Name"]
                        _df_best_s = _ts_price_s[_ts_price_s["Vendor_Name"] == _best_s].sort_values("YearMonth")
                        if not _df_best_s.empty:
                            _last_s = _df_best_s.iloc[-1]
                            _fig_pp_s.add_annotation(
                                x=_last_s["YearMonth"],
                                y=_last_s["P_Price_Difference"],
                                text=f"<b>✅ {_best_s}</b><br>Best price",
                                showarrow=True, arrowhead=3,
                                arrowcolor="#16a34a", arrowwidth=2, arrowsize=1.4,
                                ax=0, ay=-48,
                                bgcolor="rgba(220,252,231,0.9)",
                                bordercolor="#16a34a", borderwidth=1.5,
                                font=dict(color="#15803d", size=11),
                            )
                    else:
                        _ts_single = _ts_price_s.sort_values("YearMonth").copy()
                        _y_sp = _ts_single["P_Price_Difference"].values
                        _x_sp = np.arange(len(_y_sp))
                        if len(_x_sp) >= 2:
                            _coef_s = np.polyfit(_x_sp, _y_sp, 1)
                            _fig_pp_s.add_trace(go.Scatter(
                                x=_ts_single["YearMonth"],
                                y=np.polyval(_coef_s, _x_sp),
                                mode="lines", name="Trend",
                                line=dict(color="#f59e0b", dash="dot", width=2),
                                hoverinfo="skip",
                            ))
                            # Central trend message
                            _slope_s = _coef_s[0]
                            if _slope_s < 0:
                                _trend_text  = "📉 Downward trend"
                                _trend_bg    = "rgba(220,252,231,0.92)"
                                _trend_color = "#15803d"
                                _trend_border = "#16a34a"
                            else:
                                _trend_text  = "📈 Upward trend"
                                _trend_bg    = "rgba(254,226,226,0.92)"
                                _trend_color = "#b91c1c"
                                _trend_border = "#ef4444"
                            _fig_pp_s.add_annotation(
                                x=0.5, y=0.5,
                                xref="paper", yref="paper",
                                text=f"<b>{_trend_text}</b>",
                                showarrow=False,
                                font=dict(size=16, color=_trend_color),
                                bgcolor=_trend_bg,
                                bordercolor=_trend_border,
                                borderwidth=2,
                                borderpad=10,
                                opacity=0.85,
                            )

                    _fig_pp_s.update_layout(
                        plot_bgcolor="white", paper_bgcolor="white",
                        margin=dict(t=40, b=10, l=10, r=10),
                        legend=dict(orientation="h", yanchor="top", y=-0.2),
                        height=420,
                    )
                    with _sc_r:
                        st.plotly_chart(_fig_pp_s, use_container_width=True)
                        _n_pp_out = int(_pp_out_mask.sum())
                        _pp_scores_str = " | ".join(
                            f"**{k}**: {v:.4f}" for k, v in sorted(_pp_scores.items(), key=lambda x: x[1])
                        )
                        st.caption(
                            f"Outliers: model **{_pp_model}** (lowest KS) · {_n_pp_out} detected  \n"
                            f"KS Scores: {_pp_scores_str}"
                        )

            # ─ Distribucion de PPV (histograma + box + outliers) ──────────
            def _iqr_outliers(series):
                q1, q3 = series.quantile(0.25), series.quantile(0.75)
                iqr = q3 - q1
                return (series < q1 - 1.5 * iqr) | (series > q3 + 1.5 * iqr)

            _sd_l, _sd_r = st.columns(2)
            with _sd_l:
                _ppv_vals   = _df_s[PPV].dropna()
                _out_mask_b = _iqr_outliers(_ppv_vals)
                _inliers    = _ppv_vals[~_out_mask_b]
                _outliers   = _ppv_vals[_out_mask_b]
                _q1  = _ppv_vals.quantile(0.25)
                _q3  = _ppv_vals.quantile(0.75)
                _med = _ppv_vals.median()
                _avg = _ppv_vals.mean()

                _fig_dist = go.Figure()
                # Histograma favorable (negativo)
                _fig_dist.add_trace(go.Histogram(
                    x=_inliers[_inliers <= 0],
                    name="Favorable", marker_color="#22c55e", opacity=0.7,
                    hovertemplate="PPV: %{x:,.0f}<br>Records: %{y}<extra>Favorable</extra>",
                ))
                # Unfavorable histogram (positive)
                _fig_dist.add_trace(go.Histogram(
                    x=_inliers[_inliers > 0],
                    name="Unfavorable", marker_color="#ef4444", opacity=0.7,
                    hovertemplate="PPV: %{x:,.0f}<br>Records: %{y}<extra>Unfavorable</extra>",
                ))
                # Outliers como scatter sobre el eje
                if len(_outliers) > 0:
                    _fig_dist.add_trace(go.Scatter(
                        x=_outliers, y=[0] * len(_outliers),
                        mode="markers",
                        marker=dict(color="#dc2626", size=10, symbol="circle-open",
                                    line=dict(width=2)),
                        name=f"Outliers ({len(_outliers)})",
                        hovertemplate="Outlier: $%{x:,.2f}<extra></extra>",
                    ))
                # Lineas de referencia
                _fig_dist.add_vline(x=0,    line_color="#374151",  line_width=1.5, line_dash="solid",
                                    annotation_text="0",    annotation_position="top right")
                _fig_dist.add_vline(x=_med, line_color="#6366f1",  line_width=1.5, line_dash="dash",
                                    annotation_text=f"Med ${_med:,.0f}", annotation_position="top right")
                _fig_dist.add_vline(x=_avg, line_color="#f59e0b",  line_width=1.5, line_dash="dot",
                                    annotation_text=f"Avg ${_avg:,.0f}", annotation_position="top left")
                # Banda IQR
                _fig_dist.add_vrect(
                    x0=_q1, x1=_q3,
                    fillcolor="#e0e7ff", opacity=0.25, line_width=0,
                    annotation_text="IQR", annotation_position="top left",
                )
                _fig_dist.update_layout(
                    title="PPV Distribution",
                    barmode="overlay",
                    xaxis=dict(title="PPV (USD)", showgrid=True, gridcolor="#e5e7eb"),
                    yaxis=dict(title="Records"),
                    plot_bgcolor="white", paper_bgcolor="white",
                    margin=dict(t=40, b=10),
                    legend=dict(orientation="h", yanchor="bottom", y=1.01),
                )
                st.plotly_chart(_fig_dist, use_container_width=True)
            with _sd_r:
                if "Vendor_Name" in _df_s.columns:
                    _fig_viol = go.Figure()
                    for _vn_v in _df_s["Vendor_Name"].unique():
                        _vdf_v  = _df_s[_df_s["Vendor_Name"] == _vn_v][PPV]
                        _omask_v = _iqr_outliers(_vdf_v)
                        _fig_viol.add_trace(go.Violin(
                            x=[_vn_v] * len(_vdf_v),
                            y=_vdf_v,
                            name=_vn_v, box_visible=True, points=False,
                            meanline_visible=True, opacity=0.7,
                        ))
                        if _omask_v.any():
                            _fig_viol.add_trace(go.Scatter(
                                x=[_vn_v] * int(_omask_v.sum()),
                                y=_vdf_v[_omask_v],
                                mode="markers",
                                marker=dict(color="#dc2626", size=8, symbol="circle-open",
                                            line=dict(width=2)),
                                name=f"Outlier {_vn_v}", showlegend=False,
                            ))
                    _fig_viol.add_hline(y=0, line_dash="dash", line_color="#9ca3af", line_width=1)
                    _fig_viol.update_layout(
                        title="PPV Distribution by Vendor",
                        plot_bgcolor="white", paper_bgcolor="white",
                        margin=dict(t=40, b=10), showlegend=False,
                        violinmode="overlay",
                    )
                    st.plotly_chart(_fig_viol, use_container_width=True)

            # ─ ANOVA: Vendor_Name vs Total_Variance_Amount ────────────────
            _anova_cat = "Vendor_Name"
            _anova_num = "Total_Variance_Amount_num" if "Total_Variance_Amount_num" in _df_s.columns else PPV
            if _anova_cat in _df_s.columns and _anova_num in _df_s.columns:
                _df_an = _df_s[[_anova_cat, _anova_num]].dropna().copy()
                _df_an = _df_an[_df_an[_anova_cat].astype(str).str.strip() != ""]
                _groups_an = [g[_anova_num].values for _, g in _df_an.groupby(_anova_cat) if len(g) >= 2]

                if len(_groups_an) >= 2:
                    from scipy import stats as _scipy_stats

                    # F-stat y p-value
                    _f_stat, _p_val = _scipy_stats.f_oneway(*_groups_an)

                    # Medias por grupo
                    _mean_by_group = (
                        _df_an.groupby(_anova_cat)[_anova_num]
                        .agg(["mean", "std", "count"])
                        .reset_index()
                        .rename(columns={"mean": "Media", "std": "Std", "count": "N"})
                        .sort_values("Media", ascending=False)
                    )
                    _ci95 = 1.96 * _mean_by_group["Std"] / np.sqrt(_mean_by_group["N"])
                    _mean_by_group["CI95"] = _ci95.values

                    # Asignar indice numerico a cada proveedor (eje X)
                    _vendor_order = _mean_by_group[_anova_cat].tolist()
                    _vendor_idx   = {v: i for i, v in enumerate(_vendor_order)}
                    _df_an["_x"]  = _df_an[_anova_cat].map(_vendor_idx)

                    # Jitter almacenado para poder referenciar posiciones exactas despues
                    _rng = np.random.default_rng(42)
                    _df_an["_jitter"] = _rng.uniform(-0.25, 0.25, size=len(_df_an))
                    _df_an["_xj"]     = _df_an["_x"] + _df_an["_jitter"]

                    # Media global
                    _global_mean = float(_df_an[_anova_num].mean())

                    # Proveedor más caro (media más alta) y más barato (media más baja)
                    _vendor_exp = _mean_by_group.iloc[0][_anova_cat]
                    _vendor_chp = _mean_by_group.iloc[-1][_anova_cat]
                    _pts_exp    = _df_an[_df_an[_anova_cat] == _vendor_exp]
                    _pts_chp    = _df_an[_df_an[_anova_cat] == _vendor_chp]

                    # Punto individual más caro y más barato de todo el dataset
                    _idx_max = _df_an[_anova_num].idxmax()
                    _idx_min = _df_an[_anova_num].idxmin()
                    _pt_max  = _df_an.loc[_idx_max]
                    _pt_min  = _df_an.loc[_idx_min]

                    _fig_an = go.Figure()

                    # ── Elipses envolventes ───────────────────────────────
                    _y_range = float(_df_an[_anova_num].max() - _df_an[_anova_num].min())
                    _pad_x   = 0.38
                    _pad_y   = _y_range * 0.04
                    for _epts, _ec, _efill, _elabel in [
                        (_pts_exp, "#ef4444", "rgba(239,68,68,0.07)",   f"★ Most expensive: {_vendor_exp}"),
                        (_pts_chp, "#16a34a", "rgba(34,197,94,0.07)",   f"★ Cheapest: {_vendor_chp}"),
                    ]:
                        _ex0 = float(_epts["_xj"].min()) - _pad_x
                        _ex1 = float(_epts["_xj"].max()) + _pad_x
                        _ey0 = float(_epts[_anova_num].min()) - _pad_y
                        _ey1 = float(_epts[_anova_num].max()) + _pad_y
                        _fig_an.add_shape(
                            type="circle",
                            x0=_ex0, y0=_ey0, x1=_ex1, y1=_ey1,
                            line=dict(color=_ec, width=2.5, dash="dot"),
                            fillcolor=_efill,
                            layer="below",
                        )
                        # Etiqueta de la elipse
                        _fig_an.add_annotation(
                            x=(_ex0 + _ex1) / 2,
                            y=_ey1,
                            xref="x", yref="y",
                            text=f"<b>{_elabel}</b>",
                            showarrow=False,
                            yanchor="bottom",
                            font=dict(size=10, color=_ec),
                            bgcolor="rgba(255,255,255,0.80)",
                            bordercolor=_ec,
                            borderwidth=1,
                            borderpad=4,
                        )

                    # ── Puntos individuales con jitter ────────────────────
                    _pt_colors = ["#ef4444" if v > 0 else "#22c55e" for v in _df_an[_anova_num]]
                    _fig_an.add_trace(go.Scatter(
                        x=_df_an["_xj"],
                        y=_df_an[_anova_num],
                        mode="markers",
                        marker=dict(color=_pt_colors, size=6, opacity=0.45,
                                    line=dict(color="white", width=0.4)),
                        name="Records",
                        hovertemplate=(
                            "<b>%{customdata}</b><br>"
                            "Total Variance: $%{y:,.2f}<extra></extra>"
                        ),
                        customdata=_df_an[_anova_cat].values,
                    ))

                    # ── Medias por proveedor (diamante + IC 95%) ──────────
                    _mean_colors = ["#b91c1c" if v > 0 else "#15803d" for v in _mean_by_group["Media"]]
                    _fig_an.add_trace(go.Scatter(
                        x=list(range(len(_vendor_order))),
                        y=_mean_by_group["Media"].values,
                        mode="markers+text",
                        marker=dict(color=_mean_colors, size=14, symbol="diamond",
                                    line=dict(color="white", width=1.5)),
                        error_y=dict(type="data", array=_mean_by_group["CI95"].values,
                                     visible=True, color="#6b7280", thickness=2, width=8),
                        text=[f"${v:,.0f}" for v in _mean_by_group["Media"]],
                        textposition="top center",
                        textfont=dict(size=10),
                        name="Media ± IC95%",
                        hovertemplate=(
                            "<b>%{customdata[0]}</b><br>"
                            "Media: $%{y:,.2f}<br>"
                            "N: %{customdata[1]}<br>"
                            "Std: $%{customdata[2]:,.2f}<extra></extra>"
                        ),
                        customdata=list(zip(
                            _mean_by_group[_anova_cat],
                            _mean_by_group["N"],
                            _mean_by_group["Std"],
                        )),
                    ))

                    # ── Punto individual más caro (estrella roja) ─────────
                    _fig_an.add_trace(go.Scatter(
                        x=[_pt_max["_xj"]],
                        y=[_pt_max[_anova_num]],
                        mode="markers+text",
                        marker=dict(color="#dc2626", size=16, symbol="star",
                                    line=dict(color="white", width=1.5)),
                        text=[f"  Max: ${_pt_max[_anova_num]:,.0f}"],
                        textposition="middle right",
                        textfont=dict(size=10, color="#dc2626"),
                        name=f"Most expensive point",
                        hovertemplate=(
                            "<b>Most expensive point</b><br>"
                            f"Vendor: {_pt_max[_anova_cat]}<br>"
                            "Value: $%{y:,.2f}<extra></extra>"
                        ),
                    ))

                    # ── Cheapest individual point (green star) ──────
                    _fig_an.add_trace(go.Scatter(
                        x=[_pt_min["_xj"]],
                        y=[_pt_min[_anova_num]],
                        mode="markers+text",
                        marker=dict(color="#16a34a", size=16, symbol="star",
                                    line=dict(color="white", width=1.5)),
                        text=[f"  Min: ${_pt_min[_anova_num]:,.0f}"],
                        textposition="middle right",
                        textfont=dict(size=10, color="#16a34a"),
                        name=f"Cheapest point",
                        hovertemplate=(
                            "<b>Cheapest point</b><br>"
                            f"Vendor: {_pt_min[_anova_cat]}<br>"
                            "Value: $%{y:,.2f}<extra></extra>"
                        ),
                    ))

                    # ── Línea de media global ─────────────────────────────
                    _fig_an.add_hline(y=0, line_dash="dash", line_color="#9ca3af", line_width=1)
                    _fig_an.add_hline(
                        y=_global_mean,
                        line_dash="longdash", line_color="#3b82f6", line_width=2,
                        annotation_text=f"<b>Global mean: ${_global_mean:,.0f}</b>",
                        annotation_position="top right",
                        annotation_font=dict(color="#1d4ed8", size=11),
                        annotation_bgcolor="rgba(219,234,254,0.85)",
                        annotation_bordercolor="#3b82f6",
                        annotation_borderwidth=1,
                        annotation_borderpad=5,
                    )

                    # ── Anotación ANOVA p-value ───────────────────────────
                    _sig        = _p_val < 0.05
                    _pval_txt   = f"p = {_p_val:.4f}" if _p_val >= 0.0001 else "p < 0.0001"
                    _f_txt      = f"F = {_f_stat:.2f}"
                    _sig_label  = "✅ Significant difference between vendors" if _sig else "⚠️ No significant difference"
                    _sig_bg     = "rgba(220,252,231,0.9)" if _sig else "rgba(254,249,195,0.9)"
                    _sig_color  = "#15803d" if _sig else "#92400e"
                    _sig_border = "#16a34a" if _sig else "#d97706"
                    _fig_an.add_annotation(
                        x=0.5, y=1.08,
                        xref="paper", yref="paper",
                        text=f"<b>{_sig_label}</b>   {_f_txt}   {_pval_txt}   (α = 0.05)",
                        showarrow=False,
                        font=dict(size=12, color=_sig_color),
                        bgcolor=_sig_bg,
                        bordercolor=_sig_border,
                        borderwidth=1.5,
                        borderpad=7,
                    )

                    _fig_an.update_layout(
                        title="ANOVA — Total Variance Amount by Vendor",
                        xaxis=dict(
                            title="Vendor",
                            tickvals=list(range(len(_vendor_order))),
                            ticktext=_vendor_order,
                            tickangle=-30,
                            tickfont=dict(size=10),
                        ),
                        yaxis=dict(title="Total Variance Amount (USD)",
                                   showgrid=True, gridcolor="#e5e7eb"),
                        plot_bgcolor="white", paper_bgcolor="white",
                        margin=dict(t=90, b=20, l=10, r=10),
                        legend=dict(orientation="h", yanchor="bottom", y=1.02),
                        height=500,
                    )
                    st.plotly_chart(_fig_an, use_container_width=True)

                    # Tabla de medias por proveedor
                    with st.expander("View means by vendor", expanded=False):
                        _mean_fmt = _mean_by_group.copy()
                        _mean_fmt["Media"] = _mean_fmt["Media"].map("${:,.2f}".format)
                        _mean_fmt["Std"]   = _mean_fmt["Std"].map("${:,.2f}".format)
                        _mean_fmt["CI95"]  = _mean_fmt["CI95"].map("±${:,.2f}".format)
                        st.dataframe(_mean_fmt, use_container_width=True, hide_index=True)
                else:
                    st.info("At least 2 vendors with 2+ records are needed for the ANOVA analysis.")
            else:
                st.info("Columns `Vendor_Name` or `Total_Variance_Amount` not found for ANOVA analysis.")

    st.divider()

    # ── Raw data table (all records for the active filters) ────────────────
    st.markdown("### All Records")
    _raw_search = st.text_input(
        "Filter (free text)", placeholder="Type to search in any column...",
        key="search_tab_raw_filter",
    )
    _orig_cols = [c for c in dff.columns if not c.endswith("_num")
                  and c not in ("YearMonth", "Posting_Date")]
    _df_raw = dff[_orig_cols].copy()
    if _raw_search:
        _mask_raw = _df_raw.apply(
            lambda col: col.astype(str).str.contains(_raw_search, case=False, na=False)
        )
        _df_raw = _df_raw[_mask_raw.any(axis=1)]
    st.caption(f"Showing **{len(_df_raw):,}** of **{len(dff):,}** records")
    st.dataframe(_df_raw.reset_index(drop=True), use_container_width=True, height=520)
    st.download_button(
        "Download CSV",
        data=_df_raw.to_csv(index=False).encode("utf-8"),
        file_name=f"PPV_{params['Plant']}_{params['PostingStartDate']}_{params['PostingEndDate']}.csv",
        mime="text/csv",
    )

# ── Tab 9: AI Chatbot ──────────────────────────────────────────────────────────
_AZ_INF_ENDPOINT = "https://k90016277-aippv-resource.services.ai.azure.com/models"
_AZ_INF_API_KEY  = "1quEgPspq8NjEo4zm8STsskX1RwSOc6Yzaiwh0LO8Rl8pnkAjS79JQQJ99CDACHYHv6XJ3w3AAAAACOGCMKx"
_AZ_INF_API_VER  = "2024-05-01-preview"
_AZ_INF_MODEL    = "Kimi-K2.6"

with tabs[8]:
    # ── Messenger-style CSS ────────────────────────────────────────────────
    st.markdown("""
    <style>
    /* ── overall chat wrapper ── */
    .ai-chat-wrap {
        display: flex; flex-direction: column;
        background: #f0f4f9; border-radius: 16px;
        border: 1px solid #dde5f0;
        overflow: hidden; margin-bottom: 0;
    }
    /* ── topbar ── */
    .ai-topbar {
        display: flex; align-items: center; gap: 12px;
        background: linear-gradient(135deg, #1a2a44 0%, #2d4a7a 100%);
        padding: 14px 20px;
    }
    .ai-avatar {
        width: 44px; height: 44px; border-radius: 50%;
        background: rgba(255,255,255,0.15);
        display: flex; align-items: center; justify-content: center;
        font-size: 1.3rem; flex-shrink: 0;
    }
    .ai-topbar-info { flex: 1; }
    .ai-topbar-name { color: #fff; font-weight: 700; font-size: 0.97rem; margin: 0; }
    .ai-topbar-status { color: #94c8a8; font-size: 0.72rem; margin: 0;
        display: flex; align-items: center; gap: 5px; }
    .ai-online-dot {
        width: 7px; height: 7px; border-radius: 50%; background: #4ade80;
        box-shadow: 0 0 5px #4ade80;
        animation: blink-dot 2s ease-in-out infinite;
    }
    @keyframes blink-dot {
        0%,100% { opacity:1; } 50% { opacity:.4; }
    }
    /* ── message bubbles ── */
    .msg-row { display: flex; margin: 6px 18px; }
    .msg-row.user  { justify-content: flex-end; }
    .msg-row.bot   { justify-content: flex-start; }
    .bubble {
        max-width: 72%; padding: 10px 14px; border-radius: 18px;
        font-size: 0.88rem; line-height: 1.5; word-break: break-word;
        box-shadow: 0 2px 8px rgba(0,0,0,0.07);
    }
    .bubble.user {
        background: #2563eb; color: #fff;
        border-bottom-right-radius: 4px;
    }
    .bubble.bot {
        background: #fff; color: #1a2a44;
        border: 1px solid #dde5f0;
        border-bottom-left-radius: 4px;
    }
    .bubble .ts {
        font-size: 0.65rem; opacity: 0.6; margin-top: 4px; text-align: right;
    }
    /* ── typing indicator ── */
    .typing-row { display: flex; margin: 6px 18px 12px; }
    .typing-bubble {
        background: #fff; border: 1px solid #dde5f0;
        border-radius: 18px; border-bottom-left-radius: 4px;
        padding: 12px 16px; display: flex; gap: 5px; align-items: center;
        box-shadow: 0 2px 8px rgba(0,0,0,0.07);
    }
    .typing-dot {
        width: 8px; height: 8px; border-radius: 50%; background: #94a3b8;
        animation: typing-bounce 1.3s ease-in-out infinite;
    }
    .typing-dot:nth-child(2) { animation-delay: 0.2s; }
    .typing-dot:nth-child(3) { animation-delay: 0.4s; }
    @keyframes typing-bounce {
        0%,60%,100% { transform: translateY(0); }
        30%          { transform: translateY(-6px); }
    }
    /* ── chat area spacer ── */
    .chat-spacer { height: 10px; }
    </style>
    """, unsafe_allow_html=True)

    # ── SDK import ─────────────────────────────────────────────────────────
    try:
        from azure.ai.inference import ChatCompletionsClient
        from azure.ai.inference.models import AssistantMessage, SystemMessage, UserMessage
        from azure.core.credentials import AzureKeyCredential
    except Exception as _imp_err:
        st.error(f"No se pudo importar Azure AI Inference SDK: {_imp_err}")
        st.info("Ejecuta: `pip install azure-ai-inference`")
        st.stop()

    # ── Topbar header ──────────────────────────────────────────────────────
    _tb_col, _clr_col = st.columns([0.82, 0.18])
    with _tb_col:
        st.markdown("""
        <div class="ai-topbar" style="border-radius:14px 14px 0 0;">
          <div class="ai-avatar">🤖</div>
          <div class="ai-topbar-info">
            <p class="ai-topbar-name">PPV AI Assistant · Kimi-K2.6</p>
            <p class="ai-topbar-status">
              <span class="ai-online-dot"></span> En línea · Azure AI Foundry
            </p>
          </div>
        </div>
        """, unsafe_allow_html=True)
    with _clr_col:
        st.markdown("<div style='height:8px'></div>", unsafe_allow_html=True)
        if st.button("🗑️ Limpiar", use_container_width=True, key="ai_clear_btn"):
            st.session_state["ai_chat_history"] = []
            st.rerun()

    # ── Data context builder ───────────────────────────────────────────────
    def _build_data_context(df: pd.DataFrame) -> str:
        _ctx = [
            "Dataset: PPV (Purchase Price Variance)",
            f"Plant: {params.get('Plant','N/A')}  |  Period: {params.get('PostingStartDate','')} -> {params.get('PostingEndDate','')}",
            f"Total records: {len(df):,}",
        ]
        if PPV in df.columns:
            _s = df[PPV]
            _ctx.append(f"Total PPV: ${_s.sum():,.2f}  |  Avg: ${_s.mean():,.2f}  |  Min: ${_s.min():,.2f}  |  Max: ${_s.max():,.2f}")
            _ctx.append(f"Favorable (PPV<0): {(_s<0).sum():,}  |  Unfavorable (PPV>0): {(_s>0).sum():,}")
        if "YearMonth" in df.columns:
            _mo = df.groupby("YearMonth")[PPV].sum().sort_index()
            _ctx.append("\nMonthly PPV totals:")
            for _k, _v in _mo.items():
                _ctx.append(f"  {_k}: ${_v:,.2f}")
        if "Vendor_Name" in df.columns:
            _tv = df.groupby("Vendor_Name")[PPV].sum().sort_values(key=abs, ascending=False).head(10)
            _ctx.append("\nTop 10 vendors by |PPV|:")
            for _n, _v in _tv.items():
                _ctx.append(f"  {_n}: ${_v:,.2f}")
        if "Material_Description" in df.columns:
            _tm = df.groupby("Material_Description")[PPV].sum().sort_values(key=abs, ascending=False).head(10)
            _ctx.append("\nTop 10 materials by |PPV|:")
            for _n, _v in _tm.items():
                _ctx.append(f"  {_n}: ${_v:,.2f}")
        if "Material_Group_Description" in df.columns:
            _tg = df.groupby("Material_Group_Description")[PPV].sum().sort_values(key=abs, ascending=False).head(8)
            _ctx.append("\nPPV by material group:")
            for _n, _v in _tg.items():
                _ctx.append(f"  {_n}: ${_v:,.2f}")
        _ctx.append(f"\nColumns available: {', '.join(df.columns.tolist())}")
        return "\n".join(_ctx)

    _system_prompt = (
        "You are an expert financial analyst specialising in Purchase Price Variance (PPV) for manufacturing. "
        "Use ONLY the dataset context below to answer. Be concise but precise; cite figures when relevant. "
        "Respond in the same language the user writes in.\n\n"
        "=== DATASET CONTEXT ===\n" + _build_data_context(dff)
    )

    # ── SDK helpers ────────────────────────────────────────────────────────
    def _sdk_messages(history: list):
        _out = [SystemMessage(content=_system_prompt)]
        for _m in history:
            if _m["role"] == "user":
                _out.append(UserMessage(content=_m["content"]))
            elif _m["role"] == "assistant":
                _out.append(AssistantMessage(content=_m["content"]))
        return _out

    def _call_azure(history: list) -> str:
        _cli = ChatCompletionsClient(
            endpoint=_AZ_INF_ENDPOINT,
            credential=AzureKeyCredential(_AZ_INF_API_KEY),
            api_version=_AZ_INF_API_VER,
        )
        _resp = _cli.complete(
            messages=_sdk_messages(history),
            model=_AZ_INF_MODEL,
            max_tokens=2048,
            temperature=0.3,
            top_p=0.9,
        )
        _ans = _resp.choices[0].message.content
        if isinstance(_ans, list):
            _ans = "".join(getattr(_c, "text", str(_c)) for _c in _ans)
        return _ans

    # ── State ──────────────────────────────────────────────────────────────
    if "ai_chat_history" not in st.session_state:
        st.session_state["ai_chat_history"] = []

    # ── Render bubble history ──────────────────────────────────────────────
    import datetime as _dt

    def _bubble(role: str, text: str, ts: str = ""):
        _side = "user" if role == "user" else "bot"
        _ts_html = f'<div class="ts">{ts}</div>' if ts else ""
        return (
            f'<div class="msg-row {_side}">'
            f'<div class="bubble {_side}">{text}{_ts_html}</div>'
            f'</div>'
        )

    _history_html = '<div class="chat-spacer"></div>'
    for _m in st.session_state["ai_chat_history"]:
        _history_html += _bubble(_m["role"], _m["content"])
    _history_html += '<div class="chat-spacer"></div>'

    st.markdown(
        f'<div class="ai-chat-wrap" style="border-top:none; border-radius:0 0 14px 14px;">'
        f'{_history_html}</div>',
        unsafe_allow_html=True
    )

    # ── Input ──────────────────────────────────────────────────────────────
    _user_input = st.chat_input("Escribe tu pregunta…")
    if _user_input:
        # Append user message and re-render immediately
        st.session_state["ai_chat_history"].append({"role": "user", "content": _user_input})

        # Show typing indicator while waiting
        _typing_ph = st.empty()
        _typing_ph.markdown("""
        <div class="ai-chat-wrap" style="border:none; background:transparent;">
          <div class="typing-row">
            <div class="typing-bubble">
              <div class="typing-dot"></div>
              <div class="typing-dot"></div>
              <div class="typing-dot"></div>
            </div>
          </div>
        </div>
        """, unsafe_allow_html=True)

        try:
            _answer = _call_azure(st.session_state["ai_chat_history"])
        except Exception as _e:
            _answer = f"⚠️ Error al contactar Azure AI: {_e}"

        _typing_ph.empty()
        st.session_state["ai_chat_history"].append({"role": "assistant", "content": _answer})
        st.rerun()
