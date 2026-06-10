// src/types/api.types.ts — all API response shapes

export interface FilterOptions {
  material_groups: string[]
  vendors:         string[]
}

export interface SourcingBestOption {
  mpn:            string
  manufacturer?:  string
  seller?:        string
  supplier?:      string
  unit_price_usd: number
  click_url?:     string
  inventory?:     number
}

export interface SourcingResult {
  sap:            SourcingBestOption | null
  market:         SourcingBestOption | null
  recommendation: 'SAP' | 'Market' | 'No data'
  diff_pct:       number | null
  mpns:           string[]
}

export interface QueryResponse {
  session_id:     string
  row_count:      number
  columns:        string[]
  filter_options: FilterOptions
  params:         { Plants: string[]; PostingStartDate: string; PostingEndDate: string }
}

export interface KPIs {
  total_ppv:   number
  favorable:   number
  unfavorable: number
  records:     number
  vendors:     number
  materials:   number
}

export interface TrendData {
  granularity: 'daily' | 'monthly' | 'none'
  labels:      string[]
  values:      number[]
  cumulative:  number[]
  by_plant?:   Record<string, number[]>
}

export interface MGGroup {
  name:      string
  total:     number
  abs_total: number
  type:      'Favorable' | 'Unfavorable'
  plants?:   string[]
  by_plant?: Record<string, number>
}

export interface MGComponentItem {
  material:    string
  description: string
  ppv:         number
  records:     number
}

export interface MGPlantComponentsData {
  group:      string
  plant:      string
  total:      number
  components: MGComponentItem[]
}

export interface SapComponentResult {
  material:            string
  found:               boolean
  loser_price:         number | null
  loser_internal_pn:   string | null
  best_price:          number | null
  best_site:           string | null
  best_internal_pn:    string | null
  saving_pct:          number | null
  is_cheapest_at_loser: boolean
}

export interface SapBatchResponse {
  results: SapComponentResult[]
}

export interface MGTrend {
  labels:    string[]
  values:    number[]
  trend_line: number[]
  upper2s:   number[]
  lower2s:   number[]
  direction: 'up' | 'down' | 'stable'
}

export interface MaterialGroupsData {
  groups:    MGGroup[]
  drilldown: Record<string, { unfavorable: any[]; favorable: any[] }>
  trends:    Record<string, MGTrend>
}

export interface VendorRow {
  name:    string
  code:    string
  total:   number
  records: number
  average: number
  plants?: string[]
}

export interface KnnGrid {
  x: number[]; y: number[]; z: number[][]
  x_min: number; x_max: number; y_min: number; y_max: number
}

export interface VendorsData {
  vendors:   VendorRow[]
  knn_grid:  KnnGrid | null
  drilldown: Record<string, any[]>
}

export interface MaterialRow {
  number:  string
  desc:    string
  total:   number
  records: number
  average: number
  plants?: string[]
}

export interface ParetoRow {
  number: string; desc: string; total: number; cum_pct: number; rank: number; plants?: string[]
}

export interface MaterialsData {
  materials: MaterialRow[]
  pareto:    ParetoRow[]
  outliers:  Record<string, { outlier_indices: number[]; model: string }>
}

export interface TrendDetailRow {
  date:        string
  material:    string
  group:       string
  vendor:      string
  plant:       string
  ppv:         number
  quantity:    number
  po_price_k:  number
  std_price_k: number
}

export interface TrendDetailData {
  label: string
  rows:  TrendDetailRow[]
}

export interface MaterialTrendData {
  material:  string
  desc:      string
  labels:    string[]
  std_price: (number | null)[]
  po_price:  (number | null)[]
  ppv:       (number | null)[]
  records:   number[]
}

export interface HierarchyRow {
  code:    string
  total:   number
  records: number
  trend:   'up' | 'down' | 'stable'
  plants?: string[]
}

export interface HierarchyData {
  hierarchies:   HierarchyRow[]
  trend_series:  Record<string, {
    labels:      string[]
    values:      number[]
    lower_fence: number
    upper_fence: number
    trend_line:  number[] | null
    outliers:    (number | null)[]
  }>
}

export interface HierarchyDrillItem {
  material:    string
  description: string
  ppv:         number
}

export interface HierarchyDrillData {
  items:     HierarchyDrillItem[]
  hierarchy: string
  month:     string
}

export interface BoxStats {
  group: string; min: number; q1: number; median: number; q3: number
  max: number; mean: number; outliers: number[]; iqr: number
  lower_fence: number; upper_fence: number
}

export interface DistributionData {
  box_data:     BoxStats[]
  pie_by_group: Record<string, {
    by_material?: { labels: string[]; values: number[] }
    by_vendor?:   { labels: string[]; values: number[] }
  }>
}

export interface ImpactPoint {
  number:  string; desc: string; total: number; records: number; avg: number
  zone:    'outlier_pos' | 'outlier_neg' | 'normal'
}

export interface CorrelationMatrix {
  labels: string[]
  values: number[][]
}

export interface ForecastModel {
  model:     string
  mase:      number
  forecast:  number[]
  ci_lower:  number[]
  ci_upper:  number[]
}

export interface ForecastData {
  available:     boolean
  reason?:       string
  historical?:   { labels: string[]; values: number[] }
  future_labels?: string[]
  models?:       ForecastModel[]
  best_model?:   string
  n_train?:      number
  n_test?:       number
}

export interface Analytics {
  kpis:            KPIs
  trend:           TrendData
  material_groups: MaterialGroupsData
  vendors:         VendorsData
  materials:       MaterialsData
  hierarchy:       HierarchyData
  distribution:    DistributionData
  impact_scatter:  ImpactPoint[]
  correlation:     CorrelationMatrix
}

export interface SearchResult {
  found:         boolean
  query:         string
  found_mats?:   string[]
  kpis?:         { records: number; total: number; average: number; unfavorable: number; favorable: number }
  trend?:        { labels: string[]; values: number[] }
  by_vendor?:    any[]
  anova?:        { f_stat: number; p_value: number; significant: boolean; n_groups: number }
  histogram?:    { counts: number[]; edges: number[] }
  violin?:       Record<string, any>
  price_outliers?: Record<string, boolean[]>
}

export interface ChatMessage {
  role:    'user' | 'assistant' | 'system'
  content: string
}
