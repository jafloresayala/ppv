// src/tabs/TabSearch.tsx
import { useState, useRef } from 'react'
import { Search } from 'lucide-react'
import LineChart from '../components/charts/LineChart'
import HBarChart from '../components/charts/HBarChart'
import { usePPV } from '../store/ppvStore'

const fmt = (v: number) => `$${v.toLocaleString(undefined, { minimumFractionDigits: 2 })}`

export default function TabSearch() {
  const { search, searchResult, searchLoading } = usePPV()
  const [q, setQ] = useState('')
  const inputRef  = useRef<HTMLInputElement>(null)

  const handleSearch = () => { if (q.trim()) search(q.trim()) }

  const r = searchResult

  return (
    <div className="fade-in flex flex-col gap-5">
      <div className="card-p">
        <p className="section-title">Search Material / Part Number</p>
        <div className="flex gap-3 items-center">
          <input
            ref={inputRef}
            className="input-field flex-1"
            placeholder="Enter material number or partial name…"
            value={q}
            onChange={e => setQ(e.target.value)}
            onKeyDown={e => e.key === 'Enter' && handleSearch()}
          />
          <button className="btn-primary flex items-center gap-2" onClick={handleSearch} disabled={searchLoading || !q.trim()}>
            {searchLoading ? <span className="animate-spin">⏳</span> : <Search size={16} />}
            {searchLoading ? 'Searching…' : 'Search'}
          </button>
        </div>
      </div>

      {searchLoading && (
        <div className="card-p flex flex-col gap-3">
          <div className="skeleton h-4 w-1/3" />
          <div className="skeleton h-40 rounded-xl" />
        </div>
      )}

      {r && !searchLoading && (
        r.found === false
          ? <div className="card-p text-center py-10">
              <p className="text-slate-400 text-lg">No material found for <strong>{r.query}</strong></p>
              <p className="text-sm text-slate-400 mt-1">Try a partial match or check the part number.</p>
            </div>
          : <div className="flex flex-col gap-5 fade-in">
              {/* KPI row */}
              <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-5 gap-3">
                {[
                  { label: 'Net PPV',      val: fmt(r.kpis?.total ?? 0),       cls: (r.kpis?.total ?? 0) <= 0 ? 'text-success' : 'text-danger' },
                  { label: 'Favorable',    val: fmt(r.kpis?.favorable ?? 0),   cls: 'text-success' },
                  { label: 'Unfavorable',  val: fmt(r.kpis?.unfavorable ?? 0), cls: 'text-danger' },
                  { label: 'Records',      val: String(r.kpis?.records ?? 0),  cls: '' },
                  { label: 'Avg / Record', val: fmt(r.kpis?.average ?? 0),     cls: '' },
                ].map(k => (
                  <div key={k.label} className="kpi-card">
                    <p className="kpi-label">{k.label}</p>
                    <p className={`kpi-value ${k.cls}`}>{k.val}</p>
                  </div>
                ))}
              </div>

              {/* Trend + by vendor */}
              <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
                {r.trend && r.trend.labels?.length >= 2 && (
                  <div className="card-p">
                    <p className="section-title">PPV Trend</p>
                    <LineChart labels={r.trend.labels} height={220} series={[
                      { label: 'Net PPV', values: r.trend.values, color: '#1d4ed8', width: 2 }
                    ]} />
                  </div>
                )}
                {r.by_vendor && r.by_vendor.length > 0 && (
                  <div className="card-p">
                    <p className="section-title">PPV by Vendor</p>
                    <HBarChart
                      data={r.by_vendor.slice(0, 10).map((v: any) => ({ label: v.name, value: v.total }))}
                      height={280}
                    />
                  </div>
                )}
              </div>

              {/* ANOVA */}
              {r.anova && (
                <div className={`card-p border-l-4 ${r.anova.significant ? 'border-warning' : 'border-success'}`}>
                  <p className="section-title">ANOVA — Vendor PPV Comparison</p>
                  <div className="flex gap-8 flex-wrap mt-2">
                    <div>
                      <p className="text-xs text-slate-500">F-Statistic</p>
                      <p className="text-xl font-bold">{r.anova.f_stat.toFixed(3)}</p>
                    </div>
                    <div>
                      <p className="text-xs text-slate-500">p-Value</p>
                      <p className={`text-xl font-bold ${r.anova.p_value < 0.05 ? 'text-warning' : 'text-success'}`}>
                        {r.anova.p_value < 0.001 ? '< 0.001' : r.anova.p_value.toFixed(4)}
                      </p>
                    </div>
                    <div className="flex items-center">
                      <span className={`px-4 py-2 rounded-full font-semibold text-sm ${r.anova.significant ? 'bg-amber-100 text-amber-700' : 'bg-green-100 text-green-700'}`}>
                        {r.anova.significant ? '⚠ Significant vendor price differences detected' : '✅ No significant vendor differences'}
                      </span>
                    </div>
                  </div>
                </div>
              )}

              {/* Price outliers */}
              {r.price_outliers && Object.keys(r.price_outliers).length > 0 && (
                <div className="card-p overflow-x-auto">
                  <p className="section-title">Price Outlier Transactions</p>
                  <table className="tbl">
                    <thead><tr><th>Material</th><th>Outlier Records</th></tr></thead>
                    <tbody>
                      {Object.entries(r.price_outliers).map(([mat, flags]) => (
                        <tr key={mat}>
                          <td className="font-mono text-xs">{mat}</td>
                          <td>{(flags as boolean[]).filter(Boolean).length}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
      )}
    </div>
  )
}
