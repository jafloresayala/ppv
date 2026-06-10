"""
backend/analytics.py
All server-side data aggregations and ML computations for all 9 dashboard tabs.
"""
from __future__ import annotations

import os
import warnings
from concurrent.futures import ThreadPoolExecutor, as_completed
warnings.filterwarnings("ignore")

import numpy as np
import pandas as pd
from typing import Any

# Pre-import sklearn at module load so the first API call isn't penalised
try:
    from sklearn.tree import DecisionTreeClassifier
    from sklearn.preprocessing import StandardScaler
    _SKLEARN_OK = True
except ImportError:  # pragma: no cover
    _SKLEARN_OK = False


# ─── helpers ──────────────────────────────────────────────────────────────────

def _safe_float(v) -> float:
    try:
        f = float(v)
        return f if np.isfinite(f) else 0.0
    except Exception:
        return 0.0


def _to_records(df: pd.DataFrame) -> list[dict]:
    """Convert df to JSON-safe records."""
    out = []
    for row in df.to_dict("records"):
        safe = {}
        for k, v in row.items():
            if isinstance(v, float) and not np.isfinite(v):
                safe[k] = None
            elif isinstance(v, (np.integer,)):
                safe[k] = int(v)
            elif isinstance(v, (np.floating,)):
                safe[k] = float(v)
            elif isinstance(v, pd.Timestamp):
                safe[k] = str(v.date())
            else:
                safe[k] = v
        out.append(safe)
    return out


def _plant_list(df: pd.DataFrame, group_col: str) -> dict[str, list]:
    """Return {group_value: sorted_plant_codes_list} mapping, or {} if no Plant column."""
    if "Plant" not in df.columns or group_col not in df.columns:
        return {}
    return (
        df.groupby(group_col)["Plant"]
        .apply(lambda x: sorted(set(x.dropna().astype(str).tolist())))
        .to_dict()
    )


# ─── KPIs (shared header row) ─────────────────────────────────────────────────

def compute_kpis(df: pd.DataFrame, ppv_col: str) -> dict:
    s = df[ppv_col] if ppv_col in df.columns else pd.Series([], dtype=float)
    return {
        "total_ppv":    _safe_float(s.sum()),
        "favorable":    _safe_float(s[s <= 0].sum()),
        "unfavorable":  _safe_float(s[s > 0].sum()),
        "records":      int(len(df)),
        "vendors":      int(df["Vendor_Name"].nunique()) if "Vendor_Name" in df.columns else 0,
        "materials":    int(df["Material_Number"].nunique()) if "Material_Number" in df.columns else 0,
    }


# ─── Tab 1 — Trend ────────────────────────────────────────────────────────────

def compute_trend(df: pd.DataFrame, ppv_col: str) -> dict:
    if ppv_col not in df.columns:
        return {}

    has_ym = "YearMonth" in df.columns
    ts_data = df[df["YearMonth"] != ""].copy() if has_ym else None

    if ts_data is None or ts_data.empty:
        return {"granularity": "none", "labels": [], "values": [], "cumulative": []}

    unique_months = ts_data["YearMonth"].nunique()
    if unique_months <= 1 and "PostingDay" in ts_data.columns:
        ts = (
            ts_data[ts_data["PostingDay"].notna()]
            .groupby("PostingDay")[ppv_col].sum()
            .reset_index()
            .sort_values("PostingDay")
        )
        ts["label"] = ts["PostingDay"].astype(str)
        granularity  = "daily"
    else:
        ts = (
            ts_data.groupby("YearMonth")[ppv_col].sum()
            .reset_index().sort_values("YearMonth")
        )
        ts["label"] = ts["YearMonth"]
        granularity  = "monthly"

    vals = ts[ppv_col].tolist() if ppv_col in ts.columns else ts.iloc[:, 1].tolist()
    cum  = list(pd.Series(vals).cumsum())
    labels = ts["label"].tolist()
    result: dict = {
        "granularity": granularity,
        "labels":      labels,
        "values":      [_safe_float(v) for v in vals],
        "cumulative":  [_safe_float(v) for v in cum],
    }

    # Per-plant breakdown (only for multi-plant queries)
    if "Plant" in df.columns:
        plants = sorted(str(p) for p in df["Plant"].dropna().unique().tolist())
        if len(plants) > 1:
            group_col = "PostingDay" if granularity == "daily" else "YearMonth"
            by_plant: dict[str, list] = {}
            for plant in plants:
                pdf = df[df["Plant"] == plant]
                if has_ym:
                    pdf = pdf[pdf["YearMonth"] != ""]
                if pdf.empty or group_col not in pdf.columns:
                    by_plant[plant] = [0.0] * len(labels)
                    continue
                pts = pdf.groupby(group_col)[ppv_col].sum().reset_index()
                lbl_col = "PostingDay" if granularity == "daily" else "YearMonth"
                label_val = dict(zip(pts[lbl_col].astype(str), pts[ppv_col]))
                by_plant[plant] = [_safe_float(label_val.get(lbl, 0)) for lbl in labels]
            result["by_plant"] = by_plant

    return result


# ─── Tab 2 — Material Groups ──────────────────────────────────────────────────

