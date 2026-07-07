// src/components/SupplierComparePanel.tsx
// Per-MPN supplier comparison & savings panel.
// Opened from the Multi-MPN IQ Results grid. For a single MPN it groups the raw
// purchase records by plant, lets the user pick a "base" plant and (optionally) a
// "target" plant, and quantifies how much money could be saved if every supplier
// in the comparison aligned to the cheapest Last PO (USD) price found.
import { useMemo, useState, useEffect } from 'react'
import { getCurrencyRate, lookupDemandFull } from '../api/client'
import DataGrid, { DataGridColumn } from './DataGrid'
import { X, TrendingDown, ArrowRight, Building2, Trophy, CalendarClock } from 'lucide-react'

// ── Types ──────────────────────────────────────────────────────────────────

/** Minimal shape this panel needs from each raw purchase record. */
export interface CompareRecord {
  plant: string
  supplier: string
  lastPoUsd: number | null
  stdUsd: number | null
  quantity: number | null
  lastPoDate: string
  internalPN: string
  localCurrency: string
  lastPoLocal: number | null
}

function normalizeFullDemandData(data: FullDemandData | null | undefined): FullDemandData | null {
  if (!data) return null
  const columns = Array.isArray(data.columns) ? data.columns.filter((c): c is string => typeof c === 'string' && c.trim() !== '') : []
  const rows = Array.isArray(data.rows) ? data.rows : []
  return {
    ...data,
    columns,
    rows,
    lastPoPriceCol: typeof data.lastPoPriceCol === 'string' ? data.lastPoPriceCol : '',
    poQtyCol: typeof data.poQtyCol === 'string' ? data.poQtyCol : '',
    totalEauCol: typeof data.totalEauCol === 'string' ? data.totalEauCol : '',
    plantNameCol: typeof data.plantNameCol === 'string' ? data.plantNameCol : '',
  }
}

