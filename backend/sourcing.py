"""
backend/sourcing.py
Best Purchase Option — integrates EMS InternalQuery (SAP pricing) and Nexar (market pricing)
to find the cheapest purchase source for a given SAP internal material number (BMATN).

Ported from: conexion_internalquery/app.py
"""
from __future__ import annotations

import os
import warnings
from typing import Any, Dict, List, Optional

import requests
from requests_ntlm import HttpNtlmAuth

try:
    from dotenv import load_dotenv
    load_dotenv()
except ImportError:
    pass

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field
from config import PRICECALC_API_URL

warnings.filterwarnings("ignore")

# ── Configuration ──────────────────────────────────────────────────────────────────────

_SAP_BASE    = os.getenv("SAP_GENERAL_API_BASE_URL", "http://nts5102/SapGeneralApi")
SAP_AMPL_URL   = f"{_SAP_BASE}/api/Ampl/FetchAmplByMaterials"



# ── SAP AMPL ───────────────────────────────────────────────────────────────────

def _fetch_ampl(bmatn: str) -> List[Dict[str, Any]]:
    """Fetch MPNs for an internal material number from SAP AMPL. Uses Windows SSPI auth."""
    payload = {
        "InternalPartNumbers": [
            {"BMATN": bmatn.strip().upper(), "I": "Include", "fieldname": "string"}
        ]
    }
    try:
        resp = requests.post(SAP_AMPL_URL, json=payload, auth=HttpNtlmAuth("", ""), timeout=30)
        if resp.status_code == 404:
            return []
        resp.raise_for_status()
        return resp.json()
    except requests.exceptions.Timeout:
        raise HTTPException(status_code=504, detail="Timeout consultando SAP AMPL.")
    except HTTPException:
        raise
    except requests.exceptions.RequestException as e:
        raise HTTPException(status_code=502, detail=f"Error consultando SAP AMPL: {e}")


def _extract_active_mpns(items: List[Dict[str, Any]]) -> List[str]:
    """Return active (non-deleted, non-blocked) MPNs sorted by frequency."""
    counts: Dict[str, int] = {}
    for item in items:
        mpn      = (item.get("MfgPartNumber") or "").strip()
        deleted  = bool((item.get("Deleted")  or "").strip())
        blocked  = bool((item.get("Blocked")  or "").strip())
        if mpn and not deleted and not blocked:
            counts[mpn] = counts.get(mpn, 0) + 1
    return [m for m, _ in sorted(counts.items(), key=lambda x: -x[1])]


def _extract_all_mpns(items: List[Dict[str, Any]]) -> List[str]:
    """Return ALL MPNs (including blocked/deleted) sorted by frequency. Used for pricing queries."""
    counts: Dict[str, int] = {}
    for item in items:
        mpn = (item.get("MfgPartNumber") or "").strip()
        if mpn:
            counts[mpn] = counts.get(mpn, 0) + 1
    return [m for m, _ in sorted(counts.items(), key=lambda x: -x[1])]


# ── EMS InternalQuery ──────────────────────────────────────────────────────────

def _query_ems_iq(mpns: List[str]) -> List[Dict[str, Any]]:
    """Query EMS InternalQuery via the conexion_internalquery proxy (same auth used by Price Calculator)."""
    if not mpns:
        return []
    try:
        resp = requests.post(
            f"{PRICECALC_API_URL}/internal-query",
            json={"mpns": mpns},
            timeout=30,
        )
        if resp.status_code in (401, 403, 404, 502, 503):
            return []  # Proxy unavailable or auth failed — graceful degradation
        resp.raise_for_status()
        data = resp.json()
        return data if isinstance(data, list) else data.get("data", [])
    except requests.exceptions.RequestException:
        return []


def _best_sap_option(rows: List[Dict[str, Any]]) -> Optional[Dict[str, Any]]:
    """Return the row with the lowest resolved last-PO price in USD (standard price as fallback)."""
    valid = []
    for r in rows:
        price = r.get("lastPoPriceUsd")
        if price is None:
            raw = r.get("rawLastPoPrice")
            per = r.get("rawLastPoPer") or 1
            fx  = r.get("localCurrencyExchangeRateUsd") or 1
            if raw is not None and per:
                price = (raw / per) * fx
        # Fall back to standard price when no last-PO price is available
        if price is None or float(price) <= 0:
            std = r.get("standardPriceUsd")
            if std is not None and float(std) > 0:
                price = float(std)
        if price is not None and float(price) > 0:
            valid.append({**r, "_price": float(price)})
    if not valid:
        return None
    best = min(valid, key=lambda x: x["_price"])
    return {
        "site":            best.get("siteName", ""),
        "supplier":        best.get("supplierName", ""),
        "supplier_number": best.get("supplierNumber", ""),
        "unit_price_usd":  round(best["_price"], 6),
        "last_po_date":    best.get("lastPoDate", ""),
        "mpn":             best.get("mpn", ""),
        "currency":        best.get("localCurrency", "USD"),
    }