def compute_mg_plant_components(df: pd.DataFrame, ppv_col: str, group: str, plant: str) -> dict:
    """Component (material) breakdown for one material-group + plant slice."""
    empty: dict = {"group": group, "plant": plant, "total": 0.0, "components": []}
    if "Material_Group_Description" not in df.columns or ppv_col not in df.columns:
        return empty

    mask = df["Material_Group_Description"].astype(str) == group
    if "Plant" in df.columns:
        mask = mask & (df["Plant"].astype(str) == plant)

    sub = df[mask]
    if sub.empty:
        return empty

    total = _safe_float(sub[ppv_col].sum())

    agg = (
        sub.groupby("Material_Number")[ppv_col]
        .agg(ppv="sum", records="count")
        .reset_index()
        .sort_values("ppv", key=abs, ascending=False)
    )

    desc_map: dict = {}
    if "Material_Description" in sub.columns:
        desc_map = sub.groupby("Material_Number")["Material_Description"].first().to_dict()

    components = [
        {
            "material":    str(row["Material_Number"]),
            "description": str(desc_map.get(str(row["Material_Number"]), "")),
            "ppv":         _safe_float(row["ppv"]),
            "records":     int(row["records"]),
        }
        for _, row in agg.iterrows()
    ]
    return {"group": group, "plant": plant, "total": total, "components": components}


def compute_material_groups(df: pd.DataFrame, ppv_col: str) -> dict:
    if "Material_Group_Description" not in df.columns or ppv_col not in df.columns:
        return {"groups": [], "treemap": []}

    mg = (
        df.groupby("Material_Group_Description")[ppv_col]
        .sum().reset_index()
        .rename(columns={ppv_col: "total"})
        .sort_values("total", key=abs, ascending=False)
    )
    mg["abs_total"] = mg["total"].abs()
    mg["type"] = mg["total"].apply(lambda v: "Favorable" if v <= 0 else "Unfavorable")

    plant_map_mg = _plant_list(df, "Material_Group_Description")

    # by_plant PPV total per group
    by_plant_mg: dict[str, dict[str, float]] = {}
    if "Plant" in df.columns:
        bp = (
            df.groupby(["Material_Group_Description", "Plant"])[ppv_col]
            .sum().reset_index()
        )
        for gname, gdf in bp.groupby("Material_Group_Description"):
            by_plant_mg[str(gname)] = {
                str(row["Plant"]): _safe_float(row[ppv_col])
                for _, row in gdf.iterrows()
            }

    groups = [
        {
            "name":      r["Material_Group_Description"],
            "total":     _safe_float(r["total"]),
            "abs_total": _safe_float(r["abs_total"]),
            "type":      r["type"],
            "plants":    plant_map_mg.get(r["Material_Group_Description"], []),
            "by_plant":  by_plant_mg.get(r["Material_Group_Description"], {}),
        }
        for r in mg.to_dict("records")
    ]

    # per-group drilldown — single 2-level groupby instead of N nested groupbys
    drilldown: dict[str, dict] = {}
    if "Material_Number" in df.columns:
        _d_cols = ["Material_Group_Description", "Material_Number"]
        if "Material_Description" in df.columns:
            _d_cols.append("Material_Description")
        _by_mat = (
            df.groupby(_d_cols)[ppv_col]
            .agg(total="sum", records="count")
            .reset_index()
        )
        # Per-material, per-plant totals — enriches drilldown rows with a by_plant map
        _mat_plant_lookup: dict[tuple, dict] = {}
        if "Plant" in df.columns:
            _by_mp = (
                df.groupby(["Material_Group_Description", "Material_Number", "Plant"])[ppv_col]
                .sum().reset_index()
            )
            for _r in _by_mp.to_dict("records"):
                _key = (str(_r["Material_Group_Description"]), str(_r["Material_Number"]))
                _mat_plant_lookup.setdefault(_key, {})[str(_r["Plant"])] = _safe_float(_r[ppv_col])

        for gname, gdf in _by_mat.groupby("Material_Group_Description"):
            # Keep both lists explicitly sorted by their own business direction:
            # unfavorable = highest positive PPV first, favorable = lowest (most negative) first.
            unf = gdf[gdf["total"] > 0].sort_values("total", ascending=False)
            fav = gdf[gdf["total"] <= 0].sort_values("total", ascending=True)

            def _enrich(recs: list[dict], _g: str = str(gname)) -> list[dict]:
                for rec in recs:
                    bp = _mat_plant_lookup.get((_g, str(rec.get("Material_Number", ""))), {})
                    if bp:
                        rec["by_plant"] = bp
                return recs

            drilldown[str(gname)] = {
                "unfavorable": _enrich(_to_records(unf.head(10))),
                "favorable":   _enrich(_to_records(fav.head(10))),
            }

    # per-group trend
    trends: dict[str, dict] = {}
    if "YearMonth" in df.columns:
        ts_all = (
            df[df["YearMonth"] != ""]
            .groupby(["Material_Group_Description", "YearMonth"])[ppv_col]
            .sum().reset_index()
        )
        for gname, gts in ts_all.groupby("Material_Group_Description"):
            gts = gts.sort_values("YearMonth")
            ys  = gts[ppv_col].values
            xs  = np.arange(len(ys))
            if len(ys) >= 2:
                z   = np.polyfit(xs, ys, 1)
                ty  = np.polyval(z, xs)
                res = ys - ty
                sig = res.std()
                slope = float(z[0])
                rng   = float(ys.max() - ys.min()) if len(ys) > 1 else 1.0
                norm  = abs(slope) / (rng if rng != 0 else 1)
                if norm < 0.03:    direction = "stable"
                elif slope > 0:    direction = "up"
                else:              direction = "down"
                trends[str(gname)] = {
                    "labels":    gts["YearMonth"].tolist(),
                    "values":    [_safe_float(v) for v in ys],
                    "trend_line": [_safe_float(v) for v in ty],
                    "upper2s":   [_safe_float(v) for v in (ty + 2 * sig)],
                    "lower2s":   [_safe_float(v) for v in (ty - 2 * sig)],
                    "direction": direction,
                }

    return {"groups": groups, "drilldown": drilldown, "trends": trends}


