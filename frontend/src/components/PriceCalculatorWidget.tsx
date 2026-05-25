// src/components/PriceCalculatorWidget.tsx
// Floating Price Calculator widget — wraps conexion_internalquery functionality
import { useState, useCallback, useMemo, useRef } from 'react'
import { Calculator, X, Pin, ChevronDown, ChevronUp, ExternalLink, Download } from 'lucide-react'

// ── Types ─────────────────────────────────────────────────────────────────────

interface IQItem {
  rawStandardPrice: number; rawStandardPricePer: number
  rawLastPoPrice: number | null; rawLastPoPer: number | null
  uomConversion: number
  localCurrencyExchangeRate: number; localCurrencyExchangeRateUsd: number
  mpn: string; internalPN: string; siteName: string; quantity: number
  standardPriceLocalCurr: number; lastPoPriceLocalCurr: number | null
  standardPriceUsd: number; lastPoPriceUsd: number | null
  localCurrency: string; lastPoDate: string
  supplierNumber: string; supplierName: string; englishName: string | null
  manufacturerName: string; materialDescription: string
}

interface AmplActiveItem { MfgPartNumber: string; MfgName: string; MpnPartNumber: string; count: number; Blocked?: string; Deleted?: string }
type MpnInfo = { mpnPartNumber: string; status: 'active' | 'blocked' | 'deleted'; blockCode?: string }

const BLOCK_REASONS: Record<string, string> = {
  '0004': 'Receive conditionally',
  'CD':   'Customer deleted from AVL',
  'ER':   'Contains banned substances (unusable)',
  'F':    'Failed DV or PV — Do not Use',
  'MD':   'Material Datasheet not submitted',
  'NP':   'Not yet validated in process',
  'NV':   'Not Verified in Design',
}
interface AmplResponse {
  internal_part_number: string
  total_active: number; total_blocked: number; total_deleted: number
  mpns_csv: string; mpns_list: string[]
  active: AmplActiveItem[]; blocked: AmplActiveItem[]; deleted: AmplActiveItem[]
}

interface MarketOffer {
  mpn: string; manufacturer: string; description: string
  seller: string; unit_price_usd: number; total_price_usd: number
  inventory: number; moq: number; can_fulfill: boolean; packaging: string; click_url: string
}
interface MarketResponse { mpns: string[]; quantity: number; total_offers: number; offers: MarketOffer[] }

interface MultiResult {
  bmatn: string
  status: 'loading' | 'done' | 'error'
  error?: string
  description?: string
  bestPlant?: string
  bestSupplier?: string
  bestPriceUsd?: number | null
  stdPriceUsd?: number | null
  lastPoDate?: string
  totalActive?: number
  totalBlocked?: number
  totalDeleted?: number
  deltaPct?: number | null
  mpn?: string
  mpnPartNumber?: string
  internalPN?: string
  bestPriceLocal?: number | null
  stdPriceLocal?: number | null
  qty?: number | null
  currency?: string
  blockedItems?: AmplActiveItem[]
  deletedItems?: AmplActiveItem[]
  nexarBestUsd?: number | null
  nexarSeller?: string
  bestInMarket?: boolean
  searchQty?: number
}

interface PlantSummary {
  siteName: string; bestPrice: number | null
  bestSupplier: string; lastPoDate: string; mpn: string; rows: IQItem[]
}

// ── Utilities ─────────────────────────────────────────────────────────────────

function resolveLastPoPrice(row: IQItem): number | null {
  if (row.lastPoPriceUsd != null) return row.lastPoPriceUsd
  const local = row.rawLastPoPrice != null && row.rawLastPoPer
    ? row.rawLastPoPrice / row.rawLastPoPer : null
  if (local == null) return null
  return row.localCurrencyExchangeRateUsd ? local * row.localCurrencyExchangeRateUsd : null
}

function resolveStdLocal(row: IQItem): number | null {
  return row.standardPriceLocalCurr ?? (
    row.rawStandardPricePer ? row.rawStandardPrice / row.rawStandardPricePer : null
  )
}

function resolvePoLocal(row: IQItem): number | null {
  return row.lastPoPriceLocalCurr ?? (
    row.rawLastPoPrice != null && row.rawLastPoPer
      ? row.rawLastPoPrice / row.rawLastPoPer : null
  )
}

const fmt6 = (v: number | null | undefined) =>
  v != null ? v.toLocaleString('en-US', { style: 'currency', currency: 'USD', minimumFractionDigits: 6 }) : '—'
const fmt2 = (v: number | null | undefined) =>
  v != null ? v.toLocaleString('en-US', { style: 'currency', currency: 'USD', minimumFractionDigits: 2 }) : '—'
const fmtLocal = (v: number | null | undefined, cur = '') =>
  v != null ? `${v.toLocaleString('en-US', { minimumFractionDigits: 4 })} ${cur}`.trim() : '—'

function buildPlantSummaries(rows: IQItem[]): PlantSummary[] {
  const map = new Map<string, IQItem[]>()
  for (const row of rows) {
    if (!map.has(row.siteName)) map.set(row.siteName, [])
    map.get(row.siteName)!.push(row)
  }
  return Array.from(map.entries())
    .map(([siteName, siteRows]) => {
      // Representative row = most recent PO by date
      const latest = siteRows.reduce((a, b) =>
        new Date(b.lastPoDate || 0) > new Date(a.lastPoDate || 0) ? b : a)
      return {
        siteName,
        bestPrice:    resolveLastPoPrice(latest),
        bestSupplier: latest.supplierName,
        lastPoDate:   latest.lastPoDate,
        mpn:          latest.mpn,
        rows:         siteRows,
      }
    })
    // Sort by most-recent-PO price so the cheapest plant appears first (highlighted as best)
    .sort((a, b) => (a.bestPrice ?? Infinity) - (b.bestPrice ?? Infinity))
}

function getDecision(diffPct: number | null, withStock: number, total: number) {
  if (total === 0)    return { icon: '❓', text: 'No market data',       color: 'text-gray-500', bg: 'bg-gray-50 border-gray-200' }
  if (withStock === 0) return { icon: '⚠️', text: 'No market stock',      color: 'text-red-600',  bg: 'bg-red-50 border-red-200' }
  if (diffPct == null) return { icon: '🔍', text: 'Review manually',      color: 'text-gray-600', bg: 'bg-gray-50 border-gray-200' }
  if (diffPct <= -10)  return { icon: '🚀', text: 'Savings opportunity',  color: 'text-emerald-700', bg: 'bg-emerald-50 border-emerald-200' }
  if (diffPct <= 0)    return { icon: '✅', text: 'Competitive price',     color: 'text-blue-700',  bg: 'bg-blue-50 border-blue-200' }
  if (diffPct <= 15)   return { icon: '🔍', text: 'Evaluate alternatives', color: 'text-amber-700', bg: 'bg-amber-50 border-amber-200' }
  return               { icon: '🔒', text: 'Keep internal supplier',  color: 'text-gray-700',  bg: 'bg-gray-100 border-gray-200' }
}

// ── API calls ─────────────────────────────────────────────────────────────────

async function apiPost<T>(path: string, body: unknown, signal?: AbortSignal): Promise<T> {
  const res = await fetch(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal,
  })
  if (!res.ok) {
    const err = await res.json().catch(() => ({ detail: res.statusText }))
    throw new Error(err.detail ?? `HTTP ${res.status}`)
  }
  return res.json()
}

async function apiPostWithRetry<T>(path: string, body: unknown, signal?: AbortSignal, maxRetries = 10): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    if (signal?.aborted) throw new DOMException('Aborted', 'AbortError')
    try {
      return await apiPost<T>(path, body, signal)
    } catch (e) {
      if (e instanceof DOMException && e.name === 'AbortError') throw e
      if (e instanceof Error && /^HTTP 4/.test(e.message)) throw e
      if (attempt >= maxRetries) throw e
      await new Promise<void>(res => setTimeout(res, 1500))
    }
  }
}

// ── Sub-components ────────────────────────────────────────────────────────────

function StatCard({ icon, label, value, sub, highlight = false }: { icon: string; label: string; value: string; sub?: string; highlight?: boolean }) {
  return (
    <div className={`rounded-xl border p-4 ${highlight ? 'bg-emerald-50 border-emerald-200' : 'bg-white border-gray-200'}`}>
      <p className="text-xs text-gray-400 mb-1">{icon} {label}</p>
      <p className={`text-base font-bold leading-tight ${highlight ? 'text-emerald-700' : 'text-gray-800'}`}>{value}</p>
      <p className="text-xs text-gray-500 mt-0.5">{sub}</p>
    </div>
  )
}