def _all_sap_options(rows: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    """Return all valid SAP rows enriched with resolved USD price, sorted ascending."""
    result = []
    for r in rows:
        price = r.get("lastPoPriceUsd")
        if price is None:
            raw = r.get("rawLastPoPrice")
            per = r.get("rawLastPoPer") or 1
            fx  = r.get("localCurrencyExchangeRateUsd") or 1
            if raw is not None and per:
                price = (raw / per) * fx
        # Fall back to standard price when no last-PO price is available
        if price is None or float(price) <= 0:
            std_fallback = r.get("standardPriceUsd")
            if std_fallback is not None and float(std_fallback) > 0:
                price = float(std_fallback)
        if price is not None and float(price) > 0:
            std = r.get("standardPriceUsd")
            result.append({
                "site":            r.get("siteName", ""),
                "mpn":             r.get("mpn", ""),
                "manufacturer":    r.get("manufacturerName", ""),
                "supplier":        r.get("supplierName", ""),
                "supplier_number": r.get("supplierNumber", ""),
                "last_po_usd":     round(float(price), 6),
                "standard_usd":    round(float(std), 6) if std is not None else None,
                "currency":        r.get("localCurrency", "USD"),
                "last_po_date":    r.get("lastPoDate", ""),
            })
    return sorted(result, key=lambda x: x["last_po_usd"])


# ── Market prices (via conexion_internalquery proxy) ──────────────────────────

def _fetch_market_options(mpns: List[str], quantity: int):
    """Return (best_offer, all_in_stock_sorted) from Nexar via conexion_internalquery proxy."""
    if not mpns:
        return None, []
    try:
        resp = requests.post(
            f"{PRICECALC_API_URL}/market-prices",
            json={"mpns": mpns, "quantity": quantity},
            timeout=30,
        )
        if resp.status_code in (401, 403, 404, 502, 503):
            return None, []
        resp.raise_for_status()
        data = resp.json()
        raw_offers = data.get("offers", []) if isinstance(data, dict) else []
    except requests.exceptions.RequestException:
        return None, []

    candidates: List[Dict[str, Any]] = []
    for o in raw_offers:
        unit      = o.get("unit_price_usd")
        inventory = o.get("inventory", 0)
        moq       = o.get("moq") or 1
        if unit is None or inventory <= 0:
            continue
        effective_qty = max(quantity, moq)
        requires_moq  = moq > quantity
        candidates.append({
            "mpn":             o.get("mpn", ""),
            "manufacturer":    o.get("manufacturer", ""),
            "description":     o.get("description", ""),
            "seller":          o.get("seller", ""),
            "unit_price_usd":  round(float(unit), 6),
            "total_price_usd": round(float(unit) * effective_qty, 2),
            "inventory":       inventory,
            "moq":             moq,
            "effective_qty":   effective_qty,
            "requires_moq":    requires_moq,
            "can_fulfill":     o.get("can_fulfill", inventory >= effective_qty),
            "packaging":       o.get("packaging", ""),
            "click_url":       o.get("click_url", ""),
        })

    if not candidates:
        return None, []
    sorted_c = sorted(candidates, key=lambda x: x["unit_price_usd"])
    # Best = cheapest offer where MOQ ≤ requested quantity AND has sufficient stock
    fulfillable = [c for c in sorted_c if not c["requires_moq"] and c["can_fulfill"]]
    best = fulfillable[0] if fulfillable else None
    return best, sorted_c


# ── FastAPI Router ─────────────────────────────────────────────────────────────

router = APIRouter(prefix="/api/sourcing", tags=["sourcing"])


class SourcingRequest(BaseModel):
    material: str = Field(..., description="SAP internal material number (BMATN)")
    quantity: int = Field(1, ge=1, description="Quantity to price")


@router.post("")
def get_best_source(req: SourcingRequest):
    """
    Given a SAP internal material number (BMATN) and a quantity, returns:
    - sap: best option from SAP last-PO data via EMS InternalQuery
    - market: best offer from Nexar market
    - recommendation: 'SAP' | 'Market' | 'No data'
    - diff_pct: market vs SAP price difference (negative = market cheaper)
    """
    bmatn = req.material.strip().upper()

    # Step 1 — Resolve MPNs from SAP AMPL
    ampl_items  = _fetch_ampl(bmatn)
    active_mpns = _extract_active_mpns(ampl_items)
    all_mpns    = _extract_all_mpns(ampl_items)   # includes blocked/deleted — for pricing queries
    if not all_mpns:
        return {
            "sap": None, "sap_all": [], "market": None, "market_all": [],
            "recommendation": "No data", "diff_pct": None, "mpns": [],
        }
    # Use all MPNs for pricing queries (same as Price Calculator); report active ones in the response
    query_mpns = all_mpns

    # Step 2 — SAP pricing via EMS InternalQuery (proxied through conexion_internalquery)
    iq_rows  = _query_ems_iq(query_mpns)
    sap_best = _best_sap_option(iq_rows)

    # Step 3 — Market pricing via Nexar
    mkt_best, mkt_all = _fetch_market_options(query_mpns, req.quantity)
    sap_all           = _all_sap_options(iq_rows)

    # Step 4 — Recommendation
    diff_pct: Optional[float] = None
    if sap_best and mkt_best:
        sap_p    = sap_best["unit_price_usd"]
        mkt_p    = mkt_best["unit_price_usd"]
        diff_pct = round((mkt_p - sap_p) / sap_p * 100, 1) if sap_p > 0 else None
        # Recommend market if it's cheaper than SAP (any price improvement counts)
        recommendation = "Market" if (diff_pct is not None and diff_pct < 0) else "SAP"
    elif sap_best:
        recommendation = "SAP"
    elif mkt_best:
        recommendation = "Market"
    else:
        recommendation = "No data"

    return {
        "sap":            sap_best,
        "sap_all":        sap_all,
        "market":         mkt_best,
        "market_all":     mkt_all[:10],
        "recommendation": recommendation,
        "diff_pct":       diff_pct,
        "mpns":           active_mpns or all_mpns,
    }