# ─── Tab 3 — Vendors ──────────────────────────────────────────────────────────

def compute_vendors(df: pd.DataFrame, ppv_col: str) -> dict:
    if "Vendor_Name" not in df.columns or ppv_col not in df.columns:
        return {"vendors": [], "scatter": [], "knn_grid": None}

    va = df.groupby(["Vendor_Name", "Account_Number_of_Vendor_or_Creditor"]).agg(
        total=(ppv_col, "sum"),
        records=(ppv_col, "count"),
        average=(ppv_col, "mean"),
    ).reset_index() if "Account_Number_of_Vendor_or_Creditor" in df.columns else (
        df.groupby("Vendor_Name").agg(
            total=(ppv_col, "sum"),
            records=(ppv_col, "count"),
            average=(ppv_col, "mean"),
        ).reset_index()
    )
    va = va.sort_values("total", key=abs, ascending=False)

    plant_map_v = _plant_list(df, "Vendor_Name")
    scatter = [
        {
            "name":    r["Vendor_Name"],
            "code":    r.get("Account_Number_of_Vendor_or_Creditor", ""),
            "total":   _safe_float(r["total"]),
            "records": int(r["records"]),
            "average": _safe_float(r["average"]),
            "plants":  plant_map_v.get(r["Vendor_Name"], []),
        }
        for r in va.to_dict("records")  # to_dict avoids per-row Series allocation
    ]

    # Decision-region grid — DecisionTree is O(depth × n) vs KNN O(n_train × n_grid)
    knn_grid = None
    try:
        if not _SKLEARN_OK:
            raise ImportError
        X = va[["records", "total"]].values.astype(float)
        q25 = float(va["total"].quantile(0.25))
        q75 = float(va["total"].quantile(0.75))
        def _lbl(v): return 0 if v < min(q25, 0) else (2 if v > max(q75, 0) else 1)
        labels = np.array([_lbl(v) for v in va["total"]])
        if len(np.unique(labels)) >= 2:
            ss  = StandardScaler()
            Xsc = ss.fit_transform(X)
            clf = DecisionTreeClassifier(max_depth=4, random_state=42)
            clf.fit(Xsc, labels)
            xp = (X[:, 0].max() - X[:, 0].min()) * 0.25 + 1
            yp = (X[:, 1].max() - X[:, 1].min()) * 0.25 + 1
            gx = np.linspace(X[:, 0].min() - xp, X[:, 0].max() + xp, 30)
            gy = np.linspace(X[:, 1].min() - yp, X[:, 1].max() + yp, 30)
            xx, yy = np.meshgrid(gx, gy)
            Z = clf.predict(ss.transform(np.c_[xx.ravel(), yy.ravel()])).reshape(xx.shape)
            knn_grid = {
                "x":    gx.tolist(),
                "y":    gy.tolist(),
                "z":    Z.astype(int).tolist(),
                "x_min": float(X[:, 0].min() - xp),
                "x_max": float(X[:, 0].max() + xp),
                "y_min": float(X[:, 1].min() - yp),
                "y_max": float(X[:, 1].max() + yp),
            }
    except Exception:
        pass

    # vendor drilldown — rich object with summary stats, monthly trend, and top materials
    drilldown: dict[str, dict] = {}
    if "Material_Number" in df.columns:
        desc_col = "Material_Description" if "Material_Description" in df.columns else None

        # Material-level totals per vendor
        _vd = (
            df.groupby(["Vendor_Name", "Material_Number"])[ppv_col]
            .agg(total="sum", records="count")
            .reset_index()
        )
        if desc_col:
            desc_map = df.groupby("Material_Number")[desc_col].first()
            _vd["description"] = _vd["Material_Number"].map(desc_map).fillna("").astype(str)
        else:
            _vd["description"] = _vd["Material_Number"].astype(str)

        # Pre-group monthly trend by vendor (single pass)
        vtrend_map: dict[str, pd.DataFrame] = {}
        if "YearMonth" in df.columns:
            _vt = (
                df[df["YearMonth"] != ""]
                .groupby(["Vendor_Name", "YearMonth"])[ppv_col]
                .sum()
                .reset_index()
                .sort_values("YearMonth")
            )
            for _vn, _sub in _vt.groupby("Vendor_Name"):
                vtrend_map[str(_vn)] = _sub.reset_index(drop=True)

        for vname, vdf in _vd.groupby("Vendor_Name"):
            sname    = str(vname)
            vtotal   = _safe_float(vdf["total"].sum())
            vrecs    = int(vdf["records"].sum())
            vmatcnt  = int(vdf["Material_Number"].nunique())
            vavg     = vtotal / vrecs if vrecs else 0.0

            # Monthly trend + worst month
            trend_out   = None
            worst_month = None
            sub_t = vtrend_map.get(sname)
            if sub_t is not None and len(sub_t):
                worst_idx   = sub_t[ppv_col].abs().idxmax()
                worst_month = str(sub_t.loc[worst_idx, "YearMonth"])
                trend_out   = {
                    "labels": sub_t["YearMonth"].tolist(),
                    "values": [_safe_float(v) for v in sub_t[ppv_col].tolist()],
                }

            # Top 20 materials by absolute PPV
            top = vdf.sort_values("total", key=abs, ascending=False).head(20)
            by_material = [
                {
                    "material":    r["Material_Number"],
                    "description": r["description"],
                    "total":       _safe_float(r["total"]),
                    "records":     int(r["records"]),
                }
                for r in top.to_dict("records")
            ]

            drilldown[sname] = {
                "total":          vtotal,
                "records":        vrecs,
                "material_count": vmatcnt,
                "avg_per_record": _safe_float(vavg),
                "worst_month":    worst_month,
                "trend":          trend_out,
                "by_material":    by_material,
            }

    return {"vendors": scatter, "knn_grid": knn_grid, "drilldown": drilldown}