function FullDemandView({ mpn, data, loading, bestPrice, windowDays, bestSupplier, bestPlant, availablePlants, records }: { mpn: string; data: FullDemandData | null; loading: boolean; bestPrice: number | null; windowDays: number; bestSupplier?: string; bestPlant?: string; availablePlants?: string[]; records?: CompareRecord[] }) {
  // Track which row the user clicked so it stays highlighted.
  const [selectedRowIdx, setSelectedRowIdx] = useState<number | null>(null)
  const [currencyRates, setCurrencyRates] = useState<Record<string, number>>({})
  const [fxDiag, setFxDiag] = useState<{ requested: number; nonUnity: number; fallback: number; currencyCol: string; dateCol: string }>({ requested: 0, nonUnity: 0, fallback: 0, currencyCol: '—', dateCol: '—' })
  const [selectedPlant, setSelectedPlant] = useState<string>(bestPlant ?? '')
  const [appliedFilters, setAppliedFilters] = useState<Record<string, string[]>>({}) // Global filters
  const safeData = useMemo(() => normalizeFullDemandData(data), [data])

  // Load cached FX rates from localStorage on mount
  useEffect(() => {
    try {
      const cached = localStorage.getItem('fx_rates_cache')
      if (cached) {
        const parsed = JSON.parse(cached)
        setCurrencyRates(prev => ({ ...prev, ...parsed }))
      }
    } catch {
      // Silently ignore localStorage errors
    }
  }, [])

  // Keep the dropdown in sync if the caller changes the plant.
  useEffect(() => { setSelectedPlant(bestPlant ?? '') }, [bestPlant])

  // Recalculate the best price / supplier from the selected plant's records.
  const plantAnalysis = useMemo(() => {
    if (!records?.length) return null
    const plantRecords = selectedPlant
      ? records.filter(r => (r.plant || '(no plant)') === selectedPlant)
      : records
    return analyzeScope(plantRecords, windowDays)
  }, [records, selectedPlant, windowDays])
  const plantBestPrice = plantAnalysis?.refPrice ?? bestPrice
  const plantBestSupplier = plantAnalysis?.refRow?.supplier ?? bestSupplier

  const normalizeColumnName = (name: string) => String(name ?? '').replace(/[^a-z0-9]+/gi, '').trim().toLowerCase()
  const resolveColumnName = (columns: string[], candidates: string[]) => {
    const map = new Map(columns.map(c => [normalizeColumnName(c), c]))
    for (const candidate of candidates) {
      const hit = map.get(normalizeColumnName(candidate))
      if (hit) return hit
    }
    // Fallback: loose contains match for unexpected source names.
    const normalizedColumns = columns.map(c => ({ raw: c, norm: normalizeColumnName(c) }))
    for (const candidate of candidates) {
      const cand = normalizeColumnName(candidate)
      const loose = normalizedColumns.find(c => c.norm.includes(cand) || cand.includes(c.norm))
      if (loose) return loose.raw
    }
    return null
  }

  const discoverableColumns = useMemo(() => {
    if (!safeData) return []
    const fromRows = safeData.rows.length ? Object.keys(safeData.rows[0] ?? {}) : []
    return Array.from(new Set([...safeData.columns, ...fromRows]))
  }, [safeData])

  const priceCol = discoverableColumns.length ? resolveColumnName(discoverableColumns, ['LAST PO ITEM PRICE', 'Last PO Item Price']) : null
  const qtyCol = discoverableColumns.length ? resolveColumnName(discoverableColumns, ['PURCHASE ORDER QUANTITY', 'Purchase Order Quantity']) : null
  const currencyCol = discoverableColumns.length ? resolveColumnName(discoverableColumns, ['CURRENCY.2', 'CURRENCY 2', 'Currency', 'Currency 2']) : null
  const dateCol = discoverableColumns.length ? resolveColumnName(discoverableColumns, ['LAST ORDERER ON', 'Last Orderer On', 'Last Ordered On', 'Last PO Date', 'PO Date']) : null
  const mpnCol = discoverableColumns.length ? resolveColumnName(discoverableColumns, ['MANUFACTURER PART NO', 'MANUFACTURER PART NO.', 'MPN', 'Manufacturer Part No']) : null

  // Prepare all derived data BEFORE any early returns to maintain stable Hook order
  const rawRows = safeData?.rows || []
  const totalCol = safeData?.totalEauCol || ''
  
  // Filter: apply non-zero total EAU filter
  const filteredRows = useMemo(() => rawRows.filter(r => {
    const v = r[totalCol]
    if (v == null || v === '') return true
    const n = Number(v)
    if (isNaN(n)) return true
    return n !== 0
  }), [rawRows, totalCol])

  // Calculate BEST PRICE FOR MPN (global, across entire dataset)
  const mpnBestPriceMap = useMemo(() => {
    const map = new Map<string, number>()
    if (!safeData?.rows?.length || !mpnCol) return map

    const resolvedPriceCol = resolveColumnName(safeData.columns, ['LAST PO ITEM PRICE', 'Last PO Item Price'])
    if (!resolvedPriceCol) return map

    for (const row of safeData.rows) {
      const mpnKey = String(row[mpnCol] ?? '').trim()
      if (!mpnKey) continue
      const priceValue = Number(row[resolvedPriceCol] ?? 0)
      if (!Number.isFinite(priceValue) || priceValue <= 0) continue
      const currentBest = map.get(mpnKey) ?? Infinity
      map.set(mpnKey, Math.min(currentBest, priceValue))
    }
    return map
  }, [safeData, mpnCol])

  const bp = plantBestPrice
  const poCol = safeData?.poQtyCol || ''
  const lastCol = safeData?.lastPoPriceCol || ''

  const excludedColumnNames = new Set(['PLANT_CODE', 'PLANT_NAME', 'PRICE UNIT2', 'CURRENCY3', 'PRICE UNIT4', 'CURRENCY5'])
  const normalizedColumnName = (name: string) => String(name ?? '').replace(/\s+/g, ' ').trim().toUpperCase()

  // Apply global filters to all rows (not just displayed ones)
  const globallyFilteredRows = useMemo(() => {
    if (Object.keys(appliedFilters).length === 0) return filteredRows
    
    return filteredRows.filter(row => {
      for (const [colName, filterValues] of Object.entries(appliedFilters)) {
        if (filterValues.length === 0) continue
        const rowValue = String(row[colName] ?? '')
        if (!filterValues.includes(rowValue)) return false
      }
      return true
    })
  }, [filteredRows, appliedFilters])

  const displayRows = useMemo(() => {
    if (!safeData?.rows?.length) return []
    const resolvedCurrencyCol = resolveColumnName(safeData.columns, ['CURRENCY.2', 'CURRENCY 2', 'Currency', 'Currency 2'])
    const resolvedDateCol = resolveColumnName(safeData.columns, ['LAST ORDERER ON', 'Last Orderer On', 'LAST ORDERED ON', 'Last Ordered On', 'Last PO Date', 'PO Date'])
    const resolvedPriceCol = resolveColumnName(safeData.columns, ['LAST PO ITEM PRICE', 'Last PO Item Price'])
    const resolvedQtyCol = resolveColumnName(safeData.columns, ['PURCHASE ORDER QUANTITY', 'Purchase Order Quantity'])
    const resolvedStdPriceCol = resolveColumnName(safeData.columns, ['STANDARD PRICE', 'Standard Price', 'STD PRICE', 'Std Price'])

    return globallyFilteredRows.map(row => {
      const priceValue = Number(row[resolvedPriceCol ?? lastCol] ?? 0)
      const qtyValue = Number(row[resolvedQtyCol ?? poCol] ?? 0)
      const stdPriceValue = Number(row[resolvedStdPriceCol ?? ''] ?? 0)
      const currencyRaw = row[resolvedCurrencyCol ?? '']
      const currencyValue = String(currencyRaw ?? '').trim().toUpperCase()
      const dateValue = String(row[resolvedDateCol ?? ''] ?? '').trim()
      const dateKey = dateValue ? dateValue.slice(0, 10) : ''
      const rate = currencyValue && currencyValue !== 'USD' && dateKey ? (currencyRates[`${currencyValue}|${dateKey}`] ?? 1) : 1
      // Requested formula: CURRENCY TO USD = LAST PO ITEM PRICE / CurrencyRate
      const currencyToUsd = !Number.isNaN(priceValue) && priceValue > 0 && currencyValue && currencyValue !== 'USD' && rate > 0
        ? priceValue / rate
        : priceValue
      const total = currencyToUsd * (Number.isFinite(qtyValue) ? qtyValue : 0)
      const qtyXBestPrice = bp != null && Number.isFinite(qtyValue) ? bp * qtyValue : 0
      const poSavings = total - qtyXBestPrice
      const stdSavings = (stdPriceValue * qtyValue) - qtyXBestPrice
      
      // Best Price for this specific MPN (grouped globally)
      const mpnKey = mpnCol ? String(row[mpnCol] ?? '').trim() : ''
      const bestPriceForMpn = mpnKey && mpnBestPriceMap.has(mpnKey) ? mpnBestPriceMap.get(mpnKey) : null

      return {
        ...row,
        'TO USD': Number.isFinite(currencyToUsd) ? Number(currencyToUsd.toFixed(6)) : '',
        'LAST PO QTY x TO USD': Number.isFinite(total) ? Number(total.toFixed(2)) : '',
        'LAST PO QTY x BEST PRICE': Number.isFinite(qtyXBestPrice) ? Number(qtyXBestPrice.toFixed(2)) : '',
        'PO SAVINGS': Number.isFinite(poSavings) ? Number(poSavings.toFixed(2)) : '',
        'STD SAVINGS': Number.isFinite(stdSavings) ? Number(stdSavings.toFixed(2)) : '',
        'BEST PRICE FOR MPN': bestPriceForMpn != null ? Number(bestPriceForMpn.toFixed(6)) : '',
        '_currencyEmpty': !currencyValue || currencyValue.trim() === '',
      }
    })
  }, [safeData, globallyFilteredRows, lastCol, poCol, bp, currencyRates, mpnCol, mpnBestPriceMap])

  useEffect(() => {
    // FX lookup only depends on currency + date columns.
    // Do not block this when price/qty aliases are missing.
    if (!safeData || !safeData.rows.length || !currencyCol || !dateCol) {
      setFxDiag({ requested: 0, nonUnity: 0, fallback: 0, currencyCol: currencyCol ?? '—', dateCol: dateCol ?? '—' })
      return
    }
    const pending = new Map<string, { currency: string; date: string }>()
    const seen = new Set<string>()
    for (const row of safeData.rows) {
      const rawCurrency = String(row[currencyCol] ?? '').trim()
      const rawDate = String(row[dateCol] ?? '').trim()
      const currency = rawCurrency.toUpperCase()
      if (!currency || currency === 'USD') continue
      const normalizedDate = rawDate ? rawDate.slice(0, 10) : ''
      if (!normalizedDate) continue
      const key = `${currency}|${normalizedDate}`
      if (seen.has(key)) continue
      seen.add(key)
      pending.set(key, { currency, date: normalizedDate })
    }
    if (!pending.size) return

    let cancelled = false
    const run = async () => {
      const nextRates: Record<string, number> = {}
      let requested = 0
      let nonUnity = 0
      let fallback = 0
      for (const [key, req] of pending.entries()) {
        requested += 1
        try {
          const res = await getCurrencyRate(req.currency, req.date)
          nextRates[key] = res.rate
          if (res.rate !== 1) nonUnity += 1
        } catch {
          nextRates[key] = 1
          fallback += 1
        }
      }
      if (!cancelled) {
        const updatedRates = { ...currencyRates, ...nextRates }
        setCurrencyRates(updatedRates)
        // Cache FX rates in localStorage for persistence
        try {
          localStorage.setItem('fx_rates_cache', JSON.stringify(updatedRates))
        } catch {
          // Silently ignore localStorage errors
        }
        setFxDiag({ requested, nonUnity, fallback, currencyCol, dateCol })
      }
    }
    void run()
    return () => { cancelled = true }
  }, [safeData, currencyCol, dateCol])

  // Early returns AFTER all Hooks have been called
  if (loading) return (
    <div className="p-6 flex items-center justify-center">
      <div className="text-sm text-gray-500">Loading full demand data…</div>
    </div>
  )
  if (!safeData || !safeData.columns.length) return (
    <div className="p-6 text-sm text-gray-500">No demand rows available in the active demand database.</div>
  )

  // Build DataGrid columns from the DB columns, hide the noise columns, and append
  // the best-price reference columns that matter for this analysis.
  const visibleColumns = safeData.columns.filter(c => !excludedColumnNames.has(normalizedColumnName(c)))
  const cols: DataGridColumn<Record<string, any>>[] = visibleColumns.map((c, i) => {
    // Determine width based on column characteristics
    const normalized = normalizedColumnName(c)
    let width = ''
    if (i === 0) {
      width = 'sticky left-0 z-[2] bg-white'
    } else if (normalized.includes('PRICE') || normalized.includes('QUANTITY') || normalized.includes('QTY') || normalized.includes('DATE') || normalized.includes('CURRENCY')) {
      width = 'w-24'
    } else if (normalized.includes('PLANT') || normalized.includes('SUPPLIER')) {
      width = 'flex-1 min-w-32'
    }
    
    return {
      key: c,
      header: c,
      accessor: (r) => r[c] ?? '',
      render: (r) => {
        const raw = r[c]
        const norm = normalizedColumnName(c)
        if (norm === 'GROSS DEMAND') {
          const n = raw == null || raw === '' ? null : Number(raw)
          if (n == null || Number.isNaN(n)) return String(raw ?? '—')
          const cls = n < 0 ? 'bg-emerald-100 text-emerald-700' : n > 0 ? 'bg-red-100 text-red-700' : 'text-gray-700'
          return <span className={`inline-block w-full ${cls}`}>{String(raw)}</span>
        }
        return String(raw ?? '')
      },
      type: 'text',
      align: 'left',
      noSort: false,
      width: width,
    }
  })
  cols.push({
    key: 'best_supplier', header: 'BEST SUPPLIER', accessor: () => (plantBestSupplier ?? ''), render: () => (plantBestSupplier ?? '—'), type: 'text', align: 'left', width: 'flex-1 min-w-32',
  })
  cols.push({
    key: 'best_plant_price', header: 'PLANT SELECTED', accessor: () => (selectedPlant ?? bestPlant ?? ''), render: () => (selectedPlant ?? bestPlant ?? '—'), type: 'text', align: 'left', width: 'w-24',
  })
  cols.push({
    key: 'best_price_for_mpn', header: 'BEST PRICE', accessor: () => (bp == null ? '' : String(bp)), render: () => (bp == null ? '—' : String(bp)), type: 'number', align: 'right', width: 'w-20',
  })
  cols.push({
    key: 'best_price_for_this_mpn', header: 'BEST PRICE FOR MPN', accessor: (r) => r['BEST PRICE FOR MPN'] ?? '', render: (r) => {
      const v = r['BEST PRICE FOR MPN']
      if (v == null || v === '') return '—'
      return <span className="bg-indigo-100 text-indigo-700 inline-block w-full">{String(v)}</span>
    }, type: 'number', align: 'right', width: 'w-24',
  })
  cols.push({
    key: 'QTY x BEST PRICE', header: 'LAST PO QTY x BEST PRICE', accessor: (r) => r['LAST PO QTY x BEST PRICE'] ?? '', render: (r) => (r['LAST PO QTY x BEST PRICE'] == null || r['LAST PO QTY x BEST PRICE'] === '' ? '—' : String(r['LAST PO QTY x BEST PRICE'])), type: 'number', align: 'right', width: 'w-24',
  })
  cols.push({
    key: 'TO USD', header: 'LAST PO ITEM PRICE TO USD', accessor: (r) => r['TO USD'] ?? '', render: (r) => {
      const v = r['TO USD']
      const isEmpty = r['_currencyEmpty']
      if (v == null || v === '') return '—'
      const cls = isEmpty ? 'bg-yellow-100 text-yellow-700' : 'text-gray-700'
      return <span className={`inline-block w-full ${cls}`}>{String(v)}</span>
    }, type: 'number', align: 'right', width: 'w-24',
  })
  cols.push({
    key: 'PO QTY x TO CURRENCY', header: 'LAST PO QTY x TO USD', accessor: (r) => r['LAST PO QTY x TO USD'] ?? '', render: (r) => {
      const v = r['LAST PO QTY x TO USD']
      const isEmpty = r['_currencyEmpty']
      if (v == null || v === '') return '—'
      const cls = isEmpty ? 'bg-yellow-100 text-yellow-700' : 'text-gray-700'
      return <span className={`inline-block w-full ${cls}`}>{String(v)}</span>
    }, type: 'number', align: 'right', width: 'w-28',
  })
  cols.push({
    key: 'PO SAVINGS', header: 'PO SAVINGS', accessor: (r) => r['PO SAVINGS'] ?? '', render: (r) => {
      const v = r['PO SAVINGS']
      if (v == null || v === '') return '—'
      const n = typeof v === 'number' ? v : Number(v)
      const cls = n > 0 ? 'bg-emerald-100 text-emerald-700' : n < 0 ? 'bg-red-100 text-red-700' : 'text-gray-700'
      return <span className={`inline-block w-full ${cls}`}>{String(v)}</span>
    }, type: 'number', align: 'right', width: 'w-24',
  })
  cols.push({
    key: 'STD SAVINGS', header: 'STD SAVINGS', accessor: (r) => r['STD SAVINGS'] ?? '', render: (r) => {
      const v = r['STD SAVINGS']
      if (v == null || v === '') return '—'
      const n = typeof v === 'number' ? v : Number(v)
      const cls = n > 0 ? 'bg-emerald-100 text-emerald-700' : n < 0 ? 'bg-red-100 text-red-700' : 'text-gray-700'
      return <span className={`inline-block w-full ${cls}`}>{String(v)}</span>
    }, type: 'number', align: 'right', width: 'w-24',
  })

  return (
    <div className="flex flex-col h-full overflow-hidden p-4 gap-2">
      <div className="text-[11px] text-gray-600 shrink-0 flex flex-wrap items-center gap-3">
        <span>Full demand rows from <span className="font-mono">{mpn}</span> · Best price (window {windowDays}d): <span className="font-mono font-bold">{bp != null ? String(bp) : '—'}</span></span>
        {availablePlants && availablePlants.length > 0 && (
          <label className="flex items-center gap-1.5">
            <span className="text-gray-500">Plant:</span>
            <select
              value={selectedPlant}
              onChange={e => setSelectedPlant(e.target.value)}
              className="px-2 py-0.5 text-[11px] border border-gray-200 rounded focus:outline-none focus:ring-2 focus:ring-brand/30 focus:border-brand bg-white"
            >
              {availablePlants.map(p => <option key={p} value={p}>{p}</option>)}
            </select>
          </label>
        )}
        <span className="ml-auto text-gray-400">· Click a row to highlight it</span>
        <span className="text-gray-500">· FX calls: <span className="font-mono">{fxDiag.requested}</span> | rate≠1: <span className="font-mono">{fxDiag.nonUnity}</span> | fallback: <span className="font-mono">{fxDiag.fallback}</span></span>
        <span className="text-gray-500">· FX cols: <span className="font-mono">{fxDiag.currencyCol}</span> / <span className="font-mono">{fxDiag.dateCol}</span></span>
      </div>

      <div className="flex-1 min-h-0 overflow-auto">
        <DataGrid
          rows={displayRows}
          columns={cols}
          rowKey={(r, i) => `${mpn}-${i}`}
          pageSize={50}
          exportFileName={`demand_${mpn}_${new Date().toISOString().slice(0,10)}`}
          exportSheetName={`Demand_${mpn}`}
          defaultShowFilters={true}
          freezeFirstColumn={true}
          onRowClick={(_r, i) => setSelectedRowIdx(prev => prev === i ? null : i)}
          rowClassName={(_r, i) =>
            selectedRowIdx === i
              ? 'bg-indigo-100 ring-1 ring-inset ring-indigo-400 cursor-pointer'
              : 'hover:bg-indigo-50/60 cursor-pointer'
          }
        />
      </div>
    </div>
  )
}