function PlantTable({ plants, bestPlant, pinnedSite, selectedSite, onPin, onSelect, variant = 'green', mpnInfoMap }: {
  plants: PlantSummary[]; bestPlant: string; pinnedSite?: string; selectedSite?: string
  onPin: (p: PlantSummary) => void; onSelect: (p: PlantSummary) => void; variant?: 'green' | 'orange'
  mpnInfoMap?: Map<string, MpnInfo>
}) {
  return (
    <div className="overflow-x-auto rounded-xl border border-gray-200 shadow-sm">
      <table className="min-w-full text-xs">
        <thead className="bg-gray-50 text-[11px] uppercase tracking-wide text-gray-500">
          <tr>
            <th className="px-2 py-2 w-6" />
            <th className="px-3 py-2 text-left whitespace-nowrap">MPN</th>
            <th className="px-3 py-2 text-left whitespace-nowrap">Internal PN</th>
            <th className="px-3 py-2 text-left whitespace-nowrap">Plant</th>
            <th className="px-3 py-2 text-left whitespace-nowrap">Supplier</th>
            <th className="px-3 py-2 text-right whitespace-nowrap">Last PO (USD)</th>
            <th className="px-3 py-2 text-right whitespace-nowrap">Std (USD)</th>
            <th className="px-3 py-2 text-left whitespace-nowrap">PO Date</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-gray-100">
          {plants.map(p => {
            const isBest     = p.siteName === bestPlant
            const isPinned   = p.siteName === pinnedSite
            const isSelected = p.siteName === selectedSite
            const bestRow = p.rows.reduce((a, b) =>
              new Date(b.lastPoDate || 0) > new Date(a.lastPoDate || 0) ? b : a)
            return (
              <tr key={p.siteName}
                onClick={() => onSelect(p)}
                className={`cursor-pointer
                  ${isBest && !isPinned && !isSelected ? (variant === 'orange' ? 'bg-orange-100 font-semibold' : 'bg-green-50 font-semibold') : ''}
                  ${isPinned ? 'ring-2 ring-inset ring-indigo-400 bg-indigo-50 font-semibold' : ''}
                  ${isSelected ? 'ring-2 ring-inset ring-blue-500 bg-blue-50 font-semibold' : ''}
                  ${!isBest && !isPinned && !isSelected ? 'hover:bg-gray-50' : ''}
                `}>
                <td className="px-2 py-2 text-center">
                  <button
                    onClick={e => { e.stopPropagation(); onPin(p) }}
                    title={isPinned ? 'Remove reference' : 'Pin as reference'}
                    className={`text-sm transition-opacity ${isPinned ? 'opacity-100' : 'opacity-20 hover:opacity-70'}`}>
                    📌
                  </button>
                </td>
                <td className="px-3 py-2 whitespace-nowrap">
                  <span className="font-mono text-gray-600 block">{p.mpn}</span>
                  {mpnInfoMap && (() => {
                    const info = mpnInfoMap.get(p.mpn)
                    if (!info) return null
                    const reasonText = info.blockCode ? BLOCK_REASONS[info.blockCode] ?? info.blockCode : null
                    return (
                      <span className="flex flex-col gap-0.5 mt-0.5">
                        <span className="flex items-center gap-1">
                          <span className={`text-[10px] px-1 py-0.5 rounded font-medium ${
                            info.status === 'active'  ? 'bg-emerald-100 text-emerald-700' :
                            info.status === 'blocked' ? 'bg-amber-100 text-amber-700' :
                            'bg-red-100 text-red-700'
                          }`}>{info.status}</span>
                          {info.mpnPartNumber && <span className="font-mono text-[10px] text-gray-400">{info.mpnPartNumber}</span>}
                        </span>
                        {reasonText && <span className="text-[10px] text-orange-600 leading-tight">{info.blockCode}: {reasonText}</span>}
                      </span>
                    )
                  })()}
                </td>
                <td className="px-3 py-2 font-mono text-gray-600 whitespace-nowrap" title={bestRow.internalPN}>{bestRow.internalPN || '—'}</td>
                <td className="px-3 py-2 whitespace-nowrap">
                  {isBest    && <span className={`inline-block w-2 h-2 rounded-full mr-1 ${variant === 'orange' ? 'bg-orange-500' : 'bg-green-500'}`} />}
                  {isPinned  && <span className="inline-block w-2 h-2 rounded-full bg-indigo-500 mr-1" />}
                  {isSelected && !isPinned && <span className="inline-block w-2 h-2 rounded-full bg-blue-500 mr-1" />}
                  {p.siteName}
                </td>
                <td className="px-3 py-2 text-gray-700 whitespace-nowrap">{p.bestSupplier}</td>
                <td className="px-3 py-2 text-right text-blue-700 font-mono whitespace-nowrap">{fmt6(p.bestPrice)}</td>
                <td className="px-3 py-2 text-right text-gray-600 font-mono whitespace-nowrap">{fmt6(bestRow.standardPriceUsd)}</td>
                <td className="px-3 py-2 text-gray-500 whitespace-nowrap">{p.lastPoDate}</td>
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}

function DetailTable({ rows, variant = 'green', mpnInfoMap }: { rows: IQItem[]; variant?: 'green' | 'orange'; mpnInfoMap?: Map<string, MpnInfo> }) {
  const sorted = [...rows].sort((a, b) => (resolveLastPoPrice(a) ?? Infinity) - (resolveLastPoPrice(b) ?? Infinity))
  return (
    <div className="overflow-x-auto rounded-xl border border-gray-200 shadow-sm">
      <table className="min-w-full text-xs">
        <thead className="bg-gray-50 text-[11px] uppercase tracking-wide text-gray-500">
          <tr>
            {['MPN','Internal PN','Plant','Supplier','Last PO (USD)','Std (USD)','Last PO (Local)','Std (Local)','Qty','Cur','Date']
              .map(h => <th key={h} className={`px-3 py-2 ${['Last PO (USD)','Std (USD)','Last PO (Local)','Std (Local)','Qty'].includes(h) ? 'text-right' : 'text-left'}`}>{h}</th>)}
          </tr>
        </thead>
        <tbody className="divide-y divide-gray-100">
          {sorted.map((row, i) => (
            <tr key={i} className={i === 0 ? (variant === 'orange' ? 'bg-orange-100 font-semibold' : 'bg-green-50 font-semibold') : 'hover:bg-gray-50'}>
              <td className="px-3 py-1.5 whitespace-nowrap">
                <span className="font-mono block">{row.mpn}</span>
                {mpnInfoMap && (() => {
                  const info = mpnInfoMap.get(row.mpn)
                  if (!info) return null
                  const reasonText = info.blockCode ? BLOCK_REASONS[info.blockCode] ?? info.blockCode : null
                  return (
                    <span className="flex flex-col gap-0.5 mt-0.5">
                      <span className="flex items-center gap-1">
                        <span className={`text-[10px] px-1 py-0.5 rounded font-medium ${
                          info.status === 'active'  ? 'bg-emerald-100 text-emerald-700' :
                          info.status === 'blocked' ? 'bg-amber-100 text-amber-700' :
                          'bg-red-100 text-red-700'
                        }`}>{info.status}</span>
                        {info.mpnPartNumber && <span className="font-mono text-[10px] text-gray-400">{info.mpnPartNumber}</span>}
                      </span>
                      {reasonText && <span className="text-[10px] text-orange-600 leading-tight">{info.blockCode}: {reasonText}</span>}
                    </span>
                  )
                })()}
              </td>
              <td className="px-3 py-1.5 font-mono text-gray-500" title={row.internalPN}>{row.internalPN || '—'}</td>
              <td className="px-3 py-1.5">{row.siteName}</td>
              <td className="px-3 py-1.5 text-gray-700">{row.supplierName}</td>
              <td className="px-3 py-1.5 text-right text-blue-700 font-mono">{fmt6(resolveLastPoPrice(row))}</td>
              <td className="px-3 py-1.5 text-right text-gray-600 font-mono">{fmt6(row.standardPriceUsd)}</td>
              <td className="px-3 py-1.5 text-right text-indigo-700 font-mono">{fmtLocal(resolvePoLocal(row), row.localCurrency)}</td>
              <td className="px-3 py-1.5 text-right text-gray-500 font-mono">{fmtLocal(resolveStdLocal(row), row.localCurrency)}</td>
              <td className="px-3 py-1.5 text-right">{row.quantity.toLocaleString()}</td>
              <td className="px-3 py-1.5">{row.localCurrency}</td>
              <td className="px-3 py-1.5 text-gray-500">{row.lastPoDate}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

const RANK_STYLE: Record<number, string> = {
  1: 'bg-amber-50 border-l-4 border-amber-400',
  2: 'bg-slate-100 border-l-4 border-slate-400',
  3: 'bg-orange-50 border-l-4 border-orange-300',
  4: 'bg-blue-50 border-l-4 border-blue-300',
  5: 'bg-violet-50 border-l-4 border-violet-300',
}
const RANK_BADGE: Record<number, string> = {
  1: 'bg-amber-400 text-white', 2: 'bg-slate-400 text-white',
  3: 'bg-orange-400 text-white', 4: 'bg-blue-400 text-white', 5: 'bg-violet-400 text-white',
}
const RANK_LABEL: Record<number, string> = { 1: '🥇 1°', 2: '🥈 2°', 3: '🥉 3°', 4: '4°', 5: '5°' }

function MarketTable({ offers, quantity, strictMoq, selectedOffer, onSelect }: {
  offers: MarketOffer[]; quantity: number; strictMoq: boolean
  selectedOffer?: MarketOffer | null; onSelect: (o: MarketOffer) => void
}) {
  if (!offers.length) return <p className="text-sm text-gray-400 py-4 text-center">No offers found in Nexar.</p>
  const rankSource = strictMoq ? offers.filter(o => o.can_fulfill && o.inventory > 0) : offers
  const rankMap = new Map<MarketOffer, number>()
  rankSource.slice(0, 5).forEach((o, i) => rankMap.set(o, i + 1))

  const bestPrice = rankSource[0]?.unit_price_usd ?? null
  return (
    <div className="overflow-x-auto rounded-xl border border-gray-200 shadow-sm">
      <table className="min-w-full text-xs">
        <thead className="bg-gray-50 text-[11px] uppercase tracking-wide text-gray-500">
          <tr>
            {['#', 'MPN', 'Manufacturer', 'Supplier', 'Unit Price', 'Stock / MOQ', 'Packaging', 'Link']
              .map(h => <th key={h} className={`px-3 py-2 ${h === 'Unit Price' || h === 'Stock / MOQ' ? 'text-right' : 'text-left'} ${h === '#' ? 'w-10 text-center' : ''}`}>{h}</th>)}
          </tr>
        </thead>
        <tbody className="divide-y divide-gray-100">
          {offers.map((o, i) => {
            const rank       = rankMap.get(o)
            const isSelected = o === selectedOffer
            const pctVsBest  = bestPrice && rank !== 1 ? ((o.unit_price_usd - bestPrice) / bestPrice) * 100 : null
            return (
              <tr key={i}
                onClick={() => onSelect(o)}
                className={`cursor-pointer ${isSelected
                  ? 'ring-2 ring-inset ring-blue-500 bg-blue-50 font-semibold'
                  : rank ? RANK_STYLE[rank] : 'hover:bg-gray-50'}`}>
                <td className="px-3 py-1.5 text-center">
                  {rank ? <span className={`inline-flex items-center justify-center w-6 h-5 rounded text-[10px] font-bold ${RANK_BADGE[rank]}`}>{RANK_LABEL[rank]}</span> : <span className="text-gray-400">{i + 1}</span>}
                </td>
                <td className="px-3 py-1.5 font-mono max-w-[100px] truncate" title={o.mpn}>{o.mpn}</td>
                <td className="px-3 py-1.5 text-gray-700 max-w-[100px] truncate" title={o.manufacturer}>{o.manufacturer}</td>
                <td className="px-3 py-1.5 text-gray-700 max-w-[120px] truncate" title={o.seller}>
                  {o.seller}
                  {!o.can_fulfill && <span className="ml-1 text-[10px] bg-amber-100 text-amber-700 px-1 rounded">⚠ MOQ</span>}
                </td>
                <td className="px-3 py-1.5 text-right whitespace-nowrap">
                  <span className="font-mono text-blue-700 font-semibold">{fmt6(o.unit_price_usd)}</span>
                  {pctVsBest !== null && <span className="ml-1.5 text-[10px] text-gray-400">+{pctVsBest.toFixed(1)}%</span>}
                </td>
                <td className="px-3 py-1.5 text-right whitespace-nowrap">
                  <span className={`font-mono font-semibold ${o.inventory > 0 ? 'text-emerald-600' : 'text-red-500'}`}>{o.inventory.toLocaleString()}</span>
                  <span className="text-gray-400 mx-1">/</span>
                  <span className="font-mono text-gray-500">{o.moq.toLocaleString()}</span>
                </td>
                <td className="px-3 py-1.5 text-gray-500">{o.packaging}</td>
                <td className="px-3 py-1.5">
                  {o.click_url && (
                    <a href={o.click_url} target="_blank" rel="noopener noreferrer"
                      className="inline-flex items-center gap-1 text-blue-500 hover:underline whitespace-nowrap font-medium">
                      View <ExternalLink size={10} />
                    </a>
                  )}
                </td>
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}

// ── Shared Excel export (used by both Multi-Component and Multi-MPN tabs) ────
async function downloadResultsExcelFile(results: MultiResult[], myPlant: string, qty: number, filename: string) {
  const hasNexar = results.some(r => r.nexarBestUsd != null)
  const ExcelJS = (await import('exceljs')).default
  const wb = new ExcelJS.Workbook()
  wb.creator = 'PPV Dashboard'
  wb.created = new Date()
  const ws = wb.addWorksheet('Results', { views: [{ state: 'frozen', ySplit: 1 }] })
  ws.columns = [
    { header: 'Status',          key: 'status',      width: 10 },
    { header: 'MPN',             key: 'mpn',         width: 24 },
    { header: 'Alt PN',          key: 'altPn',       width: 24 },
    { header: 'Supplier',        key: 'supplier',    width: 30 },
    { header: 'Searched',        key: 'searched',    width: 16 },
    { header: 'Internal PN',     key: 'internalPN',  width: 16 },
    { header: 'Plant',           key: 'plant',       width: 10 },
    { header: 'Qty',             key: 'qty',         width: 8  },
    { header: 'Cur',             key: 'currency',    width: 8  },
    { header: 'Last PO (Local)', key: 'lastPoLocal', width: 16 },
    { header: 'Std (Local)',     key: 'stdLocal',    width: 14 },
    { header: 'Last PO (USD)',   key: 'lastPoUsd',   width: 16 },
    { header: 'Std (USD)',       key: 'stdUsd',      width: 14 },
    { header: 'QTY Inserted',    key: 'qtyInserted', width: 14 },
    { header: 'Total Cost (USD) per QTY Inserted', key: 'totalCost', width: 28 },
    { header: 'Date',            key: 'date',        width: 14 },
    { header: 'Last PO Price > Std Price', key: 'lpoGtStd',  width: 22 },
    { header: 'Swap',            key: 'swap',        width: 8  },
    { header: 'Manual Rev.',     key: 'manualRev',   width: 12 },
    ...(hasNexar ? [
      { header: 'Best in Market',   key: 'bestInMarket', width: 14 },
      { header: 'Nexar Best (USD)', key: 'nexarBestUsd', width: 18 },
      { header: 'Nexar Seller',     key: 'nexarSeller',  width: 22 },
    ] : []),
  ]
  const headerRow = ws.getRow(1)
  headerRow.height = 24
  headerRow.eachCell(cell => {
    cell.fill      = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1E3A5F' } }
    cell.font      = { bold: true, color: { argb: 'FFFFFFFF' }, size: 10, name: 'Calibri' }
    cell.alignment = { horizontal: 'center', vertical: 'middle', wrapText: false }
    cell.border    = { bottom: { style: 'medium', color: { argb: 'FF2563EB' } }, right: { style: 'thin', color: { argb: 'FF3B5998' } } }
  })
  ws.autoFilter = hasNexar ? 'A1:V1' : 'A1:S1'
  results.filter(r => r.status === 'done').forEach((r, i) => {
    const isSwap = !!(myPlant && r.bestPlant && r.bestPlant !== myPlant)
    const row = ws.addRow({
      status:      r.status,
      mpn:         r.mpn          ?? '',
      altPn:       r.mpnPartNumber ?? '',
      supplier:    r.bestSupplier  ?? '',
      searched:    r.bmatn,
      internalPN:  r.internalPN   ?? '',
      plant:       r.bestPlant    ?? '',
      qty:         r.qty          ?? '',
      currency:    r.currency     ?? '',
      lastPoLocal: r.bestPriceLocal ?? '',
      stdLocal:    r.stdPriceLocal  ?? '',
      lastPoUsd:   r.bestPriceUsd   ?? '',
      stdUsd:      r.stdPriceUsd    ?? '',
      qtyInserted: r.searchQty ?? qty,
      totalCost:   (r.bestPriceUsd != null && r.bestPriceUsd > 0) ? r.bestPriceUsd * (r.searchQty ?? qty) : '',
      date:        r.lastPoDate   ?? '',
      lpoGtStd:    (r.bestPriceUsd != null && r.stdPriceUsd != null && r.bestPriceUsd > r.stdPriceUsd) ? 1 : '',
      swap:        isSwap ? 1 : '',
      manualRev:   r.bestPriceUsd === 0 ? 1 : '',
      ...(hasNexar ? { bestInMarket: r.bestInMarket ? 1 : '', nexarBestUsd: r.nexarBestUsd ?? '', nexarSeller: r.nexarSeller ?? '' } : {}),
    })
    row.height = 18
    const isLpoGtStd = !!(r.bestPriceUsd != null && r.stdPriceUsd != null && r.bestPriceUsd > r.stdPriceUsd)
    const bgColor = isLpoGtStd ? 'FFFEE2E2' : isSwap ? 'FFE8F5E9' : i % 2 === 0 ? 'FFFFFFFF' : 'FFF8FAFC'
    row.eachCell({ includeEmpty: true }, cell => {
      cell.fill      = { type: 'pattern', pattern: 'solid', fgColor: { argb: bgColor } }
      cell.font      = { size: 9, name: 'Calibri' }
      cell.alignment = { vertical: 'middle' }
      cell.border    = { bottom: { style: 'thin', color: { argb: 'FFE5E7EB' } } }
    })
    if (isLpoGtStd) {
      const c = row.getCell('lpoGtStd')
      c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFECACA' } }
      c.font = { bold: true, color: { argb: 'FFB91C1C' }, size: 9, name: 'Calibri' }
      c.alignment = { horizontal: 'center', vertical: 'middle' }
    }
    if (isSwap) {
      const c = row.getCell('swap')
      c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFD1FAE5' } }
      c.font = { bold: true, color: { argb: 'FF166534' }, size: 9, name: 'Calibri' }
      c.alignment = { horizontal: 'center', vertical: 'middle' }
    }
    if (r.bestPriceUsd === 0) {
      const c = row.getCell('manualRev')
      c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFEF3C7' } }
      c.font = { bold: true, color: { argb: 'FF92400E' }, size: 9, name: 'Calibri' }
      c.alignment = { horizontal: 'center', vertical: 'middle' }
    }
    const priceKeys = ['lastPoUsd', 'stdUsd', 'totalCost', 'lastPoLocal', 'stdLocal'] as const
    priceKeys.forEach(k => {
      const c = row.getCell(k)
      c.alignment = { horizontal: 'right', vertical: 'middle' }
      if (c.value !== '') c.numFmt = '#,##0.000000'
    })
    row.getCell('qtyInserted').alignment = { horizontal: 'right', vertical: 'middle' }
    row.getCell('qty').alignment      = { horizontal: 'right',  vertical: 'middle' }
    row.getCell('currency').alignment  = { horizontal: 'center', vertical: 'middle' }
    row.getCell('plant').alignment     = { horizontal: 'center', vertical: 'middle' }
    row.getCell('status').alignment    = { horizontal: 'center', vertical: 'middle' }
    if (hasNexar) {
      row.getCell('bestInMarket').alignment = { horizontal: 'center', vertical: 'middle' }
      if (r.bestInMarket) {
        const bc = row.getCell('bestInMarket')
        bc.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFD1FAE5' } }
        bc.font = { bold: true, color: { argb: 'FF166534' }, size: 9, name: 'Calibri' }
      }
    }
    if (hasNexar && r.nexarBestUsd != null) {
      const nc = row.getCell('nexarBestUsd')
      nc.alignment = { horizontal: 'right', vertical: 'middle' }
      nc.numFmt = '#,##0.000000'
      const delta = r.bestPriceUsd != null && r.bestPriceUsd > 0 ? (r.nexarBestUsd - r.bestPriceUsd) / r.bestPriceUsd * 100 : null
      nc.font = { size: 9, name: 'Calibri', bold: delta != null && delta < 0, color: { argb: delta != null && delta < 0 ? 'FF166534' : delta != null && delta > 0 ? 'FFB91C1C' : 'FF374151' } }
      row.getCell('nexarSeller').font = { size: 9, name: 'Calibri', color: { argb: 'FF7C3AED' } }
    }
  })
  const buffer = await wb.xlsx.writeBuffer()
  const blob   = new Blob([buffer], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' })
  const url    = URL.createObjectURL(blob)
  const a      = document.createElement('a')
  a.href     = url
  a.download = filename
  a.click()
  URL.revokeObjectURL(url)
}

// ── Main Widget ───────────────────────────────────────────────────────────────

type Status = 'idle' | 'loading-ampl' | 'loading-iq' | 'loading-market' | 'done' | 'error'

export default function PriceCalculatorWidget() {
  const [open, setOpen]       = useState(false)
  const [bmatn, setBmatn]     = useState('')
  const [qty, setQty]         = useState(1000)
  const [status, setStatus]   = useState<Status>('idle')
  const [error, setError]     = useState('')
  const [ampl, setAmpl]       = useState<AmplResponse | null>(null)
  const [iqRows, setIqRows]   = useState<IQItem[]>([])
  const [plants, setPlants]   = useState<PlantSummary[]>([])
  const [market, setMarket]   = useState<MarketResponse | null>(null)
  const [strictMoq, setStrictMoq] = useState(true)
  const [showDetail, setShowDetail] = useState(false)
  const [showMarket, setShowMarket] = useState(true)
  const [usedFallback, setUsedFallback] = useState(false)
  const [showAmplJson, setShowAmplJson] = useState(false)
  const [blockedIqRows, setBlockedIqRows] = useState<IQItem[]>([])
  const [blockedPlants, setBlockedPlants] = useState<PlantSummary[]>([])
  const [showBlockedDetail, setShowBlockedDetail] = useState(false)
  const [pinnedPlant, setPinnedPlant]     = useState<PlantSummary | null>(null)
  const [selectedPlant, setSelectedPlant] = useState<PlantSummary | null>(null)
  const [selectedOffer, setSelectedOffer] = useState<MarketOffer | null>(null)
  const [activeTab, setActiveTab]         = useState<'single' | 'multi' | 'mpn'>('single')
  const [multiBmatn, setMultiBmatn]       = useState('')
  const [multiResults, setMultiResults]   = useState<MultiResult[]>([])
  const [multiLoading, setMultiLoading]   = useState(false)
  const [multiSubTab, setMultiSubTab]     = useState<'results' | 'blocked'>('results')
  const [myPlant, setMyPlant]             = useState<string>('')
  const [searchNexar, setSearchNexar]     = useState(false)
  const [componentQtys, setComponentQtys] = useState<Record<string, number>>({})
  const [componentQtyDefaults, setComponentQtyDefaults] = useState<Record<string, 'empty' | '0'>>({})
  const [excelFileName, setExcelFileName] = useState<string>('')
  const [stopHover, setStopHover] = useState(false)
  const abortRef = useRef<AbortController | null>(null)

  // ── Multi-MPN tab state ───────────────────────────────────────────────────
  const [multiMpnInput, setMultiMpnInput]                             = useState('')
  const [multiMpnResults, setMultiMpnResults]                         = useState<MultiResult[]>([])
  const [multiMpnLoading, setMultiMpnLoading]                         = useState(false)
  const [multiMpnSubTab, setMultiMpnSubTab]                           = useState<'results' | 'blocked'>('results')
  const [mpnExcelFileName, setMpnExcelFileName]                       = useState<string>('')
  const [mpnComponentQtys, setMpnComponentQtys]                       = useState<Record<string, number>>({})
  const [mpnComponentQtyDefaults, setMpnComponentQtyDefaults]         = useState<Record<string, 'empty' | '0'>>({})
  const [stopMpnHover, setStopMpnHover]                               = useState(false)
  const abortMpnRef = useRef<AbortController | null>(null)

  const reset = useCallback(() => {
    setAmpl(null); setIqRows([]); setPlants([]); setMarket(null)
    setShowDetail(false); setError(''); setPinnedPlant(null); setSelectedPlant(null); setSelectedOffer(null)
    setUsedFallback(false); setShowAmplJson(false)
    setBlockedIqRows([]); setBlockedPlants([]); setShowBlockedDetail(false)
  }, [])

  const handleSearch = useCallback(async () => {
    if (!bmatn.trim()) return
    reset()
    try {
      setStatus('loading-ampl')
      const amplData = await apiPost<AmplResponse>('/api/pricecalc/ampl', { internal_part_number: bmatn.trim().toUpperCase() })
      setAmpl(amplData)

      // Build query MPNs: prefer active, fall back to blocked+deleted (same logic as sourcing.py)
      let queryMpns = amplData.mpns_list
      let usedFallback = false
      if (!queryMpns.length) {
        const fallback = [
          ...amplData.blocked.map(i => i.MfgPartNumber),
          ...amplData.deleted.map(i => i.MfgPartNumber),
        ].filter(Boolean).filter((v, i, a) => a.indexOf(v) === i)
        if (!fallback.length) {
          setError('No MPNs found for this component in SAP.')
          setStatus('error'); return
        }
        queryMpns = fallback
        usedFallback = true
        setUsedFallback(true)
      }

      setStatus('loading-iq')
      const iqData = await apiPost<{ count: number; data: IQItem[] }>('/api/pricecalc/internal-query', { mpns: queryMpns })
      const rows: IQItem[] = Array.isArray(iqData.data) ? iqData.data : []
      if (!rows.length && usedFallback) {
        setError('Component found in SAP (blocked/deleted MPNs only) but no pricing data available.')
        setStatus('error'); return
      }
      setIqRows(rows)
      setPlants(buildPlantSummaries(rows))

      // Always fetch historical data from blocked/deleted MPNs when they exist (for full picture)
      if (!usedFallback) {
        const blockedMpns = [
          ...amplData.blocked.map(i => i.MfgPartNumber),
          ...amplData.deleted.map(i => i.MfgPartNumber),
        ].filter(Boolean).filter((v, i, a) => a.indexOf(v) === i)
        if (blockedMpns.length) {
          try {
            const biqData = await apiPost<{ count: number; data: IQItem[] }>('/api/pricecalc/internal-query', { mpns: blockedMpns })
            const bRows: IQItem[] = Array.isArray(biqData.data) ? biqData.data : []
            setBlockedIqRows(bRows)
            setBlockedPlants(buildPlantSummaries(bRows))
          } catch { /* non-critical */ }
        }
      }

      setStatus('loading-market')
      const mkt = await apiPost<MarketResponse>('/api/pricecalc/market-prices', { mpns: queryMpns, quantity: qty })
      setMarket(mkt)

      setStatus('done')
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : String(e))
      setStatus('error')
    }
  }, [bmatn, qty, reset])

  const handleMultiSearch = useCallback(async () => {
    const bmats = multiBmatn
      .split(/[\n,;\s]+/)
      .map(s => s.trim().toUpperCase())
      .filter(Boolean)
      .filter((v, i, a) => a.indexOf(v) === i)
    if (!bmats.length) return
    const ctrl = new AbortController()
    abortRef.current = ctrl
    const { signal } = ctrl
    setMultiResults(bmats.map(bmatn => ({ bmatn, status: 'loading' })))
    setMultiLoading(true)
    setStopHover(false)
    setMultiSubTab('results')
    await Promise.allSettled(bmats.map(async bmatn => {
      try {
        const amplData = await apiPostWithRetry<AmplResponse>('/api/pricecalc/ampl', { internal_part_number: bmatn }, signal)
        let queryMpns = amplData.mpns_list
        if (!queryMpns.length) {
          queryMpns = [
            ...amplData.blocked.map(i => i.MfgPartNumber),
            ...amplData.deleted.map(i => i.MfgPartNumber),
          ].filter(Boolean).filter((v, i, a) => a.indexOf(v) === i)
        }
        if (!queryMpns.length) {
          setMultiResults(prev => prev.map(r => r.bmatn === bmatn ? { ...r, status: 'error', error: 'No MPNs in SAP' } : r))
          return
        }
        const iqData = await apiPostWithRetry<{ count: number; data: IQItem[] }>('/api/pricecalc/internal-query', { mpns: queryMpns }, signal)
        const rows: IQItem[] = Array.isArray(iqData.data) ? iqData.data : []
        const summaries = buildPlantSummaries(rows)
        const best = summaries[0]
        const bestRow = best?.rows.reduce((a, b) =>
          new Date(b.lastPoDate || 0) > new Date(a.lastPoDate || 0) ? b : a) ?? null
        const bestPrice = bestRow ? resolveLastPoPrice(bestRow) : null
        const stdPrice = bestRow?.standardPriceUsd ?? null
        const deltaPct = bestPrice != null && stdPrice != null && stdPrice > 0
          ? ((bestPrice - stdPrice) / stdPrice) * 100 : null
        let nexarBestUsd: number | null = null
        let nexarSeller = ''
        if (searchNexar && queryMpns.length) {
          try {
            const effectiveQty = componentQtys[bmatn] ?? qty
            const mkt = await apiPostWithRetry<MarketResponse>('/api/pricecalc/market-prices', { mpns: queryMpns, quantity: effectiveQty }, signal)
            const eligible = mkt.offers.filter(o => o.inventory > 0 && o.moq <= effectiveQty)
            const best = eligible.sort((a, b) => a.unit_price_usd - b.unit_price_usd)[0] ?? null
            if (best) { nexarBestUsd = best.unit_price_usd; nexarSeller = best.seller }
          } catch { /* non-critical */ }
        }
        setMultiResults(prev => prev.map(r => r.bmatn === bmatn ? {
          ...r, status: 'done',
          description: rows[0]?.materialDescription ?? '—',
          bestPlant: best?.siteName ?? '—',
          bestSupplier: bestRow?.supplierName ?? bestRow?.englishName ?? '—',
          bestPriceUsd: bestPrice,
          stdPriceUsd: stdPrice,
          lastPoDate: bestRow?.lastPoDate ?? '—',
          totalActive: amplData.total_active,
          totalBlocked: amplData.total_blocked,
          totalDeleted: amplData.total_deleted,
          deltaPct,
          mpn: bestRow?.mpn ?? '—',
          mpnPartNumber: amplData.active.find(a => a.MfgPartNumber === bestRow?.mpn)?.MpnPartNumber ?? '—',
          internalPN: bestRow?.internalPN ?? '—',
          bestPriceLocal: bestRow ? resolvePoLocal(bestRow) : null,
          stdPriceLocal: bestRow ? resolveStdLocal(bestRow) : null,
          qty: bestRow?.quantity ?? null,
          currency: bestRow?.localCurrency ?? '—',
          blockedItems: amplData.blocked,
          deletedItems: amplData.deleted,
          nexarBestUsd,
          nexarSeller,
          bestInMarket: nexarBestUsd != null && bestPrice != null && bestPrice > 0 && nexarBestUsd < bestPrice,
          searchQty: componentQtys[bmatn] ?? qty,
        } : r))
      } catch (e) {
        const isCancelled = e instanceof DOMException && e.name === 'AbortError'
        setMultiResults(prev => prev.map(r => r.bmatn === bmatn ? {
          ...r, status: 'error', error: isCancelled ? 'Cancelled' : e instanceof Error ? e.message : String(e),
        } : r))
      }
    }))
    setMultiLoading(false)
    setStopHover(false)
  }, [multiBmatn, searchNexar, qty, componentQtys])

  const handleExcelUpload = useCallback(async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (!file) return
    e.target.value = ''
    try {
      const ExcelJS = (await import('exceljs')).default
      const wb = new ExcelJS.Workbook()
      await wb.xlsx.load(await file.arrayBuffer())
      const ws = wb.worksheets[0]
      // locate header columns (case-insensitive)
      const colIndex: Record<string, number> = {}
      ws.getRow(1).eachCell((cell, col) => {
        colIndex[String(cell.value ?? '').trim().toLowerCase()] = col
      })
      const compCol = colIndex['component']
      const qtyCol  = colIndex['quantity']
      if (!compCol) { alert('Column "Component" not found in the file.'); return }
      const components: string[] = []
      const qtys: Record<string, number> = {}
      const defaults: Record<string, 'empty' | '0'> = {}
      ws.eachRow((row, rowNum) => {
        if (rowNum === 1) return
        const comp = String(row.getCell(compCol).value ?? '').trim().toUpperCase()
        if (!comp) return
        components.push(comp)
        const rawVal = qtyCol ? row.getCell(qtyCol).value : null
        const isEmpty = rawVal === null || rawVal === undefined || String(rawVal).trim() === ''
        const raw = isEmpty ? NaN : Number(rawVal)
        if (isFinite(raw) && raw > 0) {
          qtys[comp] = raw
        } else {
          qtys[comp] = 1000
          defaults[comp] = isEmpty ? 'empty' : '0'
        }
      })
      if (!components.length) { alert('No components found in the file.'); return }
      setMultiBmatn(components.join('\n'))
      setComponentQtys(qtys)
      setComponentQtyDefaults(defaults)
      setExcelFileName(file.name)
    } catch (err) {
      alert('Error reading file: ' + (err instanceof Error ? err.message : String(err)))
    }
  }, [])

  const downloadTemplate = useCallback(async () => {
    const ExcelJS = (await import('exceljs')).default
    const wb = new ExcelJS.Workbook()
    wb.creator = 'PPV Dashboard'
    const ws = wb.addWorksheet('Components')
    ws.columns = [
      { header: 'Component', key: 'component', width: 20 },
      { header: 'Quantity',  key: 'quantity',  width: 14 },
    ]
    // Style header row
    const hdr = ws.getRow(1)
    hdr.height = 22
    hdr.eachCell(cell => {
      cell.fill      = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1E3A5F' } }
      cell.font      = { bold: true, color: { argb: 'FFFFFFFF' }, size: 11, name: 'Calibri' }
      cell.alignment = { horizontal: 'center', vertical: 'middle' }
      cell.border    = { bottom: { style: 'medium', color: { argb: 'FF2563EB' } } }
    })
    // Example rows
    const examples = [{ component: 'EC03018', quantity: 1000 }, { component: 'EC05432', quantity: 500 }, { component: 'EC09876', quantity: 2500 }]
    examples.forEach((ex, i) => {
      const row = ws.addRow(ex)
      row.height = 18
      row.eachCell({ includeEmpty: true }, cell => {
        cell.fill      = { type: 'pattern', pattern: 'solid', fgColor: { argb: i % 2 === 0 ? 'FFFFFFFF' : 'FFF8FAFC' } }
        cell.font      = { size: 10, name: 'Calibri', italic: true, color: { argb: 'FF9CA3AF' } }
        cell.alignment = { vertical: 'middle' }
      })
      row.getCell('quantity').alignment = { horizontal: 'right', vertical: 'middle' }
    })
    ws.autoFilter = 'A1:B1'
    const buffer = await wb.xlsx.writeBuffer()
    const blob = new Blob([buffer], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' })
    const url  = URL.createObjectURL(blob)
    const a    = document.createElement('a')
    a.href     = url
    a.download = 'PPV_Component_Template.xlsx'
    a.click()
    URL.revokeObjectURL(url)
  }, [])

  // ── Multi-MPN: Excel upload ───────────────────────────────────────────────
  const handleMpnExcelUpload = useCallback(async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (!file) return
    e.target.value = ''
    try {
      const ExcelJS = (await import('exceljs')).default
      const wb = new ExcelJS.Workbook()
      await wb.xlsx.load(await file.arrayBuffer())
      const ws = wb.worksheets[0]
      const colIndex: Record<string, number> = {}
      ws.getRow(1).eachCell((cell, col) => {
        colIndex[String(cell.value ?? '').trim().toLowerCase()] = col
      })
      const compCol = colIndex['mpn'] || colIndex['component']
      const qtyCol  = colIndex['quantity']
      if (!compCol) { alert('Column "MPN" or "Component" not found in the file.'); return }
      const components: string[] = []
      const qtys: Record<string, number> = {}
      const defaults: Record<string, 'empty' | '0'> = {}
      ws.eachRow((row, rowNum) => {
        if (rowNum === 1) return
        const comp = String(row.getCell(compCol).value ?? '').trim().toUpperCase()
        if (!comp) return
        components.push(comp)
        const rawVal = qtyCol ? row.getCell(qtyCol).value : null
        const isEmpty = rawVal === null || rawVal === undefined || String(rawVal).trim() === ''
        const raw = isEmpty ? NaN : Number(rawVal)
        if (isFinite(raw) && raw > 0) {
          qtys[comp] = raw
        } else {
          qtys[comp] = 1000
          defaults[comp] = isEmpty ? 'empty' : '0'
        }
      })
      if (!components.length) { alert('No MPNs found in the file.'); return }
      setMultiMpnInput(components.join('\n'))
      setMpnComponentQtys(qtys)
      setMpnComponentQtyDefaults(defaults)
      setMpnExcelFileName(file.name)
    } catch (err) {
      alert('Error reading file: ' + (err instanceof Error ? err.message : String(err)))
    }
  }, [])

  const downloadMpnTemplate = useCallback(async () => {
    const ExcelJS = (await import('exceljs')).default
    const wb = new ExcelJS.Workbook()
    wb.creator = 'PPV Dashboard'
    const ws = wb.addWorksheet('MPNs')
    ws.columns = [
      { header: 'MPN',      key: 'mpn',      width: 24 },
      { header: 'Quantity', key: 'quantity', width: 14 },
    ]
    const hdr = ws.getRow(1)
    hdr.height = 22
    hdr.eachCell(cell => {
      cell.fill      = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1E3A5F' } }
      cell.font      = { bold: true, color: { argb: 'FFFFFFFF' }, size: 11, name: 'Calibri' }
      cell.alignment = { horizontal: 'center', vertical: 'middle' }
      cell.border    = { bottom: { style: 'medium', color: { argb: 'FF2563EB' } } }
    })
    const examples = [{ mpn: 'LM741CN', quantity: 500 }, { mpn: 'BC547', quantity: 1000 }, { mpn: 'NE555P', quantity: 250 }]
    examples.forEach((ex, i) => {
      const row = ws.addRow(ex)
      row.height = 18
      row.eachCell({ includeEmpty: true }, cell => {
        cell.fill      = { type: 'pattern', pattern: 'solid', fgColor: { argb: i % 2 === 0 ? 'FFFFFFFF' : 'FFF8FAFC' } }
        cell.font      = { size: 10, name: 'Calibri', italic: true, color: { argb: 'FF9CA3AF' } }
        cell.alignment = { vertical: 'middle' }
      })
      row.getCell('quantity').alignment = { horizontal: 'right', vertical: 'middle' }
    })
    ws.autoFilter = 'A1:B1'
    const buffer = await wb.xlsx.writeBuffer()
    const blob = new Blob([buffer], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' })
    const url  = URL.createObjectURL(blob)
    const a    = document.createElement('a')
    a.href     = url
    a.download = 'PPV_MPN_Template.xlsx'
    a.click()
    URL.revokeObjectURL(url)
  }, [])

  // ── Multi-MPN: search handler ─────────────────────────────────────────────
  const handleMultiMpnSearch = useCallback(async () => {
    const mpns = multiMpnInput
      .split(/[\n,;\s]+/)
      .map(s => s.trim().toUpperCase())
      .filter(Boolean)
      .filter((v, i, a) => a.indexOf(v) === i)
    if (!mpns.length) return
    const ctrl = new AbortController()
    abortMpnRef.current = ctrl
    const { signal } = ctrl
    setMultiMpnLoading(true)
    setStopMpnHover(false)
    setMultiMpnSubTab('results')
    setMultiMpnResults([{ bmatn: '…', status: 'loading' }])

    // Step 1: IQ with all input MPNs
    let allRows: IQItem[] = []
    try {
      const iqData = await apiPostWithRetry<{ count: number; data: IQItem[] }>(
        '/api/pricecalc/internal-query', { mpns }, signal
      )
      allRows = Array.isArray(iqData.data) ? iqData.data : []
    } catch (e) {
      const isCancelled = e instanceof DOMException && e.name === 'AbortError'
      setMultiMpnResults([{ bmatn: mpns[0] ?? '', status: 'error', error: isCancelled ? 'Cancelled' : e instanceof Error ? e.message : String(e) }])
      setMultiMpnLoading(false)
      setStopMpnHover(false)
      return
    }

    // Step 2: Extract unique internalPNs
    const internalPNs = [...new Set(allRows.map(r => r.internalPN).filter(Boolean))]
    if (!internalPNs.length) {
      setMultiMpnResults([{ bmatn: mpns.join(', '), status: 'error', error: 'No Internal PNs found in IQ' }])
      setMultiMpnLoading(false)
      setStopMpnHover(false)
      return
    }

    // Initialize one loading row per internalPN
    setMultiMpnResults(internalPNs.map(bmatn => ({ bmatn, status: 'loading' })))

    // Step 3: AMPL per internalPN in parallel
    await Promise.allSettled(internalPNs.map(async internalPN => {
      try {
        if (signal.aborted) throw new DOMException('Aborted', 'AbortError')
        const amplData = await apiPostWithRetry<AmplResponse>(
          '/api/pricecalc/ampl', { internal_part_number: internalPN }, signal
        )
        const pnRows = allRows.filter(r => r.internalPN === internalPN)
        const summaries = buildPlantSummaries(pnRows)
        const best = summaries[0]
        const bestRow = best?.rows.reduce((a, b) =>
          new Date(b.lastPoDate || 0) > new Date(a.lastPoDate || 0) ? b : a) ?? null
        const bestPrice = bestRow ? resolveLastPoPrice(bestRow) : null
        const stdPrice = bestRow?.standardPriceUsd ?? null
        const deltaPct = bestPrice != null && stdPrice != null && stdPrice > 0
          ? ((bestPrice - stdPrice) / stdPrice) * 100 : null

        let nexarBestUsd: number | null = null
        let nexarSeller = ''
        if (searchNexar && amplData.mpns_list.length) {
          try {
            const effectiveQty = mpnComponentQtys[internalPN] ?? qty
            const mkt = await apiPostWithRetry<MarketResponse>(
              '/api/pricecalc/market-prices', { mpns: amplData.mpns_list, quantity: effectiveQty }, signal
            )
            const eligible = mkt.offers.filter(o => o.inventory > 0 && o.moq <= effectiveQty)
            const bestOffer = eligible.sort((a, b) => a.unit_price_usd - b.unit_price_usd)[0] ?? null
            if (bestOffer) { nexarBestUsd = bestOffer.unit_price_usd; nexarSeller = bestOffer.seller }
          } catch { /* non-critical */ }
        }

        setMultiMpnResults(prev => prev.map(r => r.bmatn === internalPN ? {
          ...r, status: 'done',
          description:   pnRows[0]?.materialDescription ?? '—',
          bestPlant:     best?.siteName ?? '—',
          bestSupplier:  bestRow?.supplierName ?? bestRow?.englishName ?? '—',
          bestPriceUsd:  bestPrice,
          stdPriceUsd:   stdPrice,
          lastPoDate:    bestRow?.lastPoDate ?? '—',
          totalActive:   amplData.total_active,
          totalBlocked:  amplData.total_blocked,
          totalDeleted:  amplData.total_deleted,
          deltaPct,
          mpn:           bestRow?.mpn ?? '—',
          mpnPartNumber: amplData.active.find(a => a.MfgPartNumber === bestRow?.mpn)?.MpnPartNumber ?? '—',
          internalPN:    bestRow?.internalPN ?? internalPN,
          bestPriceLocal: bestRow ? resolvePoLocal(bestRow) : null,
          stdPriceLocal:  bestRow ? resolveStdLocal(bestRow) : null,
          qty:           bestRow?.quantity ?? null,
          currency:      bestRow?.localCurrency ?? '—',
          blockedItems:  amplData.blocked,
          deletedItems:  amplData.deleted,
          nexarBestUsd,
          nexarSeller,
          bestInMarket:  nexarBestUsd != null && bestPrice != null && bestPrice > 0 && nexarBestUsd < bestPrice,
          searchQty:     mpnComponentQtys[internalPN] ?? qty,
        } : r))
      } catch (e) {
        const isCancelled = e instanceof DOMException && e.name === 'AbortError'
        setMultiMpnResults(prev => prev.map(r => r.bmatn === internalPN ? {
          ...r, status: 'error', error: isCancelled ? 'Cancelled' : e instanceof Error ? e.message : String(e),
        } : r))
      }
    }))
    setMultiMpnLoading(false)
    setStopMpnHover(false)
  }, [multiMpnInput, searchNexar, qty, mpnComponentQtys])

  const downloadResultsExcel = useCallback(
    () => downloadResultsExcelFile(multiResults, myPlant, qty, `PPV_Results_${new Date().toISOString().slice(0, 10)}.xlsx`),
    [multiResults, myPlant, qty]
  )

  const downloadMpnResultsExcel = useCallback(
    () => downloadResultsExcelFile(multiMpnResults, myPlant, qty, `PPV_MPN_Results_${new Date().toISOString().slice(0, 10)}.xlsx`),
    [multiMpnResults, myPlant, qty]
  )

  // Derived state
  const isLoading = status === 'loading-ampl' || status === 'loading-iq' || status === 'loading-market'
  const bestPlant = plants[0]
  // globalBest = most-recent PO row for the plant with the best (lowest) recent price
  const globalBest = bestPlant
    ? bestPlant.rows.reduce((a, b) =>
        new Date(b.lastPoDate || 0) > new Date(a.lastPoDate || 0) ? b : a)
    : null
  const displayOffers = market
    ? strictMoq ? market.offers : [...market.offers].sort((a, b) => a.unit_price_usd - b.unit_price_usd)
    : []
  const displayBest   = displayOffers[0] ?? null
  const internalBest  = globalBest ? resolveLastPoPrice(globalBest) : null
  const refPrice      = pinnedPlant?.bestPrice ?? internalBest
  const refLabel      = pinnedPlant ? pinnedPlant.siteName : 'Global'
  const mktBest       = displayBest?.unit_price_usd ?? null
  const diffPct       = refPrice && mktBest ? ((mktBest - refPrice) / refPrice) * 100 : null
  const withStock     = market?.offers.filter(o => o.inventory > 0).length ?? 0
  const decision      = getDecision(diffPct, withStock, market?.total_offers ?? 0)
  const hasNexarData    = multiResults.some(r => r.nexarBestUsd != null)
  const hasNexarMpnData = multiMpnResults.some(r => r.nexarBestUsd != null)
  const activeMpnMap = useMemo(() => {
    const map = new Map<string, MpnInfo>()
    if (!ampl) return map
    for (const item of ampl.active)
      if (!map.has(item.MfgPartNumber))
        map.set(item.MfgPartNumber, { mpnPartNumber: item.MpnPartNumber, status: 'active' })
    return map
  }, [ampl])

  const blockedMpnMap = useMemo(() => {
    const map = new Map<string, MpnInfo>()
    if (!ampl) return map
    for (const item of ampl.blocked)
      if (!map.has(item.MfgPartNumber))
        map.set(item.MfgPartNumber, { mpnPartNumber: item.MpnPartNumber, status: 'blocked', blockCode: (item.Blocked ?? '').trim() })
    for (const item of ampl.deleted)
      if (!map.has(item.MfgPartNumber))
        map.set(item.MfgPartNumber, { mpnPartNumber: item.MpnPartNumber, status: 'deleted', blockCode: (item.Blocked ?? item.Deleted ?? '').trim() })
    return map
  }, [ampl])

  const blockedGroups = useMemo(() => {
    const groups = new Map<string, { code: string; rows: IQItem[] }>()
    for (const row of blockedIqRows) {
      const code = blockedMpnMap.get(row.mpn)?.blockCode ?? ''
      if (!groups.has(code)) groups.set(code, { code, rows: [] })
      groups.get(code)!.rows.push(row)
    }
    return [...groups.values()].map(g => ({ ...g, plants: buildPlantSummaries(g.rows) }))
  }, [blockedIqRows, blockedMpnMap])

  // ── Side panel ────────────────────────────────────────────────────────────
  const showComparison  = pinnedPlant !== null && selectedPlant !== null && selectedPlant.siteName !== pinnedPlant.siteName
  const showInvoice     = pinnedPlant === null && selectedPlant !== null
  const showMarketOffer = selectedOffer !== null
  const hasSidePanel    = showComparison || showInvoice || showMarketOffer

  const mktOfferDiff    = selectedOffer != null && refPrice != null
    ? selectedOffer.unit_price_usd - refPrice : null
  const mktOfferPctDiff = refPrice != null && refPrice > 0 && mktOfferDiff != null
    ? (mktOfferDiff / refPrice) * 100 : null
  const mktOfferTotal   = selectedOffer != null ? selectedOffer.unit_price_usd * qty : null

  const compRefPrice  = pinnedPlant?.bestPrice ?? null
  const compSelPrice  = selectedPlant?.bestPrice ?? null
  const compAbsDiff   = compRefPrice != null && compSelPrice != null ? compSelPrice - compRefPrice : null
  const compPctDiff   = compRefPrice != null && compAbsDiff != null ? (compAbsDiff / compRefPrice) * 100 : null
  const compTotalRef  = compRefPrice != null ? compRefPrice * qty : null
  const compTotalSel  = compSelPrice != null ? compSelPrice * qty : null
  const compTotalDiff = compTotalRef != null && compTotalSel != null ? compTotalSel - compTotalRef : null

  const invBestRow  = selectedPlant?.rows.reduce((a, b) =>
    (resolveLastPoPrice(a) ?? Infinity) <= (resolveLastPoPrice(b) ?? Infinity) ? a : b) ?? null
  const invUnitPO   = invBestRow ? resolveLastPoPrice(invBestRow) : null
  const invUnitStd  = invBestRow?.standardPriceUsd ?? null
  const invTotalPO  = invUnitPO != null ? invUnitPO * qty : null
  const invTotalStd = invUnitStd != null ? invUnitStd * qty : null
  const invDelta    = invTotalPO != null && invTotalStd != null ? invTotalPO - invTotalStd : null
  const invDeltaPct = invUnitStd != null && invUnitStd > 0 && invDelta != null
    ? (invDelta / (invUnitStd * qty)) * 100 : null

  const sidePanelEl = hasSidePanel ? (
    <div className="w-72 flex-shrink-0 bg-blue-700 text-white shadow-2xl overflow-y-auto flex flex-col"
      onClick={e => e.stopPropagation()}>

      {/* Header */}
      <div className="sticky top-0 z-10 bg-blue-800 px-4 py-3 flex items-center justify-between">
        <h3 className="font-bold text-sm">
          {showComparison ? '📊 Comparison Analysis' : showMarketOffer ? '🛒 Market Offer' : '🧾 Cost Estimate'}
        </h3>
        <button onClick={() => { setSelectedPlant(null); setSelectedOffer(null) }}
          className="text-blue-200 hover:text-white p-1 rounded transition-colors">
          <X size={14} />
        </button>
      </div>

      {/* ── Comparison mode ─────────────────────────────────────────── */}
      {showComparison && pinnedPlant && selectedPlant && (
        <div className="p-4 space-y-3 text-sm">

          {/* ① Hero — verdict first */}
          <div className={`rounded-xl p-4 text-center ${
            compAbsDiff == null ? 'bg-blue-600'
              : compAbsDiff > 0 ? 'bg-emerald-600'   // ref cheaper → alt more expensive
              : compAbsDiff < 0 ? 'bg-red-600'        // alt cheaper
              : 'bg-blue-600'
          }`}>
            <p className="text-white/70 text-[11px] uppercase tracking-widest mb-1">
              {selectedPlant.siteName} vs. {pinnedPlant.siteName} 📌
            </p>
            <p className="text-4xl font-black text-white tabular-nums leading-none">
              {compPctDiff != null ? `${compPctDiff > 0 ? '+' : ''}${compPctDiff.toFixed(1)}%` : '—'}
            </p>
            <p className="text-white font-semibold mt-1.5">
              {compAbsDiff == null ? '—'
                : compAbsDiff > 0 ? '📌 Reference is cheaper'
                : compAbsDiff < 0 ? '🔍 Alt plant is cheaper'
                : '🟡 Same price'}
            </p>
            <p className="text-white/60 text-xs mt-0.5">
              {compAbsDiff != null
                ? `${compAbsDiff >= 0 ? '+' : ''}${fmt6(compAbsDiff)} / unit`
                : 'No price data'}
            </p>
          </div>

          {/* ② Unit price — two columns with divider */}
          <div className="bg-blue-800/80 rounded-xl p-3 space-y-2">
            <div className="flex items-stretch gap-3">
              <div className="flex-1 min-w-0">
                <p className="text-blue-300 text-[11px] uppercase tracking-wide mb-1 truncate">
                  📌 {pinnedPlant.siteName}
                </p>
                <p className="text-white font-bold text-base font-mono leading-tight truncate">
                  {fmt6(pinnedPlant.bestPrice)}
                </p>
              </div>
              <div className="w-px bg-blue-600 self-stretch shrink-0" />
              <div className="flex-1 min-w-0 text-right">
                <p className="text-blue-300 text-[11px] uppercase tracking-wide mb-1 truncate">
                  🔍 {selectedPlant.siteName}
                </p>
                <p className="text-white font-bold text-base font-mono leading-tight truncate">
                  {fmt6(selectedPlant.bestPrice)}
                </p>
              </div>
            </div>
          </div>

          {/* ③ Totals at qty pcs */}
          <div className="bg-blue-800/80 rounded-xl p-3 space-y-2">
            <p className="text-blue-300 text-[11px] uppercase tracking-wide mb-1">At {qty.toLocaleString()} pcs</p>
            <div className="flex justify-between text-xs">
              <span className="text-blue-300">📌 {pinnedPlant.siteName}</span>
              <span className="font-mono font-semibold">{fmt2(compTotalRef)}</span>
            </div>
            <div className="flex justify-between text-xs">
              <span className="text-blue-300">🔍 {selectedPlant.siteName}</span>
              <span className="font-mono font-semibold">{fmt2(compTotalSel)}</span>
            </div>
            {compTotalDiff != null && (
              <div className="border-t border-blue-600 pt-2 flex justify-between text-xs items-center">
                <span className="text-blue-300">Δ Savings</span>
                <span className={`font-mono font-bold ${compTotalDiff > 0 ? 'text-emerald-300' : compTotalDiff < 0 ? 'text-red-300' : 'text-blue-100'}`}>
                  {compTotalDiff >= 0 ? '+' : ''}{fmt2(compTotalDiff)}
                </span>
              </div>
            )}
          </div>

          {/* ④ Supplier details side by side */}
          <div className="grid grid-cols-2 gap-2">
            <div className="bg-blue-600/50 rounded-xl p-2.5 space-y-1">
              <p className="text-blue-300 text-[10px] uppercase tracking-wide">📌 {pinnedPlant.siteName}</p>
              <p className="text-white text-xs font-semibold leading-snug truncate">{pinnedPlant.bestSupplier}</p>
              <p className="text-blue-300 text-[10px]">{pinnedPlant.lastPoDate}</p>
            </div>
            <div className="bg-blue-600/50 rounded-xl p-2.5 space-y-1">
              <p className="text-blue-300 text-[10px] uppercase tracking-wide">🔍 {selectedPlant.siteName}</p>
              <p className="text-white text-xs font-semibold leading-snug truncate">{selectedPlant.bestSupplier}</p>
              <p className="text-blue-300 text-[10px]">{selectedPlant.lastPoDate}</p>
            </div>
          </div>

        </div>
      )}

      {/* ── Invoice mode ────────────────────────────────────────────── */}
      {showInvoice && selectedPlant && invBestRow && (
        <div className="p-4 space-y-3 text-sm">

          {/* ① Hero — total cost prominent, verdict on delta */}
          <div className={`rounded-xl p-4 text-center ${
            invDelta == null ? 'bg-blue-600'
              : invDelta > 0 ? 'bg-red-600'
              : invDelta < 0 ? 'bg-emerald-600'
              : 'bg-blue-600'
          }`}>
            <p className="text-white/70 text-[11px] uppercase tracking-widest mb-1">
              Cost Estimate · {qty.toLocaleString()} pcs
            </p>
            <p className="text-4xl font-black text-white tabular-nums leading-none">{fmt2(invTotalPO)}</p>
            {invDeltaPct != null ? (
              <>
                <p className="text-white font-semibold mt-1.5">
                  {invDelta! > 0 ? '🔴 Above standard' : invDelta! < 0 ? '🟢 Below standard' : '🟡 At standard'}
                </p>
                <p className="text-white/60 text-xs mt-0.5">
                  {invDelta! >= 0 ? '+' : ''}{invDeltaPct.toFixed(1)}% · {invDelta! >= 0 ? '+' : ''}{fmt2(invDelta)} vs Std
                </p>
              </>
            ) : (
              <p className="text-white/60 text-xs mt-1.5">No standard price to compare</p>
            )}
          </div>

          {/* ② Unit price breakdown — two columns with divider */}
          <div className="bg-blue-800/80 rounded-xl p-3 space-y-2">
            <div className="flex items-stretch gap-3">
              <div className="flex-1 min-w-0">
                <p className="text-blue-300 text-[11px] uppercase tracking-wide mb-1">Last PO / unit</p>
                <p className="text-white font-bold text-base font-mono leading-tight truncate">{fmt6(invUnitPO)}</p>
              </div>
              <div className="w-px bg-blue-600 self-stretch shrink-0" />
              <div className="flex-1 min-w-0 text-right">
                <p className="text-blue-300 text-[11px] uppercase tracking-wide mb-1">Standard / unit</p>
                <p className="text-white font-bold text-base font-mono leading-tight truncate">{fmt6(invUnitStd)}</p>
              </div>
            </div>
            {invTotalStd != null && (
              <div className="border-t border-blue-600 pt-2 flex justify-between text-xs">
                <span className="text-blue-300">Standard total</span>
                <span className="font-mono text-blue-100">{fmt2(invTotalStd)}</span>
              </div>
            )}
          </div>

          {/* ③ Supplier & plant */}
          <div className="bg-blue-600/50 rounded-xl p-3 space-y-1.5">
            <p className="text-blue-200 text-[11px] uppercase tracking-wide mb-1">Plant & Supplier</p>
            <div className="flex justify-between text-xs">
              <span className="text-blue-300">Plant</span>
              <span className="font-semibold">{selectedPlant.siteName}</span>
            </div>
            <div className="flex justify-between text-xs gap-2">
              <span className="text-blue-300 shrink-0">Supplier</span>
              <span className="font-semibold text-right truncate">{invBestRow.supplierName}</span>
            </div>
            <div className="flex justify-between text-xs">
              <span className="text-blue-300">MPN</span>
              <span className="font-mono">{invBestRow.mpn}</span>
            </div>
            <div className="flex justify-between text-xs">
              <span className="text-blue-300">PO Date</span>
              <span className="text-blue-100">{invBestRow.lastPoDate}</span>
            </div>
          </div>

          {/* ④ Component info */}
          <div className="bg-blue-600/50 rounded-xl p-3 space-y-1">
            <p className="text-blue-200 text-[11px] uppercase tracking-wide mb-1">Component</p>
            <p className="font-bold text-sm">{ampl?.internal_part_number}</p>
            <p className="text-blue-300 text-xs leading-snug">{invBestRow.materialDescription}</p>
          </div>

        </div>
      )}

      {/* ── Market offer mode ────────────────────────────────────────── */}
      {showMarketOffer && selectedOffer && (
        <div className="p-4 space-y-3 text-sm">

          {/* ① Verdict — first thing the eye sees */}
          {mktOfferPctDiff != null ? (
            <div className={`rounded-xl p-4 text-center ${mktOfferDiff! < 0 ? 'bg-emerald-600' : mktOfferDiff! > 0 ? 'bg-red-600' : 'bg-blue-600'}`}>
              <p className="text-white/70 text-[11px] uppercase tracking-widest mb-1">
                Market vs. {pinnedPlant ? `${pinnedPlant.siteName} 📌` : 'best PO'}
              </p>
              <p className="text-4xl font-black text-white tabular-nums leading-none">
                {mktOfferPctDiff >= 0 ? '+' : ''}{mktOfferPctDiff.toFixed(1)}%
              </p>
              <p className="text-white font-semibold mt-1.5">
                {mktOfferDiff! < 0 ? '🟢 Market is cheaper' : mktOfferDiff! > 0 ? '🔴 Market is pricier' : '🟡 Same price'}
              </p>
              <p className="text-white/60 text-xs mt-0.5">
                {mktOfferDiff! >= 0 ? '+' : ''}{fmt6(mktOfferDiff)} / unit vs. {pinnedPlant ? pinnedPlant.siteName : 'global best'}
              </p>
            </div>
          ) : (
            <div className="rounded-xl p-4 text-center bg-blue-600">
              <p className="text-white/70 text-[11px] uppercase tracking-widest mb-1">Market Offer</p>
              <p className="text-white text-sm">Pin a plant to compare vs. a reference</p>
            </div>
          )}

          {/* ② Price breakdown */}
          <div className="bg-blue-800/80 rounded-xl p-3 space-y-2">
            <div className="flex items-stretch gap-3">
              <div className="flex-1 min-w-0">
                <p className="text-blue-300 text-[11px] uppercase tracking-wide mb-1">Unit Price</p>
                <p className="text-white font-bold text-base font-mono leading-tight truncate">{fmt6(selectedOffer.unit_price_usd)}</p>
              </div>
              <div className="w-px bg-blue-600 self-stretch shrink-0" />
              <div className="flex-1 min-w-0 text-right">
                <p className="text-blue-300 text-[11px] uppercase tracking-wide mb-1">Total · {qty.toLocaleString()} pcs</p>
                <p className="text-white font-bold text-base font-mono leading-tight truncate">{fmt2(mktOfferTotal)}</p>
              </div>
            </div>
            {internalBest != null && (
              <div className="border-t border-blue-600 pt-2 flex justify-between text-xs">
                <span className="text-blue-300">{pinnedPlant ? `${pinnedPlant.siteName} 📌` : 'Global best (EMS)'}</span>
                <span className="font-mono text-blue-100">{fmt6(refPrice)}</span>
              </div>
            )}
          </div>

          {/* ③ Stock & availability */}
          <div className="bg-blue-600/50 rounded-xl p-3 space-y-1.5">
            <div className="flex items-center justify-between">
              <p className="text-blue-200 text-[11px] uppercase tracking-wide">Availability</p>
              <span className={`text-xs font-semibold px-2 py-0.5 rounded-full ${selectedOffer.can_fulfill ? 'bg-emerald-500 text-white' : 'bg-amber-400 text-white'}`}>
                {selectedOffer.can_fulfill ? '✅ Can Fulfill' : '⚠️ MOQ Issue'}
              </span>
            </div>
            <div className="flex justify-between text-xs mt-1">
              <span className="text-blue-300">In stock</span>
              <span className={`font-mono font-semibold ${selectedOffer.inventory > 0 ? 'text-emerald-300' : 'text-red-300'}`}>
                {selectedOffer.inventory.toLocaleString()}
              </span>
            </div>
            <div className="flex justify-between text-xs">
              <span className="text-blue-300">MOQ</span>
              <span className="font-mono">{selectedOffer.moq.toLocaleString()}</span>
            </div>
          </div>

          {/* ④ Seller & part info */}
          <div className="bg-blue-600/50 rounded-xl p-3 space-y-1">
            <p className="font-bold text-base leading-tight">{selectedOffer.seller}</p>
            <p className="text-blue-200 text-xs">{selectedOffer.manufacturer}</p>
            <p className="font-mono text-xs text-blue-100 mt-1">MPN: {selectedOffer.mpn}</p>
            <p className="text-blue-300 text-xs">Packaging: {selectedOffer.packaging || '—'}</p>
            {selectedOffer.description && <p className="text-blue-300 text-xs leading-snug mt-0.5">{selectedOffer.description}</p>}
          </div>

          {/* ⑤ CTA */}
          {selectedOffer.click_url && (
            <a href={selectedOffer.click_url} target="_blank" rel="noopener noreferrer"
              className="flex items-center justify-center gap-2 bg-blue-500 hover:bg-blue-400 text-white text-xs font-semibold py-2.5 rounded-xl transition-colors">
              View on Nexar <ExternalLink size={12} />
            </a>
          )}
        </div>
      )}
    </div>
  ) : null

  return (
    <>
      {/* ── Floating Action Button ───────────────────────────────────────── */}
      <button
        onClick={() => setOpen(true)}
        className="fixed bottom-6 right-6 z-40 w-14 h-14 rounded-full bg-blue-600 text-white shadow-lg hover:bg-blue-700 active:scale-95 transition-all flex items-center justify-center group"
        title="Price Calculator"
      >
        <Calculator size={22} />
        <span className="absolute right-16 whitespace-nowrap bg-slate-800 text-white text-xs px-2 py-1 rounded-lg opacity-0 group-hover:opacity-100 transition-opacity pointer-events-none">
          Price Calculator
        </span>
      </button>

      {/* ── Drawer ──────────────────────────────────────────────────────── */}
      {open && (
        <div className="fixed inset-0 z-50 flex" onClick={() => setOpen(false)}>
          {/* Backdrop */}
          <div className="flex-1 bg-black/40" />

          {/* Side panel (Comparison / Invoice) */}
          {sidePanelEl}

          {/* Panel */}
          <div
            className={`${activeTab !== 'single' ? 'w-full' : 'w-full max-w-4xl'} bg-white shadow-2xl overflow-y-auto flex flex-col animate-slideInRight`}
            onClick={e => e.stopPropagation()}
          >
            {/* Header */}
            <div className="sticky top-0 z-10 bg-white border-b border-gray-200 px-6 py-4 flex items-center gap-3">
              <div className="w-8 h-8 rounded-lg bg-blue-600 flex items-center justify-center text-white">
                <Calculator size={16} />
              </div>
              <div className="flex-1">
                <h2 className="font-bold text-gray-800 leading-tight">Price Calculator</h2>
                <p className="text-xs text-gray-400">SAP + EMS InternalQuery + Nexar Market</p>
              </div>
              <button onClick={() => setOpen(false)} className="text-gray-400 hover:text-gray-700 p-1.5 rounded-lg hover:bg-gray-100">
                <X size={18} />
              </button>
            </div>

            {/* Tabs */}
            <div className="px-6 pt-3 pb-0 flex-shrink-0 border-b border-gray-100">
              <div className="flex gap-1 bg-gray-100 rounded-xl p-1 w-fit">
                <button
                  onClick={() => setActiveTab('single')}
                  className={`px-4 py-1.5 text-sm font-medium rounded-lg transition-colors ${activeTab === 'single' ? 'bg-white text-blue-600 shadow-sm' : 'text-gray-500 hover:text-gray-700'}`}
                >
                  🔍 Single
                </button>
                <button
                  onClick={() => setActiveTab('multi')}
                  className={`px-4 py-1.5 text-sm font-medium rounded-lg transition-colors ${activeTab === 'multi' ? 'bg-white text-blue-600 shadow-sm' : 'text-gray-500 hover:text-gray-700'}`}
                >
                  📋 Multi-Component
                </button>
                <button
                  onClick={() => setActiveTab('mpn')}
                  className={`px-4 py-1.5 text-sm font-medium rounded-lg transition-colors ${activeTab === 'mpn' ? 'bg-white text-blue-600 shadow-sm' : 'text-gray-500 hover:text-gray-700'}`}
                >
                  🔬 Multi-MPN
                </button>
              </div>
            </div>

            <div className="flex-1 p-6 space-y-6">
              {/* ══════════════ SINGLE TAB ══════════════ */}
              {activeTab === 'single' && (<>
              <div className="bg-gray-50 rounded-xl border border-gray-200 p-5">
                <div className="flex gap-4 mb-4">
                  <div className="flex-1">
                    <label className="block text-sm font-medium text-gray-600 mb-1.5">Component Number (BMATN)</label>
                    <input
                      type="text" placeholder="e.g. EC03018"
                      value={bmatn} onChange={e => setBmatn(e.target.value)}
                      onKeyDown={e => e.key === 'Enter' && !isLoading && handleSearch()}
                      className="w-full rounded-lg border border-gray-300 px-4 py-2.5 text-sm font-mono uppercase focus:outline-none focus:ring-2 focus:ring-blue-500"
                    />
                  </div>
                  <div className="w-40">
                    <label className="block text-sm font-medium text-gray-600 mb-1.5">Quantity</label>
                    <input
                      type="number" min={0.0001} step="any" value={qty}
                      onChange={e => setQty(Math.max(0.0001, parseFloat(e.target.value) || 0.0001))}
                      className="w-full rounded-lg border border-gray-300 px-4 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
                    />
                  </div>
                </div>
                <button
                  onClick={handleSearch} disabled={isLoading || !bmatn.trim()}
                  className="px-6 py-2.5 bg-blue-600 text-white rounded-lg text-sm font-semibold hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
                >
                  {status === 'loading-ampl' ? 'Fetching MPNs from SAP…'
                    : status === 'loading-iq' ? 'Querying EMS prices…'
                    : status === 'loading-market' ? 'Querying Nexar market…'
                    : 'Search'}
                </button>
              </div>

              {/* ── Loading indicator ────────────────────────────────── */}
              {isLoading && (
                <div className="flex items-center gap-3 text-sm text-gray-500 bg-blue-50 border border-blue-200 rounded-xl px-5 py-4">
                  <svg className="animate-spin h-4 w-4 text-blue-600" fill="none" viewBox="0 0 24 24">
                    <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                    <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8H4z" />
                  </svg>
                  {status === 'loading-ampl' ? 'Fetching MPNs from SAP…'
                    : status === 'loading-iq' ? 'Querying prices in EMS…'
                    : 'Querying market prices in Nexar…'}
                </div>
              )}

              {/* ── Error ────────────────────────────────────────────── */}
              {status === 'error' && (
                <div className="rounded-xl bg-red-50 border border-red-200 px-5 py-4 text-sm text-red-700">
                  <strong>Error:</strong> {error}
                </div>
              )}

              {/* ── AMPL JSON viewer (shown on error when fallback was used) ── */}
              {status === 'error' && ampl && usedFallback && (
                <div className="bg-amber-50 border border-amber-200 rounded-lg text-xs text-amber-800">
                  <div className="flex items-center justify-between px-3 py-2">
                    <span className="font-medium">⚠️ AMPL response (blocked/deleted MPNs)</span>
                    <button
                      onClick={() => setShowAmplJson(v => !v)}
                      className="text-amber-700 hover:text-amber-900 font-mono font-bold border border-amber-300 rounded px-1.5 py-0.5 bg-amber-100 hover:bg-amber-200 transition-colors"
                    >
                      {showAmplJson ? '▲ Ocultar' : '▼ Ver JSON'}
                    </button>
                  </div>
                  {showAmplJson && (
                    <div className="border-t border-amber-200 px-3 py-2">
                      <pre className="text-[10px] text-slate-700 bg-white border border-slate-200 rounded p-2 overflow-x-auto max-h-96 leading-relaxed">{JSON.stringify(ampl, null, 2)}</pre>
                    </div>
                  )}
                </div>
              )}

              {/* ── Results ──────────────────────────────────────────── */}
              {status === 'done' && ampl && (
                <>
                  {/* Component header */}
                  <div className="flex items-center gap-3 flex-wrap">
                    <h3 className="text-lg font-bold text-gray-800">{ampl.internal_part_number}</h3>
                    <span className="text-sm text-gray-500 bg-gray-100 px-3 py-1 rounded-full">
                      {iqRows[0]?.materialDescription}
                    </span>
                    <div className="flex gap-2 text-xs">
                      <span className="bg-emerald-100 text-emerald-700 px-2 py-1 rounded-full font-medium">
                        ✓ {ampl.total_active} active MPNs
                      </span>
                      {ampl.total_blocked > 0 && (
                        <span className="bg-amber-100 text-amber-700 px-2 py-1 rounded-full font-medium">
                          ⚠ {ampl.total_blocked} blocked
                        </span>
                      )}
                      {ampl.total_deleted > 0 && (
                        <span className="bg-red-100 text-red-700 px-2 py-1 rounded-full font-medium">
                          ✕ {ampl.total_deleted} deleted
                        </span>
                      )}
                    </div>
                  </div>

                  {/* Fallback warning */}
                  {usedFallback && ampl && (
                    <div className="bg-amber-50 border border-amber-200 rounded-lg text-xs text-amber-800">
                      <div className="flex items-start gap-2 px-3 py-2">
                        <span className="text-base leading-none">⚠️</span>
                        <span className="flex-1">No active MPNs found — showing results based on <strong>blocked/deleted</strong> MPNs. Pricing data may be outdated.</span>
                        <button
                          onClick={() => setShowAmplJson(v => !v)}
                          className="ml-2 text-amber-700 hover:text-amber-900 font-mono font-bold border border-amber-300 rounded px-1.5 py-0.5 bg-amber-100 hover:bg-amber-200 transition-colors whitespace-nowrap"
                        >
                          {showAmplJson ? '▲ Hide JSON' : '▼ Ver JSON'}
                        </button>
                      </div>
                      {showAmplJson && (
                        <div className="border-t border-amber-200 px-3 py-2">
                          <pre className="text-[10px] text-slate-700 bg-white border border-slate-200 rounded p-2 overflow-x-auto max-h-64 leading-relaxed">{JSON.stringify(ampl, null, 2)}</pre>
                        </div>
                      )}
                    </div>
                  )}

                  {/* No SAP pricing data */}
                  {!globalBest && (
                    <div className="rounded-xl bg-yellow-50 border border-yellow-200 px-5 py-4 text-sm text-yellow-800 space-y-1">
                      <p><strong>No purchase history found for the active MPNs.</strong></p>
                      <p className="text-xs text-yellow-700">The active MPNs ({ampl.mpns_list.join(', ')}) exist in SAP but the IQ system has no purchase order records for them. This may happen if the component was recently approved or has never been purchased under these MPNs.</p>
                    </div>
                  )}

                  {/* KPI cards + Plant Summary + Detail — only when SAP data exists */}
                  {globalBest && (
                    <>
                      {/* KPI cards */}
                      <div className="grid grid-cols-3 gap-4">
                        <StatCard icon="🏭" label="Best Plant" value={bestPlant?.siteName ?? '—'} highlight />
                        <StatCard icon="🤝" label="Best Supplier" value={globalBest.supplierName} sub={`#${globalBest.supplierNumber}`} />
                        <StatCard icon="💰" label="Best Price (USD)" value={fmt6(resolveLastPoPrice(globalBest))} sub={`Last PO: ${globalBest.lastPoDate}`} />
                      </div>

                      {/* Plant Summary */}
                      <div>
                        <div className="flex items-center justify-between mb-2">
                          <h4 className="text-sm font-semibold text-gray-700">Plant Summary</h4>
                          <p className="text-xs text-gray-400">Click 📌 to pin · click row for invoice or comparison</p>
                        </div>
                        <PlantTable
                          plants={plants}
                          bestPlant={bestPlant?.siteName ?? ''}
                          pinnedSite={pinnedPlant?.siteName}
                          selectedSite={selectedPlant?.siteName}
                          onPin={p => setPinnedPlant(prev => prev?.siteName === p.siteName ? null : p)}
                          onSelect={p => { setSelectedPlant(prev => prev?.siteName === p.siteName ? null : p); setSelectedOffer(null) }}
                          variant={usedFallback ? 'orange' : 'green'}
                          mpnInfoMap={activeMpnMap}
                        />
                      </div>

                      {/* Detail toggle */}
                      <div>
                        <button onClick={() => setShowDetail(v => !v)}
                          className="flex items-center gap-1.5 text-sm text-blue-600 hover:underline font-medium">
                          {showDetail ? <><ChevronUp size={14} /> Hide full detail</> : <><ChevronDown size={14} /> Show full detail</>}
                        </button>
                        {showDetail && <div className="mt-3"><DetailTable rows={iqRows} mpnInfoMap={activeMpnMap} /></div>}
                      </div>

                      {/* Historical Purchase Data — Blocked/Deleted MPNs (expander) */}
                      {blockedGroups.length > 0 && (
                        <div>
                          <button onClick={() => setShowBlockedDetail(v => !v)}
                            className="flex items-center gap-1.5 text-sm text-orange-600 hover:underline font-medium">
                            {showBlockedDetail
                              ? <><ChevronUp size={14} /> Hide Blocked/Deleted MPNs</>
                              : <><ChevronDown size={14} /> Show Blocked/Deleted MPNs ({blockedGroups.length} reason{blockedGroups.length > 1 ? 's' : ''})</>}
                          </button>
                          {showBlockedDetail && (
                            <div className="mt-3 rounded-xl border border-orange-200 bg-orange-50 space-y-4 p-4">
                              <div className="flex items-start gap-2">
                                <span className="text-lg leading-none">🗂️</span>
                                <div>
                                  <p className="text-sm font-semibold text-orange-800">Purchase Data — Blocked / Deleted MPNs</p>
                                  <p className="text-xs text-orange-700 mt-0.5">
                                    Historical pricing grouped by SAP block reason. Shown for reference only.
                                  </p>
                                </div>
                              </div>

                              {blockedGroups.map(group => {
                                const label = BLOCK_REASONS[group.code] ?? (group.code ? group.code : 'Unknown reason')
                                const groupBest = group.rows.reduce((a, b) =>
                                  (resolveLastPoPrice(a) ?? Infinity) <= (resolveLastPoPrice(b) ?? Infinity) ? a : b)
                                const isDanger = group.code === 'F' || group.code === 'ER'
                                return (
                                  <div key={group.code || '__none__'} className="space-y-3">
                                    {/* Group header */}
                                    <div className={`flex items-center gap-2 rounded-lg px-3 py-2 ${isDanger ? 'bg-red-100 border border-red-200' : 'bg-amber-100 border border-amber-200'}`}>
                                      {group.code && (
                                        <span className={`text-xs font-bold px-2 py-0.5 rounded ${isDanger ? 'bg-red-200 text-red-800' : 'bg-amber-200 text-amber-800'}`}>
                                          {group.code}
                                        </span>
                                      )}
                                      <span className={`text-sm font-semibold ${isDanger ? 'text-red-800' : 'text-amber-800'}`}>{label}</span>
                                      <span className="text-xs text-gray-400 ml-auto">{group.rows.length} record{group.rows.length > 1 ? 's' : ''}</span>
                                    </div>
                                    {/* KPI mini-cards */}
                                    <div className="grid grid-cols-3 gap-3 text-xs">
                                      <div className="bg-white rounded-lg border border-orange-200 p-3">
                                        <p className="text-gray-400 mb-1">🏭 Best Plant</p>
                                        <p className="font-bold text-gray-800">{group.plants[0]?.siteName ?? '—'}</p>
                                      </div>
                                      <div className="bg-white rounded-lg border border-orange-200 p-3">
                                        <p className="text-gray-400 mb-1">🤝 Supplier</p>
                                        <p className="font-bold text-gray-800 truncate">{groupBest.supplierName}</p>
                                        <p className="text-gray-500">#{groupBest.supplierNumber}</p>
                                      </div>
                                      <div className="bg-white rounded-lg border border-orange-200 p-3">
                                        <p className="text-gray-400 mb-1">💰 Last Price (USD)</p>
                                        <p className="font-bold text-gray-800">{fmt6(resolveLastPoPrice(groupBest))}</p>
                                        <p className="text-gray-500">{groupBest.lastPoDate}</p>
                                      </div>
                                    </div>
                                    <PlantTable
                                      plants={group.plants}
                                      bestPlant={group.plants[0]?.siteName ?? ''}
                                      onPin={() => {}}
                                      onSelect={() => {}}
                                      variant="orange"
                                      mpnInfoMap={blockedMpnMap}
                                    />
                                    <DetailTable rows={group.rows} variant="orange" mpnInfoMap={blockedMpnMap} />
                                  </div>
                                )
                              })}
                            </div>
                          )}
                        </div>
                      )}
                    </>
                  )}

                  {/* Market section */}
                  {market && (
                    <div className="space-y-4">
                      {/* Market header */}
                      <div className="flex items-start justify-between flex-wrap gap-3">
                        <div>
                          <h4 className="text-sm font-semibold text-gray-700">Market Prices — Nexar</h4>
                          <p className="text-xs text-gray-400 mt-0.5">{market.total_offers} offers · {qty.toLocaleString()} pcs</p>
                        </div>
                        <div className="flex items-center gap-4">
                          <label className="flex items-center gap-2 cursor-pointer select-none text-sm text-gray-600">
                            Filter by MOQ
                            <button
                              role="switch" aria-checked={strictMoq} onClick={() => setStrictMoq(v => !v)}
                              className={`relative inline-flex w-10 h-5 rounded-full transition-colors ${strictMoq ? 'bg-blue-500' : 'bg-gray-300'}`}
                            >
                              <span className={`absolute top-0.5 left-0.5 w-4 h-4 bg-white rounded-full shadow transition-transform ${strictMoq ? 'translate-x-5' : 'translate-x-0'}`} />
                            </button>
                          </label>
                          <button onClick={() => setShowMarket(v => !v)} className="text-sm text-blue-600 hover:underline font-medium flex items-center gap-1">
                            {showMarket ? <><ChevronUp size={14} /> Hide</> : <><ChevronDown size={14} /> Show</>}
                          </button>
                        </div>
                      </div>

                      {/* Market KPIs */}
                      {/* Decision banner */}
                      <div className={`rounded-xl border-2 px-4 py-3 flex items-center gap-3 ${decision.bg}`}>
                        <span className="text-2xl leading-none">{decision.icon}</span>
                        <div className="flex-1 min-w-0">
                          <p className="text-xs text-gray-500 uppercase tracking-wide font-medium">Recommendation</p>
                          <p className={`text-sm font-bold ${decision.color}`}>{decision.text}</p>
                        </div>
                        {diffPct !== null && (
                          <div className="text-right shrink-0 border-l border-gray-200 pl-4 ml-1">
                            <p className="text-[10px] text-gray-400 uppercase tracking-wide mb-0.5">Market vs. your PO</p>
                            <p className={`text-xl font-bold tabular-nums ${diffPct < 0 ? 'text-emerald-700' : diffPct > 15 ? 'text-red-600' : 'text-amber-600'}`}>
                              {diffPct > 0 ? '+' : ''}{diffPct.toFixed(1)}%
                            </p>
                            <p className="text-[11px] text-gray-500">
                              {fmt6(mktBest)} vs. {fmt6(refPrice)}
                            </p>
                            <p className="text-[10px] text-gray-400">{refLabel}{pinnedPlant ? ' 📌' : ' · best PO'}</p>
                          </div>
                        )}
                      </div>
                      {/* 3 stat cards */}
                      <div className="grid grid-cols-3 gap-3">
                        <div className="bg-white rounded-xl border border-gray-200 p-3">
                          <p className="text-xs text-gray-400 mb-1">💹 Best Market Price</p>
                          <p className="text-sm font-bold text-blue-700 font-mono">{displayBest ? fmt6(displayBest.unit_price_usd) : '—'}</p>
                          <p className="text-xs text-gray-500 truncate mt-0.5">{displayBest?.seller ?? 'No offers'}</p>
                        </div>
                        <div className="bg-white rounded-xl border border-gray-200 p-3">
                          <p className="text-xs text-gray-400 mb-1">🏭 Internal Reference</p>
                          <p className="text-sm font-bold text-gray-800 font-mono">{fmt6(refPrice)}</p>
                          <p className="text-xs text-gray-500 mt-0.5">{refLabel}{pinnedPlant ? ' 📌' : ' · best PO'}</p>
                        </div>
                        <div className="bg-white rounded-xl border border-gray-200 p-3">
                          <p className="text-xs text-gray-400 mb-1">📦 In Stock</p>
                          <p className="text-sm font-bold text-gray-800">{withStock} <span className="text-xs font-normal text-gray-400">of {market.total_offers}</span></p>
                          <p className="text-xs text-gray-500 mt-0.5">{market.total_offers - withStock > 0 ? `${market.total_offers - withStock} out of stock` : 'All in stock'}</p>
                        </div>
                      </div>

                      {/* Market table */}
                      {showMarket && <MarketTable
                        offers={displayOffers} quantity={qty} strictMoq={strictMoq}
                        selectedOffer={selectedOffer}
                        onSelect={o => { setSelectedOffer(prev => prev === o ? null : o); setSelectedPlant(null) }}
                      />}
                    </div>
                  )}
                </>
              )}
              </>)}

              {/* ══════════════ MULTI TAB ══════════════ */}
              {activeTab === 'multi' && (
                <div className="space-y-6">

                  {/* Multi search form */}
                  <div className="bg-gray-50 rounded-xl border border-gray-200 p-5">
                    <div className="flex gap-4 mb-4">
                      <div className="flex-1">
                        <div className="flex items-center justify-between mb-1.5">
                        <label className="block text-sm font-medium text-gray-600">
                            Component Numbers
                            <span className="text-gray-400 font-normal ml-1">{excelFileName ? '' : '(one per line or comma-separated)'}</span>
                          </label>
                          <div className="flex items-center gap-2">
                            {excelFileName && (
                              <span className="flex items-center gap-1 text-[11px] text-emerald-700 bg-emerald-50 border border-emerald-200 rounded-full px-2 py-0.5">
                                <svg className="h-3 w-3" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" /></svg>
                                {excelFileName}
                                <button
                                  onClick={() => { setExcelFileName(''); setComponentQtys({}); setComponentQtyDefaults({}); setMultiBmatn('') }}
                                  className="ml-1 text-emerald-500 hover:text-red-500 font-bold leading-none"
                                  title="Clear Excel data"
                                >×</button>
                              </span>
                            )}
                            <label className="flex items-center gap-1.5 cursor-pointer px-3 py-1 text-xs font-semibold rounded-lg bg-white border border-gray-300 hover:border-blue-400 hover:text-blue-600 text-gray-600 transition-colors">
                              <svg className="h-3.5 w-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-8l-4-4m0 0L8 8m4-4v12" /></svg>
                              Upload Excel
                              <input type="file" accept=".xlsx,.xls" className="hidden" onChange={handleExcelUpload} />
                            </label>
                            <button
                              onClick={downloadTemplate}
                              className="flex items-center gap-1.5 px-3 py-1 text-xs font-semibold rounded-lg bg-white border border-gray-300 hover:border-emerald-400 hover:text-emerald-600 text-gray-600 transition-colors"
                              title="Download Excel template with Component and Quantity columns"
                            >
                              <svg className="h-3.5 w-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 10v6m0 0l-3-3m3 3l3-3m2 8H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" /></svg>
                              Template
                            </button>
                          </div>
                        </div>
                        {excelFileName ? (
                          /* ── Dataframe preview ── */
                          <div className="w-full rounded-lg border border-emerald-200 bg-white overflow-hidden" style={{ height: '172px' }}>
                            <div className="overflow-y-auto h-full">
                              <table className="w-full text-xs border-collapse">
                                <thead className="sticky top-0 bg-emerald-600 text-white text-[10px] uppercase tracking-wide">
                                  <tr>
                                    <th className="px-2 py-1.5 text-center w-8 font-semibold">#</th>
                                    <th className="px-3 py-1.5 text-left font-semibold">Component</th>
                                    <th className="px-3 py-1.5 text-right font-semibold">Quantity</th>
                                  </tr>
                                </thead>
                                <tbody>
                                  {Object.entries(componentQtys).map(([comp, q], idx) => (
                                    <tr key={comp} className={idx % 2 === 0 ? 'bg-white' : 'bg-gray-50'}>
                                      <td className="px-2 py-1 text-center text-gray-400 font-mono">{idx + 1}</td>
                                      <td className="px-3 py-1 font-mono font-semibold text-gray-800">{comp}</td>
                                      <td className="px-3 py-1 text-right font-mono text-blue-700">
                                        {q.toLocaleString()}
                                        {componentQtyDefaults[comp] && (
                                          <span className="ml-1 text-[10px] text-gray-400 font-normal">
                                            ({componentQtyDefaults[comp]})
                                          </span>
                                        )}
                                      </td>
                                    </tr>
                                  ))}
                                </tbody>
                              </table>
                            </div>
                            <div className="border-t border-emerald-100 bg-emerald-50 px-3 py-1 text-[10px] text-emerald-700 font-medium">
                              {Object.keys(componentQtys).length} component{Object.keys(componentQtys).length !== 1 ? 's' : ''} loaded
                            </div>
                          </div>
                        ) : (
                          /* ── Normal textarea ── */
                          <textarea
                            placeholder={"EC03018\nEC05432\nEC09876"}
                            value={multiBmatn}
                            onChange={e => setMultiBmatn(e.target.value.toUpperCase())}
                            rows={6}
                            className="w-full rounded-lg border border-gray-300 px-4 py-2.5 text-sm font-mono focus:outline-none focus:ring-2 focus:ring-blue-500 resize-y"
                          />
                        )}
                      </div>
                      {!excelFileName && (
                      <div className="w-40">
                        <label className="block text-sm font-medium text-gray-600 mb-1.5">Quantity</label>
                        <input
                          type="number" min={0.0001} step="any" value={qty}
                          onChange={e => setQty(Math.max(0.0001, parseFloat(e.target.value) || 0.0001))}
                          className="w-full rounded-lg border border-gray-300 px-4 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
                        />
                      </div>
                      )}
                      <div className="w-40">
                        <label className="block text-sm font-medium text-gray-600 mb-1.5">My Plant</label>
                        <select
                          value={myPlant}
                          onChange={e => setMyPlant(e.target.value)}
                          className="w-full rounded-lg border border-gray-300 px-3 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 bg-white"
                        >
                          <option value="">— None —</option>
                          <option value="KEMX">KEMX</option>
                          <option value="KEJ">KEJ</option>
                          <option value="KECN">KECN</option>
                          <option value="KETL">KETL</option>
                          <option value="KEPS">KEPS</option>
                          <option value="KERO">KERO</option>
                        </select>
                      </div>
                    </div>
                    <div className="flex items-center gap-4">
                      <button
                        onClick={multiLoading ? () => abortRef.current?.abort() : handleMultiSearch}
                        disabled={!multiLoading && !multiBmatn.trim()}
                        onMouseEnter={() => { if (multiLoading) setStopHover(true) }}
                        onMouseLeave={() => setStopHover(false)}
                        className={`px-6 py-2.5 rounded-lg text-sm font-semibold transition-colors ${
                          multiLoading && stopHover
                            ? 'bg-red-600 text-white hover:bg-red-700 cursor-pointer'
                            : multiLoading
                            ? 'bg-blue-400 text-white cursor-default'
                            : 'bg-blue-600 text-white hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed'
                        }`}
                      >
                        {/* Fixed-width trick: invisible spacer holds the widest text, visible label overlays it */}
                        <span className="relative inline-flex items-center justify-center">
                          <span className="invisible select-none" aria-hidden>Searching…</span>
                          <span className="absolute inset-0 flex items-center justify-center">
                            {multiLoading && stopHover ? 'Stop' : multiLoading ? 'Searching…' : 'Search All'}
                          </span>
                        </span>
                      </button>
                      <label className="flex items-center gap-2 cursor-pointer select-none">
                        <input
                          type="checkbox"
                          checked={searchNexar}
                          onChange={e => setSearchNexar(e.target.checked)}
                          className="w-4 h-4 accent-purple-600 cursor-pointer"
                        />
                        <span className="text-sm text-gray-600">Include <span className="font-semibold text-purple-600">Nexar Market</span></span>
                      </label>
                    </div>
                  </div>

                  {/* Multi results table */}
                  {multiResults.length > 0 && (
                    <div>
                      <div className="flex items-center gap-3 mb-3">
                        <div className="flex gap-1 bg-gray-100 rounded-xl p-0.5">
                          <button
                            onClick={() => setMultiSubTab('results')}
                            className={`px-3 py-1.5 text-xs font-medium rounded-lg transition-colors ${multiSubTab === 'results' ? 'bg-white text-blue-600 shadow-sm' : 'text-gray-500 hover:text-gray-700'}`}
                          >
                            📊 Results ({multiResults.filter(r => r.status === 'done').length})
                          </button>
                          <button
                            onClick={() => setMultiSubTab('blocked')}
                            className={`px-3 py-1.5 text-xs font-medium rounded-lg transition-colors ${multiSubTab === 'blocked' ? 'bg-white text-red-600 shadow-sm' : 'text-gray-500 hover:text-gray-700'}`}
                          >
                            🚫 Blocked / Deleted ({multiResults.reduce((s, r) => s + (r.totalBlocked ?? 0) + (r.totalDeleted ?? 0), 0)})
                          </button>
                        </div>
                        {multiLoading && (
                          <div className="flex items-center gap-1.5 text-xs text-blue-600">
                            <svg className="animate-spin h-3 w-3" fill="none" viewBox="0 0 24 24">
                              <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                              <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8H4z" />
                            </svg>
                            Querying…
                          </div>
                        )}
                        {multiSubTab === 'results' && !multiLoading && multiResults.some(r => r.status === 'done') && (
                          <button
                            onClick={downloadResultsExcel}
                            className="ml-auto flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold rounded-lg bg-emerald-600 hover:bg-emerald-700 text-white shadow-sm transition-colors"
                          >
                            <Download className="h-3.5 w-3.5" />
                            Export Excel
                          </button>
                        )}
                      </div>
                      {multiSubTab === 'results' && (<div className="overflow-x-auto rounded-xl border border-gray-200 shadow-sm">
                        <table className="min-w-max w-full text-xs border-collapse">
                          <thead className="bg-gray-50 text-[10px] uppercase tracking-wide text-gray-500 sticky top-0">
                            <tr>
                              <th className="px-2 py-2.5 w-6 border-b border-gray-200" />
                              <th className="px-3 py-2.5 text-left whitespace-nowrap border-b border-gray-200">MPN</th>
                              <th className="px-3 py-2.5 text-left whitespace-nowrap border-b border-gray-200">Alt PN</th>
                              <th className="px-3 py-2.5 text-left whitespace-nowrap border-b border-gray-200">Supplier</th>
                              <th className="px-3 py-2.5 text-left whitespace-nowrap border-b border-gray-200">Searched</th>
                              <th className="px-3 py-2.5 text-left whitespace-nowrap border-b border-gray-200">Internal PN</th>
                              <th className="px-3 py-2.5 text-left whitespace-nowrap border-b border-gray-200">Plant</th>
                              <th className="px-3 py-2.5 text-right whitespace-nowrap border-b border-gray-200">Qty</th>
                              <th className="px-3 py-2.5 text-center whitespace-nowrap border-b border-gray-200">Cur</th>
                              <th className="px-3 py-2.5 text-right whitespace-nowrap border-b border-gray-200">Last PO (Local)</th>
                              <th className="px-3 py-2.5 text-right whitespace-nowrap border-b border-gray-200">Std (Local)</th>
                              <th className="px-3 py-2.5 text-right whitespace-nowrap border-b border-gray-200">Last PO (USD)</th>
                              <th className="px-3 py-2.5 text-right whitespace-nowrap border-b border-gray-200">Std (USD)</th>
                              <th className="px-3 py-2.5 text-right whitespace-nowrap border-b border-gray-200">QTY Inserted</th>
                              <th className="px-3 py-2.5 text-right whitespace-nowrap border-b border-gray-200">Total Cost (USD) per QTY Inserted</th>
                              <th className="px-3 py-2.5 text-left whitespace-nowrap border-b border-gray-200">Date</th>
                              <th className="px-3 py-2.5 text-center whitespace-nowrap border-b border-gray-200">Last PO Price &gt; Std Price</th>
                              <th className="px-3 py-2.5 text-center whitespace-nowrap border-b border-gray-200">Swap</th>
                              <th className="px-3 py-2.5 text-center whitespace-nowrap border-b border-gray-200">Manual Rev.</th>
                              {hasNexarData && (<>
                                <th className="px-3 py-2.5 text-center whitespace-nowrap border-b border-gray-200">Best in Market</th>
                                <th className="px-3 py-2.5 text-right whitespace-nowrap border-b border-gray-200 bg-purple-50 text-purple-700">Nexar Best (USD)</th>
                                <th className="px-3 py-2.5 text-left whitespace-nowrap border-b border-gray-200 bg-purple-50 text-purple-700">Nexar Seller</th>
                              </>)}
                            </tr>
                          </thead>
                          <tbody className="divide-y divide-gray-100">
                            {multiResults.map(r => (
                              <tr key={r.bmatn} className={
                                r.status === 'error'   ? 'bg-red-50' :
                                r.status === 'loading' ? 'bg-blue-50/40 animate-pulse' :
                                r.status === 'done' && r.bestPriceUsd != null && r.stdPriceUsd != null && r.bestPriceUsd > r.stdPriceUsd ? 'bg-red-50 hover:bg-red-100/70' :
                                myPlant && r.bestPlant && r.bestPlant !== myPlant ? 'bg-green-50 hover:bg-green-100/70' :
                                'hover:bg-gray-50'
                              }>
                                {/* status */}
                                <td className="px-2 py-2 text-center">
                                  {r.status === 'loading' && (
                                    <svg className="animate-spin h-3 w-3 text-blue-500 mx-auto" fill="none" viewBox="0 0 24 24">
                                      <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                                      <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8H4z" />
                                    </svg>
                                  )}
                                  {r.status === 'done'  && <span className="text-emerald-500 font-bold">✓</span>}
                                  {r.status === 'error' && <span className="text-red-500 font-bold">✕</span>}
                                </td>
                                {/* MPN */}
                                <td className="px-3 py-2 font-mono text-gray-700 whitespace-nowrap" title={r.mpn}>
                                  {r.status === 'error' ? <span className="text-red-500 text-[11px]">{r.error}</span> : (r.mpn ?? '—')}
                                </td>
                                {/* Alt PN */}
                                <td className="px-3 py-2 font-mono text-gray-500 whitespace-nowrap">{r.mpnPartNumber ?? '—'}</td>
                                {/* Supplier */}
                                <td className="px-3 py-2 text-gray-600 max-w-[150px] truncate" title={r.bestSupplier}>{r.bestSupplier ?? '—'}</td>
                                {/* Searched (input BMATN) */}
                                <td className="px-3 py-2 font-mono text-gray-400 whitespace-nowrap">{r.bmatn}</td>
                                {/* Internal PN */}
                                <td className="px-3 py-2 font-mono font-semibold text-blue-700 whitespace-nowrap">{r.internalPN ?? '—'}</td>
                                {/* Plant */}
                                <td className="px-3 py-2 whitespace-nowrap text-gray-700">{r.bestPlant ?? '—'}</td>
                                {/* Qty */}
                                <td className="px-3 py-2 text-right font-mono text-gray-700 whitespace-nowrap">
                                  {r.qty != null ? r.qty.toLocaleString() : '—'}
                                </td>
                                {/* Currency */}
                                <td className="px-3 py-2 text-center font-mono text-gray-500 whitespace-nowrap">{r.currency ?? '—'}</td>
                                {/* Last PO Local */}
                                <td className="px-3 py-2 text-right font-mono text-gray-700 whitespace-nowrap">
                                  {r.bestPriceLocal != null ? r.bestPriceLocal.toLocaleString('en-US', { minimumFractionDigits: 4 }) : '—'}
                                </td>
                                {/* Std Local */}
                                <td className="px-3 py-2 text-right font-mono text-gray-500 whitespace-nowrap">
                                  {r.stdPriceLocal != null ? r.stdPriceLocal.toLocaleString('en-US', { minimumFractionDigits: 4 }) : '—'}
                                </td>
                                {/* Last PO USD */}
                                <td className="px-3 py-2 text-right font-mono text-blue-700 font-semibold whitespace-nowrap">{fmt6(r.bestPriceUsd)}</td>
                                {/* Std USD */}
                                <td className="px-3 py-2 text-right font-mono text-gray-500 whitespace-nowrap">{fmt6(r.stdPriceUsd)}</td>
                                {/* QTY Inserted */}
                                <td className="px-3 py-2 text-right font-mono text-gray-700 font-semibold whitespace-nowrap">
                                  {(r.searchQty ?? qty).toLocaleString()}
                                </td>
                                {/* Total Cost (USD) per QTY Inserted */}
                                <td className="px-3 py-2 text-right font-mono text-emerald-700 font-semibold whitespace-nowrap">
                                  {r.status === 'done' && r.bestPriceUsd != null && r.bestPriceUsd > 0 ? fmt6(r.bestPriceUsd * (r.searchQty ?? qty)) : '—'}
                                </td>
                                {/* Date */}
                                <td className="px-3 py-2 text-gray-500 whitespace-nowrap">{r.lastPoDate ?? '—'}</td>
                                {/* Last PO Price > Std Price */}
                                <td className="px-3 py-2 text-center whitespace-nowrap">
                                  {r.status === 'done' && r.bestPriceUsd != null && r.stdPriceUsd != null && r.bestPriceUsd > r.stdPriceUsd && (
                                    <span className="inline-flex items-center justify-center w-5 h-5 rounded-full bg-red-100 text-red-700 text-[10px] font-bold border border-red-300">1</span>
                                  )}
                                </td>
                                {/* Swap */}
                                <td className="px-3 py-2 text-center whitespace-nowrap">
                                  {r.status === 'done' && myPlant && r.bestPlant && r.bestPlant !== myPlant && (
                                    <span className="inline-flex items-center justify-center w-5 h-5 rounded-full bg-green-100 text-green-700 text-[10px] font-bold border border-green-300">1</span>
                                  )}
                                </td>
                                {/* Manual Rev. flag */}
                                <td className="px-3 py-2 text-center whitespace-nowrap">
                                  {r.status === 'done' && r.bestPriceUsd === 0 && (
                                    <span className="inline-flex items-center justify-center w-5 h-5 rounded-full bg-amber-100 text-amber-700 text-[10px] font-bold border border-amber-300">1</span>
                                  )}
                                </td>
                                {/* Nexar Market (conditional) */}
                                {hasNexarData && (() => {
                                  if (r.nexarBestUsd == null) return (<><td className="px-3 py-2 text-center text-gray-300 whitespace-nowrap">—</td><td className="px-3 py-2 text-center text-gray-300 whitespace-nowrap">—</td><td className="px-3 py-2 text-center text-gray-300 whitespace-nowrap">—</td></>)
                                  const delta = r.bestPriceUsd != null && r.bestPriceUsd > 0 ? ((r.nexarBestUsd - r.bestPriceUsd) / r.bestPriceUsd) * 100 : null
                                  const better = delta != null && delta < 0
                                  const worse  = delta != null && delta > 0
                                  return (<>
                                    <td className="px-3 py-2 text-center whitespace-nowrap">
                                      {r.bestInMarket && (
                                        <span className="inline-flex items-center justify-center w-5 h-5 rounded-full bg-green-100 text-green-700 text-[10px] font-bold border border-green-300">1</span>
                                      )}
                                    </td>
                                    <td className="px-3 py-2 text-right font-mono whitespace-nowrap">
                                      <span className={better ? 'text-green-600 font-semibold' : worse ? 'text-red-600' : 'text-gray-700'}>
                                        {fmt6(r.nexarBestUsd)}
                                      </span>
                                    </td>
                                    <td className="px-3 py-2 text-purple-600 text-[11px] whitespace-nowrap">{r.nexarSeller || '—'}</td>
                                  </>)
                                })()}
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>)}

                      {/* ── Blocked / Deleted sub-tab ── */}
                      {multiSubTab === 'blocked' && (() => {
                        const allItems = [
                          ...multiResults.flatMap(r => (r.blockedItems ?? []).map(i => ({ ...i, bmatn: r.bmatn, kind: 'blocked' as const, code: i.Blocked ?? '??' }))),
                          ...multiResults.flatMap(r => (r.deletedItems ?? []).map(i => ({ ...i, bmatn: r.bmatn, kind: 'deleted' as const, code: i.Deleted ?? '??' }))),
                        ]
                        const groupMap = new Map<string, { kind: 'blocked' | 'deleted'; code: string; reason: string; items: typeof allItems }>()
                        for (const item of allItems) {
                          const key = `${item.kind}:${item.code}`
                          if (!groupMap.has(key)) groupMap.set(key, { kind: item.kind, code: item.code, reason: BLOCK_REASONS[item.code] ?? (item.kind === 'deleted' ? 'Deleted from AVL' : 'Unknown reason'), items: [] })
                          const grp = groupMap.get(key)!
                          if (!grp.items.some(x => x.MfgPartNumber === item.MfgPartNumber)) grp.items.push(item)
                        }
                        const groups = [...groupMap.values()].sort((a, b) => a.kind.localeCompare(b.kind) || a.code.localeCompare(b.code))
                        if (!groups.length) return (<p className="text-sm text-gray-500 py-8 text-center">No blocked or deleted MPNs found across the searched components.</p>)
                        return (
                          <div className="space-y-4">
                            {groups.map(group => (
                              <div key={`${group.kind}:${group.code}`}>
                                <div className={`flex items-center gap-3 px-4 py-2.5 rounded-t-xl border ${group.kind === 'blocked' ? 'bg-amber-50 border-amber-200' : 'bg-red-50 border-red-200'}`}>
                                  <span className={`text-[11px] font-bold px-2 py-0.5 rounded-full ${group.kind === 'blocked' ? 'bg-amber-200 text-amber-800' : 'bg-red-200 text-red-800'}`}>
                                    {group.kind === 'blocked' ? '🔒 BLOCKED' : '🗑 DELETED'}
                                  </span>
                                  <span className="font-mono font-bold text-sm text-gray-800">{group.code}</span>
                                  <span className="text-gray-600 text-sm flex-1">{group.reason}</span>
                                  <span className="text-xs text-gray-500 bg-white border border-gray-200 rounded-full px-2 py-0.5">{group.items.length} MPN{group.items.length !== 1 ? 's' : ''}</span>
                                </div>
                                <div className="overflow-x-auto border border-t-0 border-gray-200 rounded-b-xl">
                                  <table className="min-w-max w-full text-xs">
                                    <thead className="bg-gray-50 text-[10px] uppercase tracking-wide text-gray-500">
                                      <tr>
                                        <th className="px-3 py-2 text-left border-b border-gray-200 whitespace-nowrap">Searched</th>
                                        <th className="px-3 py-2 text-left border-b border-gray-200 whitespace-nowrap">MPN</th>
                                        <th className="px-3 py-2 text-left border-b border-gray-200 whitespace-nowrap">Alt PN</th>
                                        <th className="px-3 py-2 text-left border-b border-gray-200 whitespace-nowrap">Manufacturer</th>
                                        <th className="px-3 py-2 text-right border-b border-gray-200 whitespace-nowrap">Count</th>
                                        <th className="px-3 py-2 text-right border-b border-gray-200 whitespace-nowrap">Last PO (USD)</th>
                                        <th className="px-3 py-2 text-right border-b border-gray-200 whitespace-nowrap">Std (USD)</th>
                                        <th className="px-3 py-2 text-left border-b border-gray-200 whitespace-nowrap">Date</th>
                                      </tr>
                                    </thead>
                                    <tbody className="divide-y divide-gray-100">
                                      {group.items.map((item, idx) => (
                                        <tr key={idx} className="hover:bg-gray-50">
                                          <td className="px-3 py-1.5 font-mono font-semibold text-blue-700 whitespace-nowrap">{item.bmatn}</td>
                                          <td className="px-3 py-1.5 font-mono text-gray-700 whitespace-nowrap">{item.MfgPartNumber}</td>
                                          <td className="px-3 py-1.5 font-mono text-gray-500 whitespace-nowrap">{item.MpnPartNumber && item.MpnPartNumber !== item.MfgPartNumber ? item.MpnPartNumber : '—'}</td>
                                          <td className="px-3 py-1.5 text-gray-600">{item.MfgName}</td>
                                          <td className="px-3 py-1.5 text-right font-mono text-gray-500">{item.count}</td>
                                          {(() => { const mr = multiResults.find(x => x.bmatn === item.bmatn); return (<>
                                            <td className="px-3 py-1.5 text-right font-mono text-blue-700 font-semibold whitespace-nowrap">{fmt6(mr?.bestPriceUsd)}</td>
                                            <td className="px-3 py-1.5 text-right font-mono text-gray-500 whitespace-nowrap">{fmt6(mr?.stdPriceUsd)}</td>
                                            <td className="px-3 py-1.5 text-gray-500 whitespace-nowrap">{mr?.lastPoDate ?? '—'}</td>
                                          </>) })()}
                                        </tr>
                                      ))}
                                    </tbody>
                                  </table>
                                </div>
                              </div>
                            ))}
                          </div>
                        )
                      })()}
                    </div>
                  )}

                </div>
              )}

              {/* ══════════════ MULTI-MPN TAB ══════════════ */}
              {activeTab === 'mpn' && (
                <div className="space-y-6">

                  {/* Multi-MPN search form */}
                  <div className="bg-gray-50 rounded-xl border border-gray-200 p-5">
                    <div className="flex gap-4 mb-4">
                      <div className="flex-1">
                        <div className="flex items-center justify-between mb-1.5">
                          <label className="block text-sm font-medium text-gray-600">
                            MPN Numbers
                            <span className="text-gray-400 font-normal ml-1">{mpnExcelFileName ? '' : '(one per line or comma-separated)'}</span>
                          </label>
                          <div className="flex items-center gap-2">
                            {mpnExcelFileName && (
                              <span className="flex items-center gap-1 text-[11px] text-emerald-700 bg-emerald-50 border border-emerald-200 rounded-full px-2 py-0.5">
                                <svg className="h-3 w-3" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" /></svg>
                                {mpnExcelFileName}
                                <button
                                  onClick={() => { setMpnExcelFileName(''); setMpnComponentQtys({}); setMpnComponentQtyDefaults({}); setMultiMpnInput('') }}
                                  className="ml-1 text-emerald-500 hover:text-red-500 font-bold leading-none"
                                  title="Clear Excel data"
                                >×</button>
                              </span>
                            )}
                            <label className="flex items-center gap-1.5 cursor-pointer px-3 py-1 text-xs font-semibold rounded-lg bg-white border border-gray-300 hover:border-blue-400 hover:text-blue-600 text-gray-600 transition-colors">
                              <svg className="h-3.5 w-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-8l-4-4m0 0L8 8m4-4v12" /></svg>
                              Upload Excel
                              <input type="file" accept=".xlsx,.xls" className="hidden" onChange={handleMpnExcelUpload} />
                            </label>
                            <button
                              onClick={downloadMpnTemplate}
                              className="flex items-center gap-1.5 px-3 py-1 text-xs font-semibold rounded-lg bg-white border border-gray-300 hover:border-emerald-400 hover:text-emerald-600 text-gray-600 transition-colors"
                              title="Download Excel template with MPN and Quantity columns"
                            >
                              <svg className="h-3.5 w-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 10v6m0 0l-3-3m3 3l3-3m2 8H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" /></svg>
                              Template
                            </button>
                          </div>
                        </div>
                        {mpnExcelFileName ? (
                          <div className="w-full rounded-lg border border-emerald-200 bg-white overflow-hidden" style={{ height: '172px' }}>
                            <div className="overflow-y-auto h-full">
                              <table className="w-full text-xs border-collapse">
                                <thead className="sticky top-0 bg-emerald-600 text-white text-[10px] uppercase tracking-wide">
                                  <tr>
                                    <th className="px-2 py-1.5 text-center w-8 font-semibold">#</th>
                                    <th className="px-3 py-1.5 text-left font-semibold">MPN</th>
                                    <th className="px-3 py-1.5 text-right font-semibold">Quantity</th>
                                  </tr>
                                </thead>
                                <tbody>
                                  {Object.entries(mpnComponentQtys).map(([comp, q], idx) => (
                                    <tr key={comp} className={idx % 2 === 0 ? 'bg-white' : 'bg-gray-50'}>
                                      <td className="px-2 py-1 text-center text-gray-400 font-mono">{idx + 1}</td>
                                      <td className="px-3 py-1 font-mono font-semibold text-gray-800">{comp}</td>
                                      <td className="px-3 py-1 text-right font-mono text-blue-700">
                                        {q.toLocaleString()}
                                        {mpnComponentQtyDefaults[comp] && (
                                          <span className="ml-1 text-[10px] text-gray-400 font-normal">
                                            ({mpnComponentQtyDefaults[comp]})
                                          </span>
                                        )}
                                      </td>
                                    </tr>
                                  ))}
                                </tbody>
                              </table>
                            </div>
                            <div className="border-t border-emerald-100 bg-emerald-50 px-3 py-1 text-[10px] text-emerald-700 font-medium">
                              {Object.keys(mpnComponentQtys).length} MPN{Object.keys(mpnComponentQtys).length !== 1 ? 's' : ''} loaded
                            </div>
                          </div>
                        ) : (
                          <textarea
                            placeholder={"LM741CN\nBC547\nNE555P"}
                            value={multiMpnInput}
                            onChange={e => setMultiMpnInput(e.target.value.toUpperCase())}
                            rows={6}
                            className="w-full rounded-lg border border-gray-300 px-4 py-2.5 text-sm font-mono focus:outline-none focus:ring-2 focus:ring-blue-500 resize-y"
                          />
                        )}
                      </div>
                      {!mpnExcelFileName && (
                        <div className="w-40">
                          <label className="block text-sm font-medium text-gray-600 mb-1.5">Quantity</label>
                          <input
                            type="number" min={0.0001} step="any" value={qty}
                            onChange={e => setQty(Math.max(0.0001, parseFloat(e.target.value) || 0.0001))}
                            className="w-full rounded-lg border border-gray-300 px-4 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
                          />
                        </div>
                      )}
                      <div className="w-40">
                        <label className="block text-sm font-medium text-gray-600 mb-1.5">My Plant</label>
                        <select
                          value={myPlant}
                          onChange={e => setMyPlant(e.target.value)}
                          className="w-full rounded-lg border border-gray-300 px-3 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 bg-white"
                        >
                          <option value="">— None —</option>
                          <option value="KEMX">KEMX</option>
                          <option value="KEJ">KEJ</option>
                          <option value="KECN">KECN</option>
                          <option value="KETL">KETL</option>
                          <option value="KEPS">KEPS</option>
                          <option value="KERO">KERO</option>
                        </select>
                      </div>
                    </div>
                    <div className="flex items-center gap-4">
                      <button
                        onClick={multiMpnLoading ? () => abortMpnRef.current?.abort() : handleMultiMpnSearch}
                        disabled={!multiMpnLoading && !multiMpnInput.trim()}
                        onMouseEnter={() => { if (multiMpnLoading) setStopMpnHover(true) }}
                        onMouseLeave={() => setStopMpnHover(false)}
                        className={`px-6 py-2.5 rounded-lg text-sm font-semibold transition-colors ${
                          multiMpnLoading && stopMpnHover
                            ? 'bg-red-600 text-white hover:bg-red-700 cursor-pointer'
                            : multiMpnLoading
                            ? 'bg-blue-400 text-white cursor-default'
                            : 'bg-blue-600 text-white hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed'
                        }`}
                      >
                        <span className="relative inline-flex items-center justify-center">
                          <span className="invisible select-none" aria-hidden>Searching…</span>
                          <span className="absolute inset-0 flex items-center justify-center">
                            {multiMpnLoading && stopMpnHover ? 'Stop' : multiMpnLoading ? 'Searching…' : 'Search All'}
                          </span>
                        </span>
                      </button>
                      <label className="flex items-center gap-2 cursor-pointer select-none">
                        <input
                          type="checkbox"
                          checked={searchNexar}
                          onChange={e => setSearchNexar(e.target.checked)}
                          className="w-4 h-4 accent-purple-600 cursor-pointer"
                        />
                        <span className="text-sm text-gray-600">Include <span className="font-semibold text-purple-600">Nexar Market</span></span>
                      </label>
                    </div>
                  </div>

                  {/* Multi-MPN results table */}
                  {multiMpnResults.length > 0 && (
                    <div>
                      <div className="flex items-center gap-3 mb-3">
                        <div className="flex gap-1 bg-gray-100 rounded-xl p-0.5">
                          <button
                            onClick={() => setMultiMpnSubTab('results')}
                            className={`px-3 py-1.5 text-xs font-medium rounded-lg transition-colors ${multiMpnSubTab === 'results' ? 'bg-white text-blue-600 shadow-sm' : 'text-gray-500 hover:text-gray-700'}`}
                          >
                            📊 Results ({multiMpnResults.filter(r => r.status === 'done').length})
                          </button>
                          <button
                            onClick={() => setMultiMpnSubTab('blocked')}
                            className={`px-3 py-1.5 text-xs font-medium rounded-lg transition-colors ${multiMpnSubTab === 'blocked' ? 'bg-white text-red-600 shadow-sm' : 'text-gray-500 hover:text-gray-700'}`}
                          >
                            🚫 Blocked / Deleted ({multiMpnResults.reduce((s, r) => s + (r.totalBlocked ?? 0) + (r.totalDeleted ?? 0), 0)})
                          </button>
                        </div>
                        {multiMpnLoading && (
                          <div className="flex items-center gap-1.5 text-xs text-blue-600">
                            <svg className="animate-spin h-3 w-3" fill="none" viewBox="0 0 24 24">
                              <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                              <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8H4z" />
                            </svg>
                            Querying…
                          </div>
                        )}
                        {multiMpnSubTab === 'results' && !multiMpnLoading && multiMpnResults.some(r => r.status === 'done') && (
                          <button
                            onClick={downloadMpnResultsExcel}
                            className="ml-auto flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold rounded-lg bg-emerald-600 hover:bg-emerald-700 text-white shadow-sm transition-colors"
                          >
                            <Download className="h-3.5 w-3.5" />
                            Export Excel
                          </button>
                        )}
                      </div>
                      {multiMpnSubTab === 'results' && (<div className="overflow-x-auto rounded-xl border border-gray-200 shadow-sm">
                        <table className="min-w-max w-full text-xs border-collapse">
                          <thead className="bg-gray-50 text-[10px] uppercase tracking-wide text-gray-500 sticky top-0">
                            <tr>
                              <th className="px-2 py-2.5 w-6 border-b border-gray-200" />
                              <th className="px-3 py-2.5 text-left whitespace-nowrap border-b border-gray-200">MPN</th>
                              <th className="px-3 py-2.5 text-left whitespace-nowrap border-b border-gray-200">Alt PN</th>
                              <th className="px-3 py-2.5 text-left whitespace-nowrap border-b border-gray-200">Supplier</th>
                              <th className="px-3 py-2.5 text-left whitespace-nowrap border-b border-gray-200">Internal PN</th>
                              <th className="px-3 py-2.5 text-left whitespace-nowrap border-b border-gray-200">Plant</th>
                              <th className="px-3 py-2.5 text-right whitespace-nowrap border-b border-gray-200">Qty</th>
                              <th className="px-3 py-2.5 text-center whitespace-nowrap border-b border-gray-200">Cur</th>
                              <th className="px-3 py-2.5 text-right whitespace-nowrap border-b border-gray-200">Last PO (Local)</th>
                              <th className="px-3 py-2.5 text-right whitespace-nowrap border-b border-gray-200">Std (Local)</th>
                              <th className="px-3 py-2.5 text-right whitespace-nowrap border-b border-gray-200">Last PO (USD)</th>
                              <th className="px-3 py-2.5 text-right whitespace-nowrap border-b border-gray-200">Std (USD)</th>
                              <th className="px-3 py-2.5 text-right whitespace-nowrap border-b border-gray-200">QTY Inserted</th>
                              <th className="px-3 py-2.5 text-right whitespace-nowrap border-b border-gray-200">Total Cost (USD) per QTY Inserted</th>
                              <th className="px-3 py-2.5 text-left whitespace-nowrap border-b border-gray-200">Date</th>
                              <th className="px-3 py-2.5 text-center whitespace-nowrap border-b border-gray-200">Last PO Price &gt; Std Price</th>
                              <th className="px-3 py-2.5 text-center whitespace-nowrap border-b border-gray-200">Swap</th>
                              <th className="px-3 py-2.5 text-center whitespace-nowrap border-b border-gray-200">Manual Rev.</th>
                              {hasNexarMpnData && (<>
                                <th className="px-3 py-2.5 text-center whitespace-nowrap border-b border-gray-200">Best in Market</th>
                                <th className="px-3 py-2.5 text-right whitespace-nowrap border-b border-gray-200 bg-purple-50 text-purple-700">Nexar Best (USD)</th>
                                <th className="px-3 py-2.5 text-left whitespace-nowrap border-b border-gray-200 bg-purple-50 text-purple-700">Nexar Seller</th>
                              </>)}
                            </tr>
                          </thead>
                          <tbody className="divide-y divide-gray-100">
                            {multiMpnResults.map(r => (
                              <tr key={r.bmatn} className={
                                r.status === 'error'   ? 'bg-red-50' :
                                r.status === 'loading' ? 'bg-blue-50/40 animate-pulse' :
                                r.status === 'done' && r.bestPriceUsd != null && r.stdPriceUsd != null && r.bestPriceUsd > r.stdPriceUsd ? 'bg-red-50 hover:bg-red-100/70' :
                                myPlant && r.bestPlant && r.bestPlant !== myPlant ? 'bg-green-50 hover:bg-green-100/70' :
                                'hover:bg-gray-50'
                              }>
                                <td className="px-2 py-2 text-center">
                                  {r.status === 'loading' && (
                                    <svg className="animate-spin h-3 w-3 text-blue-500 mx-auto" fill="none" viewBox="0 0 24 24">
                                      <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                                      <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8H4z" />
                                    </svg>
                                  )}
                                  {r.status === 'done'  && <span className="text-emerald-500 font-bold">✓</span>}
                                  {r.status === 'error' && <span className="text-red-500 font-bold">✕</span>}
                                </td>
                                <td className="px-3 py-2 font-mono text-gray-700 whitespace-nowrap" title={r.mpn}>
                                  {r.status === 'error' ? <span className="text-red-500 text-[11px]">{r.error}</span> : (r.mpn ?? '—')}
                                </td>
                                <td className="px-3 py-2 font-mono text-gray-500 whitespace-nowrap">{r.mpnPartNumber ?? '—'}</td>
                                <td className="px-3 py-2 text-gray-600 max-w-[150px] truncate" title={r.bestSupplier}>{r.bestSupplier ?? '—'}</td>
                                <td className="px-3 py-2 font-mono font-semibold text-blue-700 whitespace-nowrap">{r.internalPN ?? r.bmatn}</td>
                                <td className="px-3 py-2 whitespace-nowrap text-gray-700">{r.bestPlant ?? '—'}</td>
                                <td className="px-3 py-2 text-right font-mono text-gray-700 whitespace-nowrap">
                                  {r.qty != null ? r.qty.toLocaleString() : '—'}
                                </td>
                                <td className="px-3 py-2 text-center font-mono text-gray-500 whitespace-nowrap">{r.currency ?? '—'}</td>
                                <td className="px-3 py-2 text-right font-mono text-gray-700 whitespace-nowrap">
                                  {r.bestPriceLocal != null ? r.bestPriceLocal.toLocaleString('en-US', { minimumFractionDigits: 4 }) : '—'}
                                </td>
                                <td className="px-3 py-2 text-right font-mono text-gray-500 whitespace-nowrap">
                                  {r.stdPriceLocal != null ? r.stdPriceLocal.toLocaleString('en-US', { minimumFractionDigits: 4 }) : '—'}
                                </td>
                                <td className="px-3 py-2 text-right font-mono text-blue-700 font-semibold whitespace-nowrap">{fmt6(r.bestPriceUsd)}</td>
                                <td className="px-3 py-2 text-right font-mono text-gray-500 whitespace-nowrap">{fmt6(r.stdPriceUsd)}</td>
                                <td className="px-3 py-2 text-right font-mono text-gray-700 font-semibold whitespace-nowrap">
                                  {(r.searchQty ?? qty).toLocaleString()}
                                </td>
                                <td className="px-3 py-2 text-right font-mono text-emerald-700 font-semibold whitespace-nowrap">
                                  {r.status === 'done' && r.bestPriceUsd != null && r.bestPriceUsd > 0 ? fmt6(r.bestPriceUsd * (r.searchQty ?? qty)) : '—'}
                                </td>
                                <td className="px-3 py-2 text-gray-500 whitespace-nowrap">{r.lastPoDate ?? '—'}</td>
                                <td className="px-3 py-2 text-center whitespace-nowrap">
                                  {r.status === 'done' && r.bestPriceUsd != null && r.stdPriceUsd != null && r.bestPriceUsd > r.stdPriceUsd && (
                                    <span className="inline-flex items-center justify-center w-5 h-5 rounded-full bg-red-100 text-red-700 text-[10px] font-bold border border-red-300">1</span>
                                  )}
                                </td>
                                <td className="px-3 py-2 text-center whitespace-nowrap">
                                  {r.status === 'done' && myPlant && r.bestPlant && r.bestPlant !== myPlant && (
                                    <span className="inline-flex items-center justify-center w-5 h-5 rounded-full bg-green-100 text-green-700 text-[10px] font-bold border border-green-300">1</span>
                                  )}
                                </td>
                                <td className="px-3 py-2 text-center whitespace-nowrap">
                                  {r.status === 'done' && r.bestPriceUsd === 0 && (
                                    <span className="inline-flex items-center justify-center w-5 h-5 rounded-full bg-amber-100 text-amber-700 text-[10px] font-bold border border-amber-300">1</span>
                                  )}
                                </td>
                                {hasNexarMpnData && (() => {
                                  if (r.nexarBestUsd == null) return (<><td className="px-3 py-2 text-center text-gray-300 whitespace-nowrap">—</td><td className="px-3 py-2 text-center text-gray-300 whitespace-nowrap">—</td><td className="px-3 py-2 text-center text-gray-300 whitespace-nowrap">—</td></>)
                                  const delta = r.bestPriceUsd != null && r.bestPriceUsd > 0 ? ((r.nexarBestUsd - r.bestPriceUsd) / r.bestPriceUsd) * 100 : null
                                  const better = delta != null && delta < 0
                                  const worse  = delta != null && delta > 0
                                  return (<>
                                    <td className="px-3 py-2 text-center whitespace-nowrap">
                                      {r.bestInMarket && (
                                        <span className="inline-flex items-center justify-center w-5 h-5 rounded-full bg-green-100 text-green-700 text-[10px] font-bold border border-green-300">1</span>
                                      )}
                                    </td>
                                    <td className="px-3 py-2 text-right font-mono whitespace-nowrap">
                                      <span className={better ? 'text-green-600 font-semibold' : worse ? 'text-red-600' : 'text-gray-700'}>
                                        {fmt6(r.nexarBestUsd)}
                                      </span>
                                    </td>
                                    <td className="px-3 py-2 text-purple-600 text-[11px] whitespace-nowrap">{r.nexarSeller || '—'}</td>
                                  </>)
                                })()}
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>)}

                      {/* ── Blocked / Deleted sub-tab ── */}
                      {multiMpnSubTab === 'blocked' && (() => {
                        const allItems = [
                          ...multiMpnResults.flatMap(r => (r.blockedItems ?? []).map(i => ({ ...i, bmatn: r.bmatn, kind: 'blocked' as const, code: i.Blocked ?? '??' }))),
                          ...multiMpnResults.flatMap(r => (r.deletedItems ?? []).map(i => ({ ...i, bmatn: r.bmatn, kind: 'deleted' as const, code: i.Deleted ?? '??' }))),
                        ]
                        const groupMap = new Map<string, { kind: 'blocked' | 'deleted'; code: string; reason: string; items: typeof allItems }>()
                        for (const item of allItems) {
                          const key = `${item.kind}:${item.code}`
                          if (!groupMap.has(key)) groupMap.set(key, { kind: item.kind, code: item.code, reason: BLOCK_REASONS[item.code] ?? (item.kind === 'deleted' ? 'Deleted from AVL' : 'Unknown reason'), items: [] })
                          const grp = groupMap.get(key)!
                          if (!grp.items.some(x => x.MfgPartNumber === item.MfgPartNumber)) grp.items.push(item)
                        }
                        const groups = [...groupMap.values()].sort((a, b) => a.kind.localeCompare(b.kind) || a.code.localeCompare(b.code))
                        if (!groups.length) return (<p className="text-sm text-gray-500 py-8 text-center">No blocked or deleted MPNs found across the searched MPNs.</p>)
                        return (
                          <div className="space-y-4">
                            {groups.map(group => (
                              <div key={`${group.kind}:${group.code}`}>
                                <div className={`flex items-center gap-3 px-4 py-2.5 rounded-t-xl border ${group.kind === 'blocked' ? 'bg-amber-50 border-amber-200' : 'bg-red-50 border-red-200'}`}>
                                  <span className={`text-[11px] font-bold px-2 py-0.5 rounded-full ${group.kind === 'blocked' ? 'bg-amber-200 text-amber-800' : 'bg-red-200 text-red-800'}`}>
                                    {group.kind === 'blocked' ? '🔒 BLOCKED' : '🗑 DELETED'}
                                  </span>
                                  <span className="font-mono font-bold text-sm text-gray-800">{group.code}</span>
                                  <span className="text-gray-600 text-sm flex-1">{group.reason}</span>
                                  <span className="text-xs text-gray-500 bg-white border border-gray-200 rounded-full px-2 py-0.5">{group.items.length} MPN{group.items.length !== 1 ? 's' : ''}</span>
                                </div>
                                <div className="overflow-x-auto border border-t-0 border-gray-200 rounded-b-xl">
                                  <table className="min-w-max w-full text-xs">
                                    <thead className="bg-gray-50 text-[10px] uppercase tracking-wide text-gray-500">
                                      <tr>
                                        <th className="px-3 py-2 text-left border-b border-gray-200 whitespace-nowrap">Internal PN</th>
                                        <th className="px-3 py-2 text-left border-b border-gray-200 whitespace-nowrap">MPN</th>
                                        <th className="px-3 py-2 text-left border-b border-gray-200 whitespace-nowrap">Alt PN</th>
                                        <th className="px-3 py-2 text-left border-b border-gray-200 whitespace-nowrap">Manufacturer</th>
                                        <th className="px-3 py-2 text-right border-b border-gray-200 whitespace-nowrap">Count</th>
                                        <th className="px-3 py-2 text-right border-b border-gray-200 whitespace-nowrap">Last PO (USD)</th>
                                        <th className="px-3 py-2 text-right border-b border-gray-200 whitespace-nowrap">Std (USD)</th>
                                        <th className="px-3 py-2 text-left border-b border-gray-200 whitespace-nowrap">Date</th>
                                      </tr>
                                    </thead>
                                    <tbody className="divide-y divide-gray-100">
                                      {group.items.map((item, idx) => (
                                        <tr key={idx} className="hover:bg-gray-50">
                                          <td className="px-3 py-1.5 font-mono font-semibold text-blue-700 whitespace-nowrap">{item.bmatn}</td>
                                          <td className="px-3 py-1.5 font-mono text-gray-700 whitespace-nowrap">{item.MfgPartNumber}</td>
                                          <td className="px-3 py-1.5 font-mono text-gray-500 whitespace-nowrap">{item.MpnPartNumber && item.MpnPartNumber !== item.MfgPartNumber ? item.MpnPartNumber : '—'}</td>
                                          <td className="px-3 py-1.5 text-gray-600">{item.MfgName}</td>
                                          <td className="px-3 py-1.5 text-right font-mono text-gray-500">{item.count}</td>
                                          {(() => { const mr = multiMpnResults.find(x => x.bmatn === item.bmatn); return (<>
                                            <td className="px-3 py-1.5 text-right font-mono text-blue-700 font-semibold whitespace-nowrap">{fmt6(mr?.bestPriceUsd)}</td>
                                            <td className="px-3 py-1.5 text-right font-mono text-gray-500 whitespace-nowrap">{fmt6(mr?.stdPriceUsd)}</td>
                                            <td className="px-3 py-1.5 text-gray-500 whitespace-nowrap">{mr?.lastPoDate ?? '—'}</td>
                                          </>) })()}
                                        </tr>
                                      ))}
                                    </tbody>
                                  </table>
                                </div>
                              </div>
                            ))}
                          </div>
                        )
                      })()}
                    </div>
                  )}

                </div>
              )}
            </div>
          </div>
        </div>
      )}
    </>
  )
}