# ─── Tab 4 — Materials ────────────────────────────────────────────────────────

def _best_outlier_model(values: np.ndarray):
    """Fast IQR-based outlier detection (O(n), no model training).
    Falls back to z-score when IQR is near zero (constant-ish data).
    """
    n = len(values)
    if n < 4:
        return np.zeros(n, dtype=bool), "insufficient"
    Q1, Q3 = np.percentile(values, [25, 75])
    IQR = Q3 - Q1
    if IQR < 1e-9:
        mu, sigma = values.mean(), values.std()
        return (np.abs((values - mu) / (sigma + 1e-9)) > 2.5), "Z-Score"
    return (values < Q1 - 1.5 * IQR) | (values > Q3 + 1.5 * IQR), "IQR"


def compute_materials(df: pd.DataFrame, ppv_col: str, price_col: str = "") -> dict:
    if "Material_Number" not in df.columns or ppv_col not in df.columns:
        return {"materials": [], "pareto": []}

    desc_col = "Material_Description" if "Material_Description" in df.columns else None
    grp_cols = ["Material_Number"] + ([desc_col] if desc_col else [])
    ma = df.groupby(grp_cols).agg(
        total=(ppv_col, "sum"),
        records=(ppv_col, "count"),
        average=(ppv_col, "mean"),
    ).reset_index().sort_values("total", key=abs, ascending=False)
    ma["abs_total"] = ma["total"].abs()

    plant_map_mat = _plant_list(df, "Material_Number")
    materials = [
        {
            "number":  r["Material_Number"],
            "desc":    r[desc_col] if desc_col else r["Material_Number"],
            "total":   _safe_float(r["total"]),
            "records": int(r["records"]),
            "average": _safe_float(r["average"]),
            "plants":  plant_map_mat.get(r["Material_Number"], []),
        }
        for r in ma.head(100).to_dict("records")  # cap at 100 for perf
    ]

    # Pareto for unfavorable
    unfav = ma[ma["total"] > 0].sort_values("total", ascending=False).head(50).copy()
    unfav["cum_pct"] = unfav["total"].cumsum() / (unfav["total"].sum() + 1e-9) * 100
    pareto = [
        {
            "number":  r["Material_Number"],
            "desc":    r[desc_col] if desc_col else r["Material_Number"],
            "total":   _safe_float(r["total"]),
            "cum_pct": _safe_float(r["cum_pct"]),
            "rank":    i + 1,
            "plants":  plant_map_mat.get(r["Material_Number"], []),
        }
        for i, r in enumerate(unfav.to_dict("records"))
    ]

    # outlier detection — limited to top 100 materials by PPV volume for performance
    outliers_by_mat: dict[str, dict] = {}
    if price_col and price_col in df.columns and "Vendor_Name" in df.columns:
        _top_mats = set(
            df.groupby("Material_Number")[ppv_col].sum().abs().nlargest(100).index
        )
        for mat, mdf in df[df["Material_Number"].isin(_top_mats)].groupby("Material_Number"):
            vals = mdf[price_col].values.astype(float)
            if len(vals) >= 4:
                mask, model_name = _best_outlier_model(vals)
                outliers_by_mat[str(mat)] = {
                    "outlier_indices": np.where(mask)[0].tolist(),
                    "model": model_name,
                }

    return {
        "materials":    materials[:100],   # cap for perf
        "pareto":       pareto[:50],
        "outliers":     outliers_by_mat,
    }


# ─── Tab 5 — Product Hierarchy ────────────────────────────────────────────────

