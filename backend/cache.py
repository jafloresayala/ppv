"""
backend/cache.py — Redis caching layer with graceful in-memory fallback.

Cache hierarchy
───────────────
  ppv:sap:{plant}:{start}:{end}                         → raw SAP records (pickle)  2 h
  ppv:sap:master:{plant}                                 → master DataFrame (pickle) 8 h
  ppv:sap:master:{plant}:meta                            → {start, end}    (JSON)    8 h
  ppv:ses:{session_id}                                   → {df, params}  (pickle)    2 h
  ppv:ana:{plant}:{start}:{end}:{filter_hash}            → analytics dict (JSON)     1 h
  ppv:fore:{plant}:{start}:{end}:{filter_hash}:{scale}   → forecast dict  (JSON)     2 h
  ppv:drill:mgplant:{sid}:{fh}:{group}:{plant}         → mg-plant components (JSON) 2 h
  ppv:drill:hdrll:{sid}:{fh}:{hier}:{ym}:{n}          → hierarchy drill     (JSON) 2 h
  ppv:drill:mattrend:{sid}:{fh}:{material}             → material trend      (JSON) 2 h
  ppv:drill:vndtrend:{sid}:{fh}:{material}             → vendor price trend  (JSON) 2 h
  ppv:drill:vndmon:{sid}:{vendor_hash}:{yearmonth}     → vendor month records (JSON) 2 h
  ppv:drill:mgsap:{plant}:{mats_hash}                  → mg-sap batch result (JSON) 1 h

If Redis is unreachable the app falls back to an in-memory dict (same behaviour
as before) — no errors, no configuration required.
"""

import hashlib
import json
import logging
import os
import pickle
from typing import Any

logger = logging.getLogger(__name__)

# ── Redis client (optional) ───────────────────────────────────────────────────
try:
    import redis as _redis_lib

    _client: "_redis_lib.Redis | None" = _redis_lib.Redis(
        host=os.getenv("REDIS_HOST", "localhost"),
        port=int(os.getenv("REDIS_PORT", "6379")),
        password=os.getenv("REDIS_PASSWORD") or None,
        db=int(os.getenv("REDIS_DB", "0")),
        decode_responses=False,
        socket_connect_timeout=2,
        socket_timeout=2,
    )
    _client.ping()
    _redis_ok = True
    logger.info(
        "✅ Redis connected at %s:%s",
        os.getenv("REDIS_HOST", "localhost"),
        os.getenv("REDIS_PORT", "6379"),
    )
except Exception as _exc:
    _client = None
    _redis_ok = False
    logger.warning(
        "⚠️  Redis unavailable — using in-memory fallback. (%s)", _exc
    )

# ── TTL constants (overridable via env vars) ──────────────────────────────────
TTL_SAP      = int(os.getenv("CACHE_TTL_SAP",       str(2 * 3600)))  # 2 h
TTL_SESSION  = int(os.getenv("CACHE_TTL_SESSION",    str(2 * 3600)))  # 2 h
TTL_ANALYTIC = int(os.getenv("CACHE_TTL_ANALYTICS",  str(1 * 3600)))  # 1 h
TTL_FORECAST = int(os.getenv("CACHE_TTL_FORECAST",   str(2 * 3600)))  # 2 h
TTL_MASTER   = int(os.getenv("CACHE_TTL_MASTER",     str(8 * 3600)))  # 8 h — plant master dataset
TTL_DRILL    = int(os.getenv("CACHE_TTL_DRILL",       str(2 * 3600)))  # 2 h — floating-window drill-downs (matches session lifetime)
TTL_NEXAR    = int(os.getenv("CACHE_TTL_NEXAR",      str(24 * 3600))) # 24 h — Nexar market-prices cache

# ── In-memory fallback (same TTL is ignored — data lives for process lifetime) 
_fallback: dict[str, bytes] = {}


# ── Key helpers ───────────────────────────────────────────────────────────────

def make_key(*parts: str) -> str:
    """Build a namespaced Redis key."""
    return "ppv:" + ":".join(str(p) for p in parts)


