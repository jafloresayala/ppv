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

# ── Daily MPN pre-compute job (SQLite best-price cache) ─────────────────────
import os as _os

_BACKEND_DIR = _os.path.dirname(_os.path.abspath(__file__))
_PROJECT_DIR = _os.path.dirname(_BACKEND_DIR)

# Folder holding the source .xlsx with MPNs (latest file is used)
DBQUERY_DIR = _os.getenv("DBQUERY_DIR", _os.path.join(_PROJECT_DIR, "dbquery"))
# Folder where job .log files are written
LOGS_DIR    = _os.getenv("LOGS_DIR",    _os.path.join(_PROJECT_DIR, "logs"))
# SQLite database file (best price per MPN + job history)
MPN_DB_PATH = _os.getenv("MPN_DB_PATH", _os.path.join(_BACKEND_DIR, "data", "mpn_cache.db"))

# Source-file column names
DBQUERY_MPN_COL = _os.getenv("DBQUERY_MPN_COL", "Manufacturer Part No.")
DBQUERY_EAU_COL = _os.getenv("DBQUERY_EAU_COL", "Total EAU")

# Best-price look-back window (days) used by the batch job
DBJOB_WINDOW_DAYS = int(_os.getenv("DBJOB_WINDOW_DAYS", "45"))
# Hour of day (local) the job is expected to have run by; UI turns yellow if overdue
DBJOB_SCHEDULE_HOUR = int(_os.getenv("DBJOB_SCHEDULE_HOUR", "6"))
# Parallel workers for the batch job
DBJOB_MAX_WORKERS = int(_os.getenv("DBJOB_MAX_WORKERS", "8"))

# Admin dashboard credentials (override via env in production)
ADMIN_USERNAME = _os.getenv("ADMIN_USERNAME", "admin")
ADMIN_PASSWORD = _os.getenv("ADMIN_PASSWORD", "admin123")

# ── Azure AI Inference ────────────────────────────────────────────────────────
AZ_INF_ENDPOINT = "https://k90016277-aippv-resource.services.ai.azure.com/models"
AZ_INF_API_KEY  = "1quEgPspq8NjEo4zm8STsskX1RwSOc6Yzaiwh0LO8Rl8pnkAjS79JQQJ99CDACHYHv6XJ3w3AAAAACOGCMKx"
AZ_INF_API_VER  = "2024-05-01-preview"
AZ_INF_MODEL    = "Kimi-K2.6"

# ── CORS origins (add prod domain if ever deployed) ──────────────────────────
ALLOWED_ORIGINS = ["http://localhost:5173", "http://localhost:4173", "http://localhost:3000", "http://localhost:8080"]
