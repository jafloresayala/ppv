// src/components/DataGrid.tsx
// Reusable high-performance data grid: paginated, searchable, per-column typed
// filters, and Excel export. Designed for large datasets (thousands of rows)
// where rendering every row at once would freeze the UI.
import { useState, useMemo, useEffect, useCallback, type ReactNode } from 'react'
import {
  Search, X, ChevronLeft, ChevronRight, ChevronsLeft, ChevronsRight,
  Download, Filter, ArrowUp, ArrowDown, ArrowUpDown,
} from 'lucide-react'

// ── Types ──────────────────────────────────────────────────────────────────

export type ColumnType = 'text' | 'number' | 'date' | 'select'

export interface DataGridColumn<T> {
  /** Stable key used internally and for Excel export header. */
  key: string
  /** Header label shown in the UI. */
  header: string
  /** Column data type — drives the per-column filter UI. */
  type?: ColumnType
  /** Pull the raw, filterable/sortable value from a row. */
  accessor: (row: T) => string | number | null | undefined
  /** Optional custom cell renderer (rich content). Falls back to accessor. */
  render?: (row: T, rowIndex: number) => ReactNode
  /** Text alignment. */
  align?: 'left' | 'right' | 'center'
  /** Disable sorting on this column. */
  noSort?: boolean
  /** Disable the per-column filter on this column. */
  noFilter?: boolean
  /** Extra <th>/<td> className. */
  className?: string
  /** Value used for Excel export (defaults to accessor). */
  exportValue?: (row: T) => string | number | null | undefined
}

interface DataGridProps<T> {
  rows: T[]
  columns: DataGridColumn<T>[]
  /** Stable React key per row. */
  rowKey: (row: T, index: number) => string | number
  /** Rows per page. Default 50. */
  pageSize?: number
  /** Optional per-row className (e.g. conditional highlight). */
  rowClassName?: (row: T, index: number) => string
  /** Excel file name (without extension). */
  exportFileName?: string
  /** Sheet name for the Excel export. */
  exportSheetName?: string
  /** Optional extra content rendered before the first data row (e.g. spinners). */
  prepend?: ReactNode
  /** Optional extra content rendered after the last data row. */
  append?: ReactNode
  /** Compact density. */
  dense?: boolean
  /** Show the per-column filter row by default (still toggleable). Default true. */
  defaultShowFilters?: boolean
  /** Optional click handler per row (e.g. open a detail/comparison panel). */
  onRowClick?: (row: T, index: number) => void
}

// ── Helpers ────────────────────────────────────────────────────────────────

const PAGE_SIZE_OPTIONS = [25, 50, 100, 250]

function asComparable(v: string | number | null | undefined, type?: ColumnType): number | string {
  if (v == null) return type === 'number' || type === 'date' ? -Infinity : ''
  if (type === 'number') return typeof v === 'number' ? v : parseFloat(String(v)) || -Infinity
  if (type === 'date') { const t = new Date(String(v)).getTime(); return isNaN(t) ? -Infinity : t }
  return String(v).toLowerCase()
}

/** Per-column filter value. Text/select use a string; number/date use min/max. */
interface ColFilter { text: string; min: string; max: string; select: string }
const EMPTY_FILTER: ColFilter = { text: '', min: '', max: '', select: '' }

function filterMatch<T>(col: DataGridColumn<T>, f: ColFilter, row: T): boolean {
  const raw = col.accessor(row)
  const type = col.type ?? 'text'
  if (type === 'number') {
    const n = raw == null ? null : (typeof raw === 'number' ? raw : parseFloat(String(raw)))
    if (f.min !== '' && (n == null || n < parseFloat(f.min))) return false
    if (f.max !== '' && (n == null || n > parseFloat(f.max))) return false
    return true
  }
  if (type === 'date') {
    const t = raw == null ? NaN : new Date(String(raw)).getTime()
    if (f.min !== '') { const tm = new Date(f.min).getTime(); if (isNaN(t) || t < tm) return false }
    if (f.max !== '') { const tm = new Date(f.max).getTime() + 86399999; if (isNaN(t) || t > tm) return false }
    return true
  }
  if (type === 'select') {
    if (f.select === '') return true
    return String(raw ?? '') === f.select
  }
  // text
  if (f.text === '') return true
  return String(raw ?? '').toLowerCase().includes(f.text.toLowerCase())
}

