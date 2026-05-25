// src/tabs/TabImpact.tsx
import { useState, useEffect } from 'react'
import * as XLSX from 'xlsx'
import ForecastChart from '../components/charts/ForecastChart'
import { usePPV } from '../store/ppvStore'
import { getSourcing } from '../api/client'
import type { SourcingResult } from '../types/api.types'

const fmt = (v: number) => v.toLocaleString('en-US', { style: 'currency', currency: 'USD', minimumFractionDigits: 2, maximumFractionDigits: 2 })

const MODEL_DOCS: Record<string, string> = {
  'SARIMA':        'https://www.statsmodels.org/stable/generated/statsmodels.tsa.statespace.sarimax.SARIMAX.html',
  'Holt-Winters':  'https://www.statsmodels.org/stable/generated/statsmodels.tsa.holtwinters.ExponentialSmoothing.html',
  'Holt Linear':   'https://www.statsmodels.org/stable/generated/statsmodels.tsa.holtwinters.Holt.html',
  'Exp Smoothing': 'https://www.statsmodels.org/stable/generated/statsmodels.tsa.holtwinters.SimpleExpSmoothing.html',
  'Ridge Lags':    'https://scikit-learn.org/stable/modules/generated/sklearn.linear_model.Ridge.html',
  'Gradient Boost':'https://scikit-learn.org/stable/modules/generated/sklearn.ensemble.GradientBoostingRegressor.html',
  'Prophet':       'https://facebook.github.io/prophet/docs/quick_start.html',
}

// Run `limit` promises at a time from an array of async tasks
async function pLimit<T>(tasks: (() => Promise<T>)[], limit: number): Promise<PromiseSettledResult<T>[]> {
  const results: PromiseSettledResult<T>[] = []
  let i = 0
  async function runNext(): Promise<void> {
    const idx = i++
    if (idx >= tasks.length) return
    try {
      results[idx] = { status: 'fulfilled', value: await tasks[idx]() }
    } catch (e) {
      results[idx] = { status: 'rejected', reason: e }
    }
    await runNext()
  }
  await Promise.all(Array.from({ length: Math.min(limit, tasks.length) }, runNext))
  return results
}

