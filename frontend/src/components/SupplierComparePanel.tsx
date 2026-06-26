// src/components/SupplierComparePanel.tsx
// Per-MPN supplier comparison & savings panel.
// Opened from the Multi-MPN IQ Results grid. For a single MPN it groups the raw
// purchase records by plant, lets the user pick a "base" plant and (optionally) a
// "target" plant, and quantifies how much money could be saved if every supplier
// in the comparison aligned to the cheapest Last PO (USD) price found.
import { useMemo, useState } from 'react'
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

/** Per-plant demand for the MPN, pulled from the active dbquery demand DB. */
export interface DemandRow {
  plantCode: string
  plantName: string
  totalEau: number | null
  onhandQty: number | null
  grossDemand: number | null
}

interface SupplierComparePanelProps {
  mpn: string
  records: CompareRecord[]
  /** Per-plant demand rows for this MPN (keyed visually by plant name). */
  demand?: DemandRow[]
  /** True while demand is being fetched. */
  demandLoading?: boolean
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

// ── Component ──────────────────────────────────────────────────────────────

export default function SupplierComparePanel({ mpn, records, demand = [], demandLoading = false, onClose }: SupplierComparePanelProps) {
  const plantGroups = useMemo(() => groupByPlant(records), [records])

  // Map plant name → demand row (Total EAU / Onhand / Gross Demand). The SAP
  // records' plant is a short name (KEMX); the demand DB exposes plantName too.
  const demandByPlant = useMemo(() => {
    const m = new Map<string, DemandRow>()
    for (const d of demand) {
      if (d.plantName) m.set(d.plantName.toUpperCase(), d)
    }
    return m
  }, [demand])

  // Overall MPN demand totals (summed across all plants in the demand file).
  const demandTotals = useMemo(() => {
    let eau = 0, onhand = 0, gross = 0
    let any = false
    for (const d of demand) {
      if (d.totalEau != null) { eau += d.totalEau; any = true }
      if (d.onhandQty != null) { onhand += d.onhandQty; any = true }
      if (d.grossDemand != null) { gross += d.grossDemand; any = true }
    }
    return any ? { eau, onhand, gross } : null
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
    const priced = scopeRows.filter(r => r.lastPoUsd != null && r.lastPoUsd > 0)

    // Latest PO date across priced records → start of the window.
    const ts = (s: string) => { const t = new Date(s).getTime(); return isNaN(t) ? null : t }
    const dated = priced.map(r => ts(r.lastPoDate)).filter((t): t is number => t != null)
    const maxT = dated.length ? Math.max(...dated) : null
    const windowStart = maxT != null ? maxT - windowDays * 86_400_000 : null

    // A record is eligible to set the reference price only if it falls inside
    // the window (or we have no dates at all, in which case all priced count).
    const inWindow = (r: CompareRecord) => {
      if (windowStart == null) return true
      const t = ts(r.lastPoDate)
      return t == null ? false : t >= windowStart
    }
    const eligible = priced.filter(inWindow)
    const pool = eligible.length ? eligible : priced   // fall back if window empties

    const refRow = pool.reduce<CompareRecord | null>((min, r) => {
      if (min == null) return r
      return (r.lastPoUsd ?? Infinity) < (min.lastPoUsd ?? Infinity) ? r : min
    }, null)
    const refPrice = refRow?.lastPoUsd ?? null

    const lines = scopeRows.map(r => {
      const price = r.lastPoUsd
      const isRef = refRow != null && r === refRow
      const within = inWindow(r)
      const deltaUnit = price != null && refPrice != null ? price - refPrice : null
      const qty = r.quantity ?? null
      // Annualized-style saving estimate based on the recorded PO quantity.
      const saveTotal = deltaUnit != null && deltaUnit > 0 && qty != null ? deltaUnit * qty : (deltaUnit != null && deltaUnit > 0 ? null : 0)
      return { r, price, isRef, within, deltaUnit, qty, saveTotal }
    })

    const totalQtySaving = lines.reduce((sum, l) => sum + (l.saveTotal ?? 0), 0)
    const distinctSuppliers = new Set(scopeRows.map(r => r.supplier).filter(Boolean)).size
    const maxPrice = pool.reduce((mx, r) => Math.max(mx, r.lastPoUsd ?? 0), 0)
    const unitSpread = refPrice != null && maxPrice > 0 ? maxPrice - refPrice : null

    return { refRow, refPrice, lines, totalQtySaving, distinctSuppliers, unitSpread, maxPrice, windowStart, maxT }
  }, [baseGroup, targetGroup, windowDays])

  const scopeLabel = targetPlant ? `${basePlant} vs ${targetPlant}` : basePlant

  return (
    <div className="fixed inset-0 z-[120] flex items-center justify-center p-4 bg-black/40 backdrop-blur-sm" onClick={onClose}>
      <div
        className="bg-white rounded-2xl shadow-2xl w-full max-w-4xl max-h-[88vh] flex flex-col overflow-hidden"
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
          <button onClick={onClose} className="p-1 rounded-lg text-gray-400 hover:text-gray-700 hover:bg-white/60 transition-colors">
            <X className="h-4 w-4" />
          </button>
        </div>

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
        <div className="px-5 py-3 grid grid-cols-2 sm:grid-cols-4 gap-3 border-b border-gray-100 bg-gray-50/50">
          <div className="bg-white rounded-xl border border-gray-200 p-3">
            <p className="text-[10px] uppercase tracking-wide text-gray-400">Cheapest price <span className="text-emerald-500">· {windowDays}d window</span></p>
            <p className="text-sm font-bold text-emerald-700 font-mono mt-0.5">{fmtUsd6(analysis.refPrice)}</p>
            <p className="text-[10px] text-gray-400 truncate mt-0.5" title={analysis.refRow?.supplier}>
              {analysis.refRow ? `${analysis.refRow.supplier} · ${analysis.refRow.plant}` : '—'}
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
                <span className="ml-1 text-[10px] text-gray-400">(sum across {demand.length} plant{demand.length !== 1 ? 's' : ''})</span>
              </>
            ) : (
              <span className="text-[11px] text-gray-400 italic">No demand data for this MPN in the active demand database.</span>
            )}
          </div>
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
                  <th className="px-2.5 py-2 text-right whitespace-nowrap border-b border-gray-200">Δ / unit</th>
                  <th className="px-2.5 py-2 text-right whitespace-nowrap border-b border-gray-200">PO Qty</th>
                  <th className="px-2.5 py-2 text-right whitespace-nowrap border-b border-gray-200">Potential Saving</th>
                  <th className="px-2.5 py-2 text-right whitespace-nowrap border-b border-indigo-200 bg-indigo-50/60 text-indigo-600">Total EAU</th>
                  <th className="px-2.5 py-2 text-right whitespace-nowrap border-b border-indigo-200 bg-indigo-50/60 text-indigo-600">Onhand Qty</th>
                  <th className="px-2.5 py-2 text-right whitespace-nowrap border-b border-indigo-200 bg-indigo-50/60 text-indigo-600">Gross Demand</th>
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
                      <td className={`px-2.5 py-2 text-right font-mono font-semibold whitespace-nowrap ${l.isRef ? 'text-emerald-700' : 'text-gray-700'}`}>{fmtUsd6(l.price)}</td>
                      <td className={`px-2.5 py-2 text-right font-mono whitespace-nowrap ${l.deltaUnit != null && l.deltaUnit > 0 ? 'text-red-600' : 'text-gray-400'}`}>
                        {l.deltaUnit != null && l.deltaUnit > 0 ? `+${fmtUsd6(l.deltaUnit)}` : (l.isRef ? '—' : fmtUsd6(l.deltaUnit))}
                      </td>
                      <td className="px-2.5 py-2 text-right font-mono text-gray-600 whitespace-nowrap">{l.qty != null ? l.qty.toLocaleString() : '—'}</td>
                      <td className={`px-2.5 py-2 text-right font-mono font-semibold whitespace-nowrap ${l.saveTotal && l.saveTotal > 0 ? 'text-emerald-700' : 'text-gray-300'}`}>
                        {l.saveTotal && l.saveTotal > 0 ? fmtUsd2(l.saveTotal) : (l.saveTotal == null ? 'n/a (no qty)' : '—')}
                      </td>
                      {(() => {
                        const d = demandByPlant.get((l.r.plant || '').toUpperCase())
                        return (
                          <>
                            <td className="px-2.5 py-2 text-right font-mono text-indigo-700 whitespace-nowrap bg-indigo-50/30">{d?.totalEau != null ? d.totalEau.toLocaleString() : '—'}</td>
                            <td className="px-2.5 py-2 text-right font-mono text-indigo-700 whitespace-nowrap bg-indigo-50/30">{d?.onhandQty != null ? d.onhandQty.toLocaleString() : '—'}</td>
                            <td className="px-2.5 py-2 text-right font-mono text-indigo-700 whitespace-nowrap bg-indigo-50/30">{d?.grossDemand != null ? d.grossDemand.toLocaleString() : '—'}</td>
                          </>
                        )
                      })()}
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
      </div>
    </div>
  )
}

