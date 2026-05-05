"""
ui/tabs/tab_materials.py
Tab 4 — Materials: Pareto + vendor drill-down + animated outlier model per supplier.
"""

import numpy as np
import pandas as pd
import streamlit as st
import plotly.express as px
import plotly.graph_objects as go
from plotly.subplots import make_subplots

from config import COLOR_BAD, COLOR_NEUTRAL
from chart_helpers import _bar, _best_outlier_model


def render(tab, dff, PPV: str, PRICE: str, **_):
    with tab:
        if "Material_Number" not in dff.columns or PPV not in dff.columns:
            return

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
                mat_desf["Material_Number"] = mat_desf["Material_Number"].astype(str)
                mat_desf["_label"]    = mat_desf["Material_Number"]
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
                    on_select="rerun", key="mat_par_sel",
                )

        # ── Detect selected material ───────────────────────────────────────
        selected_mat = None
        if ev_bar and ev_bar.selection and ev_bar.selection.points:
            selected_mat = ev_bar.selection.points[0].get("y")
        if selected_mat is None and ev_par and ev_par.selection and ev_par.selection.points:
            pt = ev_par.selection.points[0]
            cd = pt.get("customdata")
            selected_mat = cd[0] if isinstance(cd, (list, tuple)) else (cd if cd is not None else pt.get("x"))
        st.session_state["ppv_sel_mat"] = selected_mat

        if not selected_mat:
            st.caption("Click on a material in any of the charts to see the breakdown by vendor.")
            return

        # ── Vendor detail ─────────────────────────────────────────────────
        st.markdown("---")
        st.markdown(f"#### Detail by vendor — `{selected_mat}`")
        df_mat_sel = dff[dff["Material_Number"] == selected_mat]
        desc_sel   = df_mat_sel["Material_Description"].iloc[0] if not df_mat_sel.empty else ""
        if desc_sel:
            st.caption(desc_sel)

        if "Vendor_Name" not in df_mat_sel.columns:
            return

        vend_det = (
            df_mat_sel.groupby(["Vendor_Name", "Account_Number_of_Vendor_or_Creditor"])
            .agg(PPV_Total=(PPV, "sum"), Records=(PPV, "count"))
            .reset_index()
            .sort_values("PPV_Total", key=abs, ascending=False)
        )
        kv1, kv2 = st.columns(2)
        kv1_val = vend_det["PPV_Total"].sum()
        kv1_bg  = "#16a34a" if kv1_val <= 0 else "#dc2626"
        kv1.markdown(
            f"""<div style="background:{kv1_bg};border-radius:8px;padding:14px 16px;text-align:center;">
                <p style="margin:0;font-size:0.78rem;font-weight:700;color:white;opacity:0.88;">Total PPV for material</p>
                <p style="margin:4px 0 0;font-size:1.35rem;font-weight:800;color:white;">${kv1_val:,.2f}</p>
            </div>""", unsafe_allow_html=True,
        )
        kv2.metric("Vendors involved", len(vend_det))

        fig_vdet = _bar(
            vend_det, "PPV_Total", "Vendor_Name",
            f"PPV by Vendor — {selected_mat}", orientation="h",
        )
        st.plotly_chart(fig_vdet, use_container_width=True)

        # ── Price difference trend per vendor (animated outlier models) ───
        if PRICE not in df_mat_sel.columns or "Posting_Date" not in df_mat_sel.columns:
            return

        ts_vend = df_mat_sel[df_mat_sel["Posting_Date"].notna()].copy()
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

        if ts_price.empty:
            return

        n_vendors = ts_price["Vendor_Name"].nunique()

        # Outlier detection
        all_vals = ts_price["P_Price_Difference"].values
        outlier_mask, best_model_name, model_scores = _best_outlier_model(all_vals)
        ts_price["_is_outlier"] = outlier_mask

        # Candidate models for animation
        from scipy import stats as _stats_anim
        anim_arr = all_vals
        aQ1, aQ3 = np.percentile(anim_arr, [25, 75])
        aIQR = aQ3 - aQ1
        iqr_am  = (anim_arr < aQ1 - 1.5*aIQR) | (anim_arr > aQ3 + 1.5*aIQR)
        amu, asig = anim_arr.mean(), anim_arr.std()
        z_am    = np.abs((anim_arr - amu) / (asig + 1e-9)) > 2.5
        amed    = np.median(anim_arr)
        amad    = np.median(np.abs(anim_arr - amed))
        mz_am   = np.abs(0.6745 * (anim_arr - amed) / (amad + 1e-9)) > 3.5
        anim_cands = {
            "IQR":         {"mask": iqr_am, "lower": float(aQ1 - 1.5*aIQR), "upper": float(aQ3 + 1.5*aIQR), "color": "#6366f1"},
            "Z-Score":     {"mask": z_am,   "lower": float(amu - 2.5*asig),  "upper": float(amu + 2.5*asig),  "color": "#f59e0b"},
            "Z-Score MAD": {"mask": mz_am,  "lower": float(amed - 3.5*amad/0.6745), "upper": float(amed + 3.5*amad/0.6745), "color": "#8b5cf6"},
        }
        try:
            from sklearn.ensemble import IsolationForest as _IFanim
            if_am = _IFanim(contamination="auto", random_state=42, n_estimators=100).fit_predict(
                anim_arr.reshape(-1, 1)) == -1
            anim_cands["Isolation Forest"] = {"mask": if_am, "lower": None, "upper": None, "color": "#ec4899"}
        except Exception:
            pass

        def _ks_anim(mask, vals):
            inliers = vals[~mask]
            if len(inliers) < 4: return float("inf")
            n = (inliers - inliers.mean()) / (inliers.std() + 1e-9)
            return round(float(_stats_anim.kstest(n, "norm")[0]), 4)

        anim_ks = {k: _ks_anim(v["mask"], anim_arr) for k, v in anim_cands.items()}
        anim_sorted = ts_price.sort_values(period_label).reset_index(drop=True)
        anim_x = anim_sorted[period_label].tolist()
        anim_y = anim_sorted["P_Price_Difference"].tolist()

        # Main figure
        fig_ts_price = px.line(
            ts_price, x=period_label, y="P_Price_Difference",
            color="Vendor_Name", markers=True,
            title=f"P_Price_Difference by Vendor — {selected_mat}",
            labels={"P_Price_Difference": "Price Diff. (USD)", "Vendor_Name": "Vendor"},
        )
        fig_ts_price.add_hline(y=0, line_dash="dash", line_color="#9ca3af", line_width=1)

        base_annotations = []
        if n_vendors > 1:
            vss = (
                ts_price.groupby("Vendor_Name")
                .agg(P_Total=("P_Price_Difference", "sum"), Rec=("Records", "sum"))
                .reset_index()
            )
            vss["Score"] = vss["P_Total"] / vss["Rec"].replace(0, 1)
            best_vend = vss.loc[vss["Score"].idxmin(), "Vendor_Name"]
            df_best = ts_price[ts_price["Vendor_Name"] == best_vend].sort_values(period_label)
            if not df_best.empty:
                lr = df_best.iloc[-1]
                base_annotations.append(dict(
                    x=lr[period_label], y=lr["P_Price_Difference"],
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
                trend_y = np.polyval(np.polyfit(x_num, y_vals, 1), x_num)
                fig_ts_price.add_trace(go.Scatter(
                    x=ts_single[period_label], y=trend_y,
                    mode="lines", name="Trend",
                    line=dict(color="#f59e0b", dash="dot", width=2),
                    hoverinfo="skip",
                ))

        # Overlay placeholder traces
        n_base = len(fig_ts_price.data)
        for _ in range(3):
            fig_ts_price.add_trace(go.Scatter(x=[], y=[], showlegend=False))
        ov_idx = [n_base, n_base + 1, n_base + 2]

        # Build animation frames
        anim_frames = []
        for mname, mdata in anim_cands.items():
            mask    = mdata["mask"]
            col_m   = mdata["color"]
            is_best = mname == best_model_name
            ks_val  = anim_ks.get(mname, 0)
            ox = [anim_x[i] for i, m in enumerate(mask) if m]
            oy = [anim_y[i] for i, m in enumerate(mask) if m]
            if mdata["lower"] is not None:
                ux = [anim_x[0], anim_x[-1]]; uy = [mdata["upper"], mdata["upper"]]
                lx = [anim_x[0], anim_x[-1]]; ly = [mdata["lower"], mdata["lower"]]
            else:
                ux = uy = lx = ly = []
            badge = (
                f"<b>{'✅ ' if is_best else ''}{mname}</b>"
                f"  KS={ks_val:.4f}{'  ← SELECTED' if is_best else ''}"
            )
            frame_anns = base_annotations + [dict(
                text=badge, xref="paper", yref="paper", x=0.01, y=0.97,
                bgcolor="#16a34a" if is_best else "#e5e7eb",
                font=dict(color="white" if is_best else "#374151", size=12),
                borderpad=7, showarrow=False, align="left",
            )]
            anim_frames.append(go.Frame(
                data=[
                    go.Scatter(x=ux, y=uy, mode="lines", showlegend=False,
                               line=dict(color=col_m, dash="dash", width=2)),
                    go.Scatter(x=lx, y=ly, mode="lines", showlegend=False,
                               line=dict(color=col_m, dash="dash", width=2),
                               fill="tonexty", fillcolor="rgba(99,102,241,0.06)"),
                    go.Scatter(x=ox, y=oy, mode="markers", showlegend=False,
                               marker=dict(symbol="circle-open", size=20, color="#dc2626",
                                           line=dict(width=2.5, color="#dc2626"))),
                ],
                traces=ov_idx, name=mname,
                layout=go.Layout(annotations=frame_anns),
            ))

        best_idx = list(anim_cands.keys()).index(best_model_name) if best_model_name in anim_cands else 0
        init_frame = anim_frames[best_idx]
        for ti, nd in zip(ov_idx, init_frame.data):
            fig_ts_price.data[ti].update(nd)

        init_ann = base_annotations + [dict(
            text=f"<b>✅ {best_model_name}</b>  KS={anim_ks.get(best_model_name,0):.4f}  ← SELECTED",
            xref="paper", yref="paper", x=0.01, y=0.97,
            bgcolor="#16a34a", font=dict(color="white", size=12),
            borderpad=7, showarrow=False, align="left",
        )]
        fig_ts_price.frames = anim_frames
        fig_ts_price.update_layout(
            plot_bgcolor="white", paper_bgcolor="white",
            margin=dict(t=80, b=70, l=10, r=10),
            legend=dict(orientation="h", yanchor="top", y=-0.28, xanchor="left", x=0),
            height=500,
            annotations=init_ann,
            updatemenus=[dict(
                type="buttons", showactive=False, y=1.12, x=0.5, xanchor="center",
                buttons=[
                    dict(label="▶ Play models", method="animate",
                         args=[list(anim_cands.keys()) + [best_model_name],
                               dict(frame=dict(duration=1500, redraw=True),
                                    fromcurrent=False, mode="immediate")]),
                    dict(label="⏸ Pause", method="animate",
                         args=[[None], dict(frame=dict(duration=0, redraw=False), mode="immediate")]),
                ],
            )],
            sliders=[dict(
                steps=[dict(
                    method="animate",
                    args=[[f.name], dict(mode="immediate", frame=dict(duration=0, redraw=True))],
                    label=f.name,
                ) for f in anim_frames],
                currentvalue=dict(prefix="Model: ", font=dict(size=13)),
                pad=dict(t=50), len=0.85, x=0.075, active=best_idx,
            )],
        )
        st.plotly_chart(fig_ts_price, use_container_width=True)

        # Verdict for single vendor
        if n_vendors == 1 and len(ts_price) >= 2:
            ts2 = ts_price.sort_values(period_label).copy()
            y2  = ts2["P_Price_Difference"].values
            slope2 = np.polyfit(np.arange(len(y2)), y2, 1)[0]
            vn = ts_price["Vendor_Name"].iloc[0]
            if slope2 > 0:
                st.warning(
                    f"⚠️ **Upward trend detected** for `{vn}` "
                    f"(+${slope2:,.2f} per period). "
                    "It is recommended to **negotiate the price** or look for an alternative vendor."
                )
            else:
                st.success(
                    f"✅ **OK** — `{vn}` shows a stable or downward trend "
                    f"(${slope2:,.2f} per period)."
                )

        # Detailed breakdown by vendor
        st.markdown("##### Breakdown by vendor and period")
        vend_order_df = (
            ts_price.groupby("Vendor_Name")
            .agg(_P=("P_Price_Difference", "sum"), _R=("Records", "sum"))
            .reset_index()
        )
        vend_order_df["_score"] = vend_order_df["_P"] / vend_order_df["_R"].replace(0, 1)
        sorted_vendors = vend_order_df.sort_values("_score")["Vendor_Name"].tolist()
        rank_styles = [
            ("🥇", "#15803d", "#dcfce7", "#16a34a"),
            ("🥈", "#92400e", "#fef3c7", "#d97706"),
            ("🥉", "#991b1b", "#fee2e2", "#dc2626"),
        ]
        QTY_COL = "Quantity_num"
        PO_COL  = "MExtended_PO_Price"
        STD_COL = "M_Extended__Std_Amount"

        for rank_i, vname in enumerate(sorted_vendors):
            df_raw = ts_vend[ts_vend["Vendor_Name"] == vname].copy()
            df_raw = df_raw.sort_values("Posting_Date").reset_index(drop=True)
            r_icon, r_txt, r_bg, r_border = (
                rank_styles[rank_i] if rank_i < len(rank_styles)
                else (f"#{rank_i+1}", "#374151", "#f3f4f6", "#9ca3af")
            )
            with st.container():
                st.markdown(
                    f"""<div style="margin-top:1.2rem;padding:8px 14px;background:{r_bg};
border-left:4px solid {r_border};border-radius:6px;display:flex;align-items:center;gap:10px;">
  <span style="font-size:1.4rem;">{r_icon}</span>
  <span style="font-size:1rem;font-weight:700;color:{r_txt};">#{rank_i+1} — {vname}</span>
  <span style="font-size:0.82rem;color:{r_txt};opacity:0.75;margin-left:auto;">{len(df_raw)} records</span>
</div>""",
                    unsafe_allow_html=True,
                )
                ym_col = "YearMonth" if "YearMonth" in df_raw.columns else None
                for nc in [QTY_COL, PO_COL, STD_COL]:
                    if nc in df_raw.columns:
                        df_raw[nc] = pd.to_numeric(df_raw[nc], errors="coerce")

                if ym_col:
                    agg_spec = {}
                    if QTY_COL in df_raw.columns: agg_spec[QTY_COL] = "sum"
                    if PO_COL  in df_raw.columns: agg_spec[PO_COL]  = "sum"
                    if STD_COL in df_raw.columns: agg_spec[STD_COL] = "sum"
                    if not agg_spec:
                        continue
                    grp = (
                        df_raw.groupby(ym_col).agg(agg_spec)
                        .reset_index().sort_values(ym_col)
                    )
                    max_qty   = float(grp[QTY_COL].max()) if QTY_COL in grp.columns else 1.0
                    max_price = max(
                        float(grp[PO_COL].max())  if PO_COL  in grp.columns else 0.0,
                        float(grp[STD_COL].max()) if STD_COL in grp.columns else 0.0,
                    )
                    pad   = 1.20
                    r_qty   = [0, (max_qty   or 1) * pad]
                    r_price = [0, (max_price or 1) * pad]

                    has_both = PO_COL in grp.columns and STD_COL in grp.columns
                    out_rows = pd.DataFrame()
                    if has_both:
                        diff_v    = grp[PO_COL] - grp[STD_COL]
                        pct_diff  = (diff_v / grp[STD_COL].replace(0, np.nan)).abs()
                        out_mask  = pct_diff > 0.05
                        out_rows  = grp[out_mask].copy()
                        out_rows["_pct_diff"] = pct_diff[out_mask]

                    fig_vd = make_subplots(specs=[[{"secondary_y": True}]])
                    if QTY_COL in grp.columns:
                        fig_vd.add_trace(
                            go.Bar(x=grp[ym_col], y=grp[QTY_COL], name="Cantidad",
                                   marker_color="#60a5fa", opacity=0.75),
                            secondary_y=False,
                        )
                    if PO_COL in grp.columns:
                        fig_vd.add_trace(
                            go.Scatter(x=grp[ym_col], y=grp[PO_COL],
                                       name="PO Ext. (USD)", mode="lines+markers",
                                       line=dict(color="#f97316", width=2), marker=dict(size=6)),
                            secondary_y=True,
                        )
                    if STD_COL in grp.columns:
                        fig_vd.add_trace(
                            go.Scatter(x=grp[ym_col], y=grp[STD_COL],
                                       name="Std Ext. (USD)", mode="lines+markers",
                                       line=dict(color="#8b5cf6", width=2, dash="dot"), marker=dict(size=6)),
                            secondary_y=True,
                        )
                    # Outlier segments
                    if has_both and not out_rows.empty:
                        shown_leg_red = False; shown_leg_green = False
                        for _, ov in out_rows.iterrows():
                            ox_v   = ov[ym_col]
                            oy_po  = float(ov[PO_COL]);  oy_std = float(ov[STD_COL])
                            oy_mid = (oy_po + oy_std) / 2
                            odiff  = oy_po - oy_std
                            is_gain   = odiff < 0
                            seg_color = "#22c55e" if is_gain else "#ef4444"
                            leg_name  = "Outlier ganancia" if is_gain else "Outlier pérdida"
                            shown_ref = shown_leg_green if is_gain else shown_leg_red
                            fig_vd.add_trace(
                                go.Scatter(
                                    x=[ox_v, ox_v], y=[oy_std, oy_po], mode="lines",
                                    line=dict(color=seg_color, width=3),
                                    name=leg_name if not shown_ref else None,
                                    showlegend=not shown_ref,
                                    legendgroup=f"outlier_{'gain' if is_gain else 'loss'}",
                                ),
                                secondary_y=True,
                            )
                            if is_gain: shown_leg_green = True
                            else:       shown_leg_red   = True
                            opct = float(ov["_pct_diff"]) * 100
                            fig_vd.add_annotation(
                                x=ox_v, y=oy_mid, xref="x", yref="y2",
                                text=f"<b>Δ {odiff:+,.0f}<br>({opct:.1f}%)</b>",
                                showarrow=False,
                                font=dict(color=seg_color, size=11),
                                bgcolor="rgba(255,255,255,0.75)",
                                bordercolor=seg_color, borderwidth=1,
                                xanchor="left", yanchor="middle",
                            )
                    fig_vd.update_layout(
                        plot_bgcolor="white", paper_bgcolor="white",
                        margin=dict(t=30, b=10, l=10, r=10),
                        legend=dict(orientation="h", yanchor="bottom", y=1.02, xanchor="right", x=1),
                        bargap=0.3, height=350,
                    )
                    fig_vd.update_yaxes(
                        title_text="Quantity (sum)", range=r_qty,
                        secondary_y=False, showgrid=True, gridcolor="#f3f4f6",
                    )
                    fig_vd.update_yaxes(
                        title_text="Ext. Price (USD, sum)", range=r_price,
                        secondary_y=True, showgrid=False,
                    )
                    st.plotly_chart(fig_vd, use_container_width=True)
                else:
                    st.caption("No YearMonth column available for plotting.")
