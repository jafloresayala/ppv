// src/tabs/TabData.tsx — Full raw-data viewer with pagination
import { useState, useEffect, useCallback } from 'react'
import { usePPV } from '../store/ppvStore'
import { getRawData, type RawDataResponse } from '../api/client'
import { ChevronLeft, ChevronRight, Download, RefreshCw, Search } from 'lucide-react'

const PAGE_SIZE_OPTIONS = [50, 100, 200, 500]

// Columns to pin at the left for readability
const PRIORITY_COLS = [
  'Plant', 'Posting_Date_in_the_Document', 'Posting_Date', 'YearMonth',
  'Material_Number', 'Material_Description', 'Vendor_Name', 'Vendor_Code',
  'Report_Currency', 'PPDifference_currency', 'P_Price_difference_num',
  'Total_Variance_Amount_num', 'Exchange_rate_difference_num', 'Quantity_num',
]

function sortColumns(cols: string[]): string[] {
  const priority = cols.filter(c => PRIORITY_COLS.includes(c))
    .sort((a, b) => PRIORITY_COLS.indexOf(a) - PRIORITY_COLS.indexOf(b))
  const rest = cols.filter(c => !PRIORITY_COLS.includes(c)).sort()
  return [...priority, ...rest]
}

function fmtCell(val: unknown): string {
  if (val == null) return '—'
  if (typeof val === 'number') {
    if (!isFinite(val)) return '—'
    // Heuristic: if integer-ish and < 10k, show without decimals
    if (Number.isInteger(val)) return val.toLocaleString('en-US')
    return val.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 6 })
  }
  return String(val)
}

function isNumericCol(records: Record<string, unknown>[], col: string): boolean {
  for (const r of records) {
    const v = r[col]
    if (v != null) return typeof v === 'number'
  }
  return false
}

function downloadCSV(columns: string[], records: Record<string, unknown>[], filename = 'ppv_data.csv') {
  const escape = (v: unknown) => {
    const s = v == null ? '' : String(v)
    return s.includes(',') || s.includes('"') || s.includes('\n')
      ? `"${s.replace(/"/g, '""')}"`
      : s
  }
  const header = columns.map(escape).join(',')
  const rows   = records.map(r => columns.map(c => escape(r[c])).join(','))
  const blob   = new Blob([[header, ...rows].join('\n')], { type: 'text/csv' })
  const url    = URL.createObjectURL(blob)
  const a      = document.createElement('a')
  a.href = url; a.download = filename; a.click()
  URL.revokeObjectURL(url)
}

