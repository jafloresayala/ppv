// src/tabs/TabMaterialGroup.tsx
import { useState, useEffect } from 'react'
import BarChart from '../components/charts/BarChart'
import LineChart from '../components/charts/LineChart'
import StackedMGChart from '../components/charts/StackedMGChart'
import MGRecDrillModal from '../components/MGRecDrillModal'
import { usePPV } from '../store/ppvStore'
import { PLANT_FLAGS, PLANT_NAMES, PLANT_COLORS, PlantBadges } from '../utils/plants'

const fmt = (v: number) => `$${v.toLocaleString(undefined, { minimumFractionDigits: 2 })}`
const fmtK = (v: number) => {
  const abs = Math.abs(v)
  if (abs >= 1_000_000) return `$${(v / 1_000_000).toFixed(1)}M`
  if (abs >= 1_000)     return `$${(v / 1_000).toFixed(0)}K`
  return `$${v.toFixed(0)}`
}

/** Plant with highest |PPV| for a group */
function dominantPlant(by_plant?: Record<string, number>): string | null {
  if (!by_plant) return null
  const entries = Object.entries(by_plant)
  if (!entries.length) return null
  return entries.reduce((best, cur) =>
    Math.abs(cur[1]) > Math.abs(best[1]) ? cur : best
  )[0]
}

/**
 * Compact per-plant horizontal mini-bars for a drilldown material row.
 * Shows each plant’s contribution with a proportional color bar.
 */
function PlantMiniBar({ byPlant }: { byPlant: Record<string, number> }) {
  const entries = Object.entries(byPlant)
    .filter(([, v]) => v !== 0)
    .sort((a, b) => Math.abs(b[1]) - Math.abs(a[1]))
  if (!entries.length) return <span className="text-slate-300 text-xs">—</span>
  const maxAbs = Math.max(...entries.map(([, v]) => Math.abs(v)))
  return (
    <div className="flex flex-col gap-0.5 min-w-[130px]">
      {entries.map(([plant, val]) => (
        <div key={plant} className="flex items-center gap-1">
          <span className="text-[11px] w-5 text-center leading-none flex-shrink-0">
            {PLANT_FLAGS[plant] ?? '🏭'}
          </span>
          <div className="flex-1 h-1.5 bg-slate-100 rounded-full overflow-hidden" style={{ minWidth: 36 }}>
            <div
              className="h-full rounded-full"
              style={{
                width: `${(Math.abs(val) / maxAbs) * 100}%`,
                background: PLANT_COLORS[plant] ?? '#94a3b8',
              }}
            />
          </div>
          <span className={`text-[10px] font-semibold w-11 text-right leading-none flex-shrink-0 ${
            val > 0 ? 'text-danger' : 'text-success'
          }`}>
            {fmtK(val)}
          </span>
        </div>
      ))}
    </div>
  )
}