def compute_hierarchy(df: pd.DataFrame, ppv_col: str) -> dict:
    PH = "Product_Hierarchy"
    if PH not in df.columns or ppv_col not in df.columns:
        return {"hierarchies": []}

    ph = (
        df[df[PH].notna() & (df[PH].astype(str).str.strip() != "")]
        .groupby(PH).agg(total=(ppv_col, "sum"), records=(ppv_col, "count"))
        .reset_index().sort_values("total", ascending=False)
    )

    trends: dict[str, str] = {}
    if "YearMonth" in df.columns:
        ts_all = (
            df[df["YearMonth"] != ""].groupby([PH, "YearMonth"])[ppv_col]
            .sum().reset_index()
        )
        for phn, sub in ts_all.groupby(PH):
            sub = sub.sort_values("YearMonth")
            sy  = sub[ppv_col].values
            if len(sy) >= 2:
                sc  = np.polyfit(np.arange(len(sy)), sy, 1)[0]
                pct = abs(sc) / (abs(sy.mean()) + 1e-9) * 100
                if sc > 0 and pct > 5:    trends[str(phn)] = "up"
                elif sc < 0 and pct > 5:  trends[str(phn)] = "down"
                else:                     trends[str(phn)] = "stable"
            else:
                trends[str(phn)] = "stable"

    # per-hierarchy trend data  (IQR-outlier-aware)
    trend_series: dict[str, dict] = {}
    if "YearMonth" in df.columns:
        ts_all2 = df[df["YearMonth"] != ""].groupby([PH, "YearMonth"])[ppv_col].sum().reset_index()
        for phn, sub in ts_all2.groupby(PH):
            sub  = sub.sort_values("YearMonth")
            vals = np.array([_safe_float(v) for v in sub[ppv_col]], dtype=float)
            lbs  = sub["YearMonth"].tolist()
            n    = len(vals)
            # IQR fences
            if n >= 4:
                q1, q3 = float(np.percentile(vals, 25)), float(np.percentile(vals, 75))
                iqr    = q3 - q1
                lower_fence = q1 - 1.5 * iqr
                upper_fence = q3 + 1.5 * iqr
            else:
                span        = float(np.ptp(vals)) if n > 1 else (abs(float(vals[0])) * 0.5 + 1)
                lower_fence = float(np.min(vals)) - span * 0.5
                upper_fence = float(np.max(vals)) + span * 0.5
            # Linear regression on inlier points only
            inlier = (vals >= lower_fence) & (vals <= upper_fence)
            xs_in  = np.where(inlier)[0]
            if len(xs_in) >= 2:
                c = np.polyfit(xs_in, vals[inlier], 1)
                trend_line = [float(np.polyval(c, i)) for i in range(n)]
            else:
                trend_line = None
            trend_series[str(phn)] = {
                "labels":      lbs,
                "values":      vals.tolist(),
                "lower_fence": lower_fence,
                "upper_fence": upper_fence,
                "trend_line":  trend_line,
                "outliers":    [None if inlier[i] else float(vals[i]) for i in range(n)],
            }

    plant_map_ph = _plant_list(df, PH)
    hierarchies = [
        {
            "code":    r[PH],
            "total":   _safe_float(r["total"]),
            "records": int(r["records"]),
            "trend":   trends.get(str(r[PH]), "stable"),
            "plants":  plant_map_ph.get(r[PH], []),
        }
        for r in ph.to_dict("records")
    ]

    return {"hierarchies": hierarchies, "trend_series": trend_series}


# ─── Tab 6 — Distribution ────────────────────────────────────────────────────

def _box_stats(vals: np.ndarray) -> dict:
    q1, med, q3 = float(np.percentile(vals, 25)), float(np.median(vals)), float(np.percentile(vals, 75))
    iqr = q3 - q1
    lower_fence = q1 - 1.5 * iqr
    upper_fence = q3 + 1.5 * iqr
    inliers = vals[(vals >= lower_fence) & (vals <= upper_fence)]
    outlier_pts = vals[(vals < lower_fence) | (vals > upper_fence)].tolist()
    return {
        "min":      float(inliers.min()) if len(inliers) else float(vals.min()),
        "q1":       q1,
        "median":   med,
        "q3":       q3,
        "max":      float(inliers.max()) if len(inliers) else float(vals.max()),
        "mean":     float(vals.mean()),
        "outliers": [_safe_float(o) for o in outlier_pts],
        "iqr":      iqr,
        "lower_fence": float(lower_fence),
        "upper_fence": float(upper_fence),
    }


def compute_distribution(df: pd.DataFrame, ppv_col: str) -> dict:
    if "Material_Group_Description" not in df.columns or ppv_col not in df.columns:
        return {"box_data": [], "pie_by_group": []}

    top10 = (
        df.groupby("Material_Group_Description")[ppv_col]
        .sum().abs().nlargest(10).index.tolist()
    )
    box_data = []
    for g in top10:
        vals = df[df["Material_Group_Description"] == g][ppv_col].dropna().values.astype(float)
        if len(vals) < 2:
            continue
        box_data.append({"group": g, **_box_stats(vals)})

    # pie breakdown per group (top 3 loss groups)
    loss_groups = (
        df[df[ppv_col] > 0]
        .groupby("Material_Group_Description")[ppv_col]
        .sum().nlargest(3).index.tolist()
    )
    pie_by_group: dict[str, dict] = {}
    for g in loss_groups:
        gdf = df[df["Material_Group_Description"] == g]
        # pie by material
        if "Material_Number" in gdf.columns:
            pm = gdf.groupby("Material_Number")[ppv_col].sum().abs().nlargest(8)
            pie_by_group[g] = {
                "by_material": {
                    "labels": pm.index.tolist(),
                    "values": [_safe_float(v) for v in pm.values],
                }
            }
        if "Vendor_Name" in gdf.columns:
            pv = gdf.groupby("Vendor_Name")[ppv_col].sum().abs().nlargest(8)
            pie_by_group[g]["by_vendor"] = {
                "labels": pv.index.tolist(),
                "values": [_safe_float(v) for v in pv.values],
            }

    return {"box_data": box_data, "pie_by_group": pie_by_group}


# ─── Tab 7 — Impact (scatter + correlation + forecast) ───────────────────────

