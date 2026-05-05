"""
chart_helpers.py
Reusable Plotly chart builders and the automatic outlier-model selector.
"""

import numpy as np
import plotly.express as px
import plotly.graph_objects as go

from config import COLOR_GOOD, COLOR_BAD, COLOR_NEUTRAL


# ─── Bar chart ────────────────────────────────────────────────────────────────
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


# ─── Line chart ───────────────────────────────────────────────────────────────
def _line(df_ts, x, y, title):
    fig = px.line(df_ts, x=x, y=y, markers=True, title=title,
                  color_discrete_sequence=[COLOR_NEUTRAL])
    fig.add_hline(y=0, line_dash="dash", line_color="#9ca3af", line_width=1)
    fig.update_layout(
        plot_bgcolor="white", paper_bgcolor="white",
        margin=dict(t=40, b=10, l=10, r=10), title_font_size=14,
    )
    return fig


# ─── Outlier model selector ───────────────────────────────────────────────────
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

    # Isolation Forest (optional)
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