def filter_hash(filters: dict) -> str:
    """Return a stable 16-char hex hash of a filter dict."""
    canonical = json.dumps(filters, sort_keys=True, ensure_ascii=True)
    return hashlib.sha1(canonical.encode()).hexdigest()[:16]


# ── Low-level byte-level get / set ────────────────────────────────────────────

def _get_raw(key: str) -> bytes | None:
    if _redis_ok and _client:
        try:
            return _client.get(key)      # type: ignore[return-value]
        except Exception as exc:
            logger.debug("Redis GET error: %s", exc)
    return _fallback.get(key)


def _set_raw(key: str, value: bytes, ttl: int) -> None:
    if _redis_ok and _client:
        try:
            _client.setex(key, ttl, value)
            return
        except Exception as exc:
            logger.debug("Redis SET error: %s", exc)
    # Fallback — store in-memory (no TTL enforcement)
    _fallback[key] = value


def delete(key: str) -> None:
    if _redis_ok and _client:
        try:
            _client.delete(key)
        except Exception:
            pass
    _fallback.pop(key, None)


# ── JSON helpers (analytics / forecast) ──────────────────────────────────────

def get_json(key: str) -> Any | None:
    raw = _get_raw(key)
    if raw is None:
        return None
    try:
        return json.loads(raw)
    except Exception:
        return None


def set_json(key: str, value: Any, ttl: int) -> None:
    try:
        _set_raw(key, json.dumps(value, default=str).encode(), ttl)
    except Exception as exc:
        logger.debug("set_json error for key %s: %s", key, exc)


def set_if_not_exists(key: str, value: Any, ttl: int) -> bool:
    """Store value only if key does not exist. Returns True if the key was set."""
    encoded = json.dumps(value, default=str).encode()
    if _redis_ok and _client:
        try:
            result = _client.set(key, encoded, ex=ttl, nx=True)  # type: ignore[call-overload]
            return result is not None
        except Exception as exc:
            logger.debug("Redis SET NX error: %s", exc)
    # In-memory fallback: only set if not already present
    if key not in _fallback:
        _fallback[key] = encoded
        return True
    return False


def count_keys_with_prefix(prefix: str) -> int:
    """Count the number of cached keys that start with `prefix`."""
    if _redis_ok and _client:
        try:
            count = 0
            cursor = 0
            while True:
                cursor, keys = _client.scan(cursor, match=f"{prefix}*", count=100)  # type: ignore[misc]
                count += len(keys)
                if cursor == 0:
                    break
            return count
        except Exception as exc:
            logger.debug("Redis SCAN error: %s", exc)
    return sum(1 for k in _fallback if k.startswith(prefix))

def get_pickle(key: str) -> Any | None:
    raw = _get_raw(key)
    if raw is None:
        return None
    try:
        return pickle.loads(raw)
    except Exception:
        return None


def set_pickle(key: str, value: Any, ttl: int) -> None:
    try:
        _set_raw(
            key,
            pickle.dumps(value, protocol=pickle.HIGHEST_PROTOCOL),
            ttl,
        )
    except Exception as exc:
        logger.debug("set_pickle error for key %s: %s", key, exc)


# ── Public status ─────────────────────────────────────────────────────────────

def redis_available() -> bool:
    return _redis_ok


# ── Master dataset — range-aware plant cache ──────────────────────────────────
# Stores the largest date range ever fetched per plant as a parsed DataFrame.
# Subset queries are served by filtering this DataFrame (zero SAP calls).
# Queries that extend the range only fetch the delta from SAP.

def get_master(plant: str):
    """Return (start_yyyymmdd, end_yyyymmdd, DataFrame) or None if not cached."""
    meta = get_json(make_key("sap", "master", plant, "meta"))
    if meta is None:
        return None
    df = get_pickle(make_key("sap", "master", plant))
    if df is None:
        return None  # data key expired while meta key hadn't — treat as miss
    return meta["start"], meta["end"], df


def set_master(plant: str, start: str, end: str, df: Any) -> None:
    """Persist the plant's master DataFrame and its date range."""
    set_pickle(make_key("sap", "master", plant), df, TTL_MASTER)
    set_json(
        make_key("sap", "master", plant, "meta"),
        {"start": start, "end": end},
        TTL_MASTER,
    )