def compute_impact_scatter(df: pd.DataFrame, ppv_col: str) -> list[dict]:
    if "Material_Number" not in df.columns or ppv_col not in df.columns:
        return []
    desc_col = "Material_Description" if "Material_Description" in df.columns else None
    grp = ["Material_Number"] + ([desc_col] if desc_col else [])
    agg = df.groupby(grp).agg(
        total=(ppv_col, "sum"), records=(ppv_col, "count"), avg=(ppv_col, "mean")
    ).reset_index()
    agg["abs_total"] = agg["total"].abs()

    p05 = float(agg["total"].quantile(0.05))
    p95 = float(agg["total"].quantile(0.95))

    # Vectorized zone assignment — no iterrows
    top = agg.sort_values("abs_total", ascending=False).head(200)
    zones = np.where(top["total"].values > p95, "outlier_pos",
            np.where(top["total"].values < p05, "outlier_neg", "normal"))

    desc_vals = top[desc_col].tolist() if desc_col else top["Material_Number"].tolist()
    plant_map_imp = _plant_list(df, "Material_Number")
    return [
        {
            "number":  mat,
            "desc":    desc,
            "total":   _safe_float(tot),
            "records": int(rec),
            "avg":     _safe_float(avg),
            "zone":    zone,
            "plants":  plant_map_imp.get(mat, []),
        }
        for mat, desc, tot, rec, avg, zone in zip(
            top["Material_Number"].tolist(), desc_vals,
            top["total"].tolist(), top["records"].tolist(),
            top["avg"].tolist(), zones.tolist(),
        )
    ]


def compute_correlation_matrix(df: pd.DataFrame) -> dict:
    num_cols = [c for c in df.columns if c.endswith("_num") and df[c].notna().sum() > 5]
    if len(num_cols) < 2:
        return {"labels": [], "values": []}
    clean_lbl = lambda c: c.replace("_num", "").replace("_", " ").title()
    corr = df[num_cols].corr()
    return {
        "labels": [clean_lbl(c) for c in num_cols],
        "values": [[_safe_float(v) for v in row] for row in corr.values.tolist()],
    }


