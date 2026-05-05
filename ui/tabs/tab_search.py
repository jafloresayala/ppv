"""
ui/tabs/tab_search.py
Tab 8 — Search: free-text component search + KPIs + trend + ANOVA + raw data table.
"""

import numpy as np
import pandas as pd
import streamlit as st
import plotly.express as px
import plotly.graph_objects as go

from chart_helpers import _best_outlier_model, _line


def render(tab, dff, PPV: str, PRICE: str = "", FX: str = "", params: dict | None = None, **_):
    params = params or {}
    with tab:
        _mat_col  = "Material_Number"
        _desc_col = "Material_Description"

        _search_q = st.text_input(
            "🔍 Search component",
            placeholder="Enter material number or description...",
            key="search_component",
        )

        if not _search_q or not _search_q.strip():
            st.info("Enter the name or number of a component to see its full analysis.")
            _show_raw(dff, PPV, params)
            return

        _q = _search_q.strip()
        if _mat_col in dff.columns and _desc_col in dff.columns:
            _mask = (
                dff[_mat_col].str.contains(_q, case=False, na=False, regex=False)
                | dff[_desc_col].str.contains(_q, case=False, na=False, regex=False)
            )
        elif _mat_col in dff.columns:
            _mask = dff[_mat_col].str.contains(_q, case=False, na=False, regex=False)
        else:
            _mask = pd.Series(False, index=dff.index)

        _df_s = dff[_mask].copy()
        if _df_s.empty:
            st.warning(f"No records found for `{_q}`.")
            _show_raw(dff, PPV, params)
            return

        _found_mats = _df_s[_mat_col].unique().tolist() if _mat_col in _df_s.columns else []
        if len(_found_mats) > 1:
            _sel_mat_s = st.selectbox(
                f"{len(_found_mats)} materials found — select one:",
                _found_mats, key="search_mat_pick",
            )
            _df_s = _df_s[_df_s[_mat_col] == _sel_mat_s]
        else:
            _sel_mat_s = _found_mats[0] if _found_mats else _q

        _desc_s = _df_s[_desc_col].iloc[0] if _desc_col in _df_s.columns and not _df_s.empty else ""
        st.markdown(f"## {_sel_mat_s}")
        if _desc_s:
            st.caption(_desc_s)
        st.markdown("---")

        # KPIs
        _sk1, _sk2, _sk3, _sk4, _sk5 = st.columns(5)
        _sk1.metric("Records", f"{len(_df_s):,}")
        _sk2_val = _df_s[PPV].sum()
        _sk2_bg  = "#16a34a" if _sk2_val <= 0 else "#dc2626"
        _sk2.markdown(
            f"""<div style="background:{_sk2_bg};border-radius:8px;padding:14px 16px;text-align:center;">
                <p style="margin:0;font-size:0.78rem;font-weight:700;color:white;opacity:0.88;">Total PPV (USD)</p>
                <p style="margin:4px 0 0;font-size:1.35rem;font-weight:800;color:white;">${_sk2_val:,.2f}</p>
            </div>""", unsafe_allow_html=True,
        )
        _sk3.metric("PPV Average (USD)", f"${_df_s[PPV].mean():,.2f}")
        _sk4.metric("Unfavorable (USD)", f"${_df_s.loc[_df_s[PPV]>0, PPV].sum():,.2f}")
        _sk5.metric("Favorable (USD)",   f"${_df_s.loc[_df_s[PPV]<=0, PPV].sum():,.2f}")
        st.markdown("")

        # PPV trend
        if "YearMonth" in _df_s.columns:
            _ts_s = (
                _df_s[_df_s["YearMonth"] != ""]
                .groupby("YearMonth")[PPV].sum()
                .reset_index().sort_values("YearMonth")
            )
            if not _ts_s.empty:
                st.plotly_chart(
                    _line(_ts_s, "YearMonth", PPV, f"Net PPV by Month — {_sel_mat_s}"),
                    use_container_width=True,
                )

        _sc_l, _sc_r = st.columns(2)

        # PPV by vendor bar
        if "Vendor_Name" in _df_s.columns:
            _vend_s = (
                _df_s.groupby("Vendor_Name")
                .agg(PPV_Total=(PPV, "sum"), Records=(PPV, "count"))
                .reset_index().sort_values("PPV_Total", ascending=True)
            )
            _colors_v = ["#ef4444" if v > 0 else "#22c55e" for v in _vend_s["PPV_Total"]]
            _fig_vbar = go.Figure(go.Bar(
                x=_vend_s["PPV_Total"], y=_vend_s["Vendor_Name"],
                orientation="h", marker_color=_colors_v,
                text=[f"${v:,.0f}" for v in _vend_s["PPV_Total"]], textposition="outside",
                hovertemplate="<b>%{y}</b><br>PPV: $%{x:,.2f}<extra></extra>",
            ))
            _fig_vbar.add_vline(x=0, line_color="#6b7280", line_width=1)
            _fig_vbar.update_layout(
                title="PPV by Vendor", plot_bgcolor="white", paper_bgcolor="white",
                margin=dict(t=40, b=10, l=10, r=80),
                xaxis=dict(title="PPV (USD)", showgrid=True, gridcolor="#e5e7eb"),
                yaxis=dict(title=""), height=420,
            )
            with _sc_l:
                st.plotly_chart(_fig_vbar, use_container_width=True)

        # P_Price_Difference by vendor over time
        if PRICE and PRICE in _df_s.columns and "Vendor_Name" in _df_s.columns and "YearMonth" in _df_s.columns:
            _ts_price_s = (
                _df_s[_df_s["YearMonth"] != ""]
                .groupby(["YearMonth", "Vendor_Name"])
                .agg(P_Price_Difference=(PRICE, "sum"), Records=(PRICE, "count"))
                .reset_index().sort_values("YearMonth")
            )
            if not _ts_price_s.empty:
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

                _df_pp_out = _ts_price_s[_ts_price_s["_is_outlier"]]
                if not _df_pp_out.empty:
                    _fig_pp_s.add_trace(go.Scatter(
                        x=_df_pp_out["YearMonth"], y=_df_pp_out["P_Price_Difference"],
                        mode="markers", name="Outlier",
                        marker=dict(color="red", size=13, symbol="circle-open",
                                    line=dict(width=2.5, color="red")),
                        hovertemplate="<b>⚠ OUTLIER</b><br>Month: %{x}<br>Price Diff.: $%{y:,.2f}<extra></extra>",
                    ))

                _n_vend_s = _ts_price_s["Vendor_Name"].nunique()
                if _n_vend_s > 1:
                    _vend_score = (
                        _ts_price_s.groupby("Vendor_Name")
                        .agg(P_Total=("P_Price_Difference", "sum"), Reg_Total=("Records", "sum"))
                        .reset_index()
                    )
                    _vend_score["Score"] = _vend_score["P_Total"] / _vend_score["Reg_Total"]
                    _best_s = _vend_score.loc[_vend_score["Score"].idxmin(), "Vendor_Name"]
                    _df_best_s = _ts_price_s[_ts_price_s["Vendor_Name"] == _best_s].sort_values("YearMonth")
                    if not _df_best_s.empty:
                        _last_s = _df_best_s.iloc[-1]
                        _fig_pp_s.add_annotation(
                            x=_last_s["YearMonth"], y=_last_s["P_Price_Difference"],
                            text=f"<b>✅ {_best_s}</b><br>Best price",
                            showarrow=True, arrowhead=3,
                            arrowcolor="#16a34a", arrowwidth=2, arrowsize=1.4,
                            ax=0, ay=-48, bgcolor="rgba(220,252,231,0.9)",
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
                            x=_ts_single["YearMonth"], y=np.polyval(_coef_s, _x_sp),
                            mode="lines", name="Trend",
                            line=dict(color="#f59e0b", dash="dot", width=2), hoverinfo="skip",
                        ))
                        _slope_s = _coef_s[0]
                        if _slope_s < 0:
                            _trend_text  = "📉 Downward trend"; _trend_bg = "rgba(220,252,231,0.92)"
                            _trend_color = "#15803d"; _trend_border = "#16a34a"
                        else:
                            _trend_text  = "📈 Upward trend"; _trend_bg = "rgba(254,226,226,0.92)"
                            _trend_color = "#b91c1c"; _trend_border = "#ef4444"
                        _fig_pp_s.add_annotation(
                            x=0.5, y=0.5, xref="paper", yref="paper",
                            text=f"<b>{_trend_text}</b>", showarrow=False,
                            font=dict(size=16, color=_trend_color),
                            bgcolor=_trend_bg, bordercolor=_trend_border,
                            borderwidth=2, borderpad=10, opacity=0.85,
                        )
                _fig_pp_s.update_layout(
                    plot_bgcolor="white", paper_bgcolor="white",
                    margin=dict(t=40, b=10, l=10, r=10),
                    legend=dict(orientation="h", yanchor="top", y=-0.2), height=420,
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

        # Distribution histogram + violin
        def _iqr_outliers(series):
            q1, q3 = series.quantile(0.25), series.quantile(0.75)
            iqr = q3 - q1
            return (series < q1 - 1.5 * iqr) | (series > q3 + 1.5 * iqr)

        _sd_l, _sd_r = st.columns(2)
        with _sd_l:
            _ppv_vals   = _df_s[PPV].dropna()
            _out_mask_b = _iqr_outliers(_ppv_vals)
            _inliers    = _ppv_vals[~_out_mask_b]; _outliers = _ppv_vals[_out_mask_b]
            _q1  = _ppv_vals.quantile(0.25); _q3  = _ppv_vals.quantile(0.75)
            _med = _ppv_vals.median();       _avg = _ppv_vals.mean()
            _fig_dist = go.Figure()
            _fig_dist.add_trace(go.Histogram(x=_inliers[_inliers <= 0], name="Favorable",
                                              marker_color="#22c55e", opacity=0.7))
            _fig_dist.add_trace(go.Histogram(x=_inliers[_inliers > 0], name="Unfavorable",
                                              marker_color="#ef4444", opacity=0.7))
            if len(_outliers) > 0:
                _fig_dist.add_trace(go.Scatter(
                    x=_outliers, y=[0]*len(_outliers), mode="markers",
                    marker=dict(color="#dc2626", size=10, symbol="circle-open",
                                line=dict(width=2)),
                    name=f"Outliers ({len(_outliers)})",
                    hovertemplate="Outlier: $%{x:,.2f}<extra></extra>",
                ))
            _fig_dist.add_vline(x=0,    line_color="#374151", line_width=1.5,
                                annotation_text="0",             annotation_position="top right")
            _fig_dist.add_vline(x=_med, line_color="#6366f1", line_width=1.5, line_dash="dash",
                                annotation_text=f"Med ${_med:,.0f}", annotation_position="top right")
            _fig_dist.add_vline(x=_avg, line_color="#f59e0b", line_width=1.5, line_dash="dot",
                                annotation_text=f"Avg ${_avg:,.0f}", annotation_position="top left")
            _fig_dist.add_vrect(x0=_q1, x1=_q3, fillcolor="#e0e7ff", opacity=0.25, line_width=0,
                                annotation_text="IQR", annotation_position="top left")
            _fig_dist.update_layout(
                title="PPV Distribution", barmode="overlay",
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
                        x=[_vn_v]*len(_vdf_v), y=_vdf_v, name=_vn_v,
                        box_visible=True, points=False, meanline_visible=True, opacity=0.7,
                    ))
                    if _omask_v.any():
                        _fig_viol.add_trace(go.Scatter(
                            x=[_vn_v]*int(_omask_v.sum()), y=_vdf_v[_omask_v],
                            mode="markers",
                            marker=dict(color="#dc2626", size=8, symbol="circle-open",
                                        line=dict(width=2)),
                            name=f"Outlier {_vn_v}", showlegend=False,
                        ))
                _fig_viol.add_hline(y=0, line_dash="dash", line_color="#9ca3af", line_width=1)
                _fig_viol.update_layout(
                    title="PPV Distribution by Vendor",
                    plot_bgcolor="white", paper_bgcolor="white",
                    margin=dict(t=40, b=10), showlegend=False, violinmode="overlay",
                )
                st.plotly_chart(_fig_viol, use_container_width=True)

        # ANOVA
        _anova_cat = "Vendor_Name"
        _anova_num = "Total_Variance_Amount_num" if "Total_Variance_Amount_num" in _df_s.columns else PPV
        if _anova_cat in _df_s.columns and _anova_num in _df_s.columns:
            _df_an = _df_s[[_anova_cat, _anova_num]].dropna().copy()
            _df_an = _df_an[_df_an[_anova_cat].astype(str).str.strip() != ""]
            _groups_an = [g[_anova_num].values for _, g in _df_an.groupby(_anova_cat) if len(g) >= 2]

            if len(_groups_an) >= 2:
                from scipy import stats as _scipy_stats
                _f_stat, _p_val = _scipy_stats.f_oneway(*_groups_an)

                _mean_by_group = (
                    _df_an.groupby(_anova_cat)[_anova_num]
                    .agg(["mean", "std", "count"]).reset_index()
                    .rename(columns={"mean": "Media", "std": "Std", "count": "N"})
                    .sort_values("Media", ascending=False)
                )
                _ci95 = 1.96 * _mean_by_group["Std"] / np.sqrt(_mean_by_group["N"])
                _mean_by_group["CI95"] = _ci95.values
                _vendor_order = _mean_by_group[_anova_cat].tolist()
                _vendor_idx   = {v: i for i, v in enumerate(_vendor_order)}
                _df_an["_x"]  = _df_an[_anova_cat].map(_vendor_idx)
                _rng = np.random.default_rng(42)
                _df_an["_jitter"] = _rng.uniform(-0.25, 0.25, size=len(_df_an))
                _df_an["_xj"]     = _df_an["_x"] + _df_an["_jitter"]
                _global_mean      = float(_df_an[_anova_num].mean())
                _vendor_exp = _mean_by_group.iloc[0][_anova_cat]
                _vendor_chp = _mean_by_group.iloc[-1][_anova_cat]
                _pts_exp    = _df_an[_df_an[_anova_cat] == _vendor_exp]
                _pts_chp    = _df_an[_df_an[_anova_cat] == _vendor_chp]
                _idx_max    = _df_an[_anova_num].idxmax()
                _idx_min    = _df_an[_anova_num].idxmin()
                _pt_max     = _df_an.loc[_idx_max]
                _pt_min     = _df_an.loc[_idx_min]

                _fig_an = go.Figure()
                _y_range = float(_df_an[_anova_num].max() - _df_an[_anova_num].min())
                _pad_x   = 0.38; _pad_y = _y_range * 0.04

                for _epts, _ec, _efill, _elabel in [
                    (_pts_exp, "#ef4444", "rgba(239,68,68,0.07)",   f"★ Most expensive: {_vendor_exp}"),
                    (_pts_chp, "#16a34a", "rgba(34,197,94,0.07)",   f"★ Cheapest: {_vendor_chp}"),
                ]:
                    _ex0 = float(_epts["_xj"].min()) - _pad_x; _ex1 = float(_epts["_xj"].max()) + _pad_x
                    _ey0 = float(_epts[_anova_num].min()) - _pad_y; _ey1 = float(_epts[_anova_num].max()) + _pad_y
                    _fig_an.add_shape(type="circle", x0=_ex0, y0=_ey0, x1=_ex1, y1=_ey1,
                                      line=dict(color=_ec, width=2.5, dash="dot"),
                                      fillcolor=_efill, layer="below")
                    _fig_an.add_annotation(x=(_ex0+_ex1)/2, y=_ey1, xref="x", yref="y",
                                           text=f"<b>{_elabel}</b>", showarrow=False, yanchor="bottom",
                                           font=dict(size=10, color=_ec),
                                           bgcolor="rgba(255,255,255,0.80)",
                                           bordercolor=_ec, borderwidth=1, borderpad=4)

                _pt_colors = ["#ef4444" if v > 0 else "#22c55e" for v in _df_an[_anova_num]]
                _fig_an.add_trace(go.Scatter(
                    x=_df_an["_xj"], y=_df_an[_anova_num], mode="markers",
                    marker=dict(color=_pt_colors, size=6, opacity=0.45, line=dict(color="white", width=0.4)),
                    name="Records",
                    hovertemplate="<b>%{customdata}</b><br>Total Variance: $%{y:,.2f}<extra></extra>",
                    customdata=_df_an[_anova_cat].values,
                ))
                _mean_colors = ["#b91c1c" if v > 0 else "#15803d" for v in _mean_by_group["Media"]]
                _fig_an.add_trace(go.Scatter(
                    x=list(range(len(_vendor_order))), y=_mean_by_group["Media"].values,
                    mode="markers+text",
                    marker=dict(color=_mean_colors, size=14, symbol="diamond",
                                line=dict(color="white", width=1.5)),
                    error_y=dict(type="data", array=_mean_by_group["CI95"].values,
                                 visible=True, color="#6b7280", thickness=2, width=8),
                    text=[f"${v:,.0f}" for v in _mean_by_group["Media"]], textposition="top center",
                    textfont=dict(size=10), name="Media ± IC95%",
                    hovertemplate=(
                        "<b>%{customdata[0]}</b><br>Media: $%{y:,.2f}<br>"
                        "N: %{customdata[1]}<br>Std: $%{customdata[2]:,.2f}<extra></extra>"
                    ),
                    customdata=list(zip(_mean_by_group[_anova_cat], _mean_by_group["N"], _mean_by_group["Std"])),
                ))
                _fig_an.add_trace(go.Scatter(
                    x=[_pt_max["_xj"]], y=[_pt_max[_anova_num]], mode="markers+text",
                    marker=dict(color="#dc2626", size=16, symbol="star", line=dict(color="white", width=1.5)),
                    text=[f"  Max: ${_pt_max[_anova_num]:,.0f}"], textposition="middle right",
                    textfont=dict(size=10, color="#dc2626"), name="Most expensive point",
                    hovertemplate=f"<b>Most expensive point</b><br>Vendor: {_pt_max[_anova_cat]}<br>Value: $%{{y:,.2f}}<extra></extra>",
                ))
                _fig_an.add_trace(go.Scatter(
                    x=[_pt_min["_xj"]], y=[_pt_min[_anova_num]], mode="markers+text",
                    marker=dict(color="#16a34a", size=16, symbol="star", line=dict(color="white", width=1.5)),
                    text=[f"  Min: ${_pt_min[_anova_num]:,.0f}"], textposition="middle right",
                    textfont=dict(size=10, color="#16a34a"), name="Cheapest point",
                    hovertemplate=f"<b>Cheapest point</b><br>Vendor: {_pt_min[_anova_cat]}<br>Value: $%{{y:,.2f}}<extra></extra>",
                ))
                _fig_an.add_hline(y=0, line_dash="dash", line_color="#9ca3af", line_width=1)
                _fig_an.add_hline(y=_global_mean, line_dash="longdash", line_color="#3b82f6", line_width=2,
                                  annotation_text=f"<b>Global mean: ${_global_mean:,.0f}</b>",
                                  annotation_position="top right",
                                  annotation_font=dict(color="#1d4ed8", size=11),
                                  annotation_bgcolor="rgba(219,234,254,0.85)",
                                  annotation_bordercolor="#3b82f6", annotation_borderwidth=1, annotation_borderpad=5)
                _sig = _p_val < 0.05
                _pval_txt  = f"p = {_p_val:.4f}" if _p_val >= 0.0001 else "p < 0.0001"
                _f_txt     = f"F = {_f_stat:.2f}"
                _sig_label = "✅ Significant difference between vendors" if _sig else "⚠️ No significant difference"
                _sig_bg    = "rgba(220,252,231,0.9)" if _sig else "rgba(254,249,195,0.9)"
                _sig_color = "#15803d" if _sig else "#92400e"
                _sig_border = "#16a34a" if _sig else "#d97706"
                _fig_an.add_annotation(
                    x=0.5, y=1.08, xref="paper", yref="paper",
                    text=f"<b>{_sig_label}</b>   {_f_txt}   {_pval_txt}   (α = 0.05)",
                    showarrow=False, font=dict(size=12, color=_sig_color),
                    bgcolor=_sig_bg, bordercolor=_sig_border, borderwidth=1.5, borderpad=7,
                )
                _fig_an.update_layout(
                    title="ANOVA — Total Variance Amount by Vendor",
                    xaxis=dict(title="Vendor", tickvals=list(range(len(_vendor_order))),
                               ticktext=_vendor_order, tickangle=-30, tickfont=dict(size=10)),
                    yaxis=dict(title="Total Variance Amount (USD)", showgrid=True, gridcolor="#e5e7eb"),
                    plot_bgcolor="white", paper_bgcolor="white",
                    margin=dict(t=90, b=20, l=10, r=10),
                    legend=dict(orientation="h", yanchor="bottom", y=1.02),
                    height=500,
                )
                st.plotly_chart(_fig_an, use_container_width=True)
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
        _show_raw(dff, PPV, params)


def _show_raw(dff: "pd.DataFrame", PPV: str, params: dict):
    """Render the all-records table at the bottom of the Search tab."""
    st.markdown("### All Records")
    _raw_search = st.text_input(
        "Filter (free text)", placeholder="Type to search in any column...",
        key="search_tab_raw_filter",
    )
    _orig_cols = [c for c in dff.columns if not c.endswith("_num") and c not in ("YearMonth", "Posting_Date")]
    _df_raw = dff[_orig_cols].copy()
    if _raw_search:
        _mask_raw = _df_raw.apply(lambda col: col.astype(str).str.contains(_raw_search, case=False, na=False))
        _df_raw = _df_raw[_mask_raw.any(axis=1)]
    st.caption(f"Showing **{len(_df_raw):,}** of **{len(dff):,}** records")
    st.dataframe(_df_raw.reset_index(drop=True), use_container_width=True, height=520)
    st.download_button(
        "Download CSV",
        data=_df_raw.to_csv(index=False).encode("utf-8"),
        file_name=f"PPV_{params.get('Plant','?')}_{params.get('PostingStartDate','?')}_{params.get('PostingEndDate','?')}.csv",
        mime="text/csv",
    )
