"""
ppv.py — PPV Dashboard orchestrator.

All logic has been moved to:
  config.py, sap_utils.py, chart_helpers.py
  ui/styles.py, ui/header.py, ui/query_form.py, ui/sidebar.py, ui/kpis.py
  ui/tabs/tab_trend.py .. tab_ai.py
"""
import os
import streamlit as st

from config import COL_PPV, COL_PRICE, COL_FX
from ui.styles import APP_CSS
from ui.header import render_header
from ui.query_form import render_query_form
from ui.sidebar import render_sidebar
from ui.kpis import render_kpis
from ui.tabs import (
    tab_trend, tab_material_group, tab_vendors,
    tab_materials, tab_hierarchy, tab_distribution,
    tab_impact, tab_search, tab_ai,
)

st.set_page_config(
    page_title="PPV Dashboard",
    layout="wide",
    initial_sidebar_state="collapsed",
)
st.markdown(APP_CSS, unsafe_allow_html=True)

_script_dir = os.path.dirname(os.path.abspath(__file__))
_logo_path  = os.path.join(_script_dir, "img", "kim-logo.png")
render_header(_logo_path)
render_query_form()

if "ppv_df" not in st.session_state:
    st.stop()

df     = st.session_state["ppv_df"]
params = st.session_state["ppv_params"]
dff    = render_sidebar(df, params)

if dff.empty:
    st.warning("No data with current filters.")
    st.stop()

PPV   = COL_PPV
PRICE = COL_PRICE
FX    = COL_FX

render_kpis(dff, PPV)

for _k, _v in [
    ("ppv_sel_mat",        None),
    ("ppv_sel_mg_dist",    None),
    ("ppv_sel_trend_per",  None),
    ("ppv_sel_mg_tree",    None),
    ("ppv_sel_mg_trend",   None),
    ("ppv_ph_sel",         []),
]:
    if _k not in st.session_state:
        st.session_state[_k] = _v

tabs = st.tabs([
    "Time Trend",
    "Material Group",
    "Vendors",
    "Materials",
    "Product Hierarchy",
    "Distribution",
    "Impact",
    "Search",
    "🤖 AI",
])

tab_trend.render(tabs[0], dff, PPV)
tab_material_group.render(tabs[1], dff, PPV)
tab_vendors.render(tabs[2], dff, PPV)
tab_materials.render(tabs[3], dff, PPV, PRICE=PRICE, FX=FX, params=params)
tab_hierarchy.render(tabs[4], dff, PPV)
tab_distribution.render(tabs[5], dff, PPV)
tab_impact.render(tabs[6], dff, PPV, PRICE=PRICE, FX=FX, params=params)
tab_search.render(tabs[7], dff, PPV, PRICE=PRICE, FX=FX, params=params)
tab_ai.render(tabs[8], dff, PPV, params=params)
