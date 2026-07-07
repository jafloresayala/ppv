// src/components/PriceCalculatorWidget.tsx
// Floating Price Calculator widget — wraps conexion_internalquery functionality
import { useState, useCallback, useMemo, useRef, useEffect } from 'react'
import { Calculator, X, Pin, ChevronDown, ChevronUp, ExternalLink, Download } from 'lucide-react'
import DbJobButton from './DbJobButton'
import DataGrid, { type DataGridColumn } from './DataGrid'
import SupplierComparePanel, { type CompareRecord, type DemandRow } from './SupplierComparePanel'
import FullQuoteDataTab from './FullQuoteDataTab'
import { lookupMpnBest, resolveMpnBest, resolveDeep, lookupDemand, lookupDemandFull, type MpnBestEntry, type DemandFullResponse } from '../api/client'

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

// ── Feature flag: Nexar Market integration ───────────────────────────────────
// Temporarily disabled to save Nexar API requests. While false the "Include
// Nexar Market" toggles are hidden, no Nexar queries are issued, and the Nexar
// columns in Deep Analysis are not rendered. Flip back to `true` to restore.
const NEXAR_ENABLED = false

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
      { header: 'Nexar MPN',               key: 'nexarMpn',     width: 24 },
      { header: 'Nexar Manufacturer',      key: 'nexarMfr',     width: 28 },
      { header: 'Nexar Seller',            key: 'nexarSeller',  width: 28 },
      { header: 'Nexar Price (USD)',        key: 'nexarPrice',   width: 18 },
      { header: 'Nexar Stock',             key: 'nexarStock',   width: 14 },
      { header: 'Nexar MOQ',               key: 'nexarMoq',     width: 12 },
      { header: 'Winner',                  key: 'winner',       width: 14 },
    ]
    styleHeader(ws)
    ws.autoFilter = `A1:W1`
    deepAnalysisRows.filter(dr => dr.status === 'done').forEach((dr, i) => {
      const candidates = mpnEntries.filter(e => e.bestRow.internalPN === dr.internalPN)
      const mpnBest    = candidates.reduce<typeof mpnEntries[0] | null>((min, e) => {
        const p = resolveLastPoPrice(e.bestRow), mp = min ? resolveLastPoPrice(min.bestRow) : null
        return p == null ? min : mp == null ? e : p < mp ? e : min
      }, null)
      const mpnPrice = mpnBest ? resolveLastPoPrice(mpnBest.bestRow) : null
      const mcPrice  = dr.mcBestPriceUsd
      // Best Nexar entry across all MPNs belonging to this internal PN
      let nexarEntry: (typeof ctx.mpnNexarMap)[string] | null = null
      for (const cand of candidates) {
        const nx = ctx.mpnNexarMap[cand.mpn] ?? ctx.mpnNexarMap[cand.mpn.toUpperCase()]
        if (nx?.nexarBestUsd != null && (nexarEntry?.nexarBestUsd == null || nx.nexarBestUsd < nexarEntry.nexarBestUsd))
          nexarEntry = nx
      }
      const nexarPrice = nexarEntry?.nexarBestUsd ?? null
      const qtyIns   = ctx.mpnComponentQtys[mpnBest?.mpn ?? ''] ?? ctx.qty
      // Winner considers all three sources
      const priceCands: Array<[string, number]> = []
      if (mpnPrice   != null) priceCands.push(['Multi-MPN', mpnPrice])
      if (mcPrice    != null) priceCands.push(['Multi-Comp', mcPrice])
      if (nexarPrice != null) priceCands.push(['Nexar', nexarPrice])
      let winner = ''
      let winnerPrice: number | null = null
      if (priceCands.length > 0) {
        const minP = Math.min(...priceCands.map(([, p]) => p))
        const mins = priceCands.filter(([, p]) => p === minP)
        winner = mins.length === 1 ? mins[0][0] : 'Tie'
        winnerPrice = minP
      }
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
        nexarMpn:     nexarEntry?.nexarMpn || '',
        nexarMfr:     nexarEntry?.nexarManufacturer || '',
        nexarSeller:  nexarEntry?.nexarSeller || '',
        nexarPrice:   nexarPrice ?? '',
        nexarStock:   nexarEntry?.nexarStock ?? '',
        nexarMoq:     nexarEntry?.nexarMoq ?? '',
        winner,
      })
      row.height = 18
      const isNexarWin = winner === 'Nexar'
      const bg = winner === 'Multi-MPN' ? 'FFD1FAE5' : winner === 'Multi-Comp' ? 'FFEDE9FE' : isNexarWin ? 'FFFEF3C7' : i % 2 === 0 ? 'FFFFFFFF' : 'FFF8FAFC'
      row.eachCell({ includeEmpty: true }, (cell: any) => {
        cell.fill      = { type: 'pattern', pattern: 'solid', fgColor: { argb: bg } }
        cell.font      = { size: 9, name: 'Calibri' }
        cell.alignment = { vertical: 'middle' }
        cell.border    = { bottom: { style: 'thin', color: { argb: 'FFE5E7EB' } } }
      })
      for (const k of ['mpnPrice', 'mpnStd', 'mcPrice', 'mcStd', 'totalUsd', 'nexarPrice']) {
        const c = row.getCell(k)
        c.alignment = { horizontal: 'right', vertical: 'middle' }
        if (c.value !== '' && c.value != null) c.numFmt = '#,##0.000000'
      }
      row.getCell('qtyIns').alignment = { horizontal: 'right', vertical: 'middle' }
      if (row.getCell('qtyIns').value != null) row.getCell('qtyIns').numFmt = '#,##0'
      for (const k of ['nexarStock', 'nexarMoq']) {
        const c = row.getCell(k)
        c.alignment = { horizontal: 'right', vertical: 'middle' }
        if (c.value !== '' && c.value != null) c.numFmt = '#,##0'
      }
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
      } else if (isNexarWin) {
        wc.font = { bold: true, size: 9, name: 'Calibri', color: { argb: 'FF7C2D12' } }
        row.getCell('nexarPrice').font = { bold: true, size: 9, name: 'Calibri', color: { argb: 'FF7C2D12' } }
        row.getCell('totalUsd').font   = { bold: true, size: 9, name: 'Calibri', color: { argb: 'FF7C2D12' } }
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

// ── AMPL Demand: Excel export ─────────────────────────────────────────────
// ── AMPL Demand: Excel export ─────────────────────────────────────────────
async function downloadAmplResultsExcel(
  amplHeaders: string[],
  amplRows: Array<(string | number | null)[]>,
  amplMpnColIdx: number,
  amplIqRows: IQItem[],
  amplDeepRows: DeepAnalysisRow[],
  amplNexarMap: Record<string, { nexarBestUsd: number | null; nexarSeller: string; nexarManufacturer: string; nexarStock: number | null; nexarMoq: number | null; nexarMpn: string }>,
  amplLyticaMap: Record<string, { mpnMatched: string; manufacturerMatched: string; price90th: number | null }>,
  windowDaysVal: number,
  filename: string,
): Promise<void> {
  // Build MPN→best row lookup (same window logic as Multi-MPN)
  const mpnGroupsMap = new Map<string, IQItem[]>()
  for (const r of amplIqRows) {
    if (!mpnGroupsMap.has(r.mpn)) mpnGroupsMap.set(r.mpn, [])
    mpnGroupsMap.get(r.mpn)!.push(r)
  }
  const mpnBestMap = new Map<string, IQItem>()
  mpnGroupsMap.forEach((rows, mpn) => {
    const valid = rows.filter(r => r.lastPoDate && !isNaN(new Date(r.lastPoDate).getTime()))
    if (!valid.length) return
    const maxT = Math.max(...valid.map(r => new Date(r.lastPoDate).getTime()))
    const windowStart = new Date(maxT - windowDaysVal * 86400000)
    const inWindow = valid.filter(r => new Date(r.lastPoDate).getTime() >= windowStart.getTime())
    const best = inWindow.reduce<IQItem>((min, r) => {
      const p = resolveLastPoPrice(r), mp = resolveLastPoPrice(min)
      if (p == null) return min; if (mp == null) return r; return p < mp ? r : min
    }, inWindow[0])
    mpnBestMap.set(mpn.toUpperCase(), best)
  })

  const ipToDeepRow = new Map<string, DeepAnalysisRow>()
  for (const dr of amplDeepRows.filter(d => d.status === 'done')) ipToDeepRow.set(dr.internalPN, dr)

  const hasNexar  = Object.keys(amplNexarMap).length > 0
  const hasLytica = Object.keys(amplLyticaMap).length > 0

  const extraHeaders: string[] = [
    'SAP - Internal PN', 'SAP - MPN', 'SAP - Plant', 'SAP - Supplier',
    'SAP - Best Last PO Interplants', 'SAP - STD Price', 'SAP - Date',
    ...(hasNexar  ? ['Nexar - MPN','Nexar - Manufacturer','Nexar - Supplier','Nexar - Unit Price (USD)','Nexar - Stock','Nexar - MOQ'] : []),
    ...(hasLytica ? ['Lytica - MPN Searched','Lytica - MPN Matched','Lytica - Manufacturer Matched','Lytica - 90th %tile'] : []),
    'Best Source', 'Best Price',
  ]

  const ExcelJS = (await import('exceljs')).default
  const wb = new ExcelJS.Workbook()
  wb.creator = 'PPV Dashboard'
  wb.created = new Date()
  const ws = wb.addWorksheet('AMPL + PPV Results', { views: [{ state: 'frozen', ySplit: 1 }] })
  const colWidth = (h: string) => Math.min(Math.max((h?.length ?? 0) + 4, 10), 40)
  ws.columns = [
    ...amplHeaders.map((h, i) => ({ header: h || `Col${i + 1}`, key: `c${i}`, width: colWidth(h) })),
    ...extraHeaders.map(h => ({ header: h, key: h, width: h.startsWith('Nexar') || h.startsWith('Lytica') ? 26 : 24 })),
  ]

  const totalCols      = amplHeaders.length + extraHeaders.length
  const lpoColN        = amplHeaders.length + extraHeaders.indexOf('SAP - Best Last PO Interplants') + 1
  const stdColN        = amplHeaders.length + extraHeaders.indexOf('SAP - STD Price') + 1
  const nexarPriceColN = hasNexar  ? amplHeaders.length + extraHeaders.indexOf('Nexar - Unit Price (USD)') + 1 : -1
  const lytica90ColN   = hasLytica ? amplHeaders.length + extraHeaders.indexOf('Lytica - 90th %tile') + 1 : -1
  const bestSrcColN    = amplHeaders.length + extraHeaders.indexOf('Best Source') + 1
  const bestPriceColN  = amplHeaders.length + extraHeaders.indexOf('Best Price') + 1

  const hdr = ws.getRow(1)
  hdr.height = 24
  hdr.eachCell({ includeEmpty: true }, (cell, cn) => {
    const isAmpl   = cn <= amplHeaders.length
    const isNexar2 = nexarPriceColN > 0 && cn >= nexarPriceColN - 3 && cn <= nexarPriceColN + 2
    const isLyt    = lytica90ColN > 0 && cn >= lytica90ColN - 3 && cn <= lytica90ColN
    const isBest   = cn === bestSrcColN || cn === bestPriceColN
    const bg     = isAmpl ? 'FF1E3A5F' : isNexar2 ? 'FF7C2D12' : isLyt ? 'FF0F766E' : isBest ? 'FF0C4A6E' : 'FF065F46'
    const border = isAmpl ? 'FF2563EB' : isNexar2 ? 'FFDC2626' : isLyt ? 'FF14B8A6' : isBest ? 'FF0EA5E9' : 'FF059669'
    cell.fill      = { type: 'pattern', pattern: 'solid', fgColor: { argb: bg } }
    cell.font      = { bold: true, color: { argb: 'FFFFFFFF' }, size: 10, name: 'Calibri' }
    cell.alignment = { horizontal: 'center', vertical: 'middle', wrapText: false }
    cell.border    = { bottom: { style: 'medium', color: { argb: border } }, right: { style: 'thin', color: { argb: 'FF374151' } } }
  })
  ws.autoFilter = `A1:${ws.getColumn(totalCols).letter}1`

  // ── Analysis accumulators ────────────────────────────────────────────────
  type ARow = { mpn: string; internalPN: string; supplier: string; plant: string; bestSource: string; bestPrice: number | null }
  let statTotal = 0, statNotFound = 0, statSAP = 0, statNexar = 0, statLytica = 0, statTie = 0
  const analysisRows: ARow[] = []

  amplRows.forEach((row, i) => {
    const mpnRaw  = String(row[amplMpnColIdx] ?? '').trim()
    const sapBest = mpnBestMap.get(mpnRaw.toUpperCase()) ?? null
    const ip      = sapBest?.internalPN ?? ''
    const deepRow = ip ? ipToDeepRow.get(ip) : null

    // Prefer Deep Analysis winner when available
    let sapPrice    = sapBest ? resolveLastPoPrice(sapBest) : null
    let sapStd      = sapBest?.standardPriceUsd ?? null
    let sapPlant    = sapBest?.siteName ?? ''
    let sapSupplier = (sapBest?.supplierName || sapBest?.englishName) ?? ''
    let sapMpn      = sapBest?.mpn ?? ''
    let sapIP       = sapBest?.internalPN ?? ''
    let sapDate     = sapBest?.lastPoDate ?? ''
    if (deepRow) {
      const mcP = deepRow.mcBestPriceUsd
      if (mcP != null && (sapPrice == null || mcP < sapPrice)) {
        sapPrice = mcP; sapStd = deepRow.mcStdPriceUsd; sapPlant = deepRow.mcBestPlant
        sapSupplier = deepRow.mcBestSupplier; sapMpn = deepRow.mcBestMpn
        sapIP = deepRow.mcBestInternalPN; sapDate = deepRow.mcLastPoDate
      }
    }

    const nexarEntry  = amplNexarMap[mpnRaw.toUpperCase()] ?? amplNexarMap[mpnRaw] ?? null
    const lyticaEntry = amplLyticaMap[mpnRaw.toUpperCase()] ?? amplLyticaMap[mpnRaw] ?? null

    type WS = 'sap' | 'nexar' | 'lytica' | 'tie'
    const cands: Array<[WS, number]> = []
    if (sapPrice != null)                cands.push(['sap', sapPrice])
    if (nexarEntry?.nexarBestUsd != null) cands.push(['nexar', nexarEntry.nexarBestUsd])
    if (lyticaEntry?.price90th != null)  cands.push(['lytica', lyticaEntry.price90th])

    let winSrc: WS | null = null; let winPrice: number | null = null
    if (cands.length > 0) {
      const minP = Math.min(...cands.map(([, p]) => p))
      const mins = cands.filter(([, p]) => p === minP)
      winSrc   = mins.length === 1 ? mins[0][0] : 'tie'
      winPrice = minP
    }

    const bestSrcLabel = winSrc === 'sap' ? 'SAP' : winSrc === 'nexar' ? 'NEXAR MARKET' : winSrc === 'lytica' ? 'LYTICA' : winSrc === 'tie' ? 'TIE' : 'Not Found'
    const anyFound = sapBest != null || nexarEntry != null || lyticaEntry != null
    const noPrice  = winSrc === null

    // Accumulate stats
    statTotal++
    if (!anyFound || noPrice) statNotFound++
    else if (winSrc === 'sap')    statSAP++
    else if (winSrc === 'nexar')  statNexar++
    else if (winSrc === 'lytica') statLytica++
    else if (winSrc === 'tie')    statTie++

    analysisRows.push({
      mpn: sapMpn || mpnRaw, internalPN: sapIP,
      supplier: sapSupplier || nexarEntry?.nexarSeller || '',
      plant: sapPlant, bestSource: bestSrcLabel, bestPrice: winPrice,
    })

    const extraValues: (string | number | null)[] = anyFound ? [
      sapIP || 'Not Found', sapMpn || mpnRaw,
      sapPlant || 'Not Found', sapSupplier || 'Not Found',
      sapPrice ?? 'Not Found', sapStd ?? 'Not Found', sapDate || 'Not Found',
      ...(hasNexar  ? [nexarEntry?.nexarMpn||'Not Found', nexarEntry?.nexarManufacturer||'Not Found', nexarEntry?.nexarSeller||'Not Found', nexarEntry?.nexarBestUsd??'Not Found', nexarEntry?.nexarStock??'Not Found', nexarEntry?.nexarMoq??'Not Found'] : []),
      ...(hasLytica ? [mpnRaw, lyticaEntry?.mpnMatched||'Not Found', lyticaEntry?.manufacturerMatched||'Not Found', lyticaEntry?.price90th??'Not Found'] : []),
      bestSrcLabel, winPrice ?? 'Not Found',
    ] : Array(extraHeaders.length).fill('Not Found') as string[]

    const dr = ws.addRow([...row.map(v => v ?? ''), ...extraValues])
    dr.height = 18
    const notFound = !anyFound || noPrice
    const bgColor  = notFound ? 'FFFFF9C4' : i % 2 === 0 ? 'FFFFFFFF' : 'FFF8FAFC'
    dr.eachCell({ includeEmpty: true }, cell => {
      cell.fill      = { type: 'pattern', pattern: 'solid', fgColor: { argb: bgColor } }
      cell.font      = { size: 9, name: 'Calibri' }
      cell.alignment = { vertical: 'middle' }
      cell.border    = { bottom: { style: 'thin', color: { argb: 'FFE5E7EB' } } }
    })
    for (const cn of [lpoColN, stdColN]) {
      const c = dr.getCell(cn); c.alignment = { horizontal: 'right', vertical: 'middle' }
      if (typeof c.value === 'number') c.numFmt = '#,##0.000000'
    }
    if (nexarPriceColN > 0) { const c = dr.getCell(nexarPriceColN); c.alignment = { horizontal: 'right', vertical: 'middle' }; if (typeof c.value === 'number') c.numFmt = '#,##0.000000' }
    if (lytica90ColN > 0)   { const c = dr.getCell(lytica90ColN);   c.alignment = { horizontal: 'right', vertical: 'middle' }; if (typeof c.value === 'number') c.numFmt = '#,##0.000000' }
    { const c = dr.getCell(bestSrcColN); c.alignment = { horizontal: 'center', vertical: 'middle' }; c.font = { size: 9, name: 'Calibri', bold: true }
      if (notFound) { c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFFF9C4' } }; c.font = { size: 9, name: 'Calibri', bold: true, color: { argb: 'FF92400E' }, italic: true } } }
    { const c = dr.getCell(bestPriceColN); c.alignment = { horizontal: 'right', vertical: 'middle' }; if (typeof c.value === 'number') { c.numFmt = '#,##0.000000'; c.font = { size: 9, name: 'Calibri', bold: true, color: { argb: 'FF0C4A6E' } } } }
    if (notFound) {
      for (let j = amplHeaders.length + 1; j <= totalCols; j++)
        dr.getCell(j).font = { size: 9, name: 'Calibri', color: { argb: 'FF9CA3AF' }, italic: true }
    }
  })

  // ── Analysis Sheet ────────────────────────────────────────────────────────
  const wa = wb.addWorksheet('Analysis', { views: [{ showGridLines: false }] })

  const addCell = (
    row: number, col: number, value: string | number | Date | null,
    opts?: { bold?: boolean; bg?: string; font?: string; numFmt?: string; align?: 'left'|'center'|'right'; size?: number; italic?: boolean }
  ) => {
    const c = wa.getCell(row, col)
    c.value = value
    if (opts?.numFmt) c.numFmt = opts.numFmt
    c.font      = { name: 'Calibri', size: opts?.size ?? 10, bold: opts?.bold, italic: opts?.italic, color: { argb: opts?.font ?? 'FF111827' } }
    c.alignment = { horizontal: opts?.align ?? 'left', vertical: 'middle' }
    if (opts?.bg) c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: opts.bg } }
    c.border = { bottom: { style: 'thin', color: { argb: 'FFE5E7EB' } }, right: { style: 'thin', color: { argb: 'FFE5E7EB' } } }
    return c
  }

  const sectionTitle = (row: number, title: string, bgArgb: string) => {
    wa.mergeCells(row, 1, row, 8)
    const c = wa.getCell(row, 1)
    c.value     = title
    c.font      = { name: 'Calibri', size: 12, bold: true, color: { argb: 'FFFFFFFF' } }
    c.fill      = { type: 'pattern', pattern: 'solid', fgColor: { argb: bgArgb } }
    c.alignment = { horizontal: 'left', vertical: 'middle', indent: 1 }
    wa.getRow(row).height = 26
  }

  let r = 1
  sectionTitle(r++, '📊  AMPL Demand Analysis Summary', 'FF1E3A5F')
  addCell(r, 1, 'Generated:', { bold: true, bg: 'FFF1F5F9' })
  wa.mergeCells(r, 2, r, 5); addCell(r, 2, new Date().toLocaleString(), { bg: 'FFF1F5F9' })
  wa.getRow(r).height = 18; r++
  addCell(r, 1, 'File:', { bold: true, bg: 'FFF1F5F9' })
  wa.mergeCells(r, 2, r, 5); addCell(r, 2, filename, { bg: 'FFF1F5F9' })
  wa.getRow(r).height = 18; r++
  r++

  // ── Row Classification ───────────────────────────────────────────────────
  sectionTitle(r++, '🔢  Row Classification', 'FF1E3A5F')
  const statFound = statSAP + statNexar + statLytica + statTie
  addCell(r, 1, 'Category',   { bold: true, bg: 'FF334155', font: 'FFFFFFFF', align: 'center' })
  addCell(r, 2, 'Count',      { bold: true, bg: 'FF334155', font: 'FFFFFFFF', align: 'center' })
  addCell(r, 3, '% of Total', { bold: true, bg: 'FF334155', font: 'FFFFFFFF', align: 'center' })
  wa.getRow(r).height = 20; r++

  const pct = (n: number) => statTotal > 0 ? `${+(n / statTotal * 100).toFixed(1)}%` : '0%'
  const classRows: [string, number, string, string][] = [
    ['Total AMPL rows',  statTotal,    'FF374151', 'FFFFFFFF'],
    ['Found ✅',         statFound,    'FF166534', 'FFD1FAE5'],
    ['Not Found ⚪',     statNotFound, 'FF92400E', 'FFFFF9C4'],
  ]
  for (const [label, count, fontArgb, bg] of classRows) {
    addCell(r, 1, label, { bg, font: fontArgb, bold: label === 'Total AMPL rows' })
    addCell(r, 2, count, { bg, align: 'center', bold: true, font: fontArgb })
    addCell(r, 3, pct(count), { bg, align: 'center' })
    wa.getRow(r).height = 18; r++
  }
  r++

  // ── Best Source Breakdown ────────────────────────────────────────────────
  sectionTitle(r++, '🏆  Best Source Breakdown', 'FF065F46')
  addCell(r, 1, 'Source',     { bold: true, bg: 'FF334155', font: 'FFFFFFFF', align: 'center' })
  addCell(r, 2, 'Count',      { bold: true, bg: 'FF334155', font: 'FFFFFFFF', align: 'center' })
  addCell(r, 3, '% of Total', { bold: true, bg: 'FF334155', font: 'FFFFFFFF', align: 'center' })
  wa.getRow(r).height = 20; r++

  const sourceRows: [string, number, string, string][] = [
    ['SAP',          statSAP,    'FF065F46', 'FFD1FAE5'],
    ['Nexar Market', statNexar,  'FF7C2D12', 'FFFEF3C7'],
    ['Lytica',       statLytica, 'FF0F766E', 'FFCFFAFE'],
    ['Tie',          statTie,    'FF374151', 'FFF3F4F6'],
    ['Not Found',    statNotFound,'FF92400E','FFFFF9C4'],
  ]
  for (const [label, count, fontArgb, bg] of sourceRows) {
    if (!hasNexar && label === 'Nexar Market') continue
    if (!hasLytica && label === 'Lytica') continue
    addCell(r, 1, label, { bg, font: fontArgb, bold: true })
    addCell(r, 2, count, { bg, align: 'center', bold: true, font: fontArgb })
    addCell(r, 3, pct(count), { bg, align: 'center' })
    wa.getRow(r).height = 18; r++
  }
  r++

  // ── Top 10 Best Prices ───────────────────────────────────────────────────
  const TOP = 10
  const cheapest = [...analysisRows]
    .filter(a => a.bestPrice != null)
    .sort((a, b) => a.bestPrice! - b.bestPrice!)

  sectionTitle(r++, `💰  Top ${TOP} Lowest Best Prices`, 'FF0C4A6E')
  const priceHdrs: [string, number][] = [
    ['#', 4], ['MPN', 28], ['Internal PN', 22], ['Supplier', 30],
    ['Plant', 12], ['Best Source', 16], ['Best Price (USD)', 20],
  ]
  priceHdrs.forEach(([h, w], ci) => {
    wa.getColumn(ci + 1).width = Math.max((wa.getColumn(ci + 1).width as number) ?? 0, w)
    addCell(r, ci + 1, h, { bold: true, bg: 'FF334155', font: 'FFFFFFFF', align: 'center' })
  })
  wa.getRow(r).height = 20; r++
  cheapest.slice(0, TOP).forEach((item, idx) => {
    addCell(r, 1, idx + 1,        { bg: 'FFD1FAE5', align: 'center', bold: true })
    addCell(r, 2, item.mpn,       { bg: 'FFD1FAE5', font: 'FF065F46', bold: true })
    addCell(r, 3, item.internalPN || '—', { bg: 'FFD1FAE5' })
    addCell(r, 4, item.supplier || '—',   { bg: 'FFD1FAE5' })
    addCell(r, 5, item.plant || '—',      { bg: 'FFD1FAE5', align: 'center' })
    addCell(r, 6, item.bestSource,        { bg: 'FFD1FAE5', align: 'center', bold: true })
    addCell(r, 7, item.bestPrice,         { bg: 'FFD1FAE5', align: 'right', numFmt: '#,##0.000000', bold: true, font: 'FF0C4A6E' })
    wa.getRow(r).height = 18; r++
  })
  r++

  // ── Not Found list ───────────────────────────────────────────────────────
  const notFoundRows = analysisRows.filter(a => a.bestSource === 'Not Found')
  if (notFoundRows.length > 0) {
    sectionTitle(r++, `⚠️  Not Found MPNs (${notFoundRows.length})`, 'FF92400E')
    addCell(r, 1, '#',   { bold: true, bg: 'FF334155', font: 'FFFFFFFF', align: 'center' })
    addCell(r, 2, 'MPN', { bold: true, bg: 'FF334155', font: 'FFFFFFFF' })
    wa.getRow(r).height = 20; r++
    notFoundRows.slice(0, 50).forEach((item, idx) => {
      addCell(r, 1, idx + 1,  { bg: 'FFFFF9C4', align: 'center' })
      addCell(r, 2, item.mpn, { bg: 'FFFFF9C4', font: 'FF92400E', italic: true })
      wa.getRow(r).height = 16; r++
    })
    if (notFoundRows.length > 50) { addCell(r, 2, `… and ${notFoundRows.length - 50} more`, { italic: true, font: 'FF9CA3AF' }); r++ }
  }

  wa.getColumn(1).width = 5
  wa.getColumn(2).width = 30
  wa.getColumn(3).width = 22
  wa.getColumn(4).width = 32
  wa.getColumn(5).width = 14
  wa.getColumn(6).width = 18
  wa.getColumn(7).width = 22
  wa.getColumn(8).width = 22

  const buffer = await wb.xlsx.writeBuffer()
  const blob = new Blob([buffer], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a'); a.href = url; a.download = filename; a.click()
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
  const [activeTab, setActiveTab]         = useState<'single' | 'multi' | 'mpn' | 'ampl' | 'fullquote'>('single')
  const [multiBmatn, setMultiBmatn]       = useState('')
  const [multiResults, setMultiResults]   = useState<MultiResult[]>([])
  const [multiLoading, setMultiLoading]   = useState(false)
  const [multiSubTab, setMultiSubTab]     = useState<'results' | 'allrecords' | 'blocked' | 'deep'>('results')
  const [myPlant, setMyPlant]             = useState<string>('')
  const [windowDays, setWindowDays]       = useState(45)
  const [searchMode, setSearchMode]       = useState<'internal' | 'mpn'>('internal')
  // Forced off while NEXAR_ENABLED is false (temporary: saving Nexar API calls).
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
  // Cooperative stop for the MPN Numbers search: instead of aborting the request
  // in flight, we let the current chunk finish and then stop the loop cleanly.
  const stopMpnRef = useRef(false)
  const [multiMpnSubTab, setMultiMpnSubTab]                           = useState<'results' | 'allrecords' | 'blocked' | 'deep'>('results')
  const [multiMpnAmplMap, setMultiMpnAmplMap]                         = useState<Record<string, AmplResponse>>({})
  const [multiMpnExpandedMpns, setMultiMpnExpandedMpns]               = useState<Set<string>>(new Set())
  // ── Supplier-comparison panel (per-MPN, per-plant savings analysis) ───────
  // Opened by clicking a row in the IQ Results grid. Holds the clicked MPN +
  // its full set of raw records so we can compare suppliers within a plant.
  const [mpnCompare, setMpnCompare]                                   = useState<{ mpn: string; allRows: IQItem[] } | null>(null)
  // Demand (Total EAU / Onhand / Gross Demand) for the MPN open in the compare panel
  const [mpnCompareDemand, setMpnCompareDemand]                       = useState<DemandRow[]>([])
  const [mpnCompareDemandLoading, setMpnCompareDemandLoading]         = useState(false)

  // Fetch demand for the MPN whenever the Supplier Savings panel opens.
  useEffect(() => {
    if (!mpnCompare) { setMpnCompareDemand([]); return }
    let cancelled = false
    setMpnCompareDemandLoading(true)
    setMpnCompareDemand([])
    // Look up by the searched MPN and the resolved best MPN(s) of the records.
    const mpnKeys = [...new Set([
      mpnCompare.mpn,
      ...mpnCompare.allRows.map(r => r.mpn).filter(Boolean),
    ])]
    lookupDemand(mpnKeys)
      .then(res => {
        if (cancelled) return
        // Keep EVERY demand row (do NOT de-duplicate by plant): a plant can have
        // several rows for the same MPN, and dropping them undercounts the
        // Total EAU / Onhand / Gross Demand totals. The panel sums all rows.
        const all: DemandRow[] = []
        for (const rows of Object.values(res.results)) all.push(...rows)
        setMpnCompareDemand(all)
      })
      .catch(() => { if (!cancelled) setMpnCompareDemand([]) })
      .finally(() => { if (!cancelled) setMpnCompareDemandLoading(false) })
    return () => { cancelled = true }
  }, [mpnCompare])

  // Deep Analysis pagination (keeps the rich grouped table fast for large sets)
  const [deepPage, setDeepPage]                                       = useState(0)
  const DEEP_PAGE_SIZE = 25
  const [mpnNexarMap, setMpnNexarMap]                                 = useState<Record<string, { nexarBestUsd: number | null; nexarSeller: string; nexarManufacturer: string; nexarStock: number | null; nexarMoq: number | null; nexarMpn: string }>>({})
  // ── DB best-price cache (SQLite, populated by the daily job) ──────────────
  const [mpnDbBestMap, setMpnDbBestMap]                               = useState<Record<string, MpnBestEntry>>({})
  // Per-MPN resolution status for the DB-first flow: pending = computing in real time
  const [mpnStatusMap, setMpnStatusMap]                               = useState<Record<string, 'pending' | 'done' | 'error'>>({})
  // Which searched MPNs were already in the DB cache (instant) vs queried for the
  // first time this session (uncached). Drives the split between the two tables.
  const [mpnFromCacheSet, setMpnFromCacheSet]                         = useState<Set<string>>(new Set())
  const [deepAnalysisRows, setDeepAnalysisRows]                       = useState<DeepAnalysisRow[]>([])
  const [deepAnalysisLoading, setDeepAnalysisLoading]                 = useState(false)
  const abortDeepRef = useRef<AbortController | null>(null)

  // ── CBOM upload state ─────────────────────────────────────────────────────
  const [cbomRows, setCbomRows]           = useState<Array<(string | number | null)[]>>([])
  const [cbomFileName, setCbomFileName]   = useState<string>('')
  const [cbomHeaders, setCbomHeaders]     = useState<string[]>([])
  const [cbomMpnColIdx, setCbomMpnColIdx] = useState<number>(-1)
  const [cbomMpnList, setCbomMpnList]     = useState<string[]>([])
  const [showMpnMenu, setShowMpnMenu]     = useState(false)

  // ── Lytica upload state ───────────────────────────────────────────────────
  const [lyticaMap, setLyticaMap]         = useState<Record<string, { mpnMatched: string; manufacturerMatched: string; price90th: number | null }>>({})
  const [lyticaFileName, setLyticaFileName] = useState<string>('')

  // ── AMPL Demand tab state ─────────────────────────────────────────────────
  const [amplDemandRows, setAmplDemandRows]           = useState<Array<(string | number | null)[]>>([])
  const [amplDemandHeaders, setAmplDemandHeaders]     = useState<string[]>([])
  const [amplDemandFileName, setAmplDemandFileName]   = useState<string>('')
  const [amplDemandMpnColIdx, setAmplDemandMpnColIdx] = useState<number>(-1)
  const [amplDemandSearchedList, setAmplDemandSearchedList]   = useState<string[]>([])
  const [amplDemandRawResults, setAmplDemandRawResults]       = useState<IQItem[]>([])
  const [amplDemandAmplMap, setAmplDemandAmplMap]             = useState<Record<string, AmplResponse>>({})
  const [amplDemandNexarMap, setAmplDemandNexarMap]           = useState<Record<string, { nexarBestUsd: number | null; nexarSeller: string; nexarManufacturer: string; nexarStock: number | null; nexarMoq: number | null; nexarMpn: string }>>({})
  const [amplDemandDbBestMap, setAmplDemandDbBestMap]         = useState<Record<string, MpnBestEntry>>({})
  const [amplDemandStatusMap, setAmplDemandStatusMap]         = useState<Record<string, 'pending' | 'done' | 'error'>>({})
  const [amplDemandDeepRows, setAmplDemandDeepRows]           = useState<DeepAnalysisRow[]>([])
  const [amplDemandLoading, setAmplDemandLoading]             = useState(false)
  const [amplDemandDeepLoading, setAmplDemandDeepLoading]     = useState(false)
  const [amplDemandSubTab, setAmplDemandSubTab]               = useState<'results' | 'deep'>('results')
  const [stopAmplDemandHover, setStopAmplDemandHover]         = useState(false)
  const abortAmplDemandRef    = useRef<AbortController | null>(null)
  const abortAmplDemandDeepRef = useRef<AbortController | null>(null)
  // ── AMPL Demand: multi-sheet picker + missing-cols alert + Lytica export ──

  // ── Full Quote Data tab state (all demand database rows with procedural pagination) ──
  const [fullQuoteData, setFullQuoteData]                               = useState<DemandFullResponse | null>(null)
  const [fullQuoteLoading, setFullQuoteLoading]                         = useState(false)
  const [fullQuoteDataCache, setFullQuoteDataCache]                     = useState<DemandFullResponse | null>(null)
  const abortFullQuoteRef                                               = useRef<AbortController | null>(null)

  // Fetch full demand database when the Full Quote Data tab is opened.
  // Data is cached in session memory and reused on tab re-entry to avoid reloading.
  useEffect(() => {
    if (activeTab !== 'fullquote') {
      return
    }
    // Use cached data if available
    if (fullQuoteDataCache !== null) {
      setFullQuoteData(fullQuoteDataCache)
      return
    }
    // Skip if already loading
    if (fullQuoteLoading) return
    
    let cancelled = false
    setFullQuoteLoading(true)
    console.log('[FullQuoteData] Fetching with lookupDemandFull([])')
    lookupDemandFull([]) // Empty array to get ALL rows
      .then(res => {
        if (cancelled) return
        console.log('[FullQuoteData] Full raw response:', res)
        console.log('[FullQuoteData] Response analysis:', {
          hasColumns: !!res?.columns,
          columnCount: Array.isArray(res?.columns) ? res.columns.length : 'not array',
          hasResults: !!res?.results,
          resultsIsArray: Array.isArray(res?.results),
          resultsKeys: !Array.isArray(res?.results) ? Object.keys(res?.results ?? {}) : 'is array',
          activeDb: res?.active_db,
          lastPoPriceCol: res?.last_po_price_col,
          poQtyCol: res?.po_qty_col,
          totalEauCol: res?.total_eau_col,
          plantNameCol: res?.plant_name_col,
        })
        setFullQuoteData(res)
        setFullQuoteDataCache(res) // Cache for re-entry
      })
      .catch(err => {
        if (!cancelled) {
          console.error('[FullQuoteData] Fetch failed:', err)
          setFullQuoteData(null)
        }
      })
      .finally(() => { if (!cancelled) setFullQuoteLoading(false) })
    return () => { cancelled = true }
  }, [activeTab, fullQuoteDataCache, fullQuoteLoading])

  const [amplSheetPickerOpen, setAmplSheetPickerOpen]               = useState(false)
  const [amplSheetNames, setAmplSheetNames]                         = useState<string[]>([])
  const [amplSheetPickerSelected, setAmplSheetPickerSelected]       = useState('')
  const [amplMissingColsAlertOpen, setAmplMissingColsAlertOpen]     = useState(false)
  const [showAmplMenu, setShowAmplMenu]                             = useState(false)
  const [amplDemandMpnList, setAmplDemandMpnList]                   = useState<string[]>([])
  const amplPendingWbRef      = useRef<any>(null)
  const amplPendingFileNameRef = useRef('')
  const amplPendingDataRef     = useRef<{
    headers: string[]
    rows: Array<(string | number | null)[]>
    mpnColIdx: number
    mpnList: string[]
    fileName: string
  } | null>(null)

  const reset = useCallback(() => {
    setAmpl(null); setIqRows([]); setPlants([]); setMarket(null)
    setShowDetail(false); setError(''); setPinnedPlant(null); setSelectedPlant(null); setSelectedOffer(null)
    setUsedFallback(false); setShowAmplJson(false)
    setBlockedIqRows([]); setBlockedPlants([]); setShowBlockedDetail(false)
  }, [])

  const handleSearch = useCallback(async () => {
    if (!bmatn.trim()) return
    reset()
    // Single search: cap the number of Nexar results requested to 10. The limit
    // is enforced in the BACKEND (forwarded as the upstream GraphQL `limit`) so
    // we consume fewer Nexar API requests — not just trim the response here.
    const SINGLE_NEXAR_LIMIT = 10
    try {
      if (searchMode === 'mpn') {
        // ── MPN mode: skip AMPL, query IQ + market directly ──────────────────
        const queryMpns = [bmatn.trim().toUpperCase()]
        setStatus('loading-iq')
        const iqData = await apiPost<{ count: number; data: IQItem[] }>('/api/pricecalc/internal-query', { mpns: queryMpns })
        const rows: IQItem[] = Array.isArray(iqData.data) ? iqData.data : []
        // Don't bail out when IQ has no results — still fetch market so Nexar prices are shown
        setIqRows(rows)
        setPlants(buildPlantSummaries(rows, windowDays * 86400000))
        setStatus('loading-market')
        const mkt = await apiPost<MarketResponse>('/api/pricecalc/market-prices', { mpns: queryMpns, quantity: qty, limit: SINGLE_NEXAR_LIMIT })
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
        const mkt = await apiPost<MarketResponse>('/api/pricecalc/market-prices', { mpns: queryMpns, quantity: qty, limit: SINGLE_NEXAR_LIMIT })
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
        if (NEXAR_ENABLED && searchNexar && queryMpns.length) {
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

  const downloadLyticaTemplate = useCallback(async () => {
    const ExcelJS = (await import('exceljs')).default
    const wb = new ExcelJS.Workbook()
    wb.creator = 'PPV Dashboard'
    const ws = wb.addWorksheet('MPN List')
    ws.columns = [{ header: 'MPN', key: 'mpn', width: 28 }]
    const hdr = ws.getRow(1)
    hdr.height = 22
    hdr.eachCell(cell => {
      cell.fill      = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1E3A5F' } }
      cell.font      = { bold: true, color: { argb: 'FFFFFFFF' }, size: 11, name: 'Calibri' }
      cell.alignment = { horizontal: 'center', vertical: 'middle' }
      cell.border    = { bottom: { style: 'medium', color: { argb: 'FF2563EB' } } }
    })
    cbomMpnList.forEach((mpn, i) => {
      const row = ws.addRow({ mpn })
      row.height = 18
      row.eachCell({ includeEmpty: true }, (cell: any) => {
        cell.fill      = { type: 'pattern', pattern: 'solid', fgColor: { argb: i % 2 === 0 ? 'FFFFFFFF' : 'FFF8FAFC' } }
        cell.font      = { size: 10, name: 'Calibri' }
        cell.alignment = { vertical: 'middle' }
      })
    })
    ws.autoFilter = 'A1:A1'
    const buffer = await wb.xlsx.writeBuffer()
    const blob   = new Blob([buffer], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' })
    const url    = URL.createObjectURL(blob)
    const a      = document.createElement('a')
    a.href     = url
    a.download = 'Price_Estimator_Upload_Template.xlsx'
    a.click()
    URL.revokeObjectURL(url)
  }, [cbomMpnList])

  /** Download Lytica Upload Template from the loaded AMPL Demand file (unique MPNs) */
  const downloadAmplLyticaTemplate = useCallback(async () => {
    if (!amplDemandMpnList.length) return
    const ExcelJS = (await import('exceljs')).default
    const wb = new ExcelJS.Workbook()
    wb.creator = 'PPV Dashboard'
    const ws = wb.addWorksheet('MPN List')
    ws.columns = [{ header: 'MPN', key: 'mpn', width: 28 }]
    const hdr = ws.getRow(1)
    hdr.height = 22
    hdr.eachCell((cell: any) => {
      cell.fill      = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1E3A5F' } }
      cell.font      = { bold: true, color: { argb: 'FFFFFFFF' }, size: 11, name: 'Calibri' }
      cell.alignment = { horizontal: 'center', vertical: 'middle' }
      cell.border    = { bottom: { style: 'medium', color: { argb: 'FF2563EB' } } }
    })
    amplDemandMpnList.forEach((mpn, i) => {
      const row = ws.addRow({ mpn })
      row.height = 18
      row.eachCell({ includeEmpty: true }, (cell: any) => {
        cell.fill      = { type: 'pattern', pattern: 'solid', fgColor: { argb: i % 2 === 0 ? 'FFFFFFFF' : 'FFF8FAFC' } }
        cell.font      = { size: 10, name: 'Calibri' }
        cell.alignment = { vertical: 'middle' }
      })
    })
    ws.autoFilter = 'A1:A1'
    const buffer = await wb.xlsx.writeBuffer()
    const blob   = new Blob([buffer], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' })
    const url    = URL.createObjectURL(blob)
    const a      = document.createElement('a')
    a.href     = url
    a.download = 'Price_Estimator_Upload_Template.xlsx'
    a.click()
    URL.revokeObjectURL(url)
  }, [amplDemandMpnList])

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
      setCbomMpnList(uniqueMpns)
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

  // ── AMPL Demand: upload & clean ─────────────────────────────────────────

  /** Commits fully parsed AMPL data into component state */
  const commitAmplData = useCallback((
    headers: string[],
    rows: Array<(string | number | null)[]>,
    mpnColIdx: number,
    mpnList: string[],
    fileName: string,
  ) => {
    setAmplDemandHeaders(headers)
    setAmplDemandRows(rows)
    setAmplDemandMpnColIdx(mpnColIdx)
    setAmplDemandMpnList(mpnList)
    setAmplDemandFileName(fileName)
    setAmplDemandRawResults([])
    setAmplDemandAmplMap({})
    setAmplDemandNexarMap({})
    setAmplDemandDeepRows([])
  }, [])

  /** Parse one ExcelJS worksheet; shows alert if filter cols are missing */
  const doProcessAmplSheet = useCallback((ws: any, fileName: string) => {
    const resolveCell = (v: unknown): string | number | null => {
      if (v == null) return null
      if (v instanceof Date) return v.toISOString().slice(0, 10)
      if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') return v as string | number
      if (typeof v === 'object') {
        const obj = v as Record<string, unknown>
        if ('result' in obj && obj.result != null) return obj.result as string | number
        if ('richText' in obj && Array.isArray(obj.richText)) return (obj.richText as Array<{ text: string }>).map(rt => rt.text).join('')
        if ('text' in obj) return String(obj.text)
      }
      return String(v)
    }

    let headers: string[] = []
    let mpnColIdx = -1
    let blkColIdx = -1
    let dColIdx   = -1
    let validToColIdx = -1
    let totalDemandColIdx = -1
    const dataRows: Array<(string | number | null)[]> = []
    const today = new Date(); today.setHours(0, 0, 0, 0)

    ws.eachRow((row: any) => {
      const rawVals = row.values as unknown[]
      const maxCol = rawVals.length - 1
      const rowArr: (string | number | null)[] = Array.from({ length: maxCol }, (_, i) => resolveCell(rawVals[i + 1]))

      if (!headers.length) {
        const mpnIdx = rowArr.findIndex(v => String(v ?? '').trim().toUpperCase() === 'MPN')
        if (mpnIdx !== -1) {
          headers = rowArr.map(v => String(v ?? '').trim())
          mpnColIdx         = mpnIdx
          blkColIdx         = headers.findIndex(h => h.toUpperCase() === 'BLK')
          dColIdx           = headers.findIndex(h => h.toUpperCase() === 'D')
          validToColIdx     = headers.findIndex(h => h.replace(/\s+/g, ' ').toUpperCase() === 'VALID TO')
          totalDemandColIdx = headers.findIndex(h => h.replace(/\s+/g, ' ').toUpperCase() === 'TOTAL DEMAND')
        }
        return
      }

      if (mpnColIdx === -1) return
      const mpnVal = String(rowArr[mpnColIdx] ?? '').trim()
      if (!mpnVal) return

      // Apply filters only when columns exist
      if (blkColIdx !== -1 && rowArr[blkColIdx] != null && String(rowArr[blkColIdx]).trim() !== '') return
      if (dColIdx   !== -1 && rowArr[dColIdx]   != null && String(rowArr[dColIdx]).trim()   !== '') return
      if (validToColIdx !== -1 && rowArr[validToColIdx] != null) {
        const raw = rowArr[validToColIdx] as unknown
        const dt  = raw instanceof Date ? raw : new Date(String(raw))
        if (!isNaN(dt.getTime()) && dt < today) return
      }
      if (totalDemandColIdx !== -1) {
        const td = typeof rowArr[totalDemandColIdx] === 'number'
          ? rowArr[totalDemandColIdx] as number
          : parseFloat(String(rowArr[totalDemandColIdx] ?? ''))
        if (!isNaN(td) && td === 0) return
      }

      dataRows.push(Array.from({ length: headers.length }, (_, k) => (k < rowArr.length ? rowArr[k] : null)))
    })

    if (!headers.length || mpnColIdx === -1) {
      alert('Could not find "MPN" header column in the AMPL Demand file.')
      return
    }

    // Build unique MPN list for Lytica template
    const seen = new Set<string>()
    const mpnList: string[] = []
    for (const row of dataRows) {
      const m = String(row[mpnColIdx] ?? '').trim().toUpperCase()
      if (m && !seen.has(m)) { seen.add(m); mpnList.push(m) }
    }

    // Check if none of the filter columns were found
    const missingFilterCols = blkColIdx === -1 && dColIdx === -1 && validToColIdx === -1 && totalDemandColIdx === -1

    // Store parsed data for possible deferred commit (missing-cols alert)
    amplPendingDataRef.current = { headers, rows: dataRows, mpnColIdx, mpnList, fileName }

    if (missingFilterCols) {
      setAmplMissingColsAlertOpen(true)
    } else {
      if (!dataRows.length) {
        alert('No data rows remain after cleaning (check Blk / D / Valid to / Total Demand filters).')
        return
      }
      commitAmplData(headers, dataRows, mpnColIdx, mpnList, fileName)
      amplPendingDataRef.current = null
    }
  }, [commitAmplData])

  /** Called when user confirms sheet selection in the multi-sheet picker */
  const handleAmplSheetPickerConfirm = useCallback(() => {
    const wb = amplPendingWbRef.current
    if (!wb) return
    const ws = wb.worksheets.find((s: any) => s.name === amplSheetPickerSelected) ?? wb.worksheets[0]
    setAmplSheetPickerOpen(false)
    doProcessAmplSheet(ws, amplPendingFileNameRef.current)
  }, [doProcessAmplSheet, amplSheetPickerSelected])

  /** Called when user clicks "Continue anyway" in the missing-cols alert */
  const handleAmplMissingColsContinue = useCallback(() => {
    const pending = amplPendingDataRef.current
    setAmplMissingColsAlertOpen(false)
    if (!pending) return
    if (!pending.rows.length) {
      alert('No data rows were found in the selected sheet.')
      return
    }
    commitAmplData(pending.headers, pending.rows, pending.mpnColIdx, pending.mpnList, pending.fileName)
    amplPendingDataRef.current = null
  }, [commitAmplData])

  const handleAmplDemandUpload = useCallback(async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (!file) return
    e.target.value = ''
    try {
      const ExcelJS = (await import('exceljs')).default
      const wb = new ExcelJS.Workbook()
      await wb.xlsx.load(await file.arrayBuffer())
      if (!wb.worksheets.length) { alert('No sheets found in the AMPL Demand file.'); return }

      amplPendingWbRef.current      = wb
      amplPendingFileNameRef.current = file.name

      if (wb.worksheets.length > 1) {
        // Multiple sheets — let the user pick
        setAmplSheetNames(wb.worksheets.map((ws: any) => ws.name))
        setAmplSheetPickerSelected(wb.worksheets[0].name)
        setAmplSheetPickerOpen(true)
      } else {
        doProcessAmplSheet(wb.worksheets[0], file.name)
      }
    } catch (err) {
      alert('Error reading AMPL Demand file: ' + (err instanceof Error ? err.message : String(err)))
    }
  }, [doProcessAmplSheet])

  // ── AMPL Demand: search handler ───────────────────────────────────────────
  const handleAmplDemandSearch = useCallback(async () => {
    if (!amplDemandRows.length || amplDemandMpnColIdx === -1) return
    const seen = new Set<string>()
    const uniqueMpns: string[] = []
    for (const row of amplDemandRows) {
      const m = String(row[amplDemandMpnColIdx] ?? '').trim().toUpperCase()
      if (m && !seen.has(m)) { seen.add(m); uniqueMpns.push(m) }
    }
    if (!uniqueMpns.length) return

    const ctrl = new AbortController()
    abortAmplDemandRef.current = ctrl
    const { signal } = ctrl
    setAmplDemandLoading(true)
    setStopAmplDemandHover(false)
    setAmplDemandRawResults([])
    setAmplDemandSearchedList(uniqueMpns)
    setAmplDemandAmplMap({})
    setAmplDemandNexarMap({})
    setAmplDemandDbBestMap({})
    setAmplDemandStatusMap(Object.fromEntries(uniqueMpns.map(m => [m, 'pending' as const])))
    setAmplDemandDeepRows([])
    setAmplDemandSubTab('results')

    // Accumulators rebuilt into state after each step for progressive rendering.
    const collectedRows: IQItem[] = []
    const collectedAmpl: Record<string, AmplResponse> = {}
    const applyEntry = (e: MpnBestEntry) => {
      const rr = (e.rawRows ?? []) as unknown as IQItem[]
      if (rr.length) collectedRows.push(...rr)
      if (e.ampl && e.internalPN) collectedAmpl[e.internalPN] = e.ampl as unknown as AmplResponse
    }

    try {
      // 1 — Instant DB cache: render everything already cached, no realtime call.
      const { found, missing } = await lookupMpnBest(uniqueMpns)
      if (signal.aborted) { setAmplDemandLoading(false); return }

      for (const e of Object.values(found).filter(Boolean) as MpnBestEntry[]) applyEntry(e)
      setAmplDemandDbBestMap({ ...found })
      setAmplDemandRawResults([...collectedRows])
      setAmplDemandAmplMap({ ...collectedAmpl })
      setAmplDemandStatusMap(prev => {
        const next = { ...prev }
        for (const k of Object.keys(found)) next[k] = 'done'
        return next
      })

      // 2 — Only uncached MPNs hit SAP in real time, in moderate chunks to avoid
      //     saturating the upstream server while still showing progressive results.
      const CHUNK = 9
      for (let i = 0; i < missing.length; i += CHUNK) {
        if (signal.aborted) break
        const chunk = missing.slice(i, i + CHUNK)
        try {
          const { results } = await resolveMpnBest(chunk, windowDays)
          if (signal.aborted) break
          const dbAdd: Record<string, MpnBestEntry> = {}
          const statusAdd: Record<string, 'done' | 'error'> = {}
          for (const m of chunk) {
            const e = results[m]
            if (e) { applyEntry(e); dbAdd[m] = e; statusAdd[m] = 'done' }
            else { statusAdd[m] = 'error' }
          }
          setAmplDemandDbBestMap(prev => ({ ...prev, ...dbAdd }))
          setAmplDemandRawResults([...collectedRows])
          setAmplDemandAmplMap({ ...collectedAmpl })
          setAmplDemandStatusMap(prev => ({ ...prev, ...statusAdd }))
        } catch {
          setAmplDemandStatusMap(prev => {
            const next = { ...prev }
            for (const m of chunk) next[m] = 'error'
            return next
          })
        }
      }

      // 3 — Nexar: all searched MPNs plus SAP-returned variants
      if (NEXAR_ENABLED && searchNexar && !signal.aborted) {
        const nexarMpns = [...new Set([...uniqueMpns, ...collectedRows.map((r: IQItem) => r.mpn).filter(Boolean)])]
        const nexarUpdates: typeof amplDemandNexarMap = {}
        await Promise.allSettled(nexarMpns.map(async (mpn: string) => {
          try {
            const mkt = await apiPostWithRetry<MarketResponse>('/api/pricecalc/market-prices', { mpns: [mpn], quantity: qty }, signal)
            const best = [...mkt.offers].sort((a: MarketOffer, b: MarketOffer) => a.unit_price_usd - b.unit_price_usd)[0] ?? null
            if (best) nexarUpdates[mpn] = {
              nexarBestUsd: best.unit_price_usd, nexarSeller: best.seller,
              nexarManufacturer: best.manufacturer, nexarStock: best.inventory,
              nexarMoq: best.moq, nexarMpn: best.mpn,
            }
          } catch { /* non-critical */ }
        }))
        setAmplDemandNexarMap(nexarUpdates)
      }
    } catch (e) {
      const isCancelled = e instanceof DOMException && e.name === 'AbortError'
      if (!isCancelled) {
        setAmplDemandStatusMap(prev => {
          const next = { ...prev }
          for (const k of Object.keys(next)) if (next[k] === 'pending') next[k] = 'error'
          return next
        })
      }
    }
    setAmplDemandLoading(false)
    setStopAmplDemandHover(false)
  }, [amplDemandRows, amplDemandMpnColIdx, searchNexar, qty, windowDays])

  // ── AMPL Demand: deep analysis ─────────────────────────────────────────────
  const handleAmplDemandDeep = useCallback(async () => {
    const internalPNs = [...new Set(amplDemandRawResults.map(r => r.internalPN).filter(Boolean))]
    if (!internalPNs.length) return
    abortAmplDemandDeepRef.current?.abort()
    const ctrl = new AbortController()
    abortAmplDemandDeepRef.current = ctrl
    const { signal } = ctrl
    setAmplDemandDeepLoading(true)
    setAmplDemandDeepRows(internalPNs.map(ip => ({
      internalPN: ip, status: 'loading',
      mcBestPriceUsd: null, mcStdPriceUsd: null, mcBestSupplier: '', mcBestPlant: '',
      mcBestMpn: '', mcBestInternalPN: '', mcLastPoDate: '',
    })))
    setAmplDemandSubTab('deep')
    await Promise.allSettled(internalPNs.map(async ip => {
      try {
        const amplData = await apiPostWithRetry<AmplResponse>('/api/pricecalc/ampl', { internal_part_number: ip }, signal)
        let queryMpns = amplData.mpns_list
        if (!queryMpns.length) {
          queryMpns = [...amplData.blocked.map((i: { MfgPartNumber: string }) => i.MfgPartNumber), ...amplData.deleted.map((i: { MfgPartNumber: string }) => i.MfgPartNumber)].filter(Boolean).filter((v: string, i: number, a: string[]) => a.indexOf(v) === i)
        }
        if (!queryMpns.length) {
          setAmplDemandDeepRows(prev => prev.map(r => r.internalPN === ip ? { ...r, status: 'error', error: 'No MPNs in SAP' } : r))
          return
        }
        const iqData = await apiPostWithRetry<{ count: number; data: IQItem[] }>('/api/pricecalc/internal-query', { mpns: queryMpns }, signal)
        const rows: IQItem[] = Array.isArray(iqData.data) ? iqData.data : []
        const bestRow = buildPlantSummaries(rows, windowDays * 86400000)[0]?.bestRow ?? null
        setAmplDemandDeepRows(prev => prev.map(r => r.internalPN === ip ? {
          ...r, status: 'done',
          mcBestPriceUsd: bestRow ? resolveLastPoPrice(bestRow) : null,
          mcStdPriceUsd: bestRow?.standardPriceUsd ?? null,
          mcBestSupplier: bestRow?.supplierName || bestRow?.englishName || '—',
          mcBestPlant: bestRow?.siteName || '—',
          mcBestMpn: bestRow?.mpn || '—',
          mcBestInternalPN: bestRow?.internalPN || '—',
          mcLastPoDate: bestRow?.lastPoDate || '—',
        } : r))
      } catch (e) {
        const isCancelled = e instanceof DOMException && e.name === 'AbortError'
        setAmplDemandDeepRows(prev => prev.map(r => r.internalPN === ip ? { ...r, status: 'error', error: isCancelled ? 'Cancelled' : e instanceof Error ? e.message : String(e) } : r))
      }
    }))
    setAmplDemandDeepLoading(false)
  }, [amplDemandRawResults, windowDays])

  // ── AMPL Demand: retry failed deep-analysis rows ──────────────────────────
  const handleAmplDemandDeepRetry = useCallback(async () => {
    const retryableIPs = amplDemandDeepRows
      .filter(r => r.status === 'error' && r.error !== 'Cancelled' && r.error !== 'No MPNs in SAP')
      .map(r => r.internalPN)
    if (!retryableIPs.length) return
    abortAmplDemandDeepRef.current?.abort()
    const ctrl = new AbortController()
    abortAmplDemandDeepRef.current = ctrl
    const { signal } = ctrl
    setAmplDemandDeepLoading(true)
    setAmplDemandDeepRows(prev => prev.map(r =>
      retryableIPs.includes(r.internalPN) ? { ...r, status: 'loading', error: undefined } : r
    ))
    await Promise.allSettled(retryableIPs.map(async ip => {
      try {
        const amplData = await apiPostWithRetry<AmplResponse>('/api/pricecalc/ampl', { internal_part_number: ip }, signal)
        let queryMpns = amplData.mpns_list
        if (!queryMpns.length) {
          queryMpns = [...amplData.blocked.map((i: { MfgPartNumber: string }) => i.MfgPartNumber), ...amplData.deleted.map((i: { MfgPartNumber: string }) => i.MfgPartNumber)].filter(Boolean).filter((v: string, i: number, a: string[]) => a.indexOf(v) === i)
        }
        if (!queryMpns.length) {
          setAmplDemandDeepRows(prev => prev.map(r => r.internalPN === ip ? { ...r, status: 'error', error: 'No MPNs in SAP' } : r))
          return
        }
        const iqData = await apiPostWithRetry<{ count: number; data: IQItem[] }>('/api/pricecalc/internal-query', { mpns: queryMpns }, signal)
        const rows: IQItem[] = Array.isArray(iqData.data) ? iqData.data : []
        const bestRow = buildPlantSummaries(rows, windowDays * 86400000)[0]?.bestRow ?? null
        setAmplDemandDeepRows(prev => prev.map(r => r.internalPN === ip ? {
          ...r, status: 'done',
          mcBestPriceUsd: bestRow ? resolveLastPoPrice(bestRow) : null,
          mcStdPriceUsd: bestRow?.standardPriceUsd ?? null,
          mcBestSupplier: bestRow?.supplierName || bestRow?.englishName || '—',
          mcBestPlant: bestRow?.siteName || '—',
          mcBestMpn: bestRow?.mpn || '—',
          mcBestInternalPN: bestRow?.internalPN || '—',
          mcLastPoDate: bestRow?.lastPoDate || '—',
        } : r))
      } catch (e) {
        const isCancelled = e instanceof DOMException && e.name === 'AbortError'
        setAmplDemandDeepRows(prev => prev.map(r => r.internalPN === ip ? { ...r, status: 'error', error: isCancelled ? 'Cancelled' : e instanceof Error ? e.message : String(e) } : r))
      }
    }))
    setAmplDemandDeepLoading(false)
  }, [amplDemandDeepRows, windowDays])

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
    stopMpnRef.current = false
    const { signal } = ctrl
    setMultiMpnLoading(true)
    setStopMpnHover(false)
    setMultiMpnRawResults([])
    setMultiMpnSearchedList(mpns)
    setMultiMpnAmplMap({})
    setMpnNexarMap({})
    setMpnDbBestMap({})
    setMpnStatusMap(Object.fromEntries(mpns.map(m => [m, 'pending' as const])))
    setMpnFromCacheSet(new Set())
    setMultiMpnSubTab('results')
    setMultiMpnExpandedMpns(new Set())
    setDeepAnalysisRows([])
    abortDeepRef.current?.abort()

    // Accumulators rebuilt into state after every step for progressive rendering.
    const collectedRows: IQItem[] = []
    const collectedAmpl: Record<string, AmplResponse> = {}
    const applyEntry = (e: MpnBestEntry) => {
      const rr = (e.rawRows ?? []) as unknown as IQItem[]
      if (rr.length) collectedRows.push(...rr)
      if (e.ampl && e.internalPN) collectedAmpl[e.internalPN] = e.ampl as unknown as AmplResponse
    }

    try {
      // 1 — Instant DB cache: render everything already cached, no realtime call.
      const { found, missing } = await lookupMpnBest(mpns)
      if (signal.aborted) { setMultiMpnLoading(false); return }

      const foundEntries = Object.values(found).filter(Boolean) as MpnBestEntry[]
      for (const e of foundEntries) applyEntry(e)
      setMpnDbBestMap({ ...found })
      setMpnFromCacheSet(new Set(Object.keys(found).map(k => k.toUpperCase())))
      setMultiMpnRawResults([...collectedRows])
      setMultiMpnAmplMap({ ...collectedAmpl })
      setMpnStatusMap(prev => {
        const next = { ...prev }
        for (const k of Object.keys(found)) next[k] = 'done'
        return next
      })

      // 2 — Only the uncached MPNs hit SAP in real time, in moderate chunks to avoid
      //     saturating the upstream server while still showing progressive results.
      const CHUNK = 9
      for (let i = 0; i < missing.length; i += CHUNK) {
        // Cooperative stop: the Stop button sets stopMpnRef so the loop finishes
        // the current chunk and then stops (signal.aborted = hard abort).
        if (signal.aborted || stopMpnRef.current) break
        const chunk = missing.slice(i, i + CHUNK)
        try {
          const { results } = await resolveMpnBest(chunk, windowDays)
          if (signal.aborted) break
          const dbAdd: Record<string, MpnBestEntry> = {}
          const statusAdd: Record<string, 'done' | 'error'> = {}
          for (const m of chunk) {
            const e = results[m]
            if (e) { applyEntry(e); dbAdd[m] = e; statusAdd[m] = 'done' }
            else { statusAdd[m] = 'error' }
          }
          setMpnDbBestMap(prev => ({ ...prev, ...dbAdd }))
          setMultiMpnRawResults([...collectedRows])
          setMultiMpnAmplMap({ ...collectedAmpl })
          setMpnStatusMap(prev => ({ ...prev, ...statusAdd }))
        } catch {
          // Whole chunk failed (e.g. connection) → mark those MPNs as errored
          setMpnStatusMap(prev => {
            const next = { ...prev }
            for (const m of chunk) next[m] = 'error'
            return next
          })
        }
      }

      // 3 — Nexar market fetch (optional, separate) for all searched MPNs.
      if (NEXAR_ENABLED && searchNexar && mpns.length > 0 && !signal.aborted) {
        const uniqueMpns = [...new Set([...mpns, ...collectedRows.map(r => r.mpn).filter(Boolean)])]
        const nexarUpdates: Record<string, { nexarBestUsd: number | null; nexarSeller: string; nexarManufacturer: string; nexarStock: number | null; nexarMoq: number | null; nexarMpn: string }> = {}
        await Promise.allSettled(uniqueMpns.map(async mpn => {
          try {
            const mpnQty = mpnComponentQtys[mpn] ?? qty
            const mkt = await apiPostWithRetry<MarketResponse>('/api/pricecalc/market-prices', { mpns: [mpn], quantity: mpnQty }, signal)
            const best = [...mkt.offers].sort((a, b) => a.unit_price_usd - b.unit_price_usd)[0] ?? null
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
      if (!isCancelled) {
        // Fall back to leaving whatever was collected; mark still-pending as errored
        setMpnStatusMap(prev => {
          const next = { ...prev }
          for (const k of Object.keys(next)) if (next[k] === 'pending') next[k] = 'error'
          return next
        })
      }
    }
    // If the user stopped early, clear the leftover "pending" spinners so rows
    // that were never reached don't appear to be querying forever.
    if (stopMpnRef.current) {
      setMpnStatusMap(prev => {
        const next = { ...prev }
        for (const k of Object.keys(next)) if (next[k] === 'pending') next[k] = 'error'
        return next
      })
    }
    stopMpnRef.current = false
    setMultiMpnLoading(false)
    setStopMpnHover(false)
  }, [multiMpnInput, searchNexar, qty, mpnComponentQtys, windowDays])

  // Live fallback (SAP) for a single Internal PN — used only when the DB-cached
  // deep resolver doesn't return a row (e.g. backend resolver failed).
  const computeDeepLive = useCallback(async (ip: string, signal: AbortSignal) => {
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
  }, [windowDays])

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
    setDeepPage(0)
    setMultiMpnSubTab('deep')

    // ── DB-first: ask the backend for cached deep rows; it computes any misses
    //    in real time (SAP) and stores them for next time. This makes repeated
    //    Deep Analysis on previously-seen searches instant. ──
    try {
      const resp = await resolveDeep(internalPNs, windowDays)
      const stillMissing: string[] = []
      setDeepAnalysisRows(prev => prev.map(r => {
        const e = resp.results[r.internalPN.toUpperCase()] ?? resp.results[r.internalPN]
        if (!e) { stillMissing.push(r.internalPN); return r }
        return {
          ...r, status: 'done',
          mcBestPriceUsd:   e.mcBestPriceUsd,
          mcStdPriceUsd:    e.mcStdPriceUsd,
          mcBestSupplier:   e.mcBestSupplier || '—',
          mcBestPlant:      e.mcBestPlant || '—',
          mcBestMpn:        e.mcBestMpn || '—',
          mcBestInternalPN: e.mcBestInternalPN || r.internalPN,
          mcLastPoDate:     e.mcLastPoDate || '—',
        }
      }))
      // Any internal PN the backend couldn't resolve → live SAP fallback.
      if (stillMissing.length) {
        await Promise.allSettled(stillMissing.map(ip => computeDeepLive(ip, signal).catch(e => {
          const isCancelled = e instanceof DOMException && e.name === 'AbortError'
          setDeepAnalysisRows(prev => prev.map(r => r.internalPN === ip ? {
            ...r, status: 'error',
            error: isCancelled ? 'Cancelled' : e instanceof Error ? e.message : String(e),
          } : r))
        })))
      }
    } catch {
      // Backend resolver unavailable → fall back to fully-live per-PN compute.
      await Promise.allSettled(internalPNs.map(ip => computeDeepLive(ip, signal).catch(e => {
        const isCancelled = e instanceof DOMException && e.name === 'AbortError'
        setDeepAnalysisRows(prev => prev.map(r => r.internalPN === ip ? {
          ...r, status: 'error',
          error: isCancelled ? 'Cancelled' : e instanceof Error ? e.message : String(e),
        } : r))
      })))
    }
    setDeepAnalysisLoading(false)
  }, [windowDays, computeDeepLive])

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
                <h2 className="font-bold text-gray-800 leading-tight">KE-SOL Quote Price tool</h2>
                <p className="text-xs text-gray-400">SAP + Nexar Market + Lytica</p>
              </div>
              <DbJobButton />
              {mode !== 'page' && (
                <button onClick={() => setOpen(false)} className="text-gray-400 hover:text-gray-700 p-1.5 rounded-lg hover:bg-gray-100">
                  <X size={18} />
                </button>
              )}
            </div>

            {/* Tabs */}
            <div className="px-6 pt-3 pb-0 flex-shrink-0 border-b border-gray-100">
              <div className="flex gap-1 bg-gray-100 rounded-xl p-1 w-fit overflow-x-auto">
                <button
                  type="button"
                  onClick={() => setActiveTab('single')}
                  className={`px-4 py-1.5 text-sm font-medium rounded-lg transition-colors whitespace-nowrap ${activeTab === 'single' ? 'bg-white text-blue-600 shadow-sm' : 'text-gray-500 hover:text-gray-700'}`}
                >
                  Single
                </button>
                <button
                  type="button"
                  disabled
                  onClick={() => setActiveTab('multi')}
                  className={`px-4 py-1.5 text-sm font-medium rounded-lg transition-colors cursor-not-allowed opacity-70 whitespace-nowrap ${activeTab === 'multi' ? 'bg-white text-blue-600 shadow-sm' : 'text-gray-500'}`}
                >
                  <span className="flex items-center gap-2">
                    <span>Multi-Component</span>
                    <span className="text-[10px] font-semibold uppercase tracking-wide text-amber-600">in dev</span>
                  </span>
                </button>
                <button
                  type="button"
                  onClick={() => setActiveTab('mpn')}
                  className={`px-4 py-1.5 text-sm font-medium rounded-lg transition-colors whitespace-nowrap ${activeTab === 'mpn' ? 'bg-white text-blue-600 shadow-sm' : 'text-gray-500 hover:text-gray-700'}`}
                >
                  Multi-MPN
                </button>
                <button
                  type="button"
                  disabled
                  onClick={() => setActiveTab('ampl')}
                  className={`px-4 py-1.5 text-sm font-medium rounded-lg transition-colors cursor-not-allowed opacity-70 whitespace-nowrap ${activeTab === 'ampl' ? 'bg-white text-indigo-600 shadow-sm' : 'text-gray-500'}`}
                >
                  <span className="flex items-center gap-2">
                    <span>AMPL Demand</span>
                    <span className="text-[10px] font-semibold uppercase tracking-wide text-amber-600">in dev</span>
                  </span>
                </button>
                <button
                  type="button"
                  onClick={() => setActiveTab('fullquote')}
                  className={`px-4 py-1.5 text-sm font-medium rounded-lg transition-colors whitespace-nowrap ${activeTab === 'fullquote' ? 'bg-white text-indigo-600 shadow-sm' : 'text-gray-500 hover:text-gray-700'}`}
                >
                  Full Quote Data
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

                  {/* Lytica benchmark — shown whenever lyticaMap has data for this part */}
                  {(() => {
                    if (Object.keys(lyticaMap).length === 0) return null
                    const mpnsToCheck: string[] = searchMode === 'mpn'
                      ? [bmatn]
                      : (ampl?.mpns_list ?? [bmatn])
                    const lyticaHits = mpnsToCheck
                      .map(m => ({ mpn: m, entry: lyticaMap[m.toUpperCase()] ?? lyticaMap[m] ?? null }))
                      .filter(x => x.entry !== null)
                    if (!lyticaHits.length) return null
                    return (
                      <div className="rounded-xl border border-teal-200 bg-teal-50/40 p-4">
                        <h4 className="text-xs font-semibold text-teal-700 uppercase tracking-wide mb-3 flex items-center gap-1.5">
                          <svg className="h-3.5 w-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 19v-6a2 2 0 00-2-2H5a2 2 0 00-2 2v6a2 2 0 002 2h2a2 2 0 002-2zm0 0V9a2 2 0 012-2h2a2 2 0 012 2v10m-6 0a2 2 0 002 2h2a2 2 0 002-2m0 0V5a2 2 0 012-2h2a2 2 0 012 2v14a2 2 0 01-2 2h-2a2 2 0 01-2-2z"/></svg>
                          Lytica 90th Percentile Benchmark
                        </h4>
                        <div className="flex flex-wrap gap-3">
                          {lyticaHits.map(({ mpn, entry }) => (
                            <div key={mpn} className="bg-white rounded-xl border border-teal-200 px-4 py-3 min-w-[160px] shadow-sm">
                              <p className="text-[10px] text-gray-400 font-medium uppercase tracking-wide mb-0.5">MPN</p>
                              <p className="text-xs font-mono font-semibold text-gray-800 mb-2">{mpn}</p>
                              {entry!.mpnMatched && entry!.mpnMatched.toUpperCase() !== mpn.toUpperCase() && (
                                <p className="text-[10px] text-teal-500 mb-1">Matched: <span className="font-mono">{entry!.mpnMatched}</span></p>
                              )}
                              <p className="text-[10px] text-gray-400 uppercase tracking-wide mb-0.5">90th %tile Price</p>
                              <p className="text-sm font-bold font-mono text-teal-700">{entry!.price90th != null ? fmt6(entry!.price90th) : '—'}</p>
                              {entry!.manufacturerMatched && (
                                <p className="text-[10px] text-gray-500 mt-1.5 truncate" title={entry!.manufacturerMatched}>{entry!.manufacturerMatched}</p>
                              )}
                            </div>
                          ))}
                        </div>
                      </div>
                    )
                  })()}

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
                                <thead className="sticky top-0 z-[1] bg-emerald-600 text-white text-[10px] uppercase tracking-wide">
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
                      {NEXAR_ENABLED && (
                        <label className="flex items-center gap-2 cursor-pointer select-none">
                          <input
                            type="checkbox"
                            checked={searchNexar}
                            onChange={e => setSearchNexar(e.target.checked)}
                            className="w-4 h-4 accent-purple-600 cursor-pointer"
                          />
                          <span className="text-sm text-gray-600">Include <span className="font-semibold text-purple-600">Nexar Market</span></span>
                        </label>
                      )}
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
                          <thead className="bg-gray-50 text-[10px] uppercase tracking-wide text-gray-500 sticky top-0 z-[1]">
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
                                            {winner === 'mc'  && <span className="text-xs font-bold px-2 py-0.5 rounded-full bg-purple-100 text-purple-700">Interplant (IPN)</span>}
                                            {winner === 'mpn' && <span className="text-xs font-bold px-2 py-0.5 rounded-full bg-emerald-100 text-emerald-700">Interplant (MPN)</span>}
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

                    {/* ── Toolbar: file chips + Upload CBOM + Upload Lytica + "..." menu ── */}
                    <div className="flex items-center justify-between mb-3 gap-2 flex-wrap">
                      <div className="flex items-center gap-1.5 flex-wrap">
                        <span className="text-sm font-semibold text-gray-700">MPN Numbers</span>
                        {!mpnExcelFileName && !cbomFileName && (
                          <span className="text-xs text-gray-400">(one per line or comma-separated)</span>
                        )}
                        {mpnExcelFileName && (
                          <span className="flex items-center gap-1 text-[11px] text-emerald-700 bg-emerald-50 border border-emerald-200 rounded-full px-2 py-0.5">
                            <svg className="h-3 w-3" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" /></svg>
                            {mpnExcelFileName}
                            <button onClick={() => { setMpnExcelFileName(''); setMpnComponentQtys({}); setMpnComponentQtyDefaults({}); setMultiMpnInput('') }} className="ml-1 text-emerald-500 hover:text-red-500 font-bold leading-none" title="Clear Excel data">×</button>
                          </span>
                        )}
                        {cbomFileName && (
                          <span className="flex items-center gap-1 text-[11px] text-orange-700 bg-orange-50 border border-orange-200 rounded-full px-2 py-0.5">
                            <svg className="h-3 w-3" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 17v-2m3 2v-4m3 4v-6m2 10H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" /></svg>
                            CBOM: {cbomFileName}
                            <button onClick={() => { setCbomFileName(''); setCbomRows([]); setCbomHeaders([]); setCbomMpnColIdx(-1); setCbomMpnList([]); setMpnComponentQtys({}); setMpnComponentQtyDefaults({}); setMultiMpnInput('') }} className="ml-1 text-orange-500 hover:text-red-500 font-bold leading-none" title="Clear CBOM data">×</button>
                          </span>
                        )}
                        {lyticaFileName && (
                          <span className="flex items-center gap-1 text-[11px] text-teal-700 bg-teal-50 border border-teal-200 rounded-full px-2 py-0.5">
                            <svg className="h-3 w-3" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 19v-6a2 2 0 00-2-2H5a2 2 0 00-2 2v6a2 2 0 002 2h2a2 2 0 002-2zm0 0V9a2 2 0 012-2h2a2 2 0 012 2v10m-6 0a2 2 0 002 2h2a2 2 0 002-2m0 0V5a2 2 0 012-2h2a2 2 0 012 2v14a2 2 0 01-2 2h-2a2 2 0 01-2-2z" /></svg>
                            Lytica: {lyticaFileName}
                            <button onClick={() => { setLyticaFileName(''); setLyticaMap({}) }} className="ml-1 text-teal-500 hover:text-red-500 font-bold leading-none" title="Clear Lytica data">×</button>
                          </span>
                        )}
                      </div>
                      <div className="flex items-center gap-2">
                        {/* Upload CBOM — always visible */}
                        <label className="flex items-center gap-1.5 cursor-pointer px-3 py-1.5 text-xs font-semibold rounded-lg bg-white border border-orange-300 hover:bg-orange-50 hover:border-orange-500 hover:text-orange-700 text-gray-600 transition-colors shadow-sm" title="Upload a Costed BOM (CBOM) Excel — extracts MPNs and generates an enriched export">
                          <svg className="h-3.5 w-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 17v-2m3 2v-4m3 4v-6m2 10H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" /></svg>
                          Upload CBOM
                          <input type="file" accept=".xlsx,.xls" className="hidden" onChange={handleCbomUpload} />
                        </label>
                        {/* Upload Lytica — always visible */}
                        <label className="flex items-center gap-1.5 cursor-pointer px-3 py-1.5 text-xs font-semibold rounded-lg bg-white border border-teal-300 hover:bg-teal-50 hover:border-teal-500 hover:text-teal-700 text-gray-600 transition-colors shadow-sm" title="Upload a Lytica report — matches MPN Searched with 90th percentile price">
                          <svg className="h-3.5 w-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 19v-6a2 2 0 00-2-2H5a2 2 0 00-2 2v6a2 2 0 002 2h2a2 2 0 002-2zm0 0V9a2 2 0 012-2h2a2 2 0 012 2v10m-6 0a2 2 0 002 2h2a2 2 0 002-2m0 0V5a2 2 0 012-2h2a2 2 0 012 2v14a2 2 0 01-2 2h-2a2 2 0 01-2-2z" /></svg>
                          Upload Lytica
                          <input type="file" accept=".xlsx,.xls" className="hidden" onChange={handleLyticaUpload} />
                        </label>
                        {/* "⋯" more-actions menu */}
                        <div className="relative">
                          <button
                            onClick={() => setShowMpnMenu(v => !v)}
                            className="flex items-center justify-center w-8 h-8 rounded-lg bg-white border border-gray-300 hover:border-gray-400 hover:bg-gray-50 text-gray-500 hover:text-gray-700 transition-colors shadow-sm text-base font-bold leading-none"
                            title="More actions"
                          >
                            ···
                          </button>
                          {showMpnMenu && (
                            <div
                              className="absolute right-0 top-9 z-30 w-56 bg-white rounded-xl border border-gray-200 shadow-xl py-1.5"
                              onMouseLeave={() => setShowMpnMenu(false)}
                            >
                              {/* Import section */}
                              <p className="text-[10px] text-gray-400 px-3 pt-1.5 pb-0.5 uppercase tracking-wider font-semibold">Import</p>
                              <label className="flex items-center gap-2 px-3 py-2 text-sm text-gray-700 hover:bg-gray-50 cursor-pointer rounded-lg mx-1">
                                <svg className="h-4 w-4 text-blue-500" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-8l-4-4m0 0L8 8m4-4v12" /></svg>
                                Upload Excel
                                <input type="file" accept=".xlsx,.xls" className="hidden" onChange={e => { handleMpnExcelUpload(e); setShowMpnMenu(false) }} />
                              </label>
                              {/* Export section */}
                              <div className="my-1 border-t border-gray-100" />
                              <p className="text-[10px] text-gray-400 px-3 pt-1.5 pb-0.5 uppercase tracking-wider font-semibold">Export</p>
                              <button
                                onClick={() => { downloadTemplate(); setShowMpnMenu(false) }}
                                className="flex items-center gap-2 w-full px-3 py-2 text-sm text-gray-700 hover:bg-gray-50 rounded-lg mx-auto"
                                style={{ textAlign: 'left' }}
                              >
                                <svg className="h-4 w-4 text-emerald-500 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 10v6m0 0l-3-3m3 3l3-3m2 8H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" /></svg>
                                Download Template
                              </button>
                              <button
                                onClick={() => { downloadLyticaTemplate(); setShowMpnMenu(false) }}
                                disabled={cbomMpnList.length === 0}
                                className="flex items-center gap-2 w-full px-3 py-2 text-sm text-gray-700 hover:bg-gray-50 rounded-lg mx-auto disabled:opacity-40 disabled:cursor-not-allowed"
                                style={{ textAlign: 'left' }}
                                title={cbomMpnList.length === 0 ? 'Upload a CBOM first to generate this template' : `Export ${cbomMpnList.length} MPNs from loaded CBOM`}
                              >
                                <svg className="h-4 w-4 text-indigo-500 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 10v6m0 0l-3-3m3 3l3-3m2 8H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" /></svg>
                                <span className="leading-tight">
                                  Download Lytica Template
                                  <span className="block text-[10px] text-gray-400 font-normal">CBOM List{cbomMpnList.length > 0 ? ` (${cbomMpnList.length} MPNs)` : ''}</span>
                                </span>
                              </button>
                            </div>
                          )}
                        </div>
                      </div>
                    </div>

                    {/* ── MPN input area ── */}
                    {mpnExcelFileName ? (
                      <div className="w-full rounded-lg border border-emerald-200 bg-white overflow-hidden mb-3" style={{ height: '172px' }}>
                        <div className="overflow-y-auto h-full">
                          <table className="w-full text-xs border-collapse">
                            <thead className="sticky top-0 z-[1] bg-emerald-600 text-white text-[10px] uppercase tracking-wide">
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
                                      <span className="ml-1 text-[10px] text-gray-400 font-normal">({mpnComponentQtyDefaults[comp]})</span>
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
                        className="w-full rounded-lg border border-gray-300 px-4 py-2.5 text-sm font-mono focus:outline-none focus:ring-2 focus:ring-blue-500 resize-y mb-3"
                      />
                    )}

                    {/* ── Controls + Search row ── */}
                    <div className="flex items-end gap-3 flex-wrap">
                      {!mpnExcelFileName && (
                        <div>
                          <label className="block text-xs font-medium text-gray-500 mb-1">Quantity</label>
                          <input
                            type="number" min={0.0001} step="any" value={qty}
                            onChange={e => setQty(Math.max(0.0001, parseFloat(e.target.value) || 0.0001))}
                            className="w-28 rounded-lg border border-gray-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
                          />
                        </div>
                      )}
                      <div>
                        <label className="block text-xs font-medium text-gray-500 mb-1">My Plant</label>
                        <select
                          value={myPlant}
                          onChange={e => setMyPlant(e.target.value)}
                          className="rounded-lg border border-gray-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 bg-white"
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
                      <div>
                        <label className="block text-xs font-medium text-gray-500 mb-1">Window (days)</label>
                        <input
                          type="number" min={1} max={365} step={1} value={windowDays}
                          onChange={e => setWindowDays(Math.max(1, Math.min(365, parseInt(e.target.value) || 45)))}
                          className="w-24 rounded-lg border border-gray-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
                        />
                      </div>
                      <div className="flex-1" />
                      {NEXAR_ENABLED && (
                        <label className="flex items-center gap-2 cursor-pointer select-none pb-0.5">
                          <input
                            type="checkbox"
                            checked={searchNexar}
                            onChange={e => setSearchNexar(e.target.checked)}
                            className="w-4 h-4 accent-purple-600 cursor-pointer"
                          />
                          <span className="text-sm text-gray-600">Include <span className="font-semibold text-purple-600">Nexar Market</span></span>
                        </label>
                      )}
                      <button
                        onClick={multiMpnLoading ? () => { stopMpnRef.current = true; setStopMpnHover(false) } : handleMultiMpnSearch}
                        disabled={!multiMpnLoading && !multiMpnInput.trim()}
                        onMouseEnter={() => { if (multiMpnLoading) setStopMpnHover(true) }}
                        onMouseLeave={() => setStopMpnHover(false)}
                        title={multiMpnLoading ? 'Finish the current batch, then stop' : undefined}
                        className={`flex items-center gap-2 px-6 py-2 rounded-lg text-sm font-semibold transition-colors shadow-sm ${
                          multiMpnLoading && stopMpnHover
                            ? 'bg-red-600 text-white hover:bg-red-700 cursor-pointer'
                            : multiMpnLoading
                            ? 'bg-blue-400 text-white cursor-default'
                            : 'bg-blue-600 text-white hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed'
                        }`}
                      >
                        {multiMpnLoading && !stopMpnHover && (
                          <svg className="animate-spin h-4 w-4" fill="none" viewBox="0 0 24 24">
                            <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                            <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8H4z" />
                          </svg>
                        )}
                        {multiMpnLoading && stopMpnHover ? 'Stop' : multiMpnLoading ? 'Searching…' : 'Search All'}
                      </button>
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

                    // ── DB-cache split ────────────────────────────────────────
                    // Cached MPNs render instantly in the top table; MPNs queried
                    // for the first time this session render in a separate table.
                    const fromCache = mpnFromCacheSet
                    const synthBestRow = (e: MpnBestEntry): IQItem => ({
                      rawStandardPrice: 0, rawStandardPricePer: 0,
                      rawLastPoPrice: null, rawLastPoPer: null, uomConversion: 1,
                      localCurrencyExchangeRate: 0, localCurrencyExchangeRateUsd: 0,
                      mpn: e.bestMpn || e.mpn, internalPN: e.internalPN || '',
                      siteName: e.bestPlant || '', quantity: undefined as unknown as number,
                      standardPriceLocalCurr: undefined as unknown as number, lastPoPriceLocalCurr: null,
                      standardPriceUsd: (e.stdPriceUsd ?? undefined) as unknown as number,
                      lastPoPriceUsd: e.bestPriceUsd ?? null,
                      localCurrency: '', lastPoDate: e.lastPoDate || '',
                      supplierNumber: '', supplierName: e.bestSupplier || '', englishName: null,
                      manufacturerName: '', materialDescription: '',
                    })
                    const foundMpnKeys = new Set(mpnEntries.map(e => e.mpn.toUpperCase()))
                    // Cached MPNs without raw rows (cached before payloads existed) still
                    // render a row synthesized from the stored best price.
                    const synthCachedEntries = multiMpnSearchedList
                      .filter(m => fromCache.has(m.toUpperCase()) && !foundMpnKeys.has(m.toUpperCase()))
                      .map(m => {
                        const e = mpnDbBestMap[m.toUpperCase()]
                        if (!e || e.bestPriceUsd == null) return null
                        const bestRow = synthBestRow(e)
                        return { mpn: m, bestRow, allRows: [bestRow] }
                      })
                      .filter((x): x is { mpn: string; bestRow: IQItem; allRows: IQItem[] } => x !== null)
                    const cachedEntries = [
                      ...mpnEntries.filter(e => fromCache.has(e.mpn.toUpperCase())),
                      ...synthCachedEntries,
                    ].sort((a, b) => a.mpn.localeCompare(b.mpn))
                    const freshEntries = mpnEntries
                      .filter(e => !fromCache.has(e.mpn.toUpperCase()))
                      .sort((a, b) => a.mpn.localeCompare(b.mpn))
                    const cachedSearched = multiMpnSearchedList.filter(m => fromCache.has(m.toUpperCase()))
                    const freshSearched  = multiMpnSearchedList.filter(m => !fromCache.has(m.toUpperCase()))
                    const freshPending   = freshSearched.filter(m => (mpnStatusMap[m.toUpperCase()] ?? 'done') === 'pending')

                    // Reusable detailed table (identical columns for cached & first-time).
                    const renderDetailTable = (
                      tableEntries: { mpn: string; bestRow: IQItem; allRows: IQItem[] }[],
                      searchedSubset: string[],
                      pendingMpns: string[],
                    ) => {
                      const foundSet      = new Set(tableEntries.map(e => e.mpn))
                      const rawSet        = new Set(multiMpnRawResults.map(r => r.mpn))
                      const blockedSet    = new Set(allBlockedItems.map(i => i.mpn))
                      const hasNexarCols  = Object.keys(mpnNexarMap).length > 0
                      const hasLyticaCols = Object.keys(lyticaMap).length > 0

                      // ── Unified DataGrid for ALL result sizes ──
                      // Paginated grid with always-on per-column filters, global
                      // search, sorting and Excel export. Rendering only one page of
                      // rows keeps the UI snappy even for thousands of MPNs, while
                      // small result sets still get the same filters/columns.
                      {
                        type Entry = { mpn: string; bestRow: IQItem; allRows: IQItem[]; _status?: 'found' | 'pending' | 'nomatch'; _reason?: string }
                        const gridCols: DataGridColumn<Entry>[] = [
                          {
                            key: 'mpn', header: 'MPN', type: 'text',
                            accessor: e => e._status && e._status !== 'found' ? '' : e.bestRow.mpn,
                            render: e => {
                              if (e._status === 'pending') return (
                                <span className="inline-flex items-center gap-1 text-blue-500">
                                  <svg className="animate-spin h-3 w-3" fill="none" viewBox="0 0 24 24"><circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" /><path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8H4z" /></svg>
                                  querying…
                                </span>
                              )
                              if (e._status === 'nomatch') return <span className="text-gray-300">—</span>
                              // Only the MPN value opens the Supplier Savings modal — this keeps
                              // the rest of the row freely selectable for copy/paste.
                              return (
                                <button
                                  type="button"
                                  onClick={() => setMpnCompare({ mpn: e.mpn, allRows: e.allRows })}
                                  className="font-mono font-semibold text-emerald-700 hover:text-emerald-800 hover:underline underline-offset-2 cursor-pointer"
                                  title="Open Supplier Savings Analysis"
                                >
                                  {e.bestRow.mpn}
                                </button>
                              )
                            },
                          },
                          {
                            key: 'altPn', header: 'Alt PN', type: 'text', noSort: true,
                            accessor: e => multiMpnAmplMap[e.bestRow.internalPN]?.active.find(a => a.MfgPartNumber === e.bestRow.mpn)?.MpnPartNumber ?? '',
                            render: e => {
                              const resolvedAltPn = multiMpnAmplMap[e.bestRow.internalPN]?.active.find(a => a.MfgPartNumber === e.bestRow.mpn)?.MpnPartNumber
                              return <span className="font-mono text-gray-500">{resolvedAltPn && resolvedAltPn !== e.bestRow.mpn ? resolvedAltPn : '—'}</span>
                            },
                          },
                          {
                            key: 'supplier', header: 'Supplier', type: 'text',
                            accessor: e => e.bestRow.supplierName || e.bestRow.englishName || '',
                            render: e => <span className="text-gray-600 inline-block max-w-[180px] truncate align-bottom" title={e.bestRow.supplierName || e.bestRow.englishName || ''}>{e.bestRow.supplierName || e.bestRow.englishName || '—'}</span>,
                          },
                          {
                            key: 'searched', header: 'Searched', type: 'text',
                            accessor: e => e.mpn,
                            render: e => <span className="font-mono font-semibold text-blue-700">{e.mpn}</span>,
                          },
                          {
                            key: 'status', header: 'Status', type: 'select', align: 'center',
                            accessor: e => e._status === 'pending' ? 'querying' : e._status === 'nomatch' ? 'no match' : 'found',
                            render: e => {
                              if (e._status === 'pending') return <span className="text-[10px] font-semibold text-blue-700 bg-blue-100 px-1.5 py-0.5 rounded">querying…</span>
                              if (e._status === 'nomatch') return <span className="text-[10px] font-semibold text-gray-500 bg-gray-100 px-1.5 py-0.5 rounded" title={e._reason || ''}>{e._reason || 'no match'}</span>
                              return <span className="text-[10px] font-semibold text-emerald-700 bg-emerald-100 px-1.5 py-0.5 rounded">found</span>
                            },
                          },
                          {
                            key: 'internalPN', header: 'Internal PN', type: 'text',
                            accessor: e => e.bestRow.internalPN || '',
                            render: e => <span className="font-mono text-gray-700">{e.bestRow.internalPN || '—'}</span>,
                          },
                          {
                            key: 'plant', header: 'Plant', type: 'select', align: 'center',
                            accessor: e => e.bestRow.siteName || '',
                          },
                          {
                            key: 'qty', header: 'PO/QTY', type: 'number', align: 'right',
                            accessor: e => e.bestRow.quantity ?? null,
                            render: e => <span className="font-mono text-gray-700">{e.bestRow.quantity?.toLocaleString() ?? '—'}</span>,
                          },
                          {
                            key: 'cur', header: 'Cur', type: 'select', align: 'center',
                            accessor: e => e.bestRow.localCurrency || '',
                            render: e => <span className="font-mono text-gray-500">{e.bestRow.localCurrency || '—'}</span>,
                          },
                          {
                            key: 'lpoLocal', header: 'Last PO (Local)', type: 'number', align: 'right',
                            accessor: e => resolvePoLocal(e.bestRow),
                            render: e => <span className="font-mono text-gray-700">{resolvePoLocal(e.bestRow) != null ? resolvePoLocal(e.bestRow)!.toLocaleString('en-US', { minimumFractionDigits: 4 }) : '—'}</span>,
                          },
                          {
                            key: 'stdLocal', header: 'Std (Local)', type: 'number', align: 'right',
                            accessor: e => resolveStdLocal(e.bestRow),
                            render: e => <span className="font-mono text-gray-500">{resolveStdLocal(e.bestRow) != null ? resolveStdLocal(e.bestRow)!.toLocaleString('en-US', { minimumFractionDigits: 4 }) : '—'}</span>,
                          },
                          {
                            key: 'lpoUsd', header: 'Last PO (USD)', type: 'number', align: 'right',
                            accessor: e => resolveLastPoPrice(e.bestRow),
                            render: e => {
                              const lpoUsd = resolveLastPoPrice(e.bestRow)
                              const isLpoGtStd = lpoUsd != null && e.bestRow.standardPriceUsd != null && lpoUsd > e.bestRow.standardPriceUsd
                              return <span className={`font-mono font-semibold ${isLpoGtStd ? 'text-red-700' : 'text-blue-700'}`}>{fmt6(lpoUsd)}</span>
                            },
                          },
                          {
                            key: 'stdUsd', header: 'Std (USD)', type: 'number', align: 'right',
                            accessor: e => e.bestRow.standardPriceUsd ?? null,
                            render: e => <span className="font-mono text-gray-500">{fmt6(e.bestRow.standardPriceUsd)}</span>,
                          },
                          {
                            key: 'date', header: 'Date', type: 'date',
                            accessor: e => e.bestRow.lastPoDate || '',
                            render: e => <span className="text-gray-500">{e.bestRow.lastPoDate || '—'}</span>,
                          },
                          {
                            key: 'lpoGtStd', header: 'Last PO Price > Std Price', type: 'select', align: 'center',
                            accessor: e => {
                              const lpoUsd = resolveLastPoPrice(e.bestRow)
                              return (lpoUsd != null && e.bestRow.standardPriceUsd != null && lpoUsd > e.bestRow.standardPriceUsd) ? '1' : ''
                            },
                            render: e => {
                              const lpoUsd = resolveLastPoPrice(e.bestRow)
                              const isLpoGtStd = lpoUsd != null && e.bestRow.standardPriceUsd != null && lpoUsd > e.bestRow.standardPriceUsd
                              return isLpoGtStd ? <span className="text-[10px] font-bold text-red-700 bg-red-100 px-1.5 py-0.5 rounded">1</span> : null
                            },
                          },
                          {
                            key: 'swap', header: 'Swap', type: 'select', align: 'center',
                            accessor: e => (!!(myPlant && e.bestRow.siteName && e.bestRow.siteName !== myPlant)) ? '1' : '',
                            render: e => {
                              const isSwap = !!(myPlant && e.bestRow.siteName && e.bestRow.siteName !== myPlant)
                              return isSwap ? <span className="text-[10px] font-bold text-green-700 bg-green-100 px-1.5 py-0.5 rounded">1</span> : null
                            },
                          },
                          {
                            key: 'manualRev', header: 'Manual Rev.', type: 'select', align: 'center',
                            accessor: e => (resolveLastPoPrice(e.bestRow) === 0) ? '1' : '',
                            render: e => {
                              const isManual = resolveLastPoPrice(e.bestRow) === 0
                              return isManual ? <span className="text-[10px] font-bold text-amber-700 bg-amber-100 px-1.5 py-0.5 rounded">1</span> : null
                            },
                          },
                        ]
                        if (hasNexarCols) {
                          gridCols.push(
                            {
                              key: 'bestInMarket', header: 'Best in Market', type: 'select', align: 'center', className: 'text-purple-600',
                              accessor: e => {
                                const lpoUsd = resolveLastPoPrice(e.bestRow)
                                const nexarBestUsd = mpnNexarMap[e.mpn]?.nexarBestUsd ?? null
                                return (nexarBestUsd != null && lpoUsd != null && lpoUsd > 0 && nexarBestUsd < lpoUsd) ? '1' : ''
                              },
                              render: e => {
                                const lpoUsd = resolveLastPoPrice(e.bestRow)
                                const nexarBestUsd = mpnNexarMap[e.mpn]?.nexarBestUsd ?? null
                                const bestInMarket = nexarBestUsd != null && lpoUsd != null && lpoUsd > 0 && nexarBestUsd < lpoUsd
                                return bestInMarket ? <span className="text-[10px] font-bold text-purple-700 bg-purple-100 px-1.5 py-0.5 rounded">1</span> : null
                              },
                            },
                            {
                              key: 'nexarBest', header: 'Nexar Best (USD)', type: 'number', align: 'right', className: 'text-purple-600',
                              accessor: e => mpnNexarMap[e.mpn]?.nexarBestUsd ?? null,
                              render: e => <span className="font-mono text-purple-700">{fmt6(mpnNexarMap[e.mpn]?.nexarBestUsd ?? null)}</span>,
                            },
                            {
                              key: 'nexarSeller', header: 'Nexar Seller', type: 'text', className: 'text-purple-600',
                              accessor: e => mpnNexarMap[e.mpn]?.nexarSeller ?? '',
                              render: e => <span className="font-mono text-purple-600 inline-block max-w-[160px] truncate align-bottom" title={mpnNexarMap[e.mpn]?.nexarSeller}>{mpnNexarMap[e.mpn]?.nexarSeller || '—'}</span>,
                            },
                          )
                        }
                        if (hasLyticaCols) {
                          gridCols.push({
                            key: 'lytica90', header: 'Lytica 90th (USD)', type: 'number', align: 'right',
                            accessor: e => (lyticaMap[e.mpn.toUpperCase()] ?? lyticaMap[e.mpn])?.price90th ?? null,
                            render: e => {
                              const lytE = lyticaMap[e.mpn.toUpperCase()] ?? lyticaMap[e.mpn] ?? null
                              return <span className="font-mono text-teal-700">{lytE?.price90th != null ? fmt6(lytE.price90th) : '—'}</span>
                            },
                          })
                        }
                        const missingMpns = searchedSubset.filter(m => !foundSet.has(m))
                        const missingCount = missingMpns.length

                        // Placeholder IQItem for pending / no-match synthetic rows so
                        // every searched MPN is visible in the grid (not just priced ones).
                        const blankRow = (mpn: string): IQItem => ({
                          rawStandardPrice: 0, rawStandardPricePer: 0,
                          rawLastPoPrice: null, rawLastPoPer: null, uomConversion: 1,
                          localCurrencyExchangeRate: 0, localCurrencyExchangeRateUsd: 0,
                          mpn, internalPN: '', siteName: '', quantity: undefined as unknown as number,
                          standardPriceLocalCurr: undefined as unknown as number, lastPoPriceLocalCurr: null,
                          standardPriceUsd: undefined as unknown as number, lastPoPriceUsd: null,
                          localCurrency: '', lastPoDate: '', supplierNumber: '', supplierName: '',
                          englishName: null, manufacturerName: '', materialDescription: '',
                        })

                        // Build the full display list: priced matches first, then the
                        // MPNs still querying SAP, then the ones that returned no match.
                        const pendingEntries: Entry[] = pendingMpns.map(m => ({
                          mpn: m, bestRow: blankRow(m), allRows: [], _status: 'pending',
                        }))
                        const nomatchEntries: Entry[] = missingMpns.map(m => {
                          const reason = rawSet.has(m) ? 'No valid price data' : blockedSet.has(m) ? 'Blocked / Deleted' : 'No matches'
                          return { mpn: m, bestRow: blankRow(m), allRows: [], _status: 'nomatch', _reason: reason }
                        })
                        const foundEntries: Entry[] = tableEntries.map(e => ({ ...e, _status: 'found' as const }))
                        const displayRows: Entry[] = [...foundEntries, ...pendingEntries, ...nomatchEntries]

                        return (
                          <div>
                            <p className="text-[10px] text-gray-400 mb-1.5">
                              <span className="inline-flex items-center gap-1 text-blue-500">
                                <svg className="h-3 w-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="2"><path strokeLinecap="round" strokeLinejoin="round" d="M15 15l-2 5L9 9l11 4-5 2zm0 0l5 5M7.188 2.239l.777 2.897M5.136 7.965l-2.898-.777M13.95 4.05l-2.122 2.122m-5.657 5.656l-2.12 2.122" /></svg>
                                Click the MPN value
                              </span> to compare suppliers per plant and see potential savings.
                              {pendingMpns.length > 0 && <span className="ml-2 text-blue-500">· {pendingMpns.length} querying SAP…</span>}
                              {missingCount > 0 && <span className="ml-2 text-gray-400">· {missingCount} with no priced match</span>}
                            </p>
                            <DataGrid<Entry>
                              rows={displayRows}
                              columns={gridCols}
                              rowKey={(e) => `${e._status ?? 'found'}-${e.mpn}`}
                              pageSize={50}
                              dense
                              exportFileName={`PPV_MPN_Results_${new Date().toISOString().slice(0, 10)}`}
                              exportSheetName="IQ Results"
                              rowClassName={(e, i) => {
                                if (e._status === 'pending') return 'bg-blue-50/40'
                                if (e._status === 'nomatch') return 'bg-gray-50/40 opacity-80'
                                const lpoUsd = resolveLastPoPrice(e.bestRow)
                                const isLpoGtStd = lpoUsd != null && e.bestRow.standardPriceUsd != null && lpoUsd > e.bestRow.standardPriceUsd
                                const isSwap = !!(myPlant && e.bestRow.siteName && e.bestRow.siteName !== myPlant)
                                return isLpoGtStd ? 'bg-red-50 hover:bg-red-100/70' : isSwap ? 'bg-green-50 hover:bg-green-100/70' : i % 2 === 0 ? 'hover:bg-gray-50' : 'bg-gray-50/50 hover:bg-gray-100/50'
                              }}
                            />
                          </div>
                        )
                      }

                      /* eslint-disable no-unreachable */
                      // NOTE: legacy plain-table fallback — superseded by the DataGrid
                      // above (which now handles all result sizes). Kept temporarily
                      // for reference; never reached at runtime.
                      // eslint-disable-next-line no-constant-condition
                      if (false) return (
                        <div className="overflow-x-auto rounded-xl border border-gray-200 shadow-sm">
                          <table className="min-w-max w-full text-xs border-collapse">
                            <thead className="bg-gray-50 text-[10px] uppercase tracking-wide text-gray-500 sticky top-0 z-[1]">
                              <tr>
                                <th className="px-2 py-2.5 w-6 border-b border-gray-200" />
                                <th className="px-3 py-2.5 text-left whitespace-nowrap border-b border-gray-200">MPN</th>
                                <th className="px-3 py-2.5 text-left whitespace-nowrap border-b border-gray-200">Alt PN</th>
                                <th className="px-3 py-2.5 text-left whitespace-nowrap border-b border-gray-200">Supplier</th>
                                <th className="px-3 py-2.5 text-left whitespace-nowrap border-b border-gray-200">Searched</th>
                                <th className="px-3 py-2.5 text-left whitespace-nowrap border-b border-gray-200">Internal PN</th>
                                <th className="px-3 py-2.5 text-left whitespace-nowrap border-b border-gray-200">Plant</th>
                                <th className="px-3 py-2.5 text-right whitespace-nowrap border-b border-gray-200">PO/QTY</th>
                                <th className="px-3 py-2.5 text-center whitespace-nowrap border-b border-gray-200">Cur</th>
                                <th className="px-3 py-2.5 text-right whitespace-nowrap border-b border-gray-200">Last PO (Local)</th>
                                <th className="px-3 py-2.5 text-right whitespace-nowrap border-b border-gray-200">Std (Local)</th>
                                <th className="px-3 py-2.5 text-right whitespace-nowrap border-b border-gray-200">Last PO (USD)</th>
                                <th className="px-3 py-2.5 text-right whitespace-nowrap border-b border-gray-200">Std (USD)</th>
                                <th className="px-3 py-2.5 text-left whitespace-nowrap border-b border-gray-200">Date</th>
                                <th className="px-3 py-2.5 text-center whitespace-nowrap border-b border-gray-200">Last PO Price &gt; Std Price</th>
                                <th className="px-3 py-2.5 text-center whitespace-nowrap border-b border-gray-200">Swap</th>
                                <th className="px-3 py-2.5 text-center whitespace-nowrap border-b border-gray-200">Manual Rev.</th>
                                {hasNexarCols && <th className="px-3 py-2.5 text-center whitespace-nowrap border-b border-gray-200 text-purple-600">Best in Market</th>}
                                {hasNexarCols && <th className="px-3 py-2.5 text-right whitespace-nowrap border-b border-gray-200 text-purple-600">Nexar Best (USD)</th>}
                                {hasNexarCols && <th className="px-3 py-2.5 text-left whitespace-nowrap border-b border-gray-200 text-purple-600">Nexar Seller</th>}
                                {hasLyticaCols && <th className="px-3 py-2.5 text-right whitespace-nowrap border-b border-teal-200 text-teal-600">Lytica 90th (USD)</th>}
                              </tr>
                            </thead>
                            <tbody className="divide-y divide-gray-100">
                              {pendingMpns.map(mpn => (
                                <tr key={`pending-${mpn}`} className="bg-blue-50/40 animate-pulse">
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
                                  <td className="px-3 py-2 text-gray-500 whitespace-nowrap">—</td>
                                  <td className="px-3 py-2 text-center whitespace-nowrap" />
                                  <td className="px-3 py-2 text-center whitespace-nowrap" />
                                  <td className="px-3 py-2 text-center whitespace-nowrap" />
                                  {hasNexarCols && <td className="px-3 py-2 whitespace-nowrap" />}
                                  {hasNexarCols && <td className="px-3 py-2 whitespace-nowrap" />}
                                  {hasNexarCols && <td className="px-3 py-2 whitespace-nowrap" />}
                                  {hasLyticaCols && <td className="px-3 py-2 whitespace-nowrap" />}
                                </tr>
                              ))}
                              {tableEntries.map(({ mpn, bestRow }, i) => {
                                const lpoUsd     = resolveLastPoPrice(bestRow)
                                const stdUsd     = bestRow.standardPriceUsd
                                const isLpoGtStd = lpoUsd != null && stdUsd != null && lpoUsd > stdUsd
                                const isSwap     = !!(myPlant && bestRow.siteName && bestRow.siteName !== myPlant)
                                const isManual   = lpoUsd === 0
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
                                    {hasNexarCols && (
                                      <td className="px-3 py-2 text-center whitespace-nowrap">
                                        {bestInMarket && <span className="text-[10px] font-bold text-purple-700 bg-purple-100 px-1.5 py-0.5 rounded">1</span>}
                                      </td>
                                    )}
                                    {hasNexarCols && (
                                      <td className="px-3 py-2 text-right font-mono text-purple-700 whitespace-nowrap">{fmt6(nexarBestUsd)}</td>
                                    )}
                                    {hasNexarCols && (
                                      <td className="px-3 py-2 text-left font-mono text-purple-600 whitespace-nowrap max-w-[160px] truncate" title={nexarSeller}>{nexarSeller || '—'}</td>
                                    )}
                                    {hasLyticaCols && (() => {
                                      const lytE = lyticaMap[mpn.toUpperCase()] ?? lyticaMap[mpn] ?? null
                                      return <td className="px-3 py-2 text-right font-mono text-teal-700 whitespace-nowrap bg-teal-50/30">{lytE?.price90th != null ? fmt6(lytE.price90th) : '—'}</td>
                                    })()}
                                  </tr>
                                )
                              })}
                              {(() => {
                                return searchedSubset.filter(m => !foundSet.has(m)).map(m => {
                                  const reason    = rawSet.has(m) ? 'No valid price data' : blockedSet.has(m) ? 'Blocked / Deleted' : 'No matches'
                                  const isBlocked = reason === 'Blocked / Deleted'
                                  const nexE = mpnNexarMap[m] ?? mpnNexarMap[m.toUpperCase()] ?? null
                                  const lytE = lyticaMap[m.toUpperCase()] ?? lyticaMap[m] ?? null
                                  const hasAltData = (hasNexarCols && nexE?.nexarBestUsd != null) || (hasLyticaCols && lytE?.price90th != null)
                                  if (hasAltData) {
                                    return (
                                      <tr key={`missing-${m}`} className="bg-orange-50/30 hover:bg-orange-50/60">
                                        <td className="px-2 py-2 text-center">
                                          <svg className="h-3 w-3 mx-auto text-orange-400" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z"/></svg>
                                        </td>
                                        <td className="px-3 py-2 font-mono text-orange-700 whitespace-nowrap">
                                          {m}
                                          {nexE?.nexarBestUsd != null && lytE?.price90th != null
                                            ? <span className="ml-1.5 text-[9px] font-semibold bg-purple-100 text-purple-600 px-1.5 py-0.5 rounded uppercase tracking-wide">Nexar/Lytica</span>
                                            : nexE?.nexarBestUsd != null
                                              ? <span className="ml-1.5 text-[9px] font-semibold bg-orange-100 text-orange-500 px-1.5 py-0.5 rounded uppercase tracking-wide">Nexar</span>
                                              : <span className="ml-1.5 text-[9px] font-semibold bg-teal-100 text-teal-600 px-1.5 py-0.5 rounded uppercase tracking-wide">Lytica</span>
                                          }
                                        </td>
                                        <td className="px-3 py-2 text-gray-300 whitespace-nowrap">—</td>
                                        <td className="px-3 py-2 text-gray-300 whitespace-nowrap">—</td>
                                        <td className="px-3 py-2 font-mono font-semibold text-orange-400 whitespace-nowrap">{m}</td>
                                        <td className="px-3 py-2 text-gray-300 whitespace-nowrap">—</td>
                                        <td className="px-3 py-2 text-gray-300 whitespace-nowrap">—</td>
                                        <td className="px-3 py-2 text-right text-gray-300 whitespace-nowrap">—</td>
                                        <td className="px-3 py-2 text-center text-gray-300 whitespace-nowrap">—</td>
                                        <td className="px-3 py-2 text-right text-gray-300 whitespace-nowrap">—</td>
                                        <td className="px-3 py-2 text-right text-gray-300 whitespace-nowrap">—</td>
                                        <td className="px-3 py-2 text-right text-gray-300 whitespace-nowrap">—</td>
                                        <td className="px-3 py-2 text-right text-gray-300 whitespace-nowrap">—</td>
                                        <td className="px-3 py-2 text-gray-300 whitespace-nowrap">—</td>
                                        <td className="px-3 py-2 whitespace-nowrap" />
                                        <td className="px-3 py-2 whitespace-nowrap" />
                                        <td className="px-3 py-2 whitespace-nowrap" />
                                        {hasNexarCols && <td className="px-3 py-2 whitespace-nowrap" />}
                                        {hasNexarCols && <td className="px-3 py-2 text-right font-mono font-semibold text-purple-700 whitespace-nowrap">{nexE?.nexarBestUsd != null ? fmt6(nexE.nexarBestUsd) : '—'}</td>}
                                        {hasNexarCols && <td className="px-3 py-2 text-left font-mono text-purple-600 whitespace-nowrap max-w-[160px] truncate" title={nexE?.nexarSeller}>{nexE?.nexarSeller || '—'}</td>}
                                        {hasLyticaCols && <td className="px-3 py-2 text-right font-mono font-semibold text-teal-700 whitespace-nowrap bg-teal-50/30">{lytE?.price90th != null ? fmt6(lytE.price90th) : '—'}</td>}
                                      </tr>
                                    )
                                  }
                                  return (
                                    <tr key={`missing-${m}`} className={isBlocked ? 'bg-amber-50/60' : 'bg-gray-50/40'}>
                                      <td className="px-2 py-2 text-center text-gray-300">—</td>
                                      <td className="px-3 py-2 font-mono text-gray-500 whitespace-nowrap">{m}</td>
                                      <td colSpan={15 + (hasNexarCols ? 3 : 0) + (hasLyticaCols ? 1 : 0)} className={`px-3 py-2 text-xs italic ${isBlocked ? 'text-amber-500' : 'text-gray-400'}`}>{reason}</td>
                                    </tr>
                                  )
                                })
                              })()}
                            </tbody>
                          </table>
                        </div>
                      )
                    }

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

                        {/* ── IQ Results: cached (instant) + first-time tables ── */}
                        {multiMpnSubTab === 'results' && multiMpnSearchedList.length > 0 && (
                          <div className="space-y-4">
                            {/* Cached — instant from the persistent DB cache */}
                            {(cachedEntries.length > 0 || cachedSearched.length > 0) && (
                              <div>
                                <div className="flex items-center gap-2 mb-1.5">
                                  <svg className="h-3.5 w-3.5 text-indigo-500" fill="currentColor" viewBox="0 0 20 20"><path d="M11 3a1 1 0 10-2 0v1.586l-2.293-2.293a1 1 0 10-1.414 1.414L7.586 7H6a1 1 0 000 2h5a1 1 0 001-1V3z"/><path d="M3 9a1 1 0 011-1h2.586L4.293 5.707a1 1 0 010-1.414L9 9v8a1 1 0 11-2 0v-4.586l-3.293 3.293a1 1 0 01-1.414-1.414L4.586 11H4a1 1 0 01-1-1V9z"/></svg>
                                  <span className="text-xs font-bold text-indigo-700">Instant best price (DB cache · SAP only)</span>
                                  <span className="text-[10px] text-indigo-400">{cachedEntries.length} cached</span>
                                </div>
                                <p className="text-[10px] text-gray-400 mb-2">Cheapest Last PO (USD) within a {windowDays}-day window from the latest purchase date — one row per MPN</p>
                                {renderDetailTable(cachedEntries, cachedSearched, [])}
                              </div>
                            )}
                            {/* First-time — queried live now, not yet in the cache */}
                            {(freshEntries.length > 0 || freshSearched.length > 0) && (
                              <div>
                                <div className="flex items-center gap-2 mb-1.5">
                                  {freshPending.length > 0
                                    ? <svg className="animate-spin h-3.5 w-3.5 text-amber-500" fill="none" viewBox="0 0 24 24"><circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" /><path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8H4z" /></svg>
                                    : <svg className="h-3.5 w-3.5 text-amber-500" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="2"><path strokeLinecap="round" strokeLinejoin="round" d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" /></svg>}
                                  <span className="text-xs font-bold text-amber-700">First-time query · not cached</span>
                                  <span className="text-[10px] text-amber-400">{freshEntries.length} found{freshPending.length > 0 ? ` · ${freshPending.length} querying SAP…` : ''}</span>
                                </div>
                                <p className="text-[10px] text-gray-400 mb-2">These MPNs weren’t in the database — they’re being looked up live now and saved to the cache for next time.</p>
                                {renderDetailTable(freshEntries, freshSearched.filter(m => (mpnStatusMap[m.toUpperCase()] ?? 'done') !== 'pending'), freshPending)}
                              </div>
                            )}
                          </div>
                        )}

                        {/* ── All Records: per-MPN expander ── */}
                        {multiMpnSubTab === 'allrecords' && (mpnEntries.length > 0 || multiMpnSearchedList.length > 0) && (() => {
                          // Flatten every record (cached + loaded so far) into a single
                          // paginated grid (25 rows/page) so the page stays fast even with
                          // thousands of records. Includes search, per-column filters & export.
                          type AllRow = { _mpn: string; row: IQItem }
                          const flatRows: AllRow[] = mpnEntries.flatMap(e => e.allRows.map(row => ({ _mpn: e.mpn, row })))
                          const allCols: DataGridColumn<AllRow>[] = [
                            { key: 'mpn', header: 'MPN', type: 'text', accessor: r => r.row.mpn, render: r => <span className="font-mono text-gray-700">{r.row.mpn}</span> },
                            { key: 'internalPN', header: 'Internal PN', type: 'text', accessor: r => r.row.internalPN || '', render: r => <span className="font-mono font-semibold text-blue-700">{r.row.internalPN || '—'}</span> },
                            { key: 'plant', header: 'Plant', type: 'select', align: 'center', accessor: r => r.row.siteName || '' },
                            { key: 'supplier', header: 'Supplier', type: 'text', accessor: r => r.row.supplierName || r.row.englishName || '', render: r => <span className="text-gray-600 inline-block max-w-[160px] truncate align-bottom" title={r.row.supplierName || r.row.englishName || ''}>{r.row.supplierName || r.row.englishName || '—'}</span> },
                            { key: 'desc', header: 'Description', type: 'text', accessor: r => r.row.materialDescription || '', render: r => <span className="text-gray-500 inline-block max-w-[200px] truncate align-bottom" title={r.row.materialDescription}>{r.row.materialDescription || '—'}</span> },
                            { key: 'qty', header: 'Qty', type: 'number', align: 'right', accessor: r => r.row.quantity ?? null, render: r => <span className="font-mono text-gray-700">{r.row.quantity?.toLocaleString() ?? '—'}</span> },
                            { key: 'cur', header: 'Cur', type: 'select', align: 'center', accessor: r => r.row.localCurrency || '', render: r => <span className="font-mono text-gray-500">{r.row.localCurrency || '—'}</span> },
                            { key: 'lpoLocal', header: 'Last PO (Local)', type: 'number', align: 'right', accessor: r => resolvePoLocal(r.row), render: r => <span className="font-mono text-gray-700">{resolvePoLocal(r.row) != null ? resolvePoLocal(r.row)!.toLocaleString('en-US', { minimumFractionDigits: 4 }) : '—'}</span> },
                            { key: 'stdLocal', header: 'Std (Local)', type: 'number', align: 'right', accessor: r => resolveStdLocal(r.row), render: r => <span className="font-mono text-gray-500">{resolveStdLocal(r.row) != null ? resolveStdLocal(r.row)!.toLocaleString('en-US', { minimumFractionDigits: 4 }) : '—'}</span> },
                            { key: 'lpoUsd', header: 'Last PO (USD)', type: 'number', align: 'right', accessor: r => resolveLastPoPrice(r.row), render: r => <span className="font-mono font-semibold text-blue-700">{fmt6(resolveLastPoPrice(r.row))}</span> },
                            { key: 'stdUsd', header: 'Std (USD)', type: 'number', align: 'right', accessor: r => r.row.standardPriceUsd ?? null, render: r => <span className="font-mono text-gray-500">{fmt6(r.row.standardPriceUsd)}</span> },
                            { key: 'date', header: 'Date', type: 'date', accessor: r => r.row.lastPoDate || '', render: r => <span className="text-gray-500">{r.row.lastPoDate || '—'}</span> },
                          ]
                          const foundKeys = new Set(mpnEntries.map(e => e.mpn.toUpperCase()))
                          const pendingMpnsAll = multiMpnSearchedList.filter(m => !foundKeys.has(m.toUpperCase()))
                          // Excel-like banding by MPN: every distinct MPN gets a band
                          // index, and consecutive MPN groups alternate between two
                          // shades so you can see where one MPN's rows end and the next
                          // begins. The color depends on the MPN value (not the table
                          // row index), so banding stays consistent through sorting.
                          const mpnBandIndex = new Map<string, number>()
                          for (const r of flatRows) {
                            const k = r._mpn.toUpperCase()
                            if (!mpnBandIndex.has(k)) mpnBandIndex.set(k, mpnBandIndex.size)
                          }
                          const bandClass = (r: AllRow): string => {
                            const idx = mpnBandIndex.get(r._mpn.toUpperCase()) ?? 0
                            return idx % 2 === 0
                              ? 'bg-white hover:bg-blue-50/60'
                              : 'bg-slate-100/70 hover:bg-blue-50/60'
                          }
                          return (
                            <div>
                              <DataGrid<AllRow>
                                rows={flatRows}
                                columns={allCols}
                                rowKey={(r, i) => `${r._mpn}-${i}`}
                                pageSize={25}
                                dense
                                rowClassName={bandClass}
                                exportFileName={`PPV_MPN_All_Records_${new Date().toISOString().slice(0, 10)}`}
                                exportSheetName="All Records"
                              />
                              {pendingMpnsAll.length > 0 && (
                                <p className="text-[10px] text-gray-400 mt-1.5 flex items-center gap-1.5">
                                  {multiMpnLoading && <svg className="animate-spin h-3 w-3 text-blue-500" fill="none" viewBox="0 0 24 24"><circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" /><path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8H4z" /></svg>}
                                  <span>{pendingMpnsAll.length} MPN{pendingMpnsAll.length !== 1 ? 's' : ''} {multiMpnLoading ? 'still querying SAP…' : 'returned no records'}</span>
                                </p>
                              )}
                            </div>
                          )
                        })()}

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
                                        {NEXAR_ENABLED && <th className="px-3 py-2.5 text-center border-b border-gray-200 border-l border-l-orange-200 whitespace-nowrap bg-orange-50/50" colSpan={6}>Nexar Market</th>}
                                        {Object.keys(lyticaMap).length > 0 && <th className="px-3 py-2.5 text-center border-b border-gray-200 border-l border-l-teal-200 whitespace-nowrap bg-teal-50/50" colSpan={4}>Lytica</th>}
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
                                        {NEXAR_ENABLED && <>
                                        <th className="px-3 py-2 text-left border-b border-gray-200 border-l border-l-orange-200 whitespace-nowrap bg-orange-50/30">MPN</th>
                                        <th className="px-3 py-2 text-left border-b border-gray-200 whitespace-nowrap bg-orange-50/30">Manufacturer</th>
                                        <th className="px-3 py-2 text-left border-b border-gray-200 whitespace-nowrap bg-orange-50/30">Supplier</th>
                                        <th className="px-3 py-2 text-right border-b border-gray-200 whitespace-nowrap bg-orange-50/30">Unit Price (USD)</th>
                                        <th className="px-3 py-2 text-right border-b border-gray-200 whitespace-nowrap bg-orange-50/30">Stock</th>
                                        <th className="px-3 py-2 text-right border-b border-gray-200 whitespace-nowrap bg-orange-50/30">MOQ</th>
                                        </>}
                                        {Object.keys(lyticaMap).length > 0 && <th className="px-3 py-2 text-left border-b border-gray-200 border-l border-l-teal-200 whitespace-nowrap bg-teal-50/30">MPN Searched</th>}
                                        {Object.keys(lyticaMap).length > 0 && <th className="px-3 py-2 text-left border-b border-gray-200 whitespace-nowrap bg-teal-50/30">MPN Matched</th>}
                                        {Object.keys(lyticaMap).length > 0 && <th className="px-3 py-2 text-left border-b border-gray-200 whitespace-nowrap bg-teal-50/30">Manufacturer</th>}
                                        {Object.keys(lyticaMap).length > 0 && <th className="px-3 py-2 text-right border-b border-gray-200 whitespace-nowrap bg-teal-50/30">90th %tile</th>}
                                      </tr>
                                    </thead>
                                    <tbody className="divide-y divide-gray-100">
                                      {deepAnalysisRows.slice(deepPage * DEEP_PAGE_SIZE, deepPage * DEEP_PAGE_SIZE + DEEP_PAGE_SIZE).map(dr => {
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
                                            {NEXAR_ENABLED && (() => {
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
                                            {/* Winner */}
                                            <td className="px-3 py-2.5 text-center border-l border-l-gray-200">
                                              {dr.status === 'loading' ? null
                                                : winner === 'mpn'    ? <span className="px-2 py-0.5 text-[10px] font-bold rounded-full bg-emerald-100 text-emerald-700">Interplant (MPN)</span>
                                                : winner === 'mc'     ? <span className="px-2 py-0.5 text-[10px] font-bold rounded-full bg-purple-100 text-purple-700">Interplant (IPN)</span>
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
                                {/* Deep Analysis pagination footer (25 rows/page) */}
                                {deepAnalysisRows.length > DEEP_PAGE_SIZE && (() => {
                                  const total = deepAnalysisRows.length
                                  const pageCount = Math.max(1, Math.ceil(total / DEEP_PAGE_SIZE))
                                  const safePage = Math.min(deepPage, pageCount - 1)
                                  const fromRow = safePage * DEEP_PAGE_SIZE + 1
                                  const toRow = Math.min(total, safePage * DEEP_PAGE_SIZE + DEEP_PAGE_SIZE)
                                  return (
                                    <div className="flex flex-wrap items-center justify-between gap-2 pt-2">
                                      <span className="text-[11px] text-gray-500">{fromRow}–{toRow} of {total} internal PNs</span>
                                      <div className="flex items-center gap-1">
                                        <button onClick={() => setDeepPage(0)} disabled={safePage === 0} className="p-1 rounded border border-gray-200 text-gray-600 hover:bg-gray-50 disabled:opacity-40 disabled:cursor-not-allowed" title="First page">
                                          <svg className="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="2"><path strokeLinecap="round" strokeLinejoin="round" d="M11 19l-7-7 7-7m8 14l-7-7 7-7" /></svg>
                                        </button>
                                        <button onClick={() => setDeepPage(p => Math.max(0, p - 1))} disabled={safePage === 0} className="p-1 rounded border border-gray-200 text-gray-600 hover:bg-gray-50 disabled:opacity-40 disabled:cursor-not-allowed" title="Previous page">
                                          <svg className="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="2"><path strokeLinecap="round" strokeLinejoin="round" d="M15 19l-7-7 7-7" /></svg>
                                        </button>
                                        <span className="px-2 text-[11px] text-gray-600 whitespace-nowrap">Page <span className="font-semibold">{safePage + 1}</span> / {pageCount}</span>
                                        <button onClick={() => setDeepPage(p => Math.min(pageCount - 1, p + 1))} disabled={safePage >= pageCount - 1} className="p-1 rounded border border-gray-200 text-gray-600 hover:bg-gray-50 disabled:opacity-40 disabled:cursor-not-allowed" title="Next page">
                                          <svg className="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="2"><path strokeLinecap="round" strokeLinejoin="round" d="M9 5l7 7-7 7" /></svg>
                                        </button>
                                        <button onClick={() => setDeepPage(pageCount - 1)} disabled={safePage >= pageCount - 1} className="p-1 rounded border border-gray-200 text-gray-600 hover:bg-gray-50 disabled:opacity-40 disabled:cursor-not-allowed" title="Last page">
                                          <svg className="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="2"><path strokeLinecap="round" strokeLinejoin="round" d="M13 5l7 7-7 7M5 5l7 7-7 7" /></svg>
                                        </button>
                                      </div>
                                    </div>
                                  )
                                })()}
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
                            ) : (() => {
                              // Flatten all blocked/deleted groups into one paginated grid
                              // (25 rows/page) with filters by Kind / Code / Reason so the
                              // page stays fast and the user can drill down by reason.
                              type BlkRow = {
                                kind: 'blocked' | 'deleted'; code: string; reason: string
                                internalPN: string; mpn: string; altPn: string; mfgName: string
                              }
                              const seenAll = new Set<string>()
                              const flatBlocked: BlkRow[] = blockedGroups.flatMap(group =>
                                group.items.map(item => {
                                  const altPn = item.mpnPartNumber && item.mpnPartNumber !== item.mpn ? item.mpnPartNumber : '—'
                                  return {
                                    kind: group.kind, code: group.code, reason: group.reason,
                                    internalPN: item.internalPN, mpn: item.mpn, altPn, mfgName: item.mfgName || '—',
                                  }
                                }),
                              ).filter(r => {
                                const key = `${r.kind}|${r.code}|${r.internalPN}|${r.mpn}|${r.altPn}|${r.mfgName}`
                                if (seenAll.has(key)) return false
                                seenAll.add(key)
                                return true
                              })
                              const blkCols: DataGridColumn<BlkRow>[] = [
                                {
                                  key: 'kind', header: 'Kind', type: 'select', align: 'center',
                                  accessor: r => r.kind === 'blocked' ? 'BLOCKED' : 'DELETED',
                                  render: r => {
                                    const isDanger = r.code === 'F' || r.code === 'ER'
                                    return <span className={`text-[10px] font-bold px-2 py-0.5 rounded-full ${isDanger ? 'bg-red-200 text-red-800' : r.kind === 'blocked' ? 'bg-amber-200 text-amber-800' : 'bg-red-200 text-red-800'}`}>{r.kind === 'blocked' ? 'BLOCKED' : 'DELETED'}</span>
                                  },
                                },
                                { key: 'code', header: 'Code', type: 'select', align: 'center', accessor: r => r.code, render: r => <span className="font-mono font-bold text-gray-800">{r.code}</span> },
                                { key: 'reason', header: 'Reason', type: 'text', accessor: r => r.reason, render: r => <span className="text-gray-600">{r.reason}</span> },
                                { key: 'internalPN', header: 'Internal PN', type: 'text', accessor: r => r.internalPN, render: r => <span className="font-mono font-semibold text-blue-700">{r.internalPN}</span> },
                                { key: 'mpn', header: 'MPN', type: 'text', accessor: r => r.mpn, render: r => <span className="font-mono text-gray-700">{r.mpn}</span> },
                                { key: 'altPn', header: 'Alt PN', type: 'text', accessor: r => r.altPn, render: r => <span className="font-mono text-gray-500">{r.altPn}</span> },
                                { key: 'mfgName', header: 'Manufacturer', type: 'text', accessor: r => r.mfgName, render: r => <span className="text-gray-600">{r.mfgName}</span> },
                              ]
                              return (
                                <DataGrid<BlkRow>
                                  rows={flatBlocked}
                                  columns={blkCols}
                                  rowKey={(r, i) => `${r.kind}-${r.code}-${i}`}
                                  pageSize={25}
                                  dense
                                  exportFileName={`PPV_MPN_Blocked_Deleted_${new Date().toISOString().slice(0, 10)}`}
                                  exportSheetName="Blocked Deleted"
                                />
                              )
                            })()}
                          </div>
                        )}
                      </div>
                    )
                  })()}
                </div>
              )}

              {/* •••••••••••••• AMPL DEMAND TAB •••••••••••••• */}
              {activeTab === 'ampl' && (
                <div className="space-y-5">

                  {/* ── Sheet picker modal ───────────────────────────────── */}
                  {amplSheetPickerOpen && (
                    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-sm">
                      <div className="bg-white rounded-2xl shadow-2xl border border-gray-200 w-full max-w-sm mx-4 overflow-hidden">
                        <div className="px-6 py-4 border-b border-gray-100 flex items-center gap-3">
                          <span className="flex h-9 w-9 items-center justify-center rounded-xl bg-indigo-100">
                            <svg className="h-5 w-5 text-indigo-600" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 17v-2m3 2v-4m3 4v-6m2 10H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" /></svg>
                          </span>
                          <div>
                            <h3 className="text-sm font-semibold text-gray-800">Multiple Sheets Detected</h3>
                            <p className="text-xs text-gray-500 mt-0.5">This workbook has {amplSheetNames.length} sheets. Select the one to import.</p>
                          </div>
                        </div>
                        <div className="px-6 py-5">
                          <label className="block text-xs font-medium text-gray-600 mb-1.5">Sheet</label>
                          <select
                            value={amplSheetPickerSelected}
                            onChange={e => setAmplSheetPickerSelected(e.target.value)}
                            className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm bg-white focus:outline-none focus:ring-2 focus:ring-indigo-500"
                          >
                            {amplSheetNames.map(name => (
                              <option key={name} value={name}>{name}</option>
                            ))}
                          </select>
                        </div>
                        <div className="px-6 pb-5 flex justify-end gap-2">
                          <button
                            onClick={() => { setAmplSheetPickerOpen(false); amplPendingWbRef.current = null }}
                            className="px-4 py-2 text-sm font-medium rounded-lg border border-gray-300 text-gray-600 hover:bg-gray-50 transition-colors"
                          >Cancel</button>
                          <button
                            onClick={handleAmplSheetPickerConfirm}
                            className="px-4 py-2 text-sm font-semibold rounded-lg bg-indigo-600 hover:bg-indigo-700 text-white transition-colors shadow-sm"
                          >Import Sheet</button>
                        </div>
                      </div>
                    </div>
                  )}

                  {/* ── Missing filter columns alert ─────────────────────── */}
                  {amplMissingColsAlertOpen && (
                    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-sm">
                      <div className="bg-white rounded-2xl shadow-2xl border border-gray-200 w-full max-w-md mx-4 overflow-hidden">
                        <div className="px-6 py-4 border-b border-amber-100 bg-amber-50 flex items-start gap-3">
                          <span className="flex h-9 w-9 items-center justify-center rounded-xl bg-amber-100 shrink-0 mt-0.5">
                            <svg className="h-5 w-5 text-amber-600" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z" /></svg>
                          </span>
                          <div>
                            <h3 className="text-sm font-semibold text-amber-800">Filter Columns Not Found</h3>
                            <p className="text-xs text-amber-700 mt-1 leading-relaxed">
                              The MPN column was found, but none of the standard filter columns were detected in this file:
                            </p>
                          </div>
                        </div>
                        <div className="px-6 py-4">
                          <ul className="space-y-1.5 mb-4">
                            {['Blk — blocked rows', 'D — discontinued rows', 'Valid to — expired price records', 'Total Demand — zero-demand rows'].map(label => (
                              <li key={label} className="flex items-center gap-2 text-xs text-gray-600">
                                <span className="w-1.5 h-1.5 rounded-full bg-amber-400 shrink-0" />
                                {label}
                              </li>
                            ))}
                          </ul>
                          <p className="text-xs text-gray-500 leading-relaxed">
                            Without these columns, <strong>no automatic filtering will be applied</strong> and all rows will be imported as-is. Do you want to continue?
                          </p>
                        </div>
                        <div className="px-6 pb-5 flex justify-end gap-2">
                          <button
                            onClick={() => { setAmplMissingColsAlertOpen(false); amplPendingDataRef.current = null }}
                            className="px-4 py-2 text-sm font-medium rounded-lg border border-gray-300 text-gray-600 hover:bg-gray-50 transition-colors"
                          >Cancel</button>
                          <button
                            onClick={handleAmplMissingColsContinue}
                            className="px-4 py-2 text-sm font-semibold rounded-lg bg-amber-500 hover:bg-amber-600 text-white transition-colors shadow-sm"
                          >Continue Anyway</button>
                        </div>
                      </div>
                    </div>
                  )}

                  {/* ── Control card ─────────────────────────────────────────── */}
                  <div className="bg-white rounded-xl border border-gray-200 shadow-sm overflow-hidden">

                    {/* Header */}
                    <div className="px-5 py-4 border-b border-gray-100 flex items-center justify-between">
                      <div>
                        <h3 className="text-sm font-semibold text-gray-800 flex items-center gap-2">
                          <svg className="h-4 w-4 text-indigo-500" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 17v-2m3 2v-4m3 4v-6m2 10H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" /></svg>
                          AMPL Demand
                        </h3>
                        <p className="text-[11px] text-gray-400 mt-0.5 ml-6">Rows with Blk / D / expired "Valid to" / zero Total Demand are automatically filtered out.</p>
                      </div>
                      {/* Status pills */}
                      <div className="flex items-center gap-2 flex-wrap justify-end">
                        {amplDemandFileName && (
                          <span className="flex items-center gap-1.5 text-[11px] font-medium text-indigo-700 bg-indigo-50 border border-indigo-200 rounded-full px-2.5 py-0.5">
                            <svg className="h-3 w-3 text-indigo-400" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 17v-2m3 2v-4m3 4v-6m2 10H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" /></svg>
                            {amplDemandFileName}
                            <span className="text-indigo-400">· {amplDemandRows.length} rows</span>
                            <button onClick={() => { setAmplDemandFileName(''); setAmplDemandRows([]); setAmplDemandHeaders([]); setAmplDemandMpnColIdx(-1); setAmplDemandRawResults([]); setAmplDemandDeepRows([]) }} className="ml-0.5 text-indigo-400 hover:text-red-500 leading-none font-bold" title="Clear file">×</button>
                          </span>
                        )}
                        {lyticaFileName && (
                          <span className="flex items-center gap-1.5 text-[11px] font-medium text-teal-700 bg-teal-50 border border-teal-200 rounded-full px-2.5 py-0.5">
                            <svg className="h-3 w-3 text-teal-400" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 19v-6a2 2 0 00-2-2H5a2 2 0 00-2 2v6a2 2 0 002 2h2a2 2 0 002-2zm0 0V9a2 2 0 012-2h2a2 2 0 012 2v10m-6 0a2 2 0 002 2h2a2 2 0 002-2m0 0V5a2 2 0 012-2h2a2 2 0 012 2v14a2 2 0 01-2 2h-2a2 2 0 01-2-2z" /></svg>
                            Lytica · {lyticaFileName}
                            <button onClick={() => { setLyticaFileName(''); setLyticaMap({}) }} className="ml-0.5 text-teal-400 hover:text-red-500 leading-none font-bold" title="Clear Lytica">×</button>
                          </span>
                        )}
                      </div>
                    </div>

                    {/* Row 1 – File uploads */}
                    <div className="px-5 py-3 flex items-center gap-3 flex-wrap border-b border-gray-100 bg-gray-50/60">
                      <span className="text-[10px] font-semibold text-gray-400 uppercase tracking-wide w-16 shrink-0">Upload</span>
                      <label className="flex items-center gap-1.5 cursor-pointer px-3 py-1.5 text-xs font-semibold rounded-lg bg-white border border-indigo-300 hover:border-indigo-500 hover:text-indigo-600 text-gray-600 transition-colors shadow-sm" title="Upload AMPL Demand Excel file (.xlsx)">
                        <svg className="h-3.5 w-3.5 text-indigo-400" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-8l-4-4m0 0L8 8m4-4v12" /></svg>
                        AMPL Demand {amplDemandFileName ? '(replace)' : ''}
                        <input type="file" accept=".xlsx,.xls" className="hidden" onChange={handleAmplDemandUpload} />
                      </label>
                      <label className="flex items-center gap-1.5 cursor-pointer px-3 py-1.5 text-xs font-semibold rounded-lg bg-white border border-teal-300 hover:border-teal-500 hover:text-teal-600 text-gray-600 transition-colors shadow-sm" title="Upload Lytica report — 90th percentile benchmark">
                        <svg className="h-3.5 w-3.5 text-teal-400" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 19v-6a2 2 0 00-2-2H5a2 2 0 00-2 2v6a2 2 0 002 2h2a2 2 0 002-2zm0 0V9a2 2 0 012-2h2a2 2 0 012 2v10m-6 0a2 2 0 002 2h2a2 2 0 002-2m0 0V5a2 2 0 012-2h2a2 2 0 012 2v14a2 2 0 01-2 2h-2a2 2 0 01-2-2z" /></svg>
                        Lytica {lyticaFileName ? '(replace)' : ''}
                        <input type="file" accept=".xlsx,.xls" className="hidden" onChange={handleLyticaUpload} />
                      </label>
                      {/* "···" more-actions menu */}
                      <div className="relative">
                        <button
                          onClick={() => setShowAmplMenu(v => !v)}
                          className="flex items-center justify-center w-8 h-8 rounded-lg bg-white border border-gray-300 hover:border-gray-400 hover:bg-gray-50 text-gray-500 hover:text-gray-700 transition-colors shadow-sm text-base font-bold leading-none"
                          title="More actions"
                        >···</button>
                        {showAmplMenu && (
                          <div
                            className="absolute left-0 bottom-9 z-30 w-60 bg-white rounded-xl border border-gray-200 shadow-xl py-1.5"
                            onMouseLeave={() => setShowAmplMenu(false)}
                          >
                            <p className="text-[10px] text-gray-400 px-3 pt-1.5 pb-0.5 uppercase tracking-wider font-semibold">Export</p>
                            <button
                              onClick={() => { downloadAmplLyticaTemplate(); setShowAmplMenu(false) }}
                              disabled={amplDemandMpnList.length === 0}
                              className="flex items-center gap-2 w-full px-3 py-2 text-sm text-gray-700 hover:bg-gray-50 rounded-lg mx-auto disabled:opacity-40 disabled:cursor-not-allowed"
                              style={{ textAlign: 'left' }}
                              title={amplDemandMpnList.length === 0 ? 'Load an AMPL Demand file first' : `Export ${amplDemandMpnList.length} unique MPNs for Lytica`}
                            >
                              <svg className="h-4 w-4 text-indigo-500 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 10v6m0 0l-3-3m3 3l3-3m2 8H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" /></svg>
                              <span className="leading-tight">
                                Download Lytica Template
                                <span className="block text-[10px] text-gray-400 font-normal">AMPL MPN List{amplDemandMpnList.length > 0 ? ` (${amplDemandMpnList.length} MPNs)` : ''}</span>
                              </span>
                            </button>
                          </div>
                        )}
                      </div>
                      {/* Nexar toggle */}
                      {NEXAR_ENABLED && (
                        <div className="ml-auto flex items-center gap-2">
                          <label className={`flex items-center gap-2 cursor-pointer select-none px-3 py-1.5 rounded-lg border text-xs font-semibold transition-colors ${searchNexar ? 'bg-orange-50 border-orange-300 text-orange-700' : 'bg-white border-gray-200 text-gray-500 hover:border-orange-300'}`}>
                            <input
                              type="checkbox"
                              checked={searchNexar}
                              onChange={e => setSearchNexar(e.target.checked)}
                              className="w-3.5 h-3.5 accent-orange-500 cursor-pointer"
                            />
                            Include <span className="font-bold text-orange-500">Nexar</span> market data
                          </label>
                        </div>
                      )}
                    </div>

                    {/* Row 2 – Actions (only when file loaded) */}
                    {amplDemandRows.length > 0 && (
                      <div className="px-5 py-3 flex items-center gap-3 flex-wrap">
                        <span className="text-[10px] font-semibold text-gray-400 uppercase tracking-wide w-16 shrink-0">Actions</span>

                        {/* Step 1 */}
                        <div className="flex items-center gap-1.5">
                          <span className="w-5 h-5 rounded-full bg-blue-100 text-blue-600 text-[10px] font-bold flex items-center justify-center shrink-0">1</span>
                          <button
                            onClick={handleAmplDemandSearch}
                            disabled={amplDemandLoading}
                            className={`flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold rounded-lg transition-colors shadow-sm ${amplDemandLoading ? 'bg-gray-100 text-gray-400 cursor-not-allowed' : 'bg-blue-600 hover:bg-blue-700 text-white'}`}
                          >
                            {amplDemandLoading
                              ? <><svg className="animate-spin h-3 w-3" fill="none" viewBox="0 0 24 24"><circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"/><path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8H4z"/></svg>Searching…</>
                              : <><svg className="h-3.5 w-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z"/></svg>Search SAP{searchNexar ? ' + Nexar' : ''}</>
                            }
                          </button>
                        </div>

                        {/* Step 2 – only after results */}
                        {amplDemandRawResults.length > 0 && !amplDemandLoading && (
                          <div className="flex items-center gap-1.5">
                            <span className="w-5 h-5 rounded-full bg-purple-100 text-purple-600 text-[10px] font-bold flex items-center justify-center shrink-0">2</span>
                            <button
                              onClick={handleAmplDemandDeep}
                              disabled={amplDemandDeepLoading}
                              className={`flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold rounded-lg transition-colors shadow-sm ${amplDemandDeepLoading ? 'bg-gray-100 text-gray-400 cursor-not-allowed' : 'bg-purple-600 hover:bg-purple-700 text-white'}`}
                            >
                              {amplDemandDeepLoading
                                ? <><svg className="animate-spin h-3 w-3" fill="none" viewBox="0 0 24 24"><circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"/><path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8H4z"/></svg>Analyzing…</>
                                : <><svg className="h-3.5 w-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 3H5a2 2 0 00-2 2v4m6-6h10a2 2 0 012 2v4M9 3v18m0 0h10a2 2 0 002-2V9M9 21H5a2 2 0 01-2-2V9m0 0h18"/></svg>Deep Analysis</>
                              }
                            </button>
                            {/* Retry Failed button — only shown when there are retryable errors */}
                            {(() => {
                              const retryCount = amplDemandDeepRows.filter(r => r.status === 'error' && r.error !== 'Cancelled' && r.error !== 'No MPNs in SAP').length
                              return retryCount > 0 && !amplDemandDeepLoading ? (
                                <button
                                  onClick={handleAmplDemandDeepRetry}
                                  className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold rounded-lg transition-colors shadow-sm bg-amber-50 hover:bg-amber-100 text-amber-700 border border-amber-300"
                                  title={`Retry ${retryCount} failed Internal PN${retryCount > 1 ? 's' : ''} (connection errors)`}
                                >
                                  <svg className="h-3.5 w-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15"/></svg>
                                  Retry Failed ({retryCount})
                                </button>
                              ) : null
                            })()}
                          </div>
                        )}

                        {/* Export – only after results */}
                        {(amplDemandRawResults.length > 0 || amplDemandDeepRows.length > 0) && (
                          <button
                            onClick={() => downloadAmplResultsExcel(
                              amplDemandHeaders, amplDemandRows, amplDemandMpnColIdx,
                              amplDemandRawResults, amplDemandDeepRows,
                              amplDemandNexarMap, lyticaMap, windowDays,
                              `AMPL_PPV_${new Date().toISOString().slice(0, 10)}.xlsx`,
                            )}
                            className="ml-auto flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold text-emerald-700 bg-emerald-50 hover:bg-emerald-100 border border-emerald-200 rounded-lg transition-colors shadow-sm whitespace-nowrap"
                            title="Export enriched AMPL report to Excel"
                          >
                            <svg className="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="2"><path strokeLinecap="round" strokeLinejoin="round" d="M12 10v6m0 0l-3-3m3 3l3-3m2 4H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z"/></svg>
                            Export AMPL
                          </button>
                        )}

                        {/* Summary stats inline */}
                        {(() => {
                          const seen = new Set<string>()
                          for (const r of amplDemandRows) { const m = String(r[amplDemandMpnColIdx] ?? '').trim().toUpperCase(); if (m) seen.add(m) }
                          return (
                            <div className="flex items-center gap-2 flex-wrap ml-3 pl-3 border-l border-gray-200">
                              <span className="text-[11px] text-gray-500">{amplDemandRows.length} rows</span>
                              <span className="text-[11px] text-indigo-500 font-medium">{seen.size} unique MPNs</span>
                              {amplDemandRawResults.length > 0 && <span className="text-[11px] text-green-600 font-medium">{[...new Set(amplDemandRawResults.map(r => r.mpn))].length} found in SAP</span>}
                            </div>
                          )
                        })()}
                      </div>
                    )}
                  </div>

                  {/* Sub-tab selector */}
                  {(amplDemandRawResults.length > 0 || amplDemandDeepRows.length > 0) && (
                    <div className="flex gap-1 bg-gray-100 rounded-lg p-0.5 w-fit">
                      <button onClick={() => setAmplDemandSubTab('results')} className={`px-3 py-1 text-xs font-medium rounded-md transition-colors ${amplDemandSubTab === 'results' ? 'bg-white text-blue-600 shadow-sm' : 'text-gray-500 hover:text-gray-700'}`}>SAP Results</button>
                      <button onClick={() => setAmplDemandSubTab('deep')} className={`px-3 py-1 text-xs font-medium rounded-md transition-colors ${amplDemandSubTab === 'deep' ? 'bg-white text-purple-600 shadow-sm' : 'text-gray-500 hover:text-gray-700'}`}>
                        Deep Analysis
                        {amplDemandDeepRows.length > 0 && <span className="ml-1.5 text-[10px] bg-purple-100 text-purple-700 rounded px-1">{amplDemandDeepRows.filter(r => r.status === 'done').length}/{amplDemandDeepRows.length}</span>}
                      </button>
                    </div>
                  )}

                  {/* SAP Results sub-tab */}
                  {amplDemandSubTab === 'results' && amplDemandSearchedList.length > 0 && (() => {
                    const list = amplDemandSearchedList
                    const rows = list.map(m => {
                      const key = m.toUpperCase()
                      return { mpn: m, entry: amplDemandDbBestMap[key], status: amplDemandStatusMap[key] ?? 'done' }
                    })
                    const cachedCount  = rows.filter(r => r.entry && r.status === 'done').length
                    const pendingCount = rows.filter(r => r.status === 'pending').length
                    const errorCount   = rows.filter(r => r.status === 'error').length
                    if (!cachedCount && !pendingCount && !errorCount) return null
                    return (
                      <div className="mb-3 rounded-xl border border-indigo-200 bg-indigo-50/40 overflow-hidden">
                        <div className="flex items-center gap-2 px-3 py-2 border-b border-indigo-100">
                          <svg className="h-3.5 w-3.5 text-indigo-500" fill="currentColor" viewBox="0 0 20 20"><path d="M11 3a1 1 0 10-2 0v1.586l-2.293-2.293a1 1 0 10-1.414 1.414L7.586 7H6a1 1 0 000 2h5a1 1 0 001-1V3z"/><path d="M3 9a1 1 0 011-1h2.586L4.293 5.707a1 1 0 010-1.414L9 9v8a1 1 0 11-2 0v-4.586l-3.293 3.293a1 1 0 01-1.414-1.414L4.586 11H4a1 1 0 01-1-1V9z"/></svg>
                          <span className="text-xs font-bold text-indigo-700">Instant best price (DB cache · SAP only)</span>
                          <span className="text-[10px] text-indigo-400">{cachedCount} cached</span>
                          {pendingCount > 0 && <span className="text-[10px] text-amber-500">· {pendingCount} computing</span>}
                          {errorCount > 0 && <span className="text-[10px] text-red-400">· {errorCount} failed</span>}
                        </div>
                        <div className="overflow-x-auto">
                          <table className="min-w-max w-full text-xs">
                            <thead className="text-[10px] uppercase tracking-wide text-indigo-400">
                              <tr>
                                <th className="px-3 py-1.5 text-left">MPN</th>
                                <th className="px-3 py-1.5 text-left">Source</th>
                                <th className="px-3 py-1.5 text-right">Best Price (USD)</th>
                                <th className="px-3 py-1.5 text-left">Supplier</th>
                                <th className="px-3 py-1.5 text-left">Plant</th>
                                <th className="px-3 py-1.5 text-left">Last PO</th>
                              </tr>
                            </thead>
                            <tbody>
                              {rows.map(({ mpn, entry, status }) => {
                                if (status === 'pending') return (
                                  <tr key={mpn} className="border-t border-indigo-100/70 bg-amber-50/40">
                                    <td className="px-3 py-1.5 font-mono text-gray-700">{mpn}</td>
                                    <td className="px-3 py-1.5" colSpan={5}>
                                      <span className="inline-flex items-center gap-1.5 text-[11px] text-amber-600 font-medium">
                                        <svg className="animate-spin h-3 w-3" fill="none" viewBox="0 0 24 24">
                                          <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                                          <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8H4z" />
                                        </svg>
                                        Not cached — querying SAP…
                                      </span>
                                    </td>
                                  </tr>
                                )
                                if (!entry || entry.bestPriceUsd == null) return (
                                  <tr key={mpn} className="border-t border-indigo-100/70">
                                    <td className="px-3 py-1.5 font-mono text-gray-700">{mpn}</td>
                                    <td className="px-3 py-1.5 text-[11px] text-gray-400" colSpan={5}>
                                      {status === 'error' ? 'Connection error — not cached' : 'No SAP price found'}
                                    </td>
                                  </tr>
                                )
                                return (
                                  <tr key={mpn} className="border-t border-indigo-100/70">
                                    <td className="px-3 py-1.5 font-mono text-gray-700">{entry.mpn}</td>
                                    <td className="px-3 py-1.5">
                                      <span className={`px-1.5 py-0.5 rounded text-[10px] font-semibold ${entry.bestSource === 'Internal' ? 'bg-purple-100 text-purple-700' : 'bg-blue-100 text-blue-700'}`}>
                                        {entry.bestSource === 'Internal' ? 'Internal PN' : 'MPN'}
                                      </span>
                                      {entry.origin === 'realtime' && <span className="ml-1 text-[9px] text-gray-400">live</span>}
                                    </td>
                                    <td className="px-3 py-1.5 text-right font-mono font-bold text-indigo-700">{fmt6(entry.bestPriceUsd)}</td>
                                    <td className="px-3 py-1.5 text-gray-600 max-w-[160px] truncate" title={entry.bestSupplier ?? ''}>{entry.bestSupplier || '—'}</td>
                                    <td className="px-3 py-1.5 text-gray-500">{entry.bestPlant || '—'}</td>
                                    <td className="px-3 py-1.5 text-gray-500">{entry.lastPoDate || '—'}</td>
                                  </tr>
                                )
                              })}
                            </tbody>
                          </table>
                        </div>
                      </div>
                    )
                  })()}

                  {amplDemandSubTab === 'results' && (amplDemandRawResults.length > 0 || (amplDemandSearchedList.length > 0 && (Object.keys(amplDemandNexarMap).length > 0 || Object.keys(lyticaMap).length > 0))) && (() => {
                    const mpnGroupsMap = new Map<string, IQItem[]>()
                    for (const r of amplDemandRawResults) {
                      if (!mpnGroupsMap.has(r.mpn)) mpnGroupsMap.set(r.mpn, [])
                      mpnGroupsMap.get(r.mpn)!.push(r)
                    }
                    const entries = [...mpnGroupsMap.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([mpn, rows]) => {
                      const valid = rows.filter(r => r.lastPoDate && !isNaN(new Date(r.lastPoDate).getTime()))
                      if (!valid.length) return null
                      const maxT = Math.max(...valid.map(r => new Date(r.lastPoDate).getTime()))
                      const inWindow = valid.filter(r => new Date(r.lastPoDate).getTime() >= new Date(maxT - windowDays * 86400000).getTime())
                      const best = inWindow.reduce<IQItem>((min, r) => { const p = resolveLastPoPrice(r), mp = resolveLastPoPrice(min); return p == null ? min : mp == null ? r : p < mp ? r : min }, inWindow[0])
                      return { mpn, bestRow: best }
                    }).filter((x): x is { mpn: string; bestRow: IQItem } => x !== null)
                    const foundMpnSet = new Set(entries.map(e => e.mpn))

                    return (
                      <div className="overflow-x-auto rounded-xl border border-gray-200 shadow-sm">
                        <table className="min-w-max w-full text-xs border-collapse">
                          <thead className="bg-gray-50 text-[10px] uppercase tracking-wide text-gray-500 sticky top-0 z-[1]">
                            <tr>
                              <th className="px-3 py-2.5 text-left whitespace-nowrap border-b border-gray-200">MPN</th>
                              <th className="px-3 py-2.5 text-left whitespace-nowrap border-b border-gray-200">Internal PN</th>
                              <th className="px-3 py-2.5 text-left whitespace-nowrap border-b border-gray-200">Plant</th>
                              <th className="px-3 py-2.5 text-left whitespace-nowrap border-b border-gray-200">Supplier</th>
                              <th className="px-3 py-2.5 text-right whitespace-nowrap border-b border-gray-200">Last PO (USD)</th>
                              <th className="px-3 py-2.5 text-right whitespace-nowrap border-b border-gray-200">STD (USD)</th>
                              <th className="px-3 py-2.5 text-left whitespace-nowrap border-b border-gray-200">Date</th>
                              {Object.keys(amplDemandNexarMap).length > 0 && <>
                                <th className="px-3 py-2.5 text-right whitespace-nowrap border-b border-orange-200 bg-orange-50 text-orange-600">Nexar Price</th>
                                <th className="px-3 py-2.5 text-left whitespace-nowrap border-b border-orange-200 bg-orange-50 text-orange-600">Nexar Seller</th>
                              </>}
                              {Object.keys(lyticaMap).length > 0 && <>
                                <th className="px-3 py-2.5 text-right whitespace-nowrap border-b border-teal-200 bg-teal-50 text-teal-600">Lytica 90th</th>
                              </>}
                              <th className="px-3 py-2.5 text-center whitespace-nowrap border-b border-gray-200">Best Source</th>
                              <th className="px-3 py-2.5 text-right whitespace-nowrap border-b border-gray-200">Best Price</th>
                            </tr>
                          </thead>
                          <tbody className="divide-y divide-gray-100">
                            {entries.map(({ mpn, bestRow }, idx) => {
                              const sapP = resolveLastPoPrice(bestRow)
                              const nexE = amplDemandNexarMap[mpn.toUpperCase()] ?? amplDemandNexarMap[mpn] ?? null
                              const lytE = lyticaMap[mpn.toUpperCase()] ?? lyticaMap[mpn] ?? null
                              const cands2: Array<['sap'|'nexar'|'lytica', number]> = []
                              if (sapP != null) cands2.push(['sap', sapP])
                              if (nexE?.nexarBestUsd != null) cands2.push(['nexar', nexE.nexarBestUsd])
                              if (lytE?.price90th != null) cands2.push(['lytica', lytE.price90th])
                              const minP2 = cands2.length > 0 ? Math.min(...cands2.map(([,p]) => p)) : null
                              const winS2 = cands2.length > 0 ? (cands2.filter(([,p]) => p === minP2).length === 1 ? cands2.find(([,p]) => p === minP2)![0] : 'tie') : null
                              return (
                                <tr key={mpn} className={`hover:bg-gray-50 ${idx % 2 === 0 ? 'bg-white' : 'bg-gray-50/40'}`}>
                                  <td className="px-3 py-2 font-mono font-semibold text-blue-700 whitespace-nowrap">{mpn}</td>
                                  <td className="px-3 py-2 font-mono text-gray-600 whitespace-nowrap">{bestRow.internalPN || '—'}</td>
                                  <td className="px-3 py-2 text-gray-500 whitespace-nowrap">{bestRow.siteName || '—'}</td>
                                  <td className="px-3 py-2 text-gray-600 max-w-[150px] truncate" title={bestRow.supplierName || ''}>{bestRow.supplierName || bestRow.englishName || '—'}</td>
                                  <td className="px-3 py-2 text-right font-mono text-gray-700 whitespace-nowrap">{sapP != null ? sapP.toFixed(6) : '—'}</td>
                                  <td className="px-3 py-2 text-right font-mono text-gray-500 whitespace-nowrap">{bestRow.standardPriceUsd != null ? bestRow.standardPriceUsd.toFixed(6) : '—'}</td>
                                  <td className="px-3 py-2 text-gray-400 whitespace-nowrap">{bestRow.lastPoDate || '—'}</td>
                                  {Object.keys(amplDemandNexarMap).length > 0 && <>
                                    <td className={`px-3 py-2 text-right font-mono whitespace-nowrap bg-orange-50/30 ${winS2 === 'nexar' ? 'font-bold text-emerald-700' : 'text-orange-700'}`}>{nexE?.nexarBestUsd != null ? nexE.nexarBestUsd.toFixed(6) : '—'}</td>
                                    <td className="px-3 py-2 text-gray-600 whitespace-nowrap bg-orange-50/30">{nexE?.nexarSeller || '—'}</td>
                                  </>}
                                  {Object.keys(lyticaMap).length > 0 && <>
                                    <td className={`px-3 py-2 text-right font-mono whitespace-nowrap bg-teal-50/30 ${winS2 === 'lytica' ? 'font-bold text-emerald-700' : 'text-teal-700'}`}>{lytE?.price90th != null ? lytE.price90th.toFixed(6) : '—'}</td>
                                  </>}
                                  <td className="px-3 py-2 text-center whitespace-nowrap">
                                    {winS2 === 'sap' ? <span className="px-2 py-0.5 text-[10px] font-bold rounded-full bg-emerald-100 text-emerald-700">SAP</span>
                                    : winS2 === 'nexar' ? <span className="px-2 py-0.5 text-[10px] font-bold rounded-full bg-orange-100 text-orange-700">Nexar</span>
                                    : winS2 === 'lytica' ? <span className="px-2 py-0.5 text-[10px] font-bold rounded-full bg-teal-100 text-teal-700">Lytica</span>
                                    : winS2 === 'tie' ? <span className="px-2 py-0.5 text-[10px] font-bold rounded-full bg-gray-100 text-gray-500">Tie</span>
                                    : <span className="text-[10px] text-gray-300">—</span>}
                                  </td>
                                  <td className={`px-3 py-2 text-right font-mono font-bold whitespace-nowrap ${winS2 ? 'text-indigo-700' : 'text-gray-300'}`}>{minP2 != null ? minP2.toFixed(6) : '—'}</td>
                                </tr>
                              )
                            })}
                            {/* Missing MPNs — not found in SAP but have Nexar/Lytica data */}
                            {amplDemandSearchedList.filter(m => !foundMpnSet.has(m)).map(m => {
                              const nexE = amplDemandNexarMap[m.toUpperCase()] ?? amplDemandNexarMap[m] ?? null
                              const lytE = lyticaMap[m.toUpperCase()] ?? lyticaMap[m] ?? null
                              const hasAlt = (nexE?.nexarBestUsd != null) || (lytE?.price90th != null)
                              if (!hasAlt) return null
                              const cands: Array<['nexar' | 'lytica', number]> = []
                              if (nexE?.nexarBestUsd != null) cands.push(['nexar', nexE.nexarBestUsd])
                              if (lytE?.price90th != null) cands.push(['lytica', lytE.price90th])
                              const minP = cands.length > 0 ? Math.min(...cands.map(([, p]) => p)) : null
                              const winS = cands.length > 0 ? (cands.filter(([, p]) => p === minP).length === 1 ? cands.find(([, p]) => p === minP)![0] : 'tie') : null
                              return (
                                <tr key={`missing-${m}`} className="bg-orange-50/30 hover:bg-orange-50/60">
                                  <td className="px-3 py-2 whitespace-nowrap">
                                    <span className="font-mono font-semibold text-orange-700">{m}</span>
                                    {nexE?.nexarBestUsd != null && lytE?.price90th != null
                                      ? <span className="ml-1.5 text-[9px] font-semibold bg-purple-100 text-purple-600 px-1.5 py-0.5 rounded uppercase tracking-wide">Nexar/Lytica</span>
                                      : nexE?.nexarBestUsd != null
                                        ? <span className="ml-1.5 text-[9px] font-semibold bg-orange-100 text-orange-500 px-1.5 py-0.5 rounded uppercase tracking-wide">Nexar</span>
                                        : <span className="ml-1.5 text-[9px] font-semibold bg-teal-100 text-teal-600 px-1.5 py-0.5 rounded uppercase tracking-wide">Lytica</span>
                                    }
                                  </td>
                                  <td className="px-3 py-2 text-gray-300">—</td>
                                  <td className="px-3 py-2 text-gray-300">—</td>
                                  <td className="px-3 py-2 text-gray-300">—</td>
                                  <td className="px-3 py-2 text-right text-gray-300">—</td>
                                  <td className="px-3 py-2 text-right text-gray-300">—</td>
                                  <td className="px-3 py-2 text-gray-300">—</td>
                                  {Object.keys(amplDemandNexarMap).length > 0 && <>
                                    <td className="px-3 py-2 text-right font-mono text-orange-700 whitespace-nowrap bg-orange-50/30">{nexE?.nexarBestUsd != null ? nexE.nexarBestUsd.toFixed(6) : '—'}</td>
                                    <td className="px-3 py-2 text-gray-600 whitespace-nowrap bg-orange-50/30">{nexE?.nexarSeller || '—'}</td>
                                  </>}
                                  {Object.keys(lyticaMap).length > 0 && <>
                                    <td className="px-3 py-2 text-right font-mono text-teal-700 whitespace-nowrap bg-teal-50/30">{lytE?.price90th != null ? lytE.price90th.toFixed(6) : '—'}</td>
                                  </>}
                                  <td className="px-3 py-2 text-center whitespace-nowrap">
                                    {winS === 'nexar' ? <span className="px-2 py-0.5 text-[10px] font-bold rounded-full bg-orange-100 text-orange-700">Nexar</span>
                                    : winS === 'lytica' ? <span className="px-2 py-0.5 text-[10px] font-bold rounded-full bg-teal-100 text-teal-700">Lytica</span>
                                    : winS === 'tie' ? <span className="px-2 py-0.5 text-[10px] font-bold rounded-full bg-gray-100 text-gray-500">Tie</span>
                                    : <span className="text-[10px] text-gray-300">—</span>}
                                  </td>
                                  <td className="px-3 py-2 text-right font-mono font-bold whitespace-nowrap text-indigo-700">{minP != null ? minP.toFixed(6) : '—'}</td>
                                </tr>
                              )
                            })}
                          </tbody>
                        </table>
                      </div>
                    )
                  })()}

                  {/* Deep Analysis sub-tab */}
                  {amplDemandSubTab === 'deep' && (
                    <div>
                      {amplDemandDeepRows.length === 0 ? (
                        <p className="text-sm text-gray-400 py-8 text-center">Click "Deep Analysis" to search by Internal Part Number for Multi-Component price comparison.</p>
                      ) : (
                        <div>
                          <p className="text-[10px] text-gray-400 mb-3">Comparison of AMPL MPN ({windowDays}-day window best) vs Multi-Component (AMPL active MPNs best) prices per Internal PN</p>
                          <div className="overflow-x-auto rounded-xl border border-gray-200 shadow-sm">
                          <table className="min-w-max w-full text-xs border-collapse">
                            <thead className="bg-gray-50 text-[10px] uppercase tracking-wide text-gray-500">
                              <tr>
                                <th className="px-3 py-2.5 text-left border-b border-gray-200 whitespace-nowrap" rowSpan={2}>Internal PN</th>
                                <th className="px-3 py-2.5 text-center border-b border-gray-200 border-l border-l-blue-200 whitespace-nowrap bg-blue-50/50" colSpan={6}>AMPL MPN</th>
                                <th className="px-3 py-2.5 text-center border-b border-gray-200 border-l border-l-purple-200 whitespace-nowrap bg-purple-50/50" colSpan={7}>Multi-Component</th>
                                {NEXAR_ENABLED && <th className="px-3 py-2.5 text-center border-b border-gray-200 border-l border-l-orange-200 whitespace-nowrap bg-orange-50/50" colSpan={6}>Nexar Market</th>}
                                {Object.keys(lyticaMap).length > 0 && <th className="px-3 py-2.5 text-center border-b border-gray-200 border-l border-l-teal-200 whitespace-nowrap bg-teal-50/50" colSpan={4}>Lytica</th>}
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
                                {NEXAR_ENABLED && <>
                                <th className="px-3 py-2 text-left border-b border-gray-200 border-l border-l-orange-200 whitespace-nowrap bg-orange-50/30">MPN</th>
                                <th className="px-3 py-2 text-left border-b border-gray-200 whitespace-nowrap bg-orange-50/30">Manufacturer</th>
                                <th className="px-3 py-2 text-left border-b border-gray-200 whitespace-nowrap bg-orange-50/30">Supplier</th>
                                <th className="px-3 py-2 text-right border-b border-gray-200 whitespace-nowrap bg-orange-50/30">Unit Price (USD)</th>
                                <th className="px-3 py-2 text-right border-b border-gray-200 whitespace-nowrap bg-orange-50/30">Stock</th>
                                <th className="px-3 py-2 text-right border-b border-gray-200 whitespace-nowrap bg-orange-50/30">MOQ</th>
                                </>}
                                {Object.keys(lyticaMap).length > 0 && <th className="px-3 py-2 text-left border-b border-gray-200 border-l border-l-teal-200 whitespace-nowrap bg-teal-50/30">MPN Searched</th>}
                                {Object.keys(lyticaMap).length > 0 && <th className="px-3 py-2 text-left border-b border-gray-200 whitespace-nowrap bg-teal-50/30">MPN Matched</th>}
                                {Object.keys(lyticaMap).length > 0 && <th className="px-3 py-2 text-left border-b border-gray-200 whitespace-nowrap bg-teal-50/30">Manufacturer</th>}
                                {Object.keys(lyticaMap).length > 0 && <th className="px-3 py-2 text-right border-b border-gray-200 whitespace-nowrap bg-teal-50/30">90th %tile</th>}
                              </tr>
                            </thead>
                            <tbody className="divide-y divide-gray-100">
                              {amplDemandDeepRows.map((dr) => {
                                // AMPL MPN side: find best SAP row for this internalPN
                                const amplCandidates = amplDemandRawResults.filter(r => r.internalPN === dr.internalPN)
                                const amplBestEntry = amplCandidates.reduce<IQItem | null>((best, r) => {
                                  const p = resolveLastPoPrice(r), bp = best ? resolveLastPoPrice(best) : null
                                  if (p == null) return best; if (bp == null) return r; return p < bp ? r : best
                                }, null)
                                const amplMpnPrice = amplBestEntry ? resolveLastPoPrice(amplBestEntry) : null
                                const mcPrice = dr.mcBestPriceUsd
                                // Lytica: find best match for MPNs in this internalPN group
                                const hasLytica = Object.keys(lyticaMap).length > 0
                                let lyticaBest: { mpnSearched: string; mpnMatched: string; manufacturerMatched: string; price90th: number | null } | null = null
                                if (hasLytica) {
                                  for (const r of amplCandidates) {
                                    const entry = lyticaMap[r.mpn.toUpperCase()]
                                    if (entry && (lyticaBest == null || (entry.price90th != null && (lyticaBest.price90th == null || entry.price90th < lyticaBest.price90th))))
                                      lyticaBest = { mpnSearched: r.mpn, ...entry }
                                  }
                                }
                                const lyticaPrice = lyticaBest?.price90th ?? null
                                // Nexar: find best from amplDemandNexarMap for MPNs in this internalPN group
                                let nexarBest: (typeof amplDemandNexarMap)[string] | null = null
                                for (const r of amplCandidates) {
                                  const nx = amplDemandNexarMap[r.mpn.toUpperCase()] ?? amplDemandNexarMap[r.mpn]
                                  if (nx && (nexarBest == null || (nx.nexarBestUsd != null && (nexarBest.nexarBestUsd == null || nx.nexarBestUsd < nexarBest.nexarBestUsd))))
                                    nexarBest = nx
                                }
                                const nexarPrice = nexarBest?.nexarBestUsd ?? null
                                // Winner
                                type WinnerType = 'mpn' | 'mc' | 'nexar' | 'lytica' | 'tie' | null
                                let winner: WinnerType = null
                                const prices: Array<[WinnerType, number]> = []
                                if (amplMpnPrice != null) prices.push(['mpn', amplMpnPrice])
                                if (mcPrice != null) prices.push(['mc', mcPrice])
                                if (nexarPrice != null) prices.push(['nexar', nexarPrice])
                                if (lyticaPrice != null) prices.push(['lytica', lyticaPrice])
                                if (prices.length > 0) {
                                  const minPrice = Math.min(...prices.map(([, p]) => p))
                                  const winners = prices.filter(([, p]) => p === minPrice)
                                  winner = winners.length === 1 ? winners[0][0] : 'tie'
                                }
                                return (
                                <tr key={dr.internalPN} className="hover:bg-gray-50">
                                  <td className="px-3 py-2.5 font-mono font-semibold text-blue-700 whitespace-nowrap">{dr.internalPN}</td>
                                  {/* AMPL MPN side */}
                                  <td className="px-3 py-2.5 font-mono text-gray-600 whitespace-nowrap border-l border-l-blue-100">{amplBestEntry?.mpn || '—'}</td>
                                  <td className="px-3 py-2.5 text-gray-500 whitespace-nowrap">{amplBestEntry?.siteName || '—'}</td>
                                  <td className="px-3 py-2.5 text-gray-600 max-w-[150px] truncate" title={amplBestEntry?.supplierName || ''}>{amplBestEntry ? (amplBestEntry.supplierName || amplBestEntry.englishName || '—') : '—'}</td>
                                  <td className={`px-3 py-2.5 text-right font-mono font-semibold whitespace-nowrap ${winner === 'mpn' ? 'text-emerald-700 text-sm' : 'text-gray-700'}`}>{fmt6(amplMpnPrice)}</td>
                                  <td className="px-3 py-2.5 text-right font-mono text-gray-500 whitespace-nowrap">{fmt6(amplBestEntry?.standardPriceUsd ?? null)}</td>
                                  <td className="px-3 py-2.5 text-gray-500 whitespace-nowrap">{amplBestEntry?.lastPoDate || '—'}</td>
                                  {/* Multi-Component side */}
                                  {dr.status === 'loading' ? (
                                    <td colSpan={7} className="px-3 py-2.5 text-center border-l border-l-purple-100">
                                      <div className="flex items-center justify-center gap-1.5 text-gray-400">
                                        <svg className="animate-spin h-3 w-3" fill="none" viewBox="0 0 24 24"><circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"/><path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8H4z"/></svg>
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
                                  {NEXAR_ENABLED && (nexarBest == null ? (
                                    <td colSpan={6} className="px-3 py-2.5 text-center text-gray-300 text-[10px] border-l border-l-orange-100 bg-orange-50/10">
                                      {Object.keys(amplDemandNexarMap).length === 0 ? 'Enable Nexar search' : '—'}
                                    </td>
                                  ) : (
                                    <>
                                      <td className="px-3 py-2.5 font-mono text-orange-700 whitespace-nowrap border-l border-l-orange-100 bg-orange-50/10">{nexarBest.nexarMpn || '—'}</td>
                                      <td className="px-3 py-2.5 text-gray-600 max-w-[130px] truncate bg-orange-50/10" title={nexarBest.nexarManufacturer}>{nexarBest.nexarManufacturer || '—'}</td>
                                      <td className="px-3 py-2.5 text-gray-600 max-w-[130px] truncate bg-orange-50/10" title={nexarBest.nexarSeller}>{nexarBest.nexarSeller || '—'}</td>
                                      <td className={`px-3 py-2.5 text-right font-mono font-semibold whitespace-nowrap bg-orange-50/10 ${winner === 'nexar' ? 'text-emerald-700 text-sm' : 'text-orange-700'}`}>{fmt6(nexarBest.nexarBestUsd)}</td>
                                      <td className="px-3 py-2.5 text-right font-mono text-gray-500 whitespace-nowrap bg-orange-50/10">{nexarBest.nexarStock != null ? nexarBest.nexarStock.toLocaleString() : '—'}</td>
                                      <td className="px-3 py-2.5 text-right font-mono text-gray-500 whitespace-nowrap bg-orange-50/10">{nexarBest.nexarMoq != null ? nexarBest.nexarMoq.toLocaleString() : '—'}</td>
                                    </>
                                  ))}
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
                                  {/* Winner */}
                                  <td className="px-3 py-2.5 text-center border-l border-l-gray-200">
                                    {dr.status === 'loading' ? null
                                      : winner === 'mpn'    ? <span className="px-2 py-0.5 text-[10px] font-bold rounded-full bg-emerald-100 text-emerald-700">AMPL MPN</span>
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
                </div>
              )}
            </div>
          </div>
        </div>
      )}

      {/* •••••••••••••• FULL QUOTE DATA TAB •••••••••••••• */}
      {activeTab === 'fullquote' && (
        <div className="flex flex-col h-full overflow-hidden">
          {(() => {
            // Extract rows from active database or flatten all results
            let rows: Array<Record<string, string | number | null>> = []
            let hasValidData = false
            
            if (fullQuoteData && fullQuoteData.results) {
              if (fullQuoteData.active_db && Array.isArray(fullQuoteData.results[fullQuoteData.active_db])) {
                // Single active database
                rows = fullQuoteData.results[fullQuoteData.active_db]
                hasValidData = rows.length > 0
              } else if (!Array.isArray(fullQuoteData.results)) {
                // Object with multiple databases — flatten all
                try {
                  const allRows = Object.values(fullQuoteData.results)
                    .filter((v): v is Array<Record<string, string | number | null>> => Array.isArray(v))
                    .flat()
                  if (allRows.length > 0) {
                    rows = allRows
                    hasValidData = true
                  }
                } catch {
                  // If flattening fails, keep hasValidData = false
                }
              }
            }

            // Calculate best price from all rows
            let calculatedBestPrice: number | null = null
            if (hasValidData && rows.length > 0) {
              const lastPoPriceCol = fullQuoteData?.last_po_price_col
              if (lastPoPriceCol) {
                const prices: number[] = []
                for (const row of rows) {
                  const price = Number(row[lastPoPriceCol] ?? 0)
                  if (!Number.isNaN(price) && price > 0) {
                    prices.push(price)
                  }
                }
                if (prices.length > 0) {
                  calculatedBestPrice = Math.min(...prices)
                }
              }
            }

            return (
              <FullQuoteDataTab
                data={hasValidData && fullQuoteData ? { columns: fullQuoteData.columns, rows } : null}
                loading={fullQuoteLoading}
                lastPoPriceCol={fullQuoteData?.last_po_price_col ?? ''}
                poQtyCol={fullQuoteData?.po_qty_col ?? ''}
                currencyCol=""
                dateCol=""
                bestPrice={calculatedBestPrice}
              />
            )
          })()}
        </div>
      )}

      {/* ── Supplier savings comparison panel (per-MPN, per-plant) ── */}
      {mpnCompare && (
        <SupplierComparePanel
          mpn={mpnCompare.mpn}
          records={mpnCompare.allRows.map<CompareRecord>(r => ({
            plant: r.siteName || '',
            supplier: r.supplierName || r.englishName || '',
            lastPoUsd: resolveLastPoPrice(r),
            stdUsd: r.standardPriceUsd ?? null,
            quantity: r.quantity ?? null,
            lastPoDate: r.lastPoDate || '',
            internalPN: r.internalPN || '',
            localCurrency: r.localCurrency || '',
            lastPoLocal: resolvePoLocal(r),
          }))}
          demand={mpnCompareDemand}
          demandLoading={mpnCompareDemandLoading}
          onClose={() => setMpnCompare(null)}
        />
      )}
    </>
  )
}