export default function TabImpact() {
  const { analytics, forecast, forecastLoading, loadForecast } = usePPV()
  const impact  = analytics?.impact_scatter
  const [scale, setScale]             = useState<'log' | 'minmax' | 'robust'>('log')
  const [scaleLoaded, setScaleLoaded] = useState(false)
  const [drillZone, setDrillZone]     = useState<'pos' | 'neg' | null>(null)

  // Sourcing search state
  const [searchStatus, setSearchStatus]   = useState<'idle' | 'loading' | 'done'>('idle')
  const [searchProgress, setSearchProgress] = useState({ done: 0, total: 0 })
  const [sourcingMap, setSourcingMap]     = useState<Record<string, SourcingResult>>({})

  const handleForecast = async (s: typeof scale) => {
    setScale(s); await loadForecast(s); setScaleLoaded(true)
  }

  // Auto-run forecast when analytics loads (only if not already run)
  useEffect(() => {
    if (analytics && !forecast && !forecastLoading) {
      handleForecast(scale)
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [analytics])

  const posItems = (impact ?? []).filter(p => p.zone === 'outlier_pos')
  const negItems = (impact ?? []).filter(p => p.zone === 'outlier_neg')
  const posTotal = posItems.reduce((s, p) => s + p.total, 0)
  const negTotal = negItems.reduce((s, p) => s + p.total, 0)
  const totalShown = (impact ?? []).length

  const drillItems = drillZone === 'pos' ? posItems : negItems
  const sortedDrill = drillItems.slice().sort((a, b) => Math.abs(b.total) - Math.abs(a.total))
  const drillTitle  = drillZone === 'pos' ? '🔴 Cost Drivers — High PPV Materials' : '🟢 Savings Drivers — Low PPV Materials'
  const drillAccent = drillZone === 'pos' ? 'bg-red-700' : 'bg-green-700'
  const drillColor  = drillZone === 'pos' ? 'text-danger' : 'text-success'

  function closeModal() {
    setDrillZone(null)
    setSearchStatus('idle')
    setSearchProgress({ done: 0, total: 0 })
    setSourcingMap({})
  }

  async function handleFindBestPrices() {
    setSearchStatus('loading')
    setSearchProgress({ done: 0, total: sortedDrill.length })
    setSourcingMap({})
    let done = 0
    const tasks = sortedDrill.map(item => async () => {
      const result = await getSourcing(item.number)
      done++
      setSearchProgress({ done, total: sortedDrill.length })
      setSourcingMap(prev => ({ ...prev, [item.number]: result }))
      return result
    })
    await pLimit(tasks, 5)
    setSearchStatus('done')
  }

  function handleExcel() {
    const rows = sortedDrill.map(item => {
      const s = sourcingMap[item.number]
      const best = s?.recommendation === 'Market' ? s.market : s?.recommendation === 'SAP' ? s.sap : null
      return {
        'Material Number':   item.number,
        'Description':       item.desc ?? '',
        'PPV Total (USD)':   item.total,
        'Avg / Record (USD)': item.avg,
        'Records':           item.records,
        'MPN':               s?.mpns?.join(', ') ?? '',
        'Manufacturer':      best?.manufacturer ?? '',
        'Best Source':       s?.recommendation ?? '',
        'Unit Price (USD)':  best?.unit_price_usd ?? '',
        'Supplier / Seller': best?.seller ?? best?.supplier ?? '',
        'Link':              s?.recommendation === 'Market' ? (s.market?.click_url ?? '') : '',
      }
    })
    const ws = XLSX.utils.json_to_sheet(rows)
    const wb = XLSX.utils.book_new()
    XLSX.utils.book_append_sheet(wb, ws, 'Best Options')
    const zone = drillZone === 'pos' ? 'CostDrivers' : 'SavingsDrivers'
    XLSX.writeFile(wb, `PPV_BestOptions_${zone}_${new Date().toISOString().slice(0,10)}.xlsx`)
  }

  return (
    <>
    <div className="fade-in flex flex-col gap-5">

      {/* Context note */}
      <p className="text-xs text-slate-400">
        Showing the top <strong>{totalShown}</strong> materials ranked by absolute PPV impact.
        Materials above the 95th percentile are <span className="text-danger font-semibold">Cost Drivers</span>;
        below the 5th percentile are <span className="text-success font-semibold">Savings Drivers</span>.
        The remaining {totalShown === 0 ? 0 : totalShown - posItems.length - negItems.length} materials
        in this selection fall within the normal range.
      </p>

      {/* Summary cards — only pos and neg */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <button
          className="card-p bg-red-50 border border-red-200 text-left hover:shadow-md hover:border-red-400 transition-all cursor-pointer"
          onClick={() => setDrillZone('pos')}
        >
          <p className="text-xs font-semibold text-danger uppercase tracking-wide mb-1">🔴 Cost Drivers (High PPV)</p>
          <p className="text-2xl font-bold text-danger">{fmt(posTotal)}</p>
          <p className="text-sm text-slate-500 mt-1">
            <span className="font-semibold text-slate-700">{posItems.length}</span> materials with unusually high price variance
          </p>
          <p className="text-[11px] text-slate-400 mt-0.5">These are pushing your PPV cost up · <span className="underline">Click to see details</span></p>
        </button>
        <button
          className="card-p bg-green-50 border border-green-200 text-left hover:shadow-md hover:border-green-400 transition-all cursor-pointer"
          onClick={() => setDrillZone('neg')}
        >
          <p className="text-xs font-semibold text-success uppercase tracking-wide mb-1">🟢 Savings Drivers (Low PPV)</p>
          <p className="text-2xl font-bold text-success">{fmt(negTotal)}</p>
          <p className="text-sm text-slate-500 mt-1">
            <span className="font-semibold text-slate-700">{negItems.length}</span> materials with unusually low price variance
          </p>
          <p className="text-[11px] text-slate-400 mt-0.5">These are helping reduce your PPV cost · <span className="underline">Click to see details</span></p>
        </button>
      </div>

      {/* Forecast */}
      <div className="card-p">
        <p className="section-title">PPV Forecasting</p>
        <div className="flex gap-2 items-center flex-wrap mb-4">
          <span className="text-xs text-slate-500">Scale method:</span>
          {(['log', 'minmax', 'robust'] as const).map(s => (
            <button key={s} onClick={() => handleForecast(s)}
              className={scale === s && scaleLoaded ? 'tab-btn-active' : 'tab-btn-inactive'}>
              {s.charAt(0).toUpperCase() + s.slice(1)}
            </button>
          ))}
          {forecastLoading && (
            <span className="text-xs text-slate-400 animate-pulse ml-2">⏳ Running forecast…</span>
          )}
        </div>

        {forecastLoading && <div className="skeleton h-64 rounded-xl" />}

        {!forecastLoading && forecast && (
          <>
            {!forecast.available
              ? <p className="text-sm text-slate-400 italic">Not enough data points to forecast (need ≥ 12 months).</p>
              : <>
                  <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-4">
                    <div className="card-p bg-slate-50">
                      <p className="text-xs text-slate-500">Best Model</p>
                      <div className="flex items-center gap-2 flex-wrap mt-0.5">
                        <p className="font-bold text-brand">{forecast.best_model}</p>
                        {MODEL_DOCS[forecast.best_model] && (
                          <a
                            href={MODEL_DOCS[forecast.best_model]}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="inline-flex items-center gap-1 text-[10px] font-semibold px-1.5 py-0.5 rounded bg-brand/10 text-brand hover:bg-brand/20 transition-colors whitespace-nowrap"
                          >
                            📖 Docs
                          </a>
                        )}
                      </div>
                    </div>
                    <div className="card-p bg-slate-50"><p className="text-xs text-slate-500">Train / Test</p><p className="font-bold">{forecast.n_train} / {forecast.n_test} months</p></div>
                  </div>
                  <ForecastChart data={forecast} height={340} />
                  <div className="overflow-x-auto mt-4">
                    <table className="tbl">
                      <thead><tr><th>Model</th><th>MASE</th><th>RMSE</th><th>MAE</th><th>Best?</th><th>Docs</th></tr></thead>
                      <tbody>
                        {(forecast.models ?? []).map(m => (
                          <tr key={m.model} className={m.model === forecast.best_model ? 'bg-brand/10' : ''}>
                            <td className="font-medium">{m.model}</td>
                            <td className={m.mase <= 1 ? 'text-success font-semibold' : 'text-danger'}>{m.mase.toFixed(3)}</td>
                            <td>{m.forecast?.length ?? 0} pts</td>
                            <td>—</td>
                            <td>{m.model === forecast.best_model ? '🏆 Best' : ''}</td>
                            <td>
                              {MODEL_DOCS[m.model] && (
                                <a
                                  href={MODEL_DOCS[m.model]}
                                  target="_blank"
                                  rel="noopener noreferrer"
                                  className="inline-flex items-center gap-1 text-[10px] font-semibold text-brand hover:underline whitespace-nowrap"
                                >
                                  📖 Docs
                                </a>
                              )}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>

                  {/* ── Priority Components to Attack ── */}
                  {posItems.length > 0 && (() => {
                    const sortedPos = posItems.slice().sort((a, b) => b.total - a.total)
                    return (
                      <div className="mt-6">
                        <div className="flex items-center gap-2 mb-3">
                          <div className="h-4 w-1 rounded-full bg-red-500" />
                          <p className="text-sm font-bold text-slate-700">Priority Components to Attack</p>
                          <span className="text-xs text-slate-400">— tackle these to improve the PPV trend</span>
                        </div>
                        <div className="overflow-x-auto rounded-lg border border-red-100">
                          <table className="tbl text-xs">
                            <thead>
                              <tr><th>#</th><th>Material</th><th>Description</th><th>PPV Impact</th><th>Avg/Record</th><th>Records</th><th>Priority</th></tr>
                            </thead>
                            <tbody>
                              {sortedPos.map((item, i) => {
                                const pct = Math.abs(posTotal) > 0 ? Math.abs(item.total) / Math.abs(posTotal) * 100 : 0
                                const [priority, pillCls] =
                                  pct > 20 ? ['Critical', 'bg-red-100 text-red-700'] :
                                  pct > 10 ? ['High',     'bg-orange-100 text-orange-700'] :
                                  pct > 5  ? ['Medium',   'bg-amber-100 text-amber-700'] :
                                             ['Low',      'bg-slate-100 text-slate-600']
                                return (
                                  <tr key={item.number} className={i < 3 ? 'bg-red-50/40' : ''}>
                                    <td className="text-slate-400">{i + 1}</td>
                                    <td className="font-mono">{item.number}</td>
                                    <td className="text-slate-500 max-w-[200px] truncate" title={item.desc ?? ''}>{item.desc ?? '—'}</td>
                                    <td className="text-danger font-semibold">{fmt(item.total)}</td>
                                    <td className="text-slate-500">{fmt(item.avg)}</td>
                                    <td className="text-slate-400">{item.records}</td>
                                    <td><span className={`text-[10px] font-bold px-2 py-0.5 rounded-full ${pillCls}`}>{priority}</span></td>
                                  </tr>
                                )
                              })}
                            </tbody>
                          </table>
                        </div>
                        <p className="text-[11px] text-slate-400 mt-2 italic">
                          💡 Reducing the purchase price of these materials will have the most direct impact on reversing the upward PPV trend.
                        </p>
                      </div>
                    )
                  })()}
                </>}
          </>
        )}
      </div>
    </div>

      {/* ── Drill-down floating modal ─────────────────────────────────────── */}
      {drillZone && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm"
          onClick={closeModal}
        >
          <div
            className="bg-white rounded-2xl shadow-2xl w-full max-w-4xl mx-4 max-h-[92vh] flex flex-col"
            onClick={e => e.stopPropagation()}
          >
            {/* Header */}
            <div className={`${drillAccent} text-white px-6 py-4 shrink-0 rounded-t-2xl`}>
              <div className="flex items-start justify-between gap-3">
                <div>
                  <p className="text-[10px] font-semibold opacity-70 uppercase tracking-widest">Impact Analysis</p>
                  <h2 className="text-lg font-bold">{drillTitle}</h2>
                </div>
                <div className="flex items-center gap-2">
                  {/* Find Best Prices */}
                  {searchStatus !== 'done' && (
                    <button
                      disabled={searchStatus === 'loading'}
                      onClick={handleFindBestPrices}
                      className="px-3 py-1.5 rounded-lg bg-white/20 hover:bg-white/30 disabled:opacity-60 disabled:cursor-wait text-xs font-semibold transition-colors whitespace-nowrap"
                    >
                      {searchStatus === 'loading'
                        ? `⏳ Searching… ${searchProgress.done}/${searchProgress.total}`
                        : '🔍 Find Best Prices'}
                    </button>
                  )}
                  {/* Download Excel */}
                  {searchStatus === 'done' && (
                    <button
                      onClick={handleExcel}
                      className="px-3 py-1.5 rounded-lg bg-white/20 hover:bg-white/30 text-xs font-semibold transition-colors whitespace-nowrap"
                    >
                      📥 Download Excel
                    </button>
                  )}
                  <button
                    className="w-8 h-8 rounded-full bg-white/20 hover:bg-white/30 flex items-center justify-center transition-colors"
                    onClick={closeModal}
                  >✕</button>
                </div>
              </div>

              {/* Progress bar */}
              {searchStatus === 'loading' && (
                <div className="mt-3 h-1.5 bg-white/20 rounded-full overflow-hidden">
                  <div
                    className="h-full bg-white rounded-full transition-all duration-300"
                    style={{ width: `${searchProgress.total ? (searchProgress.done / searchProgress.total) * 100 : 0}%` }}
                  />
                </div>
              )}
            </div>

            {/* Body */}
            <div className="flex-1 overflow-y-auto">
              <table className="tbl text-xs w-full">
                <thead className="sticky top-0 bg-white z-10">
                  <tr>
                    <th>#</th>
                    <th>Material</th>
                    <th>Description</th>
                    <th>PPV Total</th>
                    <th>Avg / Rec.</th>
                    <th>Recs.</th>
                    {searchStatus !== 'idle' && <>
                      <th>MPN</th>
                      <th>Manufacturer</th>
                      <th>Unit Price</th>
                      <th>Supplier / Link</th>
                    </>}
                  </tr>
                </thead>
                <tbody>
                  {sortedDrill.map((p, i) => {
                    const s = sourcingMap[p.number]
                    const best = s?.recommendation === 'Market' ? s.market : s?.recommendation === 'SAP' ? s.sap : null
                    return (
                      <tr key={p.number}>
                        <td className="text-slate-400">{i + 1}</td>
                        <td className="font-mono">{p.number}</td>
                        <td className="text-slate-500 max-w-[160px] truncate">{p.desc ?? '—'}</td>
                        <td className={`font-semibold ${drillColor}`}>{fmt(p.total)}</td>
                        <td className="text-slate-500">{fmt(p.avg)}</td>
                        <td>{p.records}</td>
                        {searchStatus !== 'idle' && <>
                          {s === undefined ? (
                            <td colSpan={4} className="text-slate-300 italic text-center">
                              {searchStatus === 'loading' ? '…' : '—'}
                            </td>
                          ) : s.recommendation === 'No data' ? (
                            <td colSpan={4} className="text-slate-400 italic">No sourcing data</td>
                          ) : (
                            <>
                              <td className="font-mono text-slate-600">{s.mpns?.[0] ?? best?.mpn ?? '—'}</td>
                              <td className="text-slate-600">{best?.manufacturer ?? '—'}</td>
                              <td className="font-semibold text-brand">
                                {best?.unit_price_usd != null ? fmt(best.unit_price_usd) : '—'}
                              </td>
                              <td>
                                {s.recommendation === 'Market' && s.market?.click_url
                                  ? <a
                                      href={s.market.click_url}
                                      target="_blank"
                                      rel="noopener noreferrer"
                                      className="text-blue-600 underline hover:text-blue-800 truncate block max-w-[120px]"
                                      title={s.market.seller ?? s.market.click_url}
                                    >
                                      {s.market.seller ?? 'View'}
                                    </a>
                                  : <span className="text-slate-500">{best?.supplier ?? best?.seller ?? '—'}</span>
                                }
                              </td>
                            </>
                          )}
                        </>}
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>

            {/* Footer */}
            <div className="px-6 py-3 border-t border-slate-100 text-xs text-slate-400 shrink-0 flex items-center justify-between">
              <span>{sortedDrill.length} materials · sorted by absolute PPV impact</span>
              {searchStatus === 'done' && (
                <span className="text-green-600 font-semibold">
                  ✓ Sourcing data loaded — click 📥 Download Excel to export
                </span>
              )}
            </div>
          </div>
        </div>
      )}
    </>
  )
}