def compute_forecast(df: pd.DataFrame, ppv_col: str, scale_method: str = "StandardScaler") -> dict:
    if "YearMonth" not in df.columns or ppv_col not in df.columns:
        return {"available": False}

    ts = (
        df.groupby("YearMonth")[ppv_col].sum()
        .reset_index().sort_values("YearMonth")
        .rename(columns={"YearMonth": "Month", ppv_col: "Net_PPV"})
    )
    if len(ts) < 4:
        return {"available": False, "reason": "Need at least 4 months"}

    try:
        ts["ds"] = pd.PeriodIndex(ts["Month"], freq="M").to_timestamp()
    except Exception:
        ts["ds"] = pd.to_datetime(ts["Month"], format="%Y-%m", errors="coerce")

    vals     = ts["Net_PPV"].values.astype(float)
    n_test   = min(3, max(1, len(ts) // 3))
    n_train  = len(ts) - n_test
    n_fcast  = 3

    try:
        base = pd.Period(ts["Month"].iloc[-1], freq="M")
        future_lbls = [(base + i).strftime("%Y-%m") for i in range(1, n_fcast + 1)]
    except Exception:
        future_lbls = [f"Month+{i}" for i in range(1, n_fcast + 1)]

    # Scaling
    from sklearn.preprocessing import StandardScaler, MinMaxScaler
    if scale_method == "StandardScaler":   scaler = StandardScaler()
    elif scale_method == "Min-Max":        scaler = MinMaxScaler()
    else:                                  scaler = None

    if scaler is not None:
        tv_sc = scaler.fit_transform(vals[:n_train].reshape(-1, 1)).ravel()
        vv_sc = scaler.transform(vals.reshape(-1, 1)).ravel()
        inv   = lambda a: scaler.inverse_transform(np.array(a, dtype=float).reshape(-1, 1)).ravel()
    else:
        tv_sc = vals[:n_train].copy()
        vv_sc = vals.copy()
        inv   = lambda a: np.array(a, dtype=float)

    def _mase(actual, predicted):
        a, p = np.array(actual, dtype=float), np.array(predicted, dtype=float)
        mae  = np.mean(np.abs(a - p))
        naive_errors = np.abs(np.diff(a))
        naive_mae = np.mean(naive_errors) if len(naive_errors) else 1.0
        return _safe_float(mae / (naive_mae + 1e-9))

    results: list[dict] = []

    # ── SARIMA ────────────────────────────────────────────────────────────
    try:
        from statsmodels.tsa.statespace.sarimax import SARIMAX
        with warnings.catch_warnings():
            warnings.simplefilter("ignore")
            m = SARIMAX(tv_sc, order=(1,1,1), seasonal_order=(0,0,0,0)).fit(disp=False, maxiter=100)
            test_pred  = inv(m.forecast(steps=n_test))
            fcast_vals = inv(m.forecast(steps=n_fcast))
            mase_val   = _mase(vals[n_train:], test_pred)
        results.append({"model": "SARIMA", "mase": mase_val, "forecast": fcast_vals.tolist(),
                        "ci_lower": (fcast_vals * 0.9).tolist(), "ci_upper": (fcast_vals * 1.1).tolist()})
    except Exception:
        pass

    # ── Holt-Winters ──────────────────────────────────────────────────────
    try:
        from statsmodels.tsa.holtwinters import ExponentialSmoothing as ES
        with warnings.catch_warnings():
            warnings.simplefilter("ignore")
            m = ES(tv_sc, trend="add", initialization_method="estimated").fit(optimized=True)
            test_pred  = inv(m.forecast(n_test))
            fcast_vals = inv(m.forecast(n_fcast))
            mase_val   = _mase(vals[n_train:], test_pred)
        results.append({"model": "Holt-Winters", "mase": mase_val, "forecast": fcast_vals.tolist(),
                        "ci_lower": (fcast_vals * 0.9).tolist(), "ci_upper": (fcast_vals * 1.1).tolist()})
    except Exception:
        pass

    # ── Holt Linear ───────────────────────────────────────────────────────
    try:
        from statsmodels.tsa.holtwinters import Holt
        with warnings.catch_warnings():
            warnings.simplefilter("ignore")
            m = Holt(tv_sc, initialization_method="estimated").fit(optimized=True)
            test_pred  = inv(m.forecast(n_test))
            fcast_vals = inv(m.forecast(n_fcast))
            mase_val   = _mase(vals[n_train:], test_pred)
        results.append({"model": "Holt Linear", "mase": mase_val, "forecast": fcast_vals.tolist(),
                        "ci_lower": (fcast_vals * 0.9).tolist(), "ci_upper": (fcast_vals * 1.1).tolist()})
    except Exception:
        pass

    # ── Simple Exp Smoothing ──────────────────────────────────────────────
    try:
        from statsmodels.tsa.holtwinters import SimpleExpSmoothing
        with warnings.catch_warnings():
            warnings.simplefilter("ignore")
            m = SimpleExpSmoothing(tv_sc, initialization_method="estimated").fit(optimized=True)
            test_pred  = inv(m.forecast(n_test))
            fcast_vals = inv(m.forecast(n_fcast))
            mase_val   = _mase(vals[n_train:], test_pred)
        results.append({"model": "Exp Smoothing", "mase": mase_val, "forecast": fcast_vals.tolist(),
                        "ci_lower": (fcast_vals * 0.9).tolist(), "ci_upper": (fcast_vals * 1.1).tolist()})
    except Exception:
        pass

    # ── Ridge with lags ───────────────────────────────────────────────────
    try:
        from sklearn.linear_model import Ridge
        LAG = min(3, n_train - 1)
        def _lags(a, l):
            rows = [a[i:i+l] for i in range(len(a)-l)]
            return np.array(rows), a[l:]
        Xtr, ytr = _lags(tv_sc, LAG)
        Xte, _   = _lags(vv_sc[:n_train+n_test], LAG)
        m = Ridge(alpha=1.0).fit(Xtr, ytr)
        test_pred  = inv(m.predict(Xte[-n_test:]))
        last_w     = vv_sc[-(LAG):].tolist()
        fvals = []
        for _ in range(n_fcast):
            p = m.predict(np.array(last_w[-LAG:]).reshape(1, -1))[0]
            fvals.append(float(p)); last_w.append(float(p))
        fcast_vals = inv(np.array(fvals))
        mase_val   = _mase(vals[n_train:], test_pred)
        results.append({"model": "Ridge Lags", "mase": mase_val, "forecast": fcast_vals.tolist(),
                        "ci_lower": (fcast_vals * 0.9).tolist(), "ci_upper": (fcast_vals * 1.1).tolist()})
    except Exception:
        pass

    # ── Gradient Boosting ─────────────────────────────────────────────────
    try:
        from sklearn.ensemble import GradientBoostingRegressor
        LAG = min(3, n_train - 1)
        Xtr, ytr = _lags(tv_sc, LAG)
        m = GradientBoostingRegressor(n_estimators=200, max_depth=3, random_state=42).fit(Xtr, ytr)
        test_pred  = inv(m.predict(Xte[-n_test:]))
        last_w     = vv_sc[-(LAG):].tolist()
        fvals = []
        for _ in range(n_fcast):
            p = m.predict(np.array(last_w[-LAG:]).reshape(1, -1))[0]
            fvals.append(float(p)); last_w.append(float(p))
        fcast_vals = inv(np.array(fvals))
        mase_val   = _mase(vals[n_train:], test_pred)
        results.append({"model": "Gradient Boost", "mase": mase_val, "forecast": fcast_vals.tolist(),
                        "ci_lower": (fcast_vals * 0.9).tolist(), "ci_upper": (fcast_vals * 1.1).tolist()})
    except Exception:
        pass

    # ── Prophet ───────────────────────────────────────────────────────────
    try:
        from prophet import Prophet
        ph_df = ts[["ds", "Net_PPV"]].rename(columns={"Net_PPV": "y"})
        if scaler is not None:
            ph_df["y"] = scaler.transform(ph_df["y"].values.reshape(-1,1)).ravel()
        m    = Prophet(yearly_seasonality=False, weekly_seasonality=False, daily_seasonality=False)
        m.fit(ph_df.iloc[:n_train])
        fut  = m.make_future_dataframe(periods=n_fcast, freq="MS")
        fc   = m.predict(fut)
        test_pred  = inv(fc["yhat"].values[n_train:n_train+n_test])
        fcast_vals = inv(fc["yhat"].values[-n_fcast:])
        ci_lo = inv(fc["yhat_lower"].values[-n_fcast:])
        ci_hi = inv(fc["yhat_upper"].values[-n_fcast:])
        mase_val = _mase(vals[n_train:], test_pred)
        results.append({"model": "Prophet", "mase": mase_val, "forecast": fcast_vals.tolist(),
                        "ci_lower": ci_lo.tolist(), "ci_upper": ci_hi.tolist()})
    except Exception:
        pass

    results.sort(key=lambda x: x["mase"])

    return {
        "available":    True,
        "historical":   {"labels": ts["Month"].tolist(), "values": vals.tolist()},
        "future_labels": future_lbls,
        "models":       results[:5],
        "best_model":   results[0]["model"] if results else None,
        "n_train":      n_train,
        "n_test":       n_test,
    }


# ─── Tab 8 — Search ──────────────────────────────────────────────────────────

def search_material(df: pd.DataFrame, ppv_col: str, price_col: str, query: str) -> dict:
    MAT = "Material_Number"
    DESC = "Material_Description"
    if MAT not in df.columns:
        return {"found": False}
    q = query.strip()
    if DESC in df.columns:
        mask = (
            df[MAT].str.contains(q, case=False, na=False, regex=False)
            | df[DESC].str.contains(q, case=False, na=False, regex=False)
        )
    else:
        mask = df[MAT].str.contains(q, case=False, na=False, regex=False)
    df_s = df[mask].copy()
    if df_s.empty:
        return {"found": False, "query": q}

    found_mats = df_s[MAT].unique().tolist()
    kpis = {
        "records":     int(len(df_s)),
        "total":       _safe_float(df_s[ppv_col].sum()),
        "average":     _safe_float(df_s[ppv_col].mean()),
        "unfavorable": _safe_float(df_s.loc[df_s[ppv_col] > 0, ppv_col].sum()),
        "favorable":   _safe_float(df_s.loc[df_s[ppv_col] <= 0, ppv_col].sum()),
    }

    # trend
    trend: dict = {}
    if "YearMonth" in df_s.columns:
        ts = df_s[df_s["YearMonth"] != ""].groupby("YearMonth")[ppv_col].sum().reset_index().sort_values("YearMonth")
        trend = {"labels": ts["YearMonth"].tolist(), "values": [_safe_float(v) for v in ts[ppv_col]]}

    # by vendor
    by_vendor: list = []
    if "Vendor_Name" in df_s.columns:
        vd = df_s.groupby("Vendor_Name").agg(total=(ppv_col, "sum"), records=(ppv_col, "count")).reset_index()
        vd = vd.sort_values("total", ascending=True)
        by_vendor = _to_records(vd)

    # ANOVA across vendors
    anova: dict = {}
    if "Vendor_Name" in df_s.columns and ppv_col in df_s.columns:
        try:
            from scipy import stats as _st
            groups = [
                g[ppv_col].values for _, g in df_s.groupby("Vendor_Name")
                if len(g) >= 3
            ]
            if len(groups) >= 2:
                fstat, pval = _st.f_oneway(*groups)
                anova = {
                    "f_stat": _safe_float(fstat),
                    "p_value": _safe_float(pval),
                    "significant": bool(pval < 0.05),
                    "n_groups": len(groups),
                }
        except Exception:
            pass

    # histogram bins
    hist_vals = df_s[ppv_col].dropna().values.astype(float)
    if len(hist_vals) >= 4:
        counts, edges = np.histogram(hist_vals, bins=min(30, max(5, len(hist_vals) // 10)))
        histogram = {
            "counts": counts.tolist(),
            "edges":  edges.tolist(),
        }
    else:
        histogram = {}

    # price diff outliers per vendor
    price_outliers: dict[str, list] = {}
    if price_col and price_col in df_s.columns and "Vendor_Name" in df_s.columns:
        for vname, vdf in df_s.groupby("Vendor_Name"):
            vals = vdf[price_col].values.astype(float)
            if len(vals) >= 4:
                mask, _ = _best_outlier_model(vals)
                price_outliers[str(vname)] = mask.tolist()

    # violin data (per vendor)
    violin: dict[str, dict] = {}
    if "Vendor_Name" in df_s.columns:
        for vname, vdf in df_s.groupby("Vendor_Name"):
            vals = vdf[ppv_col].dropna().values.astype(float)
            if len(vals) >= 2:
                violin[str(vname)] = {
                    "values": vals.tolist(),
                    **_box_stats(vals),
                }

    return {
        "found":        True,
        "query":        q,
        "found_mats":   found_mats,
        "kpis":         kpis,
        "trend":        trend,
        "by_vendor":    by_vendor,
        "anova":        anova,
        "histogram":    histogram,
        "violin":       violin,
        "price_outliers": price_outliers,
    }


# ─── Compute ALL analytics at once ───────────────────────────────────────────

def compute_all_analytics(df: pd.DataFrame, ppv_col: str, price_col: str = "", fx_col: str = "") -> dict:
    """Run all 9 analytics tabs in parallel threads (independent computations)."""
    _tasks = {
        "kpis":            (compute_kpis,              (df, ppv_col)),
        "trend":           (compute_trend,             (df, ppv_col)),
        "material_groups": (compute_material_groups,   (df, ppv_col)),
        "vendors":         (compute_vendors,           (df, ppv_col)),
        "materials":       (compute_materials,         (df, ppv_col, price_col)),
        "hierarchy":       (compute_hierarchy,         (df, ppv_col)),
        "distribution":    (compute_distribution,      (df, ppv_col)),
        "impact_scatter":  (compute_impact_scatter,    (df, ppv_col)),
        "correlation":     (compute_correlation_matrix,(df,)),
    }
    results: dict = {}
    workers = min(len(_tasks), (os.cpu_count() or 4))
    with ThreadPoolExecutor(max_workers=workers) as pool:
        futures = {pool.submit(fn, *args): key for key, (fn, args) in _tasks.items()}
        for fut in as_completed(futures):
            key = futures[fut]
            try:
                results[key] = fut.result()
            except Exception as exc:
                import traceback
                results[key] = {"_error": traceback.format_exc()}
    return results