export default function TabData() {
  const { sessionId, selectedGroups, selectedVendors, selectedPlants, selectedDateRange } = usePPV()

  const [resp,      setResp]      = useState<RawDataResponse | null>(null)
  const [loading,   setLoading]   = useState(false)
  const [error,     setError]     = useState<string | null>(null)
  const [page,      setPage]      = useState(1)
  const [pageSize,  setPageSize]  = useState(100)
  const [colFilter, setColFilter] = useState('')

  const buildFilters = useCallback(() => {
    const f: Record<string, unknown> = {}
    if (selectedGroups.length)  f.material_groups = selectedGroups
    if (selectedVendors.length) f.vendors          = selectedVendors
    if (selectedPlants.length)  f.plants           = selectedPlants
    if (selectedDateRange)      { f.date_start = selectedDateRange.start; f.date_end = selectedDateRange.end }
    return f
  }, [selectedGroups, selectedVendors, selectedPlants, selectedDateRange])

  const fetchPage = useCallback(async (p: number, ps: number) => {
    if (!sessionId) return
    setLoading(true)
    setError(null)
    try {
      const data = await getRawData(sessionId, buildFilters() as any, p, ps)
      setResp(data)
      setPage(data.page)
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'Error loading data')
    } finally {
      setLoading(false)
    }
  }, [sessionId, buildFilters])

  // Initial load when tab mounts / session changes
  useEffect(() => {
    if (sessionId) {
      setPage(1)
      fetchPage(1, pageSize)
    }
  }, [sessionId]) // eslint-disable-line react-hooks/exhaustive-deps

  if (!sessionId)
    return <p className="text-sm text-slate-400 italic">No data loaded yet.</p>

  const columns = resp ? sortColumns(resp.columns) : []
  const visibleCols = colFilter.trim()
    ? columns.filter(c => c.toLowerCase().includes(colFilter.toLowerCase()))
    : columns

  const numericCols = new Set(resp ? visibleCols.filter(c => isNumericCol(resp.records, c)) : [])

  const totalPages = resp?.total_pages ?? 1
  const totalRows  = resp?.total_rows  ?? 0

  function goTo(p: number) {
    const np = Math.max(1, Math.min(p, totalPages))
    fetchPage(np, pageSize)
  }

  function changePageSize(ps: number) {
    setPageSize(ps)
    fetchPage(1, ps)
  }

  return (
    <div className="flex flex-col gap-3">
      {/* Toolbar */}
      <div className="flex flex-wrap items-center gap-2 bg-white border border-slate-200 rounded-xl px-4 py-2.5 shadow-sm">
        {/* Column search */}
        <div className="relative flex-1 min-w-[160px] max-w-xs">
          <Search size={13} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-slate-400 pointer-events-none" />
          <input
            type="text"
            value={colFilter}
            onChange={e => setColFilter(e.target.value)}
            placeholder="Filter columns…"
            className="w-full pl-7 pr-3 py-1.5 text-xs border border-slate-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-brand/30"
          />
        </div>

        {/* Row count info */}
        <span className="text-xs text-slate-500 ml-auto">
          {totalRows.toLocaleString('en-US')} rows · {columns.length} columns
        </span>

        {/* Page size selector */}
        <select
          value={pageSize}
          onChange={e => changePageSize(Number(e.target.value))}
          className="text-xs border border-slate-200 rounded-lg px-2 py-1.5 bg-white focus:outline-none focus:ring-2 focus:ring-brand/30"
        >
          {PAGE_SIZE_OPTIONS.map(n => (
            <option key={n} value={n}>{n} / page</option>
          ))}
        </select>

        {/* Refresh */}
        <button
          onClick={() => fetchPage(page, pageSize)}
          disabled={loading}
          className="p-1.5 rounded-lg border border-slate-200 text-slate-500 hover:bg-slate-50 disabled:opacity-40"
          title="Refresh"
        >
          <RefreshCw size={13} className={loading ? 'animate-spin' : ''} />
        </button>

        {/* Export current page as CSV */}
        {resp && (
          <button
            onClick={() => downloadCSV(visibleCols, resp.records)}
            className="flex items-center gap-1.5 text-xs font-medium border border-slate-200 rounded-lg px-2.5 py-1.5 text-slate-600 hover:bg-slate-50"
            title="Download current page as CSV"
          >
            <Download size={13} />
            CSV
          </button>
        )}
      </div>

      {/* Error */}
      {error && (
        <div className="text-sm text-red-600 bg-red-50 border border-red-200 rounded-xl px-4 py-2">{error}</div>
      )}

      {/* Table */}
      <div className="bg-white border border-slate-200 rounded-xl shadow-sm overflow-hidden">
        <div className="overflow-auto max-h-[60vh]">
          {loading && !resp ? (
            <div className="flex items-center justify-center h-40">
              <RefreshCw size={20} className="animate-spin text-brand" />
            </div>
          ) : resp && resp.records.length > 0 ? (
            <table className="text-xs w-full border-collapse">
              <thead className="sticky top-0 z-[1] bg-slate-50 border-b border-slate-200">
                <tr>
                  <th className="text-right font-medium text-slate-400 px-3 py-2 w-10">#</th>
                  {visibleCols.map(col => (
                    <th
                      key={col}
                      className={`whitespace-nowrap font-semibold text-slate-600 px-3 py-2 border-l border-slate-100 ${
                        numericCols.has(col) ? 'text-right' : 'text-left'
                      }`}
                    >
                      {col}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {resp.records.map((row, i) => {
                  const rowNum = (page - 1) * pageSize + i + 1
                  return (
                    <tr
                      key={i}
                      className="border-b border-slate-100 last:border-0 hover:bg-slate-50 transition-colors"
                    >
                      <td className="text-right text-slate-300 font-mono px-3 py-1.5 select-none">{rowNum}</td>
                      {visibleCols.map(col => {
                        const val = row[col]
                        const isNum = numericCols.has(col)
                        const isNeg = isNum && typeof val === 'number' && val < 0
                        const isPos = isNum && typeof val === 'number' && val > 0
                        return (
                          <td
                            key={col}
                            className={`px-3 py-1.5 border-l border-slate-100 whitespace-nowrap ${
                              isNum ? 'text-right font-mono' : 'text-left'
                            } ${isNeg ? 'text-red-600' : isPos ? 'text-emerald-700' : 'text-slate-700'}`}
                          >
                            {fmtCell(val)}
                          </td>
                        )
                      })}
                    </tr>
                  )
                })}
              </tbody>
            </table>
          ) : (
            <p className="text-sm text-slate-400 italic text-center py-10">No records found.</p>
          )}
        </div>
      </div>

      {/* Pagination */}
      {resp && totalPages > 1 && (
        <div className="flex items-center justify-center gap-2">
          <button
            onClick={() => goTo(page - 1)}
            disabled={page <= 1 || loading}
            className="p-1.5 rounded-lg border border-slate-200 text-slate-500 hover:bg-slate-50 disabled:opacity-40"
          >
            <ChevronLeft size={14} />
          </button>

          {/* Page numbers (window of 5) */}
          {Array.from({ length: Math.min(5, totalPages) }, (_, i) => {
            let p = page - 2 + i
            if (p < 1) p = i + 1
            if (p > totalPages) p = totalPages - (4 - i)
            return Math.max(1, Math.min(totalPages, p))
          })
            .filter((v, i, a) => a.indexOf(v) === i)
            .map(p => (
              <button
                key={p}
                onClick={() => goTo(p)}
                disabled={loading}
                className={`min-w-[32px] h-8 rounded-lg border text-xs font-medium transition-colors disabled:opacity-40 ${
                  p === page
                    ? 'bg-brand text-white border-brand'
                    : 'border-slate-200 text-slate-600 hover:bg-slate-50'
                }`}
              >
                {p}
              </button>
            ))}

          <button
            onClick={() => goTo(page + 1)}
            disabled={page >= totalPages || loading}
            className="p-1.5 rounded-lg border border-slate-200 text-slate-500 hover:bg-slate-50 disabled:opacity-40"
          >
            <ChevronRight size={14} />
          </button>

          <span className="text-xs text-slate-400 ml-2">
            Page {page} of {totalPages.toLocaleString('en-US')}
          </span>
        </div>
      )}
    </div>
  )
}