/** Per-plant demand for the MPN, pulled from the active dbquery demand DB. */
export interface DemandRow {
  plantCode: string
  plantName: string
  /** Source Vendor Name from the dbquery 'Source Vendor Name' column (when present). */
  sourceVendorName?: string
  /** MPN key (uppercased Manufacturer Part No.) the row belongs to. */
  mpnKey?: string
  totalEau: number | null
  onhandQty: number | null
  grossDemand: number | null
}

/** Full demand rows (every .db column) + the column names used for savings calc. */
export interface FullDemandData {
  columns: string[]
  rows: Array<Record<string, string | number | null>>
  lastPoPriceCol: string
  poQtyCol: string
  totalEauCol: string
  plantNameCol: string
}

interface SupplierComparePanelProps {
  mpn: string
  records: CompareRecord[]
  /** Per-plant demand rows for this MPN (keyed visually by plant name). */
  demand?: DemandRow[]
  /** True while demand is being fetched. */
  demandLoading?: boolean
  /** Full demand rows (all columns) for the "Full demand data" view. */
  fullDemand?: FullDemandData | null
  /** True while full demand data is being fetched. */
  fullDemandLoading?: boolean
  onClose: () => void
}

// ── Helpers ──────────────────────────────────────────────────────────────────

const fmtUsd6 = (v: number | null | undefined) =>
  v != null ? v.toLocaleString('en-US', { style: 'currency', currency: 'USD', minimumFractionDigits: 6 }) : '—'
