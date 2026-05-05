"""
ui/tabs/tab_vendors.py
Tab 3 — Vendors: bar + KNN scatter + drill-down by component.
"""

import numpy as np
import streamlit as st
import plotly.graph_objects as go

from chart_helpers import _bar


def render(tab, dff, PPV: str, **_):
    with tab:
        if "Vendor_Name" not in dff.columns or PPV not in dff.columns:
            return

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
            ev_vend = st.plotly_chart(
                _bar(vend, "PPV_Total", "Vendor_Name",
                     f"Top {n_top} Vendors by Total PPV", orientation="h"),
                use_container_width=True,
                on_select="rerun",
                key="vendor_bar_chart",
                selection_mode="points",
            )
            st.caption("Click a vendor bar to see its component breakdown below.")

        with col_r:
            # ── KNN decision-region scatter ────────────────────────────────
            fig_sc = go.Figure()
            try:
                from sklearn.neighbors import KNeighborsClassifier as _KNC
                from sklearn.preprocessing import StandardScaler as _SS

                X_knn  = vend_all[["Records", "PPV_Total"]].values.astype(float)
                q25_k  = float(vend_all["PPV_Total"].quantile(0.25))
                q75_k  = float(vend_all["PPV_Total"].quantile(0.75))

                def _klabel(v):
                    if v < min(q25_k, 0): return 0
                    if v > max(q75_k, 0): return 2
                    return 1

                lab_knn  = np.array([_klabel(v) for v in vend_all["PPV_Total"]])
                has_knn  = len(np.unique(lab_knn)) >= 2

                if has_knn:
                    ss  = _SS()
                    Xsc = ss.fit_transform(X_knn)
                    clf = _KNC(n_neighbors=min(5, max(1, len(vend_all) - 1)))
                    clf.fit(Xsc, lab_knn)

                    xp = (float(vend_all["Records"].max()) - float(vend_all["Records"].min())) * 0.20 + 1
                    yp = (float(vend_all["PPV_Total"].max()) - float(vend_all["PPV_Total"].min())) * 0.22 + 1
                    xx_k, yy_k = np.meshgrid(
                        np.linspace(float(vend_all["Records"].min()) - xp,
                                    float(vend_all["Records"].max()) + xp, 160),
                        np.linspace(float(vend_all["PPV_Total"].min()) - yp,
                                    float(vend_all["PPV_Total"].max()) + yp, 160),
                    )
                    Z_k = clf.predict(
                        ss.transform(np.c_[xx_k.ravel(), yy_k.ravel()])
                    ).reshape(xx_k.shape).astype(float)

                    kcs = [
                        [0.00, "rgba(34,197,94,0.28)"],  [0.32, "rgba(34,197,94,0.28)"],
                        [0.34, "rgba(156,163,175,0.20)"], [0.65, "rgba(156,163,175,0.20)"],
                        [0.67, "rgba(239,68,68,0.28)"],  [1.00, "rgba(239,68,68,0.28)"],
                    ]
                    fig_sc.add_trace(go.Heatmap(
                        x=xx_k[0], y=yy_k[:, 0], z=Z_k,
                        colorscale=kcs, zmin=0, zmax=2,
                        showscale=False, hoverinfo="skip",
                    ))
            except Exception:
                pass

            dot_colors = [
                "#22c55e" if v < 0 else ("#ef4444" if v > 0 else "#9ca3af")
                for v in vend_all["PPV_Total"]
            ]
            fig_sc.add_trace(go.Scatter(
                x=vend_all["Records"], y=vend_all["PPV_Total"],
                mode="markers+text",
                text=vend_all["Vendor_Name"],
                textposition="top center",
                textfont=dict(size=9),
                marker=dict(color=dot_colors, size=10, line=dict(color="white", width=1)),
                customdata=vend_all[["PPV_Total", "Records"]].values,
                hovertemplate=(
                    "<b>%{text}</b><br>"
                    "PPV: $%{customdata[0]:,.0f}<br>"
                    "Records: %{customdata[1]}<extra></extra>"
                ),
                showlegend=False,
            ))
            fig_sc.add_hline(y=0, line_dash="dash", line_color="#9ca3af", line_width=1)
            for zl, zc in [("Favorable", "#22c55e"), ("Normal", "#9ca3af"), ("Unfavorable", "#ef4444")]:
                fig_sc.add_trace(go.Scatter(
                    x=[None], y=[None], mode="markers",
                    marker=dict(color=zc, size=11, symbol="square"),
                    name=zl, showlegend=True,
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

        # ── Vendor drill-down ─────────────────────────────────────────────
        vend_sel_pts = (
            (ev_vend.get("selection") or {}).get("points", [])
            if isinstance(ev_vend, dict) else []
        )
        sel_vendor = vend_sel_pts[0].get("y") if vend_sel_pts else None

        if not sel_vendor:
            return

        st.markdown(f"#### Detail — {sel_vendor}")
        df_vd = dff[dff["Vendor_Name"] == sel_vendor]
        if "Material_Number" not in df_vd.columns or df_vd.empty:
            st.info("No material data available for this vendor.")
            return

        vd_mat = (
            df_vd.groupby(["Material_Number", "Material_Description"])
            .agg(PPV_Total=(PPV, "sum"), Records=(PPV, "count"), PPV_Average=(PPV, "mean"))
            .reset_index()
            .sort_values("PPV_Total", ascending=False)
        )
        vd_k1, vd_k2, vd_k3, vd_k4, vd_k5 = st.columns(5)
        vd_k1.metric("Materials", f"{len(vd_mat):,}")
        vd_k2_val = df_vd[PPV].sum()
        vd_k2_bg  = "#16a34a" if vd_k2_val <= 0 else "#dc2626"
        vd_k2.markdown(
            f"""<div style="background:{vd_k2_bg};border-radius:8px;padding:14px 16px;text-align:center;">
                <p style="margin:0;font-size:0.78rem;font-weight:700;color:white;opacity:0.88;">Total PPV (USD)</p>
                <p style="margin:4px 0 0;font-size:1.35rem;font-weight:800;color:white;">${vd_k2_val:,.2f}</p>
            </div>""", unsafe_allow_html=True,
        )
        vd_k3.metric("Unfavorable (USD)", f"${df_vd.loc[df_vd[PPV]>0, PPV].sum():,.2f}")
        vd_k4.metric("Favorable (USD)",   f"${df_vd.loc[df_vd[PPV]<=0, PPV].sum():,.2f}")
        vd_k5.metric("Records",           f"{len(df_vd):,}")

        fig_vd = _bar(
            vd_mat, "PPV_Total", "Material_Number",
            f"Components — {sel_vendor}  (most to least expensive → favorable)",
            orientation="h",
        )
        fig_vd.update_traces(
            customdata=vd_mat[["Material_Description", "Records", "PPV_Average"]].values,
            hovertemplate=(
                "<b>%{y}</b><br>%{customdata[0]}<br>"
                "PPV Total: $%{x:,.2f}<br>"
                "Records: %{customdata[1]}<br>"
                "PPV Avg: $%{customdata[2]:,.2f}<extra></extra>"
            ),
        )
        hd_vd, tg_vd = st.columns([5, 1])
        hd_vd.markdown(f"**Components — {sel_vendor}**")
        show_tbl_vd = tg_vd.toggle("Table", value=False, key="tg_vd_comp")
        if show_tbl_vd:
            vd_fmt = vd_mat.copy()
            for c in ["PPV_Total", "PPV_Average"]:
                vd_fmt[c] = vd_fmt[c].map("${:,.2f}".format)
            st.dataframe(vd_fmt, use_container_width=True, hide_index=True)
        else:
            st.plotly_chart(fig_vd, use_container_width=True)
