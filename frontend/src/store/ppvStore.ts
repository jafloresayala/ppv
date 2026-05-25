// src/store/ppvStore.ts — global state with Zustand
import { create } from 'zustand'
import type {
  Analytics, FilterOptions, ForecastData, QueryResponse, SearchResult, ChatMessage,
} from '../types/api.types'
import { getAnalytics, getForecast, searchMaterial, sendChatStream } from '../api/client'

interface PPVState {
  // Session
  sessionId:     string | null
  params:        QueryResponse['params'] | null
  filterOptions: FilterOptions | null
  rowCount:      number

  // Filters
  selectedGroups:  string[]
  selectedVendors: string[]

  // Data
  analytics:  Analytics | null
  forecast:   ForecastData | null
  searchResult: SearchResult | null

  // UI state
  loading:         boolean
  loadingPhase:    string | null   // describes current operation step
  forecastLoading: boolean
  searchLoading:   boolean
  error:           string | null
  activeTab:       number

  // Fetch progress (SAP month-by-month streaming)
  fetchProgress:    number          // 0–100
  fetchMonthLabel:  string          // e.g. "Jan 2025" or "3 months from cache"
  fetchMonthsDone:  number
  fetchTotalMonths: number
  fetchRowsSoFar:   number

  // Chat
  chatHistory:   ChatMessage[]
  chatLoading:   boolean
  streamingMsg:  string | null

  // Actions
  query:          (plants: string[], start: string, end: string) => Promise<void>
  applyFilters:   () => Promise<void>
  loadForecast:   (scale?: string) => Promise<void>
  search:         (q: string) => Promise<void>
  setGroups:      (groups: string[]) => void
  setVendors:     (vendors: string[]) => void
  setTab:         (tab: number) => void
  clearError:     () => void
  sendMessage:    (content: string) => Promise<void>
  clearChat:      () => void
}

