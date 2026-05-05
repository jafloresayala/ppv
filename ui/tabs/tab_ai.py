"""
ui/tabs/tab_ai.py
Tab 9 — AI Chatbot: messenger-style chat with Azure AI Inference (Kimi-K2.6).
"""

import pandas as pd
import streamlit as st

from config import AZ_INF_ENDPOINT, AZ_INF_API_KEY, AZ_INF_API_VER, AZ_INF_MODEL

_CHAT_CSS = """
<style>
.ai-chat-wrap {
    display: flex; flex-direction: column;
    background: #f0f4f9; border-radius: 16px;
    border: 1px solid #dde5f0;
    overflow: hidden; margin-bottom: 0;
}
.ai-topbar {
    display: flex; align-items: center; gap: 12px;
    background: linear-gradient(135deg, #1a2a44 0%, #2d4a7a 100%);
    padding: 14px 20px;
}
.ai-avatar {
    width: 44px; height: 44px; border-radius: 50%;
    background: rgba(255,255,255,0.15);
    display: flex; align-items: center; justify-content: center;
    font-size: 1.3rem; flex-shrink: 0;
}
.ai-topbar-info { flex: 1; }
.ai-topbar-name { color: #fff; font-weight: 700; font-size: 0.97rem; margin: 0; }
.ai-topbar-status { color: #94c8a8; font-size: 0.72rem; margin: 0;
    display: flex; align-items: center; gap: 5px; }
.ai-online-dot {
    width: 7px; height: 7px; border-radius: 50%; background: #4ade80;
    box-shadow: 0 0 5px #4ade80;
    animation: blink-dot 2s ease-in-out infinite;
}
@keyframes blink-dot { 0%,100% { opacity:1; } 50% { opacity:.4; } }
.msg-row { display: flex; margin: 6px 18px; }
.msg-row.user  { justify-content: flex-end; }
.msg-row.bot   { justify-content: flex-start; }
.bubble {
    max-width: 72%; padding: 10px 14px; border-radius: 18px;
    font-size: 0.88rem; line-height: 1.5; word-break: break-word;
    box-shadow: 0 2px 8px rgba(0,0,0,0.07);
}
.bubble.user { background: #2563eb; color: #fff; border-bottom-right-radius: 4px; }
.bubble.bot  { background: #fff; color: #1a2a44; border: 1px solid #dde5f0; border-bottom-left-radius: 4px; }
.bubble .ts  { font-size: 0.65rem; opacity: 0.6; margin-top: 4px; text-align: right; }
.typing-row { display: flex; margin: 6px 18px 12px; }
.typing-bubble {
    background: #fff; border: 1px solid #dde5f0;
    border-radius: 18px; border-bottom-left-radius: 4px;
    padding: 12px 16px; display: flex; gap: 5px; align-items: center;
    box-shadow: 0 2px 8px rgba(0,0,0,0.07);
}
.typing-dot { width: 8px; height: 8px; border-radius: 50%; background: #94a3b8;
    animation: typing-bounce 1.3s ease-in-out infinite; }
.typing-dot:nth-child(2) { animation-delay: 0.2s; }
.typing-dot:nth-child(3) { animation-delay: 0.4s; }
@keyframes typing-bounce { 0%,60%,100% { transform: translateY(0); } 30% { transform: translateY(-6px); } }
.chat-spacer { height: 10px; }
</style>
"""


def _build_data_context(df: pd.DataFrame, ppv_col: str, params: dict) -> str:
    lines = [
        "Dataset: PPV (Purchase Price Variance)",
        f"Plant: {params.get('Plant','N/A')}  |  Period: {params.get('PostingStartDate','')} -> {params.get('PostingEndDate','')}",
        f"Total records: {len(df):,}",
    ]
    if ppv_col in df.columns:
        s = df[ppv_col]
        lines.append(f"Total PPV: ${s.sum():,.2f}  |  Avg: ${s.mean():,.2f}  |  Min: ${s.min():,.2f}  |  Max: ${s.max():,.2f}")
        lines.append(f"Favorable (PPV<0): {(s<0).sum():,}  |  Unfavorable (PPV>0): {(s>0).sum():,}")
    if "YearMonth" in df.columns and ppv_col in df.columns:
        mo = df.groupby("YearMonth")[ppv_col].sum().sort_index()
        lines.append("\nMonthly PPV totals:")
        for k, v in mo.items():
            lines.append(f"  {k}: ${v:,.2f}")
    if "Vendor_Name" in df.columns and ppv_col in df.columns:
        tv = df.groupby("Vendor_Name")[ppv_col].sum().sort_values(key=abs, ascending=False).head(10)
        lines.append("\nTop 10 vendors by |PPV|:")
        for n, v in tv.items():
            lines.append(f"  {n}: ${v:,.2f}")
    if "Material_Description" in df.columns and ppv_col in df.columns:
        tm = df.groupby("Material_Description")[ppv_col].sum().sort_values(key=abs, ascending=False).head(10)
        lines.append("\nTop 10 materials by |PPV|:")
        for n, v in tm.items():
            lines.append(f"  {n}: ${v:,.2f}")
    if "Material_Group_Description" in df.columns and ppv_col in df.columns:
        tg = df.groupby("Material_Group_Description")[ppv_col].sum().sort_values(key=abs, ascending=False).head(8)
        lines.append("\nPPV by material group:")
        for n, v in tg.items():
            lines.append(f"  {n}: ${v:,.2f}")
    lines.append(f"\nColumns available: {', '.join(df.columns.tolist())}")
    return "\n".join(lines)


