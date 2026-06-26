// src/api/client.ts — typed API wrappers
import axios from 'axios'
import type {
  QueryResponse, Analytics, ForecastData, SearchResult, ChatMessage,
  HierarchyDrillData, SourcingResult, MaterialTrendData, MGPlantComponentsData,
  SapBatchResponse, TrendDetailData,
} from '../types/api.types'

// Shared filter type for all analytics endpoints
export type Filters = {
  material_groups?: string[]
  vendors?:         string[]
  plants?:          string[]
  date_start?:      string    // "YYYY-MM"
  date_end?:        string    // "YYYY-MM"
}

// Base instance — long default for all requests
const http = axios.create({ baseURL: '/api', timeout: 600_000 })

export async function queryApi(plants: string[], startDate: string, endDate: string): Promise<QueryResponse> {
  const { data } = await http.post<QueryResponse>('/query', {
    plants,
    start_date: startDate.replace(/-/g, ''),
    end_date:   endDate.replace(/-/g, ''),
  }, { timeout: 480_000 })  // 8 min — SAP can be slow for large ranges
  return data
}

export async function getAnalytics(
  sessionId: string,
  filters: Filters,
): Promise<Analytics> {
  const { data } = await http.post<Analytics>('/analytics', {
    session_id: sessionId,
    filters,
  }, { timeout: 300_000 })  // 5 min — analytics on large datasets
  return data
}

export async function getForecast(
  sessionId: string,
  filters:   Filters,
  scaleMethod = 'StandardScaler',
): Promise<ForecastData> {
  const { data } = await http.post<ForecastData>('/forecast', {
    session_id:   sessionId,
    filters,
    scale_method: scaleMethod,
  }, { timeout: 600_000 })  // 10 min — ML models can be slow
  return data
}

export async function searchMaterial(sessionId: string, query: string): Promise<SearchResult> {
  const { data } = await http.post<SearchResult>('/search', {
    session_id: sessionId,
    query,
  })
  return data
}

export async function sendChat(messages: ChatMessage[]): Promise<string> {
  const { data } = await http.post<{ reply: string }>('/chat', { messages })
  return data.reply
}

export async function sendChatStream(
  messages:  ChatMessage[],
  onChunk:   (text: string) => void,
  sessionId?: string,
  filters?:   Filters,
): Promise<void> {
  const body: Record<string, unknown> = { messages }
  if (sessionId) { body.session_id = sessionId; body.filters = filters ?? {} }
  const res = await fetch('/api/chat/stream', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  if (!res.ok) throw new Error(`Chat error ${res.status}`)
  const reader = res.body!.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    buffer += decoder.decode(value, { stream: true })
    const lines = buffer.split('\n')
    buffer = lines.pop() ?? ''
    for (const line of lines) {
      if (!line.startsWith('data: ')) continue
      const payload = line.slice(6).trim()
      if (payload === '[DONE]') return
      try {
        const parsed = JSON.parse(payload)
        if (parsed.error) throw new Error(parsed.error)
        if (parsed.text) onChunk(parsed.text)
      } catch (e) { if (e instanceof Error) throw e }
    }
  }
}

export async function getHierarchyDrill(
  sessionId:     string,
  filters:       Filters,
  hierarchyCode: string,
  yearMonth:     string,
): Promise<HierarchyDrillData> {
  const { data } = await http.post<HierarchyDrillData>('/hierarchy-drill', {
    session_id:     sessionId,
    filters,
    hierarchy_code: hierarchyCode,
    year_month:     yearMonth,
  })
  return data
}

export async function getSourcing(
  material: string,
  quantity = 1,
): Promise<SourcingResult> {
  const { data } = await http.post<SourcingResult>('/sourcing', { material, quantity })
  return data
}

export async function getMaterialTrend(
  sessionId: string,
  filters:   Filters,
  materialNumber: string,
): Promise<MaterialTrendData> {
  const { data } = await http.post<MaterialTrendData>('/material-trend', {
    session_id:      sessionId,
    filters,
    material_number: materialNumber,
  })
  return data
}

export async function getMGSapBatch(
  materials:  string[],
  loserPlant: string,
): Promise<SapBatchResponse> {
  const { data } = await http.post<SapBatchResponse>('/mg-sap-batch', {
    materials,
    loser_plant: loserPlant,
  })
  return data
}