export default function TabMaterialGroup() {
  const { analytics }     = usePPV()
  const mg                = analytics?.material_groups
  const [selected, setSelected] = useState<string | null>(null)
  const [split, setSplit] = useState(false)
  const [recFilterIdx, setRecFilterIdx] = useState<number>(-1)
  const [drillRec, setDrillRec] = useState<PlantRec | null>(null)

  // Reset filter whenever split is toggled (avoids stale index)
  useEffect(() => { setRecFilterIdx(-1) }, [split])

  if (!mg?.groups.length)
    return <p className="text-sm text-slate-400 italic">No Material Group data available.</p>

  const unfav   = mg.groups.filter(g => g.total > 0).sort((a, b) => b.total - a.total)
  const fav     = mg.groups.filter(g => g.total <= 0).sort((a, b) => a.total - b.total)
  const barData = [...unfav, ...fav].slice(0, 28).map(g => ({ label: g.name, value: g.total }))
  const splitAt = Math.min(unfav.length, 28)

  // Collect all plants that appear in any group
  const allPlants = Array.from(
    new Set(mg.groups.flatMap(g => Object.keys(g.by_plant ?? {})))
  ).sort()
  const hasPlants = allPlants.length > 1

  // Data for stacked-by-plant chart (split mode) — deduplicate by group name first
  const groupList  = Array.from(
    new Map([...unfav, ...fav].map(g => [g.name, g])).values()
  ).slice(0, 28)
  const mgLabels   = groupList.map(g => g.name)
  const byPlantMG: Record<string, number[]> = {}
  allPlants.forEach(p => {
    byPlantMG[p] = groupList.map(g => g.by_plant?.[p] ?? 0)
  })

  // Recommendations: for every losing plant in each group, recommend against the best performer
  interface PlantRec { group: string; winner: { plant: string; value: number }; loser: { plant: string; value: number }; gap: number }
  const allPlantRecs: PlantRec[] = !split || !hasPlants ? [] : groupList.flatMap((g, i) => {
    const vals = allPlants
      .map(p => ({ plant: p, value: byPlantMG[p]?.[i] ?? 0 }))
      .filter(it => it.value !== 0)
    if (vals.length < 2) return []
    // Best performer: plant with the most favorable (lowest) PPV
    const winner = vals.reduce((b, c) => c.value < b.value ? c : b)
    // Every plant with positive PPV (losing money) gets a recommendation vs the winner
    const losers = vals.filter(it => it.value > 0 && it.plant !== winner.plant)
    return losers.map(loser => ({
      group: g.name,
      winner,
      loser,
      gap: loser.value - Math.min(0, winner.value),
    }))
  }).sort((a, b) => b.gap - a.gap)

  const recFilterPlants = Array.from(new Set(allPlantRecs.map(r => r.loser.plant))).sort()
  // Use index instead of string to guarantee exact match regardless of code format
  const selectedPlant = recFilterIdx >= 0 && recFilterIdx < recFilterPlants.length
    ? recFilterPlants[recFilterIdx]
    : null
  const plantRecs = selectedPlant == null
    ? allPlantRecs
    : allPlantRecs.filter(r => r.loser.plant === selectedPlant)

  const drill    = selected ? mg.drilldown[selected] : null
  const trendD   = selected ? mg.trends[selected]    : null
  const totalSel = selected ? mg.groups.find(g => g.name === selected)?.total ?? 0 : 0
  const selPlants = selected ? (mg.groups.find(g => g.name === selected)?.plants ?? []) : []
  const trendDir  = trendD?.direction ?? 'stable'
  const TREND_BADGE: Record<string, string> = { up: '⬆ Rising', down: '⬇ Falling', stable: '➡ Stable' }
  const TREND_CLS:   Record<string, string> = { up: 'badge badge-bad', down: 'badge badge-good', stable: 'badge badge-neutral' }

  return (
    <div className="fade-in flex flex-col gap-5">

      {/* ── Main bar chart ── */}
      <div className="card-p">
        <div className="flex items-center justify-between flex-wrap gap-3 mb-3">
          <p className="section-title mb-0">PPV by Material Group</p>

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
                <span className={`pointer-events-none inline-block h-4 w-4 transform rounded-full bg-white shadow ring-0 transition-transform ${
                  split ? 'translate-x-4' : 'translate-x-0'
                }`} />
              </button>
            </label>
          )}
        </div>

        {split && hasPlants
          ? <StackedMGChart
              labels={mgLabels}
              byPlant={byPlantMG}
              height={400}
              selected={selected}
              onSelect={lbl => setSelected(lbl)}
            />
          : <BarChart
              data={barData}
              height={340}
              splitIndex={splitAt}
              selected={selected}
              onSelect={item => setSelected(item ? item.label : null)}
            />
        }
        <p className="text-xs text-slate-400 mt-1">Click a bar to drill down ↓</p>
      </div>

      {/* ── Recommendations card ── */}
      {split && hasPlants && allPlantRecs.length > 0 && (
        <div className="card-p fade-in">
          {/* Header row */}
          <div className="flex items-center justify-between flex-wrap gap-3 mb-1">
            <div className="flex items-center gap-2">
              <span className="text-base">💡</span>
              <p className="section-title mb-0">Recommendations</p>
            </div>
            {/* Plant filter dropdown */}
            <select
              value={recFilterIdx}
              onChange={e => setRecFilterIdx(Number(e.target.value))}
              className="text-xs border border-slate-200 rounded-lg px-2.5 py-1.5 text-slate-600 bg-white focus:outline-none focus:ring-2 focus:ring-brand/30 cursor-pointer"
            >
              <option value={-1}>All plants</option>
              {recFilterPlants.map((p, i) => (
                <option key={p} value={i}>
                  {PLANT_FLAGS[p] ?? '🏭'} {PLANT_NAMES[p] ?? p}
                </option>
              ))}
            </select>
          </div>
          <p className="text-xs text-slate-500 mb-4">
            {selectedPlant == null
              ? 'Top opportunities where underperforming plants can reduce cost by benchmarking against the best performer in each material group.'
              : `Showing groups where ${PLANT_NAMES[selectedPlant] ?? selectedPlant} is the highest-cost plant — sorted by savings potential.`
            }
          </p>

          {plantRecs.length === 0
            ? <p className="text-xs text-slate-400 italic">No recommendations for the selected filter.</p>
            : <div className="flex flex-col gap-2.5">
                {plantRecs.map(rec => (
                  <div
                    key={`${rec.group}|${rec.loser.plant}`}
                    className={`flex items-center gap-3 p-3 rounded-xl border transition-colors cursor-pointer ${
                      'border-slate-100 bg-slate-50 hover:bg-slate-100 hover:border-slate-200'
                    }`}
                    onClick={() => setDrillRec(rec)}
                  >
                    {/* Opportunity badge */}
                    <div className="shrink-0 text-center min-w-[56px]">
                      <p className="text-[10px] text-slate-400 leading-tight">Opportunity</p>
                      <p className="text-sm font-bold text-danger leading-tight">{fmtK(rec.gap)}</p>
                    </div>

                    <div className="flex-1 min-w-0">
                      <p className="text-sm font-semibold text-slate-800 truncate mb-1">{rec.group}</p>
                      <div className="flex items-center gap-2 flex-wrap text-xs">
                        {/* Worst performer (loser) — shown FIRST so filtered plant is prominent */}
                        <span className="flex items-center gap-1 px-2 py-0.5 rounded-full bg-red-50 border border-red-200 text-red-700 font-medium">
                          <span className="w-1.5 h-1.5 rounded-full bg-red-500 shrink-0" />
                          {PLANT_FLAGS[rec.loser.plant] ?? '🏭'} {PLANT_NAMES[rec.loser.plant] ?? rec.loser.plant}
                          <span className="text-red-600 font-semibold">+{fmtK(rec.loser.value)}</span>
                        </span>

                        <span className="text-slate-400 text-[10px] font-medium">→ target:</span>

                        {/* Best performer */}
                        <span className="flex items-center gap-1 px-2 py-0.5 rounded-full bg-green-50 border border-green-200 text-green-700 font-medium">
                          <span className="w-1.5 h-1.5 rounded-full bg-green-500 shrink-0" />
                          {PLANT_FLAGS[rec.winner.plant] ?? '🏭'} {PLANT_NAMES[rec.winner.plant] ?? rec.winner.plant}
                          <span className="text-green-600 font-semibold">{fmtK(rec.winner.value)}</span>
                        </span>
                      </div>
                      <p className="text-[11px] text-slate-400 mt-1 truncate">
                        Review <strong className="text-slate-600">{PLANT_NAMES[rec.loser.plant] ?? rec.loser.plant}</strong>'s sourcing strategy for this group —
                        benchmark against <strong className="text-slate-600">{PLANT_NAMES[rec.winner.plant] ?? rec.winner.plant}</strong>
                      </p>
                    </div>
                  </div>
                ))}
              </div>
          }
        </div>
      )}

      {/* ── Split by Plant: ranking card ── */}
      {split && hasPlants && (
        <div className="card-p">
          <p className="section-title">Plant Ranking by Material Group</p>
          <div className="overflow-auto max-h-[520px]">
            <table className="tbl">
              <thead className="sticky top-0 z-[1] bg-white shadow-[0_1px_0_0_#e2e8f0]">
                <tr>
                  <th className="text-left">Material Group</th>
                  <th>Total PPV</th>
                  <th>Top Plant</th>
                  {allPlants.map(p => (
                    <th key={p}>
                      <span className="flex items-center gap-1 justify-center">
                        <span className="w-2 h-2 rounded-full inline-block shrink-0"
                          style={{ background: PLANT_COLORS[p] ?? '#94a3b8' }} />
                        {PLANT_FLAGS[p] ?? '🏭'} {PLANT_NAMES[p] ?? p}
                      </span>
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {[...unfav, ...fav].slice(0, 28).map(g => {
                  const dom = dominantPlant(g.by_plant)
                  return (
                    <tr
                      key={g.name}
                      className={`cursor-pointer ${selected === g.name ? 'bg-brand/10' : 'hover:bg-slate-50'}`}
                      onClick={() => setSelected(selected === g.name ? null : g.name)}
                    >
                      <td className="font-medium text-sm max-w-[200px] truncate">{g.name}</td>
                      <td className={`font-semibold ${g.total > 0 ? 'text-danger' : 'text-success'}`}>
                        {fmtK(g.total)}
                      </td>
                      <td className="text-center text-base">
                        {dom ? (
                          <span title={PLANT_NAMES[dom] ?? dom}>
                            {PLANT_FLAGS[dom] ?? '🏭'}
                          </span>
                        ) : '—'}
                      </td>
                      {allPlants.map(p => {
                        const v = g.by_plant?.[p] ?? 0
                        return (
                          <td key={p} className={v > 0 ? 'text-danger' : v < 0 ? 'text-success' : 'text-slate-300'}>
                            {v !== 0 ? fmtK(v) : '—'}
                          </td>
                        )
                      })}
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* ── Drilldown card ── */}
      {selected && (
        <div className="card-p border-l-4 border-brand fade-in flex flex-col gap-4">
          <div className="flex items-center justify-between flex-wrap gap-2">
            <div>
              <span className="text-xs text-slate-500 uppercase tracking-wide">Selected Group</span>
              <h3 className="text-lg font-bold text-slate-800">{selected}</h3>
            </div>
            <div className="flex gap-3 items-center flex-wrap">
              <span className={`px-3 py-1 rounded-full text-sm font-bold ${totalSel <= 0 ? 'bg-success-light text-success' : 'bg-danger-light text-danger'}`}>
                {fmt(totalSel)}
              </span>
              {trendD && <span className={TREND_CLS[trendDir]}>{TREND_BADGE[trendDir]}</span>}
              <PlantBadges plants={selPlants} />

              {/* Dominant plant badge */}
              {(() => {
                const grp = mg.groups.find(g => g.name === selected)
                const dom = dominantPlant(grp?.by_plant)
                if (!dom) return null
                const domVal = grp?.by_plant?.[dom] ?? 0
                return (
                  <span className="flex items-center gap-1 text-xs px-2 py-1 rounded-full bg-slate-100 text-slate-600 font-medium">
                    <span className="text-[10px] text-slate-400 mr-0.5">Top plant:</span>
                    {PLANT_FLAGS[dom] ?? '🏭'} {PLANT_NAMES[dom] ?? dom}
                    <span className={`ml-1 font-semibold ${domVal > 0 ? 'text-danger' : 'text-success'}`}>
                      {fmtK(domVal)}
                    </span>
                  </span>
                )
              })()}

              <button className="btn-ghost text-xs" onClick={() => setSelected(null)}>✕ Clear</button>
            </div>
          </div>

          {drill && (
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">

              {/* Unfavorable 🔴 */}
              <div>
                <p className="text-sm font-semibold text-danger mb-2">Top 10 Unfavorable Components 🔴</p>
                {drill.unfavorable.length
                  ? <div className="overflow-x-auto">
                      <table className="tbl w-full">
                        <thead>
                          <tr>
                            <th className="text-left">Material</th>
                            <th>PPV Total</th>
                            <th>Records</th>
                            {hasPlants && <th className="text-left">Plants</th>}
                          </tr>
                        </thead>
                        <tbody>
                          {drill.unfavorable.map((r: any) => (
                            <tr key={r.Material_Number}>
                              <td className="font-mono text-xs">{r.Material_Number}</td>
                              <td className="text-danger font-medium">{fmt(r.total)}</td>
                              <td>{r.records}</td>
                              {hasPlants && (
                                <td className="py-1.5">
                                  {r.by_plant && Object.keys(r.by_plant).length > 0
                                    ? <PlantMiniBar byPlant={r.by_plant} />
                                    : <span className="text-slate-300 text-xs">—</span>
                                  }
                                </td>
                              )}
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  : <p className="text-xs text-slate-400 italic">No unfavorable components.</p>}
              </div>

              {/* Favorable 🟢 */}
              <div>
                <p className="text-sm font-semibold text-success mb-2">Top 10 Favorable Components 🟢</p>
                {drill.favorable.length
                  ? <div className="overflow-x-auto">
                      <table className="tbl w-full">
                        <thead>
                          <tr>
                            <th className="text-left">Material</th>
                            <th>PPV Total</th>
                            <th>Records</th>
                            {hasPlants && <th className="text-left">Plants</th>}
                          </tr>
                        </thead>
                        <tbody>
                          {[...drill.favorable]
                            .sort((a: any, b: any) => (a.total ?? 0) - (b.total ?? 0))
                            .slice(0, 10)
                            .map((r: any) => (
                              <tr key={r.Material_Number}>
                                <td className="font-mono text-xs">{r.Material_Number}</td>
                                <td className="text-success font-medium">{fmt(r.total)}</td>
                                <td>{r.records}</td>
                                {hasPlants && (
                                  <td className="py-1.5">
                                    {r.by_plant && Object.keys(r.by_plant).length > 0
                                      ? <PlantMiniBar byPlant={r.by_plant} />
                                      : <span className="text-slate-300 text-xs">—</span>
                                    }
                                  </td>
                                )}
                              </tr>
                            ))}
                        </tbody>
                      </table>
                    </div>
                  : <p className="text-xs text-slate-400 italic">No favorable components.</p>}
                <p className="text-[11px] text-slate-400 mt-2">
                  Note: this list shows only the top 10 favorable materials in the selected group. The Selected Group amount is the net PPV of all materials (favorable + unfavorable) in that group.
                </p>
              </div>

            </div>
          )}

          {trendD && trendD.labels.length >= 2 && (
            <div>
              <p className="section-title">Group PPV Trend with 2σ Bands</p>
              <LineChart
                labels={trendD.labels}
                height={240}
                series={[
                  { label: 'Net PPV',   values: trendD.values,     color: '#1d4ed8', width: 2 },
                  { label: 'Trend',     values: trendD.trend_line, color: '#7c3aed', width: 1.5, dash: [6, 3] },
                  { label: 'Upper 2σ',  values: trendD.upper2s,    color: '#f97316', width: 1, dash: [4, 3] },
                  { label: 'Lower 2σ',  values: trendD.lower2s,    color: '#3b82f6', width: 1, dash: [4, 3], fill: '#3b82f610' },
                ]}
              />
            </div>
          )}
        </div>
      )}

      {/* ── Recommendation drilldown modal ── */}
      {drillRec && (
        <MGRecDrillModal
          group={drillRec.group}
          loserPlant={drillRec.loser.plant}
          winnerPlant={drillRec.winner.plant}
          loserValue={drillRec.loser.value}
          winnerValue={drillRec.winner.value}
          gap={drillRec.gap}
          onClose={() => setDrillRec(null)}
        />
      )}
    </div>
  )
}