def render(tab, dff: pd.DataFrame, PPV: str, params: dict | None = None, **_):
    params = params or {}
    with tab:
        st.markdown(_CHAT_CSS, unsafe_allow_html=True)

        # Import SDK
        try:
            from azure.ai.inference import ChatCompletionsClient
            from azure.ai.inference.models import AssistantMessage, SystemMessage, UserMessage
            from azure.core.credentials import AzureKeyCredential
        except Exception as _imp_err:
            st.error(f"Could not import Azure AI Inference SDK: {_imp_err}")
            st.info("Run: `pip install azure-ai-inference`")
            return

        # Topbar + clear button
        _tb_col, _clr_col = st.columns([0.82, 0.18])
        with _tb_col:
            st.markdown("""
            <div class="ai-topbar" style="border-radius:14px 14px 0 0;">
              <div class="ai-avatar">🤖</div>
              <div class="ai-topbar-info">
                <p class="ai-topbar-name">PPV AI Assistant · Kimi-K2.6</p>
                <p class="ai-topbar-status">
                  <span class="ai-online-dot"></span> Online · Azure AI Foundry
                </p>
              </div>
            </div>
            """, unsafe_allow_html=True)
        with _clr_col:
            st.markdown("<div style='height:8px'></div>", unsafe_allow_html=True)
            if st.button("🗑️ Clear", use_container_width=True, key="ai_clear_btn"):
                st.session_state["ai_chat_history"] = []
                st.rerun()

        _system_prompt = (
            "You are an expert financial analyst specialising in Purchase Price Variance (PPV) for manufacturing. "
            "Use ONLY the dataset context below to answer. Be concise but precise; cite figures when relevant. "
            "Respond in the same language the user writes in.\n\n"
            "=== DATASET CONTEXT ===\n" + _build_data_context(dff, PPV, params)
        )

        def _sdk_messages(history: list):
            from azure.ai.inference.models import AssistantMessage, SystemMessage, UserMessage
            out = [SystemMessage(content=_system_prompt)]
            for m in history:
                if m["role"] == "user":    out.append(UserMessage(content=m["content"]))
                elif m["role"] == "assistant": out.append(AssistantMessage(content=m["content"]))
            return out

        def _call_azure(history: list) -> str:
            cli = ChatCompletionsClient(
                endpoint=AZ_INF_ENDPOINT,
                credential=AzureKeyCredential(AZ_INF_API_KEY),
                api_version=AZ_INF_API_VER,
            )
            resp = cli.complete(
                messages=_sdk_messages(history),
                model=AZ_INF_MODEL,
                max_tokens=2048, temperature=0.3, top_p=0.9,
            )
            ans = resp.choices[0].message.content
            if isinstance(ans, list):
                ans = "".join(getattr(c, "text", str(c)) for c in ans)
            return ans

        if "ai_chat_history" not in st.session_state:
            st.session_state["ai_chat_history"] = []

        def _bubble(role: str, text: str):
            _side = "user" if role == "user" else "bot"
            return (
                f'<div class="msg-row {_side}">'
                f'<div class="bubble {_side}">{text}</div>'
                f'</div>'
            )

        _history_html = '<div class="chat-spacer"></div>'
        for m in st.session_state["ai_chat_history"]:
            _history_html += _bubble(m["role"], m["content"])
        _history_html += '<div class="chat-spacer"></div>'

        st.markdown(
            '<div class="ai-chat-wrap" style="border-top:none; border-radius:0 0 14px 14px;">'
            f'{_history_html}</div>',
            unsafe_allow_html=True,
        )

        _user_input = st.chat_input("Type your question…")
        if _user_input:
            st.session_state["ai_chat_history"].append({"role": "user", "content": _user_input})
            _typing_ph = st.empty()
            _typing_ph.markdown("""
            <div class="ai-chat-wrap" style="border:none; background:transparent;">
              <div class="typing-row">
                <div class="typing-bubble">
                  <div class="typing-dot"></div>
                  <div class="typing-dot"></div>
                  <div class="typing-dot"></div>
                </div>
              </div>
            </div>
            """, unsafe_allow_html=True)
            try:
                _answer = _call_azure(st.session_state["ai_chat_history"])
            except Exception as e:
                _answer = f"⚠️ Error contacting Azure AI: {e}"
            _typing_ph.empty()
            st.session_state["ai_chat_history"].append({"role": "assistant", "content": _answer})
            st.rerun()