const fmtUsd2 = (v: number | null | undefined) =>
  v != null ? v.toLocaleString('en-US', { style: 'currency', currency: 'USD', minimumFractionDigits: 2 }) : '—'

interface PlantGroup {
  plant: string
  rows: CompareRecord[]
  cheapest: CompareRecord | null
  cheapestPrice: number | null
}

/** Group records by plant and find the cheapest priced supplier in each. */
function groupByPlant(records: CompareRecord[]): PlantGroup[] {
  const map = new Map<string, CompareRecord[]>()
  for (const r of records) {
    const key = r.plant || '(no plant)'
    if (!map.has(key)) map.set(key, [])
    map.get(key)!.push(r)
  }
  return [...map.entries()]
    .map(([plant, rows]) => {
      const priced = rows.filter(r => r.lastPoUsd != null && r.lastPoUsd > 0)
      const cheapest = priced.reduce<CompareRecord | null>((min, r) => {
        if (min == null) return r
        return (r.lastPoUsd ?? Infinity) < (min.lastPoUsd ?? Infinity) ? r : min
      }, null)
      return { plant, rows, cheapest, cheapestPrice: cheapest?.lastPoUsd ?? null }
    })
    .sort((a, b) => a.plant.localeCompare(b.plant))
}

interface AnalysisLine {
  r: CompareRecord
  price: number | null
  isRef: boolean
  within: boolean
  deltaUnit: number | null
  qty: number | null
  saveTotal: number | null
}