export async function getMGPlantComponents(
  sessionId: string,
  filters:   Filters,
  group:     string,
  plant:     string,
): Promise<MGPlantComponentsData> {
  const { data } = await http.post<MGPlantComponentsData>('/mg-plant-components', {
    session_id: sessionId,
    filters,
    group,
    plant,
  })
  return data
}

export async function getTrendDetail(
  sessionId:   string,
  filters:     Filters,
  label:       string,
  granularity: string,
): Promise<TrendDetailData> {
  const { data } = await http.post<TrendDetailData>('/trend-detail', {
    session_id:  sessionId,
    filters,
    label,
    granularity,
  })
  return data
}

export interface RawDataResponse {
  columns:     string[]
  records:     Record<string, unknown>[]
  total_rows:  number
  total_pages: number
  page:        number
  page_size:   number
}

export async function getRawData(
  sessionId: string,
  filters:   Filters,
  page:      number,
  pageSize:  number,
): Promise<RawDataResponse> {
  const { data } = await http.post<RawDataResponse>('/raw-data', {
    session_id: sessionId,
    filters,
    page,
    page_size: pageSize,
  }, { timeout: 60_000 })
  return data
}

export interface NexarCacheStats {
  initialized_at: string | null
  expires_at:     string | null
  cached_count:   number
}

export async function getNexarCacheStats(): Promise<NexarCacheStats> {
  const { data } = await http.get<NexarCacheStats>('/pricecalc/nexar-cache-stats', { timeout: 5_000 })
  return data
}

// ── MPN best-price DB cache + daily batch job ──────────────────────────────

export interface MpnBestEntry {
  mpn:          string
  internalPN:   string | null
  bestSource:   string | null   // 'MPN' | 'Internal' | 'None'
  bestPriceUsd: number | null
  stdPriceUsd:  number | null
  bestSupplier: string | null
  bestPlant:    string | null
  bestMpn:      string | null
  lastPoDate:   string | null
  computedAt:   string | null
  origin:       string | null   // 'job' | 'realtime'
  status?:      string | null   // 'ok' | 'no_price' | 'error'
  errorDetail?: string | null
  // Full cached payload (present when hasPayload) — typed loosely; the widget
  // casts rawRows→IQItem[] and ampl→AmplResponse.
  rawRows?:     Record<string, unknown>[]
  ampl?:        Record<string, unknown> | null
  mcRows?:      Record<string, unknown>[]
  hasPayload?:  boolean
}

export interface DbJobStatus {
  running:       boolean
  run_id:        number | null
  trigger:       string | null
  total:         number
  processed:     number
  success:       number
  errors:        number
  conn_errors:   number
  started_at:    string | null
  finished_at:   string | null
  status:        string         // idle | running | done | failed | cancelled
  source_file:   string | null
  message:       string
  last_run_at:   string | null
  cached_count:  number
  schedule_hour: number
  overdue:       boolean
  latest_run:    Record<string, unknown> | null
}

export async function getDbJobStatus(): Promise<DbJobStatus> {
  const { data } = await http.get<DbJobStatus>('/dbjob/status', { timeout: 10_000 })
  return data
}

export async function runDbJob(windowDays?: number, force = false, token?: string): Promise<DbJobStatus & { started: boolean; reason?: string }> {
  const { data } = await http.post('/dbjob/run', { window_days: windowDays ?? null, force }, {
    timeout: 15_000,
    headers: token ? { Authorization: `Bearer ${token}` } : undefined,
  })
  return data
}

export async function retryDbJobErrors(): Promise<{ started: boolean; reason?: string }> {
  const { data } = await http.post('/dbjob/retry-errors', {}, { timeout: 15_000 })
  return data
}

export async function cancelDbJob(): Promise<{ cancelled: boolean }> {
  const { data } = await http.post('/dbjob/cancel', {}, { timeout: 10_000 })
  return data
}

export function dbJobExportUrl(): string {
  return '/api/dbjob/export'
}

export interface MpnLookupResponse {
  found:   Record<string, MpnBestEntry>
  missing: string[]
}

export async function lookupMpnBest(mpns: string[]): Promise<MpnLookupResponse> {
  const { data } = await http.post<MpnLookupResponse>('/mpn-best/lookup', { mpns }, { timeout: 20_000 })
  return data
}

