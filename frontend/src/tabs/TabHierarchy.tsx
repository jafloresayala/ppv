// src/tabs/TabHierarchy.tsx
import { useState } from 'react'
import HBarChart from '../components/charts/HBarChart'
import LineChart from '../components/charts/LineChart'
import { usePPV } from '../store/ppvStore'
import { getHierarchyDrill } from '../api/client'
import type { HierarchyDrillData } from '../types/api.types'
import { PlantBadges } from '../utils/plants'

const fmt = (v: number) =>
  v.toLocaleString('en-US', { style: 'currency', currency: 'USD', minimumFractionDigits: 2, maximumFractionDigits: 2 })
const TREND: Record<string, string>     = { up: '⬆', down: '⬇', stable: '➡' }
const TREND_CLS: Record<string, string> = { up: 'text-danger', down: 'text-success', stable: 'text-slate-500' }

export default function TabHierarchy() {
  const { analytics, sessionId, selectedGroups, selectedVendors } = usePPV()
  const hd = analytics?.hierarchy
  const [selected, setSelected]       = useState<string | null>(null)
  const [drillMonth, setDrillMonth]   = useState<string | null>(null)
  const [drillData, setDrillData]     = useState<HierarchyDrillData | null>(null)
  const [drillLoading, setDrillLoading] = useState(false)

  if (!hd?.hierarchies.length)
    return <p className="text-sm text-slate-400 italic">No commodity hierarchy data available.</p>

  const barItems     = hd.hierarchies.slice(0, 25).map(h => ({ label: h.code, value: h.total }))
  const trend        = selected ? hd.trend_series[selected] : null
  const hasFences    = trend?.upper_fence != null
  const upperFence   = trend?.upper_fence ?? null
  const lowerFence   = trend?.lower_fence ?? null
  const outlierCount = trend?.outliers?.filter(v => v !== null).length ?? 0

  // Split outliers by direction for distinct colouring
  const highOutliers: (number | null)[] = trend?.outliers?.map((v, i) =>
    v !== null && upperFence !== null && (trend.values[i] ?? 0) > upperFence ? v : null
  ) ?? []
  const lowOutliers: (number | null)[]  = trend?.outliers?.map((v, i) =>
    v !== null && lowerFence !== null && (trend.values[i] ?? 0) < lowerFence ? v : null
  ) ?? []
  const highCount = highOutliers.filter(v => v !== null).length
  const lowCount  = lowOutliers.filter(v => v !== null).length

  return (
    <>
      <div className="fade-in grid grid-cols-1 lg:grid-cols-2 gap-4">
        <div className="card-p">
          <p className="section-title">PPV by Commodity Hierarchy</p>
          <HBarChart
            data={barItems}
            height={640}
            selected={selected}
            onSelect={item => setSelected(item ? item.label : null)}
          />
        </div>
        <div className="card-p overflow-x-auto">
          <p className="section-title">Hierarchy Summary Table</p>
          <table className="tbl">
            <thead>
              <tr><th>Hierarchy</th><th>PPV Total</th><th>Records</th><th>Materials</th><th>Trend</th><th>Plants</th></tr>
            </thead>
            <tbody>
              {hd.hierarchies.map(h => (
                <tr key={h.code}
                  className={selected === h.code ? 'bg-brand/10 cursor-pointer' : 'cursor-pointer hover:bg-slate-50'}
                  onClick={() => setSelected(selected === h.code ? null : h.code)}>
                  <td className="font-medium text-sm">{h.code}</td>
                  <td className={h.total <= 0 ? 'text-success font-semibold' : 'text-danger font-semibold'}>{fmt(h.total)}</td>
                  <td>{h.records}</td>
                  <td>—</td>
                  <td className={TREND_CLS[h.trend]}>{TREND[h.trend]} {h.trend}</td>
                  <td><PlantBadges plants={h.plants} /></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {/* ── Floating Trend Widget ───────────────────────────────────────── */}
      {selected && trend && trend.labels.length >= 2 && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-sm"
          onClick={() => setSelected(null)}
        >
          <div
            className="bg-white rounded-2xl shadow-2xl w-full max-w-3xl mx-4 overflow-hidden"
            onClick={e => e.stopPropagation()}
          >
            {/* Header */}
            <div className="bg-slate-800 text-white px-6 py-4 flex items-center justify-between gap-4">
              <div className="min-w-0">
                <p className="text-[10px] font-semibold text-slate-400 uppercase tracking-widest">Monthly Trend</p>
                <h2 className="text-lg font-bold font-mono truncate">{selected}</h2>
              </div>
              {/* Legend */}
              <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs shrink-0">
                <span className="flex items-center gap-1.5">
                  <span className="inline-block w-6 border-t-2 border-blue-400" />
                  <span className="text-slate-300">Actual</span>
                </span>
                {trend.trend_line && (
                  <span className="flex items-center gap-1.5">
                    <span className="inline-block w-6 border-t-2 border-amber-400 border-dashed" />
                    <span className="text-slate-300">Trend (inliers)</span>
                  </span>
                )}
                {hasFences && (
                  <span className="flex items-center gap-1.5">
                    <span className="inline-block w-6 border-t border-dashed border-red-400" />
                    <span className="text-slate-300">Upper {fmt(upperFence!)}</span>
                  </span>
                )}
                {hasFences && (
                  <span className="flex items-center gap-1.5">
                    <span className="inline-block w-6 border-t border-dashed border-emerald-400" />
                    <span className="text-slate-300">Lower {fmt(lowerFence!)}</span>
                  </span>
                )}
                {outlierCount > 0 && (
                  <span className="flex items-center gap-1.5">
                    <span className="inline-block w-3 h-3 rounded-full bg-red-500" />
                    <span className="text-slate-300">High outliers ({highCount})</span>
                  </span>
                )}
                {lowCount > 0 && (
                  <span className="flex items-center gap-1.5">
                    <span className="inline-block w-3 h-3 rounded-full bg-emerald-400" />
                    <span className="text-slate-300">Low outliers ({lowCount})</span>
                  </span>
                )}
              </div>
              <button
                className="shrink-0 w-8 h-8 rounded-full bg-slate-700 hover:bg-slate-600 flex items-center justify-center text-slate-300 hover:text-white transition-colors"
                onClick={() => setSelected(null)}
              >✕</button>
            </div>

            {/* Outlier notice */}
            {outlierCount > 0 && (
              <div className="bg-amber-50 border-b border-amber-200 px-6 py-2 text-xs text-amber-700 flex items-center gap-2">
                <span className="font-bold">⚠ {outlierCount} outlier{outlierCount > 1 ? 's' : ''}</span>
                <span>detected via IQR — excluded from trend line</span>
                {highCount > 0 && <span className="font-semibold text-red-600">↑ {highCount} high</span>}
                {lowCount  > 0 && <span className="font-semibold text-emerald-600">↓ {lowCount} low</span>}
              </div>
            )}

            {/* Chart */}
            <div className="p-5">
              <p className="text-[10px] text-slate-400 text-center mb-1">Haz clic en un punto para ver el desglose de materiales</p>
              <LineChart
                labels={trend.labels}
                height={300}
                onClickPoint={async (_label, idx) => {
                  if (!sessionId || !selected) return
                  const month = trend.labels[idx]
                  if (!month) return
                  setDrillMonth(month)
                  setDrillData(null)
                  setDrillLoading(true)
                  try {
                    const result = await getHierarchyDrill(
                      sessionId,
                      { material_groups: selectedGroups, vendors: selectedVendors },
                      selected,
                      month,
                    )
                    setDrillData(result)
                  } finally {
                    setDrillLoading(false)
                  }
                }}
                series={[
                  { label: 'Monthly PPV',    values: trend.values,                             color: '#1d4ed8', width: 2 },
                  ...(trend.trend_line
                    ? [{ label: 'Trend (inliers)', values: trend.trend_line,                   color: '#f59e0b', width: 2, dash: [6, 3] }]
                    : []),
                  ...(hasFences ? [{ label: 'Upper fence', values: trend.labels.map(() => upperFence), color: '#ef4444', width: 1, dash: [4, 4], noPoints: true }] : []),
                  ...(hasFences ? [{ label: 'Lower fence', values: trend.labels.map(() => lowerFence), color: '#10b981', width: 1, dash: [4, 4], noPoints: true }] : []),
                  ...(highCount > 0
                    ? [{ label: 'High outliers', values: highOutliers, color: '#ef4444', width: 0, pointOnly: true }]
                    : []),
                  ...(lowCount > 0
                    ? [{ label: 'Low outliers',  values: lowOutliers,  color: '#10b981', width: 0, pointOnly: true }]
                    : []),
                ]}
              />
            </div>
          </div>
        </div>
      )}

      {/* ── Drill-down Widget (material breakdown per month) ─────────────── */}
      {drillMonth && (drillLoading || drillData) && (
        <div
          className="fixed inset-0 z-[60] flex items-center justify-center bg-black/50 backdrop-blur-sm"
          onClick={() => { setDrillMonth(null); setDrillData(null) }}
        >
          <div
            className="bg-white rounded-2xl shadow-2xl w-full max-w-2xl mx-4 max-h-[90vh] flex flex-col"
            onClick={e => e.stopPropagation()}
          >
            {/* Header */}
            <div className="bg-slate-900 text-white px-6 py-4 flex items-center justify-between shrink-0">
              <div>
                <p className="text-[10px] font-semibold text-slate-400 uppercase tracking-widest">Material Breakdown</p>
                <h2 className="text-lg font-bold font-mono">
                  {selected} — {drillMonth}
                </h2>
              </div>
              <button
                className="w-8 h-8 rounded-full bg-slate-700 hover:bg-slate-600 flex items-center justify-center text-slate-300 hover:text-white transition-colors"
                onClick={() => { setDrillMonth(null); setDrillData(null) }}
              >✕</button>
            </div>

            {/* Body — scrollable */}
            <div className="flex-1 overflow-y-auto p-5">
              {drillLoading && (
                <div className="flex items-center justify-center gap-2 py-10 text-slate-400">
                  <svg className="animate-spin h-5 w-5" viewBox="0 0 24 24" fill="none">
                    <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"/>
                    <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8H4z"/>
                  </svg>
                  <span className="text-sm">Loading materials…</span>
                </div>
              )}
              {!drillLoading && drillData && drillData.items.length === 0 && (
                <p className="text-center text-sm text-slate-400 py-8">No records found for this month.</p>
              )}
              {!drillLoading && drillData && drillData.items.length > 0 && (
                <>
                  <HBarChart
                    data={drillData.items.map(it => ({
                      label: it.material,
                      value: it.ppv,
                    }))}
                    height={drillData.items.length * 30 + 40}
                  />
                  <div className="mt-3 overflow-x-auto">
                    <table className="tbl text-xs">
                      <thead>
                        <tr><th>Material</th><th>Description</th><th>PPV</th></tr>
                      </thead>
                      <tbody>
                        {drillData.items.map(it => (
                          <tr key={it.material}>
                            <td className="font-mono">{it.material}</td>
                            <td className="text-slate-600 max-w-[260px] truncate">{it.description}</td>
                            <td className={it.ppv <= 0 ? 'text-success font-semibold' : 'text-danger font-semibold'}>
                              {fmt(it.ppv)}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </>
              )}
            </div>
          </div>
        </div>
      )}
    </>
  )
}