interface AnalysisResult {
  refRow: CompareRecord | null
  refPrice: number | null
  lines: AnalysisLine[]
  totalQtySaving: number
  distinctSuppliers: number
  unitSpread: number | null
  maxPrice: number
  windowStart: number | null
  maxT: number | null
}

/** Compute the cheapest reference price and savings lines for a set of records.
 *  If `referenceMaxT` is provided, the window is anchored to that timestamp
 *  instead of the most recent date inside `records`. This lets an "all plants"
 *  analysis share the same time window as the user's selected scope. */
function analyzeScope(records: CompareRecord[], windowDays: number, referenceMaxT?: number | null): AnalysisResult {
  const priced = records.filter(r => r.lastPoUsd != null && r.lastPoUsd > 0)

  const ts = (s: string) => { const t = new Date(s).getTime(); return isNaN(t) ? null : t }
  const dated = priced.map(r => ts(r.lastPoDate)).filter((t): t is number => t != null)
  const maxT = referenceMaxT ?? (dated.length ? Math.max(...dated) : null)
  const windowStart = maxT != null ? maxT - windowDays * 86_400_000 : null

  const inWindow = (r: CompareRecord) => {
    if (windowStart == null) return true
    const t = ts(r.lastPoDate)
    return t == null ? false : t >= windowStart
  }
  const eligible = priced.filter(inWindow)
  const pool = eligible.length ? eligible : priced

  const refRow = pool.reduce<CompareRecord | null>((min, r) => {
    if (min == null) return r
    return (r.lastPoUsd ?? Infinity) < (min.lastPoUsd ?? Infinity) ? r : min
  }, null)
  const refPrice = refRow?.lastPoUsd ?? null

  const lines = records.map(r => {
    const price = r.lastPoUsd
    const isRef = refRow != null && r === refRow
    const within = inWindow(r)
    const deltaUnit = price != null && refPrice != null ? price - refPrice : null
    const qty = r.quantity ?? null
    const saveTotal = deltaUnit != null && deltaUnit > 0 && qty != null ? deltaUnit * qty : (deltaUnit != null && deltaUnit > 0 ? null : 0)
    return { r, price, isRef, within, deltaUnit, qty, saveTotal }
  })

  const totalQtySaving = lines.reduce((sum, l) => sum + (l.saveTotal ?? 0), 0)
  const distinctSuppliers = new Set(records.map(r => r.supplier).filter(Boolean)).size
  const maxPrice = pool.reduce((mx, r) => Math.max(mx, r.lastPoUsd ?? 0), 0)
  const unitSpread = refPrice != null && maxPrice > 0 ? maxPrice - refPrice : null

  return { refRow, refPrice, lines, totalQtySaving, distinctSuppliers, unitSpread, maxPrice, windowStart, maxT }
}

/** Find the cheapest price across every plant, where each plant is evaluated
 *  against its own look-back window anchored to its own most recent Last PO date. */
function analyzeAllPlants(records: CompareRecord[], windowDays: number): AnalysisResult {
  const groups = groupByPlant(records)
  let bestRefRow: CompareRecord | null = null
  let bestRefPrice: number | null = null
  let bestWindowStart: number | null = null
  let bestMaxT: number | null = null

  for (const group of groups) {
    const plantAnalysis = analyzeScope(group.rows, windowDays)
    if (plantAnalysis.refPrice != null && (bestRefPrice == null || plantAnalysis.refPrice < bestRefPrice)) {
      bestRefRow = plantAnalysis.refRow
      bestRefPrice = plantAnalysis.refPrice
      bestWindowStart = plantAnalysis.windowStart
      bestMaxT = plantAnalysis.maxT
    }
  }

  return {
    refRow: bestRefRow,
    refPrice: bestRefPrice,
    lines: [],
    totalQtySaving: 0,
    distinctSuppliers: 0,
    unitSpread: null,
    maxPrice: bestRefPrice ?? 0,
    windowStart: bestWindowStart,
    maxT: bestMaxT,
  }
}

// ── Component ──────────────────────────────────────────────────────────────

