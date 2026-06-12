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

interface DeepAnalysisRow {
  internalPN: string
  status: 'loading' | 'done' | 'error'
  error?: string
  mcBestPriceUsd: number | null
  mcStdPriceUsd: number | null
  mcBestSupplier: string
  mcBestPlant: string
  mcBestMpn: string
  mcBestInternalPN: string
  mcLastPoDate: string
}

interface McDeepRow {
  bmatn: string
  mcInternalPN: string
  mcPrice: number | null
  mcSupplier: string
  mcPlant: string
  mcMpn: string
  mcLastPoDate: string
  mcStdPriceUsd: number | null
  mpnStatus: 'loading' | 'done' | 'error'
  mpnError?: string
  mpnBestPriceUsd: number | null
  mpnBestStdPriceUsd: number | null
  mpnBestSupplier: string
  mpnBestPlant: string
  mpnBestMpn: string
  mpnBestInternalPN: string
  mpnLastPoDate: string
}

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
  bestRow: IQItem
  hadInWindowData: boolean
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

function buildPlantSummaries(rows: IQItem[], windowMs: number): PlantSummary[] {
  const map = new Map<string, IQItem[]>()
  for (const row of rows) {
    if (!map.has(row.siteName)) map.set(row.siteName, [])
    map.get(row.siteName)!.push(row)
  }

  // Configurable look-back window from the most recent purchase date across all plants
  const maxTime = rows.length
    ? Math.max(...rows.map(r => new Date(r.lastPoDate || 0).getTime()))
    : 0
  const windowStart = isFinite(maxTime) && maxTime > 0
    ? maxTime - windowMs
    : 0

  return Array.from(map.entries())
    .map(([siteName, siteRows]) => {
      // Only consider rows within the look-back window; fall back to all rows if none qualify
      const inWindow   = siteRows.filter(r => new Date(r.lastPoDate || 0).getTime() >= windowStart)
      const hadInWindowData = inWindow.length > 0
      const candidates = hadInWindowData ? inWindow : siteRows
      // Pick the cheapest row among candidates; fall back to most-recent if all prices are null
      let best: IQItem | null = null
      let bestP = Infinity
      for (const r of candidates) {
        const p = resolveLastPoPrice(r)
        if (p != null && p < bestP) { bestP = p; best = r }
      }
      if (!best) {
        best = candidates.reduce((a, b) =>
          new Date(b.lastPoDate || 0) > new Date(a.lastPoDate || 0) ? b : a)
      }
      return {
        siteName,
        bestPrice:        resolveLastPoPrice(best),
        bestSupplier:     best.supplierName,
        lastPoDate:       best.lastPoDate,
        mpn:              best.mpn,
        rows:             siteRows,
        bestRow:          best,
        hadInWindowData,
      }
    })
    // In-window plants rank before fallback plants; within each group sort by price ascending
    .sort((a, b) => {
      if (a.hadInWindowData !== b.hadInWindowData) return a.hadInWindowData ? -1 : 1
      return (a.bestPrice ?? Infinity) - (b.bestPrice ?? Infinity)
    })
}

/**
 * Selects the best row from a list of IQ rows using the following rules:
 * 1. Only consider active MPNs (rows whose mpn is in activeSet).
 * 2. Find the most recent purchase date and define a configurable look-back window.
 * 3. Within that window, deduplicate by Alt PN (mpnToAltPn map): if the same supplier
 *    (same Alt PN) appears multiple times, keep only their most recent row.
 *    This avoids rewarding a supplier whose price was lower before they raised it.
 * 4. Among the deduplicated candidates, return the row with the lowest last-PO price.
 *    If all prices are null, return the most recent row.
 */
function selectBestRow(
  rows: IQItem[],
  activeSet: Set<string>,
  mpnToAltPn: Map<string, string>,
  windowMs: number,
): IQItem | null {
  // Step 1 — filter to active rows (if we have active info)
  const workRows = activeSet.size > 0 ? rows.filter(r => activeSet.has(r.mpn)) : rows
  if (!workRows.length) return null

  // Step 2 — most recent purchase date
  const maxTime = Math.max(...workRows.map(r => new Date(r.lastPoDate || 0).getTime()))
  if (!isFinite(maxTime) || maxTime <= 0) return workRows[0]

  // Step 3 — configurable look-back window
  const windowStart = maxTime - windowMs
  const windowRows  = workRows.filter(r => new Date(r.lastPoDate || 0).getTime() >= windowStart)

  // Step 4 — deduplicate by Alt PN: keep only the most recent row per supplier variant
  const byAltPn = new Map<string, IQItem>()
  for (const row of windowRows) {
    const altPn    = mpnToAltPn.get(row.mpn) ?? row.mpn
    const existing = byAltPn.get(altPn)
    if (!existing || new Date(row.lastPoDate || 0) > new Date(existing.lastPoDate || 0)) {
      byAltPn.set(altPn, row)
    }
  }

  // Step 5 — pick the lowest-price candidate
  let best: IQItem | null = null
  let bestPrice = Infinity
  for (const row of byAltPn.values()) {
    const price = resolveLastPoPrice(row)
    if (price != null && price < bestPrice) { bestPrice = price; best = row }
  }

  // Fallback: if all prices are null, return the most recent row in the window
  if (!best && byAltPn.size > 0) {
    best = [...byAltPn.values()].reduce((a, b) =>
      new Date(b.lastPoDate || 0) > new Date(a.lastPoDate || 0) ? b : a)
  }

  return best
}

/**
 * Replicates the exact same algorithm used by mpnEntries in Multi-MPN:
 * group IQ rows by MPN → per-MPN configurable window from that MPN's latest date
 * → cheapest within window → pick cheapest across all MPN groups.
 */
function pickBestRowByMpn(rows: IQItem[], windowMs: number): IQItem | null {
  const mpnGroupsMap = new Map<string, IQItem[]>()
  for (const row of rows) {
    if (!mpnGroupsMap.has(row.mpn)) mpnGroupsMap.set(row.mpn, [])
    mpnGroupsMap.get(row.mpn)!.push(row)
  }
  let overallBest: IQItem | null = null
  let overallBestPrice = Infinity
  for (const mpnRows of mpnGroupsMap.values()) {
    const validRows = mpnRows.filter(r => r.lastPoDate && !isNaN(new Date(r.lastPoDate).getTime()))
    if (!validRows.length) continue
    const maxT = Math.max(...validRows.map(r => new Date(r.lastPoDate).getTime()))
    const windowStart = maxT - windowMs
    const inWindow = validRows.filter(r => new Date(r.lastPoDate).getTime() >= windowStart)
    if (!inWindow.length) continue
    const best = inWindow.reduce<IQItem>((min, r) => {
      const p  = resolveLastPoPrice(r)
      const mp = resolveLastPoPrice(min)
      if (p == null) return min
      if (mp == null) return r
      return p < mp ? r : min
    }, inWindow[0])
    const price = resolveLastPoPrice(best)
    if (price != null && price < overallBestPrice) { overallBestPrice = price; overallBest = best }
    else if (price == null && overallBest == null)  { overallBest = best }
  }
  return overallBest
}

