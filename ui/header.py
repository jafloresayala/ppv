"""
ui/header.py
Logo + dashboard title row.
"""

import os
import streamlit as st


def render_header(logo_path: str) -> None:
    hdr_logo, hdr_title = st.columns([0.80, 0.92])
    with hdr_logo:
        if os.path.exists(logo_path):
            st.image(logo_path, width=1200)
        else:
            st.warning("Logo not found")
    with hdr_title:
        st.markdown("## PPV - Purchase Price Variance")
        st.caption("Corporate statistical analysis of purchase price variance.")