export default function SupplierComparePanel({ mpn, records, demand = [], demandLoading = false, fullDemand = null, fullDemandLoading = false, onClose }: SupplierComparePanelProps) {
  const plantGroups = useMemo(() => groupByPlant(records), [records])

  // View toggle: savings comparison (default) ↔ full demand data table.
  const [view, setView] = useState<'savings' | 'full'>('savings')

  // Local fetch for full-demand rows when the view is switched to 'full' and
  // the parent did not supply `fullDemand` props. This keeps the panel
  // self-contained and avoids changing the parent component.
  const [fullLocal, setFullLocal] = useState<FullDemandData | null>(null)
  const [fullLocalLoading, setFullLocalLoading] = useState(false)

  useEffect(() => {
    let cancelled = false
    if (view !== 'full') return
    // If parent provided fullDemand, no need to fetch.
    if (fullDemand) { setFullLocal(fullDemand); return }
    setFullLocal(null)
    setFullLocalLoading(true)
    lookupDemandFull([mpn])
      .then(res => {
        if (cancelled) return
        const columns = Array.isArray(res?.columns) ? res.columns.filter((c): c is string => typeof c === 'string' && c.trim() !== '') : []
        const rows = Array.isArray(res?.results) ? res.results : Object.values(res?.results ?? {}).flat()
        setFullLocal({
          columns,
          rows,
          lastPoPriceCol: typeof res?.last_po_price_col === 'string' ? res.last_po_price_col : '',
          poQtyCol: typeof res?.po_qty_col === 'string' ? res.po_qty_col : '',
          totalEauCol: typeof res?.total_eau_col === 'string' ? res.total_eau_col : '',
          plantNameCol: typeof res?.plant_name_col === 'string' ? res.plant_name_col : '',
        })
      })
      .catch(() => { if (!cancelled) setFullLocal(null) })
      .finally(() => { if (!cancelled) setFullLocalLoading(false) })
    return () => { cancelled = true }
  }, [view, mpn, fullDemand])

  // MPN demand totals: a grand total (sum of EVERY demand row) plus a per-plant
  // breakdown. Rows are NOT de-duplicated, so a plant with several rows for the
  // same MPN is fully summed — matching what you get summing the Excel column.
  const demandTotals = useMemo(() => {
    let eau = 0, onhand = 0, gross = 0
    let any = false
    const byPlant = new Map<string, { eau: number; onhand: number; gross: number; rows: number }>()
    for (const d of demand) {
      const plantKey = (d.plantName || d.plantCode || '—').toUpperCase()
      const acc = byPlant.get(plantKey) ?? { eau: 0, onhand: 0, gross: 0, rows: 0 }
      acc.rows += 1
      if (d.totalEau != null)    { eau    += d.totalEau;    acc.eau    += d.totalEau;    any = true }
      if (d.onhandQty != null)   { onhand += d.onhandQty;   acc.onhand += d.onhandQty;   any = true }
      if (d.grossDemand != null) { gross  += d.grossDemand; acc.gross  += d.grossDemand; any = true }
      byPlant.set(plantKey, acc)
    }
    if (!any) return null
    const plants = [...byPlant.entries()]
      .map(([plant, v]) => ({ plant, ...v }))
      .sort((a, b) => a.plant.localeCompare(b.plant))
    return { eau, onhand, gross, plants, totalRows: demand.length }
  }, [demand])

  // Default base plant = the one with the most records (likely the main buyer).
  const [basePlant, setBasePlant] = useState<string>(() => {
    if (!plantGroups.length) return ''
    return plantGroups.reduce((best, g) => (g.rows.length > best.rows.length ? g : best), plantGroups[0]).plant
  })
  // Target plant is optional. Empty = compare within the base plant only.
  const [targetPlant, setTargetPlant] = useState<string>('')
  // Look-back window (days): the reference (cheapest) price is taken only from
  // POs within this many days BEFORE the latest PO date in scope. Default 45.
  const [windowDays, setWindowDays] = useState<number>(45)

  const baseGroup   = plantGroups.find(g => g.plant === basePlant) ?? null
  const targetGroup = targetPlant ? plantGroups.find(g => g.plant === targetPlant) ?? null : null

  // ── Savings model ──────────────────────────────────────────────────────────
  // Reference price = cheapest Last PO (USD) within a `windowDays` window from
  // the latest PO date in scope. For every supplier record, the per-unit
  // overspend is (its price − reference); × its quantity = potential saving.
  const analysis = useMemo(() => {
    const scopeRows: CompareRecord[] = []
    if (baseGroup) scopeRows.push(...baseGroup.rows)
    if (targetGroup) scopeRows.push(...targetGroup.rows)
    return analyzeScope(scopeRows, windowDays)
  }, [baseGroup, targetGroup, windowDays])

  // Cheapest price across every plant, where each plant is evaluated within its
  // own look-back window anchored to its own most recent Last PO date.
  const allPlantsAnalysis = useMemo(() => analyzeAllPlants(records, windowDays), [records, windowDays])

  const scopeLabel = targetPlant ? `${basePlant} vs ${targetPlant}` : basePlant

  return (
    <div className="fixed inset-0 z-[120] flex items-center justify-center p-4 bg-black/40 backdrop-blur-sm" onClick={onClose}>
      <div
        className={`bg-white rounded-2xl shadow-2xl w-full ${view === 'full' ? 'max-w-7xl' : 'max-w-4xl'} max-h-[88vh] flex flex-col overflow-hidden`}
        onClick={e => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-3.5 border-b border-gray-100 bg-gradient-to-r from-blue-50 to-indigo-50">
          <div className="flex items-center gap-2.5">
            <div className="p-1.5 rounded-lg bg-blue-100">
              <TrendingDown className="h-4 w-4 text-blue-600" />
            </div>
            <div>
              <h3 className="text-sm font-bold text-gray-800">Supplier Savings Analysis</h3>
              <p className="text-[11px] text-gray-500 font-mono">{mpn}</p>
            </div>
          </div>
          <div className="flex items-center gap-3">
            {/* View toggle */}
            <div className="flex gap-0.5 bg-white/70 rounded-lg p-0.5 border border-gray-200">
              <button
                onClick={() => setView('savings')}
                className={`px-2.5 py-1 text-[11px] font-semibold rounded-md transition-colors ${view === 'savings' ? 'bg-blue-600 text-white shadow-sm' : 'text-gray-500 hover:text-gray-700'}`}
              >
                Savings
              </button>
              <button
                onClick={() => setView('full')}
                className={`px-2.5 py-1 text-[11px] font-semibold rounded-md transition-colors ${view === 'full' ? 'bg-indigo-600 text-white shadow-sm' : 'text-gray-500 hover:text-gray-700'}`}
              >
                Full demand data
              </button>
            </div>
            <button onClick={onClose} className="p-1 rounded-lg text-gray-400 hover:text-gray-700 hover:bg-white/60 transition-colors">
              <X className="h-4 w-4" />
            </button>
          </div>
        </div>

        {view === 'savings' && <>
        {/* Plant selectors */}
        <div className="px-5 py-3 border-b border-gray-100 flex flex-wrap items-end gap-4">
          <label className="flex flex-col gap-1">
            <span className="text-[10px] font-semibold uppercase tracking-wide text-gray-400 flex items-center gap-1">
              <Building2 className="h-3 w-3" /> Base Plant
            </span>
            <select
              value={basePlant}
              onChange={e => setBasePlant(e.target.value)}
              className="px-2.5 py-1.5 text-xs border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500/30 focus:border-blue-500 bg-white min-w-[140px]"
            >
              {plantGroups.map(g => (
                <option key={g.plant} value={g.plant}>{g.plant} ({g.rows.length})</option>
              ))}
            </select>
          </label>

          <ArrowRight className="h-4 w-4 text-gray-300 mb-2" />

          <label className="flex flex-col gap-1">
            <span className="text-[10px] font-semibold uppercase tracking-wide text-gray-400 flex items-center gap-1">
              <Building2 className="h-3 w-3" /> Compare With (optional)
            </span>
            <select
              value={targetPlant}
              onChange={e => setTargetPlant(e.target.value)}
              className="px-2.5 py-1.5 text-xs border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-indigo-500/30 focus:border-indigo-500 bg-white min-w-[160px]"
            >
              <option value="">— Same plant only —</option>
              {plantGroups.filter(g => g.plant !== basePlant).map(g => (
                <option key={g.plant} value={g.plant}>{g.plant} ({g.rows.length})</option>
              ))}
            </select>
          </label>

          {/* Look-back window (days) */}
          <label className="flex flex-col gap-1">
            <span className="text-[10px] font-semibold uppercase tracking-wide text-gray-400 flex items-center gap-1">
              <CalendarClock className="h-3 w-3" /> Window (days)
            </span>
            <div className="flex items-center gap-1">
              <input
                type="number" min={1} max={3650}
                value={windowDays}
                onChange={e => setWindowDays(Math.max(1, Number(e.target.value) || 1))}
                className="w-20 px-2.5 py-1.5 text-xs border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-emerald-500/30 focus:border-emerald-500 bg-white"
                title="Cheapest price is taken from POs within this many days before the latest PO date"
              />
              <div className="flex gap-0.5">
                {[30, 45, 90, 365].map(d => (
                  <button
                    key={d}
                    onClick={() => setWindowDays(d)}
                    className={`px-1.5 py-1 text-[10px] rounded font-semibold transition-colors ${windowDays === d ? 'bg-emerald-600 text-white' : 'bg-gray-100 text-gray-500 hover:bg-gray-200'}`}
                  >{d}</button>
                ))}
              </div>
            </div>
          </label>

          <span className="ml-auto text-[11px] text-gray-400 mb-1.5">Scope: <span className="font-semibold text-gray-600">{scopeLabel}</span></span>
        </div>

        {/* Summary cards */}
        <div className="px-5 py-3 grid grid-cols-2 sm:grid-cols-5 gap-3 border-b border-gray-100 bg-gray-50/50">
          <div className="bg-white rounded-xl border border-gray-200 p-3">
            <p className="text-[10px] uppercase tracking-wide text-gray-400">Cheapest price <span className="text-emerald-500">· {windowDays}d window</span></p>
            <p className="text-sm font-bold text-emerald-700 font-mono mt-0.5">{fmtUsd6(analysis.refPrice)}</p>
            <p className="text-[10px] text-gray-400 truncate mt-0.5" title={analysis.refRow?.supplier}>
              {analysis.refRow ? `${analysis.refRow.supplier} · ${analysis.refRow.plant}` : '—'}
            </p>
          </div>
          <div className="bg-white rounded-xl border border-gray-200 p-3">
            <p className="text-[10px] uppercase tracking-wide text-gray-400">Cheapest price all plants <span className="text-emerald-500">· {windowDays}d window</span></p>
            <p className="text-sm font-bold text-emerald-700 font-mono mt-0.5">{fmtUsd6(allPlantsAnalysis.refPrice)}</p>
            <p className="text-[10px] text-gray-400 truncate mt-0.5" title={allPlantsAnalysis.refRow?.supplier}>
              {allPlantsAnalysis.refRow ? `${allPlantsAnalysis.refRow.supplier} · ${allPlantsAnalysis.refRow.plant}` : '—'}
            </p>
          </div>
          <div className="bg-white rounded-xl border border-gray-200 p-3">
            <p className="text-[10px] uppercase tracking-wide text-gray-400">Price spread / unit</p>
            <p className="text-sm font-bold text-amber-700 font-mono mt-0.5">{analysis.unitSpread != null ? fmtUsd6(analysis.unitSpread) : '—'}</p>
            <p className="text-[10px] text-gray-400 mt-0.5">max {fmtUsd6(analysis.maxPrice || null)}</p>
          </div>
          <div className="bg-white rounded-xl border border-gray-200 p-3">
            <p className="text-[10px] uppercase tracking-wide text-gray-400">Suppliers in scope</p>
            <p className="text-sm font-bold text-gray-700 font-mono mt-0.5">{analysis.distinctSuppliers}</p>
            <p className="text-[10px] text-gray-400 mt-0.5">{analysis.lines.length} record{analysis.lines.length !== 1 ? 's' : ''}</p>
          </div>
          <div className="bg-gradient-to-br from-emerald-50 to-green-50 rounded-xl border border-emerald-200 p-3">
            <p className="text-[10px] uppercase tracking-wide text-emerald-500">Potential saving</p>
            <p className="text-sm font-bold text-emerald-700 font-mono mt-0.5">{fmtUsd2(analysis.totalQtySaving)}</p>
            <p className="text-[10px] text-emerald-500/80 mt-0.5">if all align to cheapest</p>
          </div>
        </div>

        {/* Demand band (from the active dbquery demand DB) */}
        <div className="px-5 py-2.5 border-b border-gray-100 bg-indigo-50/40">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="text-[10px] font-bold uppercase tracking-wide text-indigo-500">MPN Demand</span>
            {demandLoading ? (
              <span className="inline-flex items-center gap-1 text-[11px] text-indigo-500">
                <svg className="animate-spin h-3 w-3" fill="none" viewBox="0 0 24 24"><circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" /><path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8H4z" /></svg>
                loading…
              </span>
            ) : demandTotals ? (
              <>
                <span className="text-[11px] text-gray-600">Total EAU <span className="font-bold text-indigo-700 font-mono">{demandTotals.eau.toLocaleString()}</span></span>
                <span className="text-gray-300">·</span>
                <span className="text-[11px] text-gray-600">Onhand Qty <span className="font-bold text-indigo-700 font-mono">{demandTotals.onhand.toLocaleString()}</span></span>
                <span className="text-gray-300">·</span>
                <span className="text-[11px] text-gray-600">Gross Demand <span className="font-bold text-indigo-700 font-mono">{demandTotals.gross.toLocaleString()}</span></span>
                <span className="ml-1 text-[10px] text-gray-400">(grand total · {demandTotals.totalRows} demand row{demandTotals.totalRows !== 1 ? 's' : ''})</span>
              </>
            ) : (
              <span className="text-[11px] text-gray-400 italic">No demand data for this MPN in the active demand database.</span>
            )}
          </div>

          {/* Per-plant breakdown of the same totals */}
          {!demandLoading && demandTotals && demandTotals.plants.length > 0 && (
            <div className="mt-2 flex flex-wrap gap-2">
              {demandTotals.plants.map(p => (
                <div key={p.plant} className="rounded-lg border border-indigo-100 bg-white px-2.5 py-1.5">
                  <div className="flex items-center gap-1.5">
                    <span className="text-[10px] font-bold font-mono text-indigo-700">{p.plant}</span>
                    <span className="text-[9px] text-gray-400">{p.rows} row{p.rows !== 1 ? 's' : ''}</span>
                  </div>
                  <div className="flex items-center gap-2 mt-0.5">
                    <span className="text-[10px] text-gray-500">EAU <span className="font-mono font-semibold text-gray-700">{p.eau.toLocaleString()}</span></span>
                    <span className="text-[10px] text-gray-500">Onhand <span className="font-mono font-semibold text-gray-700">{p.onhand.toLocaleString()}</span></span>
                    <span className="text-[10px] text-gray-500">Gross <span className="font-mono font-semibold text-gray-700">{p.gross.toLocaleString()}</span></span>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Comparison table */}
        <div className="flex-1 overflow-auto px-5 py-3">
          {analysis.lines.length === 0 ? (
            <p className="text-sm text-gray-400 italic text-center py-8">No priced records available for the selected plant(s).</p>
          ) : (
            <table className="min-w-full text-xs border-collapse">
              <thead className="bg-gray-50 text-[10px] uppercase tracking-wide text-gray-500 sticky top-0 z-[1]">
                <tr>
                  <th className="px-2.5 py-2 text-left whitespace-nowrap border-b border-gray-200">Plant</th>
                  <th className="px-2.5 py-2 text-left whitespace-nowrap border-b border-gray-200">Supplier</th>
                  <th className="px-2.5 py-2 text-right whitespace-nowrap border-b border-gray-200">Last PO (USD)</th>
                  <th className="px-2.5 py-2 text-right whitespace-nowrap border-b border-gray-200">STD (USD)</th>
                  <th className="px-2.5 py-2 text-right whitespace-nowrap border-b border-gray-200">Δ / unit</th>
                  <th className="px-2.5 py-2 text-right whitespace-nowrap border-b border-gray-200">PO Qty</th>
                  <th className="px-2.5 py-2 text-right whitespace-nowrap border-b border-gray-200">Potential Saving</th>
                  <th className="px-2.5 py-2 text-left whitespace-nowrap border-b border-gray-200">Date</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {[...analysis.lines]
                  .sort((a, b) => (a.price ?? Infinity) - (b.price ?? Infinity))
                  .map((l, i) => (
                    <tr key={i} className={`${l.isRef ? 'bg-emerald-50/70' : (l.saveTotal && l.saveTotal > 0 ? 'bg-amber-50/40 hover:bg-amber-50/70' : 'hover:bg-gray-50')} ${!l.within ? 'opacity-50' : ''}`}>
                      <td className="px-2.5 py-2 font-mono text-gray-700 whitespace-nowrap">{l.r.plant || '—'}</td>
                      <td className="px-2.5 py-2 text-gray-700 max-w-[200px] truncate" title={l.r.supplier}>
                        {l.isRef && <Trophy className="inline h-3 w-3 text-emerald-600 mr-1 -mt-0.5" />}
                        {l.r.supplier || '—'}
                      </td>
                      <td className={`px-2.5 py-2 text-right font-mono font-semibold whitespace-nowrap ${l.isRef ? 'text-emerald-700' : l.price === 0 ? 'bg-yellow-100 text-yellow-700' : l.price != null && l.r.stdUsd != null && l.price > l.r.stdUsd ? 'bg-red-100 text-red-700' : 'text-gray-700'}`}>{fmtUsd6(l.price)}</td>
                      <td className="px-2.5 py-2 text-right font-mono text-gray-600 whitespace-nowrap">{fmtUsd6(l.r.stdUsd)}</td>
                      <td className={`px-2.5 py-2 text-right font-mono whitespace-nowrap ${l.deltaUnit != null && l.deltaUnit > 0 ? 'text-red-600' : 'text-gray-400'}`}>
                        {l.deltaUnit != null && l.deltaUnit > 0 ? `+${fmtUsd6(l.deltaUnit)}` : (l.isRef ? '—' : fmtUsd6(l.deltaUnit))}
                      </td>
                      <td className="px-2.5 py-2 text-right font-mono text-gray-600 whitespace-nowrap">{l.qty != null ? l.qty.toLocaleString() : '—'}</td>
                      <td className={`px-2.5 py-2 text-right font-mono font-semibold whitespace-nowrap ${l.saveTotal && l.saveTotal > 0 ? 'text-emerald-700' : 'text-gray-300'}`}>
                        {l.saveTotal && l.saveTotal > 0 ? fmtUsd2(l.saveTotal) : (l.saveTotal == null ? 'n/a (no qty)' : '—')}
                      </td>
                      <td className="px-2.5 py-2 text-gray-500 whitespace-nowrap">
                        {l.r.lastPoDate || '—'}
                        {!l.within && l.price != null && l.price > 0 && (
                          <span className="ml-1.5 text-[9px] font-semibold bg-gray-200 text-gray-500 px-1 py-0.5 rounded uppercase tracking-wide" title={`Outside the ${windowDays}-day window — not eligible as the cheapest reference`}>out of window</span>
                        )}
                      </td>
                    </tr>
                  ))}
              </tbody>
            </table>
          )}
          <p className="text-[10px] text-gray-400 mt-3 leading-relaxed">
            <strong>How it works:</strong> the cheapest Last PO (USD) <strong>within the last {windowDays} days from the latest PO date</strong> is the
            reference (🏆). Rows outside that window are dimmed and can't set the reference. For every other supplier record,
            <em> Δ/unit</em> is its overspend per piece, and <em>Potential Saving</em> = Δ/unit × its PO quantity — the money that could be
            saved by buying that volume at the reference price. Pick a second plant to compare cross-plant suppliers.
          </p>
        </div>
        </>}

        {view === 'full' && (
          <div className="flex-1 overflow-hidden flex flex-col">
            <FullDemandView
              mpn={mpn}
              data={fullDemand ?? fullLocal}
              loading={fullDemandLoading || fullLocalLoading}
              bestPrice={analysis.refPrice}
              windowDays={windowDays}
              bestSupplier={analysis.refRow?.supplier ?? ''}
              bestPlant={analysis.refRow?.plant ?? ''}
              availablePlants={plantGroups.map(g => g.plant)}
              records={records}
            />
          </div>
        )}
      </div>
    </div>
  )
}

