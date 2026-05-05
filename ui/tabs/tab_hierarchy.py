"""
ui/tabs/tab_hierarchy.py
Tab 5 — Product Hierarchy: trend classification + interactive bar + time trend.
"""

import numpy as np
import streamlit as st
import plotly.express as px
import plotly.graph_objects as go


def render(tab, dff, PPV: str, **_):
    with tab:
        PH_COL = "Product_Hierarchy"
        if PH_COL not in dff.columns or PPV not in dff.columns:
            st.info("Column `Product_Hierarchy` not found in data. Verify the API includes it.")
            return

        ph = (
            dff[dff[PH_COL].notna() & (dff[PH_COL].astype(str).str.strip() != "")]
            .groupby(PH_COL)
            .agg(PPV_Total=(PPV, "sum"), Records=(PPV, "count"))
            .reset_index()
            .sort_values("PPV_Total", ascending=False)
        )
        ph[PH_COL] = ph[PH_COL].astype(str)

        if ph.empty:
            st.info("No data with Product_Hierarchy for the current filter.")
            return

        # KPIs
        k1, k2, k3, k4 = st.columns(4)
        k1.metric("Distinct Hierarchies", f"{len(ph):,}")
        ph_total = ph["PPV_Total"].sum()
        ph_bg    = "#16a34a" if ph_total <= 0 else "#dc2626"
        k2.markdown(
            f"""<div style="background:{ph_bg};border-radius:8px;padding:14px 16px;text-align:center;">
                <p style="margin:0;font-size:0.78rem;font-weight:700;color:white;opacity:0.88;">Total PPV (USD)</p>
                <p style="margin:4px 0 0;font-size:1.35rem;font-weight:800;color:white;">${ph_total:,.2f}</p>
            </div>""", unsafe_allow_html=True,
        )
        k3.metric("Unfavorable", f"${ph.loc[ph['PPV_Total']>0,'PPV_Total'].sum():,.2f}")
        k4.metric("Favorable",   f"${ph.loc[ph['PPV_Total']<=0,'PPV_Total'].sum():,.2f}")

        # Per-hierarchy trend classification
        ph_trend = {}
        if "YearMonth" in dff.columns:
            ph_ts_all = (
                dff[
                    dff[PH_COL].notna()
                    & (dff[PH_COL].astype(str).str.strip() != "")
                    & (dff["YearMonth"] != "")
                ]
                .groupby([PH_COL, "YearMonth"])[PPV]
                .sum().reset_index()
            )
            for phn in ph[PH_COL].tolist():
                sub = ph_ts_all[ph_ts_all[PH_COL].astype(str) == str(phn)].sort_values("YearMonth")
                if len(sub) >= 2:
                    sy = sub[PPV].values
                    sc = np.polyfit(np.arange(len(sy)), sy, 1)[0]
                    pct = abs(sc) / (abs(sy.mean()) + 1e-9) * 100
                    if   sc > 0 and pct > 5: ph_trend[str(phn)] = "up"
                    elif sc < 0 and pct > 5: ph_trend[str(phn)] = "down"
                    else:                    ph_trend[str(phn)] = "stable"
                else:
                    ph_trend[str(phn)] = "stable"

        TREND_ICON   = {"up": "⬆", "down": "⬇", "stable": "➡"}
        TREND_BORDER = {"up": "#f97316", "down": "#10b981", "stable": "#9ca3af"}
        TREND_LABEL  = {"up": "Rising ⚠", "down": "Falling ✅", "stable": "Stable"}

        ph_colors  = ["#22c55e" if v <= 0 else "#ef4444" for v in ph["PPV_Total"]]
        ph_borders = [TREND_BORDER[ph_trend.get(str(h), "stable")] for h in ph[PH_COL]]
        ph_labels  = [
            f"{TREND_ICON[ph_trend.get(str(h), 'stable')]} ${v:,.0f}"
            for h, v in zip(ph[PH_COL], ph["PPV_Total"])
        ]
        ph_custom = np.column_stack([
            ph["Records"].values,
            [TREND_LABEL[ph_trend.get(str(h), "stable")] for h in ph[PH_COL]],
        ])

        fig_ph_bar = go.Figure(go.Bar(
            x=ph[PH_COL], y=ph["PPV_Total"],
            marker_color=ph_colors,
            marker_line_color=ph_borders,
            marker_line_width=3,
            text=ph_labels,
            textposition="outside",
            customdata=ph_custom,
            hovertemplate=(
                "<b>%{x}</b><br>PPV: $%{y:,.2f}<br>"
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
            height=480, dragmode="select",
        )

        ph_hd, ph_tg = st.columns([5, 1])
        ph_hd.markdown("**PPV Total by Product Hierarchy**")
        ph_show_tbl = ph_tg.toggle("Table", value=False, key="tg_ph_bar")
        ev_ph = None
        if ph_show_tbl:
            ph_fmt = ph.copy()
            ph_fmt["PPV_Total"] = ph_fmt["PPV_Total"].map("${:,.2f}".format)
            ph_fmt["Trend"]     = [TREND_LABEL[ph_trend.get(str(h), "stable")] for h in ph[PH_COL]]
            st.dataframe(ph_fmt, use_container_width=True, hide_index=True)
        else:
            ev_ph = st.plotly_chart(
                fig_ph_bar, use_container_width=True,
                on_select="rerun", key="ph_bar_sel",
            )

        ph_sel_active = []
        if ev_ph and ev_ph.selection and ev_ph.selection.points:
            ph_sel_active = [pt.get("x") for pt in ev_ph.selection.points if pt.get("x")]

        if ph_sel_active:
            st.caption(f"Selected: **{', '.join(ph_sel_active)}**")
        else:
            st.caption("Use Box Select ⬜ or Lasso Select in the toolbar to select hierarchies.")

        # Time trend for selected hierarchies
        if "YearMonth" not in dff.columns or not ph_sel_active:
            return

        st.markdown("---")
        ts_ph = (
            dff[dff[PH_COL].astype(str).isin(ph_sel_active) & (dff["YearMonth"] != "")]
            .groupby(["YearMonth", PH_COL])[PPV]
            .sum().reset_index()
            .rename(columns={PPV: "PPV_Total", "YearMonth": "Mes"})
            .sort_values("Mes")
        )
        if ts_ph.empty:
            return

        fig_ph_ts = px.line(
            ts_ph, x="Mes", y="PPV_Total", color=PH_COL, markers=True,
            title="Time Trend — Selected Product Hierarchies",
            labels={"PPV_Total": "Total Variance Amount (USD)"},
        )
        fig_ph_ts.add_hline(y=0, line_dash="dash", line_color="#9ca3af", line_width=1)

        ts_ph_agg = ts_ph.groupby("Mes")["PPV_Total"].sum().reset_index().sort_values("Mes")
        tr_y = ts_ph_agg["PPV_Total"].values
        tr_x = np.arange(len(tr_y))
        if len(tr_x) >= 2:
            tr_coeffs = np.polyfit(tr_x, tr_y, 1)
            tr_slope  = tr_coeffs[0]
            tr_line   = np.polyval(tr_coeffs, tr_x)
            fig_ph_ts.add_trace(go.Scatter(
                x=ts_ph_agg["Mes"], y=tr_line,
                mode="lines", name="Trend (combined)",
                line=dict(color="#f59e0b", dash="dot", width=2),
                hoverinfo="skip",
            ))
            tr_pct = abs(tr_slope) / (abs(tr_y.mean()) + 1e-9) * 100
            if   tr_slope > 0 and tr_pct > 5: tr_label = "⬆ Trending UP";   tr_bg = "#dc2626"
            elif tr_slope < 0 and tr_pct > 5: tr_label = "⬇ Trending DOWN"; tr_bg = "#16a34a"
            else:                              tr_label = "➡ Stable";         tr_bg = "#3b82f6"
            fig_ph_ts.add_annotation(
                xref="paper", yref="paper", x=0.5, y=0.5,
                text=f"<b>{tr_label}</b>",
                showarrow=False,
                font=dict(size=16, color="white"),
                bgcolor=tr_bg, bordercolor="white", borderwidth=2, borderpad=10, opacity=0.82,
            )
        fig_ph_ts.update_layout(
            plot_bgcolor="white", paper_bgcolor="white",
            margin=dict(t=40, b=10),
            legend=dict(orientation="h", yanchor="bottom", y=1.02, xanchor="right", x=1),
            height=400,
        )
        st.plotly_chart(fig_ph_ts, use_container_width=True)
