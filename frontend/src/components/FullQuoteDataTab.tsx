// src/components/FullQuoteDataTab.tsx
// Full demand database view with procedural pagination (25 rows per page)
// Shows all demand data with FX rate conversions and savings calculations
import { useMemo, useState, useEffect } from 'react'
import { getCurrencyRate } from '../api/client'
import DataGrid, { DataGridColumn } from './DataGrid'

interface FullQuoteRow {
  [key: string]: string | number | null | undefined
  'TO USD'?: number
  'LAST PO QTY x TO USD'?: number
  'LAST PO QTY x BEST PRICE'?: number
  'PO SAVINGS'?: number
  'STD SAVINGS'?: number
  '_currencyEmpty'?: boolean
}

interface FullQuoteDataTabProps {
  data: { columns: string[]; rows: Array<Record<string, string | number | null>> } | null
  loading: boolean
  lastPoPriceCol: string
  poQtyCol: string
  currencyCol: string
  dateCol: string
  bestPrice: number | null
}

const PAGE_SIZE = 25

export default function FullQuoteDataTab({
  data,
  loading,
  lastPoPriceCol,
  poQtyCol,
  currencyCol,
  dateCol,
  bestPrice,
}: FullQuoteDataTabProps) {
  const [currentPage, setCurrentPage] = useState(0)
  const [currencyRates, setCurrencyRates] = useState<Record<string, number>>({})
  const [fxDiag, setFxDiag] = useState<{
    requested: number
    nonUnity: number
    fallback: number
    currencyCol: string
    dateCol: string
  }>({ requested: 0, nonUnity: 0, fallback: 0, currencyCol: '—', dateCol: '—' })

  const normalizeColumnName = (name: string) =>
    String(name ?? '').replace(/[^a-z0-9]+/gi, '').trim().toLowerCase()
  const resolveColumnName = (columns: string[], candidates: string[]) => {
    const map = new Map(columns.map(c => [normalizeColumnName(c), c]))
    for (const candidate of candidates) {
      const hit = map.get(normalizeColumnName(candidate))
      if (hit) return hit
    }
    const normalizedColumns = columns.map(c => ({ raw: c, norm: normalizeColumnName(c) }))
    for (const candidate of candidates) {
      const cand = normalizeColumnName(candidate)
      const loose = normalizedColumns.find(c => c.norm.includes(cand) || cand.includes(c.norm))
      if (loose) return loose.raw
    }
    return null
  }

  const discoverableColumns = useMemo(() => {
    if (!data) return []
    const fromRows = data.rows.length ? Object.keys(data.rows[0] ?? {}) : []
    return Array.from(new Set([...data.columns, ...fromRows]))
  }, [data])

  const resolvedPriceCol = useMemo(
    () => discoverableColumns.length
      ? resolveColumnName(discoverableColumns, ['LAST PO ITEM PRICE', 'Last PO Item Price'])
      : null,
    [discoverableColumns]
  )
  const resolvedQtyCol = useMemo(
    () => discoverableColumns.length
      ? resolveColumnName(discoverableColumns, ['PURCHASE ORDER QUANTITY', 'Purchase Order Quantity'])
      : null,
    [discoverableColumns]
  )
  const resolvedCurrencyCol = useMemo(
    () => discoverableColumns.length
      ? resolveColumnName(discoverableColumns, ['CURRENCY.2', 'CURRENCY 2', 'Currency', 'Currency 2'])
      : null,
    [discoverableColumns]
  )
  const resolvedDateCol = useMemo(
    () => discoverableColumns.length
      ? resolveColumnName(discoverableColumns, [
          'LAST ORDERER ON',
          'Last Orderer On',
          'LAST ORDERED ON',
          'Last Ordered On',
          'Last PO Date',
          'PO Date',
        ])
      : null,
    [discoverableColumns]
  )
  const resolvedStdPriceCol = useMemo(
    () => discoverableColumns.length
      ? resolveColumnName(discoverableColumns, ['STANDARD PRICE', 'Standard Price', 'STD PRICE', 'Std Price'])
      : null,
    [discoverableColumns]
  )

  const rawRows = data?.rows || []
  const totalRows = rawRows.length
  const totalPages = Math.ceil(totalRows / PAGE_SIZE)
  
  const paginatedRows = useMemo(() => 
    rawRows.slice(currentPage * PAGE_SIZE, (currentPage + 1) * PAGE_SIZE),
    [currentPage, rawRows]
  )

  // Fetch FX rates whenever the page changes
  useEffect(() => {
    if (!resolvedCurrencyCol || !resolvedDateCol || !data?.rows.length) {
      setFxDiag({ requested: 0, nonUnity: 0, fallback: 0, currencyCol: resolvedCurrencyCol ?? '—', dateCol: resolvedDateCol ?? '—' })
      return
    }

    // Recalculate paginated rows here to avoid dependency on a changing value
    const paginatedRows = data.rows.slice(currentPage * PAGE_SIZE, (currentPage + 1) * PAGE_SIZE)
    
    const pending = new Map<string, { currency: string; date: string }>()
    const seen = new Set<string>()

    for (const row of paginatedRows) {
      const rawCurrency = String(row[resolvedCurrencyCol] ?? '').trim()
      const rawDate = String(row[resolvedDateCol] ?? '').trim()
      const currency = rawCurrency.toUpperCase()
      if (!currency || currency === 'USD') continue
      const normalizedDate = rawDate ? rawDate.slice(0, 10) : ''
      if (!normalizedDate) continue
      const key = `${currency}|${normalizedDate}`
      if (seen.has(key)) continue
      seen.add(key)
      pending.set(key, { currency, date: normalizedDate })
    }

    if (!pending.size) {
      setFxDiag({
        requested: 0,
        nonUnity: 0,
        fallback: 0,
        currencyCol: resolvedCurrencyCol ?? '—',
        dateCol: resolvedDateCol ?? '—',
      })
      return
    }

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
        setCurrencyRates(prev => ({ ...prev, ...nextRates }))
        setFxDiag({
          requested,
          nonUnity,
          fallback,
          currencyCol: resolvedCurrencyCol ?? '—',
          dateCol: resolvedDateCol ?? '—',
        })
      }
    }

    void run()
    return () => {
      cancelled = true
    }
  }, [currentPage, resolvedCurrencyCol, resolvedDateCol, data])

  const displayRows = useMemo(() => {
    if (!paginatedRows.length) return []

    return paginatedRows.map(row => {
      const priceValue = Number(row[resolvedPriceCol ?? lastPoPriceCol] ?? 0)
      const qtyValue = Number(row[resolvedQtyCol ?? poQtyCol] ?? 0)
      const stdPriceValue = Number(row[resolvedStdPriceCol ?? ''] ?? 0)
      const currencyRaw = row[resolvedCurrencyCol ?? '']
      const currencyValue = String(currencyRaw ?? '').trim().toUpperCase()
      const dateValue = String(row[resolvedDateCol ?? ''] ?? '').trim()
      const dateKey = dateValue ? dateValue.slice(0, 10) : ''
      const rate = currencyValue && currencyValue !== 'USD' && dateKey ? currencyRates[`${currencyValue}|${dateKey}`] ?? 1 : 1

      const currencyToUsd =
        !Number.isNaN(priceValue) && priceValue > 0 && currencyValue && currencyValue !== 'USD' && rate > 0
          ? priceValue / rate
          : priceValue

      const total = currencyToUsd * (Number.isFinite(qtyValue) ? qtyValue : 0)
      const qtyXBestPrice = bestPrice != null && Number.isFinite(qtyValue) ? bestPrice * qtyValue : 0
      const poSavings = total - qtyXBestPrice
      const stdSavings = stdPriceValue * qtyValue - qtyXBestPrice

      return {
        ...row,
        'TO USD': Number.isFinite(currencyToUsd) ? Number(currencyToUsd.toFixed(6)) : '',
        'LAST PO QTY x TO USD': Number.isFinite(total) ? Number(total.toFixed(2)) : '',
        'LAST PO QTY x BEST PRICE': Number.isFinite(qtyXBestPrice) ? Number(qtyXBestPrice.toFixed(2)) : '',
        'PO SAVINGS': Number.isFinite(poSavings) ? Number(poSavings.toFixed(2)) : '',
        'STD SAVINGS': Number.isFinite(stdSavings) ? Number(stdSavings.toFixed(2)) : '',
        '_currencyEmpty': !currencyValue || currencyValue.trim() === '',
      }
    })
  }, [paginatedRows, currencyRates, lastPoPriceCol, poQtyCol, resolvedPriceCol, resolvedQtyCol, resolvedCurrencyCol, resolvedDateCol, resolvedStdPriceCol, bestPrice])

  if (loading) {
    return (
      <div className="p-6 flex items-center justify-center">
        <div className="text-sm text-gray-500">Loading full demand data…</div>
      </div>
    )
  }

  if (!data || !data.columns.length || !data.rows.length) {
    return (
      <div className="p-6 text-sm text-gray-500 space-y-2">
        <div>❌ No demand database loaded yet.</div>
        <div className="text-xs text-gray-400 space-y-1 bg-gray-50 p-3 rounded border border-gray-200 font-mono">
          <div className="font-bold text-gray-600">Debug Info:</div>
          <div>• Data prop exists: {data ? 'yes' : 'no'}</div>
          <div>• Columns: {data?.columns?.length ?? 0}</div>
          <div>• Rows: {data?.rows?.length ?? 0}</div>
          {data && (
            <>
              <div>• First column: {data.columns?.[0] ?? 'N/A'}</div>
              <div>• Sample row keys: {data.rows?.[0] ? Object.keys(data.rows[0]).slice(0, 3).join(', ') : 'N/A'}</div>
            </>
          )}
          <div className="mt-2 text-gray-500">👉 Check browser console for full API response</div>
        </div>
      </div>
    )
  }

  const excludedColumnNames = new Set(['PLANT_CODE', 'PLANT_NAME', 'PRICE UNIT2', 'CURRENCY3', 'PRICE UNIT4', 'CURRENCY5'])
  const normalizedColumnName = (name: string) => String(name ?? '').replace(/\s+/g, ' ').trim().toUpperCase()
  const visibleColumns = data.columns.filter(c => !excludedColumnNames.has(normalizedColumnName(c)))

  const cols: DataGridColumn<FullQuoteRow>[] = visibleColumns.map((c, i) => {
    const normalized = normalizedColumnName(c)
    let width = ''
    if (i === 0) {
      width = 'sticky left-0 z-[2] bg-white'
    } else if (
      normalized.includes('PRICE') ||
      normalized.includes('QUANTITY') ||
      normalized.includes('QTY') ||
      normalized.includes('DATE') ||
      normalized.includes('CURRENCY')
    ) {
      width = 'w-24'
    } else if (normalized.includes('PLANT') || normalized.includes('SUPPLIER')) {
      width = 'flex-1 min-w-32'
    }

    return {
      key: c,
      header: c,
      accessor: r => r[c] ?? '',
      render: r => {
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
    key: 'best_price_for_all',
    header: 'BEST PRICE',
    accessor: () => (bestPrice == null ? '' : String(bestPrice)),
    render: () => (bestPrice == null ? '—' : String(bestPrice)),
    type: 'number',
    align: 'right',
    width: 'w-20',
  })

  cols.push({
    key: 'TO USD',
    header: 'LAST PO ITEM PRICE TO USD',
    accessor: r => r['TO USD'] ?? '',
    render: r => {
      const v = r['TO USD']
      const isEmpty = r['_currencyEmpty']
      if (v == null || v === '') return '—'
      const cls = isEmpty ? 'bg-yellow-100 text-yellow-700' : 'text-gray-700'
      return (
        <span className={`inline-block w-full ${cls}`}>{String(v)}</span>
      )
    },
    type: 'number',
    align: 'right',
    width: 'w-24',
  })

  cols.push({
    key: 'PO QTY x TO CURRENCY',
    header: 'LAST PO QTY x TO USD',
    accessor: r => r['LAST PO QTY x TO USD'] ?? '',
    render: r => {
      const v = r['LAST PO QTY x TO USD']
      const isEmpty = r['_currencyEmpty']
      if (v == null || v === '') return '—'
      const cls = isEmpty ? 'bg-yellow-100 text-yellow-700' : 'text-gray-700'
      return (
        <span className={`inline-block w-full ${cls}`}>{String(v)}</span>
      )
    },
    type: 'number',
    align: 'right',
    width: 'w-28',
  })

  cols.push({
    key: 'PO SAVINGS',
    header: 'PO SAVINGS',
    accessor: r => r['PO SAVINGS'] ?? '',
    render: r => {
      const v = r['PO SAVINGS']
      if (v == null || v === '') return '—'
      const n = typeof v === 'number' ? v : Number(v)
      const cls = n > 0 ? 'bg-emerald-100 text-emerald-700' : n < 0 ? 'bg-red-100 text-red-700' : 'text-gray-700'
      return (
        <span className={`inline-block w-full ${cls}`}>{String(v)}</span>
      )
    },
    type: 'number',
    align: 'right',
    width: 'w-24',
  })

  cols.push({
    key: 'STD SAVINGS',
    header: 'STD SAVINGS',
    accessor: r => r['STD SAVINGS'] ?? '',
    render: r => {
      const v = r['STD SAVINGS']
      if (v == null || v === '') return '—'
      const n = typeof v === 'number' ? v : Number(v)
      const cls = n > 0 ? 'bg-emerald-100 text-emerald-700' : n < 0 ? 'bg-red-100 text-red-700' : 'text-gray-700'
      return (
        <span className={`inline-block w-full ${cls}`}>{String(v)}</span>
      )
    },
    type: 'number',
    align: 'right',
    width: 'w-24',
  })

  return (
    <div className="flex flex-col h-full overflow-hidden p-4 gap-2">
      {/* Header info */}
      <div className="text-[11px] text-gray-600 shrink-0 flex flex-wrap items-center gap-3">
        <span>
          Full demand database · Total rows: <span className="font-mono font-bold">{totalRows.toLocaleString()}</span> · Best price (all plants): <span className="font-mono font-bold">{bestPrice != null ? String(bestPrice) : '—'}</span>
        </span>
      </div>

      {/* Pagination controls */}
      <div className="text-[11px] text-gray-600 shrink-0 flex flex-wrap items-center gap-3 justify-between">
        <div className="flex items-center gap-2">
          <button
            onClick={() => setCurrentPage(Math.max(0, currentPage - 1))}
            disabled={currentPage === 0}
            className="px-2 py-1 border border-gray-200 rounded text-xs font-medium disabled:opacity-40 hover:bg-gray-100"
          >
            ← Prev
          </button>
          <span className="font-mono text-gray-500">
            Page <span className="font-bold text-gray-700">{currentPage + 1}</span> of <span className="font-bold text-gray-700">{totalPages}</span> · Rows {(currentPage * PAGE_SIZE + 1).toLocaleString()} – {Math.min((currentPage + 1) * PAGE_SIZE, totalRows).toLocaleString()}
          </span>
          <button
            onClick={() => setCurrentPage(Math.min(totalPages - 1, currentPage + 1))}
            disabled={currentPage >= totalPages - 1}
            className="px-2 py-1 border border-gray-200 rounded text-xs font-medium disabled:opacity-40 hover:bg-gray-100"
          >
            Next →
          </button>
        </div>
        <span className="text-gray-400">
          · FX calls: <span className="font-mono">{fxDiag.requested}</span> | rate≠1: <span className="font-mono">{fxDiag.nonUnity}</span> | fallback: <span className="font-mono">{fxDiag.fallback}</span>
        </span>
      </div>

      {/* DataGrid */}
      <div className="flex-1 min-h-0 overflow-auto">
        <DataGrid
          rows={displayRows}
          columns={cols}
          rowKey={(r, i) => `${currentPage}-${i}`}
          pageSize={PAGE_SIZE}
          exportFileName={`fullquote_${new Date().toISOString().slice(0, 10)}`}
          exportSheetName={`FullQuote_Page${currentPage + 1}`}
          defaultShowFilters={true}
          freezeFirstColumn={true}
        />
      </div>
    </div>
  )
}
