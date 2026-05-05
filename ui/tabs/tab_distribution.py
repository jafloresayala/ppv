"""
ui/tabs/tab_distribution.py
Tab 6 — Statistical Distribution: box plots + period drill-down with pie charts.
"""

import numpy as np
import streamlit as st
import plotly.express as px
import plotly.graph_objects as go

from chart_helpers import _bar, _line


def render(tab, dff, PPV: str, **_):
    with tab:
        if PPV not in dff.columns:
            return
        if "Material_Group_Description" not in dff.columns:
            st.info("Column `Material_Group_Description` not found in data.")
            return

        top_groups = (
            dff.groupby("Material_Group_Description")[PPV]
            .sum().abs().nlargest(10).index.tolist()
        )
        df_box = dff[dff["Material_Group_Description"].isin(top_groups)]

        _mg_order = (
            df_box.groupby("Material_Group_Description")[PPV]
            .sum().sort_values(ascending=False).index.tolist()
        )
        _mg_ppv_sum = df_box.groupby("Material_Group_Description")[PPV].sum()
        _top3_loss  = _mg_ppv_sum.nlargest(3).index.tolist()

        fig_box = px.box(
            df_box, x="Material_Group_Description", y=PPV,
            title="Variance by Material Group (Top 10)",
            color_discrete_sequence=["#3b82f6"],
            labels={PPV: "PPV (USD)", "Material_Group_Description": ""},
            category_orders={"Material_Group_Description": _mg_order},
        )
        fig_box.add_hline(y=0, line_dash="dash", line_color="#dc2626", line_width=1)

        _rect_colors   = {0: "rgba(220,38,38,0.18)", 1: "rgba(251,146,60,0.14)", 2: "rgba(250,204,21,0.12)"}
        _border_colors = {0: "#dc2626", 1: "#f97316", 2: "#eab308"}
        for _rank, _gname in enumerate(_top3_loss):
            if _gname not in _mg_order:
                continue
            _xi = _mg_order.index(_gname)
            _label = ["#1 Biggest loss", "#2", "#3"][_rank]
            fig_box.add_shape(
                type="rect",
                x0=_xi - 0.48, x1=_xi + 0.48, y0=0, y1=1,
                xref="x", yref="paper",
                fillcolor=_rect_colors[_rank],
                line=dict(color=_border_colors[_rank], width=2.5 if _rank == 0 else 1.5),
                layer="below",
            )
            fig_box.add_annotation(
                x=_xi, y=1.0, xref="x", yref="paper",
                text=f"<b>{_label}</b>", showarrow=False, yanchor="bottom",
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

        _sel_mg = None
        if ev_box and ev_box.selection and ev_box.selection.points:
            _sel_mg = ev_box.selection.points[0].get("x")
        st.session_state["ppv_sel_mg_dist"] = _sel_mg

        if not _sel_mg:
            st.caption("Click on an element in the box plot to see group details.")
            return

        st.markdown(f"#### Detail — `{_sel_mg}`")
        _df_mg = dff[dff["Material_Group_Description"] == _sel_mg]
        _dm1, _dm2, _dm3, _dm4 = st.columns(4)
        _dm1.metric("Records", f"{len(_df_mg):,}")
        _dm2_val = _df_mg[PPV].sum()
        _dm2_bg  = "#16a34a" if _dm2_val <= 0 else "#dc2626"
        _dm2.markdown(
            f"""<div style="background:{_dm2_bg};border-radius:8px;padding:14px 16px;text-align:center;">
                <p style="margin:0;font-size:0.78rem;font-weight:700;color:white;opacity:0.88;">Total PPV (USD)</p>
                <p style="margin:4px 0 0;font-size:1.35rem;font-weight:800;color:white;">${_dm2_val:,.2f}</p>
            </div>""", unsafe_allow_html=True,
        )
        _dm3.metric("PPV Average (USD)",  f"${_df_mg[PPV].mean():,.2f}")
        _dm4.metric(
            "Materials",
            f"{_df_mg['Material_Number'].nunique():,}"
            if "Material_Number" in _df_mg.columns else "—",
        )

        if "Material_Number" in _df_mg.columns:
            _mg_mat = (
                _df_mg.groupby(["Material_Number", "Material_Description"])
                .agg(PPV_Total=(PPV, "sum"), Records=(PPV, "count"))
                .reset_index()
                .sort_values("PPV_Total", key=abs, ascending=False)
            )
            st.markdown("**PPV by material within the group**")
            st.plotly_chart(
                _bar(_mg_mat.head(15), "PPV_Total", "Material_Number",
                     f"Top materials — {_sel_mg}", orientation="h"),
                use_container_width=True,
            )

        if "YearMonth" not in _df_mg.columns:
            return

        _ts_mg = (
            _df_mg[_df_mg["YearMonth"] != ""]
            .groupby("YearMonth")[PPV].sum()
            .reset_index().sort_values("YearMonth")
        )
        if _ts_mg.empty:
            return

        st.markdown("**Group PPV Trend**")
        _ev_trend = st.plotly_chart(
            _line(_ts_mg, "YearMonth", PPV, f"PPV Trend — {_sel_mg}"),
            use_container_width=True,
            on_select="rerun", key="dist_trend_sel",
        )

        _sel_period = None
        if _ev_trend and _ev_trend.selection and _ev_trend.selection.points:
            _raw_x = _ev_trend.selection.points[0].get("x", "")
            _sel_period = str(_raw_x)[:7]
        if _sel_period is not None and _sel_period != st.session_state.get("ppv_sel_trend_per"):
            st.session_state["ppv_sel_trend_per"] = _sel_period
        elif _sel_period is None:
            _sel_period = st.session_state.get("ppv_sel_trend_per")

        if not _sel_period:
            st.caption("Click on a trend point to see contributors for the period.")
            return

        _df_per = _df_mg[_df_mg["YearMonth"] == _sel_period]
        st.markdown(f"##### Main contributors — `{_sel_mg}` · `{_sel_period}`")
        _pc1, _pc2, _pc3 = st.columns(3)
        _pc1.metric("Records in the month", f"{len(_df_per):,}")
        _pc2_val = _df_per[PPV].sum()
        _pc2_bg  = "#16a34a" if _pc2_val <= 0 else "#dc2626"
        _pc2.markdown(
            f"""<div style="background:{_pc2_bg};border-radius:8px;padding:14px 16px;text-align:center;">
                <p style="margin:0;font-size:0.78rem;font-weight:700;color:white;opacity:0.88;">Total PPV (USD)</p>
                <p style="margin:4px 0 0;font-size:1.35rem;font-weight:800;color:white;">${_pc2_val:,.2f}</p>
            </div>""", unsafe_allow_html=True,
        )
        _pc3.metric(
            "Unique materials",
            f"{_df_per['Material_Number'].nunique():,}"
            if "Material_Number" in _df_per.columns else "—",
        )

        _has_mat  = "Material_Number" in _df_per.columns
        _has_vend = "Vendor_Name"      in _df_per.columns

        if not (_has_mat or _has_vend):
            return
        _pie_col_l, _pie_col_r = st.columns(2)

        if _has_mat:
            _contrib_mat = (
                _df_per.groupby(["Material_Number", "Material_Description"])
                .agg(PPV_Total=(PPV, "sum"), Records=(PPV, "count"))
                .reset_index()
                .sort_values("PPV_Total", key=abs, ascending=False)
            )
            _cm_abs    = _contrib_mat["PPV_Total"].abs()
            _cm_colors = ["#22c55e" if v <= 0 else "#ef4444" for v in _contrib_mat["PPV_Total"]]
            _fig_cm = go.Figure(go.Pie(
                labels=_contrib_mat["Material_Number"].astype(str),
                values=_cm_abs,
                marker=dict(colors=_cm_colors, line=dict(color="white", width=2)),
                textinfo="label+percent",
                hovertemplate=(
                    "<b>%{label}</b><br>PPV: $%{customdata[0]:,.2f}<br>"
                    "Share (abs): %{percent}<br>Records: %{customdata[1]}<extra></extra>"
                ),
                customdata=np.column_stack([
                    _contrib_mat["PPV_Total"].values,
                    _contrib_mat["Records"].values,
                ]),
                hole=0.35,
            ))
            _fig_cm.update_layout(
                title=f"By material — {_sel_period}", paper_bgcolor="white",
                margin=dict(t=50, b=10, l=10, r=10), height=400,
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
            _cv_abs    = _contrib_vend["PPV_Total"].abs()
            _cv_colors = ["#22c55e" if v <= 0 else "#ef4444" for v in _contrib_vend["PPV_Total"]]
            _fig_cv = go.Figure(go.Pie(
                labels=_contrib_vend["Vendor_Name"],
                values=_cv_abs,
                marker=dict(colors=_cv_colors, line=dict(color="white", width=2)),
                textinfo="label+percent",
                hovertemplate=(
                    "<b>%{label}</b><br>PPV: $%{customdata[0]:,.2f}<br>"
                    "Share (abs): %{percent}<br>Records: %{customdata[1]}<extra></extra>"
                ),
                customdata=np.column_stack([
                    _contrib_vend["PPV_Total"].values,
                    _contrib_vend["Records"].values,
                ]),
                hole=0.35,
            ))
            _fig_cv.update_layout(
                title=f"By vendor — {_sel_period}", paper_bgcolor="white",
                margin=dict(t=50, b=10, l=10, r=10), height=400,
                legend=dict(orientation="v", font=dict(size=10)),
            )
            with _pie_col_r:
                st.plotly_chart(_fig_cv, use_container_width=True)