export interface MpnResolveResponse {
  results:  Record<string, MpnBestEntry | null>
  from_db:  string[]
  computed: string[]
}

export async function resolveMpnBest(mpns: string[], windowDays?: number): Promise<MpnResolveResponse> {
  const { data } = await http.post<MpnResolveResponse>(
    '/mpn-best/resolve', { mpns, window_days: windowDays ?? 45 }, { timeout: 600_000 },
  )
  return data
}

// ── Admin dashboard ─────────────────────────────────────────────────────────

export async function adminLogin(username: string, password: string): Promise<{ token: string; expires_in: number }> {
  const { data } = await http.post('/admin/login', { username, password }, { timeout: 10_000 })
  return data
}

export interface AdminDashboard {
  metrics:       { total: number; by_type: Record<string, number> }
  runs:          Array<Record<string, unknown>>
  recent_errors: Array<Record<string, unknown>>
  cached_count:  number
  deep_count?:    number
  active_db?:     string
  status_counts?: Record<string, number>
}

export async function getAdminDashboard(token: string): Promise<AdminDashboard> {
  const { data } = await http.get<AdminDashboard>('/admin/dashboard', {
    timeout: 15_000,
    headers: { Authorization: `Bearer ${token}` },
  })
  return data
}

// ── Admin: search & re-query specific MPNs ────────────────────────────────────

export interface AdminMpnSearchResponse {
  results:       MpnBestEntry[]
  status_counts: Record<string, number>
}

export async function adminSearchMpns(
  token: string, q: string, status?: string,
): Promise<AdminMpnSearchResponse> {
  const { data } = await http.get<AdminMpnSearchResponse>('/admin/mpn-search', {
    timeout: 20_000,
    params: { q: q || '', status: status || '' },
    headers: { Authorization: `Bearer ${token}` },
  })
  return data
}

export interface AdminRequeryResponse {
  results:       MpnBestEntry[]
  summary:       { requested: number; ok: number; failed: number }
  status_counts: Record<string, number>
}

export async function adminRequeryMpns(
  token: string, mpns: string[], windowDays?: number,
): Promise<AdminRequeryResponse> {
  const { data } = await http.post<AdminRequeryResponse>(
    '/admin/mpn-requery',
    { mpns, window_days: windowDays ?? null },
    { timeout: 600_000, headers: { Authorization: `Bearer ${token}` } },
  )
  return data
}

export async function adminRequeryFailed(
  token: string, statuses?: string[], windowDays?: number,
): Promise<{ started: boolean; reason?: string; count: number }> {
  const { data } = await http.post(
    '/admin/mpn-requery-failed',
    { statuses: statuses ?? null, window_days: windowDays ?? null },
    { timeout: 30_000, headers: { Authorization: `Bearer ${token}` } },
  )
  return data
}

// ── Deep Analysis cache (per Internal PN) ─────────────────────────────────────

export interface DeepCacheEntry {
  internalPN:       string
  status:           string
  mpnBestPriceUsd:  number | null
  mpnBestStdUsd:    number | null
  mpnBestSupplier:  string | null
  mpnBestPlant:     string | null
  mpnBestMpn:       string | null
  mpnLastPoDate:    string | null
  mcBestPriceUsd:   number | null
  mcStdPriceUsd:    number | null
  mcBestSupplier:   string | null
  mcBestPlant:      string | null
  mcBestMpn:        string | null
  mcBestInternalPN: string | null
  mcLastPoDate:     string | null
  origin?:          string
  fromCache?:       boolean
}

export interface DeepResolveResponse {
  results:  Record<string, DeepCacheEntry | null>
  from_db:  string[]
  computed: string[]
}

export async function resolveDeep(
  internalPNs: string[], windowDays?: number,
): Promise<DeepResolveResponse> {
  const { data } = await http.post<DeepResolveResponse>(
    '/mpn-deep/resolve',
    { internal_pns: internalPNs, window_days: windowDays ?? undefined },
    { timeout: 600_000 },
  )
  return data
}

// ── Admin: local database version control ─────────────────────────────────────

export interface DbVersion {
  file:       string
  label:      string
  created_at: string
  active:     boolean
  exists:     boolean
  size_bytes: number
}