function getDecision(diffPct: number | null, withStock: number, total: number) {
  if (total === 0)    return { icon: '“', text: 'No market data',       color: 'text-gray-500', bg: 'bg-gray-50 border-gray-200' }
  if (withStock === 0) return { icon: ' ', text: 'No market stock',      color: 'text-red-600',  bg: 'bg-red-50 border-red-200' }
  if (diffPct == null) return { icon: '”', text: 'Review manually',      color: 'text-gray-600', bg: 'bg-gray-50 border-gray-200' }
  if (diffPct <= -10)  return { icon: '', text: 'Savings opportunity',  color: 'text-emerald-700', bg: 'bg-emerald-50 border-emerald-200' }
  if (diffPct <= 0)    return { icon: '', text: 'Competitive price',     color: 'text-blue-700',  bg: 'bg-blue-50 border-blue-200' }
  if (diffPct <= 15)   return { icon: '”', text: 'Evaluate alternatives', color: 'text-amber-700', bg: 'bg-amber-50 border-amber-200' }
  return               { icon: '', text: 'Keep internal supplier',  color: 'text-gray-700',  bg: 'bg-gray-100 border-gray-200' }
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
          {[...plants].sort((a, b) => new Date(b.lastPoDate || 0).getTime() - new Date(a.lastPoDate || 0).getTime()).map(p => {
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
  const sorted = [...rows].sort((a, b) => new Date(b.lastPoDate || 0).getTime() - new Date(a.lastPoDate || 0).getTime())
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
const RANK_LABEL: Record<number, string> = { 1: ' 1°', 2: ' 2°', 3: ' 3°', 4: '4°', 5: '5°' }

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
                  {!o.can_fulfill && <span className="ml-1 text-[10px] bg-amber-100 text-amber-700 px-1 rounded"> MOQ</span>}
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

async function downloadMpnExcelFile(
  subTab: 'results' | 'allrecords' | 'blocked' | 'deep',
  mpnEntries: Array<{ mpn: string; bestRow: IQItem; allRows: IQItem[] }>,
  allBlockedItems: Array<{ internalPN: string; mpn: string; mfgName: string; mpnPartNumber: string; kind: 'blocked' | 'deleted'; code: string }>,
  deepAnalysisRows: DeepAnalysisRow[],
  filename: string,
  ctx: {
    mpnComponentQtys: Record<string, number>
    mpnNexarMap: Record<string, { nexarBestUsd: number | null; nexarSeller: string; nexarManufacturer: string; nexarStock: number | null; nexarMoq: number | null; nexarMpn: string }>
    myPlant: string
    qty: number
  },
): Promise<void> {
  const ExcelJS = (await import('exceljs')).default
  const wb = new ExcelJS.Workbook()
  wb.creator = 'PPV Dashboard'
  wb.created = new Date()

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const styleHeader = (ws: any) => {
    const hdr = ws.getRow(1)
    hdr.height = 24
    hdr.eachCell((cell: any) => {
      cell.fill      = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1E3A5F' } }
      cell.font      = { bold: true, color: { argb: 'FFFFFFFF' }, size: 10, name: 'Calibri' }
      cell.alignment = { horizontal: 'center', vertical: 'middle', wrapText: false }
      cell.border    = { bottom: { style: 'medium', color: { argb: 'FF2563EB' } }, right: { style: 'thin', color: { argb: 'FF3B5998' } } }
    })
  }

  const iqCols = [
    { header: 'MPN',             key: 'mpn',         width: 24 },
    { header: 'Internal PN',     key: 'internalPN',  width: 16 },
    { header: 'Plant',           key: 'plant',       width: 10 },
    { header: 'Supplier',        key: 'supplier',    width: 32 },
    { header: 'Description',     key: 'description', width: 36 },
    { header: 'Qty',             key: 'qty',         width: 10 },
    { header: 'Currency',        key: 'currency',    width: 10 },
    { header: 'Last PO (Local)', key: 'lastPoLocal', width: 16 },
    { header: 'Std (Local)',     key: 'stdLocal',    width: 14 },
    { header: 'Last PO (USD)',   key: 'lastPoUsd',   width: 16 },
    { header: 'Std (USD)',       key: 'stdUsd',      width: 14 },
    { header: 'Date',            key: 'date',        width: 14 },
    { header: 'Best in Market',  key: 'bestInMkt',   width: 14 },
    { header: 'Nexar Best (USD)',key: 'nexarUsd',    width: 16 },
    { header: 'Nexar Seller',    key: 'nexarSeller', width: 28 },
  ]

  const resultsCols = [
    { header: 'MPN',                              key: 'mpn',        width: 24 },
    { header: 'Supplier',                         key: 'supplier',   width: 32 },
    { header: 'Searched MPN',                     key: 'searched',   width: 24 },
    { header: 'Internal PN',                      key: 'internalPN', width: 16 },
    { header: 'Plant',                            key: 'plant',      width: 10 },
    { header: 'Qty',                              key: 'qty',        width: 10 },
    { header: 'Currency',                         key: 'currency',   width: 10 },
    { header: 'Last PO (Local)',                  key: 'lastPoLocal',width: 16 },
    { header: 'Std (Local)',                      key: 'stdLocal',   width: 14 },
    { header: 'Last PO (USD)',                    key: 'lastPoUsd',  width: 16 },
    { header: 'Std (USD)',                        key: 'stdUsd',     width: 14 },
    { header: 'QTY Inserted',                     key: 'qtyIns',     width: 14 },
    { header: 'Total Cost (USD) per QTY Inserted',key: 'totalUsd',   width: 30 },
    { header: 'Date',                             key: 'date',       width: 14 },
    { header: 'LPO > Std',                        key: 'lpoGtStd',   width: 10 },
    { header: 'Swap',                             key: 'swap',       width: 8  },
    { header: 'Manual Rev.',                      key: 'manual',     width: 12 },
    { header: 'Best in Market',                   key: 'bestInMkt',  width: 14 },
    { header: 'Nexar Best (USD)',                 key: 'nexarUsd',   width: 16 },
    { header: 'Nexar Seller',                     key: 'nexarSeller',width: 28 },
  ]

  const toRowData = (r: IQItem) => ({
    mpn: r.mpn, internalPN: r.internalPN, plant: r.siteName,
    supplier: r.supplierName || r.englishName || '',
    description: r.materialDescription || '',
    qty: r.quantity ?? '', currency: r.localCurrency || '',
    lastPoLocal: resolvePoLocal(r) ?? '', stdLocal: resolveStdLocal(r) ?? '',
    lastPoUsd: resolveLastPoPrice(r) ?? '', stdUsd: r.standardPriceUsd ?? '',
    date: r.lastPoDate || '',
  })

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const styleIqRow = (dr: any, bg: string) => {
    dr.height = 18
    dr.eachCell({ includeEmpty: true }, (cell: any) => {
      cell.fill      = { type: 'pattern', pattern: 'solid', fgColor: { argb: bg } }
      cell.font      = { size: 9, name: 'Calibri' }
      cell.alignment = { vertical: 'middle' }
      cell.border    = { bottom: { style: 'thin', color: { argb: 'FFE5E7EB' } } }
    })
    for (const k of ['lastPoLocal', 'stdLocal', 'lastPoUsd', 'stdUsd']) {
      const c = dr.getCell(k)
      c.alignment = { horizontal: 'right', vertical: 'middle' }
      if (c.value !== '' && c.value != null) c.numFmt = '#,##0.000000'
    }
    dr.getCell('qty').alignment      = { horizontal: 'right',  vertical: 'middle' }
    dr.getCell('currency').alignment = { horizontal: 'center', vertical: 'middle' }
    dr.getCell('plant').alignment    = { horizontal: 'center', vertical: 'middle' }
  }

  if (subTab === 'results') {
    const ws = wb.addWorksheet('IQ Results', { views: [{ state: 'frozen', ySplit: 1 }] })
    ws.columns = resultsCols
    styleHeader(ws)
    ws.autoFilter = `A1:${String.fromCharCode(64 + resultsCols.length)}1`
    mpnEntries.forEach((e, i) => {
      const lpoUsd      = resolveLastPoPrice(e.bestRow)
      const stdUsd      = e.bestRow.standardPriceUsd
      const qtyIns      = ctx.mpnComponentQtys[e.mpn] ?? ctx.qty
      const totalUsd    = lpoUsd != null && lpoUsd > 0 ? lpoUsd * qtyIns : null
      const isLpoGtStd  = lpoUsd != null && stdUsd != null && lpoUsd > stdUsd
      const isSwap      = !!(ctx.myPlant && e.bestRow.siteName && e.bestRow.siteName !== ctx.myPlant)
      const isManual    = lpoUsd === 0
      const nexarEntry  = ctx.mpnNexarMap[e.mpn]
      const nexarBestUsd = nexarEntry?.nexarBestUsd ?? null
      const nexarSeller  = nexarEntry?.nexarSeller ?? ''
      const bestInMarket = nexarBestUsd != null && lpoUsd != null && lpoUsd > 0 && nexarBestUsd < lpoUsd
      const row = ws.addRow({
        mpn: e.bestRow.mpn,
        supplier: e.bestRow.supplierName || e.bestRow.englishName || '',
        searched: e.mpn,
        internalPN: e.bestRow.internalPN,
        plant: e.bestRow.siteName,
        qty: e.bestRow.quantity ?? '',
        currency: e.bestRow.localCurrency || '',
        lastPoLocal: resolvePoLocal(e.bestRow) ?? '',
        stdLocal: resolveStdLocal(e.bestRow) ?? '',
        lastPoUsd: lpoUsd ?? '',
        stdUsd: stdUsd ?? '',
        qtyIns,
        totalUsd: totalUsd ?? '',
        date: e.bestRow.lastPoDate || '',
        lpoGtStd: isLpoGtStd ? 1 : '',
        swap: isSwap ? 1 : '',
        manual: isManual ? 1 : '',
        bestInMkt: bestInMarket ? 1 : '',
        nexarUsd: nexarBestUsd ?? '',
        nexarSeller,
      })
      row.height = 18
      const bg = isLpoGtStd ? 'FFFEE2E2' : isSwap ? 'FFD1FAE5' : i % 2 === 0 ? 'FFE8F5E9' : 'FFF0FDF4'
      row.eachCell({ includeEmpty: true }, (cell: any) => {
        cell.fill      = { type: 'pattern', pattern: 'solid', fgColor: { argb: bg } }
        cell.font      = { size: 9, name: 'Calibri' }
        cell.alignment = { vertical: 'middle' }
        cell.border    = { bottom: { style: 'thin', color: { argb: 'FFE5E7EB' } } }
      })
      for (const k of ['lastPoLocal', 'stdLocal', 'lastPoUsd', 'stdUsd', 'totalUsd', 'nexarUsd']) {
        const c = row.getCell(k)
        c.alignment = { horizontal: 'right', vertical: 'middle' }
        if (c.value !== '' && c.value != null) c.numFmt = '#,##0.000000'
      }
      const qtyInsCell = row.getCell('qtyIns')
      qtyInsCell.alignment = { horizontal: 'right', vertical: 'middle' }
      if (qtyInsCell.value != null && qtyInsCell.value !== '') qtyInsCell.numFmt = '#,##0'
      row.getCell('qty').alignment      = { horizontal: 'right',  vertical: 'middle' }
      row.getCell('currency').alignment = { horizontal: 'center', vertical: 'middle' }
      row.getCell('plant').alignment    = { horizontal: 'center', vertical: 'middle' }
      for (const k of ['lpoGtStd', 'swap', 'manual', 'bestInMkt']) {
        row.getCell(k).alignment = { horizontal: 'center', vertical: 'middle' }
      }
      if (nexarBestUsd != null) {
        row.getCell('nexarUsd').font    = { bold: true, size: 9, name: 'Calibri', color: { argb: 'FF7C3AED' } }
        row.getCell('nexarSeller').font = { size: 9, name: 'Calibri', color: { argb: 'FF7C3AED' } }
      }
    })

  } else if (subTab === 'allrecords') {
    const ws = wb.addWorksheet('All Records', { views: [{ state: 'frozen', ySplit: 1 }] })
    ws.columns = iqCols
    styleHeader(ws)
    ws.autoFilter = `A1:${String.fromCharCode(64 + iqCols.length)}1`
    mpnEntries.flatMap(e => e.allRows).forEach((r, i) => {
      const nexarEntry   = ctx.mpnNexarMap[r.mpn]
      const nexarBestUsd = nexarEntry?.nexarBestUsd ?? null
      const nexarSeller  = nexarEntry?.nexarSeller ?? ''
      const lpoUsd       = resolveLastPoPrice(r)
      const bestInMarket = nexarBestUsd != null && lpoUsd != null && lpoUsd > 0 && nexarBestUsd < lpoUsd
      const row = ws.addRow({
        ...toRowData(r),
        bestInMkt: bestInMarket ? 1 : '',
        nexarUsd: nexarBestUsd ?? '',
        nexarSeller,
      })
      styleIqRow(row, i % 2 === 0 ? 'FFFFFFFF' : 'FFF8FAFC')
      for (const k of ['bestInMkt']) { row.getCell(k).alignment = { horizontal: 'center', vertical: 'middle' } }
      if (nexarBestUsd != null) {
        row.getCell('nexarUsd').font    = { bold: true, size: 9, name: 'Calibri', color: { argb: 'FF7C3AED' } }
        row.getCell('nexarSeller').font = { size: 9, name: 'Calibri', color: { argb: 'FF7C3AED' } }
      }
    })

  } else if (subTab === 'blocked') {
    const ws = wb.addWorksheet('Blocked - Deleted', { views: [{ state: 'frozen', ySplit: 1 }] })
    ws.columns = [
      { header: 'Kind',         key: 'kind',         width: 12 },
      { header: 'Code',         key: 'code',         width: 10 },
      { header: 'Reason',       key: 'reason',       width: 42 },
      { header: 'Internal PN',  key: 'internalPN',   width: 16 },
      { header: 'MPN',          key: 'mpn',          width: 24 },
      { header: 'Alt PN',       key: 'altPn',        width: 24 },
      { header: 'Manufacturer', key: 'manufacturer', width: 30 },
    ]
    styleHeader(ws)
    ws.autoFilter = 'A1:G1'
    allBlockedItems.forEach(item => {
      const reason   = BLOCK_REASONS[item.code] ?? (item.kind === 'deleted' ? 'Deleted from AVL' : 'Unknown reason')
      const isDanger = item.code === 'F' || item.code === 'ER'
      const bg       = isDanger ? 'FFFECACA' : item.kind === 'blocked' ? 'FFFEF3C7' : 'FFFEE2E2'
      const accent   = isDanger ? 'FFB91C1C' : item.kind === 'blocked' ? 'FF92400E' : 'FF991B1B'
      const dr = ws.addRow({
        kind: item.kind === 'blocked' ? 'BLOCKED' : 'DELETED',
        code: item.code, reason, internalPN: item.internalPN,
        mpn: item.mpn, altPn: item.mpnPartNumber, manufacturer: item.mfgName,
      })
      dr.height = 18
      dr.eachCell({ includeEmpty: true }, (cell: any) => {
        cell.fill      = { type: 'pattern', pattern: 'solid', fgColor: { argb: bg } }
        cell.font      = { size: 9, name: 'Calibri' }
        cell.alignment = { vertical: 'middle' }
        cell.border    = { bottom: { style: 'thin', color: { argb: 'FFE5E7EB' } } }
      })
      for (const k of ['kind', 'code']) {
        dr.getCell(k).font      = { bold: true, size: 9, name: 'Calibri', color: { argb: accent } }
        dr.getCell(k).alignment = { horizontal: 'center', vertical: 'middle' }
      }
    })

  } else {
    // Deep Analysis
    const ws = wb.addWorksheet('Deep Analysis', { views: [{ state: 'frozen', ySplit: 1 }] })
    ws.columns = [
      { header: 'Internal PN',             key: 'internalPN',   width: 16 },
      { header: 'MPN (Multi-MPN)',          key: 'mpnMpn',       width: 24 },
      { header: 'Plant (Multi-MPN)',        key: 'mpnPlant',     width: 12 },
      { header: 'Supplier (Multi-MPN)',     key: 'mpnSupplier',  width: 30 },
      { header: 'Last PO USD (Multi-MPN)', key: 'mpnPrice',     width: 20 },
      { header: 'Std USD (Multi-MPN)',     key: 'mpnStd',       width: 18 },
      { header: 'Date (Multi-MPN)',         key: 'mpnDate',      width: 14 },
      { header: 'Internal PN (Multi-Comp)',key: 'mcInternalPN', width: 16 },
      { header: 'MPN (Multi-Comp)',         key: 'mcMpn',        width: 24 },
      { header: 'Plant (Multi-Comp)',       key: 'mcPlant',      width: 12 },
      { header: 'Supplier (Multi-Comp)',    key: 'mcSupplier',   width: 30 },
      { header: 'Last PO USD (Multi-Comp)',key: 'mcPrice',      width: 20 },
      { header: 'Std USD (Multi-Comp)',    key: 'mcStd',        width: 18 },
      { header: 'Date (Multi-Comp)',        key: 'mcDate',       width: 14 },
      { header: 'QTY Inserted',            key: 'qtyIns',       width: 14 },
      { header: 'Total (USD) per QTY',     key: 'totalUsd',     width: 22 },
      { header: 'Winner',                  key: 'winner',       width: 14 },
    ]
    styleHeader(ws)
    ws.autoFilter = `A1:Q1`
    deepAnalysisRows.filter(dr => dr.status === 'done').forEach((dr, i) => {
      const candidates = mpnEntries.filter(e => e.bestRow.internalPN === dr.internalPN)
      const mpnBest    = candidates.reduce<typeof mpnEntries[0] | null>((min, e) => {
        const p = resolveLastPoPrice(e.bestRow), mp = min ? resolveLastPoPrice(min.bestRow) : null
        return p == null ? min : mp == null ? e : p < mp ? e : min
      }, null)
      const mpnPrice = mpnBest ? resolveLastPoPrice(mpnBest.bestRow) : null
      const mcPrice  = dr.mcBestPriceUsd
      const qtyIns   = ctx.mpnComponentQtys[mpnBest?.mpn ?? ''] ?? ctx.qty
      const winner   = mpnPrice != null && mcPrice != null
        ? mpnPrice < mcPrice ? 'Multi-MPN' : mcPrice < mpnPrice ? 'Multi-Comp' : 'Tie'
        : mpnPrice != null ? 'Multi-MPN' : mcPrice != null ? 'Multi-Comp' : ''
      const winnerPrice = winner === 'Multi-MPN' ? mpnPrice : winner === 'Multi-Comp' ? mcPrice : winner === 'Tie' ? (mpnPrice ?? mcPrice) : null
      const totalUsd = winnerPrice != null && winnerPrice > 0 ? winnerPrice * qtyIns : null
      const row = ws.addRow({
        internalPN:   dr.internalPN,
        mpnMpn:       mpnBest?.mpn || '',
        mpnPlant:     mpnBest?.bestRow.siteName || '',
        mpnSupplier:  mpnBest ? (mpnBest.bestRow.supplierName || mpnBest.bestRow.englishName || '') : '',
        mpnPrice:     mpnPrice ?? '',
        mpnStd:       mpnBest?.bestRow.standardPriceUsd ?? '',
        mpnDate:      mpnBest?.bestRow.lastPoDate || '',
        mcInternalPN: dr.mcBestInternalPN || '',
        mcMpn:        dr.mcBestMpn || '',
        mcPlant:      dr.mcBestPlant || '',
        mcSupplier:   dr.mcBestSupplier || '',
        mcPrice:      mcPrice ?? '',
        mcStd:        dr.mcStdPriceUsd ?? '',
        mcDate:       dr.mcLastPoDate || '',
        qtyIns,
        totalUsd:     totalUsd ?? '',
        winner,
      })
      row.height = 18
      const bg = winner === 'Multi-MPN' ? 'FFD1FAE5' : winner === 'Multi-Comp' ? 'FFEDE9FE' : i % 2 === 0 ? 'FFFFFFFF' : 'FFF8FAFC'
      row.eachCell({ includeEmpty: true }, (cell: any) => {
        cell.fill      = { type: 'pattern', pattern: 'solid', fgColor: { argb: bg } }
        cell.font      = { size: 9, name: 'Calibri' }
        cell.alignment = { vertical: 'middle' }
        cell.border    = { bottom: { style: 'thin', color: { argb: 'FFE5E7EB' } } }
      })
      for (const k of ['mpnPrice', 'mpnStd', 'mcPrice', 'mcStd', 'totalUsd']) {
        const c = row.getCell(k)
        c.alignment = { horizontal: 'right', vertical: 'middle' }
        if (c.value !== '' && c.value != null) c.numFmt = '#,##0.000000'
      }
      row.getCell('qtyIns').alignment = { horizontal: 'right', vertical: 'middle' }
      if (row.getCell('qtyIns').value != null) row.getCell('qtyIns').numFmt = '#,##0'
      const wc = row.getCell('winner')
      wc.alignment = { horizontal: 'center', vertical: 'middle' }
      if (winner === 'Multi-MPN') {
        wc.font = { bold: true, size: 9, name: 'Calibri', color: { argb: 'FF166534' } }
        row.getCell('mpnPrice').font = { bold: true, size: 9, name: 'Calibri', color: { argb: 'FF166534' } }
        row.getCell('totalUsd').font = { bold: true, size: 9, name: 'Calibri', color: { argb: 'FF166534' } }
      } else if (winner === 'Multi-Comp') {
        wc.font = { bold: true, size: 9, name: 'Calibri', color: { argb: 'FF7C3AED' } }
        row.getCell('mcPrice').font  = { bold: true, size: 9, name: 'Calibri', color: { argb: 'FF7C3AED' } }
        row.getCell('totalUsd').font = { bold: true, size: 9, name: 'Calibri', color: { argb: 'FF7C3AED' } }
      }
    })
  }

  const buffer = await wb.xlsx.writeBuffer()
  const blob   = new Blob([buffer], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' })
  const url    = URL.createObjectURL(blob)
  const a      = document.createElement('a')
  a.href = url; a.download = filename; a.click()
  URL.revokeObjectURL(url)
}

async function downloadMcDeepExcelFile(
  rows: McDeepRow[],
  componentQtys: Record<string, number>,
  qty: number,
  filename: string,
): Promise<void> {
  const ExcelJS = (await import('exceljs')).default
  const wb = new ExcelJS.Workbook()
  wb.creator = 'PPV Dashboard'
  const ws = wb.addWorksheet('MC Deep Analysis', { views: [{ state: 'frozen', ySplit: 1 }] })

  ws.columns = [
    { header: 'BMATN',                          key: 'bmatn',          width: 18 },
    { header: 'MC Internal PN',                 key: 'mcInternalPN',   width: 16 },
    { header: 'MC MPN',                         key: 'mcMpn',          width: 24 },
    { header: 'MC Plant',                       key: 'mcPlant',        width: 12 },
    { header: 'MC Supplier',                    key: 'mcSupplier',     width: 30 },
    { header: 'MC Last PO (USD)',               key: 'mcPrice',        width: 18 },
    { header: 'MC Std (USD)',                   key: 'mcStd',          width: 14 },
    { header: 'MC Date',                        key: 'mcDate',         width: 14 },
    { header: 'MPN Internal PN',                key: 'mpnInternalPN',  width: 16 },
    { header: 'MPN MPN',                        key: 'mpnMpn',         width: 24 },
    { header: 'MPN Plant',                      key: 'mpnPlant',       width: 12 },
    { header: 'MPN Supplier',                   key: 'mpnSupplier',    width: 30 },
    { header: 'MPN Last PO (USD)',              key: 'mpnPrice',       width: 18 },
    { header: 'MPN Std (USD)',                  key: 'mpnStd',         width: 14 },
    { header: 'MPN Date',                       key: 'mpnDate',        width: 14 },
    { header: 'QTY Inserted',                   key: 'qtyIns',         width: 14 },
    { header: 'Total (USD) per QTY',            key: 'totalUsd',       width: 22 },
    { header: 'Winner',                         key: 'winner',         width: 14 },
  ]

  // Style header
  const headerRow = ws.getRow(1)
  headerRow.height = 22
  headerRow.eachCell((cell: any) => {
    cell.font      = { bold: true, size: 9, name: 'Calibri', color: { argb: 'FFFFFFFF' } }
    cell.fill      = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1F2937' } }
    cell.alignment = { vertical: 'middle', horizontal: 'center' }
    cell.border    = { bottom: { style: 'medium', color: { argb: 'FF374151' } } }
  })
  ws.autoFilter = `A1:R1`

  rows.filter(dr => dr.mpnStatus === 'done').forEach((dr, i) => {
    const mcPrice  = dr.mcPrice
    const mpnPrice = dr.mpnBestPriceUsd
    const qtyIns   = componentQtys[dr.bmatn] ?? qty
    let winner: 'MC' | 'MPN' | 'Tie' | '' = ''
    if (mcPrice != null && mpnPrice != null) {
      winner = mcPrice < mpnPrice ? 'MC' : mpnPrice < mcPrice ? 'MPN' : 'Tie'
    } else if (mcPrice != null) winner = 'MC'
    else if (mpnPrice != null) winner = 'MPN'
    const winnerPrice = winner === 'MC' ? mcPrice : winner === 'MPN' ? mpnPrice : winner === 'Tie' ? (mcPrice ?? mpnPrice) : null
    const totalUsd = winnerPrice != null ? winnerPrice * qtyIns : null

    const row = ws.addRow({
      bmatn:         dr.bmatn,
      qtyIns,
      mcInternalPN:  dr.mcInternalPN || '',
      mcMpn:         dr.mcMpn || '',
      mcPlant:       dr.mcPlant || '',
      mcSupplier:    dr.mcSupplier || '',
      mcPrice:       mcPrice ?? '',
      mcStd:         dr.mcStdPriceUsd ?? '',
      mcDate:        dr.mcLastPoDate || '',
      mpnInternalPN: dr.mpnBestInternalPN || '',
      mpnMpn:        dr.mpnBestMpn || '',
      mpnPlant:      dr.mpnBestPlant || '',
      mpnSupplier:   dr.mpnBestSupplier || '',
      mpnPrice:      mpnPrice ?? '',
      mpnStd:        dr.mpnBestStdPriceUsd ?? '',
      mpnDate:       dr.mpnLastPoDate || '',
      totalUsd:      totalUsd ?? '',
      winner,
    })
    row.height = 18
    const bg = winner === 'MC' ? 'FFEDE9FE' : winner === 'MPN' ? 'FFD1FAE5' : i % 2 === 0 ? 'FFFFFFFF' : 'FFF8FAFC'
    row.eachCell({ includeEmpty: true }, (cell: any) => {
      cell.fill      = { type: 'pattern', pattern: 'solid', fgColor: { argb: bg } }
      cell.font      = { size: 9, name: 'Calibri' }
      cell.alignment = { vertical: 'middle' }
      cell.border    = { bottom: { style: 'thin', color: { argb: 'FFE5E7EB' } } }
    })
    for (const k of ['mcPrice', 'mcStd', 'mpnPrice', 'mpnStd', 'totalUsd']) {
      const c = row.getCell(k)
      c.alignment = { horizontal: 'right', vertical: 'middle' }
      if (c.value !== '' && c.value != null) c.numFmt = '#,##0.000000'
    }
    row.getCell('qtyIns').alignment = { horizontal: 'right', vertical: 'middle' }
    if (row.getCell('qtyIns').value != null) row.getCell('qtyIns').numFmt = '#,##0'
    row.getCell('winner').alignment = { horizontal: 'center', vertical: 'middle' }
    if (winner === 'MC') {
      row.getCell('winner').font  = { bold: true, size: 9, name: 'Calibri', color: { argb: 'FF7C3AED' } }
      row.getCell('mcPrice').font = { bold: true, size: 9, name: 'Calibri', color: { argb: 'FF7C3AED' } }
      row.getCell('totalUsd').font = { bold: true, size: 9, name: 'Calibri', color: { argb: 'FF7C3AED' } }
    } else if (winner === 'MPN') {
      row.getCell('winner').font   = { bold: true, size: 9, name: 'Calibri', color: { argb: 'FF166534' } }
      row.getCell('mpnPrice').font = { bold: true, size: 9, name: 'Calibri', color: { argb: 'FF166534' } }
      row.getCell('totalUsd').font = { bold: true, size: 9, name: 'Calibri', color: { argb: 'FF166534' } }
    }
  })

  const buffer = await wb.xlsx.writeBuffer()
  const blob   = new Blob([buffer], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' })
  const url    = URL.createObjectURL(blob)
  const a      = document.createElement('a')
  a.href = url; a.download = filename; a.click()
  URL.revokeObjectURL(url)
}

// ── CBOM + PPV left-join export ───────────────────────────────────────────────
async function downloadCbomResultsExcel(
  cbomHeaders: string[],
  cbomRows: Array<(string | number | null)[]>,
  cbomMpnColIdx: number,
  mpnEntries: Array<{ mpn: string; bestRow: IQItem; allRows: IQItem[] }>,
  deepAnalysisRows: DeepAnalysisRow[],
  mpnNexarMap: Record<string, { nexarBestUsd: number | null; nexarSeller: string; nexarManufacturer: string; nexarStock: number | null; nexarMoq: number | null; nexarMpn: string }>,
  lyticaMap: Record<string, { mpnMatched: string; manufacturerMatched: string; price90th: number | null }>,
  filename: string,
): Promise<void> {
  // ── Lookup maps ─────────────────────────────────────────────────────────────
  const mpnToEntry = new Map<string, { mpn: string; bestRow: IQItem; allRows: IQItem[] }>()
  for (const e of mpnEntries) mpnToEntry.set(e.mpn.toUpperCase(), e)

  const ipToDeepRow = new Map<string, DeepAnalysisRow>()
  for (const dr of deepAnalysisRows.filter(d => d.status === 'done')) ipToDeepRow.set(dr.internalPN, dr)

  const hasDeepAnalysis = ipToDeepRow.size > 0

  // Find Cost #1 (Conv.) column index (0-based); Cost #2 is no longer used for deltas
  const cost1Idx = cbomHeaders.findIndex(h => h.trim() === 'Cost #1 (Conv.)')

  const toNum = (v: string | number | null): number | null => {
    if (typeof v === 'number' && isFinite(v)) return v
    if (typeof v === 'string') { const n = parseFloat(v); return isFinite(n) ? n : null }
    return null
  }

  // ── Best-result lookup: uses Deep Analysis winner when available ─────────────
  type BestResult = {
    source: string; internalPN: string; mpn: string; plant: string; supplier: string
    lastPoUsd: number | null; stdUsd: number | null; date: string
  }

  const getBestForMpn = (mpnRaw: string): BestResult | null => {
    const entry = mpnToEntry.get(mpnRaw.toUpperCase())
    if (!entry) return null

    const ip = entry.bestRow.internalPN
    const dr = ipToDeepRow.get(ip)

    if (dr) {
      // Replicate the winner logic from the Deep Analysis tab
      const candidates = mpnEntries.filter(e => e.bestRow.internalPN === ip)
      const mpnBest    = candidates.reduce<typeof mpnEntries[0] | null>((min, e) => {
        const p = resolveLastPoPrice(e.bestRow), mp = min ? resolveLastPoPrice(min.bestRow) : null
        return p == null ? min : mp == null ? e : p < mp ? e : min
      }, null)
      const mpnPrice = mpnBest ? resolveLastPoPrice(mpnBest.bestRow) : null
      const mcPrice  = dr.mcBestPriceUsd
      const winner   = mpnPrice != null && mcPrice != null
        ? mpnPrice < mcPrice ? 'Multi-MPN' : mcPrice < mpnPrice ? 'Multi-Comp' : 'Tie'
        : mpnPrice != null ? 'Multi-MPN' : mcPrice != null ? 'Multi-Comp' : ''

      if (winner === 'Multi-Comp') {
        return {
          source: 'Multi-Comp (Int. PN)',
          internalPN: dr.mcBestInternalPN || ip, mpn: dr.mcBestMpn,
          plant: dr.mcBestPlant, supplier: dr.mcBestSupplier,
          lastPoUsd: dr.mcBestPriceUsd, stdUsd: dr.mcStdPriceUsd, date: dr.mcLastPoDate,
        }
      }
      if (mpnBest) {
        const r = mpnBest.bestRow
        return {
          source: winner === 'Tie' ? 'Tie (MPN used)' : 'Multi-MPN',
          internalPN: r.internalPN, mpn: r.mpn, plant: r.siteName,
          supplier: r.supplierName || r.englishName || '',
          lastPoUsd: resolveLastPoPrice(r), stdUsd: r.standardPriceUsd, date: r.lastPoDate,
        }
      }
    }

    // Fallback: no deep analysis — use direct MPN search result
    const r = entry.bestRow
    return {
      source: 'MPN Only',
      internalPN: r.internalPN, mpn: r.mpn, plant: r.siteName,
      supplier: r.supplierName || r.englishName || '',
      lastPoUsd: resolveLastPoPrice(r), stdUsd: r.standardPriceUsd, date: r.lastPoDate,
    }
  }

  // ── Nexar best for a given MPN (from the map) ────────────────────────────────
  const hasNexarData = Object.keys(mpnNexarMap).length > 0
  const getNexarForMpn = (mpnRaw: string) => mpnNexarMap[mpnRaw.toUpperCase()] ?? mpnNexarMap[mpnRaw] ?? null

  // ── Lytica lookup for a given MPN ────────────────────────────────────────────
  const hasLyticaData = Object.keys(lyticaMap).length > 0
  const getLyticaForMpn = (mpnRaw: string) => lyticaMap[mpnRaw.toUpperCase()] ?? lyticaMap[mpnRaw] ?? null

  // ── Build worksheet ─────────────────────────────────────────────────────────
  const ExcelJS = (await import('exceljs')).default
  const wb = new ExcelJS.Workbook()
  wb.creator = 'PPV Dashboard'
  wb.created = new Date()
  const ws = wb.addWorksheet('CBOM + PPV Results', { views: [{ state: 'frozen', ySplit: 1 }] })

  const ppvHeaders: string[] = [
    'SAP - Internal PN',
    'SAP - MPN',
    'SAP - Plant',
    'SAP - Supplier',
    'SAP - Best Last PO Interplants',
    'SAP - STD Price',
    'SAP - Date',
    ...(hasNexarData ? [
      'Nexar - MPN',
      'Nexar - Manufacturer',
      'Nexar - Supplier',
      'Nexar - Unit Price (USD)',
      'Nexar - Stock',
      'Nexar - MOQ',
    ] : []),
    ...(hasLyticaData ? [
      'Lytica - MPN Searched',
      'Lytica - MPN Matched',
      'Lytica - Manufacturer Matched',
      'Lytica - 90th %tile',
    ] : []),
    'Best Source',
    'Best Price',
    'Δ Cost#1 - Best Price',
    'Δ Cost#1 - STD',
  ]

  const colWidth = (h: string) => Math.min(Math.max((h?.length ?? 0) + 4, 10), 40)
  ws.columns = [
    ...cbomHeaders.map((h, i) => ({ header: h || `Col${i + 1}`, key: `c${i}`, width: colWidth(h) })),
    ...ppvHeaders.map(h => ({ header: h, key: h, width: h.startsWith('Nexar') || h.startsWith('Lytica') ? 26 : 24 })),
  ]

  const totalCols    = cbomHeaders.length + ppvHeaders.length
  // 1-based column numbers (calculated from position in ppvHeaders, order-independent)
  const lpoColNum         = cbomHeaders.length + ppvHeaders.indexOf('SAP - Best Last PO Interplants') + 1
  const stdColNum         = cbomHeaders.length + ppvHeaders.indexOf('SAP - STD Price') + 1
  const delta1ColNum      = cbomHeaders.length + ppvHeaders.indexOf('Δ Cost#1 - Best Price') + 1
  const delta2ColNum      = cbomHeaders.length + ppvHeaders.indexOf('Δ Cost#1 - STD') + 1
  const nexarPriceColNum  = hasNexarData  ? cbomHeaders.length + ppvHeaders.indexOf('Nexar - Unit Price (USD)') + 1 : -1
  const lytica90ColNum    = hasLyticaData ? cbomHeaders.length + ppvHeaders.indexOf('Lytica - 90th %tile') + 1 : -1
  const bestSourceColNum  = cbomHeaders.length + ppvHeaders.indexOf('Best Source') + 1
  const bestPriceColNum   = cbomHeaders.length + ppvHeaders.indexOf('Best Price') + 1

  const hdr = ws.getRow(1)
  hdr.height = 24
  hdr.eachCell({ includeEmpty: true }, (cell, colNum) => {
    const isCbom      = colNum <= cbomHeaders.length
    const isDelta     = colNum === delta1ColNum || colNum === delta2ColNum
    const isNexar     = nexarPriceColNum > 0 && colNum >= nexarPriceColNum - 3 && colNum <= nexarPriceColNum + 2
    const isLytica    = lytica90ColNum > 0 && colNum >= lytica90ColNum - 3 && colNum <= lytica90ColNum
    const isBestGroup = colNum === bestSourceColNum || colNum === bestPriceColNum
    const bg = isCbom ? 'FF1E3A5F' : isDelta ? 'FF5B21B6' : isNexar ? 'FF7C2D12' : isLytica ? 'FF0F766E' : isBestGroup ? 'FF0C4A6E' : 'FF065F46'
    const border = isCbom ? 'FF2563EB' : isDelta ? 'FF8B5CF6' : isNexar ? 'FFDC2626' : isLytica ? 'FF14B8A6' : isBestGroup ? 'FF0EA5E9' : 'FF059669'
    cell.fill      = { type: 'pattern', pattern: 'solid', fgColor: { argb: bg } }
    cell.font      = { bold: true, color: { argb: 'FFFFFFFF' }, size: 10, name: 'Calibri' }
    cell.alignment = { horizontal: 'center', vertical: 'middle', wrapText: false }
    cell.border    = { bottom: { style: 'medium', color: { argb: border } }, right: { style: 'thin', color: { argb: 'FF374151' } } }
  })
  ws.autoFilter = `A1:${ws.getColumn(totalCols).letter}1`

  // ── Analysis accumulators ───────────────────────────────────────────────────
  type AnalysisRow = {
    mpn: string; internalPN: string; supplier: string; plant: string; bestSource: string
    cost1: number | null; lastPoUsd: number | null; stdUsd: number | null
    delta1: number | null; delta2: number | null
  }
  let statTotal = 0, statNotFound = 0, statFav = 0, statUnfav = 0, statNeutral = 0
  const analysisRows: AnalysisRow[] = []

  cbomRows.forEach((row, i) => {
    const mpnRaw    = String(row[cbomMpnColIdx] ?? '').trim()
    const sapBest   = getBestForMpn(mpnRaw)                            // SAP winner (null if not found)
    const cost1     = cost1Idx >= 0 ? toNum(row[cost1Idx]) : null

    // Always look up Nexar / Lytica regardless of SAP result
    const nexarEntry  = getNexarForMpn(mpnRaw)
    const lyticaEntry = getLyticaForMpn(mpnRaw)

    // ── Determine overall winner across all sources ──────────────────────────
    type WinSrc = 'sap' | 'nexar' | 'lytica' | 'tie'
    const priceCands: Array<[WinSrc, number]> = []
    if (sapBest?.lastPoUsd != null)       priceCands.push(['sap',    sapBest.lastPoUsd])
    if (nexarEntry?.nexarBestUsd != null) priceCands.push(['nexar',  nexarEntry.nexarBestUsd])
    if (lyticaEntry?.price90th != null)   priceCands.push(['lytica', lyticaEntry.price90th])

    let winSrc: WinSrc | null = null
    let winPrice: number | null = null
    if (priceCands.length > 0) {
      const minP = Math.min(...priceCands.map(([, p]) => p))
      const mins = priceCands.filter(([, p]) => p === minP)
      winSrc   = mins.length === 1 ? mins[0][0] : 'tie'
      winPrice = minP
    }

    // Only SAP exposes a STD price; Nexar/Lytica have no STD
    const winnerStd = (winSrc === 'sap' || winSrc === 'tie') ? (sapBest?.stdUsd ?? null) : null

    // Deltas: Cost#1 (Conv.) minus the best-market price
    const delta1 = cost1 != null && winPrice    != null ? cost1 - winPrice    : null
    const delta2 = cost1 != null && winnerStd   != null ? cost1 - winnerStd   : null

    // Best-source label for the report column
    const sapSrcLabel  = sapBest?.source || 'SAP'
    const sapSrcFull   = sapSrcLabel.startsWith('Multi-MPN') ? 'SAP MPN' : sapSrcLabel.startsWith('Multi-Comp') || sapSrcLabel.startsWith('Tie') ? 'SAP COMPONENT' : 'SAP MPN'
    const bestSourceLabel = winSrc === 'sap'    ? sapSrcFull
      : winSrc === 'nexar'  ? 'NEXAR MARKET'
      : winSrc === 'lytica' ? 'LYTICA'
      : winSrc === 'tie'    ? 'TIE'
      : 'Not Found'

    // "truly not found" = nothing from any source, OR something returned but zero usable prices
    const anyFound   = sapBest != null || nexarEntry != null || lyticaEntry != null
    const noPrice    = winSrc === null   // sources found but none had an actual price

    // Accumulate stats
    statTotal++
    if (!anyFound || noPrice)    { statNotFound++ }
    else if (delta1 == null)     { statNeutral++  }
    else if (delta1 < 0)         { statFav++      }
    else if (delta1 > 0)         { statUnfav++    }
    else                         { statNeutral++  }

    if (anyFound) {
      analysisRows.push({
        mpn: sapBest?.mpn || mpnRaw, internalPN: sapBest?.internalPN || '',
        supplier: sapBest?.supplier || nexarEntry?.nexarSeller || '',
        plant: sapBest?.plant || '',
        bestSource: bestSourceLabel,
        cost1, lastPoUsd: winPrice, stdUsd: winnerStd, delta1, delta2,
      })
    }

    const ppvValues: (string | number | null)[] = anyFound
      ? [
          sapBest?.internalPN || 'Not Found',
          sapBest?.mpn        || mpnRaw,
          sapBest?.plant      || 'Not Found',
          sapBest?.supplier   || 'Not Found',
          sapBest?.lastPoUsd  ?? 'Not Found',
          sapBest?.stdUsd     ?? 'Not Found',
          sapBest?.date       || 'Not Found',
          ...(hasNexarData ? [
            nexarEntry?.nexarMpn          || 'Not Found',
            nexarEntry?.nexarManufacturer || 'Not Found',
            nexarEntry?.nexarSeller       || 'Not Found',
            nexarEntry?.nexarBestUsd      ?? 'Not Found',
            nexarEntry?.nexarStock        ?? 'Not Found',
            nexarEntry?.nexarMoq          ?? 'Not Found',
          ] : []),
          ...(hasLyticaData ? [
            mpnRaw,
            lyticaEntry?.mpnMatched          || 'Not Found',
            lyticaEntry?.manufacturerMatched || 'Not Found',
            lyticaEntry?.price90th           ?? 'Not Found',
          ] : []),
          bestSourceLabel,
          winPrice            ?? 'Not Found',
          delta1              ?? 'N/A',
          delta2              ?? 'N/A',
        ]
      : Array(ppvHeaders.length).fill('Not Found') as string[]

    const dr = ws.addRow([...row.map(v => v ?? ''), ...ppvValues])
    dr.height = 18

    const notFound = !anyFound || noPrice   // whole row yellow when no usable price from any source
    // Green row when actual price is below quoted cost (favorable); red when above
    const isFav    = delta1 != null && delta1 < 0
    const isUnfav  = delta1 != null && delta1 > 0
    const bgColor  = notFound ? 'FFFFF9C4' : isFav ? 'FFD1FAE5' : isUnfav ? 'FFFEE2E2' : i % 2 === 0 ? 'FFFFFFFF' : 'FFF8FAFC'
    dr.eachCell({ includeEmpty: true }, cell => {
      cell.fill      = { type: 'pattern', pattern: 'solid', fgColor: { argb: bgColor } }
      cell.font      = { size: 9, name: 'Calibri' }
      cell.alignment = { vertical: 'middle' }
      cell.border    = { bottom: { style: 'thin', color: { argb: 'FFE5E7EB' } } }
    })

    // Format Last PO and STD price columns
    for (const cn of [lpoColNum, stdColNum]) {
      const c = dr.getCell(cn)
      c.alignment = { horizontal: 'right', vertical: 'middle' }
      if (typeof c.value === 'number') c.numFmt = '#,##0.000000'
    }

    // Format and colour-code the two delta columns
    // Negative (−) = green (actual cheaper than quoted); Positive (+) = red (actual costlier)
    for (const cn of [delta1ColNum, delta2ColNum]) {
      const c = dr.getCell(cn)
      c.alignment = { horizontal: 'right', vertical: 'middle' }
      if (typeof c.value === 'number') {
        c.numFmt = '#,##0.000000'
        const v  = c.value as number
        const argb = v < 0 ? 'FF166534' : v > 0 ? 'FFB91C1C' : 'FF374151'
        const bg   = v < 0 ? 'FFD1FAE5' : v > 0 ? 'FFFEE2E2' : (bgColor === 'FFFFFFFF' ? 'FFFFFFFF' : 'FFF8FAFC')
        c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: bg } }
        c.font = { size: 9, name: 'Calibri', bold: true, color: { argb } }
      }
    }

    // Format Nexar unit price column with number format
    if (nexarPriceColNum > 0) {
      const c = dr.getCell(nexarPriceColNum)
      c.alignment = { horizontal: 'right', vertical: 'middle' }
      if (typeof c.value === 'number') c.numFmt = '#,##0.000000'
    }

    // Format Lytica 90th %tile column with number format
    if (lytica90ColNum > 0) {
      const c = dr.getCell(lytica90ColNum)
      c.alignment = { horizontal: 'right', vertical: 'middle' }
      if (typeof c.value === 'number') c.numFmt = '#,##0.000000'
    }

    // PPV - Best Source: yellow if Not Found
    {
      const c = dr.getCell(bestSourceColNum)
      c.alignment = { horizontal: 'center', vertical: 'middle' }
      c.font = { size: 9, name: 'Calibri', bold: true }
      if (c.value === 'Not Found' || !anyFound) {
        c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFFF9C4' } }
        c.font = { size: 9, name: 'Calibri', bold: true, color: { argb: 'FF92400E' }, italic: true }
      }
    }

    // PPV - Best Price: number format
    {
      const c = dr.getCell(bestPriceColNum)
      c.alignment = { horizontal: 'right', vertical: 'middle' }
      if (typeof c.value === 'number') {
        c.numFmt = '#,##0.000000'
        c.font = { size: 9, name: 'Calibri', bold: true, color: { argb: 'FF0C4A6E' } }
      }
    }

    if (notFound) {
      for (let j = cbomHeaders.length + 1; j <= totalCols; j++)
        dr.getCell(j).font = { size: 9, name: 'Calibri', color: { argb: 'FF9CA3AF' }, italic: true }
    }
  })

  // ── Analysis Sheet ───────────────────────────────────────────────────────────
  const wa = wb.addWorksheet('Analysis', { views: [{ showGridLines: false }] })

  const addCell = (
    row: number, col: number, value: string | number | Date | null,
    opts?: { bold?: boolean; bg?: string; font?: string; numFmt?: string; align?: 'left'|'center'|'right'; size?: number; italic?: boolean }
  ) => {
    const c = wa.getCell(row, col)
    c.value = value
    if (opts?.numFmt) c.numFmt = opts.numFmt
    c.font = { name: 'Calibri', size: opts?.size ?? 10, bold: opts?.bold, italic: opts?.italic, color: { argb: opts?.font ?? 'FF111827' } }
    c.alignment = { horizontal: opts?.align ?? 'left', vertical: 'middle' }
    if (opts?.bg) c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: opts.bg } }
    c.border = { bottom: { style: 'thin', color: { argb: 'FFE5E7EB' } }, right: { style: 'thin', color: { argb: 'FFE5E7EB' } } }
    return c
  }

  const sectionTitle = (row: number, title: string, bgArgb: string) => {
    wa.mergeCells(row, 1, row, 8)
    const c = wa.getCell(row, 1)
    c.value = title
    c.font      = { name: 'Calibri', size: 12, bold: true, color: { argb: 'FFFFFFFF' } }
    c.fill      = { type: 'pattern', pattern: 'solid', fgColor: { argb: bgArgb } }
    c.alignment = { horizontal: 'left', vertical: 'middle', indent: 1 }
    wa.getRow(row).height = 26
  }

  // ── Meta header ──────────────────────────────────────────────────────────────
  let r = 1
  sectionTitle(r++, '📊  CBOM Analysis Summary', 'FF1E3A5F')
  addCell(r, 1, 'Generated:', { bold: true, bg: 'FFF1F5F9' })
  wa.mergeCells(r, 2, r, 5)
  addCell(r, 2, new Date().toLocaleString(), { bg: 'FFF1F5F9' })
  wa.getRow(r).height = 18; r++
  addCell(r, 1, 'File:', { bold: true, bg: 'FFF1F5F9' })
  wa.mergeCells(r, 2, r, 5)
  addCell(r, 2, filename, { bg: 'FFF1F5F9' })
  wa.getRow(r).height = 18; r++
  r++ // blank row

  // ── Row Classification ───────────────────────────────────────────────────────
  sectionTitle(r++, '🔢  Row Classification', 'FF1E3A5F')
  addCell(r, 1, 'Category',   { bold: true, bg: 'FF334155', font: 'FFFFFFFF', align: 'center' })
  addCell(r, 2, 'Count',      { bold: true, bg: 'FF334155', font: 'FFFFFFFF', align: 'center' })
  addCell(r, 3, '% of Total', { bold: true, bg: 'FF334155', font: 'FFFFFFFF', align: 'center' })
  wa.getRow(r).height = 20; r++

  const pct = (n: number) => statTotal > 0 ? `${+(n / statTotal * 100).toFixed(1)}%` : '0%'
  const summaryRows: [string, number, string][] = [
    ['Total CBOM rows',      statTotal,    'FF374151'],
    ['Favorable — green ✅', statFav,      'FF166534'],
    ['Unfavorable — red ❌', statUnfav,    'FFB91C1C'],
    ['Not Found ⚪',         statNotFound, 'FF6B7280'],
    ['No delta (N/A) ➖',   statNeutral,  'FF92400E'],
  ]
  for (const [label, count, fontArgb] of summaryRows) {
    const bg = label.startsWith('Favorable') ? 'FFD1FAE5' : label.startsWith('Unfavorable') ? 'FFFEE2E2' : label.startsWith('Not Found') ? 'FFFFF9C4' : 'FFFFFFFF'
    addCell(r, 1, label, { bg, font: fontArgb, bold: label === 'Total CBOM rows' })
    addCell(r, 2, count, { bg, align: 'center', bold: true, font: fontArgb })
    addCell(r, 3, pct(count), { bg, align: 'center' })
    wa.getRow(r).height = 18; r++
  }
  r++ // blank row

  // ── Critical items builder ───────────────────────────────────────────────────
  const TOP = 10
  const critByLpo = [...analysisRows].filter(a => a.delta1 != null).sort((a, b) => b.delta1! - a.delta1!)
  const critByStd = [...analysisRows].filter(a => a.delta2 != null).sort((a, b) => b.delta2! - a.delta2!)

  const buildCritTable = (
    startRow: number, title: string, titleBg: string,
    items: AnalysisRow[], priceLabel: string, deltaLabel: string,
    getPrice: (a: AnalysisRow) => number | null,
    getDelta: (a: AnalysisRow) => number | null,
  ): number => {
    sectionTitle(startRow++, title, titleBg)
    const headers: [string, number][] = [
      ['#', 4], ['MPN', 28], ['Internal PN', 22], ['Supplier', 30],
      ['Plant', 10], [priceLabel, 18], ['Cost #1 (Conv.)', 18], [deltaLabel, 22],
    ]
    headers.forEach(([h, w], ci) => {
      wa.getColumn(ci + 1).width = Math.max(wa.getColumn(ci + 1).width as number ?? 0, w)
      addCell(startRow, ci + 1, h, { bold: true, bg: 'FF334155', font: 'FFFFFFFF', align: 'center' })
    })
    wa.getRow(startRow).height = 20; startRow++

    items.slice(0, TOP).forEach((item, idx) => {
      const delta    = getDelta(item)
      const price    = getPrice(item)
      const isFav    = delta != null && delta < 0
      const isUnfav  = delta != null && delta > 0
      const bg       = isFav ? 'FFD1FAE5' : isUnfav ? 'FFFEE2E2' : 'FFFFFFFF'
      const fontDelta = isFav ? 'FF166534' : isUnfav ? 'FFB91C1C' : 'FF374151'
      addCell(startRow, 1, idx + 1,        { bg, align: 'center', bold: true })
      addCell(startRow, 2, item.mpn,        { bg, font: 'FF1E3A5F', bold: true })
      addCell(startRow, 3, item.internalPN, { bg })
      addCell(startRow, 4, item.supplier,   { bg })
      addCell(startRow, 5, item.plant || `(${item.bestSource})`, { bg, align: 'center', italic: !item.plant })
      const priceC = addCell(startRow, 6, price,      { bg, align: 'right', numFmt: '#,##0.000000' })
      const cost1C = addCell(startRow, 7, item.cost1, { bg, align: 'right', numFmt: '#,##0.000000' })
      const deltaC = addCell(startRow, 8, delta,      { bg: isFav ? 'FFD1FAE5' : isUnfav ? 'FFFEE2E2' : bg, align: 'right', numFmt: '#,##0.000000', bold: true, font: fontDelta })
      if (price == null) priceC.value = 'N/A'
      if (item.cost1 == null) cost1C.value = 'N/A'
      if (delta == null) deltaC.value = 'N/A'
      wa.getRow(startRow).height = 18; startRow++
    })
    return startRow
  }

  r = buildCritTable(
    r,
    `⚠️  Top ${TOP} Most Critical — Δ Last PO vs Cost #1 (highest delta first)`,
    'FF7C2D12',
    critByLpo, 'SAP - Best Last PO Interplants', 'Δ Cost#1 - Best Price',
    a => a.lastPoUsd, a => a.delta1,
  )
  r++
  r = buildCritTable(
    r,
    `⚠️  Top ${TOP} Most Critical — Δ STD vs Cost #1 (highest delta first)`,
    'FF4C1D95',
    critByStd, 'SAP - STD Price', 'Δ Cost#1 - STD',
    a => a.stdUsd, a => a.delta2,
  )

  const buffer = await wb.xlsx.writeBuffer()
  const blob   = new Blob([buffer], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' })
  const url    = URL.createObjectURL(blob)
  const a      = document.createElement('a')
  a.href = url; a.download = filename; a.click()
  URL.revokeObjectURL(url)
}

type Status = 'idle' | 'loading-ampl' | 'loading-iq' | 'loading-market' | 'done' | 'error'

export default function PriceCalculatorWidget({ mode = 'widget' }: { mode?: 'widget' | 'page' }) {
  const [open, setOpen]       = useState(mode === 'page')
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
  const [multiSubTab, setMultiSubTab]     = useState<'results' | 'allrecords' | 'blocked' | 'deep'>('results')
  const [myPlant, setMyPlant]             = useState<string>('')
  const [windowDays, setWindowDays]       = useState(45)
  const [searchMode, setSearchMode]       = useState<'internal' | 'mpn'>('internal')
  const [searchNexar, setSearchNexar]     = useState(false)
  const [componentQtys, setComponentQtys] = useState<Record<string, number>>({})
  const [componentQtyDefaults, setComponentQtyDefaults] = useState<Record<string, 'empty' | '0'>>({})
  const [excelFileName, setExcelFileName] = useState<string>('')
  const [stopHover, setStopHover] = useState(false)
  const abortRef = useRef<AbortController | null>(null)
  const [multiIqRowsMap, setMultiIqRowsMap]           = useState<Record<string, IQItem[]>>({})
  const [multiExpandedBmats, setMultiExpandedBmats]   = useState<Set<string>>(new Set())
  const [mcDeepRows, setMcDeepRows]                   = useState<McDeepRow[]>([])
  const [mcDeepLoading, setMcDeepLoading]             = useState(false)
  const abortMcDeepRef = useRef<AbortController | null>(null)

  // ── Multi-MPN tab state ───────────────────────────────────────────────────
  const [multiMpnInput, setMultiMpnInput]                             = useState('')
  const [multiMpnRawResults, setMultiMpnRawResults]                   = useState<IQItem[]>([])
  const [multiMpnSearchedList, setMultiMpnSearchedList]               = useState<string[]>([])
  const [multiMpnLoading, setMultiMpnLoading]                         = useState(false)
  const [mpnExcelFileName, setMpnExcelFileName]                       = useState<string>('')
  const [mpnComponentQtys, setMpnComponentQtys]                       = useState<Record<string, number>>({})
  const [mpnComponentQtyDefaults, setMpnComponentQtyDefaults]         = useState<Record<string, 'empty' | '0'>>({})
  const [stopMpnHover, setStopMpnHover]                               = useState(false)
  const abortMpnRef = useRef<AbortController | null>(null)
  const [multiMpnSubTab, setMultiMpnSubTab]                           = useState<'results' | 'allrecords' | 'blocked' | 'deep'>('results')
  const [multiMpnAmplMap, setMultiMpnAmplMap]                         = useState<Record<string, AmplResponse>>({})
  const [multiMpnExpandedMpns, setMultiMpnExpandedMpns]               = useState<Set<string>>(new Set())
  const [mpnNexarMap, setMpnNexarMap]                                 = useState<Record<string, { nexarBestUsd: number | null; nexarSeller: string; nexarManufacturer: string; nexarStock: number | null; nexarMoq: number | null; nexarMpn: string }>>({})
  const [deepAnalysisRows, setDeepAnalysisRows]                       = useState<DeepAnalysisRow[]>([])
  const [deepAnalysisLoading, setDeepAnalysisLoading]                 = useState(false)
  const abortDeepRef = useRef<AbortController | null>(null)

  // ── CBOM upload state ─────────────────────────────────────────────────────
  const [cbomRows, setCbomRows]           = useState<Array<(string | number | null)[]>>([])
  const [cbomFileName, setCbomFileName]   = useState<string>('')
  const [cbomHeaders, setCbomHeaders]     = useState<string[]>([])
  const [cbomMpnColIdx, setCbomMpnColIdx] = useState<number>(-1)

  // ── Lytica upload state ───────────────────────────────────────────────────
  const [lyticaMap, setLyticaMap]         = useState<Record<string, { mpnMatched: string; manufacturerMatched: string; price90th: number | null }>>({})
  const [lyticaFileName, setLyticaFileName] = useState<string>('')

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
      if (searchMode === 'mpn') {
        // ── MPN mode: skip AMPL, query IQ + market directly ──────────────────
        const queryMpns = [bmatn.trim().toUpperCase()]
        setStatus('loading-iq')
        const iqData = await apiPost<{ count: number; data: IQItem[] }>('/api/pricecalc/internal-query', { mpns: queryMpns })
        const rows: IQItem[] = Array.isArray(iqData.data) ? iqData.data : []
        if (!rows.length) {
          setError('No pricing data found for this MPN.')
          setStatus('error'); return
        }
        setIqRows(rows)
        setPlants(buildPlantSummaries(rows, windowDays * 86400000))
        setStatus('loading-market')
        const mkt = await apiPost<MarketResponse>('/api/pricecalc/market-prices', { mpns: queryMpns, quantity: qty })
        setMarket(mkt)
      } else {
        // ── Internal PN mode: original flow ──────────────────────────────────
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
        setPlants(buildPlantSummaries(rows, windowDays * 86400000))

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
              setBlockedPlants(buildPlantSummaries(bRows, windowDays * 86400000))
            } catch { /* non-critical */ }
          }
        }

        setStatus('loading-market')
        const mkt = await apiPost<MarketResponse>('/api/pricecalc/market-prices', { mpns: queryMpns, quantity: qty })
        setMarket(mkt)
      }

      setStatus('done')
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : String(e))
      setStatus('error')
    }
  }, [bmatn, qty, reset, windowDays, searchMode])

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
    setMultiIqRowsMap({})
    setMcDeepRows([])
    setMultiExpandedBmats(new Set())
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
        setMultiIqRowsMap(prev => ({ ...prev, [bmatn]: rows }))
        const bestPlant = buildPlantSummaries(rows, windowDays * 86400000)[0] ?? null
        const bestRow   = bestPlant?.bestRow ?? null
        const bestPrice = bestPlant?.bestPrice ?? null
        const stdPrice  = bestRow?.standardPriceUsd ?? null
        const deltaPct  = bestPrice != null && stdPrice != null && stdPrice > 0
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
          bestPlant: bestRow?.siteName ?? '—',
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
  }, [multiBmatn, searchNexar, qty, componentQtys, windowDays])

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
    const examples = [{ component: 'CCR00292', quantity: 1000 }, { component: 'EC03018', quantity: 500 }, { component: '40012', quantity: 2500 }]
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

  // ── CBOM upload: reads the "CBOM" sheet, extracts all rows + their MPNs ──
  const handleCbomUpload = useCallback(async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (!file) return
    e.target.value = ''
    try {
      const ExcelJS = (await import('exceljs')).default
      const wb = new ExcelJS.Workbook()
      await wb.xlsx.load(await file.arrayBuffer())

      // Find the CBOM sheet (name may have trailing spaces)
      const ws = wb.worksheets.find(s => s.name.trim().toUpperCase().startsWith('CBOM'))
      if (!ws) { alert('No sheet starting with "CBOM" found in this file.'); return }

      const resolveCell = (v: unknown): string | number | null => {
        if (v == null) return null
        if (v instanceof Date) return v.toISOString().slice(0, 10)
        if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean')
          return v as string | number
        if (typeof v === 'object') {
          // formula cell: { formula, result } or { richText }
          const obj = v as Record<string, unknown>
          if ('result' in obj && obj.result != null) return obj.result as string | number
          if ('richText' in obj && Array.isArray(obj.richText))
            return (obj.richText as Array<{ text: string }>).map(rt => rt.text).join('')
          if ('text' in obj) return String(obj.text)
        }
        return String(v)
      }

      let headers: string[] = []
      let mpnColIdx = -1
      const dataRows: Array<(string | number | null)[]> = []

      ws.eachRow((row, _rowNum) => {
        // row.values is 1-indexed; convert to 0-indexed array
        const rawVals = row.values as unknown[]
        const maxCol = rawVals.length - 1
        const rowArr: (string | number | null)[] = Array.from({ length: maxCol }, (_, i) =>
          resolveCell(rawVals[i + 1])
        )

        // Detect header row: any cell contains exactly "Mfg Part Number"
        const hdrIdx = rowArr.findIndex(v => String(v ?? '').trim() === 'Mfg Part Number')
        if (hdrIdx !== -1) {
          if (!headers.length) {
            // First header row — capture column names and MPN column index
            headers = rowArr.map(v => String(v ?? '').trim())
            mpnColIdx = hdrIdx
          }
          return // skip header rows from data collection
        }

        if (mpnColIdx === -1) return // haven't found the header yet
        const mpnVal = String(rowArr[mpnColIdx] ?? '').trim()
        if (!mpnVal) return // skip rows without an MPN

        // Normalize to exactly headers.length columns (pad or trim)
        const normRow: (string | number | null)[] = Array.from(
          { length: headers.length }, (_, k) => (k < rowArr.length ? rowArr[k] : null)
        )
        dataRows.push(normRow)
      })

      if (!headers.length) { alert('No header row with "Mfg Part Number" found in the CBOM sheet.'); return }
      if (!dataRows.length) { alert('No data rows found in the CBOM sheet.'); return }

      // Collect unique MPNs in the order they first appear
      const seen = new Set<string>()
      const uniqueMpns: string[] = []
      for (const row of dataRows) {
        const mpn = String(row[mpnColIdx] ?? '').trim().toUpperCase()
        if (mpn && !seen.has(mpn)) { seen.add(mpn); uniqueMpns.push(mpn) }
      }

      // Extract Part Qty (column index 4 = "Part Qty") to pre-fill quantities
      const partQtyIdx = headers.indexOf('Part Qty')
      const qtys: Record<string, number> = {}
      const defaults: Record<string, 'empty' | '0'> = {}
      for (const row of dataRows) {
        const mpn = String(row[mpnColIdx] ?? '').trim().toUpperCase()
        if (!mpn) continue
        if (partQtyIdx !== -1) {
          const rawQty = row[partQtyIdx]
          const isEmpty = rawQty === null || rawQty === undefined || String(rawQty).trim() === ''
          const parsed = isEmpty ? NaN : Number(rawQty)
          if (isFinite(parsed) && parsed > 0) {
            qtys[mpn] = parsed
          } else {
            qtys[mpn] = 1000
            defaults[mpn] = isEmpty ? 'empty' : '0'
          }
        } else {
          if (!(mpn in qtys)) { qtys[mpn] = 1000; defaults[mpn] = 'empty' }
        }
      }

      setCbomHeaders(headers)
      setCbomRows(dataRows)
      setCbomMpnColIdx(mpnColIdx)
      setCbomFileName(file.name)
      // Clear any previously-loaded simple Excel file and populate the textarea
      setMpnExcelFileName('')
      setMpnComponentQtys(qtys)
      setMpnComponentQtyDefaults(defaults)
      setMultiMpnInput(uniqueMpns.join('\n'))
    } catch (err) {
      alert('Error reading CBOM file: ' + (err instanceof Error ? err.message : String(err)))
    }
  }, [])

  // ── Lytica upload: reads flat Excel, extracts MPN Searched / MPN Matched / Manufacturer Matched / 90th percentile ──
  const handleLyticaUpload = useCallback(async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (!file) return
    e.target.value = ''
    try {
      const ExcelJS = (await import('exceljs')).default
      const wb = new ExcelJS.Workbook()
      await wb.xlsx.load(await file.arrayBuffer())
      const ws = wb.worksheets[0]
      if (!ws) { alert('No sheets found in the Lytica file.'); return }

      // Find header row (first row that contains "MPN Searched")
      let headerRowNum = -1
      let headers: string[] = []
      ws.eachRow({ includeEmpty: false }, (row, rn) => {
        if (headerRowNum !== -1) return
        const vals = row.values as (unknown)[]
        const strs = vals.map(v => String(v ?? '').trim())
        if (strs.some(s => s.toLowerCase() === 'mpn searched')) {
          headerRowNum = rn
          headers = strs.slice(1) // ExcelJS row.values is 1-indexed (index 0 is empty)
        }
      })
      if (headerRowNum === -1) { alert('Could not find "MPN Searched" header in the Lytica file.'); return }

      const normalize = (h: string) => h.toLowerCase().replace(/\s+/g, ' ').trim()
      const mpnSearchedIdx    = headers.findIndex(h => normalize(h) === 'mpn searched')
      const mpnMatchedIdx     = headers.findIndex(h => normalize(h) === 'mpn matched')
      const mfrMatchedIdx     = headers.findIndex(h => normalize(h) === 'manufacturer matched')
      const price90Idx        = headers.findIndex(h => normalize(h) === '90th percentile' || normalize(h) === '90th %tile' || normalize(h).includes('90th'))

      if (mpnSearchedIdx === -1) { alert('Column "MPN Searched" not found in Lytica file.'); return }

      const map: Record<string, { mpnMatched: string; manufacturerMatched: string; price90th: number | null }> = {}
      ws.eachRow({ includeEmpty: false }, (row, rn) => {
        if (rn <= headerRowNum) return
        const vals = (row.values as unknown[]).slice(1)
        const mpnSearched = String(vals[mpnSearchedIdx] ?? '').trim()
        if (!mpnSearched) return
        const mpnMatched  = mpnMatchedIdx >= 0 ? String(vals[mpnMatchedIdx] ?? '').trim() : ''
        const mfrMatched  = mfrMatchedIdx >= 0 ? String(vals[mfrMatchedIdx] ?? '').trim() : ''
        let price90th: number | null = null
        if (price90Idx >= 0) {
          const raw = vals[price90Idx]
          const n = typeof raw === 'number' ? raw : parseFloat(String(raw ?? '').replace(/[$,]/g, ''))
          if (isFinite(n)) price90th = n
        }
        map[mpnSearched.toUpperCase()] = { mpnMatched, manufacturerMatched: mfrMatched, price90th }
      })

      setLyticaMap(map)
      setLyticaFileName(file.name)
    } catch (err) {
      alert('Error reading Lytica file: ' + (err instanceof Error ? err.message : String(err)))
    }
  }, [])

  // ── Multi-MPN: search handler ─────────────────────────────────────────────
  const handleMultiMpnSearch = useCallback(async () => {
    const mpns = multiMpnInput
      .split(/[\n,;]+/)
      .map(s => s.trim().toUpperCase())
      .filter(Boolean)
      .filter((v, i, a) => a.indexOf(v) === i)
    if (!mpns.length) return
    const ctrl = new AbortController()
    abortMpnRef.current = ctrl
    const { signal } = ctrl
    setMultiMpnLoading(true)
    setStopMpnHover(false)
    setMultiMpnRawResults([])
    setMultiMpnSearchedList(mpns)
    setMultiMpnAmplMap({})
    setMpnNexarMap({})
    setMultiMpnSubTab('results')
    setMultiMpnExpandedMpns(new Set())
    setDeepAnalysisRows([])
    abortDeepRef.current?.abort()
    try {
      const iqData = await apiPostWithRetry<{ count: number; data: IQItem[] }>(
        '/api/pricecalc/internal-query', { mpns }, signal
      )
      const rows = Array.isArray(iqData.data) ? iqData.data : []
      setMultiMpnRawResults(rows)

      // For each unique internalPN found in IQ results, fetch AMPL data progressively
      const internalPNs = [...new Set(rows.map(r => r.internalPN).filter(Boolean))]
      if (internalPNs.length > 0 && !signal.aborted) {
        await Promise.allSettled(
          internalPNs.map(async pn => {
            try {
              const amplData = await apiPostWithRetry<AmplResponse>('/api/pricecalc/ampl', { internal_part_number: pn }, signal)
              if (!signal.aborted) {
                setMultiMpnAmplMap(prev => ({ ...prev, [pn]: amplData }))
              }
            } catch { /* non-critical */ }
          })
        )
      }

      // ── Nexar market fetch (all searched MPNs, even those not found in SAP) ──
      if (searchNexar && mpns.length > 0 && !signal.aborted) {
        // Include both the original searched list and any SAP-returned MPN variants
        const uniqueMpns = [...new Set([...mpns, ...rows.map(r => r.mpn).filter(Boolean)])]
        const nexarUpdates: Record<string, { nexarBestUsd: number | null; nexarSeller: string; nexarManufacturer: string; nexarStock: number | null; nexarMoq: number | null; nexarMpn: string }> = {}
        await Promise.allSettled(uniqueMpns.map(async mpn => {
          try {
            const mpnQty = mpnComponentQtys[mpn] ?? qty
            const mkt = await apiPostWithRetry<MarketResponse>('/api/pricecalc/market-prices', { mpns: [mpn], quantity: mpnQty }, signal)
            const eligible = mkt.offers.filter(o => o.inventory > 0 && o.moq <= mpnQty)
            const best = eligible.sort((a, b) => a.unit_price_usd - b.unit_price_usd)[0] ?? null
            if (best) nexarUpdates[mpn] = {
              nexarBestUsd: best.unit_price_usd, nexarSeller: best.seller,
              nexarManufacturer: best.manufacturer, nexarStock: best.inventory,
              nexarMoq: best.moq, nexarMpn: best.mpn,
            }
          } catch { /* non-critical */ }
        }))
        setMpnNexarMap(nexarUpdates)
      }
    } catch (e) {
      const isCancelled = e instanceof DOMException && e.name === 'AbortError'
      if (!isCancelled) setMultiMpnRawResults([])
    }
    setMultiMpnLoading(false)
    setStopMpnHover(false)
  }, [multiMpnInput, searchNexar, qty, mpnComponentQtys])

  const handleDeepAnalysis = useCallback(async (internalPNs: string[]) => {
    if (!internalPNs.length) return
    abortDeepRef.current?.abort()
    const ctrl = new AbortController()
    abortDeepRef.current = ctrl
    const { signal } = ctrl
    setDeepAnalysisLoading(true)
    setDeepAnalysisRows(internalPNs.map(ip => ({
      internalPN: ip, status: 'loading',
      mcBestPriceUsd: null, mcStdPriceUsd: null, mcBestSupplier: '', mcBestPlant: '', mcBestMpn: '', mcBestInternalPN: '', mcLastPoDate: '',
    })))
    setMultiMpnSubTab('deep')
    await Promise.allSettled(internalPNs.map(async ip => {
      try {
        const amplData = await apiPostWithRetry<AmplResponse>('/api/pricecalc/ampl', { internal_part_number: ip }, signal)
        let queryMpns = amplData.mpns_list
        if (!queryMpns.length) {
          queryMpns = [
            ...amplData.blocked.map(i => i.MfgPartNumber),
            ...amplData.deleted.map(i => i.MfgPartNumber),
          ].filter(Boolean).filter((v, i, a) => a.indexOf(v) === i)
        }
        if (!queryMpns.length) {
          setDeepAnalysisRows(prev => prev.map(r => r.internalPN === ip
            ? { ...r, status: 'error', error: 'No MPNs found in SAP' } : r))
          return
        }
        const iqData = await apiPostWithRetry<{ count: number; data: IQItem[] }>(
          '/api/pricecalc/internal-query', { mpns: queryMpns }, signal
        )
        const rows: IQItem[] = Array.isArray(iqData.data) ? iqData.data : []
        const bestRow = buildPlantSummaries(rows, windowDays * 86400000)[0]?.bestRow ?? null
        setDeepAnalysisRows(prev => prev.map(r => r.internalPN === ip ? {
          ...r, status: 'done',
          mcBestPriceUsd:      bestRow ? resolveLastPoPrice(bestRow) : null,
          mcStdPriceUsd:       bestRow?.standardPriceUsd ?? null,
          mcBestSupplier:      bestRow?.supplierName || bestRow?.englishName || '—',
          mcBestPlant:         bestRow?.siteName || '—',
          mcBestMpn:           bestRow?.mpn || '—',
          mcBestInternalPN:    bestRow?.internalPN || '—',
          mcLastPoDate:        bestRow?.lastPoDate || '—',
        } : r))
      } catch (e) {
        const isCancelled = e instanceof DOMException && e.name === 'AbortError'
        setDeepAnalysisRows(prev => prev.map(r => r.internalPN === ip ? {
          ...r, status: 'error',
          error: isCancelled ? 'Cancelled' : e instanceof Error ? e.message : String(e),
        } : r))
      }
    }))
    setDeepAnalysisLoading(false)
  }, [windowDays])

  const handleMcDeepAnalysis = useCallback(async () => {
    const doneBmats = multiResults.filter(r => r.status === 'done')
    if (!doneBmats.length) return
    abortMcDeepRef.current?.abort()
    const ctrl = new AbortController()
    abortMcDeepRef.current = ctrl
    const { signal } = ctrl
    setMcDeepLoading(true)
    setMcDeepRows(doneBmats.map(r => ({
      bmatn: r.bmatn,
      mcInternalPN: r.internalPN ?? '',
      mcPrice: r.bestPriceUsd ?? null,
      mcSupplier: r.bestSupplier ?? '',
      mcPlant: r.bestPlant ?? '',
      mcMpn: r.mpn ?? '',
      mcLastPoDate: r.lastPoDate ?? '',
      mcStdPriceUsd: r.stdPriceUsd ?? null,
      mpnStatus: 'loading' as const,
      mpnBestPriceUsd: null,
      mpnBestStdPriceUsd: null,
      mpnBestSupplier: '', mpnBestPlant: '', mpnBestMpn: '', mpnBestInternalPN: '', mpnLastPoDate: '',
    })))
    setMultiSubTab('deep')
    await Promise.allSettled(doneBmats.map(async r => {
      const bmatn = r.bmatn
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
          setMcDeepRows(prev => prev.map(dr => dr.bmatn === bmatn
            ? { ...dr, mpnStatus: 'error', mpnError: 'No MPNs found in SAP' } : dr))
          return
        }
        const iqData = await apiPostWithRetry<{ count: number; data: IQItem[] }>(
          '/api/pricecalc/internal-query', { mpns: queryMpns }, signal)
        const rows: IQItem[] = Array.isArray(iqData.data) ? iqData.data : []
        const bestRow = pickBestRowByMpn(rows, windowDays * 86400000)
        setMcDeepRows(prev => prev.map(dr => dr.bmatn === bmatn ? {
          ...dr, mpnStatus: 'done',
          mpnBestPriceUsd:      bestRow ? resolveLastPoPrice(bestRow) : null,
          mpnBestStdPriceUsd:  bestRow?.standardPriceUsd ?? null,
          mpnBestSupplier:   bestRow?.supplierName || bestRow?.englishName || '—',
          mpnBestPlant:      bestRow?.siteName || '—',
          mpnBestMpn:        bestRow?.mpn || '—',
          mpnBestInternalPN: bestRow?.internalPN || '—',
          mpnLastPoDate:     bestRow?.lastPoDate || '—',
        } : dr))
      } catch (e) {
        const isCancelled = e instanceof DOMException && e.name === 'AbortError'
        setMcDeepRows(prev => prev.map(dr => dr.bmatn === bmatn ? {
          ...dr, mpnStatus: 'error',
          mpnError: isCancelled ? 'Cancelled' : e instanceof Error ? e.message : String(e),
        } : dr))
      }
    }))
    setMcDeepLoading(false)
  }, [multiResults, windowDays])

  const downloadResultsExcel = useCallback(
    () => downloadResultsExcelFile(multiResults, myPlant, qty, `PPV_Results_${new Date().toISOString().slice(0, 10)}.xlsx`),
    [multiResults, myPlant, qty]
  )

  // Derived state
  const isLoading = status === 'loading-ampl' || status === 'loading-iq' || status === 'loading-market'
  const bestPlant = plants[0]
  // globalBest = cheapest-within-45-day-window row for the best plant
  const globalBest = bestPlant?.bestRow ?? null
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
    return [...groups.values()].map(g => ({ ...g, plants: buildPlantSummaries(g.rows, windowDays * 86400000) }))
  }, [blockedIqRows, blockedMpnMap, windowDays])

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
          {showComparison ? ' Comparison Analysis' : showMarketOffer ? '’ Market Offer' : ' Cost Estimate'}
        </h3>
        <button onClick={() => { setSelectedPlant(null); setSelectedOffer(null) }}
          className="text-blue-200 hover:text-white p-1 rounded transition-colors">
          <X size={14} />
        </button>
      </div>

      {/* ── Comparison mode ─────────────────────────────────────────── */}
      {showComparison && pinnedPlant && selectedPlant && (
        <div className="p-4 space-y-3 text-sm">

          {/*  Hero — verdict first */}
          <div className={`rounded-xl p-4 text-center ${
            compAbsDiff == null ? 'bg-blue-600'
              : compAbsDiff > 0 ? 'bg-emerald-600'   // ref cheaper ’ alt more expensive
              : compAbsDiff < 0 ? 'bg-red-600'        // alt cheaper
              : 'bg-blue-600'
          }`}>
            <p className="text-white/70 text-[11px] uppercase tracking-widest mb-1">
              {selectedPlant.siteName} vs. {pinnedPlant.siteName} 
            </p>
            <p className="text-4xl font-black text-white tabular-nums leading-none">
              {compPctDiff != null ? `${compPctDiff > 0 ? '+' : ''}${compPctDiff.toFixed(1)}%` : '—'}
            </p>
            <p className="text-white font-semibold mt-1.5">
              {compAbsDiff == null ? '—'
                : compAbsDiff > 0 ? ' Reference is cheaper'
                : compAbsDiff < 0 ? '” Alt plant is cheaper'
                : ' Same price'}
            </p>
            <p className="text-white/60 text-xs mt-0.5">
              {compAbsDiff != null
                ? `${compAbsDiff >= 0 ? '+' : ''}${fmt6(compAbsDiff)} / unit`
                : 'No price data'}
            </p>
          </div>

          {/*  Unit price — two columns with divider */}
          <div className="bg-blue-800/80 rounded-xl p-3 space-y-2">
            <div className="flex items-stretch gap-3">
              <div className="flex-1 min-w-0">
                <p className="text-blue-300 text-[11px] uppercase tracking-wide mb-1 truncate">
                   {pinnedPlant.siteName}
                </p>
                <p className="text-white font-bold text-base font-mono leading-tight truncate">
                  {fmt6(pinnedPlant.bestPrice)}
                </p>
              </div>
              <div className="w-px bg-blue-600 self-stretch shrink-0" />
              <div className="flex-1 min-w-0 text-right">
                <p className="text-blue-300 text-[11px] uppercase tracking-wide mb-1 truncate">
                  ” {selectedPlant.siteName}
                </p>
                <p className="text-white font-bold text-base font-mono leading-tight truncate">
                  {fmt6(selectedPlant.bestPrice)}
                </p>
              </div>
            </div>
          </div>

          {/*  Totals at qty pcs */}
          <div className="bg-blue-800/80 rounded-xl p-3 space-y-2">
            <p className="text-blue-300 text-[11px] uppercase tracking-wide mb-1">At {qty.toLocaleString()} pcs</p>
            <div className="flex justify-between text-xs">
              <span className="text-blue-300"> {pinnedPlant.siteName}</span>
              <span className="font-mono font-semibold">{fmt2(compTotalRef)}</span>
            </div>
            <div className="flex justify-between text-xs">
              <span className="text-blue-300">” {selectedPlant.siteName}</span>
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

          {/*  Supplier details side by side */}
          <div className="grid grid-cols-2 gap-2">
            <div className="bg-blue-600/50 rounded-xl p-2.5 space-y-1">
              <p className="text-blue-300 text-[10px] uppercase tracking-wide"> {pinnedPlant.siteName}</p>
              <p className="text-white text-xs font-semibold leading-snug truncate">{pinnedPlant.bestSupplier}</p>
              <p className="text-blue-300 text-[10px]">{pinnedPlant.lastPoDate}</p>
            </div>
            <div className="bg-blue-600/50 rounded-xl p-2.5 space-y-1">
              <p className="text-blue-300 text-[10px] uppercase tracking-wide">” {selectedPlant.siteName}</p>
              <p className="text-white text-xs font-semibold leading-snug truncate">{selectedPlant.bestSupplier}</p>
              <p className="text-blue-300 text-[10px]">{selectedPlant.lastPoDate}</p>
            </div>
          </div>

        </div>
      )}

      {/* ── Invoice mode ────────────────────────────────────────────── */}
      {showInvoice && selectedPlant && invBestRow && (
        <div className="p-4 space-y-3 text-sm">

          {/*  Hero — total cost prominent, verdict on delta */}
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
                  {invDelta! > 0 ? ' Above standard' : invDelta! < 0 ? ' Below standard' : ' At standard'}
                </p>
                <p className="text-white/60 text-xs mt-0.5">
                  {invDelta! >= 0 ? '+' : ''}{invDeltaPct.toFixed(1)}% · {invDelta! >= 0 ? '+' : ''}{fmt2(invDelta)} vs Std
                </p>
              </>
            ) : (
              <p className="text-white/60 text-xs mt-1.5">No standard price to compare</p>
            )}
          </div>

          {/*  Unit price breakdown — two columns with divider */}
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

          {/*  Supplier & plant */}
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

          {/*  Component info */}
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

          {/*  Verdict — first thing the eye sees */}
          {mktOfferPctDiff != null ? (
            <div className={`rounded-xl p-4 text-center ${mktOfferDiff! < 0 ? 'bg-emerald-600' : mktOfferDiff! > 0 ? 'bg-red-600' : 'bg-blue-600'}`}>
              <p className="text-white/70 text-[11px] uppercase tracking-widest mb-1">
                Market vs. {pinnedPlant ? `${pinnedPlant.siteName} ` : 'best PO'}
              </p>
              <p className="text-4xl font-black text-white tabular-nums leading-none">
                {mktOfferPctDiff >= 0 ? '+' : ''}{mktOfferPctDiff.toFixed(1)}%
              </p>
              <p className="text-white font-semibold mt-1.5">
                {mktOfferDiff! < 0 ? ' Market is cheaper' : mktOfferDiff! > 0 ? ' Market is pricier' : ' Same price'}
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

          {/*  Price breakdown */}
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
                <span className="text-blue-300">{pinnedPlant ? `${pinnedPlant.siteName} ` : 'Global best (EMS)'}</span>
                <span className="font-mono text-blue-100">{fmt6(refPrice)}</span>
              </div>
            )}
          </div>

          {/*  Stock & availability */}
          <div className="bg-blue-600/50 rounded-xl p-3 space-y-1.5">
            <div className="flex items-center justify-between">
              <p className="text-blue-200 text-[11px] uppercase tracking-wide">Availability</p>
              <span className={`text-xs font-semibold px-2 py-0.5 rounded-full ${selectedOffer.can_fulfill ? 'bg-emerald-500 text-white' : 'bg-amber-400 text-white'}`}>
                {selectedOffer.can_fulfill ? ' Can Fulfill' : '  MOQ Issue'}
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

          {/*  Seller & part info */}
          <div className="bg-blue-600/50 rounded-xl p-3 space-y-1">
            <p className="font-bold text-base leading-tight">{selectedOffer.seller}</p>
            <p className="text-blue-200 text-xs">{selectedOffer.manufacturer}</p>
            <p className="font-mono text-xs text-blue-100 mt-1">MPN: {selectedOffer.mpn}</p>
            <p className="text-blue-300 text-xs">Packaging: {selectedOffer.packaging || '—'}</p>
            {selectedOffer.description && <p className="text-blue-300 text-xs leading-snug mt-0.5">{selectedOffer.description}</p>}
          </div>

          {/*  CTA */}
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
      {/* ── Floating Action Button (widget mode only) ─────────────────────── */}
      {mode !== 'page' && (
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
      )}

      {/* ── Drawer / Page ────────────────────────────────────────────────── */}
      {(mode === 'page' || open) && (
        <div className={mode !== 'page' ? 'fixed inset-0 z-50 flex' : undefined} onClick={mode !== 'page' ? () => setOpen(false) : undefined}>
          {/* Backdrop (widget mode only) */}
          {mode !== 'page' && <div className="flex-1 bg-black/40" />}

          {/* Side panel (widget mode only) */}
          {mode !== 'page' && sidePanelEl}

          {/* Panel */}
          <div
            className={mode !== 'page' ? 'w-full bg-white shadow-2xl overflow-y-auto flex flex-col animate-slideInRight' : 'min-h-screen bg-white flex flex-col'}
            onClick={mode !== 'page' ? e => e.stopPropagation() : undefined}
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
              {mode !== 'page' && (
                <button onClick={() => setOpen(false)} className="text-gray-400 hover:text-gray-700 p-1.5 rounded-lg hover:bg-gray-100">
                  <X size={18} />
                </button>
              )}
            </div>

            {/* Tabs */}
            <div className="px-6 pt-3 pb-0 flex-shrink-0 border-b border-gray-100">
              <div className="flex gap-1 bg-gray-100 rounded-xl p-1 w-fit">
                <button
                  onClick={() => setActiveTab('single')}
                  className={`px-4 py-1.5 text-sm font-medium rounded-lg transition-colors ${activeTab === 'single' ? 'bg-white text-blue-600 shadow-sm' : 'text-gray-500 hover:text-gray-700'}`}
                >
                  Single
                </button>
                <button
                  onClick={() => setActiveTab('multi')}
                  className={`px-4 py-1.5 text-sm font-medium rounded-lg transition-colors ${activeTab === 'multi' ? 'bg-white text-blue-600 shadow-sm' : 'text-gray-500 hover:text-gray-700'}`}
                >
                  Multi-Component
                </button>
                <button
                  onClick={() => setActiveTab('mpn')}
                  className={`px-4 py-1.5 text-sm font-medium rounded-lg transition-colors ${activeTab === 'mpn' ? 'bg-white text-blue-600 shadow-sm' : 'text-gray-500 hover:text-gray-700'}`}
                >
                  Multi-MPN
                </button>
              </div>
            </div>

            <div className="flex-1 p-6 space-y-6">
              {/* •••••••••••••• SINGLE TAB •••••••••••••• */}
              {activeTab === 'single' && (<>
              <div className="bg-gray-50 rounded-xl border border-gray-200 p-5">
                <div className="flex gap-4 mb-4">
                  <div className="flex-1">
                    <div className="flex items-center justify-between mb-1.5">
                      <label className="text-sm font-medium text-gray-600">
                        {searchMode === 'internal' ? 'Internal Part Number' : 'MPN'}
                      </label>
                      <div className="flex text-xs rounded-lg overflow-hidden border border-gray-200">
                        <button
                          type="button"
                          onClick={() => setSearchMode('internal')}
                          className={`px-2.5 py-1 font-medium transition-colors ${searchMode === 'internal' ? 'bg-blue-600 text-white' : 'bg-white text-gray-500 hover:bg-gray-50'}`}
                        >Internal PN</button>
                        <button
                          type="button"
                          onClick={() => setSearchMode('mpn')}
                          className={`px-2.5 py-1 font-medium border-l border-gray-200 transition-colors ${searchMode === 'mpn' ? 'bg-blue-600 text-white' : 'bg-white text-gray-500 hover:bg-gray-50'}`}
                        >MPN</button>
                      </div>
                    </div>
                    <input
                      type="text" placeholder={searchMode === 'internal' ? 'e.g. EC03018' : 'e.g. TPS62130DSGR'}
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
                  <div className="w-28">
                    <label className="block text-sm font-medium text-gray-600 mb-1.5">Window (days)</label>
                    <input
                      type="number" min={1} max={365} step={1} value={windowDays}
                      onChange={e => setWindowDays(Math.max(1, Math.min(365, parseInt(e.target.value) || 45)))}
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
                    <span className="font-medium">  AMPL response (blocked/deleted MPNs)</span>
                    <button
                      onClick={() => setShowAmplJson(v => !v)}
                      className="text-amber-700 hover:text-amber-900 font-mono font-bold border border-amber-300 rounded px-1.5 py-0.5 bg-amber-100 hover:bg-amber-200 transition-colors"
                    >
                      {showAmplJson ? ' Ocultar' : ' Ver JSON'}
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
              {status === 'done' && (ampl || searchMode === 'mpn') && (
                <>
                  {/* Component header */}
                  <div className="flex items-center gap-3 flex-wrap">
                    <h3 className="text-lg font-bold text-gray-800">{ampl ? ampl.internal_part_number : bmatn.toUpperCase()}</h3>
                    <span className="text-sm text-gray-500 bg-gray-100 px-3 py-1 rounded-full">
                      {iqRows[0]?.materialDescription}
                    </span>
                    {ampl && (
                      <div className="flex gap-2 text-xs">
                        <span className="bg-emerald-100 text-emerald-700 px-2 py-1 rounded-full font-medium">
                           {ampl.total_active} active MPNs
                        </span>
                        {ampl.total_blocked > 0 && (
                          <span className="bg-amber-100 text-amber-700 px-2 py-1 rounded-full font-medium">
                             {ampl.total_blocked} blocked
                          </span>
                        )}
                        {ampl.total_deleted > 0 && (
                          <span className="bg-red-100 text-red-700 px-2 py-1 rounded-full font-medium">
                             {ampl.total_deleted} deleted
                          </span>
                        )}
                      </div>
                    )}
                  </div>

                  {/* Fallback warning */}
                  {usedFallback && ampl && (
                    <div className="bg-amber-50 border border-amber-200 rounded-lg text-xs text-amber-800">
                      <div className="flex items-start gap-2 px-3 py-2">
                        <span className="text-base leading-none"> </span>
                        <span className="flex-1">No active MPNs found — showing results based on <strong>blocked/deleted</strong> MPNs. Pricing data may be outdated.</span>
                        <button
                          onClick={() => setShowAmplJson(v => !v)}
                          className="ml-2 text-amber-700 hover:text-amber-900 font-mono font-bold border border-amber-300 rounded px-1.5 py-0.5 bg-amber-100 hover:bg-amber-200 transition-colors whitespace-nowrap"
                        >
                          {showAmplJson ? ' Hide JSON' : ' Ver JSON'}
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
                      <p><strong>No purchase history found{ampl ? ' for the active MPNs' : ''}.</strong></p>
                      {ampl
                        ? <p className="text-xs text-yellow-700">The active MPNs ({ampl.mpns_list.join(', ')}) exist in SAP but the IQ system has no purchase order records for them. This may happen if the component was recently approved or has never been purchased under these MPNs.</p>
                        : <p className="text-xs text-yellow-700">The MPN {bmatn.toUpperCase()} has no purchase order records in the IQ system.</p>
                      }
                    </div>
                  )}

                  {/* KPI cards + Plant Summary + Detail — only when SAP data exists */}
                  {globalBest && (
                    <>
                      {/* KPI cards */}
                      <div className="grid grid-cols-3 gap-4">
                        <StatCard icon="" label="Best Plant" value={bestPlant?.siteName ?? '—'} highlight />
                        <StatCard icon="" label="Best Supplier" value={globalBest.supplierName} sub={`#${globalBest.supplierNumber}`} />
                        <StatCard icon="" label="Best Price (USD)" value={fmt6(resolveLastPoPrice(globalBest))} sub={`Last PO: ${globalBest.lastPoDate}`} />
                      </div>

                      {/* Plant Summary */}
                      <div>
                        <div className="flex items-center justify-between mb-2">
                          <h4 className="text-sm font-semibold text-gray-700">Plant Summary</h4>
                          <p className="text-xs text-gray-400">Click  to pin · click row for invoice or comparison</p>
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
                            <div className="mt-3 space-y-3">
                              {blockedGroups.map(group => {
                                const label = BLOCK_REASONS[group.code] ?? (group.code ? group.code : 'Unknown reason')
                                const isDanger = group.code === 'F' || group.code === 'ER'
                                return (
                                  <div key={group.code || '__none__'} className="rounded-xl border border-orange-200 overflow-hidden">
                                    <div className={`flex items-center gap-2 px-3 py-2 ${isDanger ? 'bg-red-50 border-b border-red-200' : 'bg-amber-50 border-b border-amber-200'}`}>
                                      {group.code && (
                                        <span className={`text-[10px] font-bold px-1.5 py-0.5 rounded ${isDanger ? 'bg-red-100 text-red-700' : 'bg-amber-100 text-amber-700'}`}>
                                          {group.code}
                                        </span>
                                      )}
                                      <span className={`text-xs font-medium ${isDanger ? 'text-red-700' : 'text-amber-700'}`}>{label}</span>
                                      <span className="text-xs text-gray-400 ml-auto">{group.rows.length} record{group.rows.length > 1 ? 's' : ''}</span>
                                    </div>
                                    <div className="p-2 bg-white">
                                      <DetailTable rows={group.rows} variant="orange" mpnInfoMap={blockedMpnMap} />
                                    </div>
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
                            <p className="text-[10px] text-gray-400">{refLabel}{pinnedPlant ? ' ' : ' · best PO'}</p>
                          </div>
                        )}
                      </div>
                      {/* 3 stat cards */}
                      <div className="grid grid-cols-3 gap-3">
                        <div className="bg-white rounded-xl border border-gray-200 p-3">
                          <p className="text-xs text-gray-400 mb-1"> Best Market Price</p>
                          <p className="text-sm font-bold text-blue-700 font-mono">{displayBest ? fmt6(displayBest.unit_price_usd) : '—'}</p>
                          <p className="text-xs text-gray-500 truncate mt-0.5">{displayBest?.seller ?? 'No offers'}</p>
                        </div>
                        <div className="bg-white rounded-xl border border-gray-200 p-3">
                          <p className="text-xs text-gray-400 mb-1"> Internal Reference</p>
                          <p className="text-sm font-bold text-gray-800 font-mono">{fmt6(refPrice)}</p>
                          <p className="text-xs text-gray-500 mt-0.5">{refLabel}{pinnedPlant ? ' ' : ' · best PO'}</p>
                        </div>
                        <div className="bg-white rounded-xl border border-gray-200 p-3">
                          <p className="text-xs text-gray-400 mb-1"> In Stock</p>
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

              {/* •••••••••••••• MULTI TAB •••••••••••••• */}
              {activeTab === 'multi' && (
                <div className="space-y-6">

                  {/* Multi search form */}
                  <div className="bg-gray-50 rounded-xl border border-gray-200 p-5">
                    <div className="flex gap-4 mb-4">
                      <div className="flex-1">
                        <div className="flex items-center justify-between mb-1.5">
                        <label className="block text-sm font-medium text-gray-600">
                            Internal Part Numbers
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
                            placeholder={"CCR00292\nEC03018\n40012"}
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
                          <option value="">- None -</option>
                          <option value="KEMX">KEMX</option>
                          <option value="KEJ">KEJ</option>
                          <option value="KECN">KECN</option>
                          <option value="KETL">KETL</option>
                          <option value="KEPS">KEPS</option>
                          <option value="KERO">KERO</option>
                        </select>
                      </div>
                      <div className="w-28">
                        <label className="block text-sm font-medium text-gray-600 mb-1.5">Window (days)</label>
                        <input
                          type="number" min={1} max={365} step={1} value={windowDays}
                          onChange={e => setWindowDays(Math.max(1, Math.min(365, parseInt(e.target.value) || 45)))}
                          className="w-full rounded-lg border border-gray-300 px-4 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
                        />
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
                          <span className="invisible select-none" aria-hidden>Searching...</span>
                          <span className="absolute inset-0 flex items-center justify-center">
                            {multiLoading && stopHover ? 'Stop' : multiLoading ? 'Searching' : 'Search All'}
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
                             Results ({multiResults.filter(r => r.status === 'done').length})
                          </button>
                          <button
                            onClick={() => setMultiSubTab('allrecords')}
                            className={`px-3 py-1.5 text-xs font-medium rounded-lg transition-colors ${multiSubTab === 'allrecords' ? 'bg-white text-purple-600 shadow-sm' : 'text-gray-500 hover:text-gray-700'}`}
                          >
                             All Records ({Object.values(multiIqRowsMap).reduce((s, rows) => s + rows.length, 0)})
                          </button>
                          <button
                            onClick={() => setMultiSubTab('blocked')}
                            className={`px-3 py-1.5 text-xs font-medium rounded-lg transition-colors ${multiSubTab === 'blocked' ? 'bg-white text-red-600 shadow-sm' : 'text-gray-500 hover:text-gray-700'}`}
                          >
                             Blocked / Deleted ({multiResults.reduce((s, r) => s + (r.totalBlocked ?? 0) + (r.totalDeleted ?? 0), 0)})
                          </button>
                          <button
                            onClick={() => setMultiSubTab('deep')}
                            className={`px-3 py-1.5 text-xs font-medium rounded-lg transition-colors ${multiSubTab === 'deep' ? 'bg-white text-indigo-600 shadow-sm' : 'text-gray-500 hover:text-gray-700'}`}
                          >
                             Deep Analysis{mcDeepRows.length > 0 ? ` (${mcDeepRows.length})` : ''}
                          </button>
                        </div>
                        {(multiLoading || mcDeepLoading) && (
                          <div className="flex items-center gap-1.5 text-xs text-blue-600">
                            <svg className="animate-spin h-3 w-3" fill="none" viewBox="0 0 24 24">
                              <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                              <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8H4z" />
                            </svg>
                            Querying…
                          </div>
                        )}
                        {!multiLoading && !mcDeepLoading && multiResults.some(r => r.status === 'done') && (
                          <div className="ml-auto flex items-center gap-2">
                            <button
                              onClick={handleMcDeepAnalysis}
                              className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-indigo-700 bg-indigo-50 hover:bg-indigo-100 border border-indigo-200 rounded-lg transition-colors whitespace-nowrap"
                            >
                              <svg className="h-3.5 w-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 19v-6a2 2 0 00-2-2H5a2 2 0 00-2 2v6a2 2 0 002 2h2a2 2 0 002-2zm0 0V9a2 2 0 012-2h2a2 2 0 012 2v10m-6 0a2 2 0 002 2h2a2 2 0 002-2m0 0V5a2 2 0 012-2h2a2 2 0 012 2v14a2 2 0 01-2 2h-2a2 2 0 01-2-2z" /></svg>
                              Deep Analysis
                            </button>
                            {multiSubTab === 'results' && (
                              <button
                                onClick={downloadResultsExcel}
                                className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-emerald-700 bg-emerald-50 hover:bg-emerald-100 border border-emerald-200 rounded-lg transition-colors whitespace-nowrap"
                              >
                                <Download className="h-3.5 w-3.5" />
                                Export Excel
                              </button>
                            )}
                          </div>
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
                            {[...multiResults]
                              .filter(r => r.status === 'done' && typeof r.bestPriceUsd === 'number')
                              .sort((a, b) => (a.bestPriceUsd ?? 0) - (b.bestPriceUsd ?? 0))
                              .concat(multiResults.filter(r => !(r.status === 'done' && typeof r.bestPriceUsd === 'number')))
                              .map(r => (
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
                                  {r.status === 'done'  && <span className="text-emerald-500 font-bold"></span>}
                                  {r.status === 'error' && <span className="text-red-500 font-bold"></span>}
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

                      {/* ── All Records sub-tab ── */}
                      {multiSubTab === 'allrecords' && !multiLoading && (
                        Object.keys(multiIqRowsMap).length > 0 ? (
                          <div className="rounded-xl border border-gray-200 overflow-hidden shadow-sm">
                            {multiResults.filter(r => r.status === 'done').map((mr, idx) => {
                              const rows = [...(multiIqRowsMap[mr.bmatn] ?? [])].sort(
                                (a, b) => new Date(b.lastPoDate || 0).getTime() - new Date(a.lastPoDate || 0).getTime()
                              )
                              if (!rows.length) return null
                              const isOpen = multiExpandedBmats.has(mr.bmatn)
                              const toggle = () => setMultiExpandedBmats(prev => {
                                const s = new Set(prev)
                                isOpen ? s.delete(mr.bmatn) : s.add(mr.bmatn)
                                return s
                              })
                              return (
                                <div key={mr.bmatn} className={idx > 0 ? 'border-t border-gray-200' : ''}>
                                  <button onClick={toggle} className="w-full flex items-center gap-3 px-4 py-3 text-left hover:bg-gray-50 transition-colors">
                                    <svg className={`h-3.5 w-3.5 text-gray-400 flex-shrink-0 transition-transform ${isOpen ? 'rotate-90' : ''}`} fill="none" viewBox="0 0 24 24">
                                      <path stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" d="M9 6l6 6-6 6" />
                                    </svg>
                                    <span className="font-mono font-semibold text-sm text-gray-800">{mr.bmatn}</span>
                                    <span className="text-xs text-gray-400 ml-1">{rows.length} record{rows.length !== 1 ? 's' : ''}</span>
                                  </button>
                                  {isOpen && (
                                    <div className="overflow-x-auto border-t border-gray-100">
                                      <table className="min-w-max w-full text-xs border-collapse">
                                        <thead className="bg-gray-50 text-[10px] uppercase tracking-wide text-gray-500">
                                          <tr>
                                            <th className="px-3 py-2.5 text-left whitespace-nowrap border-b border-gray-200">MPN</th>
                                            <th className="px-3 py-2.5 text-left whitespace-nowrap border-b border-gray-200">Internal PN</th>
                                            <th className="px-3 py-2.5 text-left whitespace-nowrap border-b border-gray-200">Plant</th>
                                            <th className="px-3 py-2.5 text-left whitespace-nowrap border-b border-gray-200">Supplier</th>
                                            <th className="px-3 py-2.5 text-left whitespace-nowrap border-b border-gray-200">Description</th>
                                            <th className="px-3 py-2.5 text-right whitespace-nowrap border-b border-gray-200">Qty</th>
                                            <th className="px-3 py-2.5 text-center whitespace-nowrap border-b border-gray-200">Cur</th>
                                            <th className="px-3 py-2.5 text-right whitespace-nowrap border-b border-gray-200">Last PO (Local)</th>
                                            <th className="px-3 py-2.5 text-right whitespace-nowrap border-b border-gray-200">Std (Local)</th>
                                            <th className="px-3 py-2.5 text-right whitespace-nowrap border-b border-gray-200">Last PO (USD)</th>
                                            <th className="px-3 py-2.5 text-right whitespace-nowrap border-b border-gray-200">Std (USD)</th>
                                            <th className="px-3 py-2.5 text-left whitespace-nowrap border-b border-gray-200">Date</th>
                                          </tr>
                                        </thead>
                                        <tbody className="divide-y divide-gray-100">
                                          {rows.map((row, i) => (
                                            <tr key={i} className="hover:bg-gray-50">
                                              <td className="px-3 py-2 font-mono text-gray-700 whitespace-nowrap">{row.mpn}</td>
                                              <td className="px-3 py-2 font-mono font-semibold text-blue-700 whitespace-nowrap">{row.internalPN}</td>
                                              <td className="px-3 py-2 whitespace-nowrap text-gray-700">{row.siteName}</td>
                                              <td className="px-3 py-2 text-gray-600 max-w-[160px] truncate" title={row.supplierName || row.englishName || ''}>{row.supplierName || row.englishName || '—'}</td>
                                              <td className="px-3 py-2 text-gray-500 max-w-[200px] truncate" title={row.materialDescription}>{row.materialDescription || '—'}</td>
                                              <td className="px-3 py-2 text-right font-mono text-gray-700 whitespace-nowrap">{row.quantity?.toLocaleString() ?? '—'}</td>
                                              <td className="px-3 py-2 text-center font-mono text-gray-500 whitespace-nowrap">{row.localCurrency || '—'}</td>
                                              <td className="px-3 py-2 text-right font-mono text-gray-700 whitespace-nowrap">{resolvePoLocal(row) != null ? resolvePoLocal(row)!.toLocaleString('en-US', { minimumFractionDigits: 4 }) : '—'}</td>
                                              <td className="px-3 py-2 text-right font-mono text-gray-500 whitespace-nowrap">{resolveStdLocal(row) != null ? resolveStdLocal(row)!.toLocaleString('en-US', { minimumFractionDigits: 4 }) : '—'}</td>
                                              <td className="px-3 py-2 text-right font-mono font-semibold text-blue-700 whitespace-nowrap">{fmt6(resolveLastPoPrice(row))}</td>
                                              <td className="px-3 py-2 text-right font-mono text-gray-500 whitespace-nowrap">{fmt6(row.standardPriceUsd)}</td>
                                              <td className="px-3 py-2 text-gray-500 whitespace-nowrap">{row.lastPoDate || '—'}</td>
                                            </tr>
                                          ))}
                                        </tbody>
                                      </table>
                                    </div>
                                  )}
                                </div>
                              )
                            })}
                          </div>
                        ) : (
                          <p className="text-sm text-gray-400 py-8 text-center">No raw records available. Run a search first.</p>
                        )
                      )}

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
                                    {group.kind === 'blocked' ? ' BLOCKED' : ' DELETED'}
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

                      {/* ── Deep Analysis sub-tab ── */}
                      {multiSubTab === 'deep' && (
                        <div>
                          {mcDeepRows.length === 0 ? (
                            <p className="text-sm text-gray-400 py-8 text-center">Click "Deep Analysis" to compare component prices with Multi-MPN best prices.</p>
                          ) : (
                            <div>
                              <div className="flex items-center justify-between mb-3">
                                <p className="text-[10px] text-gray-400">Comparison of Multi-Component ({windowDays}-day window best) vs Multi-MPN (AMPL active MPNs best) prices per BMATN</p>
                                <button
                                  onClick={() => downloadMcDeepExcelFile(
                                    mcDeepRows,
                                    componentQtys,
                                    qty,
                                    `PPV_MC_DeepAnalysis_${new Date().toISOString().slice(0, 10)}.xlsx`,
                                  )}
                                  className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-emerald-700 bg-emerald-50 hover:bg-emerald-100 border border-emerald-200 rounded-lg transition-colors whitespace-nowrap"
                                >
                                  <svg className="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="2">
                                    <path strokeLinecap="round" strokeLinejoin="round" d="M12 10v6m0 0l-3-3m3 3l3-3m2 4H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
                                  </svg>
                                  Export Excel
                                </button>
                              </div>
                              <div className="overflow-x-auto rounded-xl border border-gray-200 shadow-sm">
                                <table className="min-w-max w-full text-xs border-collapse">
                                  <thead className="bg-gray-50 text-[10px] uppercase tracking-wide text-gray-500">
                                    <tr>
                                      <th className="px-3 py-2.5 text-left border-b border-gray-200 whitespace-nowrap" rowSpan={2}>BMATN</th>
                                      <th className="px-3 py-2.5 text-center border-b border-gray-200 border-l border-l-purple-200 whitespace-nowrap bg-purple-50/50" colSpan={7}>Multi-Component</th>
                                      <th className="px-3 py-2.5 text-center border-b border-gray-200 border-l border-l-blue-200 whitespace-nowrap bg-blue-50/50" colSpan={7}>Multi-MPN</th>
                                      <th className="px-3 py-2.5 text-center border-b border-gray-200 border-l border-l-gray-300 whitespace-nowrap" rowSpan={2}>QTY Inserted</th>
                                      <th className="px-3 py-2.5 text-center border-b border-gray-200 border-l border-l-gray-300 whitespace-nowrap" rowSpan={2}>Total (USD) per QTY</th>
                                      <th className="px-3 py-2.5 text-center border-b border-gray-200 border-l border-l-gray-300 whitespace-nowrap" rowSpan={2}>Winner</th>
                                    </tr>
                                    <tr>
                                      <th className="px-3 py-2 text-left border-b border-gray-200 border-l border-l-purple-200 whitespace-nowrap bg-purple-50/30">Internal PN</th>
                                      <th className="px-3 py-2 text-left border-b border-gray-200 whitespace-nowrap bg-purple-50/30">MPN</th>
                                      <th className="px-3 py-2 text-left border-b border-gray-200 whitespace-nowrap bg-purple-50/30">Plant</th>
                                      <th className="px-3 py-2 text-left border-b border-gray-200 whitespace-nowrap bg-purple-50/30">Supplier</th>
                                      <th className="px-3 py-2 text-right border-b border-gray-200 whitespace-nowrap bg-purple-50/30">Last PO (USD)</th>
                                      <th className="px-3 py-2 text-right border-b border-gray-200 whitespace-nowrap bg-purple-50/30">Std (USD)</th>
                                      <th className="px-3 py-2 text-left border-b border-gray-200 whitespace-nowrap bg-purple-50/30">Date</th>
                                      <th className="px-3 py-2 text-left border-b border-gray-200 border-l border-l-blue-200 whitespace-nowrap bg-blue-50/30">Internal PN</th>
                                      <th className="px-3 py-2 text-left border-b border-gray-200 whitespace-nowrap bg-blue-50/30">MPN</th>
                                      <th className="px-3 py-2 text-left border-b border-gray-200 whitespace-nowrap bg-blue-50/30">Plant</th>
                                      <th className="px-3 py-2 text-left border-b border-gray-200 whitespace-nowrap bg-blue-50/30">Supplier</th>
                                      <th className="px-3 py-2 text-right border-b border-gray-200 whitespace-nowrap bg-blue-50/30">Last PO (USD)</th>
                                      <th className="px-3 py-2 text-right border-b border-gray-200 whitespace-nowrap bg-blue-50/30">Std (USD)</th>
                                      <th className="px-3 py-2 text-left border-b border-gray-200 whitespace-nowrap bg-blue-50/30">Date</th>
                                    </tr>
                                  </thead>
                                  <tbody className="divide-y divide-gray-100">
                                    {mcDeepRows.map(dr => {
                                      const mcPrice  = dr.mcPrice
                                      const mpnPrice = dr.mpnStatus === 'done' ? dr.mpnBestPriceUsd : null
                                      let winner: 'mc' | 'mpn' | 'tie' | null = null
                                      if (mcPrice != null && mpnPrice != null) {
                                        if (mcPrice < mpnPrice) winner = 'mc'
                                        else if (mpnPrice < mcPrice) winner = 'mpn'
                                        else winner = 'tie'
                                      } else if (mcPrice != null) winner = 'mc'
                                      else if (mpnPrice != null) winner = 'mpn'
                                      const winnerPrice = winner === 'mc' ? mcPrice : winner === 'mpn' ? mpnPrice : winner === 'tie' ? (mcPrice ?? mpnPrice) : null
                                      const winnerStd   = winner === 'mc' ? dr.mcStdPriceUsd : winner === 'mpn' ? dr.mpnBestStdPriceUsd : winner === 'tie' ? (dr.mcStdPriceUsd ?? dr.mpnBestStdPriceUsd) : null
                                      const lpoGtStd    = winnerPrice != null && winnerStd != null && winnerPrice > winnerStd
                                      const qtyIns      = componentQtys[dr.bmatn] ?? qty
                                      const totalUsd    = winnerPrice != null ? winnerPrice * qtyIns : null
                                      return (
                                        <tr key={dr.bmatn} className={`hover:bg-gray-50 ${lpoGtStd ? 'bg-red-50/60' : ''}`}>
                                          <td className="px-3 py-2.5 font-mono font-semibold text-gray-800 whitespace-nowrap">{dr.bmatn}</td>
                                          {/* Multi-Component side */}
                                          <td className="px-3 py-2.5 font-mono text-blue-700 whitespace-nowrap border-l border-l-purple-100">{dr.mcInternalPN || '—'}</td>
                                          <td className="px-3 py-2.5 font-mono text-gray-600 whitespace-nowrap">{dr.mcMpn || '—'}</td>
                                          <td className="px-3 py-2.5 text-gray-500 whitespace-nowrap">{dr.mcPlant || '—'}</td>
                                          <td className="px-3 py-2.5 text-gray-600 max-w-[150px] truncate" title={dr.mcSupplier}>{dr.mcSupplier || '—'}</td>
                                          <td className={`px-3 py-2.5 text-right font-mono font-semibold whitespace-nowrap ${winner === 'mc' ? 'text-emerald-700 text-sm' : 'text-gray-700'}`}>{fmt6(mcPrice)}</td>
                                          <td className="px-3 py-2.5 text-right font-mono text-gray-500 whitespace-nowrap">{fmt6(dr.mcStdPriceUsd)}</td>
                                          <td className="px-3 py-2.5 text-gray-500 whitespace-nowrap">{dr.mcLastPoDate || '—'}</td>
                                          {/* Multi-MPN side */}
                                          {dr.mpnStatus === 'loading' ? (
                                            <td colSpan={7} className="px-3 py-2.5 border-l border-l-blue-100">
                                              <div className="flex items-center gap-1.5 text-xs text-blue-500">
                                                <svg className="animate-spin h-3 w-3" fill="none" viewBox="0 0 24 24">
                                                  <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                                                  <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8H4z" />
                                                </svg>
                                                Querying…
                                              </div>
                                            </td>
                                          ) : dr.mpnStatus === 'error' ? (
                                            <td colSpan={7} className="px-3 py-2.5 text-xs text-red-500 border-l border-l-blue-100">{dr.mpnError || 'Error'}</td>
                                          ) : (
                                            <>
                                              <td className="px-3 py-2.5 font-mono text-blue-700 whitespace-nowrap border-l border-l-blue-100">{dr.mpnBestInternalPN || '—'}</td>
                                              <td className="px-3 py-2.5 font-mono text-gray-600 whitespace-nowrap">{dr.mpnBestMpn || '—'}</td>
                                              <td className="px-3 py-2.5 text-gray-500 whitespace-nowrap">{dr.mpnBestPlant || '—'}</td>
                                              <td className="px-3 py-2.5 text-gray-600 max-w-[150px] truncate" title={dr.mpnBestSupplier}>{dr.mpnBestSupplier || '—'}</td>
                                              <td className={`px-3 py-2.5 text-right font-mono font-semibold whitespace-nowrap ${winner === 'mpn' ? 'text-emerald-700 text-sm' : 'text-gray-700'}`}>{fmt6(mpnPrice)}</td>
                                              <td className="px-3 py-2.5 text-right font-mono text-gray-500 whitespace-nowrap">{fmt6(dr.mpnBestStdPriceUsd)}</td>
                                              <td className="px-3 py-2.5 text-gray-500 whitespace-nowrap">{dr.mpnLastPoDate || '—'}</td>
                                            </>
                                          )}
                                          {/* QTY Inserted */}
                                          <td className="px-3 py-2.5 text-right font-mono text-gray-600 whitespace-nowrap border-l border-l-gray-200">{qtyIns}</td>
                                          {/* Total (USD) per QTY */}
                                          <td className="px-3 py-2.5 text-right font-mono font-semibold text-indigo-700 whitespace-nowrap border-l border-l-gray-200">{totalUsd != null ? fmt6(totalUsd) : '—'}</td>
                                          {/* Winner */}
                                          <td className="px-3 py-2.5 text-center border-l border-l-gray-200 whitespace-nowrap">
                                            {winner === 'mc'  && <span className="text-xs font-bold px-2 py-0.5 rounded-full bg-purple-100 text-purple-700">MC</span>}
                                            {winner === 'mpn' && <span className="text-xs font-bold px-2 py-0.5 rounded-full bg-emerald-100 text-emerald-700">MPN</span>}
                                            {winner === 'tie' && <span className="text-xs text-gray-400">Tie</span>}
                                          </td>
                                        </tr>
                                      )
                                    })}
                                  </tbody>
                                </table>
                              </div>
                            </div>
                          )}
                        </div>
                      )}
                    </div>
                  )}

                </div>
              )}

              {/* •••••••••••••• MULTI-MPN TAB •••••••••••••• */}
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
                            {cbomFileName && (
                              <span className="flex items-center gap-1 text-[11px] text-orange-700 bg-orange-50 border border-orange-200 rounded-full px-2 py-0.5">
                                <svg className="h-3 w-3" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 17v-2m3 2v-4m3 4v-6m2 10H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" /></svg>
                                CBOM: {cbomFileName}
                                <button
                                  onClick={() => { setCbomFileName(''); setCbomRows([]); setCbomHeaders([]); setCbomMpnColIdx(-1); setMpnComponentQtys({}); setMpnComponentQtyDefaults({}); setMultiMpnInput('') }}
                                  className="ml-1 text-orange-500 hover:text-red-500 font-bold leading-none"
                                  title="Clear CBOM data"
                                >×</button>
                              </span>
                            )}
                            {lyticaFileName && (
                              <span className="flex items-center gap-1 text-[11px] text-teal-700 bg-teal-50 border border-teal-200 rounded-full px-2 py-0.5">
                                <svg className="h-3 w-3" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 19v-6a2 2 0 00-2-2H5a2 2 0 00-2 2v6a2 2 0 002 2h2a2 2 0 002-2zm0 0V9a2 2 0 012-2h2a2 2 0 012 2v10m-6 0a2 2 0 002 2h2a2 2 0 002-2m0 0V5a2 2 0 012-2h2a2 2 0 012 2v14a2 2 0 01-2 2h-2a2 2 0 01-2-2z" /></svg>
                                Lytica: {lyticaFileName}
                                <button
                                  onClick={() => { setLyticaFileName(''); setLyticaMap({}) }}
                                  className="ml-1 text-teal-500 hover:text-red-500 font-bold leading-none"
                                  title="Clear Lytica data"
                                >×</button>
                              </span>
                            )}
                            <label className="flex items-center gap-1.5 cursor-pointer px-3 py-1 text-xs font-semibold rounded-lg bg-white border border-gray-300 hover:border-blue-400 hover:text-blue-600 text-gray-600 transition-colors">
                              <svg className="h-3.5 w-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-8l-4-4m0 0L8 8m4-4v12" /></svg>
                              Upload Excel
                              <input type="file" accept=".xlsx,.xls" className="hidden" onChange={handleMpnExcelUpload} />
                            </label>
                            <label className="flex items-center gap-1.5 cursor-pointer px-3 py-1 text-xs font-semibold rounded-lg bg-white border border-orange-300 hover:border-orange-500 hover:text-orange-600 text-gray-600 transition-colors" title="Upload a Costed BOM (CBOM) Excel — extracts MPNs from the 'CBOM' sheet and generates an enriched export">
                              <svg className="h-3.5 w-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 17v-2m3 2v-4m3 4v-6m2 10H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" /></svg>
                              Upload CBOM
                              <input type="file" accept=".xlsx,.xls" className="hidden" onChange={handleCbomUpload} />
                            </label>
                            <label className="flex items-center gap-1.5 cursor-pointer px-3 py-1 text-xs font-semibold rounded-lg bg-white border border-teal-300 hover:border-teal-500 hover:text-teal-600 text-gray-600 transition-colors" title="Upload a Lytica report — matches MPN Searched with 90th percentile price for Deep Analysis comparison">
                              <svg className="h-3.5 w-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 19v-6a2 2 0 00-2-2H5a2 2 0 00-2 2v6a2 2 0 002 2h2a2 2 0 002-2zm0 0V9a2 2 0 012-2h2a2 2 0 012 2v10m-6 0a2 2 0 002 2h2a2 2 0 002-2m0 0V5a2 2 0 012-2h2a2 2 0 012 2v14a2 2 0 01-2 2h-2a2 2 0 01-2-2z" /></svg>
                              Upload Lytica
                              <input type="file" accept=".xlsx,.xls" className="hidden" onChange={handleLyticaUpload} />
                            </label>
                            <button
                              onClick={downloadTemplate}
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
                            placeholder={"RC0402FR-07100KL\nRC0402FR-0710KL\nRC0402FR-071KL"}
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
                          <option value="">- None -</option>
                          <option value="KEMX">KEMX</option>
                          <option value="KEJ">KEJ</option>
                          <option value="KECN">KECN</option>
                          <option value="KETL">KETL</option>
                          <option value="KEPS">KEPS</option>
                          <option value="KERO">KERO</option>
                        </select>
                      </div>
                      <div className="w-28">
                        <label className="block text-sm font-medium text-gray-600 mb-1.5">Window (days)</label>
                        <input
                          type="number" min={1} max={365} step={1} value={windowDays}
                          onChange={e => setWindowDays(Math.max(1, Math.min(365, parseInt(e.target.value) || 45)))}
                          className="w-full rounded-lg border border-gray-300 px-4 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
                        />
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

                  {/* Multi-MPN results */}
                  {(multiMpnRawResults.length > 0 || multiMpnLoading || multiMpnSearchedList.length > 0) && (() => {
                    // Derive blocked/deleted items from AMPL map
                    const allBlockedItems = Object.entries(multiMpnAmplMap).flatMap(([internalPN, ampl]) => [
                      ...ampl.blocked.map(i => ({ internalPN, mpn: i.MfgPartNumber, mfgName: i.MfgName, mpnPartNumber: i.MpnPartNumber, kind: 'blocked' as const, code: i.Blocked ?? '??' })),
                      ...ampl.deleted.map(i => ({ internalPN, mpn: i.MfgPartNumber, mfgName: i.MfgName, mpnPartNumber: i.MpnPartNumber, kind: 'deleted' as const, code: i.Deleted ?? '??' })),
                    ])
                    // Group by kind + code
                    const groupMap = new Map<string, { kind: 'blocked' | 'deleted'; code: string; reason: string; items: typeof allBlockedItems }>()
                    for (const item of allBlockedItems) {
                      const key = `${item.kind}:${item.code}`
                      if (!groupMap.has(key)) groupMap.set(key, {
                        kind: item.kind, code: item.code,
                        reason: BLOCK_REASONS[item.code] ?? (item.kind === 'deleted' ? 'Deleted from AVL' : 'Unknown reason'),
                        items: [],
                      })
                      groupMap.get(key)!.items.push(item)
                    }
                    const blockedGroups = [...groupMap.values()].sort((a, b) => a.kind.localeCompare(b.kind) || a.code.localeCompare(b.code))
                    const blockedCount = allBlockedItems.length

                    // Best price per MPN: cheapest Last PO (USD) within configurable window from latest purchase date
                    const mpnGroupsMap = new Map<string, IQItem[]>()
                    for (const row of multiMpnRawResults) {
                      if (!mpnGroupsMap.has(row.mpn)) mpnGroupsMap.set(row.mpn, [])
                      mpnGroupsMap.get(row.mpn)!.push(row)
                    }
                    const mpnEntries = [...mpnGroupsMap.entries()]
                      .sort(([a], [b]) => a.localeCompare(b))
                      .map(([mpn, rows]) => {
                        const validRows = rows.filter(r => r.lastPoDate && !isNaN(new Date(r.lastPoDate).getTime()))
                        if (!validRows.length) return null
                        const maxT = Math.max(...validRows.map(r => new Date(r.lastPoDate).getTime()))
                        const windowStart = new Date(maxT - windowDays * 86400000)
                        const inWindow = validRows.filter(r => new Date(r.lastPoDate).getTime() >= windowStart.getTime())
                        const best = inWindow.reduce<IQItem>((min, r) => {
                          const p = resolveLastPoPrice(r)
                          const mp = resolveLastPoPrice(min)
                          if (p == null) return min
                          if (mp == null) return r
                          return p < mp ? r : min
                        }, inWindow[0])
                        const allSorted = [...rows].sort((a, b) => new Date(b.lastPoDate || 0).getTime() - new Date(a.lastPoDate || 0).getTime())
                        return { mpn, bestRow: best, allRows: allSorted }
                      })
                      .filter((x): x is { mpn: string; bestRow: IQItem; allRows: IQItem[] } => x !== null)

                    // Shared table header and row renderer
                    const iqThead = (
                      <thead className="bg-gray-50 text-[10px] uppercase tracking-wide text-gray-500">
                        <tr>
                          <th className="px-3 py-2.5 text-left whitespace-nowrap border-b border-gray-200">MPN</th>
                          <th className="px-3 py-2.5 text-left whitespace-nowrap border-b border-gray-200">Internal PN</th>
                          <th className="px-3 py-2.5 text-left whitespace-nowrap border-b border-gray-200">Plant</th>
                          <th className="px-3 py-2.5 text-left whitespace-nowrap border-b border-gray-200">Supplier</th>
                          <th className="px-3 py-2.5 text-left whitespace-nowrap border-b border-gray-200">Description</th>
                          <th className="px-3 py-2.5 text-right whitespace-nowrap border-b border-gray-200">Qty</th>
                          <th className="px-3 py-2.5 text-center whitespace-nowrap border-b border-gray-200">Cur</th>
                          <th className="px-3 py-2.5 text-right whitespace-nowrap border-b border-gray-200">Last PO (Local)</th>
                          <th className="px-3 py-2.5 text-right whitespace-nowrap border-b border-gray-200">Std (Local)</th>
                          <th className="px-3 py-2.5 text-right whitespace-nowrap border-b border-gray-200">Last PO (USD)</th>
                          <th className="px-3 py-2.5 text-right whitespace-nowrap border-b border-gray-200">Std (USD)</th>
                          <th className="px-3 py-2.5 text-left whitespace-nowrap border-b border-gray-200">Date</th>
                        </tr>
                      </thead>
                    )
                    const iqRow = (row: IQItem, key: string | number, highlight = false) => (
                      <tr key={key} className={highlight ? 'bg-emerald-50/60 hover:bg-emerald-50' : 'hover:bg-gray-50'}>
                        <td className="px-3 py-2 font-mono text-gray-700 whitespace-nowrap">{row.mpn}</td>
                        <td className="px-3 py-2 font-mono font-semibold text-blue-700 whitespace-nowrap">{row.internalPN}</td>
                        <td className="px-3 py-2 whitespace-nowrap text-gray-700">{row.siteName}</td>
                        <td className="px-3 py-2 text-gray-600 max-w-[160px] truncate" title={row.supplierName || row.englishName || ''}>{row.supplierName || row.englishName || '—'}</td>
                        <td className="px-3 py-2 text-gray-500 max-w-[200px] truncate" title={row.materialDescription}>{row.materialDescription || '—'}</td>
                        <td className="px-3 py-2 text-right font-mono text-gray-700 whitespace-nowrap">{row.quantity?.toLocaleString() ?? '—'}</td>
                        <td className="px-3 py-2 text-center font-mono text-gray-500 whitespace-nowrap">{row.localCurrency || '—'}</td>
                        <td className="px-3 py-2 text-right font-mono text-gray-700 whitespace-nowrap">
                          {resolvePoLocal(row) != null ? resolvePoLocal(row)!.toLocaleString('en-US', { minimumFractionDigits: 4 }) : '—'}
                        </td>
                        <td className="px-3 py-2 text-right font-mono text-gray-500 whitespace-nowrap">
                          {resolveStdLocal(row) != null ? resolveStdLocal(row)!.toLocaleString('en-US', { minimumFractionDigits: 4 }) : '—'}
                        </td>
                        <td className={`px-3 py-2 text-right font-mono font-semibold whitespace-nowrap ${highlight ? 'text-emerald-700' : 'text-blue-700'}`}>{fmt6(resolveLastPoPrice(row))}</td>
                        <td className="px-3 py-2 text-right font-mono text-gray-500 whitespace-nowrap">{fmt6(row.standardPriceUsd)}</td>
                        <td className="px-3 py-2 text-gray-500 whitespace-nowrap">{row.lastPoDate || '—'}</td>
                      </tr>
                    )

                    return (
                      <div>
                        {/* Sub-tab bar */}
                        <div className="flex items-center gap-3 mb-3">
                          <div className="flex gap-1 bg-gray-100 rounded-xl p-0.5">
                            <button
                              onClick={() => setMultiMpnSubTab('results')}
                              className={`px-3 py-1.5 text-xs font-medium rounded-lg transition-colors ${multiMpnSubTab === 'results' ? 'bg-white text-blue-600 shadow-sm' : 'text-gray-500 hover:text-gray-700'}`}
                            >
                              IQ Results ({mpnEntries.length})
                            </button>
                            <button
                              onClick={() => setMultiMpnSubTab('allrecords')}
                              className={`px-3 py-1.5 text-xs font-medium rounded-lg transition-colors ${multiMpnSubTab === 'allrecords' ? 'bg-white text-purple-600 shadow-sm' : 'text-gray-500 hover:text-gray-700'}`}
                            >
                              All Records ({multiMpnRawResults.length})
                            </button>
                            <button
                              onClick={() => setMultiMpnSubTab('blocked')}
                              className={`px-3 py-1.5 text-xs font-medium rounded-lg transition-colors ${multiMpnSubTab === 'blocked' ? 'bg-white text-red-600 shadow-sm' : 'text-gray-500 hover:text-gray-700'}`}
                            >
                              Blocked / Deleted ({blockedCount})
                            </button>
                            <button
                              onClick={() => setMultiMpnSubTab('deep')}
                              className={`px-3 py-1.5 text-xs font-medium rounded-lg transition-colors ${multiMpnSubTab === 'deep' ? 'bg-white text-indigo-600 shadow-sm' : 'text-gray-500 hover:text-gray-700'}`}
                            >
                              Deep Analysis{deepAnalysisRows.length > 0 ? ` (${deepAnalysisRows.length})` : ''}
                            </button>
                          </div>
                          {(multiMpnLoading || deepAnalysisLoading) && (
                            <div className="flex items-center gap-1.5 text-xs text-blue-600">
                              <svg className="animate-spin h-3 w-3" fill="none" viewBox="0 0 24 24">
                                <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                                <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8H4z" />
                              </svg>
                              {multiMpnRawResults.length > 0 ? 'Fetching AMPL…' : 'Querying…'}
                            </div>
                          )}
                          {/* Export Excel button — shown only when data is ready */}
                          {!multiMpnLoading && !deepAnalysisLoading && (() => {
                            const hasData =
                              multiMpnSubTab === 'results'    ? mpnEntries.length > 0 :
                              multiMpnSubTab === 'allrecords' ? mpnEntries.length > 0 :
                              multiMpnSubTab === 'blocked'    ? allBlockedItems.length > 0 :
                              deepAnalysisRows.filter(r => r.status === 'done').length > 0
                            const tabLabel =
                              multiMpnSubTab === 'results'    ? 'IQ_Results' :
                              multiMpnSubTab === 'allrecords' ? 'All_Records' :
                              multiMpnSubTab === 'blocked'    ? 'Blocked_Deleted' : 'Deep_Analysis'
                            return (
                              <div className="ml-auto flex items-center gap-2">
                                {mpnEntries.length > 0 && (
                                  <button
                                    onClick={() => {
                                      const uniqueIPs = [...new Set(mpnEntries.map(e => e.bestRow.internalPN).filter(Boolean))]
                                      handleDeepAnalysis(uniqueIPs)
                                    }}
                                    className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-indigo-700 bg-indigo-50 hover:bg-indigo-100 border border-indigo-200 rounded-lg transition-colors whitespace-nowrap"
                                  >
                                    <svg className="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="2">
                                      <path strokeLinecap="round" strokeLinejoin="round" d="M9 19v-6a2 2 0 00-2-2H5a2 2 0 00-2 2v6a2 2 0 002 2h2a2 2 0 002-2zm0 0V9a2 2 0 012-2h2a2 2 0 012 2v10m-6 0a2 2 0 002 2h2a2 2 0 002-2m0 0V5a2 2 0 012-2h2a2 2 0 012 2v14a2 2 0 01-2 2h-2a2 2 0 01-2-2z" />
                                    </svg>
                                    Deep Analysis
                                  </button>
                                )}
                                {hasData && (
                                  <button
                                    onClick={() => downloadMpnExcelFile(
                                      multiMpnSubTab, mpnEntries, allBlockedItems, deepAnalysisRows,
                                      `PPV_MPN_${tabLabel}_${new Date().toISOString().slice(0, 10)}.xlsx`,
                                      { mpnComponentQtys, mpnNexarMap, myPlant: myPlant ?? '', qty },
                                    )}
                                    className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-emerald-700 bg-emerald-50 hover:bg-emerald-100 border border-emerald-200 rounded-lg transition-colors whitespace-nowrap"
                                  >
                                    <svg className="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="2">
                                      <path strokeLinecap="round" strokeLinejoin="round" d="M12 10v6m0 0l-3-3m3 3l3-3m2 4H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
                                    </svg>
                                    Export Excel
                                  </button>
                                )}
                                {cbomRows.length > 0 && mpnEntries.length > 0 && (
                                  <button
                                    onClick={() => downloadCbomResultsExcel(
                                      cbomHeaders, cbomRows, cbomMpnColIdx, mpnEntries, deepAnalysisRows,
                                      mpnNexarMap,
                                      lyticaMap,
                                      `CBOM_PPV_${new Date().toISOString().slice(0, 10)}.xlsx`,
                                    )}
                                    className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-orange-700 bg-orange-50 hover:bg-orange-100 border border-orange-200 rounded-lg transition-colors whitespace-nowrap"
                                    title={deepAnalysisRows.some(r => r.status === 'done')
                                      ? 'Export CBOM enriched with Deep Analysis best-supplier winner (left join)'
                                      : 'Export CBOM with PPV best-price results. Run Deep Analysis for optimal supplier selection.'}
                                  >
                                    <svg className="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="2">
                                      <path strokeLinecap="round" strokeLinejoin="round" d="M9 17v-2m3 2v-4m3 4v-6m2 10H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
                                    </svg>
                                    Export CBOM
                                    {deepAnalysisRows.some(r => r.status === 'done') && (
                                      <span className="ml-1 text-[10px] bg-indigo-100 text-indigo-700 rounded px-1 font-semibold">Deep</span>
                                    )}
                                  </button>
                                )}
                              </div>
                            )
                          })()}
                        </div>

                        {/* ── IQ Results: loading skeleton — only while the bulk IQ call is in-flight ── */}
                        {multiMpnSubTab === 'results' && multiMpnLoading && multiMpnRawResults.length === 0 && multiMpnSearchedList.length > 0 && (
                          <div>
                            <p className="text-[10px] text-gray-400 mb-2">Cheapest Last PO (USD) within a {windowDays}-day window from the latest purchase date — one row per MPN</p>
                            <div className="overflow-x-auto rounded-xl border border-gray-200 shadow-sm">
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
                                  </tr>
                                </thead>
                                <tbody className="divide-y divide-gray-100">
                                  {multiMpnSearchedList.map(mpn => (
                                    <tr key={mpn} className="bg-blue-50/40 animate-pulse">
                                      <td className="px-2 py-2 text-center">
                                        <svg className="animate-spin h-3 w-3 text-blue-500 mx-auto" fill="none" viewBox="0 0 24 24">
                                          <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                                          <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8H4z" />
                                        </svg>
                                      </td>
                                      <td className="px-3 py-2 font-mono text-gray-700 whitespace-nowrap">—</td>
                                      <td className="px-3 py-2 font-mono text-gray-500 whitespace-nowrap">—</td>
                                      <td className="px-3 py-2 text-gray-500 whitespace-nowrap">—</td>
                                      <td className="px-3 py-2 font-mono font-semibold text-blue-700 whitespace-nowrap">{mpn}</td>
                                      <td className="px-3 py-2 font-mono text-gray-700 whitespace-nowrap">—</td>
                                      <td className="px-3 py-2 text-gray-700 whitespace-nowrap">—</td>
                                      <td className="px-3 py-2 text-right font-mono text-gray-700 whitespace-nowrap">—</td>
                                      <td className="px-3 py-2 text-center font-mono text-gray-500 whitespace-nowrap">—</td>
                                      <td className="px-3 py-2 text-right font-mono text-gray-700 whitespace-nowrap">—</td>
                                      <td className="px-3 py-2 text-right font-mono text-gray-500 whitespace-nowrap">—</td>
                                      <td className="px-3 py-2 text-right font-mono text-blue-700 font-semibold whitespace-nowrap">—</td>
                                      <td className="px-3 py-2 text-right font-mono text-gray-500 whitespace-nowrap">—</td>
                                      <td className="px-3 py-2 text-right font-mono text-gray-700 whitespace-nowrap">—</td>
                                      <td className="px-3 py-2 text-right font-mono text-gray-700 whitespace-nowrap">—</td>
                                      <td className="px-3 py-2 text-gray-500 whitespace-nowrap">—</td>
                                      <td className="px-3 py-2 text-center whitespace-nowrap" />
                                      <td className="px-3 py-2 text-center whitespace-nowrap" />
                                      <td className="px-3 py-2 text-center whitespace-nowrap" />
                                    </tr>
                                  ))}
                                </tbody>
                              </table>
                            </div>
                          </div>
                        )}

                        {/* ── IQ Results: one best-price row per MPN — shows as soon as IQ data arrives ── */}
                        {multiMpnSubTab === 'results' && (mpnEntries.length > 0 || (!multiMpnLoading && multiMpnSearchedList.length > 0)) && (
                          <div>
                            <p className="text-[10px] text-gray-400 mb-2">Cheapest Last PO (USD) within a {windowDays}-day window from the latest purchase date — one row per MPN</p>
                            <div className="overflow-x-auto rounded-xl border border-gray-200 shadow-sm">
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
                                    {Object.keys(mpnNexarMap).length > 0 && <th className="px-3 py-2.5 text-center whitespace-nowrap border-b border-gray-200 text-purple-600">Best in Market</th>}
                                    {Object.keys(mpnNexarMap).length > 0 && <th className="px-3 py-2.5 text-right whitespace-nowrap border-b border-gray-200 text-purple-600">Nexar Best (USD)</th>}
                                    {Object.keys(mpnNexarMap).length > 0 && <th className="px-3 py-2.5 text-left whitespace-nowrap border-b border-gray-200 text-purple-600">Nexar Seller</th>}
                                  </tr>
                                </thead>
                                <tbody className="divide-y divide-gray-100">
                                  {mpnEntries.map(({ mpn, bestRow }, i) => {
                                    const lpoUsd     = resolveLastPoPrice(bestRow)
                                    const stdUsd     = bestRow.standardPriceUsd
                                    const isLpoGtStd = lpoUsd != null && stdUsd != null && lpoUsd > stdUsd
                                    const isSwap     = !!(myPlant && bestRow.siteName && bestRow.siteName !== myPlant)
                                    const isManual   = lpoUsd === 0
                                    const qtyIns     = mpnComponentQtys[mpn] ?? qty
                                    const nexarEntry   = mpnNexarMap[mpn]
                                    const nexarBestUsd = nexarEntry?.nexarBestUsd ?? null
                                    const nexarSeller  = nexarEntry?.nexarSeller ?? ''
                                    const bestInMarket = nexarBestUsd != null && lpoUsd != null && lpoUsd > 0 && nexarBestUsd < lpoUsd
                                    const bgColor    = isLpoGtStd ? 'bg-red-50 hover:bg-red-100/70' : isSwap ? 'bg-green-50 hover:bg-green-100/70' : i % 2 === 0 ? 'hover:bg-gray-50' : 'bg-gray-50/50 hover:bg-gray-100/50'
                                    const amplStillLoading = multiMpnLoading && !!bestRow.internalPN && !(bestRow.internalPN in multiMpnAmplMap)
                                    const resolvedAltPn    = multiMpnAmplMap[bestRow.internalPN]?.active.find(a => a.MfgPartNumber === bestRow.mpn)?.MpnPartNumber
                                    return (
                                      <tr key={mpn} className={bgColor}>
                                        <td className="px-2 py-2 text-center text-emerald-500 font-bold"></td>
                                        <td className="px-3 py-2 font-mono font-semibold text-emerald-700 whitespace-nowrap">{bestRow.mpn}</td>
                                        <td className="px-3 py-2 font-mono text-gray-500 whitespace-nowrap">
                                          {amplStillLoading
                                            ? <span className="inline-flex items-center text-blue-400 animate-pulse"><svg className="h-2.5 w-2.5 animate-spin" fill="none" viewBox="0 0 24 24"><circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"/><path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8H4z"/></svg></span>
                                            : (resolvedAltPn && resolvedAltPn !== bestRow.mpn ? resolvedAltPn : '—')
                                          }
                                        </td>
                                        <td className="px-3 py-2 text-gray-600 max-w-[180px] truncate" title={bestRow.supplierName || bestRow.englishName || ''}>{bestRow.supplierName || bestRow.englishName || '—'}</td>
                                        <td className="px-3 py-2 font-mono font-semibold text-blue-700 whitespace-nowrap">{mpn}</td>
                                        <td className="px-3 py-2 font-mono text-gray-700 whitespace-nowrap">{bestRow.internalPN || '—'}</td>
                                        <td className="px-3 py-2 text-center whitespace-nowrap">{bestRow.siteName || '—'}</td>
                                        <td className="px-3 py-2 text-right font-mono text-gray-700 whitespace-nowrap">{bestRow.quantity?.toLocaleString() ?? '—'}</td>
                                        <td className="px-3 py-2 text-center font-mono text-gray-500 whitespace-nowrap">{bestRow.localCurrency || '—'}</td>
                                        <td className="px-3 py-2 text-right font-mono text-gray-700 whitespace-nowrap">{resolvePoLocal(bestRow) != null ? resolvePoLocal(bestRow)!.toLocaleString('en-US', { minimumFractionDigits: 4 }) : '—'}</td>
                                        <td className="px-3 py-2 text-right font-mono text-gray-500 whitespace-nowrap">{resolveStdLocal(bestRow) != null ? resolveStdLocal(bestRow)!.toLocaleString('en-US', { minimumFractionDigits: 4 }) : '—'}</td>
                                        <td className={`px-3 py-2 text-right font-mono font-semibold whitespace-nowrap ${isLpoGtStd ? 'text-red-700' : 'text-blue-700'}`}>{fmt6(lpoUsd)}</td>
                                        <td className="px-3 py-2 text-right font-mono text-gray-500 whitespace-nowrap">{fmt6(stdUsd)}</td>
                                        <td className="px-3 py-2 text-right font-mono text-gray-700 whitespace-nowrap">{qtyIns.toLocaleString()}</td>
                                        <td className="px-3 py-2 text-right font-mono text-gray-700 whitespace-nowrap">{lpoUsd != null && lpoUsd > 0 ? fmt6(lpoUsd * qtyIns) : '—'}</td>
                                        <td className="px-3 py-2 text-gray-500 whitespace-nowrap">{bestRow.lastPoDate || '—'}</td>
                                        <td className="px-3 py-2 text-center whitespace-nowrap">
                                          {isLpoGtStd && <span className="text-[10px] font-bold text-red-700 bg-red-100 px-1.5 py-0.5 rounded">1</span>}
                                        </td>
                                        <td className="px-3 py-2 text-center whitespace-nowrap">
                                          {isSwap && <span className="text-[10px] font-bold text-green-700 bg-green-100 px-1.5 py-0.5 rounded">1</span>}
                                        </td>
                                        <td className="px-3 py-2 text-center whitespace-nowrap">
                                          {isManual && <span className="text-[10px] font-bold text-amber-700 bg-amber-100 px-1.5 py-0.5 rounded">1</span>}
                                        </td>
                                        {Object.keys(mpnNexarMap).length > 0 && (
                                          <td className="px-3 py-2 text-center whitespace-nowrap">
                                            {bestInMarket && <span className="text-[10px] font-bold text-purple-700 bg-purple-100 px-1.5 py-0.5 rounded">1</span>}
                                          </td>
                                        )}
                                        {Object.keys(mpnNexarMap).length > 0 && (
                                          <td className="px-3 py-2 text-right font-mono text-purple-700 whitespace-nowrap">{fmt6(nexarBestUsd)}</td>
                                        )}
                                        {Object.keys(mpnNexarMap).length > 0 && (
                                          <td className="px-3 py-2 text-left font-mono text-purple-600 whitespace-nowrap max-w-[160px] truncate" title={nexarSeller}>{nexarSeller || '—'}</td>
                                        )}
                                      </tr>
                                    )
                                  })}
                                  {(() => {
                                    const foundSet   = new Set(mpnEntries.map(e => e.mpn))
                                    const rawSet     = new Set(multiMpnRawResults.map(r => r.mpn))
                                    const blockedSet = new Set(allBlockedItems.map(i => i.mpn))
                                    return multiMpnSearchedList.filter(m => !foundSet.has(m)).map(m => {
                                      const reason    = rawSet.has(m) ? 'No valid price data' : blockedSet.has(m) ? 'Blocked / Deleted' : 'No data'
                                      const isBlocked = reason === 'Blocked / Deleted'
                                      return (
                                        <tr key={`missing-${m}`} className={isBlocked ? 'bg-amber-50/60' : 'bg-gray-50/40'}>
                                          <td className="px-2 py-2 text-center text-gray-300">—</td>
                                          <td className="px-3 py-2 font-mono text-gray-500 whitespace-nowrap">{m}</td>
                                          <td colSpan={Object.keys(mpnNexarMap).length > 0 ? 20 : 17} className={`px-3 py-2 text-xs italic ${isBlocked ? 'text-amber-500' : 'text-gray-400'}`}>{reason}</td>
                                        </tr>
                                      )
                                    })
                                  })()}
                                </tbody>
                              </table>
                            </div>
                          </div>
                        )}

                        {/* ── All Records: per-MPN expander ── */}
                        {multiMpnSubTab === 'allrecords' && !multiMpnLoading && mpnEntries.length > 0 && (
                          <div className="rounded-xl border border-gray-200 overflow-hidden shadow-sm">
                            {mpnEntries.map(({ mpn, allRows }, idx) => {
                              const isOpen = multiMpnExpandedMpns.has(mpn)
                              const toggle = () => setMultiMpnExpandedMpns(prev => {
                                const s = new Set(prev)
                                isOpen ? s.delete(mpn) : s.add(mpn)
                                return s
                              })
                              return (
                                <div key={mpn} className={idx > 0 ? 'border-t border-gray-200' : ''}>
                                  <button
                                    onClick={toggle}
                                    className="w-full flex items-center gap-3 px-4 py-3 text-left hover:bg-gray-50 transition-colors"
                                  >
                                    <svg
                                      className={`h-3.5 w-3.5 text-gray-400 flex-shrink-0 transition-transform ${isOpen ? 'rotate-90' : ''}`}
                                      fill="none" viewBox="0 0 24 24"
                                    >
                                      <path stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" d="M9 6l6 6-6 6" />
                                    </svg>
                                    <span className="font-mono font-semibold text-sm text-gray-800">{mpn}</span>
                                    <span className="text-xs text-gray-400 ml-1">{allRows.length} record{allRows.length !== 1 ? 's' : ''}</span>
                                  </button>
                                  {isOpen && (
                                    <div className="overflow-x-auto border-t border-gray-100">
                                      <table className="min-w-max w-full text-xs border-collapse">
                                        {iqThead}
                                        <tbody className="divide-y divide-gray-100">
                                          {allRows.map((row, i) => iqRow(row, i))}
                                        </tbody>
                                      </table>
                                    </div>
                                  )}
                                </div>
                              )
                            })}
                          </div>
                        )}

                        {/* ── Deep Analysis tab ── */}
                        {multiMpnSubTab === 'deep' && (
                          <div>
                            {deepAnalysisRows.length === 0 ? (
                              <p className="text-sm text-gray-400 py-8 text-center">Click "Deep Analysis" in the IQ Results tab to compare prices.</p>
                            ) : (
                              <div>
                                <p className="text-[10px] text-gray-400 mb-3">Comparison of Multi-MPN ({windowDays}-day window best) vs Multi-Component (AMPL active MPNs best) prices per Internal PN</p>
                                <div className="overflow-x-auto rounded-xl border border-gray-200 shadow-sm">
                                  <table className="min-w-max w-full text-xs border-collapse">
                                    <thead className="bg-gray-50 text-[10px] uppercase tracking-wide text-gray-500">
                                      <tr>
                                        <th className="px-3 py-2.5 text-left border-b border-gray-200 whitespace-nowrap" rowSpan={2}>Internal PN</th>
                                        <th className="px-3 py-2.5 text-center border-b border-gray-200 border-l border-l-blue-200 whitespace-nowrap bg-blue-50/50" colSpan={6}>Multi-MPN</th>
                                        <th className="px-3 py-2.5 text-center border-b border-gray-200 border-l border-l-purple-200 whitespace-nowrap bg-purple-50/50" colSpan={7}>Multi-Component</th>
                                        <th className="px-3 py-2.5 text-center border-b border-gray-200 border-l border-l-orange-200 whitespace-nowrap bg-orange-50/50" colSpan={6}>Nexar Market</th>
                                        {Object.keys(lyticaMap).length > 0 && <th className="px-3 py-2.5 text-center border-b border-gray-200 border-l border-l-teal-200 whitespace-nowrap bg-teal-50/50" colSpan={4}>Lytica</th>}
                                        <th className="px-3 py-2.5 text-center border-b border-gray-200 border-l border-l-gray-300 whitespace-nowrap" rowSpan={2}>QTY Inserted</th>
                                        <th className="px-3 py-2.5 text-center border-b border-gray-200 border-l border-l-gray-300 whitespace-nowrap" rowSpan={2}>Total (USD) per QTY</th>
                                        <th className="px-3 py-2.5 text-center border-b border-gray-200 border-l border-l-gray-300 whitespace-nowrap" rowSpan={2}>Winner</th>
                                      </tr>
                                      <tr>
                                        <th className="px-3 py-2 text-left border-b border-gray-200 border-l border-l-blue-200 whitespace-nowrap bg-blue-50/30">MPN</th>
                                        <th className="px-3 py-2 text-left border-b border-gray-200 whitespace-nowrap bg-blue-50/30">Plant</th>
                                        <th className="px-3 py-2 text-left border-b border-gray-200 whitespace-nowrap bg-blue-50/30">Supplier</th>
                                        <th className="px-3 py-2 text-right border-b border-gray-200 whitespace-nowrap bg-blue-50/30">Last PO (USD)</th>
                                        <th className="px-3 py-2 text-right border-b border-gray-200 whitespace-nowrap bg-blue-50/30">Std (USD)</th>
                                        <th className="px-3 py-2 text-left border-b border-gray-200 whitespace-nowrap bg-blue-50/30">Date</th>
                                        <th className="px-3 py-2 text-left border-b border-gray-200 border-l border-l-purple-200 whitespace-nowrap bg-purple-50/30">Internal PN</th>
                                        <th className="px-3 py-2 text-left border-b border-gray-200 whitespace-nowrap bg-purple-50/30">MPN</th>
                                        <th className="px-3 py-2 text-left border-b border-gray-200 whitespace-nowrap bg-purple-50/30">Plant</th>
                                        <th className="px-3 py-2 text-left border-b border-gray-200 whitespace-nowrap bg-purple-50/30">Supplier</th>
                                        <th className="px-3 py-2 text-right border-b border-gray-200 whitespace-nowrap bg-purple-50/30">Last PO (USD)</th>
                                        <th className="px-3 py-2 text-right border-b border-gray-200 whitespace-nowrap bg-purple-50/30">Std (USD)</th>
                                        <th className="px-3 py-2 text-left border-b border-gray-200 whitespace-nowrap bg-purple-50/30">Date</th>
                                        <th className="px-3 py-2 text-left border-b border-gray-200 border-l border-l-orange-200 whitespace-nowrap bg-orange-50/30">MPN</th>
                                        <th className="px-3 py-2 text-left border-b border-gray-200 whitespace-nowrap bg-orange-50/30">Manufacturer</th>
                                        <th className="px-3 py-2 text-left border-b border-gray-200 whitespace-nowrap bg-orange-50/30">Supplier</th>
                                        <th className="px-3 py-2 text-right border-b border-gray-200 whitespace-nowrap bg-orange-50/30">Unit Price (USD)</th>
                                        <th className="px-3 py-2 text-right border-b border-gray-200 whitespace-nowrap bg-orange-50/30">Stock</th>
                                        <th className="px-3 py-2 text-right border-b border-gray-200 whitespace-nowrap bg-orange-50/30">MOQ</th>
                                        {Object.keys(lyticaMap).length > 0 && <th className="px-3 py-2 text-left border-b border-gray-200 border-l border-l-teal-200 whitespace-nowrap bg-teal-50/30">MPN Searched</th>}
                                        {Object.keys(lyticaMap).length > 0 && <th className="px-3 py-2 text-left border-b border-gray-200 whitespace-nowrap bg-teal-50/30">MPN Matched</th>}
                                        {Object.keys(lyticaMap).length > 0 && <th className="px-3 py-2 text-left border-b border-gray-200 whitespace-nowrap bg-teal-50/30">Manufacturer</th>}
                                        {Object.keys(lyticaMap).length > 0 && <th className="px-3 py-2 text-right border-b border-gray-200 whitespace-nowrap bg-teal-50/30">90th %tile</th>}
                                      </tr>
                                    </thead>
                                    <tbody className="divide-y divide-gray-100">
                                      {deepAnalysisRows.map(dr => {
                                        // Multi-MPN best for this internalPN
                                        const mpnCandidates = mpnEntries.filter(e => e.bestRow.internalPN === dr.internalPN)
                                        const mpnBestEntry = mpnCandidates.reduce<typeof mpnEntries[0] | null>((min, e) => {
                                          const p = resolveLastPoPrice(e.bestRow)
                                          const mp = min ? resolveLastPoPrice(min.bestRow) : null
                                          if (p == null) return min
                                          if (mp == null) return e
                                          return p < mp ? e : min
                                        }, null)
                                        const mpnPrice = mpnBestEntry ? resolveLastPoPrice(mpnBestEntry.bestRow) : null
                                        const mcPrice  = dr.mcBestPriceUsd

                                        // Lytica: find the best match for any MPN belonging to this internalPN
                                        const hasLytica = Object.keys(lyticaMap).length > 0
                                        let lyticaBest: { mpnSearched: string; mpnMatched: string; manufacturerMatched: string; price90th: number | null } | null = null
                                        if (hasLytica) {
                                          const candidates = mpnEntries.filter(e => e.bestRow.internalPN === dr.internalPN)
                                          for (const c of candidates) {
                                            const entry = lyticaMap[c.mpn.toUpperCase()]
                                            if (entry && (lyticaBest == null || (entry.price90th != null && (lyticaBest.price90th == null || entry.price90th < lyticaBest.price90th))))
                                              lyticaBest = { mpnSearched: c.mpn, ...entry }
                                          }
                                        }
                                        const lyticaPrice = lyticaBest?.price90th ?? null

                                        // Winner: compare mpn, mc, nexar, lytica — pick lowest price
                                        const nexarCandidates = mpnEntries.filter(e => e.bestRow.internalPN === dr.internalPN)
                                        let nexarBestForWinner: number | null = null
                                        for (const c of nexarCandidates) {
                                          const nx = mpnNexarMap[c.mpn]
                                          if (nx?.nexarBestUsd != null && (nexarBestForWinner == null || nx.nexarBestUsd < nexarBestForWinner))
                                            nexarBestForWinner = nx.nexarBestUsd
                                        }

                                        type WinnerType = 'mpn' | 'mc' | 'nexar' | 'lytica' | 'tie' | null
                                        let winner: WinnerType = null
                                        const prices: Array<[WinnerType, number]> = []
                                        if (mpnPrice != null)       prices.push(['mpn', mpnPrice])
                                        if (mcPrice != null)        prices.push(['mc', mcPrice])
                                        if (nexarBestForWinner != null) prices.push(['nexar', nexarBestForWinner])
                                        if (lyticaPrice != null)    prices.push(['lytica', lyticaPrice])
                                        if (prices.length > 0) {
                                          const minPrice = Math.min(...prices.map(([, p]) => p))
                                          const winners = prices.filter(([, p]) => p === minPrice)
                                          winner = winners.length === 1 ? winners[0][0] : 'tie'
                                        }
                                        const winnerPrice = prices.length > 0 ? Math.min(...prices.map(([, p]) => p)) : null
                                        const winnerStd   = winner === 'mpn' ? (mpnBestEntry?.bestRow.standardPriceUsd ?? null) : winner === 'mc' ? dr.mcStdPriceUsd : null
                                        const lpoGtStd    = winnerPrice != null && winnerStd != null && winnerPrice > winnerStd
                                        const qtyIns      = mpnComponentQtys[mpnBestEntry?.mpn ?? ''] ?? qty
                                        const totalUsd    = winnerPrice != null ? winnerPrice * qtyIns : null
                                        return (
                                          <tr key={dr.internalPN} className={`hover:bg-gray-50 ${lpoGtStd ? 'bg-red-50/60' : ''}`}>
                                            <td className="px-3 py-2.5 font-mono font-semibold text-blue-700 whitespace-nowrap">{dr.internalPN}</td>
                                            {/* Multi-MPN side */}
                                            <td className="px-3 py-2.5 font-mono text-gray-600 whitespace-nowrap border-l border-l-blue-100">{mpnBestEntry?.mpn || '—'}</td>
                                            <td className="px-3 py-2.5 text-gray-500 whitespace-nowrap">{mpnBestEntry?.bestRow.siteName || '—'}</td>
                                            <td className="px-3 py-2.5 text-gray-600 max-w-[150px] truncate" title={mpnBestEntry?.bestRow.supplierName || ''}>{mpnBestEntry ? (mpnBestEntry.bestRow.supplierName || mpnBestEntry.bestRow.englishName || '—') : '—'}</td>
                                            <td className={`px-3 py-2.5 text-right font-mono font-semibold whitespace-nowrap ${winner === 'mpn' ? 'text-emerald-700 text-sm' : 'text-gray-700'}`}>{fmt6(mpnPrice)}</td>
                                            <td className="px-3 py-2.5 text-right font-mono text-gray-500 whitespace-nowrap">{fmt6(mpnBestEntry?.bestRow.standardPriceUsd ?? null)}</td>
                                            <td className="px-3 py-2.5 text-gray-500 whitespace-nowrap">{mpnBestEntry?.bestRow.lastPoDate || '—'}</td>
                                            {/* Multi-Component side */}
                                            {dr.status === 'loading' ? (
                                              <td colSpan={7} className="px-3 py-2.5 text-center border-l border-l-purple-100">
                                                <div className="flex items-center justify-center gap-1.5 text-gray-400">
                                                  <svg className="animate-spin h-3 w-3" fill="none" viewBox="0 0 24 24">
                                                    <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                                                    <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8H4z" />
                                                  </svg>
                                                  Loading...
                                                </div>
                                              </td>
                                            ) : dr.status === 'error' ? (
                                              <td colSpan={7} className="px-3 py-2.5 text-center text-red-400 border-l border-l-purple-100">{dr.error}</td>
                                            ) : (
                                              <>
                                                <td className="px-3 py-2.5 font-mono font-semibold text-purple-700 whitespace-nowrap border-l border-l-purple-100">{dr.mcBestInternalPN || '—'}</td>
                                                <td className="px-3 py-2.5 font-mono text-gray-600 whitespace-nowrap">{dr.mcBestMpn || '—'}</td>
                                                <td className="px-3 py-2.5 text-gray-500 whitespace-nowrap">{dr.mcBestPlant || '—'}</td>
                                                <td className="px-3 py-2.5 text-gray-600 max-w-[150px] truncate" title={dr.mcBestSupplier}>{dr.mcBestSupplier || '—'}</td>
                                                <td className={`px-3 py-2.5 text-right font-mono font-semibold whitespace-nowrap ${winner === 'mc' ? 'text-emerald-700 text-sm' : 'text-gray-700'}`}>{fmt6(mcPrice)}</td>
                                                <td className="px-3 py-2.5 text-right font-mono text-gray-500 whitespace-nowrap">{fmt6(dr.mcStdPriceUsd)}</td>
                                                <td className="px-3 py-2.5 text-gray-500 whitespace-nowrap">{dr.mcLastPoDate || '—'}</td>
                                              </>
                                            )}
                                            {/* Nexar Market side */}
                                            {(() => {
                                              const candidates = mpnEntries.filter(e => e.bestRow.internalPN === dr.internalPN)
                                              let nexarBest: (typeof mpnNexarMap)[string] | null = null
                                              for (const c of candidates) {
                                                const e = mpnNexarMap[c.mpn]
                                                if (e && (nexarBest == null || (e.nexarBestUsd != null && (nexarBest.nexarBestUsd == null || e.nexarBestUsd < nexarBest.nexarBestUsd))))
                                                  nexarBest = e
                                              }
                                              if (!nexarBest) return (
                                                <td colSpan={6} className="px-3 py-2.5 text-center text-gray-300 text-[10px] border-l border-l-orange-100 bg-orange-50/10">
                                                  {Object.keys(mpnNexarMap).length === 0 ? 'Enable Nexar search' : '—'}
                                                </td>
                                              )
                                              return (
                                                <>
                                                  <td className="px-3 py-2.5 font-mono text-orange-700 whitespace-nowrap border-l border-l-orange-100 bg-orange-50/10">{nexarBest.nexarMpn || '—'}</td>
                                                  <td className="px-3 py-2.5 text-gray-600 max-w-[130px] truncate bg-orange-50/10" title={nexarBest.nexarManufacturer}>{nexarBest.nexarManufacturer || '—'}</td>
                                                  <td className="px-3 py-2.5 text-gray-600 max-w-[130px] truncate bg-orange-50/10" title={nexarBest.nexarSeller}>{nexarBest.nexarSeller || '—'}</td>
                                                  <td className={`px-3 py-2.5 text-right font-mono font-semibold whitespace-nowrap bg-orange-50/10 ${winner === 'nexar' ? 'text-emerald-700 text-sm' : 'text-orange-700'}`}>{fmt6(nexarBest.nexarBestUsd)}</td>
                                                  <td className="px-3 py-2.5 text-right font-mono text-gray-500 whitespace-nowrap bg-orange-50/10">{nexarBest.nexarStock != null ? nexarBest.nexarStock.toLocaleString() : '—'}</td>
                                                  <td className="px-3 py-2.5 text-right font-mono text-gray-500 whitespace-nowrap bg-orange-50/10">{nexarBest.nexarMoq != null ? nexarBest.nexarMoq.toLocaleString() : '—'}</td>
                                                </>
                                              )
                                            })()}
                                            {/* Lytica side */}
                                            {hasLytica && (
                                              lyticaBest == null ? (
                                                <td colSpan={4} className="px-3 py-2.5 text-center text-gray-300 text-[10px] border-l border-l-teal-100 bg-teal-50/10">—</td>
                                              ) : (
                                                <>
                                                  <td className="px-3 py-2.5 font-mono text-teal-700 whitespace-nowrap border-l border-l-teal-100 bg-teal-50/10">{lyticaBest.mpnSearched || '—'}</td>
                                                  <td className="px-3 py-2.5 font-mono text-gray-600 whitespace-nowrap bg-teal-50/10">{lyticaBest.mpnMatched || '—'}</td>
                                                  <td className="px-3 py-2.5 text-gray-600 max-w-[130px] truncate bg-teal-50/10" title={lyticaBest.manufacturerMatched}>{lyticaBest.manufacturerMatched || '—'}</td>
                                                  <td className={`px-3 py-2.5 text-right font-mono font-semibold whitespace-nowrap bg-teal-50/10 ${winner === 'lytica' ? 'text-emerald-700 text-sm' : 'text-teal-700'}`}>{fmt6(lyticaPrice)}</td>
                                                </>
                                              )
                                            )}
                                            {/* QTY Inserted */}
                                            <td className="px-3 py-2.5 text-right font-mono text-gray-600 whitespace-nowrap border-l border-l-gray-200">{qtyIns}</td>
                                            {/* Total (USD) per QTY */}
                                            <td className="px-3 py-2.5 text-right font-mono font-semibold text-indigo-700 whitespace-nowrap border-l border-l-gray-200">{totalUsd != null ? fmt6(totalUsd) : '—'}</td>
                                            {/* Winner */}
                                            <td className="px-3 py-2.5 text-center border-l border-l-gray-200">
                                              {dr.status === 'loading' ? null
                                                : winner === 'mpn'    ? <span className="px-2 py-0.5 text-[10px] font-bold rounded-full bg-emerald-100 text-emerald-700">Multi-MPN</span>
                                                : winner === 'mc'     ? <span className="px-2 py-0.5 text-[10px] font-bold rounded-full bg-purple-100 text-purple-700">Multi-Comp</span>
                                                : winner === 'nexar'  ? <span className="px-2 py-0.5 text-[10px] font-bold rounded-full bg-orange-100 text-orange-700">Nexar</span>
                                                : winner === 'lytica' ? <span className="px-2 py-0.5 text-[10px] font-bold rounded-full bg-teal-100 text-teal-700">Lytica</span>
                                                : winner === 'tie'    ? <span className="px-2 py-0.5 text-[10px] font-bold rounded-full bg-gray-100 text-gray-500">Tie</span>
                                                : null
                                              }
                                            </td>
                                          </tr>
                                        )
                                      })}
                                    </tbody>
                                  </table>
                                </div>
                              </div>
                            )}
                          </div>
                        )}

                        {/* ── Blocked / Deleted sub-tab ── */}
                        {multiMpnSubTab === 'blocked' && (
                          <div>
                            {multiMpnLoading && Object.keys(multiMpnAmplMap).length === 0 ? (
                              <p className="text-sm text-gray-400 py-6 text-center">Fetching AMPL data…</p>
                            ) : blockedGroups.length === 0 ? (
                              <p className="text-sm text-gray-500 py-8 text-center">No blocked or deleted MPNs found for the internal part numbers in this search.</p>
                            ) : (
                              <div className="space-y-4">
                                {blockedGroups.map(group => {
                                  const isDanger = group.code === 'F' || group.code === 'ER'
                                  const seen = new Set<string>()
                                  const dedupedItems = group.items.filter(item => {
                                    const altPn = item.mpnPartNumber && item.mpnPartNumber !== item.mpn ? item.mpnPartNumber : '—'
                                    const key = `${item.internalPN}|${item.mpn}|${altPn}|${item.mfgName || '—'}`
                                    if (seen.has(key)) return false
                                    seen.add(key)
                                    return true
                                  })
                                  return (
                                    <div key={`${group.kind}:${group.code}`}>
                                      {/* Group header */}
                                      <div className={`flex items-center gap-3 px-4 py-2.5 rounded-t-xl border ${isDanger ? 'bg-red-50 border-red-200' : group.kind === 'blocked' ? 'bg-amber-50 border-amber-200' : 'bg-red-50 border-red-200'}`}>
                                        <span className={`text-[11px] font-bold px-2 py-0.5 rounded-full ${isDanger ? 'bg-red-200 text-red-800' : group.kind === 'blocked' ? 'bg-amber-200 text-amber-800' : 'bg-red-200 text-red-800'}`}>
                                          {group.kind === 'blocked' ? 'BLOCKED' : 'DELETED'}
                                        </span>
                                        <span className="font-mono font-bold text-sm text-gray-800">{group.code}</span>
                                        <span className="text-gray-600 text-sm flex-1">{group.reason}</span>
                                        <span className="text-xs text-gray-500 bg-white border border-gray-200 rounded-full px-2 py-0.5">{dedupedItems.length} MPN{dedupedItems.length !== 1 ? 's' : ''}</span>
                                      </div>
                                      {/* Items table */}
                                      <div className="overflow-x-auto border border-t-0 border-gray-200 rounded-b-xl">
                                        <table className="min-w-max w-full text-xs">
                                          <thead className="bg-gray-50 text-[10px] uppercase tracking-wide text-gray-500">
                                            <tr>
                                              <th className="px-3 py-2 text-left border-b border-gray-200 whitespace-nowrap">Internal PN</th>
                                              <th className="px-3 py-2 text-left border-b border-gray-200 whitespace-nowrap">MPN</th>
                                              <th className="px-3 py-2 text-left border-b border-gray-200 whitespace-nowrap">Alt PN</th>
                                              <th className="px-3 py-2 text-left border-b border-gray-200 whitespace-nowrap">Manufacturer</th>
                                            </tr>
                                          </thead>
                                          <tbody className="divide-y divide-gray-100">
                                            {dedupedItems.map((item, idx) => (
                                              <tr key={idx} className="hover:bg-gray-50">
                                                <td className="px-3 py-1.5 font-mono font-semibold text-blue-700 whitespace-nowrap">{item.internalPN}</td>
                                                <td className="px-3 py-1.5 font-mono text-gray-700 whitespace-nowrap">{item.mpn}</td>
                                                <td className="px-3 py-1.5 font-mono text-gray-500 whitespace-nowrap">{item.mpnPartNumber && item.mpnPartNumber !== item.mpn ? item.mpnPartNumber : '—'}</td>
                                                <td className="px-3 py-1.5 text-gray-600">{item.mfgName || '—'}</td>
                                              </tr>
                                            ))}
                                          </tbody>
                                        </table>
                                      </div>
                                    </div>
                                  )
                                })}
                              </div>
                            )}
                          </div>
                        )}
                      </div>
                    )
                  })()}
                </div>
              )}
            </div>
          </div>
        </div>
      )}
    </>
  )
}
