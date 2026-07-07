"""
config.py
Global constants: API URL, corporate colors, column name aliases, Azure AI credentials.
"""

# ─── SAP API ──────────────────────────────────────────────────────────────────
API_URL     = "http://nts5102/SapGeneralApi/api/Financials/PPV"
SAP_API_URL = API_URL   # alias used by backend/main.py

# ─── CORS ─────────────────────────────────────────────────────────────────────
ALLOWED_ORIGINS = ["http://localhost:5173", "http://localhost:4173", "http://localhost:8080"]

# ─── Corporate colors ─────────────────────────────────────────────────────────
COLOR_GOOD    = "#16a34a"
COLOR_BAD     = "#dc2626"
COLOR_NEUTRAL = "#3b82f6"

# ─── Column name aliases (after _parse_df) ────────────────────────────────────
COL_PPV   = "Total_Variance_Amount_num"
COL_PRICE = "P_Price_difference_num"
COL_FX    = "Exchange_rate_difference_num"

# ─── Price Calculator proxy (conexion_internalquery backend) ─────────────────
PRICECALC_API_URL = "http://localhost:8081"

# ─── Azure AI Inference ───────────────────────────────────────────────────────
AZ_INF_ENDPOINT = "AZ_INF_ENDPOINT"
AZ_INF_API_KEY  = "AZ_INF_API_KEY"
AZ_INF_API_VER  = "AZ_INF_API_VER"
AZ_INF_MODEL    = "AZ_INF_MODEL"
