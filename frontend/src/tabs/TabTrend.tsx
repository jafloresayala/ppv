// src/tabs/TabTrend.tsx
import { useState } from 'react'
import { X } from 'lucide-react'
import TrendChart      from '../components/charts/TrendChart'
import StackedBarChart from '../components/charts/StackedBarChart'
import { usePPV } from '../store/ppvStore'
import { PLANT_FLAGS, PLANT_NAMES, PLANT_COLORS } from '../utils/plants'
import { getTrendDetail } from '../api/client'
import type { TrendDetailRow } from '../types/api.types'

const fmt = (v: number) => `$${v.toLocaleString(undefined, { minimumFractionDigits: 2 })}`

export default function TabTrend() {
  const { analytics, sessionId, selectedGroups, selectedVendors, selectedPlants, selectedDateRange } = usePPV()
  const data               = analytics?.trend
  const [split, setSplit]  = useState(false)

  // Drill-down modal
  const [drillLabel,   setDrillLabel]   = useState<string | null>(null)
  const [drillRows,    setDrillRows]    = useState<TrendDetailRow[]>([])
  const [drillLoading, setDrillLoading] = useState(false)

  async function handleBarClick(label: string) {
    if (!sessionId || !data) return
    setDrillLabel(label)
    setDrillRows([])
    setDrillLoading(true)
    try {
      const filters = {
        material_groups: selectedGroups,
        vendors:         selectedVendors,
        plants:          selectedPlants,
        ...(selectedDateRange ? { date_start: selectedDateRange.start, date_end: selectedDateRange.end } : {}),
      }
      const result = await getTrendDetail(sessionId, filters, label, data.granularity)
      setDrillRows(result.rows)
    } finally {
      setDrillLoading(false)
    }
  }

  if (!data || !data.labels.length)
    return <p className="text-sm text-slate-400 italic">No date/time data available in this dataset.</p>

  const hasPlants = !!data.by_plant && Object.keys(data.by_plant).length > 1
  const showSplit = split && hasPlants

  // Plant ranking (total PPV per plant, sorted by abs value desc)
  const plantRanking = hasPlants
    ? Object.entries(data.by_plant!).map(([p, vals]) => ({
        plant: p,
        total: vals.reduce((s, v) => s + v, 0),
      })).sort((a, b) => Math.abs(b.total) - Math.abs(a.total))
    : []

  const grandTotal = plantRanking.reduce((s, r) => s + r.total, 0)

  return (
    <div className="fade-in flex flex-col gap-5">
      <div className="card-p">
        {/* Header row */}
        <div className="flex items-center justify-between flex-wrap gap-3 mb-3">
          <p className="section-title mb-0">
            Net PPV + Cumulative —{' '}
            <span className="font-normal text-slate-500">
              {data.granularity === 'daily' ? 'Daily' : 'Monthly'} Granularity
            </span>
          </p>

          {hasPlants && (
            <label className="flex items-center gap-2 cursor-pointer select-none text-sm text-slate-600 font-medium">
              <span>Split by Plant</span>
              <button
                role="switch"
                aria-checked={split}
                onClick={() => setSplit(s => !s)}
                className={`relative inline-flex h-5 w-9 shrink-0 rounded-full border-2 border-transparent transition-colors focus:outline-none ${
                  split ? 'bg-brand' : 'bg-slate-300'
                }`}
              >
                <span
                  className={`pointer-events-none inline-block h-4 w-4 transform rounded-full bg-white shadow ring-0 transition-transform ${
                    split ? 'translate-x-4' : 'translate-x-0'
                  }`}
                />
              </button>
            </label>
          )}
        </div>

        {showSplit
          ? <StackedBarChart labels={data.labels} byPlant={data.by_plant!} height={360} />
          : <TrendChart data={data} height={360} onBarClick={handleBarClick} />
        }
      </div>

      {/* ── When split is ON: two independent sections ── */}
      {showSplit && hasPlants && (
        <>
          {/* Section: Plant Ranking */}
          <div className="card-p">
            <p className="section-title">Plant Ranking</p>
            <table className="tbl w-full">
              <thead>
                <tr>
                  <th className="text-center w-6">#</th>
                  <th className="text-left">Plant</th>
                  <th>Total PPV</th>
                  <th>Share</th>
                </tr>
              </thead>
              <tbody>
                {plantRanking.map((r, idx) => {
                  const pct    = grandTotal !== 0 ? Math.abs(r.total / grandTotal * 100).toFixed(1) : '0.0'
                  const barPct = Math.abs(r.total) / (Math.abs(plantRanking[0]?.total) || 1) * 100
                  return (
                    <tr key={r.plant}>
                      <td className="text-slate-400 font-mono text-center">{idx + 1}</td>
                      <td>
                        <span className="flex items-center gap-1.5">
                          <span className="w-2.5 h-2.5 rounded-full shrink-0"
                            style={{ background: PLANT_COLORS[r.plant] ?? '#94a3b8' }} />
                          <span className="whitespace-nowrap">
                            {PLANT_FLAGS[r.plant] ?? '🏭'} {PLANT_NAMES[r.plant] ?? r.plant}
                          </span>
                        </span>
                      </td>
                      <td className={`font-semibold ${r.total > 0 ? 'text-danger' : 'text-success'}`}>
                        {fmt(r.total)}
                      </td>
                      <td className="min-w-[80px]">
                        <div className="flex items-center gap-1.5">
                          <div className="flex-1 h-1.5 bg-slate-100 rounded-full overflow-hidden">
                            <div className="h-full rounded-full"
                              style={{ width: `${barPct}%`, background: PLANT_COLORS[r.plant] ?? '#94a3b8' }} />
                          </div>
                          <span className="text-[11px] text-slate-500 w-9 text-right shrink-0">{pct}%</span>
                        </div>
                      </td>
                    </tr>
                  )
                })}
                <tr className="border-t border-slate-200 font-semibold">
                  <td colSpan={2} className="text-slate-600">Total</td>
                  <td className={grandTotal > 0 ? 'text-danger' : 'text-success'}>{fmt(grandTotal)}</td>
                  <td className="text-slate-400 text-center text-xs">100%</td>
                </tr>
              </tbody>
            </table>
          </div>

          {/* Section: Monthly Breakdown by Plant */}
          <div className="card-p">
            <p className="section-title">
              {data.granularity === 'daily' ? 'Daily' : 'Monthly'} Breakdown by Plant
            </p>
            <div className="overflow-auto max-h-[480px]">
              <table className="tbl">
                <thead className="sticky top-0 z-10 bg-white shadow-[0_1px_0_0_#e2e8f0]">
                  <tr>
                    <th>{data.granularity === 'daily' ? 'Date' : 'Month'}</th>
                    {Object.keys(data.by_plant!).sort().map(p => (
                      <th key={p}>
                        <span className="flex items-center gap-1 justify-center">
                          <span
                            className="w-2 h-2 rounded-full inline-block shrink-0"
                            style={{ background: PLANT_COLORS[p] ?? '#94a3b8' }}
                          />
                          {PLANT_FLAGS[p] ?? '🏭'} {PLANT_NAMES[p] ?? p}
                        </span>
                      </th>
                    ))}
                    <th>Total</th>
                  </tr>
                </thead>
                <tbody>
                  {data.labels.map((lbl, i) => {
                    const plantKeys = Object.keys(data.by_plant!).sort()
                    const total = plantKeys.reduce((s, p) => s + (data.by_plant![p][i] ?? 0), 0)
                    return (
                      <tr key={lbl}>
                        <td className="font-medium whitespace-nowrap">{lbl}</td>
                        {plantKeys.map(p => {
                          const v = data.by_plant![p][i] ?? 0
                          return (
                            <td key={p} className={v > 0 ? 'text-danger' : v < 0 ? 'text-success' : 'text-slate-300'}>
                              {v !== 0 ? fmt(v) : '—'}
                            </td>
                          )
                        })}
                        <td className={`font-semibold ${total > 0 ? 'text-danger' : 'text-success'}`}>
                          {fmt(total)}
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
          </div>

        </>
      )}

      {/* ── When split is OFF: standard Monthly Detail section ── */}
      {!showSplit && (
        <details className="card-p group">
          <summary className="cursor-pointer text-sm font-semibold text-brand select-none">
            {data.granularity === 'daily' ? 'Daily' : 'Monthly'} Detail
          </summary>
          <div className="mt-3 overflow-x-auto">
            <table className="tbl">
              <thead>
                <tr>
                  <th>{data.granularity === 'daily' ? 'Date' : 'Month'}</th>
                  <th>Net PPV (USD)</th>
                  <th>Cumulative PPV (USD)</th>
                  <th>Trend</th>
                </tr>
              </thead>
              <tbody>
                {data.labels.map((lbl, i) => {
                  const v   = data.values[i]
                  const cum = data.cumulative[i]
                  return (
                    <tr key={lbl}>
                      <td className="font-medium">{lbl}</td>
                      <td className={v > 0 ? 'text-danger' : 'text-success'}>{fmt(v)}</td>
                      <td className={cum > 0 ? 'text-danger' : 'text-success'}>{fmt(cum)}</td>
                      <td>{v > 0 ? '🔴' : '🟢'}</td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        </details>
      )}

      {/* ── Drill-down modal ── */}
      {drillLabel !== null && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-sm p-4"
          onClick={() => setDrillLabel(null)}
        >
          <div
            className="bg-white rounded-2xl shadow-2xl flex flex-col w-full max-w-5xl max-h-[85vh]"
            onClick={e => e.stopPropagation()}
          >
            {/* Modal header */}
            <div className="flex items-center justify-between px-5 py-4 border-b border-slate-100 shrink-0">
              <div>
                <p className="text-sm font-bold text-slate-700">
                  Records — {drillLabel.length >= 10 ? drillLabel.slice(0, 10) : drillLabel}
                </p>
                {!drillLoading && (
                  <p className="text-xs text-slate-400 mt-0.5">
                    {drillRows.length} record{drillRows.length !== 1 ? 's' : ''} ·{' '}
                    Total PPV:{' '}
                    <span className={drillRows.reduce((s, r) => s + r.ppv, 0) > 0 ? 'text-danger font-semibold' : 'text-success font-semibold'}>
                      {fmt(drillRows.reduce((s, r) => s + r.ppv, 0))}
                    </span>
                  </p>
                )}
              </div>
              <button
                className="w-7 h-7 rounded-full flex items-center justify-center hover:bg-slate-100 transition-colors"
                onClick={() => setDrillLabel(null)}
              >
                <X className="w-4 h-4 text-slate-400" />
              </button>
            </div>

            {/* Table */}
            <div className="flex-1 overflow-auto">
              {drillLoading ? (
                <div className="flex items-center justify-center h-40 text-slate-400 text-sm">Loading…</div>
              ) : drillRows.length === 0 ? (
                <div className="flex items-center justify-center h-40 text-slate-400 text-sm italic">No records found</div>
              ) : (
                <table className="tbl w-full text-xs">
                  <thead className="sticky top-0 bg-white z-10 shadow-[0_1px_0_0_#e2e8f0]">
                    <tr>
                      <th className="text-left">Date</th>
                      <th className="text-left">Material</th>
                      <th className="text-left">Group</th>
                      <th className="text-left">Vendor</th>
                      <th className="text-left">Plant</th>
                      <th className="text-right">Qty</th>
                      <th className="text-right">PO /1k</th>
                      <th className="text-right">Std /1k</th>
                      <th className="text-right">PPV</th>
                    </tr>
                  </thead>
                  <tbody>
                    {drillRows.map((r, i) => (
                      <tr key={i}>
                        <td className="font-mono whitespace-nowrap">{r.date}</td>
                        <td className="font-mono whitespace-nowrap">{r.material || '—'}</td>
                        <td className="max-w-[160px] truncate">{r.group || '—'}</td>
                        <td className="max-w-[160px] truncate">{r.vendor || '—'}</td>
                        <td className="whitespace-nowrap">{r.plant || '—'}</td>
                        <td className="text-right tabular-nums">{r.quantity !== 0 ? r.quantity.toLocaleString() : '—'}</td>
                        <td className="text-right tabular-nums">{r.po_price_k  !== 0 ? fmt(r.po_price_k)  : '—'}</td>
                        <td className="text-right tabular-nums">{r.std_price_k !== 0 ? fmt(r.std_price_k) : '—'}</td>
                        <td className={`text-right font-semibold tabular-nums ${r.ppv > 0 ? 'text-danger' : 'text-success'}`}>
                          {fmt(r.ppv)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

