"""
ui/styles.py
Global CSS injected once via st.markdown in ppv.py.
"""

APP_CSS = """
<style>
    .stApp { background: #f0f4f9; }
    .block-container { padding-top: 3.5rem; padding-bottom: 2rem; max-width: 1400px; }
    div[data-testid="stMetric"] {
        background: #fff;
        border: 1px solid #dde5f0;
        border-radius: 14px;
        padding: 0.85rem 1.1rem;
        box-shadow: 0 4px 14px rgba(0,0,0,0.05);
    }
    div[data-testid="stMetricValue"] { font-size: 1.6rem !important; }
    div[data-testid="stMetricLabel"] { font-size: 0.8rem !important; color: #667; }
    .section-title {
        font-size: 1.05rem;
        font-weight: 700;
        color: #1a2a44;
        margin: 1.2rem 0 0.4rem 0;
        padding-bottom: 0.25rem;
        border-bottom: 2px solid #dde5f0;
    }
    [data-testid="stTabs"] button { font-size: 0.9rem; font-weight: 600; }
</style>
"""
