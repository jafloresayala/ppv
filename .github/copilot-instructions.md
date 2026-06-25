# PPV Analytics Dashboard — Copilot Instructions

## Project Overview
**Purchase Price Variance (PPV) Analytics Dashboard** for Kimball Electronics.
Full-stack web app: **React + TypeScript frontend** + **FastAPI Python backend** communicating via REST/SSE.

```
price_variation/
├── frontend/          # React 18 + TypeScript + Vite + Tailwind + Zustand
│   ├── src/
│   │   ├── App.tsx              # Root shell, routing, tab bar
│   │   ├── api/client.ts        # Typed axios wrappers for all API endpoints
│   │   ├── store/ppvStore.ts    # Global state (Zustand)
│   │   ├── types/api.types.ts   # All TypeScript interfaces (source of truth)
│   │   ├── components/          # Shared UI components (KPICards, QueryForm, Sidebar…)
│   │   ├── tabs/                # One file per dashboard tab (TabTrend, TabVendors…)
│   │   └── charts/              # Reusable chart wrappers (uPlot / plotly)
│   └── dist/                    # Production build output (served by FastAPI)
├── backend/
│   ├── main.py          # FastAPI app, all routes, SSE streaming
│   ├── data_service.py  # SAP fetch, DataFrame parsing, session store
│   ├── analytics.py     # All analytics computations (KPIs, trend, groups…)
│   ├── cache.py         # Redis cache layer
│   ├── sourcing.py      # Price sourcing / recommendation logic
│   ├── config.py        # All constants and env-var-overridable settings
│   └── requirements.txt
└── build.bat            # Production build helper
```

## Tech Stack

### Frontend
- **React 18** with **TypeScript** (strict mode)
- **Vite** for bundling
- **Tailwind CSS** for styling — use utility classes, not custom CSS files
- **Zustand** (`usePPV` hook) for all global state — no prop-drilling, no `useState` for shared data
- **uPlot** for high-performance time-series charts; Plotly for other chart types
- **axios** (`frontend/src/api/client.ts`) for all API calls — never use raw `fetch` except for SSE streaming (query and chat stream)
- **lucide-react** for icons
- **react-router-dom v7** — two routes: `/` (main app) and `/pricecalculator`

### Backend
- **FastAPI** + **uvicorn** — all routes in `backend/main.py`
- **Pandas / NumPy / SciPy / scikit-learn / statsmodels** for analytics and ML
- **Redis** for caching SAP data, sessions, and computed analytics (TTLs in `config.py`)
- **requests + requests_ntlm** (`HttpNtlmAuth`) for SAP General API — NTLM auth
- **Azure AI Inference** (`azure-ai-inference`) for the AI chat tab — streaming via SSE
- Credentials and config come from **environment variables** (`.env` / `backend/.env`); constants live in `backend/config.py`

### Model / AI chat integration
- Primary model integration is in `backend/main.py`: `/api/chat` for non-stream replies and `/api/chat/stream` for streaming SSE responses.
- Model config lives in `backend/config.py`: `AZ_INF_ENDPOINT`, `AZ_INF_API_KEY`, `AZ_INF_API_VER`, `AZ_INF_MODEL`.
- Current model is `Kimi-K2.6`. Change model behavior by updating backend prompt construction or the model config, not the frontend UI.
- Frontend chat clients are in `frontend/src/api/client.ts` and `frontend/src/tabs/TabAI.tsx`.
- For chat with session context, the backend injects raw/aggregated dataset context via `_build_data_context()` when `session_id` is present.
- Do not add direct AI inference calls in the frontend; all AI requests must be proxied through the backend.

## Architecture Patterns

### Data flow
1. User selects plants + date range → `QueryForm` calls `usePPV().query()`
2. Frontend POSTs to `/api/query` → backend streams SSE progress events (`phase: fetching | done | error`)
3. On `done`, frontend calls `/api/analytics` with `session_id` + active filters
4. All subsequent tab/filter changes call `/api/analytics` — no full re-fetch from SAP
5. Forecast → `/api/forecast`, search → `/api/search`, AI chat → `/api/chat/stream`

### State management (Zustand — `ppvStore.ts`)
- Single `usePPV` store for everything: session, analytics, filters, UI state, chat
- Derived state (e.g., `hasData = !!analytics`) computed inline in components, not stored
- Never put analytics data in React `useState`; always read from `usePPV()`

### Backend session model
- SAP fetch creates a `session_id` (UUID); the parsed DataFrame is cached in Redis under that ID
- All analytics endpoints accept `session_id` + `filters` and operate on the cached DataFrame
- Cache TTLs are defined in `backend/config.py` and overridable via env vars

### SAP data quirks
- SAP amounts use a trailing `-` to denote negatives: `"0.01-"` → `-0.01`
- Always parse through `_sap_amount()` in `data_service.py`; use the `*_num` suffixed columns
- API response may be wrapped: `_extract_records(raw)` normalizes list / dict envelopes
- Column name constants: `COL_PPV`, `COL_PRICE`, `COL_FX` (defined in `backend/config.py`)

### SSE streaming pattern
Both the query endpoint and chat endpoint stream `data: <json>\n\n` events.
Frontend reads with `ReadableStream` + `TextDecoder` — see `ppvStore.ts` `query()` and `sendChatStream()` in `client.ts` as the canonical examples.

## Code Style

### Naming & language
- **All identifiers**: English
- **User-facing UI text**: English (labels, buttons, placeholders)
- **Code comments**: can be Spanish or English

### TypeScript (frontend)
- All API response shapes are defined in `frontend/src/types/api.types.ts` — update this file when adding/changing endpoints
- Use `interface` not `type` for API shapes
- Avoid `any`; use the typed interfaces
- Component files: PascalCase (`TabTrend.tsx`); utilities: camelCase

### Python (backend)
- Section headers: `# ─── Section Name ────────────────────────────────────────────────────────────`
- Private/internal helpers: `_snake_case` prefix
- All route functions are `async def`; CPU-heavy analytics run in `asyncio.to_thread()`

### Tailwind / styling
- Corporate accent color is `bg-brand` / `text-brand` (defined in `tailwind.config.js`)
- Favorable variance = green (`text-green-600`), Unfavorable = red (`text-red-600`)
- Use skeleton loaders (`className="skeleton"`) for loading states — already defined in `index.css`

## What NOT to do
- **Do not** add Streamlit, `st.*`, or any Streamlit dependency — the app is fully migrated to React + FastAPI
- **Do not** hardcode credentials or API keys — use `backend/config.py` constants that read from env vars
- **Do not** use `pd.DataFrame.append()` (deprecated) — use `pd.concat()`
- **Do not** bypass the Zustand store with local `useState` for shared data
- **Do not** call SAP directly from the frontend — all SAP calls go through the FastAPI backend
- **Do not** add new analytics endpoints without updating `frontend/src/types/api.types.ts`
- **Do not** write intermediate data to CSV — use Redis cache or in-memory DataFrames
