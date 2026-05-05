"""
ui/tabs/tab_trend.py
Tab 1 — Time Trend: Net PPV by day/month + cumulative area.
"""

import streamlit as st
import plotly.graph_objects as go
from plotly.subplots import make_subplots

from config import COLOR_NEUTRAL, COLOR_BAD, COLOR_GOOD
from chart_helpers import _bar


def render(tab, dff, PPV: str, **_):
    with tab:
        has_dates = "YearMonth" in dff.columns and PPV in dff.columns
        ts_data   = dff[dff["YearMonth"] != ""].copy() if has_dates else None

        if ts_data is None or ts_data.empty:
            st.info("No date data available or all dates are invalid.")
            return

        unique_months = ts_data["YearMonth"].nunique()

        if unique_months <= 1 and "PostingDay" in ts_data.columns:
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
        bar_colors = ["#ef4444" if v > 0 else "#22c55e" for v in ts["PPV_Total"]]

        fig = make_subplots(specs=[[{"secondary_y": True}]])

        fig.add_trace(
            go.Bar(
                x=ts[x_col], y=ts["PPV_Total"],
                name="Net PPV",
                marker_color=bar_colors,
                opacity=0.85,
            ),
            secondary_y=False,
        )
        fig.add_trace(
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

        fig.add_hline(y=0, line_dash="dash", line_color="#9ca3af", line_width=1)
        fig.update_layout(
            title=title_line + " + " + title_area,
            plot_bgcolor="white",
            paper_bgcolor="white",
            margin=dict(t=40, b=10, l=10, r=10),
            title_font_size=14,
            legend=dict(orientation="h", yanchor="bottom", y=1.02, xanchor="right", x=1),
            bargap=0.25,
        )
        fig.update_yaxes(
            title_text="Net PPV (USD)", secondary_y=False,
            showgrid=True, gridcolor="#f3f4f6",
        )
        fig.update_yaxes(
            title_text="Cumulative PPV (USD)", secondary_y=True, showgrid=False,
        )
        st.plotly_chart(fig, use_container_width=True)

        with st.expander(lbl_detail, expanded=False):
            ts_fmt = ts.copy()
            ts_fmt["PPV_Total"]     = ts_fmt["PPV_Total"].map("${:,.2f}".format)
            ts_fmt["PPV_Acumulado"] = ts_fmt["PPV_Acumulado"].map("${:,.2f}".format)
            st.dataframe(ts_fmt, use_container_width=True, hide_index=True)
