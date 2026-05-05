"""
ui/tabs/tab_impact.py
Tab 7 — Impact: PPV scatter + vendor network + correlation matrix + predictive model (11 models).
"""

import warnings as _warn
import io as _io
import contextlib as _ctx

import numpy as np
import pandas as pd
import streamlit as st
import plotly.graph_objects as go

from config import COLOR_GOOD, COLOR_BAD, COLOR_NEUTRAL


def render(tab, dff, PPV: str, PRICE: str = "", FX: str = "", params: dict | None = None, **_):
    with tab:
        # ══════════════════════════════════════════════════════════════════
        # ── PPV IMPACT SCATTER ────────────────────────────────────────────
        if "Material_Number" in dff.columns and PPV in dff.columns:
            st.markdown("#### PPV Impact by Component")

            if "Material_Description" in dff.columns:
                _corr_df = (
                    dff.groupby(["Material_Number", "Material_Description"])
                    .agg(PPV_Total=(PPV, "sum"), Records=(PPV, "count"), PPV_Average=(PPV, "mean"))
                    .reset_index()
                )
            else:
                _corr_df = (
                    dff.groupby("Material_Number")
                    .agg(PPV_Total=(PPV, "sum"), Records=(PPV, "count"), PPV_Average=(PPV, "mean"))
                    .reset_index()
                    .assign(Material_Description=lambda d: d["Material_Number"])
                )

            _corr_df = _corr_df.assign(Abs_PPV=lambda d: d["PPV_Total"].abs()).sort_values("Abs_PPV", ascending=False)
            _p05 = float(_corr_df["PPV_Total"].quantile(0.05))
            _p95 = float(_corr_df["PPV_Total"].quantile(0.95))

            def _outlier_zone(v):
                if v > _p95: return "Outlier +"
                if v < _p05: return "Outlier −"
                return "Within range"

            _corr_df["Zone"] = _corr_df["PPV_Total"].apply(_outlier_zone)

            _fig_corr = go.Figure()
            for _zone, (_zclr, _zopa) in {
                "Outlier +":    (COLOR_BAD,  1.00),
                "Outlier −":    (COLOR_GOOD, 1.00),
                "Within range": ("#6b7280",  0.70),
            }.items():
                _sub = _corr_df[_corr_df["Zone"] == _zone]
                if _sub.empty: continue
                _sizes = (_sub["Abs_PPV"] / (_corr_df["Abs_PPV"].max() or 1) * 42 + 8).clip(8, 50)
                _is_out = _zone != "Within range"
                _fig_corr.add_trace(go.Scattergl(
                    x=_sub["PPV_Total"], y=_sub["Records"],
                    mode="markers", name=_zone,
                    marker=dict(color="white", size=_sizes, opacity=_zopa,
                                line=dict(color=_zclr, width=4 if _is_out else 1.5)),
                    customdata=_sub[["Material_Number", "Material_Description", "PPV_Average", "Abs_PPV", "Zone"]].values,
                    hovertemplate=(
                        "<b>%{customdata[0]}</b>  %{customdata[4]}<br>"
                        "%{customdata[1]}<br>"
                        "PPV Total: $%{x:,.2f}<br>Records: %{y}<br>"
                        "PPV Avg: $%{customdata[2]:,.2f}<extra></extra>"
                    ),
                ))

            _fig_corr.add_vline(x=_p05, line_dash="dot", line_color=COLOR_GOOD, line_width=1.5,
                                annotation_text="5th pct", annotation_position="top left",
                                annotation_font=dict(size=9, color=COLOR_GOOD))
            _fig_corr.add_vline(x=_p95, line_dash="dot", line_color=COLOR_BAD, line_width=1.5,
                                annotation_text="95th pct", annotation_position="top right",
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
                _fig_corr, use_container_width=True,
                on_select="rerun", key="ppv_impact_chart", selection_mode="points",
            )

            _corr_sel_pts = (
                (_ev_corr.get("selection") or {}).get("points", [])
                if isinstance(_ev_corr, dict) else []
            )
            _sel_comp = (
                _corr_sel_pts[0].get("customdata", [None])[0] if _corr_sel_pts else None
            )

            if _sel_comp and "Vendor_Name" in dff.columns:
                _df_comp = dff[dff["Material_Number"].astype(str) == str(_sel_comp)]
                if not _df_comp.empty:
                    _mat_desc = _df_comp["Material_Description"].iloc[0] if "Material_Description" in _df_comp.columns else _sel_comp
                    st.markdown(f"#### Vendor Network — `{_sel_comp}` · {_mat_desc}")
                    _vend_net = (
                        _df_comp.groupby("Vendor_Name")
                        .agg(PPV_Total=(PPV, "sum"), Records=(PPV, "count"), PPV_Average=(PPV, "mean"))
                        .reset_index().sort_values("PPV_Average")
                    )
                    _global_avg_net = _df_comp[PPV].mean()
                    _best_vendor    = _vend_net.iloc[0]["Vendor_Name"]
                    _n_v    = len(_vend_net)
                    _angles = [2 * np.pi * i / _n_v for i in range(_n_v)]
                    _vx = [np.cos(a) for a in _angles]
                    _vy = [np.sin(a) for a in _angles]
                    _max_rec_net = float(_vend_net["Records"].max()) or 1.0

                    _fig_net = go.Figure()
                    for _vi, (_, _vrow) in enumerate(_vend_net.iterrows()):
                        _ew = max(1.0, _vrow["Records"] / _max_rec_net * 7)
                        _ec = "#22c55e" if _vrow["Vendor_Name"] == _best_vendor else "#e5e7eb"
                        _fig_net.add_trace(go.Scatter(
                            x=[0, _vx[_vi], None], y=[0, _vy[_vi], None],
                            mode="lines", line=dict(color=_ec, width=_ew),
                            hoverinfo="skip", showlegend=False,
                        ))

                    def _nc(vname, pavg):
                        if vname == _best_vendor: return "#22c55e"
                        if pavg > _global_avg_net: return "#ef4444"
                        return "#f59e0b"

                    _dot_clrs  = [_nc(r["Vendor_Name"], r["PPV_Average"]) for _, r in _vend_net.iterrows()]
                    _dot_sizes = (_vend_net["Records"] / _max_rec_net * 28 + 16).clip(16, 44).tolist()
                    _fig_net.add_trace(go.Scatter(
                        x=_vx, y=_vy, mode="markers+text",
                        text=_vend_net["Vendor_Name"], textposition="top center",
                        textfont=dict(size=9),
                        marker=dict(color=_dot_clrs, size=_dot_sizes,
                                    line=dict(color="white", width=2)),
                        customdata=_vend_net[["PPV_Average", "Records", "PPV_Total"]].values,
                        hovertemplate=(
                            "<b>%{text}</b><br>PPV Avg: $%{customdata[0]:,.2f}<br>"
                            "Records: %{customdata[1]}<br>PPV Total: $%{customdata[2]:,.2f}<extra></extra>"
                        ),
                        showlegend=False,
                    ))
                    _fig_net.add_trace(go.Scatter(
                        x=[0], y=[0], mode="markers+text",
                        text=[_sel_comp], textposition="bottom center",
                        textfont=dict(size=11, color="#1e40af"),
                        marker=dict(color="#3b82f6", size=32, line=dict(color="white", width=3)),
                        hovertemplate=f"<b>{_sel_comp}</b><br>{_mat_desc}<br>Global avg: ${_global_avg_net:,.2f}<extra></extra>",
                        showlegend=False,
                    ))
                    _fig_net.add_annotation(
                        x=0, y=-1.42, xref="x", yref="y",
                        text=f"Global avg PPV: <b>${_global_avg_net:,.2f}</b>",
                        showarrow=False, font=dict(size=11, color="#6b7280"),
                    )
                    for _lbl, _lclr in [
                        (f"✅ Best price — {_best_vendor}", "#22c55e"),
                        ("Above global avg (unfavorable)", "#ef4444"),
                        ("Below global avg (favorable)",   "#f59e0b"),
                    ]:
                        _fig_net.add_trace(go.Scatter(
                            x=[None], y=[None], mode="markers",
                            marker=dict(color=_lclr, size=11), name=_lbl, showlegend=True,
                        ))
                    _fig_net.update_layout(
                        plot_bgcolor="white", paper_bgcolor="white",
                        margin=dict(t=50, b=60, l=10, r=10),
                        xaxis=dict(visible=False, range=[-1.65, 1.65]),
                        yaxis=dict(visible=False, range=[-1.65, 1.65]),
                        height=540,
                        legend=dict(orientation="h", yanchor="bottom", y=1.02, xanchor="right", x=1),
                    )
                    st.plotly_chart(_fig_net, use_container_width=True)
                    _net_fmt = _vend_net.copy()
                    _net_fmt.insert(0, "Best Price?", _net_fmt["Vendor_Name"].apply(
                        lambda v: "✅ Best" if v == _best_vendor else ""))
                    _net_fmt["Global Avg"] = f"${_global_avg_net:,.2f}"
                    for _c in ["PPV_Average", "PPV_Total"]:
                        _net_fmt[_c] = _net_fmt[_c].map("${:,.2f}".format)
                    st.dataframe(_net_fmt, use_container_width=True, hide_index=True)

            st.divider()

        # ══════════════════════════════════════════════════════════════════
        # ── CORRELATION MATRIX ────────────────────────────────────────────
        st.markdown("### Variable Impact Analysis — Correlation Matrix")

        def _clean_lbl(col): return col.replace("_num", "").replace("_", " ").title()

        _ia_num_cols = [c for c in dff.columns if c.endswith("_num") and dff[c].notna().sum() > 5]
        if len(_ia_num_cols) >= 2:
            _corr_matrix = dff[_ia_num_cols].corr()
            _corr_labels = [_clean_lbl(c) for c in _ia_num_cols]
            _corr_vals   = _corr_matrix.values.tolist()
            _ppv_idx     = _ia_num_cols.index(PPV) if PPV in _ia_num_cols else None
            _fig_cm = go.Figure(go.Heatmap(
                z=_corr_vals, x=_corr_labels, y=_corr_labels,
                colorscale="RdBu", zmid=0, zmin=-1, zmax=1,
                text=[[f"{v:.2f}" for v in row] for row in _corr_vals],
                texttemplate="%{text}", textfont=dict(size=10),
                hovertemplate="<b>%{y}</b> × <b>%{x}</b><br>r = %{z:.3f}<extra></extra>",
                colorbar=dict(title="Pearson r", tickvals=[-1, -0.5, 0, 0.5, 1]),
            ))
            if _ppv_idx is not None:
                _nc = len(_ia_num_cols)
                for _xr, _yr in [
                    ((-0.5, _nc - 0.5), (_ppv_idx - 0.5, _ppv_idx + 0.5)),
                    ((_ppv_idx - 0.5, _ppv_idx + 0.5), (-0.5, _nc - 0.5)),
                ]:
                    _fig_cm.add_shape(
                        type="rect", xref="x", yref="y",
                        x0=_xr[0], x1=_xr[1], y0=_yr[0], y1=_yr[1],
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

        # ══════════════════════════════════════════════════════════════════
        # ── PREDICTIVE MODEL ──────────────────────────────────────────────
        st.markdown("### Predictive Model — 3-Month Forecast")

        if "YearMonth" not in dff.columns or PPV not in dff.columns:
            st.info("YearMonth column not available for time-series forecasting.")
            return

        _ts_pred = (
            dff.groupby("YearMonth")[PPV]
            .sum().reset_index().sort_values("YearMonth")
            .rename(columns={"YearMonth": "Month", PPV: "Net_PPV"})
        )
        if len(_ts_pred) < 4:
            st.info("At least 4 months of data are required for the predictive model.")
            return

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
            _future_lbls = [(_base_period + i).strftime("%Y-%m") for i in range(1, _n_fcast + 1)]
        except Exception:
            _future_lbls = [f"Month+{i}" for i in range(1, _n_fcast + 1)]

        _scale_method = st.radio(
            "Data scaling before model fitting",
            ["StandardScaler", "Min-Max Scaling", "None"],
            index=0, horizontal=True, key="ppv_scale_method",
            help=(
                "**StandardScaler**: centers to mean=0, std=1.\n\n"
                "**Min-Max Scaling**: maps to [0,1].\n\n"
                "**None**: raw USD values."
            ),
        )

        from sklearn.preprocessing import StandardScaler as _StdScl, MinMaxScaler as _MmScl
        if _scale_method == "StandardScaler":    _scaler = _StdScl()
        elif _scale_method == "Min-Max Scaling": _scaler = _MmScl()
        else:                                    _scaler = None

        if _scaler is not None:
            _tv_sc = _scaler.fit_transform(_train_vals.reshape(-1, 1)).ravel()
            _vv_sc = _scaler.transform(_vals.reshape(-1, 1)).ravel()
            def _inv(arr): return _scaler.inverse_transform(np.array(arr, dtype=float).reshape(-1, 1)).ravel()
        else:
            _tv_sc = _train_vals.copy()
            _vv_sc = _vals.copy()
            def _inv(arr): return np.array(arr, dtype=float)

        def _mase_fn(actual, predicted):
            a = np.array(actual, dtype=float); p = np.array(predicted, dtype=float)
            mae = np.mean(np.abs(a - p))
            naive = np.mean(np.abs(np.diff(_train_vals)))
            if naive < 1e-10: naive = max(np.mean(np.abs(_train_vals)), 1e-10)
            return float(mae / naive)

        def _make_lag_X(series, n_lags):
            rows = []
            for i in range(n_lags, len(series)):
                row = [series[i - l - 1] for l in range(n_lags)]
                row += [float(i), float(i) ** 2]
                rows.append(row)
            return np.array(rows)

        _model_results = {}
        _arima_best_name = "ARIMA Grid"

        with st.spinner("⏳ Evaluating 11 models — please wait ..."):
            # 1. Prophet
            try:
                from prophet import Prophet as _PHM
                _sbuf = _io.StringIO()
                with _ctx.redirect_stdout(_sbuf), _ctx.redirect_stderr(_sbuf), _warn.catch_warnings():
                    _warn.simplefilter("ignore")
                    _ph_m = _PHM(yearly_seasonality=False, weekly_seasonality=False, daily_seasonality=False)
                    _ph_m.fit(pd.DataFrame({"ds": _train_dates.values, "y": _tv_sc}))
                    _ph_ft = _ph_m.make_future_dataframe(periods=_n_test, freq="MS", include_history=False)
                    _ph_tp = _inv(_ph_m.predict(_ph_ft)["yhat"].values)
                    _ph_m2 = _PHM(yearly_seasonality=False, weekly_seasonality=False, daily_seasonality=False)
                    _ph_m2.fit(pd.DataFrame({"ds": _ts_pred["ds"].values, "y": _vv_sc}))
                    _ph_fut = _ph_m2.make_future_dataframe(periods=_n_fcast, freq="MS", include_history=False)
                    _ph_fc3 = _inv(_ph_m2.predict(_ph_fut)["yhat"].values).tolist()
                _model_results["Prophet"] = {"mape": _mase_fn(_test_vals, _ph_tp), "pred_3m": _ph_fc3,
                                             "test_pred": _ph_tp.tolist(), "error": None}
            except Exception as _e:
                _model_results["Prophet"] = {"mape": float("inf"), "pred_3m": [0.0]*_n_fcast,
                                             "test_pred": [0.0]*_n_test, "error": str(_e)[:120]}

            # 2. NeuralProphet
            try:
                import numpy as _np_compat
                if not hasattr(_np_compat, "NaN"): _np_compat.NaN = _np_compat.nan
                import torch as _tch
                _orig_tload = _tch.load
                def _tload_patched(*a, **kw):
                    kw.setdefault("weights_only", False); return _orig_tload(*a, **kw)
                _tch.load = _tload_patched
                import neuralprophet as _NPL; _NPL.set_log_level("ERROR")
                _sbuf = _io.StringIO()
                with _ctx.redirect_stdout(_sbuf), _ctx.redirect_stderr(_sbuf), _warn.catch_warnings():
                    _warn.simplefilter("ignore")
                    _np_tr = pd.DataFrame({"ds": _train_dates.values, "y": _tv_sc.tolist()})
                    _np_m  = _NPL.NeuralProphet(epochs=60, batch_size=min(16, max(1, _n_train)),
                                                yearly_seasonality=False, weekly_seasonality=False, daily_seasonality=False)
                    _np_m.fit(_np_tr, freq="MS")
                    _np_ft = _np_m.make_future_dataframe(_np_tr, periods=_n_test)
                    _np_tp = _inv(_np_m.predict(_np_ft)["yhat1"].iloc[-_n_test:].values)
                    _np_full = pd.DataFrame({"ds": _ts_pred["ds"].values, "y": _vv_sc.tolist()})
                    _np_m2 = _NPL.NeuralProphet(epochs=60, batch_size=min(16, max(1, len(_vals))),
                                                yearly_seasonality=False, weekly_seasonality=False, daily_seasonality=False)
                    _np_m2.fit(_np_full, freq="MS")
                    _np_fut = _np_m2.make_future_dataframe(_np_full, periods=_n_fcast)
                    _np_fc3 = _inv(_np_m2.predict(_np_fut)["yhat1"].iloc[-_n_fcast:].values).tolist()
                _model_results["NeuralProphet"] = {"mape": _mase_fn(_test_vals, _np_tp), "pred_3m": _np_fc3,
                                                   "test_pred": _np_tp.tolist(), "error": None}
            except Exception as _e:
                _model_results["NeuralProphet"] = {"mape": float("inf"), "pred_3m": [0.0]*_n_fcast,
                                                   "test_pred": [0.0]*_n_test, "error": str(_e)[:120]}
            finally:
                try: _tch.load = _orig_tload
                except Exception: pass

            # 3. SARIMA
            try:
                from statsmodels.tsa.statespace.sarimax import SARIMAX as _SARX
                with _warn.catch_warnings():
                    _warn.simplefilter("ignore")
                    _sar_kw = {"order": (1, 1, 1)}
                    if _n_train >= 24: _sar_kw["seasonal_order"] = (1, 0, 1, 12)
                    _sar_r  = _SARX(_tv_sc, **_sar_kw).fit(disp=False)
                    _sar_tp = _inv(_sar_r.forecast(steps=_n_test))
                    _sar_r2 = _SARX(_vv_sc, **_sar_kw).fit(disp=False)
                    _sar_fc = _inv(_sar_r2.forecast(steps=_n_fcast)).tolist()
                _model_results["SARIMA"] = {"mape": _mase_fn(_test_vals, _sar_tp), "pred_3m": _sar_fc,
                                            "test_pred": list(_sar_tp), "error": None}
            except Exception as _e:
                _model_results["SARIMA"] = {"mape": float("inf"), "pred_3m": [0.0]*_n_fcast,
                                            "test_pred": [0.0]*_n_test, "error": str(_e)[:120]}

            # 4. Holt-Winters
            try:
                from statsmodels.tsa.holtwinters import ExponentialSmoothing as _HW
                with _warn.catch_warnings():
                    _warn.simplefilter("ignore")
                    _hw_kw = dict(trend="add",
                                  seasonal="add" if _n_train >= 24 else None,
                                  seasonal_periods=12 if _n_train >= 24 else None,
                                  initialization_method="estimated")
                    _hw_r  = _HW(_tv_sc, **_hw_kw).fit(optimized=True)
                    _hw_tp = _inv(_hw_r.forecast(_n_test))
                    _hw_r2 = _HW(_vv_sc, **_hw_kw).fit(optimized=True)
                    _hw_fc = _inv(_hw_r2.forecast(_n_fcast)).tolist()
                _model_results["Holt-Winters"] = {"mape": _mase_fn(_test_vals, _hw_tp), "pred_3m": _hw_fc,
                                                  "test_pred": list(_hw_tp), "error": None}
            except Exception as _e:
                _model_results["Holt-Winters"] = {"mape": float("inf"), "pred_3m": [0.0]*_n_fcast,
                                                  "test_pred": [0.0]*_n_test, "error": str(_e)[:120]}

            # 5. Holt Linear
            try:
                from statsmodels.tsa.holtwinters import Holt as _Holt
                with _warn.catch_warnings():
                    _warn.simplefilter("ignore")
                    _holt_r  = _Holt(_tv_sc, initialization_method="estimated").fit(optimized=True)
                    _holt_tp = _inv(_holt_r.forecast(_n_test))
                    _holt_r2 = _Holt(_vv_sc, initialization_method="estimated").fit(optimized=True)
                    _holt_fc = _inv(_holt_r2.forecast(_n_fcast)).tolist()
                _model_results["Holt Linear"] = {"mape": _mase_fn(_test_vals, _holt_tp), "pred_3m": _holt_fc,
                                                 "test_pred": list(_holt_tp), "error": None}
            except Exception as _e:
                _model_results["Holt Linear"] = {"mape": float("inf"), "pred_3m": [0.0]*_n_fcast,
                                                 "test_pred": [0.0]*_n_test, "error": str(_e)[:120]}

            # 6. Exp Smoothing
            try:
                from statsmodels.tsa.holtwinters import SimpleExpSmoothing as _SES
                with _warn.catch_warnings():
                    _warn.simplefilter("ignore")
                    _ses_r  = _SES(_tv_sc, initialization_method="estimated").fit(optimized=True)
                    _ses_tp = _inv(_ses_r.forecast(_n_test))
                    _ses_r2 = _SES(_vv_sc, initialization_method="estimated").fit(optimized=True)
                    _ses_fc = _inv(_ses_r2.forecast(_n_fcast)).tolist()
                _model_results["Exp Smoothing"] = {"mape": _mase_fn(_test_vals, _ses_tp), "pred_3m": _ses_fc,
                                                   "test_pred": list(_ses_tp), "error": None}
            except Exception as _e:
                _model_results["Exp Smoothing"] = {"mape": float("inf"), "pred_3m": [0.0]*_n_fcast,
                                                   "test_pred": [0.0]*_n_test, "error": str(_e)[:120]}

            # 7. Theta
            try:
                from statsmodels.tsa.forecasting.theta import ThetaModel as _Theta
                with _warn.catch_warnings():
                    _warn.simplefilter("ignore")
                    _th_r  = _Theta(_tv_sc, period=12).fit()
                    _th_tp = _inv(_th_r.forecast(_n_test))
                    _th_r2 = _Theta(_vv_sc, period=12).fit()
                    _th_fc = _inv(_th_r2.forecast(_n_fcast)).tolist()
                _model_results["Theta"] = {"mape": _mase_fn(_test_vals, _th_tp), "pred_3m": _th_fc,
                                           "test_pred": list(_th_tp), "error": None}
            except Exception as _e:
                _model_results["Theta"] = {"mape": float("inf"), "pred_3m": [0.0]*_n_fcast,
                                           "test_pred": [0.0]*_n_test, "error": str(_e)[:120]}

            # 8. ARIMA Grid
            try:
                from statsmodels.tsa.arima.model import ARIMA as _ARIMA2
                with _warn.catch_warnings():
                    _warn.simplefilter("ignore")
                    _best_aic, _best_ari_ord = float("inf"), (1, 1, 1)
                    for _p in range(4):
                        for _d in range(3):
                            for _q in range(4):
                                try:
                                    _aic = _ARIMA2(_tv_sc, order=(_p, _d, _q)).fit().aic
                                    if _aic < _best_aic: _best_aic = _aic; _best_ari_ord = (_p, _d, _q)
                                except Exception: pass
                    _arima_best_name = f"ARIMA{_best_ari_ord}"
                    _ag_r  = _ARIMA2(_tv_sc, order=_best_ari_ord).fit()
                    _ag_tp = _inv(_ag_r.forecast(_n_test))
                    _ag_r2 = _ARIMA2(_vv_sc, order=_best_ari_ord).fit()
                    _ag_fc = _inv(_ag_r2.forecast(_n_fcast)).tolist()
                _model_results[_arima_best_name] = {"mape": _mase_fn(_test_vals, _ag_tp), "pred_3m": _ag_fc,
                                                    "test_pred": list(_ag_tp), "error": None}
            except Exception as _e:
                _model_results[_arima_best_name] = {"mape": float("inf"), "pred_3m": [0.0]*_n_fcast,
                                                    "test_pred": [0.0]*_n_test, "error": str(_e)[:120]}

            # 9. Ridge (lags)
            try:
                from sklearn.linear_model import Ridge as _Ridge2
                with _warn.catch_warnings():
                    _warn.simplefilter("ignore")
                    _n_lags_r = min(3, max(1, _n_train - 2))
                    if _n_train < _n_lags_r + 2: raise ValueError("Too few data points")
                    _Xl  = _make_lag_X(_tv_sc, _n_lags_r); _yl = _tv_sc[_n_lags_r:]
                    _rg  = _Ridge2(alpha=10.0).fit(_Xl, _yl)
                    _rg_buf, _rg_tp_sc = list(_tv_sc), []
                    for _si in range(_n_test):
                        _xi = np.array([[_rg_buf[-l-1] for l in range(_n_lags_r)] + [float(len(_rg_buf)), float(len(_rg_buf))**2]])
                        _pv = float(_rg.predict(_xi)[0]); _rg_tp_sc.append(_pv); _rg_buf.append(_pv)
                    _rg_tp = _inv(_rg_tp_sc)
                    _Xl2 = _make_lag_X(_vv_sc, _n_lags_r)
                    _rg2 = _Ridge2(alpha=10.0).fit(_Xl2, _vv_sc[_n_lags_r:])
                    _rg_buf2, _rg_fc_sc = list(_vv_sc), []
                    for _si in range(_n_fcast):
                        _xi2 = np.array([[_rg_buf2[-l-1] for l in range(_n_lags_r)] + [float(len(_rg_buf2)), float(len(_rg_buf2))**2]])
                        _pv2 = float(_rg2.predict(_xi2)[0]); _rg_fc_sc.append(_pv2); _rg_buf2.append(_pv2)
                    _rg_fc = _inv(_rg_fc_sc).tolist()
                _model_results["Ridge (lags)"] = {"mape": _mase_fn(_test_vals, _rg_tp), "pred_3m": _rg_fc,
                                                  "test_pred": list(_rg_tp), "error": None}
            except Exception as _e:
                _model_results["Ridge (lags)"] = {"mape": float("inf"), "pred_3m": [0.0]*_n_fcast,
                                                  "test_pred": [0.0]*_n_test, "error": str(_e)[:120]}

            # 10. Gradient Boost
            try:
                from sklearn.ensemble import GradientBoostingRegressor as _GBR
                with _warn.catch_warnings():
                    _warn.simplefilter("ignore")
                    _n_lags_gb = min(4, max(1, _n_train - 2))
                    if _n_train < _n_lags_gb + 4: raise ValueError("Too few data points")
                    _Xgb = _make_lag_X(_tv_sc, _n_lags_gb); _ygb = _tv_sc[_n_lags_gb:]
                    _gb  = _GBR(n_estimators=200, max_depth=2, learning_rate=0.1, random_state=42).fit(_Xgb, _ygb)
                    _gb_buf, _gb_tp_sc = list(_tv_sc), []
                    for _si in range(_n_test):
                        _xi = np.array([[_gb_buf[-l-1] for l in range(_n_lags_gb)] + [float(len(_gb_buf)), float(len(_gb_buf))**2]])
                        _pv = float(_gb.predict(_xi)[0]); _gb_tp_sc.append(_pv); _gb_buf.append(_pv)
                    _gb_tp = _inv(_gb_tp_sc)
                    _Xgb2 = _make_lag_X(_vv_sc, _n_lags_gb)
                    _gb2  = _GBR(n_estimators=200, max_depth=2, learning_rate=0.1, random_state=42).fit(_Xgb2, _vv_sc[_n_lags_gb:])
                    _gb_buf2, _gb_fc_sc = list(_vv_sc), []
                    for _si in range(_n_fcast):
                        _xi2 = np.array([[_gb_buf2[-l-1] for l in range(_n_lags_gb)] + [float(len(_gb_buf2)), float(len(_gb_buf2))**2]])
                        _pv2 = float(_gb2.predict(_xi2)[0]); _gb_fc_sc.append(_pv2); _gb_buf2.append(_pv2)
                    _gb_fc = _inv(_gb_fc_sc).tolist()
                _model_results["Gradient Boost"] = {"mape": _mase_fn(_test_vals, _gb_tp), "pred_3m": _gb_fc,
                                                    "test_pred": list(_gb_tp), "error": None}
            except Exception as _e:
                _model_results["Gradient Boost"] = {"mape": float("inf"), "pred_3m": [0.0]*_n_fcast,
                                                    "test_pred": [0.0]*_n_test, "error": str(_e)[:120]}

        # ── Model competition results ──────────────────────────────────────
        _valid     = {k: v for k, v in _model_results.items() if v["mape"] < float("inf")}
        _best_name = min(_valid, key=lambda k: _valid[k]["mape"]) if _valid else None
        st.markdown(f"#### Model Competition — {'🏆 Winner: **' + _best_name + '**' if _best_name else '⚠️ All models failed'}")

        with st.expander("📊 View model scores", expanded=False):
            _comp_df = pd.DataFrame([
                {"": "🏆" if m == _best_name else "", "Model": m,
                 "MASE": f"{r['mape']:.3f}" if r["mape"] < float("inf") else "—",
                 "Status": "✅ OK" if r["error"] is None else f"❌ {r['error'][:80]}"}
                for m, r in sorted(_model_results.items(), key=lambda x: x[1]["mape"])
            ])
            st.caption("MASE < 1 = beats naive · Lower is better · Scale-free")
            st.dataframe(_comp_df, use_container_width=True, hide_index=True)

        if _best_name:
            _pred_vals = _model_results[_best_name]["pred_3m"]
            _resid_std = float(np.std(np.array(_test_vals) - np.array(_model_results[_best_name]["test_pred"]))) if _n_test > 0 else float(np.std(_vals) * 0.3)
        else:
            from sklearn.preprocessing import PolynomialFeatures as _PF2
            from sklearn.linear_model import Ridge as _RDG
            _pf2   = _PF2(degree=2, include_bias=False)
            _Xp2   = _pf2.fit_transform(np.arange(len(_vals)).reshape(-1, 1))
            _mdlpf = _RDG(alpha=1.0).fit(_Xp2, _vals)
            _Xp2fc = _pf2.transform(np.arange(len(_vals), len(_vals) + _n_fcast).reshape(-1, 1))
            _pred_vals = _mdlpf.predict(_Xp2fc).tolist()
            _resid_std = float(np.std(_vals - _mdlpf.predict(_Xp2)))

        # KPI cards — current month + 3 forecast
        _kc_cols = st.columns(1 + _n_fcast)
        for _ci, (_lbl_kpi, _val_kpi) in enumerate([
            (f"Current<br>({_current_month})", _current_val),
            *[(f"Predicted<br>({_future_lbls[i]})", _pred_vals[i]) for i in range(_n_fcast)],
        ]):
            _bg_kpi = COLOR_BAD if _val_kpi > 0 else COLOR_GOOD
            _kc_cols[_ci].markdown(
                f'<div style="background:{_bg_kpi};border-radius:10px;padding:14px;text-align:center;">'
                f'<p style="margin:0;font-size:0.75rem;font-weight:700;color:white;opacity:.85;">{_lbl_kpi}</p>'
                f'<p style="margin:6px 0 0;font-size:1.25rem;font-weight:800;color:white;">${_val_kpi:,.0f}</p>'
                f'</div>', unsafe_allow_html=True,
            )
        st.markdown("")

        _ytd_cum_cards = [_ytd_total + sum(_pred_vals[:i+1]) for i in range(_n_fcast)]
        _kc2_cols = st.columns(1 + _n_fcast)
        for _ci2, (_lbl2, _val2) in enumerate([
            (f"Cumulative YTD<br>({_current_month})", _ytd_total),
            *[(f"Pred. Cumulative YTD<br>({_future_lbls[i]})", _ytd_cum_cards[i]) for i in range(_n_fcast)],
        ]):
            _bg2 = COLOR_BAD if _val2 > 0 else COLOR_GOOD
            _kc2_cols[_ci2].markdown(
                f'<div style="background:{_bg2};border-radius:10px;padding:14px;text-align:center;opacity:0.85;">'
                f'<p style="margin:0;font-size:0.75rem;font-weight:700;color:white;opacity:.85;">{_lbl2}</p>'
                f'<p style="margin:6px 0 0;font-size:1.25rem;font-weight:800;color:white;">${_val2:,.0f}</p>'
                f'</div>', unsafe_allow_html=True,
            )
        st.markdown("")

        # ── Animated forecast chart ────────────────────────────────────────
        _H   = len(_ts_pred)
        _S   = 12
        _TOT = _H + _n_fcast * _S
        _hist_months = list(_ts_pred["Month"].astype(str))
        _all_months  = _hist_months + _future_lbls
        _cum_hist    = [float(_ts_pred["Net_PPV"].iloc[:i+1].sum()) for i in range(_H)]
        _tr_poly     = np.polyfit(np.arange(_H), _vals, 2)
        _fitted_hist = list(np.polyval(_tr_poly, np.arange(_H)))
        _fitted_fc   = list(np.polyval(_tr_poly, np.arange(_H, _H + _n_fcast)))
        _all_pred_y  = _fitted_hist + list(_pred_vals)

        def _build_frame(_nh, _pp):
            _bx  = _hist_months[:_nh]; _by = list(_ts_pred["Net_PPV"].iloc[:_nh])
            _bc  = [COLOR_BAD if v > 0 else COLOR_GOOD for v in _by]
            _px  = _future_lbls; _py = list(_pp)
            _tx  = _all_months[:max(_nh, 1)]
            _ty  = (_fitted_hist + _fitted_fc)[:max(_nh, 1)]
            _cx  = _hist_months[:_nh] + [_future_lbls[i] for i, p in enumerate(_pp) if p != 0]
            _cy  = _cum_hist[:_nh] + [_ytd_total + sum(_pp[:i+1]) for i, p in enumerate(_pp) if p != 0]
            _sx  = []; _sy = []
            for i, p in enumerate(_pp):
                if p != 0: _sx += [_future_lbls[i], _future_lbls[i], None]; _sy += [_fitted_fc[i] - 1.5*_resid_std, _fitted_fc[i] + 1.5*_resid_std, None]
            _ux = list(_all_months[:_nh])
            _uy = list(_all_pred_y[:_nh])
            for _pi, _pp2 in enumerate(_pp):
                if _pp2 != 0: _ux.append(_future_lbls[_pi]); _uy.append(_pred_vals[_pi])
            return _bx, _by, _bc, _px, _py, _tx, _ty, _cx, _cy, _sx, _sy, _ux, _uy

        _bx0, _by0, _bc0, _px0, _py0, _tx0, _ty0, _cx0, _cy0, _sx0, _sy0, _ux0, _uy0 = _build_frame(_H, _pred_vals)
        _fig_fc = go.Figure(data=[
            go.Bar(x=_bx0, y=_by0, name="Actual", marker_color=_bc0, opacity=0.85),
            go.Bar(x=_px0, y=_py0, name=f"Predicted ({_best_name or 'Model'})",
                   marker_color="rgba(59,130,246,0.50)", marker_line=dict(color=COLOR_NEUTRAL, width=2)),
            go.Scatter(x=_tx0, y=_ty0, mode="lines", name="Trend",
                       line=dict(color=COLOR_NEUTRAL, width=2, dash="dot")),
            go.Scatter(x=_cx0, y=_cy0, mode="lines+markers", name="Cumulative (YTD)",
                       line=dict(color="#f59e0b", width=2), marker=dict(size=6), yaxis="y2"),
            go.Scatter(x=_sx0, y=_sy0, mode="lines", name="±1.5σ range",
                       line=dict(color="rgba(59,130,246,0.40)", width=8)),
            go.Scatter(x=_ux0, y=_uy0, mode="lines", name="Prediction curve",
                       line=dict(color="rgba(147,51,234,0.30)", width=14)),
        ])
        _frames = []
        for _fi in range(_TOT):
            if _fi < _H:
                _nh2, _pp2 = _fi + 1, [0.0] * _n_fcast
            else:
                _nh2 = _H; _idx = _fi - _H; _bi = _idx // _S; _si = _idx % _S + 1
                _pp2 = [
                    _pred_vals[j] * min(_si, _S) / _S if j < _bi
                    else (_pred_vals[j] * _si / _S if j == _bi else 0.0)
                    for j in range(_n_fcast)
                ]
            _bx, _by, _bc, _px, _py, _tx, _ty, _cx, _cy, _sx, _sy, _ux, _uy = _build_frame(_nh2, _pp2)
            _frames.append(go.Frame(
                data=[
                    go.Bar(x=_bx, y=_by, marker_color=_bc, opacity=0.85),
                    go.Bar(x=_px, y=_py),
                    go.Scatter(x=_tx, y=_ty, mode="lines"),
                    go.Scatter(x=_cx, y=_cy, mode="lines+markers", yaxis="y2"),
                    go.Scatter(x=_sx, y=_sy, mode="lines"),
                    go.Scatter(x=_ux, y=_uy, mode="lines"),
                ],
                traces=[0, 1, 2, 3, 4, 5], name=str(_fi),
            ))
        _fig_fc.frames = _frames
        _fig_fc.update_layout(
            uirevision="ppv_forecast", barmode="overlay",
            plot_bgcolor="white", paper_bgcolor="white",
            margin=dict(t=80, b=20, l=10, r=80),
            yaxis=dict(title="Net PPV (USD)", zeroline=True, zerolinecolor="#9ca3af", zerolinewidth=1.5),
            yaxis2=dict(title="Cumulative (USD)", overlaying="y", side="right", showgrid=False, zeroline=False),
            xaxis=dict(categoryorder="array", categoryarray=_all_months),
            height=500,
            legend=dict(orientation="h", yanchor="bottom", y=1.05, xanchor="right", x=1),
            updatemenus=[dict(
                type="buttons", showactive=False, y=1.22, x=0.0, xanchor="left",
                buttons=[
                    dict(label="▶ Animate", method="animate",
                         args=[None, dict(frame=dict(duration=60, redraw=True),
                                         transition=dict(duration=15, easing="cubic-in-out"),
                                         fromcurrent=False, mode="immediate")]),
                    dict(label="⏸ Stop", method="animate",
                         args=[[None], dict(frame=dict(duration=0, redraw=False), mode="immediate")]),
                ],
            )],
            sliders=[dict(
                active=0, y=0,
                currentvalue=dict(prefix="Frame: ", font=dict(size=10), visible=True, xanchor="right"),
                len=0.88, x=0.12,
                steps=[dict(
                    method="animate",
                    args=[[str(i)], dict(mode="immediate", frame=dict(duration=60, redraw=True), transition=dict(duration=0))],
                    label="" if i % 5 != 0 else str(i),
                ) for i in range(_TOT)],
            )],
        )
        st.plotly_chart(_fig_fc, use_container_width=True)
