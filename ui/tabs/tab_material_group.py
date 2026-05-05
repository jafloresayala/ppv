"""
ui/tabs/tab_material_group.py
Tab 2 — Material Group: bar + treemap + drill-down with trend analysis.
"""

import numpy as np
import pandas as pd
import streamlit as st
import plotly.express as px
import plotly.graph_objects as go

from chart_helpers import _bar, _line


def render(tab, dff, PPV: str, **_):
    with tab:
        if "Material_Group_Description" not in dff.columns or PPV not in dff.columns:
            return

        col_l, col_r = st.columns(2)
        mg = (
            dff.groupby("Material_Group_Description")[PPV]
            .sum().reset_index()
            .rename(columns={PPV: "PPV_Total"})
            .sort_values("PPV_Total", ascending=False)
        )

        with col_l:
            mg_bar_fig = _bar(mg, "Material_Group_Description", "PPV_Total",
                              "PPV by Material Group (Top 20)", top_n=20)
            ev_mg_bar = st.plotly_chart(
                mg_bar_fig, use_container_width=True,
                on_select="rerun", key="mg_bar_sel",
            )
            sel_from_bar = None
            if ev_mg_bar and ev_mg_bar.selection and ev_mg_bar.selection.points:
                sel_from_bar = ev_mg_bar.selection.points[0].get("x")
            st.session_state["ppv_sel_mg_tree"] = sel_from_bar
            sel_mg_tree = sel_from_bar

        with col_r:
            df_tree = mg.copy()
            df_tree["Abs_PPV"] = df_tree["PPV_Total"].abs()
            df_tree["Type"] = df_tree["PPV_Total"].apply(
                lambda v: "Favorable" if v <= 0 else "Unfavorable"
            )
            fig_tree = px.treemap(
                df_tree, path=["Type", "Material_Group_Description"],
                values="Abs_PPV", color="PPV_Total",
                color_continuous_scale=["#16a34a", "#f9fafb", "#dc2626"],
                color_continuous_midpoint=0,
                title="PPV Proportion by Material Group",
            )
            fig_tree.update_layout(margin=dict(t=40, b=5))
            st.plotly_chart(fig_tree, use_container_width=True)

        # ── Drill-down ────────────────────────────────────────────────────
        if not sel_mg_tree:
            st.caption("Click a group in the treemap to see details.")
            return

        st.markdown("---")
        st.markdown(f"#### Detail — `{sel_mg_tree}`")
        df_sel = dff[dff["Material_Group_Description"] == sel_mg_tree]
        t1, t2, t3, t4 = st.columns(4)
        t1.metric("Records", f"{len(df_sel):,}")
        mg_total = df_sel[PPV].sum()
        mg_bg    = "#16a34a" if mg_total <= 0 else "#dc2626"
        t2.markdown(
            f"""<div style="background:{mg_bg};border-radius:8px;padding:14px 16px;text-align:center;">
                <p style="margin:0;font-size:0.78rem;font-weight:700;color:white;opacity:0.88;">Total PPV (USD)</p>
                <p style="margin:4px 0 0;font-size:1.35rem;font-weight:800;color:white;">${mg_total:,.2f}</p>
            </div>""", unsafe_allow_html=True,
        )
        t3.metric("Unfavorable (USD)", f"${df_sel.loc[df_sel[PPV]>0, PPV].sum():,.2f}")
        t4.metric("Favorable (USD)",   f"${df_sel.loc[df_sel[PPV]<=0, PPV].sum():,.2f}")

        if "Material_Number" in df_sel.columns:
            by_mat = (
                df_sel.groupby(["Material_Number", "Material_Description"])
                .agg(PPV_Total=(PPV, "sum"), Records=(PPV, "count"))
                .reset_index()
            )
            desf = by_mat[by_mat["PPV_Total"] > 0].sort_values("PPV_Total", ascending=False).head(10).copy()
            fav  = by_mat[by_mat["PPV_Total"] <= 0].sort_values("PPV_Total").head(10).copy()

            col_desf, col_fav = st.columns(2)
            with col_desf:
                hd, tg = st.columns([3, 1])
                hd.markdown("**Top 10 unfavorable components 🔴**")
                show_tbl = tg.toggle("Table", value=False, key="tg_desf")
                if not desf.empty:
                    if show_tbl:
                        desf_fmt = desf.copy()
                        desf_fmt["PPV_Total"] = desf_fmt["PPV_Total"].map("${:,.2f}".format)
                        st.dataframe(desf_fmt, use_container_width=True, hide_index=True)
                    else:
                        fig_d = go.Figure(go.Bar(
                            x=desf["PPV_Total"], y=desf["Material_Number"],
                            orientation="h", marker_color="#dc2626",
                            text=desf["PPV_Total"].map("${:,.2f}".format),
                            textposition="outside",
                            hovertemplate="%{y}<br>PPV: %{x:$,.2f}<extra></extra>",
                        ))
                        fig_d.update_layout(
                            plot_bgcolor="white", paper_bgcolor="white",
                            margin=dict(t=10, b=10, l=10, r=80),
                            yaxis=dict(autorange="reversed"), height=320,
                        )
                        st.plotly_chart(fig_d, use_container_width=True)
                else:
                    st.caption("No unfavorable components.")

            with col_fav:
                hd2, tg2 = st.columns([3, 1])
                hd2.markdown("**Top 10 favorable components 🟢**")
                show_tbl2 = tg2.toggle("Table", value=False, key="tg_fav")
                if not fav.empty:
                    if show_tbl2:
                        fav_fmt = fav.copy()
                        fav_fmt["PPV_Total"] = fav_fmt["PPV_Total"].map("${:,.2f}".format)
                        st.dataframe(fav_fmt, use_container_width=True, hide_index=True)
                    else:
                        fig_f = go.Figure(go.Bar(
                            x=fav["PPV_Total"], y=fav["Material_Number"],
                            orientation="h", marker_color="#16a34a",
                            text=fav["PPV_Total"].map("${:,.2f}".format),
                            textposition="outside",
                            hovertemplate="%{y}<br>PPV: %{x:$,.2f}<extra></extra>",
                        ))
                        fig_f.update_layout(
                            plot_bgcolor="white", paper_bgcolor="white",
                            margin=dict(t=10, b=10, l=10, r=80),
                            yaxis=dict(autorange="reversed"), height=320,
                        )
                        st.plotly_chart(fig_f, use_container_width=True)
                else:
                    st.caption("No favorable components.")

            # ── Group trend ────────────────────────────────────────────────
            if "YearMonth" in df_sel.columns:
                ts_tree = (
                    df_sel[df_sel["YearMonth"] != ""]
                    .groupby("YearMonth")[PPV].sum()
                    .reset_index().sort_values("YearMonth")
                    .reset_index(drop=True)
                )
                if not ts_tree.empty:
                    ts_x       = np.arange(len(ts_tree))
                    ts_y       = ts_tree[PPV].values
                    ts_z       = np.polyfit(ts_x, ts_y, 1)
                    ts_trend_y = np.polyval(ts_z, ts_x)
                    ts_resid   = ts_y - ts_trend_y
                    ts_sigma   = ts_resid.std()
                    ts_upper   = ts_trend_y + 2 * ts_sigma
                    ts_lower   = ts_trend_y - 2 * ts_sigma
                    ts_anom    = ts_tree[np.abs(ts_resid) > 2 * ts_sigma]

                    slope      = ts_z[0]
                    rng        = ts_y.max() - ts_y.min() if len(ts_y) > 1 else 1
                    slope_norm = abs(slope) / (rng if rng != 0 else 1)
                    if slope_norm < 0.03:
                        trend_lbl, trend_bg, trend_icon = "Normal",   "#6b7280", "➡️"
                    elif slope > 0:
                        trend_lbl, trend_bg, trend_icon = "Upward",   "#dc2626", "📈"
                    else:
                        trend_lbl, trend_bg, trend_icon = "Downward", "#16a34a", "📉"

                    st.markdown("**Group PPV Trend**")
                    fig_mg_trend = _line(ts_tree, "YearMonth", PPV, f"Trend — {sel_mg_tree}")
                    fig_mg_trend.add_annotation(
                        text=f"{trend_icon} {trend_lbl}",
                        xref="paper", yref="paper", x=0.01, y=0.97,
                        showarrow=False,
                        font=dict(size=13, color="white"),
                        bgcolor=trend_bg, bordercolor=trend_bg,
                        borderwidth=1, borderpad=6, opacity=0.92,
                    )
                    fig_mg_trend.add_trace(go.Scatter(
                        x=ts_tree["YearMonth"], y=ts_upper.tolist(),
                        mode="lines", name="Upper (2σ)",
                        line=dict(color="#f97316", width=1.5, dash="dash"),
                        hovertemplate="Upper 2σ: %{y:$,.0f}<extra></extra>",
                    ))
                    fig_mg_trend.add_trace(go.Scatter(
                        x=ts_tree["YearMonth"], y=ts_lower.tolist(),
                        mode="lines", name="Lower (2σ)",
                        line=dict(color="#3b82f6", width=1.5, dash="dash"),
                        fill="tonexty", fillcolor="rgba(99,102,241,0.07)",
                        hovertemplate="Lower 2σ: %{y:$,.0f}<extra></extra>",
                    ))
                    fig_mg_trend.add_trace(go.Scatter(
                        x=ts_tree["YearMonth"], y=ts_trend_y.tolist(),
                        mode="lines", name="Trend",
                        line=dict(color="#6366f1", width=2, dash="dot"),
                        hovertemplate="Trend: %{y:$,.0f}<extra></extra>",
                    ))
                    if not ts_anom.empty:
                        fig_mg_trend.add_trace(go.Scatter(
                            x=ts_anom["YearMonth"], y=ts_anom[PPV],
                            mode="markers", name="Anomaly (>2σ)",
                            marker=dict(symbol="circle-open", size=20, color="#dc2626",
                                        line=dict(width=2.5, color="#dc2626")),
                            hovertemplate="Anomaly: %{y:$,.0f}<extra></extra>",
                        ))
                    ev_mg_trend = st.plotly_chart(
                        fig_mg_trend, use_container_width=True,
                        on_select="rerun", key="mg_trend_sel",
                    )
                    sel_mg_per = None
                    if ev_mg_trend and ev_mg_trend.selection and ev_mg_trend.selection.points:
                        raw_x = ev_mg_trend.selection.points[0].get("x", "")
                        sel_mg_per = str(raw_x)[:7]
                    st.session_state["ppv_sel_mg_trend"] = sel_mg_per

                    if sel_mg_per:
                        df_mg_per = df_sel[df_sel["YearMonth"] == sel_mg_per]
                        st.markdown(f"##### Records — `{sel_mg_tree}` · `{sel_mg_per}`")
                        rp1, rp2, rp3 = st.columns(3)
                        rp1.metric("Records", f"{len(df_mg_per):,}")
                        rp2_val = df_mg_per[PPV].sum()
                        rp2_bg  = "#16a34a" if rp2_val <= 0 else "#dc2626"
                        rp2.markdown(
                            f"""<div style="background:{rp2_bg};border-radius:8px;padding:14px 16px;text-align:center;">
                                <p style="margin:0;font-size:0.78rem;font-weight:700;color:white;opacity:0.88;">Total PPV (USD)</p>
                                <p style="margin:4px 0 0;font-size:1.35rem;font-weight:800;color:white;">${rp2_val:,.2f}</p>
                            </div>""", unsafe_allow_html=True,
                        )
                        rp3.metric(
                            "Materials",
                            f"{df_mg_per['Material_Number'].nunique():,}"
                            if "Material_Number" in df_mg_per.columns else "—",
                        )

                        if "Material_Number" in df_mg_per.columns:
                            per_mat = (
                                df_mg_per.groupby(["Material_Number", "Material_Description"])
                                .agg(PPV_Total=(PPV, "sum"), Records=(PPV, "count"))
                                .reset_index()
                                .sort_values("PPV_Total", ascending=False)
                            )
                            per_mat["% of month"] = (
                                per_mat["PPV_Total"] / df_mg_per[PPV].sum() * 100
                            ).map("{:.1f}%".format)
                            per_mat["PPV_Total"] = per_mat["PPV_Total"].map("${:,.2f}".format)
                            st.markdown("**Period contributors (by material)**")
                            st.dataframe(per_mat, use_container_width=True, hide_index=True)

                        show_cols = [c for c in [
                            "Posting_Date_in_the_Document", "Material_Number",
                            "Material_Description", "Vendor_Name",
                            "Total_Variance_Amount", "MExtended_PO_Price",
                            "M_Extended__Std_Amount",
                        ] if c in df_mg_per.columns]
                        if show_cols:
                            st.markdown("**Individual records for the period**")
                            heat_df = (
                                df_mg_per[show_cols]
                                .sort_values("Posting_Date_in_the_Document")
                                .reset_index(drop=True)
                            )
                            if "Total_Variance_Amount_num" in df_mg_per.columns:
                                heat_vals = (
                                    df_mg_per
                                    .sort_values("Posting_Date_in_the_Document")
                                    .reset_index(drop=True)["Total_Variance_Amount_num"]
                                )
                                v_min = heat_vals.min()
                                v_max = heat_vals.max()

                                def _heat_color(row_idx, vals=heat_vals, vmin=v_min, vmax=v_max):
                                    v = vals.iloc[row_idx] if row_idx < len(vals) else 0
                                    if vmax == vmin:
                                        return "background-color: white"
                                    if v < 0:
                                        t = max(0.0, v / vmin)
                                        r = int(255 - t * (255 - 22))
                                        g = int(255 - t * (255 - 163))
                                        b = int(255 - t * (255 - 74))
                                    else:
                                        t = min(1.0, v / vmax) if vmax > 0 else 0
                                        r = int(255 - t * (255 - 220))
                                        g = int(255 - t * 255)
                                        b = int(255 - t * 255)
                                    return f"background-color: rgb({r},{g},{b})"

                                def _apply_heat(df_s):
                                    styles = pd.DataFrame("", index=df_s.index, columns=df_s.columns)
                                    for ri in range(len(df_s)):
                                        styles.iloc[ri] = _heat_color(ri)
                                    return styles

                                st.dataframe(
                                    heat_df.style.apply(_apply_heat, axis=None),
                                    use_container_width=True, height=340, hide_index=True,
                                )
                            else:
                                st.dataframe(heat_df, use_container_width=True, height=320, hide_index=True)
                    else:
                        st.caption("Click a point on the trend to see records for the period.")