export const usePPV = create<PPVState>((set, get) => ({
  sessionId:       null,
  params:          null,
  filterOptions:   null,
  rowCount:        0,
  selectedGroups:  [],
  selectedVendors: [],
  analytics:       null,
  forecast:        null,
  searchResult:    null,
  loading:         false,
  loadingPhase:    null,
  forecastLoading: false,
  searchLoading:   false,
  error:           null,
  activeTab:       0,
  chatHistory:     [],
  chatLoading:     false,
  streamingMsg:    null,

  fetchProgress:    0,
  fetchMonthLabel:  '',
  fetchMonthsDone:  0,
  fetchTotalMonths: 0,
  fetchRowsSoFar:   0,

  query: async (plants, start, end) => {
    set({
      loading: true,
      loadingPhase: 'Fetching SAP data…',
      error: null,
      analytics: null,
      forecast: null,
      fetchProgress: 0,
      fetchMonthLabel: '',
      fetchMonthsDone: 0,
      fetchTotalMonths: 0,
      fetchRowsSoFar: 0,
    })
    try {
      const response = await fetch('/api/query', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          plants,
          start_date: start.replace(/-/g, ''),
          end_date:   end.replace(/-/g, ''),
        }),
      })

      if (!response.ok) {
        const err = await response.json().catch(() => ({ detail: 'Query failed' }))
        throw new Error(err.detail ?? 'Query failed')
      }
      if (!response.body) throw new Error('Streaming not supported by this browser.')

      const reader  = response.body.getReader()
      const decoder = new TextDecoder()
      let buffer   = ''
      let doneData: any = null

      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        buffer += decoder.decode(value, { stream: true })

        const lines = buffer.split('\n')
        buffer = lines.pop() ?? ''   // keep incomplete last line

        for (const line of lines) {
          if (!line.startsWith('data: ')) continue
          let event: any
          try { event = JSON.parse(line.slice(6)) } catch { continue }

          if (event.phase === 'fetching') {
            set({
              fetchProgress:    event.progress    ?? 0,
              fetchMonthLabel:  event.month_label ?? '',
              fetchMonthsDone:  event.months_done  ?? 0,
              fetchTotalMonths: event.total_months ?? 0,
              fetchRowsSoFar:   event.rows_so_far  ?? 0,
            })
          } else if (event.phase === 'done') {
            doneData = event
          } else if (event.phase === 'error') {
            throw new Error(event.message ?? 'Unknown server error')
          }
        }
      }

      if (!doneData) throw new Error('No response received from server.')

      set({
        sessionId:       doneData.session_id,
        params:          doneData.params,
        filterOptions:   doneData.filter_options,
        rowCount:        doneData.row_count,
        selectedGroups:  doneData.filter_options.material_groups,
        selectedVendors: doneData.filter_options.vendors,
        loadingPhase:    'Computing analytics…',
        fetchProgress:   100,
      })

      const ana = await getAnalytics(doneData.session_id, {
        material_groups: doneData.filter_options.material_groups,
        vendors:         doneData.filter_options.vendors,
      })
      set({ analytics: ana, loading: false, loadingPhase: null })
    } catch (e: any) {
      set({ loading: false, loadingPhase: null, error: e.message ?? String(e) })
    }
  },

  applyFilters: async () => {
    const { sessionId, selectedGroups, selectedVendors } = get()
    if (!sessionId) return
    set({ loading: true, error: null })
    try {
      const ana = await getAnalytics(sessionId, {
        material_groups: selectedGroups,
        vendors:         selectedVendors,
      })
      set({ analytics: ana, loading: false, forecast: null })
    } catch (e: any) {
      set({ loading: false, error: e.response?.data?.detail ?? e.message })
    }
  },

  loadForecast: async (scale = 'StandardScaler') => {
    const { sessionId, selectedGroups, selectedVendors } = get()
    if (!sessionId) return
    set({ forecastLoading: true })
    try {
      const fc = await getForecast(sessionId, { material_groups: selectedGroups, vendors: selectedVendors }, scale)
      set({ forecast: fc, forecastLoading: false })
    } catch (e: any) {
      set({ forecastLoading: false, error: e.response?.data?.detail ?? e.message })
    }
  },

  search: async (q) => {
    const { sessionId } = get()
    if (!sessionId) return
    set({ searchLoading: true })
    try {
      const res = await searchMaterial(sessionId, q)
      set({ searchResult: res, searchLoading: false })
    } catch (e: any) {
      set({ searchLoading: false, error: e.response?.data?.detail ?? e.message })
    }
  },

  setGroups:  (groups)  => set({ selectedGroups:  groups }),
  setVendors: (vendors) => set({ selectedVendors: vendors }),
  setTab:     (tab)     => set({ activeTab: tab }),
  clearError: ()        => set({ error: null }),

  sendMessage: async (content) => {
    const { chatHistory, analytics, sessionId, selectedGroups, selectedVendors } = get()
    const next: ChatMessage[] = [...chatHistory, { role: 'user', content }]
    set({ chatHistory: next, chatLoading: true, streamingMsg: null })

    const $ = (v: number) => v.toLocaleString('en-US', { style: 'currency', currency: 'USD', minimumFractionDigits: 2, maximumFractionDigits: 2 })

    const lines: string[] = [
      'You are an expert financial analyst specialising in Purchase Price Variance (PPV) for manufacturing.',
      'Use ONLY the data context below. Be concise but precise; cite figures when relevant.',
      'Respond in the same language the user writes in.',
      '',
    ]

    if (!analytics) {
      lines.push('No dataset loaded yet.')
    } else {
      const { kpis, trend, material_groups, vendors, materials, distribution } = analytics

      // ── KPIs ──────────────────────────────────────────────
      lines.push('=== KPIs ===')
      lines.push(`Total PPV: ${$(kpis.total_ppv)} | Favorable: ${$(kpis.favorable)} | Unfavorable: ${$(kpis.unfavorable)}`)
      lines.push(`Records: ${kpis.records} | Vendors: ${kpis.vendors} | Materials: ${kpis.materials}`)

      // ── Monthly trend ─────────────────────────────────────
      if (trend?.labels?.length) {
        lines.push('', `=== MONTHLY PPV TREND (${trend.labels[0]} – ${trend.labels[trend.labels.length - 1]}) ===`)
        lines.push('Month | PPV | Cumulative')
        trend.labels.forEach((lbl, i) => {
          lines.push(`${lbl} | ${$(trend.values[i])} | ${$(trend.cumulative[i])}`)
        })
      }

      // ── Material groups ───────────────────────────────────
      if (material_groups?.groups?.length) {
        lines.push('', '=== MATERIAL GROUPS (sorted by magnitude) ===')
        lines.push('Group | Total PPV | Type')
        const sorted = [...material_groups.groups].sort((a, b) => b.abs_total - a.abs_total).slice(0, 15)
        sorted.forEach(g => lines.push(`${g.name} | ${$(g.total)} | ${g.type}`))
      }

      // ── Vendors ───────────────────────────────────────────
      if (vendors?.vendors?.length) {
        lines.push('', '=== TOP VENDORS (by Total PPV magnitude) ===')
        lines.push('Vendor | Total PPV | Avg PPV | Records')
        const sorted = [...vendors.vendors].sort((a, b) => Math.abs(b.total) - Math.abs(a.total)).slice(0, 15)
        sorted.forEach(v => lines.push(`${v.name} | ${$(v.total)} | ${$(v.average)} | ${v.records}`))
      }

      // ── Materials ─────────────────────────────────────────
      if (materials?.materials?.length) {
        lines.push('', '=== TOP MATERIALS (by Total PPV magnitude) ===')
        lines.push('Material# | Description | Total PPV | Avg PPV | Records')
        const sorted = [...materials.materials].sort((a, b) => Math.abs(b.total) - Math.abs(a.total)).slice(0, 20)
        sorted.forEach(m => lines.push(`${m.number} | ${m.desc} | ${$(m.total)} | ${$(m.average)} | ${m.records}`))
      }

      // ── Distribution (box stats) ──────────────────────────
      if (distribution?.box_data?.length) {
        lines.push('', '=== PPV DISTRIBUTION BY GROUP (Box-Whisker) ===')
        lines.push('Group | Q1 | Median | Q3 | IQR | Outlier count')
        distribution.box_data.forEach(b =>
          lines.push(`${b.group} | ${$(b.q1)} | ${$(b.median)} | ${$(b.q3)} | ${$(b.iqr)} | ${b.outliers.length}`)
        )
      }
    }

    const systemMsg: ChatMessage = { role: 'system', content: lines.join('\n') }

    try {
      let accumulated = ''
      await sendChatStream(
        [systemMsg, ...next],
        (chunk) => { accumulated += chunk; set({ streamingMsg: accumulated }) },
        sessionId ?? undefined,
        sessionId ? { material_groups: selectedGroups, vendors: selectedVendors } : undefined,
      )
      set({
        chatHistory: [...next, { role: 'assistant', content: accumulated }],
        chatLoading: false,
        streamingMsg: null,
      })
    } catch (e: any) {
      set({
        chatHistory: [...next, { role: 'assistant', content: `⚠️ Error: ${e.message}` }],
        chatLoading: false,
        streamingMsg: null,
      })
    }
  },

  clearChat: () => set({ chatHistory: [] }),
}))
