// src/tabs/TabMaterials.tsx
import { useState } from 'react'
import { Trophy, BarChart2, X, TrendingUp, TrendingDown } from 'lucide-react'
import HBarChart from '../components/charts/HBarChart'
import LineChart  from '../components/charts/LineChart'
import { usePPV } from '../store/ppvStore'
import { getMaterialTrend } from '../api/client'
import type { MaterialTrendData } from '../types/api.types'
import { PlantBadges } from '../utils/plants'

const fmtUSD = (v: number | null | undefined) =>
  v == null ? 'â€”' : v.toLocaleString('en-US', { style: 'currency', currency: 'USD', minimumFractionDigits: 2, maximumFractionDigits: 2 })

// Format "202401" â†’ "Jan '24"
function fmtYM(ym: string) {
  if (ym.length !== 6) return ym
  const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec']
  const y = ym.slice(0, 4); const m = parseInt(ym.slice(4), 10) - 1
  return `${months[m] ?? ym.slice(4)} '${y.slice(2)}`
}

function avg(arr: (number | null)[]): number | null {
  const valid = arr.filter((v): v is number => v != null)
  return valid.length ? valid.reduce((a, b) => a + b, 0) / valid.length : null
}

export default function TabMaterials() {
  const { analytics, sessionId, selectedGroups, selectedVendors } = usePPV()
  const md = analytics?.materials

  const [view, setView]         = useState<'top' | 'pareto'>('top')
  const [topN, setTopN]         = useState(20)
  const [sign, setSign]         = useState<'both' | 'pos' | 'neg'>('both')

  // Trend modal state
  const [trendData,    setTrendData]    = useState<MaterialTrendData | null>(null)
  const [trendLoading, setTrendLoading] = useState(false)
  const [trendMat,     setTrendMat]     = useState<string | null>(null)

  if (!md?.materials.length)
    return <p className="text-sm text-slate-400 italic">No material data available.</p>

  // Compute displayed bar items based on sign filter + topN
  const allMats = md.materials
  const filtered =
    sign === 'pos'  ? allMats.filter(m => m.total >  0).sort((a, b) => b.total - a.total) :
    sign === 'neg'  ? allMats.filter(m => m.total <  0).sort((a, b) => a.total - b.total) :
    allMats.slice().sort((a, b) => Math.abs(b.total) - Math.abs(a.total))
  const barItems = filtered.slice(0, Math.max(1, topN)).map(m => ({ label: m.number, value: m.total }))

  async function openTrend(materialNumber: string) {
    setTrendMat(materialNumber)
    setTrendData(null)
    setTrendLoading(true)
    try {
      const filters: Record<string, string[]> = {}
      if (selectedGroups.length)  filters.material_groups = selectedGroups
      if (selectedVendors.length) filters.vendors          = selectedVendors
      const result = await getMaterialTrend(sessionId!, filters, materialNumber)
      setTrendData(result)
    } finally {
      setTrendLoading(false)
    }
  }

  function closeTrend() { setTrendMat(null); setTrendData(null) }

  // Stats derived from trend data
  const avgStd  = trendData ? avg(trendData.std_price) : null
  const avgPO   = trendData ? avg(trendData.po_price)  : null
  const avgDiff = avgStd != null && avgPO != null ? avgPO - avgStd : null
  const diffPct = avgStd != null && avgStd !== 0 && avgDiff != null ? (avgDiff / avgStd) * 100 : null
  const totalPPV = trendData ? trendData.ppv.reduce<number>((s, v) => s + (v ?? 0), 0) : null

  // Chart series for trend modal
  const trendLabels  = trendData?.labels.map(fmtYM) ?? []
  const trendSeries = trendData ? [
    ...(trendData.std_price.some(v => v != null) ? [{
      label: 'Std Price /1k', values: trendData.std_price, color: '#3b82f6', width: 2,
    }] : []),
    ...(trendData.po_price.some(v => v != null) ? [{
      label: 'PO Price /1k',  values: trendData.po_price,  color: '#f59e0b', width: 2,
    }] : []),
    ...(trendData.ppv.some(v => v != null) ? [{
      label: 'PPV (monthly)', values: trendData.ppv, color: '#ef4444', width: 1.5, dash: [4, 3],
    }] : []),
  ] : []

  return (
    <div className="fade-in flex flex-col gap-5">

      {/* â”€â”€ View toggle â”€â”€ */}
      <div className="flex gap-1 flex-wrap bg-white rounded-xl border border-slate-200 p-1.5 shadow-sm">
        <button
          className={`tab-btn flex items-center gap-1.5 ${view === 'top' ? 'tab-btn-active' : 'tab-btn-inactive'}`}
          onClick={() => setView('top')}
        >
          <Trophy size={13} />
          <span>Top N</span>
        </button>
        <button
          className={`tab-btn flex items-center gap-1.5 ${view === 'pareto' ? 'tab-btn-active' : 'tab-btn-inactive'}`}
          onClick={() => setView('pareto')}
        >
          <BarChart2 size={13} />
          <span>Pareto</span>
        </button>
      </div>

      {view === 'top' && (
        <div className="card-p flex flex-col gap-4">

          {/* Controls row */}
          <div className="flex flex-wrap items-center gap-3">
            {/* Top N input */}
            <div className="flex items-center gap-2">
              <span className="text-xs text-slate-500 font-medium">Top</span>
              <input
                type="number"
                min={1}
                max={allMats.length}
                value={topN}
                onChange={e => setTopN(Math.max(1, parseInt(e.target.value) || 1))}
                className="w-16 px-2 py-1 text-sm font-semibold text-center border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-brand/40"
              />
              <span className="text-xs text-slate-400">of {allMats.length}</span>
            </div>

            {/* Sign filter */}
            <div className="flex gap-1 bg-slate-100 p-1 rounded-lg">
              {([
                { k: 'both', label: 'Both'         },
                { k: 'pos',  label: 'Cost (+)'     },
                { k: 'neg',  label: 'Savings (−)'  },
              ] as const).map(({ k, label }) => (
                <button
                  key={k}
                  onClick={() => setSign(k)}
                  className={`px-2.5 py-1 rounded-md text-xs font-semibold transition-all ${
                    sign === k
                      ? k === 'pos' ? 'bg-white shadow text-red-600'
                        : k === 'neg' ? 'bg-white shadow text-green-600'
                        : 'bg-white shadow text-slate-800'
                      : 'text-slate-500 hover:text-slate-700'
                  }`}
                >
                  {label}
                </button>
              ))}
            </div>

            <p className="text-xs text-slate-400 ml-auto">
              Click a bar to see the price trend
            </p>
          </div>

          <HBarChart
            data={barItems}
            height={Math.max(260, barItems.length * 28)}
            onSelect={item => item && openTrend(item.label)}
          />
        </div>
      )}

      {view === 'pareto' && (
        <div className="card-p overflow-x-auto">
          <p className="section-title">Pareto Analysis (80/20 Rule)</p>
          <table className="tbl">
            <thead>
              <tr>
                <th>#</th><th>Material</th><th>Description</th>
                <th>PPV Total</th><th>Cumulative %</th><th>Plants</th>
              </tr>
            </thead>
            <tbody>
              {md.pareto.map((r, i) => (
                <tr key={r.number} className={r.cum_pct <= 80 ? 'bg-amber-50' : ''}>
                  <td className="text-slate-400 text-xs">{i + 1}</td>
                  <td className="font-mono text-xs">{r.number}</td>
                  <td className="text-xs text-slate-500">{r.desc ?? 'â€”'}</td>
                  <td className={r.total <= 0 ? 'text-success font-medium' : 'text-danger font-medium'}>{fmtUSD(r.total)}</td>
                  <td>
                    <div className="flex items-center gap-2">
                      <div className="w-20 bg-slate-200 h-1.5 rounded">
                        <div className="bg-brand h-1.5 rounded" style={{ width: `${Math.min(r.cum_pct, 100)}%` }} />
                      </div>
                      <span className="text-xs">{r.cum_pct.toFixed(1)}%</span>
                    </div>
                  </td>
                  <td><PlantBadges plants={r.plants} /></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* â”€â”€ Price Trend Modal â”€â”€ */}
      {trendMat && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm"
          onClick={closeTrend}
        >
          <div
            className="bg-white rounded-2xl shadow-2xl w-full max-w-3xl mx-4 max-h-[92vh] flex flex-col"
            onClick={e => e.stopPropagation()}
          >
            {/* Header */}
            <div className="bg-slate-800 text-white px-6 py-4 rounded-t-2xl shrink-0 flex items-start justify-between gap-3">
              <div>
                <p className="text-[10px] font-semibold opacity-60 uppercase tracking-widest">Price Trend</p>
                <h2 className="text-base font-bold font-mono">{trendMat}</h2>
                {trendData?.desc && (
                  <p className="text-xs opacity-70 mt-0.5">{trendData.desc}</p>
                )}
              </div>
              <button
                onClick={closeTrend}
                className="w-8 h-8 rounded-full bg-white/10 hover:bg-white/20 flex items-center justify-center transition-colors shrink-0"
              >
                <X size={15} />
              </button>
            </div>

            {/* Body */}
            <div className="flex-1 overflow-y-auto p-5 flex flex-col gap-5">
              {trendLoading && (
                <div className="flex flex-col gap-3">
                  <div className="skeleton h-8 w-48 rounded-lg" />
                  <div className="skeleton h-52 rounded-xl" />
                </div>
              )}

              {!trendLoading && trendData && (
                <>
                  {/* Summary stats */}
                  <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
                    <div className="card-p bg-blue-50 border border-blue-100 min-w-0">
                      <p className="text-[10px] text-blue-500 font-semibold uppercase tracking-wide leading-tight">Avg Std Price /1k</p>
                      <p className="text-sm font-bold text-blue-700 mt-1 truncate">{fmtUSD(avgStd)}</p>
                    </div>
                    <div className="card-p bg-amber-50 border border-amber-100 min-w-0">
                      <p className="text-[10px] text-amber-600 font-semibold uppercase tracking-wide leading-tight">Avg PO Price /1k</p>
                      <p className="text-sm font-bold text-amber-700 mt-1 truncate">{fmtUSD(avgPO)}</p>
                    </div>
                    <div className={`card-p border min-w-0 ${avgDiff != null && avgDiff > 0 ? 'bg-red-50 border-red-100' : 'bg-green-50 border-green-100'}`}>
                      <p className={`text-[10px] font-semibold uppercase tracking-wide leading-tight ${avgDiff != null && avgDiff > 0 ? 'text-red-500' : 'text-green-600'}`}>
                        Avg Difference /1k
                      </p>
                      <p className={`text-sm font-bold mt-1 truncate ${avgDiff != null && avgDiff > 0 ? 'text-red-600' : 'text-green-700'}`}>
                        {fmtUSD(avgDiff)}
                      </p>
                      {diffPct != null && (
                        <p className={`text-[11px] font-semibold mt-0.5 ${diffPct > 0 ? 'text-red-500' : 'text-green-600'}`}>
                          {diffPct > 0 ? <TrendingUp size={11} className="inline mr-0.5" /> : <TrendingDown size={11} className="inline mr-0.5" />}
                          {diffPct > 0 ? '+' : ''}{diffPct.toFixed(1)}%
                        </p>
                      )}
                    </div>
                    <div className={`card-p border min-w-0 ${totalPPV != null && totalPPV > 0 ? 'bg-red-50 border-red-100' : 'bg-green-50 border-green-100'}`}>
                      <p className="text-[10px] text-slate-500 font-semibold uppercase tracking-wide leading-tight">Total PPV</p>
                      <p className={`text-sm font-bold mt-1 truncate ${totalPPV != null && totalPPV > 0 ? 'text-red-600' : 'text-green-700'}`}>
                        {fmtUSD(totalPPV)}
                      </p>
                    </div>
                  </div>

                  {/* Chart */}
                  {trendLabels.length > 0 && trendSeries.length > 0
                    ? <LineChart labels={trendLabels} series={trendSeries} height={260} yLabel="Price /1k (USD)" />
                    : <p className="text-sm text-slate-400 italic">No price series available for this material.</p>
                  }

                  {/* Monthly detail table */}
                  {trendLabels.length > 0 && (
                    <div className="overflow-x-auto">
                      <table className="tbl text-xs w-full">
                        <thead>
                          <tr>
                            <th>Month</th>
                            <th>Std Price /1k</th>
                            <th>PO Price /1k</th>
                            <th>Difference</th>
                            <th>Diff %</th>
                            <th>PPV Total</th>
                            <th>Records</th>
                          </tr>
                        </thead>
                        <tbody>
                          {trendLabels.map((lbl, i) => {
                            const std  = trendData.std_price[i]
                            const po   = trendData.po_price[i]
                            const diff = std != null && po != null ? po - std : null
                            const pct  = std != null && std !== 0 && diff != null ? (diff / std) * 100 : null
                            const ppv  = trendData.ppv[i]
                            return (
                              <tr key={lbl}>
                                <td className="font-medium">{lbl}</td>
                                <td className="text-blue-700">{fmtUSD(std)}</td>
                                <td className="text-amber-700">{fmtUSD(po)}</td>
                                <td className={diff != null ? (diff > 0 ? 'text-danger font-semibold' : 'text-success font-semibold') : ''}>
                                  {fmtUSD(diff)}
                                </td>
                                <td className={pct != null ? (pct > 0 ? 'text-danger' : 'text-success') : 'text-slate-400'}>
                                  {pct != null ? `${pct > 0 ? '+' : ''}${pct.toFixed(1)}%` : 'â€”'}
                                </td>
                                <td className={ppv != null ? (ppv > 0 ? 'text-danger font-semibold' : 'text-success font-semibold') : ''}>
                                  {fmtUSD(ppv)}
                                </td>
                                <td className="text-slate-400">{trendData.records[i]}</td>
                              </tr>
                            )
                          })}
                        </tbody>
                      </table>
                    </div>
                  )}
                </>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