export async function adminListDatabases(token: string): Promise<{ active: string; databases: DbVersion[]; job_running: boolean }> {
  const { data } = await http.get('/admin/databases', {
    timeout: 15_000, headers: { Authorization: `Bearer ${token}` },
  })
  return data
}

export async function adminActivateDatabase(token: string, file: string): Promise<{ active: string; cached_count: number; deep_count: number; databases: DbVersion[] }> {
  const { data } = await http.post('/admin/databases/activate', { file }, {
    timeout: 30_000, headers: { Authorization: `Bearer ${token}` },
  })
  return data
}

export async function adminRemoveDatabase(token: string, file: string, deleteFile = false): Promise<{ active: string; databases: DbVersion[] }> {
  const { data } = await http.post('/admin/databases/remove', { file, delete_file: deleteFile }, {
    timeout: 15_000, headers: { Authorization: `Bearer ${token}` },
  })
  return data
}

// ── Demand databases (dbquery Excel → .db: Total EAU / Onhand / Gross Demand) ──

export interface DemandRow {
  plantCode:   string
  plantName:   string
  sourceVendorName?: string
  mpnKey?:     string
  totalEau:    number | null
  onhandQty:   number | null
  grossDemand: number | null
}

export async function lookupDemand(mpns: string[]): Promise<{ results: Record<string, DemandRow[]>; active_db: string | null }> {
  const { data } = await http.post('/demand/lookup', { mpns }, { timeout: 30_000 })
  return data
}

/** Full demand rows (all columns) for a set of MPNs, for the modal's full-data view. */
export interface DemandFullResponse {
  columns: string[]
  results: Record<string, Array<Record<string, string | number | null>>>
  active_db: string | null
  last_po_price_col: string
  po_qty_col: string
  total_eau_col: string
  plant_name_col: string
}

export async function lookupDemandFull(mpns: string[]): Promise<DemandFullResponse> {
  const { data } = await http.post<DemandFullResponse>('/demand/full', { mpns }, { timeout: 30_000 })
  return data
}

export interface DemandDbVersion {
  file:       string
  label:      string
  rows:       number | null
  created_at: string
  active:     boolean
  exists:     boolean
  size_bytes: number
}

export interface DemandConvertState {
  running:     boolean
  started_at:  string | null
  finished_at: string | null
  results:     Array<Record<string, unknown>>
  message:     string
}

export async function adminListDemandDatabases(token: string): Promise<{
  active: string | null; databases: DemandDbVersion[]; xlsx_files: string[]; convert: DemandConvertState
}> {
  const { data } = await http.get('/admin/demand/databases', {
    timeout: 15_000, headers: { Authorization: `Bearer ${token}` },
  })
  return data
}

export async function adminConvertDemand(token: string, force = false): Promise<{ started: boolean; reason?: string }> {
  const { data } = await http.post('/admin/demand/convert', { force }, {
    timeout: 15_000, headers: { Authorization: `Bearer ${token}` },
  })
  return data
}

export async function adminActivateDemand(token: string, file: string): Promise<{ active: string | null; databases: DemandDbVersion[] }> {
  const { data } = await http.post('/admin/demand/activate', { file }, {
    timeout: 15_000, headers: { Authorization: `Bearer ${token}` },
  })
  return data
}

export async function adminRemoveDemand(token: string, file: string, deleteFile = false): Promise<{ active: string | null; databases: DemandDbVersion[] }> {
  const { data } = await http.post('/admin/demand/remove', { file, delete_file: deleteFile }, {
    timeout: 15_000, headers: { Authorization: `Bearer ${token}` },
  })
  return data
}

/** Create a derived table in the active demand DB with best-price & savings. */
export async function adminCreateDemandBestTable(
  token: string,
  mpns?: string[] | null,
  windowDays?: number | null,
  tableName?: string | null,
): Promise<{ table: string | null; rows: number; total_potential_saving: number; per_mpn: Record<string, number | null> }> {
  const body: Record<string, unknown> = {}
  if (mpns) body.mpns = mpns
  if (windowDays != null) body.window_days = windowDays
  if (tableName) body.table_name = tableName
  const { data } = await http.post('/admin/demand/create_best_table', body, {
    timeout: 120_000,
    headers: { Authorization: `Bearer ${token}` },
  })
  return data
}
