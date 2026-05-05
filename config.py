"""
config.py
Global constants: API URL, corporate colors, column name aliases, Azure AI credentials.
"""

# ─── SAP API ──────────────────────────────────────────────────────────────────
API_URL = "http://nts5102/SapGeneralApi/api/Financials/PPV"

# ─── Corporate colors ─────────────────────────────────────────────────────────
COLOR_GOOD    = "#16a34a"
COLOR_BAD     = "#dc2626"
COLOR_NEUTRAL = "#3b82f6"

# ─── Column name aliases (after _parse_df) ────────────────────────────────────
COL_PPV   = "Total_Variance_Amount_num"
COL_PRICE = "P_Price_difference_num"
COL_FX    = "Exchange_rate_difference_num"

# ─── Azure AI Inference ───────────────────────────────────────────────────────
AZ_INF_ENDPOINT = "https://k90016277-aippv-resource.services.ai.azure.com/models"
AZ_INF_API_KEY  = "1quEgPspq8NjEo4zm8STsskX1RwSOc6Yzaiwh0LO8Rl8pnkAjS79JQQJ99CDACHYHv6XJ3w3AAAAACOGCMKx"
AZ_INF_API_VER  = "2024-05-01-preview"
AZ_INF_MODEL    = "Kimi-K2.6"
