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
