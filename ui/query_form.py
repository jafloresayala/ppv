"""
ui/query_form.py
Query form (plant + dates) and SAP API call.
Stores result in st.session_state["ppv_df"] and st.session_state["ppv_params"].
"""

import requests
import streamlit as st
from datetime import date, timedelta
from requests_ntlm import HttpNtlmAuth

from config import API_URL
from sap_utils import _extract_records, _parse_df


def render_query_form() -> None:
    """Render the search form and trigger the API call when submitted."""
    with st.form("ppv_form"):
        c1, c2, c3, c_btn = st.columns([0.8, 1, 1, 0.7])
        with c1:
            st.markdown("**Plant**")
            plant = st.text_input(
                " ", value="0020", label_visibility="collapsed", placeholder="0020"
            )
        with c2:
            st.markdown("**Posting Start Date**")
            start_date = st.date_input(
                " ", value=date.today() - timedelta(days=7),
                label_visibility="collapsed", key="ppv_start",
            )
        with c3:
            st.markdown("**Posting End Date**")
            end_date = st.date_input(
                " ", value=date.today(),
                label_visibility="collapsed", key="ppv_end",
            )
        with c_btn:
            st.markdown("&nbsp;", unsafe_allow_html=True)
            submitted = st.form_submit_button(
                "Query", use_container_width=True, type="primary"
            )

    if not submitted:
        return

    if not plant.strip():
        st.warning("Enter a plant.")
        st.stop()
    if start_date > end_date:
        st.warning("Start date cannot be greater than end date.")
        st.stop()

    payload = {
        "Plant": plant.strip(),
        "PostingStartDate": start_date.strftime("%Y%m%d"),
        "PostingEndDate": end_date.strftime("%Y%m%d"),
    }

    with st.spinner("Querying API..."):
        try:
            auth = HttpNtlmAuth("", "")
            resp = requests.post(API_URL, json=payload, auth=auth, timeout=90)
            resp.raise_for_status()
            raw = resp.json()
        except requests.exceptions.ConnectionError:
            st.error("Cannot connect to nts5102. Check network / VPN.")
            st.stop()
        except requests.exceptions.Timeout:
            st.error("Timeout (90s). API took too long.")
            st.stop()
        except requests.exceptions.HTTPError as exc:
            st.error(f"Error HTTP {exc.response.status_code}: {exc.response.text[:400]}")
            st.stop()
        except Exception as exc:
            st.error(f"Unexpected error: {exc}")
            st.stop()

    records = _extract_records(raw)
    if not records:
        st.info("API responded successfully but returned no records.")
        st.stop()

    st.session_state["ppv_df"]     = _parse_df(records)
    st.session_state["ppv_params"] = payload