// ── Component ──────────────────────────────────────────────────────────────

export default function DataGrid<T>({
  rows, columns, rowKey, pageSize = 50, rowClassName,
  exportFileName = 'export', exportSheetName = 'Data',
  prepend, append, dense = false, defaultShowFilters = true, onRowClick,
}: DataGridProps<T>) {
  const [page, setPage]         = useState(0)
  const [perPage, setPerPage]   = useState(pageSize)
  const [globalQuery, setGQ]    = useState('')
  const [filters, setFilters]   = useState<Record<string, ColFilter>>({})
  const [showFilters, setShow]  = useState(defaultShowFilters)
  const [sortKey, setSortKey]   = useState<string | null>(null)
  const [sortDir, setSortDir]   = useState<'asc' | 'desc'>('asc')
  const [exporting, setExporting] = useState(false)

  // Pre-compute distinct values for `select` columns (for the dropdown).
  const selectOptions = useMemo(() => {
    const map: Record<string, string[]> = {}
    for (const col of columns) {
      if (col.type !== 'select') continue
      const set = new Set<string>()
      for (const r of rows) { const v = col.accessor(r); if (v != null && v !== '') set.add(String(v)) }
      map[col.key] = [...set].sort()
    }
    return map
  }, [columns, rows])

  // Global text search across all column accessors.
  const searched = useMemo(() => {
    const q = globalQuery.trim().toLowerCase()
    if (!q) return rows
    return rows.filter(r => columns.some(c => String(c.accessor(r) ?? '').toLowerCase().includes(q)))
  }, [rows, columns, globalQuery])

  // Per-column filters.
  const filtered = useMemo(() => {
    const active = columns.filter(c => filters[c.key] && (
      filters[c.key].text || filters[c.key].min || filters[c.key].max || filters[c.key].select
    ))
    if (!active.length) return searched
    return searched.filter(r => active.every(c => filterMatch(c, filters[c.key], r)))
  }, [searched, columns, filters])

  // Sorting.
  const sorted = useMemo(() => {
    if (!sortKey) return filtered
    const col = columns.find(c => c.key === sortKey)
    if (!col) return filtered
    const arr = [...filtered]
    arr.sort((a, b) => {
      const av = asComparable(col.accessor(a), col.type)
      const bv = asComparable(col.accessor(b), col.type)
      if (av < bv) return sortDir === 'asc' ? -1 : 1
      if (av > bv) return sortDir === 'asc' ? 1 : -1
      return 0
    })
    return arr
  }, [filtered, columns, sortKey, sortDir])

  const total      = sorted.length
  const pageCount  = Math.max(1, Math.ceil(total / perPage))
  const safePage   = Math.min(page, pageCount - 1)
  const pageRows   = useMemo(
    () => sorted.slice(safePage * perPage, safePage * perPage + perPage),
    [sorted, safePage, perPage],
  )

  // Reset to first page whenever filters/search/sort change the result set.
  useEffect(() => { setPage(0) }, [globalQuery, filters, perPage, sortKey, sortDir])

  const activeFilterCount = useMemo(
    () => columns.filter(c => filters[c.key] && (
      filters[c.key].text || filters[c.key].min || filters[c.key].max || filters[c.key].select
    )).length,
    [columns, filters],
  )

  const setColFilter = useCallback((key: string, patch: Partial<ColFilter>) => {
    setFilters(prev => ({ ...prev, [key]: { ...EMPTY_FILTER, ...prev[key], ...patch } }))
  }, [])

  const clearAll = useCallback(() => { setFilters({}); setGQ(''); setSortKey(null) }, [])

  const toggleSort = useCallback((key: string) => {
    setSortKey(prev => {
      if (prev !== key) { setSortDir('asc'); return key }
      setSortDir(d => (d === 'asc' ? 'desc' : 'asc'))
      return key
    })
  }, [])

  // Excel export — exports the *filtered/sorted* result set (all pages).
  const handleExport = useCallback(async () => {
    setExporting(true)
    try {
      const ExcelJS = (await import('exceljs')).default
      const wb = new ExcelJS.Workbook()
      const ws = wb.addWorksheet(exportSheetName.slice(0, 31) || 'Data')
      ws.columns = columns.map(c => ({
        header: c.header, key: c.key,
        width: Math.min(40, Math.max(12, c.header.length + 4)),
      }))
      for (const r of sorted) {
        const obj: Record<string, string | number | null> = {}
        for (const c of columns) {
          const v = (c.exportValue ?? c.accessor)(r)
          obj[c.key] = (v ?? '') as string | number | null
        }
        ws.addRow(obj)
      }
      // Header style
      ws.getRow(1).font = { bold: true, color: { argb: 'FFFFFFFF' } }
      ws.getRow(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF2563EB' } }
      ws.getRow(1).alignment = { vertical: 'middle' }
      ws.views = [{ state: 'frozen', ySplit: 1 }]
      ws.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: columns.length } }
      const buf = await wb.xlsx.writeBuffer()
      const blob = new Blob([buf], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' })
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = `${exportFileName}.xlsx`
      a.click()
      URL.revokeObjectURL(url)
    } finally {
      setExporting(false)
    }
  }, [columns, sorted, exportFileName, exportSheetName])

  const pad = dense ? 'px-2 py-1.5' : 'px-3 py-2'
  const padH = dense ? 'px-2 py-2' : 'px-3 py-2.5'

  const fromRow = total === 0 ? 0 : safePage * perPage + 1
  const toRow   = Math.min(total, safePage * perPage + perPage)

  return (
    <div className="space-y-2">
      {/* ── Toolbar ── */}
      <div className="flex flex-wrap items-center gap-2">
        {/* Global search */}
        <div className="relative flex-1 min-w-[180px] max-w-xs">
          <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-gray-400" />
          <input
            value={globalQuery}
            onChange={e => setGQ(e.target.value)}
            placeholder="Search all columns…"
            className="w-full pl-8 pr-7 py-1.5 text-xs border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-brand/30 focus:border-brand"
          />
          {globalQuery && (
            <button onClick={() => setGQ('')} className="absolute right-2 top-1/2 -translate-y-1/2 text-gray-400 hover:text-gray-600">
              <X className="h-3.5 w-3.5" />
            </button>
          )}
        </div>

        {/* Toggle column filters */}
        <button
          onClick={() => setShow(s => !s)}
          className={`flex items-center gap-1.5 px-2.5 py-1.5 text-xs font-medium rounded-lg border transition-colors ${
            showFilters || activeFilterCount > 0
              ? 'bg-brand/10 text-brand border-brand/30'
              : 'text-gray-600 border-gray-200 hover:bg-gray-50'
          }`}
        >
          <Filter className="h-3.5 w-3.5" />
          Filters
          {activeFilterCount > 0 && (
            <span className="ml-0.5 text-[10px] font-bold bg-brand text-white rounded-full px-1.5 py-0.5 leading-none">{activeFilterCount}</span>
          )}
        </button>

        {(activeFilterCount > 0 || globalQuery || sortKey) && (
          <button onClick={clearAll} className="text-xs text-gray-500 hover:text-red-500 underline underline-offset-2">
            Clear
          </button>
        )}

        <div className="ml-auto flex items-center gap-2">
          <span className="text-[11px] text-gray-500 whitespace-nowrap">
            {total.toLocaleString()} row{total !== 1 ? 's' : ''}
          </span>
          <button
            onClick={handleExport}
            disabled={exporting || total === 0}
            className="flex items-center gap-1.5 px-2.5 py-1.5 text-xs font-medium text-emerald-700 bg-emerald-50 hover:bg-emerald-100 border border-emerald-200 rounded-lg transition-colors disabled:opacity-50 whitespace-nowrap"
          >
            <Download className="h-3.5 w-3.5" />
            {exporting ? 'Exporting…' : 'Export Excel'}
          </button>
        </div>
      </div>

      {/* ── Table ── */}
      <div className="overflow-x-auto rounded-xl border border-gray-200 shadow-sm">
        <table className="min-w-max w-full text-xs border-collapse">
          <thead className="bg-gray-50 text-[10px] uppercase tracking-wide text-gray-500 sticky top-0 z-10">
            <tr>
              {columns.map(col => {
                const isSorted = sortKey === col.key
                const alignCls = col.align === 'right' ? 'text-right' : col.align === 'center' ? 'text-center' : 'text-left'
                return (
                  <th
                    key={col.key}
                    className={`${padH} ${alignCls} whitespace-nowrap border-b border-gray-200 ${col.noSort ? '' : 'cursor-pointer select-none hover:text-gray-700'} ${col.className ?? ''}`}
                    onClick={col.noSort ? undefined : () => toggleSort(col.key)}
                  >
                    <span className={`inline-flex items-center gap-1 ${col.align === 'right' ? 'flex-row-reverse' : ''}`}>
                      {col.header}
                      {!col.noSort && (
                        isSorted
                          ? (sortDir === 'asc' ? <ArrowUp className="h-3 w-3 text-brand" /> : <ArrowDown className="h-3 w-3 text-brand" />)
                          : <ArrowUpDown className="h-3 w-3 text-gray-300" />
                      )}
                    </span>
                  </th>
                )
              })}
            </tr>

            {/* Per-column filter row */}
            {showFilters && (
              <tr className="bg-white">
                {columns.map(col => {
                  const f = filters[col.key] ?? EMPTY_FILTER
                  const type = col.type ?? 'text'
                  if (col.noFilter) return <th key={col.key} className="px-2 py-1.5 border-b border-gray-200" />
                  return (
                    <th key={col.key} className="px-2 py-1.5 border-b border-gray-200 font-normal">
                      {type === 'number' || type === 'date' ? (
                        <div className="flex items-center gap-1">
                          <input
                            type={type === 'date' ? 'date' : 'number'}
                            value={f.min}
                            onChange={e => setColFilter(col.key, { min: e.target.value })}
                            placeholder="min"
                            className="w-full min-w-[64px] px-1.5 py-1 text-[11px] border border-gray-200 rounded focus:outline-none focus:ring-1 focus:ring-brand/40"
                          />
                          <input
                            type={type === 'date' ? 'date' : 'number'}
                            value={f.max}
                            onChange={e => setColFilter(col.key, { max: e.target.value })}
                            placeholder="max"
                            className="w-full min-w-[64px] px-1.5 py-1 text-[11px] border border-gray-200 rounded focus:outline-none focus:ring-1 focus:ring-brand/40"
                          />
                        </div>
                      ) : type === 'select' ? (
                        <select
                          value={f.select}
                          onChange={e => setColFilter(col.key, { select: e.target.value })}
                          className="w-full px-1.5 py-1 text-[11px] border border-gray-200 rounded focus:outline-none focus:ring-1 focus:ring-brand/40 bg-white"
                        >
                          <option value="">All</option>
                          {(selectOptions[col.key] ?? []).map(o => <option key={o} value={o}>{o}</option>)}
                        </select>
                      ) : (
                        <input
                          value={f.text}
                          onChange={e => setColFilter(col.key, { text: e.target.value })}
                          placeholder="filter…"
                          className="w-full px-1.5 py-1 text-[11px] border border-gray-200 rounded focus:outline-none focus:ring-1 focus:ring-brand/40"
                        />
                      )}
                    </th>
                  )
                })}
              </tr>
            )}
          </thead>

          <tbody className="divide-y divide-gray-100">
            {prepend}
            {pageRows.map((row, i) => {
              const globalIdx = safePage * perPage + i
              const extra = rowClassName?.(row, globalIdx) ?? (i % 2 === 0 ? 'hover:bg-gray-50' : 'bg-gray-50/50 hover:bg-gray-100/50')
              return (
                <tr
                  key={rowKey(row, globalIdx)}
                  className={`${extra} ${onRowClick ? 'cursor-pointer' : ''}`}
                  onClick={onRowClick ? () => onRowClick(row, globalIdx) : undefined}
                >
                  {columns.map(col => {
                    const alignCls = col.align === 'right' ? 'text-right' : col.align === 'center' ? 'text-center' : 'text-left'
                    return (
                      <td key={col.key} className={`${pad} ${alignCls} whitespace-nowrap ${col.className ?? ''}`}>
                        {col.render ? col.render(row, globalIdx) : (col.accessor(row) ?? '—')}
                      </td>
                    )
                  })}
                </tr>
              )
            })}
            {append}
            {total === 0 && !prepend && (
              <tr>
                <td colSpan={columns.length} className="px-3 py-8 text-center text-sm text-gray-400 italic">
                  No rows match the current filters.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {/* ── Pagination footer ── */}
      <div className="flex flex-wrap items-center justify-between gap-2 pt-1">
        <div className="flex items-center gap-2 text-[11px] text-gray-500">
          <span>
            {fromRow.toLocaleString()}–{toRow.toLocaleString()} of {total.toLocaleString()}
          </span>
          <span className="text-gray-300">|</span>
          <label className="flex items-center gap-1">
            Rows:
            <select
              value={perPage}
              onChange={e => setPerPage(Number(e.target.value))}
              className="px-1.5 py-0.5 text-[11px] border border-gray-200 rounded focus:outline-none focus:ring-1 focus:ring-brand/40 bg-white"
            >
              {PAGE_SIZE_OPTIONS.map(o => <option key={o} value={o}>{o}</option>)}
            </select>
          </label>
        </div>

        <div className="flex items-center gap-1">
          <button
            onClick={() => setPage(0)} disabled={safePage === 0}
            className="p-1 rounded border border-gray-200 text-gray-600 hover:bg-gray-50 disabled:opacity-40 disabled:cursor-not-allowed"
            title="First page"
          ><ChevronsLeft className="h-3.5 w-3.5" /></button>
          <button
            onClick={() => setPage(p => Math.max(0, p - 1))} disabled={safePage === 0}
            className="p-1 rounded border border-gray-200 text-gray-600 hover:bg-gray-50 disabled:opacity-40 disabled:cursor-not-allowed"
            title="Previous page"
          ><ChevronLeft className="h-3.5 w-3.5" /></button>

          <span className="px-2 text-[11px] text-gray-600 whitespace-nowrap">
            Page <span className="font-semibold">{safePage + 1}</span> / {pageCount}
          </span>

          <button
            onClick={() => setPage(p => Math.min(pageCount - 1, p + 1))} disabled={safePage >= pageCount - 1}
            className="p-1 rounded border border-gray-200 text-gray-600 hover:bg-gray-50 disabled:opacity-40 disabled:cursor-not-allowed"
            title="Next page"
          ><ChevronRight className="h-3.5 w-3.5" /></button>
          <button
            onClick={() => setPage(pageCount - 1)} disabled={safePage >= pageCount - 1}
            className="p-1 rounded border border-gray-200 text-gray-600 hover:bg-gray-50 disabled:opacity-40 disabled:cursor-not-allowed"
            title="Last page"
          ><ChevronsRight className="h-3.5 w-3.5" /></button>
        </div>
      </div>
    </div>
  )
}

