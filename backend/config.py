"""backend/config.py — environment-level constants."""

# ── SAP API ──────────────────────────────────────────────────────────────────
SAP_API_URL = "http://nts5102/SapGeneralApi/api/Financials/PPV"

# ── Column aliases (must match _parse_df output) ─────────────────────────────
COL_PPV   = "PPDifference_currency"
COL_PRICE = "PPDifference_currency"
COL_FX    = "Exchange_rate_difference_num"
# ── Redis cache (env vars override, see cache.py) ──────────────────────────
# REDIS_HOST        = localhost  (env var, default shown)
# REDIS_PORT        = 6379
# REDIS_PASSWORD    = (none)
# REDIS_DB          = 0
# CACHE_TTL_SAP     = 7200   (2 h  — raw SAP records)
# CACHE_TTL_SESSION = 7200   (2 h  — parsed DataFrame)
# CACHE_TTL_ANALYTICS = 3600 (1 h  — computed analytics)
# CACHE_TTL_FORECAST  = 7200 (2 h  — forecast models)
# ── Price Calculator proxy (conexion_internalquery backend) ─────────────────
PRICECALC_API_URL = "http://localhost:8081"

# ── Azure AI Inference ────────────────────────────────────────────────────────
AZ_INF_ENDPOINT = "https://k90016277-aippv-resource.services.ai.azure.com/models"
AZ_INF_API_KEY  = "1quEgPspq8NjEo4zm8STsskX1RwSOc6Yzaiwh0LO8Rl8pnkAjS79JQQJ99CDACHYHv6XJ3w3AAAAACOGCMKx"
AZ_INF_API_VER  = "2024-05-01-preview"
AZ_INF_MODEL    = "Kimi-K2.6"

# ── CORS origins (add prod domain if ever deployed) ──────────────────────────
ALLOWED_ORIGINS = ["http://localhost:5173", "http://localhost:4173", "http://localhost:3000", "http://localhost:8080"]
