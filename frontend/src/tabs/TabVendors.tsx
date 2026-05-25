// src/tabs/TabVendors.tsx
import { useState, useEffect, useCallback } from 'react'
import { X } from 'lucide-react'
import HBarChart from '../components/charts/HBarChart'
import ScatterPlot from '../components/charts/ScatterPlot'
import LineChart from '../components/charts/LineChart'
import { usePPV } from '../store/ppvStore'
import { PlantBadges } from '../utils/plants'

const fmt      = (v: number) => `$${v.toLocaleString(undefined, { minimumFractionDigits: 2 })}`
const fmtUnit  = (v: number) => '$' + v.toLocaleString('en-US', { minimumFractionDigits: 6, maximumFractionDigits: 6 })
const fmtTotal = (v: number) => '$' + v.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })

interface SapRow {
  site: string; mpn: string; manufacturer: string
  supplier: string; supplier_number: string
  last_po_usd: number; standard_usd: number | null
  currency: string; last_po_date: string
}
interface MarketRow {
  mpn: string; manufacturer: string; description: string; seller: string
  unit_price_usd: number; total_price_usd: number
  inventory: number; moq: number; effective_qty: number; requires_moq: boolean; can_fulfill: boolean
  packaging: string; click_url: string
}
interface SourcingResult {
  sap:        { site: string; supplier: string; unit_price_usd: number; last_po_date: string } | null
  sap_all:    SapRow[]
  market:     { seller: string; unit_price_usd: number; inventory: number; click_url: string; requires_moq: boolean; moq: number; effective_qty: number } | null
  market_all: MarketRow[]
  recommendation: 'SAP' | 'Market' | 'No data'
  diff_pct: number | null
  mpns: string[]
}
type SourcingCell = 'loading' | 'error' | SourcingResult

export default function TabVendors() {
  const { analytics, sessionId } = usePPV()
  const vd = analytics?.vendors
  const [selected, setSelected] = useState<string | null>(null)
  const [quantity,  setQuantity]  = useState(1000)
  const [rowQty,    setRowQty]    = useState<Record<string, number>>({})
  const [sourcing,  setSourcing]  = useState<Record<string, SourcingCell>>({})
  const [detailMaterial, setDetailMaterial] = useState<string | null>(null)
  const [selectedSapRow, setSelectedSapRow] = useState<SapRow | null>(null)
  const [selectedMarketRow, setSelectedMarketRow] = useState<MarketRow | null>(null)

  // Month records modal
  const [monthModal, setMonthModal] = useState<{
    vendor: string; month: string; records: any[]; columns: string[]; loading: boolean
  } | null>(null)

  async function openMonthModal(vendor: string, month: string) {
    setMonthModal({ vendor, month, records: [], columns: [], loading: true })
    try {
      const res  = await fetch('/api/vendor-month', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ session_id: sessionId, vendor, yearmonth: month }),
      })
      const data = await res.json()
      setMonthModal({ vendor, month, records: data.records, columns: data.columns, loading: false })
    } catch {
      setMonthModal({ vendor, month, records: [], columns: [], loading: false })
    }
  }

  // Vendor price trend state
  const [vendorTrend, setVendorTrend] = useState<{
    labels: string[]
    vendors: { name: string; po_price: (number | null)[] }[]
  } | null>(null)
  const [vendorTrendLoading, setVendorTrendLoading] = useState(false)
  const [showVendorTrend, setShowVendorTrend] = useState(false)

  // Reset everything when vendor changes
  useEffect(() => { setSourcing({}); setRowQty({}); setDetailMaterial(null) }, [selected])
  useEffect(() => { setSelectedSapRow(null); setSelectedMarketRow(null) }, [detailMaterial])

  // Fetch vendor price trend whenever detailMaterial changes
  useEffect(() => {
    if (!detailMaterial || !sessionId) { setVendorTrend(null); setShowVendorTrend(false); return }
    setVendorTrendLoading(true)
    setShowVendorTrend(true)
    setVendorTrend(null)
    fetch('/api/vendor-price-trend', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ session_id: sessionId, material_number: detailMaterial, filters: {} }),
    })
      .then(r => r.json())
      .then(data => { setVendorTrend(data); setVendorTrendLoading(false) })
      .catch(() => setVendorTrendLoading(false))
  }, [detailMaterial, sessionId])

  const fetchSourcing = useCallback(async (material: string, qty: number) => {
    setSourcing(prev => ({ ...prev, [material]: 'loading' }))
    try {
      const res = await fetch('/api/sourcing', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ material, quantity: qty }),
      })
      if (!res.ok) throw new Error()
      const data = await res.json() as SourcingResult
      setSourcing(prev => ({ ...prev, [material]: data }))
    } catch {
      setSourcing(prev => ({ ...prev, [material]: 'error' }))
    }
  }, [])

  // Auto-fetch all materials when vendor or global quantity changes
  useEffect(() => {
    const drill = selected ? vd?.drilldown?.[selected] : null
    if (!drill?.by_material?.length) return
    drill.by_material
      .filter((r: any) => r.total > 0)
      .forEach((r: any) => fetchSourcing(r.material, quantity))
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selected, quantity])

  if (!vd?.vendors.length)
    return <p className="text-sm text-slate-400 italic">No vendor data available.</p>

  const barItems = vd.vendors.slice(0, 15).map(v => ({ label: v.name, value: v.total }))
  const drill = selected ? (vd.drilldown[selected] as any) ?? null : null

  return (
    <div className="fade-in flex flex-col gap-5">
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <div className="card-p">
          <p className="section-title">Top 15 Vendors by PPV Impact</p>
          <HBarChart
            data={barItems}
            height={440}
            selected={selected}
            onSelect={item => setSelected(item ? item.label : null)}
          />
          <p className="text-xs text-slate-400 mt-1">Click a bar to drill down ↓</p>
        </div>
        <div className="card-p">
          <p className="section-title">Vendor Scatter — Records vs. PPV</p>
          <p className="text-xs text-slate-400 mb-2">KNN decision regions: 🟢 Favorable zone | 🔴 Unfavorable zone</p>
          <ScatterPlot
            vendors={vd.vendors}
            knnGrid={vd.knn_grid ?? null}
            selected={selected}
            onSelect={setSelected}
            height={380}
          />
        </div>
      </div>

      {/* Vendor summary table */}
      <div className="card-p overflow-x-auto">
        <p className="section-title">All Vendors Summary</p>
        <table className="tbl">
          <thead>
            <tr><th>Vendor</th><th>Code</th><th>PPV Total</th><th>Records</th><th>Avg PPV</th><th>Plants</th></tr>
          </thead>
          <tbody>
            {vd.vendors.map(v => (
              <tr
                key={v.code || v.name}
                className={selected === v.name ? 'bg-brand/10 cursor-pointer' : 'cursor-pointer hover:bg-slate-50'}
                onClick={() => setSelected(selected === v.name ? null : v.name)}
              >
                <td className="font-medium text-sm">{v.name}</td>
                <td className="font-mono text-xs text-slate-500">{v.code}</td>
                <td className={v.total <= 0 ? 'text-success font-semibold' : 'text-danger font-semibold'}>{fmt(v.total)}</td>
                <td>{v.records}</td>
                <td className={v.average <= 0 ? 'text-success' : 'text-danger'}>{fmt(v.average)}</td>
                <td><PlantBadges plants={v.plants} /></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {selected && drill && (
        <div className="card-p border-l-4 border-brand fade-in flex flex-col gap-4">
          <div className="flex items-center justify-between flex-wrap gap-2">
            <div>
              <span className="text-xs text-slate-500 uppercase tracking-wide">Vendor Drill-Down</span>
              <h3 className="text-lg font-bold text-slate-800">{selected}</h3>
            </div>
            <div className="flex gap-3 items-center">
              <span className={`text-sm font-bold ${drill.total <= 0 ? 'text-success' : 'text-danger'}`}>{fmt(drill.total)}</span>
              <span className="badge badge-neutral">{drill.records} records</span>
              <PlantBadges plants={vd.vendors.find(v => v.name === selected)?.plants} />
              <button className="btn-ghost text-xs" onClick={() => setSelected(null)}>✕ Clear</button>
            </div>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
            <div className="card-p bg-slate-50">
              <p className="text-xs text-slate-500">Materials Purchased</p>
              <p className="text-2xl font-bold">{drill.material_count}</p>
            </div>
            <div className="card-p bg-slate-50">
              <p className="text-xs text-slate-500">Avg PPV / Record</p>
              <p className={`text-2xl font-bold ${drill.avg_per_record <= 0 ? 'text-success' : 'text-danger'}`}>
                {fmt(drill.avg_per_record)}
              </p>
            </div>
            <div className="card-p bg-slate-50">
              <p className="text-xs text-slate-500">Worst Month</p>
              <p className="text-xl font-bold">{drill.worst_month ?? '—'}</p>
            </div>
          </div>

          {drill.trend && drill.trend.labels.length >= 2 && (
            <div>
              <p className="section-title">Monthly Trend for {selected}</p>
              <p className="text-xs text-slate-400 mb-1">Click a point to see that month's records</p>
              <LineChart
                labels={drill.trend.labels}
                height={220}
                series={[{ label: 'Monthly PPV', values: drill.trend.values, color: '#1d4ed8', width: 2 }]}
                onClickPoint={(label) => openMonthModal(selected, label)}
              />
            </div>
          )}

          {drill.by_material?.length > 0 && (
            <div className="flex flex-col gap-4">
              <div>
                <p className="section-title">Material PPV Impact — {selected}</p>
                <HBarChart
                  data={drill.by_material.map((r: any) => ({
                    label: r.description && r.description !== r.material
                      ? `${r.material} · ${String(r.description).slice(0, 32)}`
                      : String(r.material),
                    value: r.total,
                  }))}
                  height={Math.min(520, Math.max(180, drill.by_material.length * 28 + 50))}
                />
              </div>
                <div className="overflow-x-auto">
                <div className="flex items-center justify-between mb-2 flex-wrap gap-2">
                  <p className="text-sm font-semibold">Material Detail</p>
                  <div className="flex items-center gap-2 text-xs">
                    <label className="text-slate-500">Default qty:</label>
                    <input
                      type="number" min={1} value={quantity}
                      onChange={e => { setQuantity(Math.max(1, Number(e.target.value))); setSourcing({}); setRowQty({}) }}
                      className="border border-slate-300 rounded px-2 py-0.5 w-20 text-xs"
                    />
                  </div>
                </div>
                <table className="tbl">
                  <thead><tr><th>Material</th><th>Description</th><th>PPV Total</th><th>Records</th><th>Qty</th><th>Best Option</th><th className="text-right">Total</th></tr></thead>
                  <tbody>
                    {drill.by_material.filter((r: any) => r.total > 0).map((r: any) => {
                      const s = sourcing[r.material]
                      const effQty = rowQty[r.material] ?? quantity
                      return (
                        <tr key={r.material} className="cursor-pointer hover:bg-slate-50" onClick={() => setDetailMaterial(r.material)}>
                          <td className="font-mono text-xs">{r.material}</td>
                          <td className="text-xs text-slate-500">{r.description ?? '—'}</td>
                          <td className={r.total <= 0 ? 'text-success font-medium' : 'text-danger font-medium'}>{fmt(r.total)}</td>
                          <td>{r.records}</td>
                          <td onClick={e => e.stopPropagation()}>
                            <input
                              type="number" min={1}
                              value={effQty}
                              onChange={e => {
                                const q = Math.max(1, Number(e.target.value))
                                setRowQty(prev => ({ ...prev, [r.material]: q }))
                                fetchSourcing(r.material, q)
                              }}
                              className="border border-slate-300 rounded px-1 py-0.5 w-20 text-xs"
                            />
                          </td>
                          <td className="min-w-[150px]">
                            {s === 'loading' && (
                              <span className="text-xs text-slate-400 animate-pulse">Loading…</span>
                            )}
                            {s === 'error' && (
                              <button onClick={e => { e.stopPropagation(); fetchSourcing(r.material, effQty) }} className="text-xs text-red-500 underline">Error — retry</button>
                            )}
                            {s && s !== 'loading' && s !== 'error' && (() => {
                              const res = s as SourcingResult
                              if (res.recommendation === 'No data')
                                return <span className="text-xs text-slate-400">No data</span>
                              const isSAP = res.recommendation === 'SAP'
                              const price = isSAP ? res.sap?.unit_price_usd : res.market?.unit_price_usd
                              const who   = isSAP ? res.sap?.supplier : res.market?.seller
                              const site  = isSAP ? res.sap?.site : (res.market?.inventory ? `Stock: ${res.market.inventory.toLocaleString()}` : null)
                              return (
                                <div className="text-xs flex flex-col gap-0.5">
                                  <span className={`font-semibold ${isSAP ? 'text-slate-800' : 'text-blue-700'}`}>
                                    {res.recommendation} · {price != null ? fmtUnit(price) : '—'}
                                  </span>
                                  {who && <span className="text-slate-500 truncate max-w-[160px]" title={who}>{who}</span>}
                                  {site && <span className="text-slate-400">{site}</span>}
                                  {res.diff_pct != null && !isSAP && (
                                    <span className="text-emerald-600 font-medium">Saves {Math.abs(res.diff_pct).toFixed(1)}% vs SAP</span>
                                  )}
                                  {!isSAP && res.market?.requires_moq && (
                                    <span className="text-amber-600 font-medium">⚠ MOQ: {res.market.moq.toLocaleString()}</span>
                                  )}
                                </div>
                              )
                            })()}
                          </td>
                          <td className="text-right font-mono text-xs">
                            {(() => {
                              if (!s || s === 'loading' || s === 'error') return <span className="text-slate-300">—</span>
                              const res = s as SourcingResult
                              const price = res.recommendation === 'SAP'    ? res.sap?.unit_price_usd
                                          : res.recommendation === 'Market' ? res.market?.unit_price_usd : null
                              if (price == null) return <span className="text-slate-300">—</span>
                              return <span className={res.recommendation === 'Market' ? 'text-blue-700 font-semibold' : 'font-semibold'}>{fmtTotal(price * effQty)}</span>
                            })()}
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
      {/* ── Detail Analysis Drawer ── */}
      {detailMaterial && (() => {
        const sc     = sourcing[detailMaterial]
        const mat    = drill?.by_material?.find((r: any) => r.material === detailMaterial)
        const res    = (sc && sc !== 'loading' && sc !== 'error') ? sc as SourcingResult : null
        const effQty = rowQty[detailMaterial] ?? quantity
        const RANKS  = ['🥇','🥈','🥉','4°','5°','6°','7°','8°','9°','10°']
        return (
          <div className="fixed inset-0 z-50 flex" onClick={() => setDetailMaterial(null)}>
            {/* Backdrop */}
            <div className="flex-1 bg-black/50 backdrop-blur-sm" />

            {/* ── Cost Estimate Panel (outside drawer, to the left) ── */}
            {(selectedSapRow !== null || selectedMarketRow !== null) && (
              <div className="w-72 shrink-0 bg-blue-700 text-white flex flex-col overflow-y-auto shadow-2xl" onClick={e => e.stopPropagation()}>
                <div className="sticky top-0 z-10 flex items-center justify-between px-4 py-3 bg-blue-800">
                  <h3 className="font-bold text-sm">
                    {selectedSapRow ? '🧾 Cost Estimate' : '🛒 Market Offer'}
                  </h3>
                  <button
                    onClick={() => { setSelectedSapRow(null); setSelectedMarketRow(null) }}
                    className="text-blue-200 hover:text-white text-lg leading-none px-1"
                  >✕</button>
                </div>
                <div className="px-4 py-4 flex flex-col gap-4 text-sm">
                  {selectedSapRow && (() => {
                    const row = selectedSapRow
                    const ppvPct = row.standard_usd != null && row.standard_usd > 0
                      ? ((row.last_po_usd - row.standard_usd) / row.standard_usd) * 100
                      : null
                    return (
                      <>
                        <div className="bg-blue-600/60 rounded-xl p-3">
                          <p className="text-blue-200 text-[10px] uppercase tracking-wide mb-2">🏭 Site</p>
                          <p className="font-bold text-white">{row.site}</p>
                          <p className="text-blue-200 text-xs mt-0.5">{row.supplier}</p>
                          <p className="text-blue-300 text-[10px] font-mono mt-0.5">{row.mpn}</p>
                          <p className="text-blue-300 text-[10px]">{row.currency} · {row.last_po_date}</p>
                        </div>
                        <div className="bg-blue-600/60 rounded-xl p-3 space-y-1">
                          <p className="text-blue-200 text-[10px] uppercase tracking-wide mb-1">Unit Price</p>
                          <div className="flex justify-between text-xs">
                            <span className="text-blue-300">Last PO</span>
                            <span className="font-mono font-semibold">{fmtUnit(row.last_po_usd)}</span>
                          </div>
                          {row.standard_usd != null && (
                            <div className="flex justify-between text-xs">
                              <span className="text-blue-300">Standard</span>
                              <span className="font-mono text-blue-100">{fmtUnit(row.standard_usd)}</span>
                            </div>
                          )}
                        </div>
                        <div className="bg-blue-600/60 rounded-xl p-3 space-y-1">
                          <p className="text-blue-200 text-[10px] uppercase tracking-wide mb-1">Total @ {effQty.toLocaleString()} pcs</p>
                          <div className="flex justify-between text-xs">
                            <span className="text-blue-300">Last PO</span>
                            <span className="font-mono font-semibold">{fmtTotal(row.last_po_usd * effQty)}</span>
                          </div>
                          {row.standard_usd != null && (
                            <div className="flex justify-between text-xs">
                              <span className="text-blue-300">Standard</span>
                              <span className="font-mono text-blue-100">{fmtTotal(row.standard_usd * effQty)}</span>
                            </div>
                          )}
                        </div>
                        {ppvPct != null && (
                          <div className="bg-blue-800/80 rounded-xl p-3">
                            <p className="text-blue-200 text-[10px] uppercase tracking-wide mb-1">PPV vs Std</p>
                            <p className={`text-xl font-bold ${ppvPct <= 0 ? 'text-emerald-300' : 'text-red-300'}`}>
                              {ppvPct > 0 ? '+' : ''}{ppvPct.toFixed(1)}%
                            </p>
                            <p className={`font-mono text-xs mt-0.5 ${ppvPct <= 0 ? 'text-emerald-300' : 'text-red-300'}`}>
                              {ppvPct <= 0 ? '↓' : '↑'} {fmtUnit(Math.abs(row.last_po_usd - row.standard_usd!))} / unit
                            </p>
                          </div>
                        )}
                      </>
                    )
                  })()}
                  {selectedMarketRow && (() => {
                    const row = selectedMarketRow
                    const sapPrice = res?.sap?.unit_price_usd ?? null
                    const diffPct = sapPrice != null && sapPrice > 0 ? ((row.unit_price_usd - sapPrice) / sapPrice) * 100 : null
                    const displayQty = row.requires_moq ? row.effective_qty : effQty
                    return (
                      <>
                        <div className="bg-blue-600/60 rounded-xl p-3">
                          <p className="text-blue-200 text-[10px] uppercase tracking-wide mb-2">🛒 Offer</p>
                          <p className="font-bold text-white">{row.seller}</p>
                          <p className="text-blue-200 text-xs mt-0.5">{row.manufacturer}</p>
                          <p className="text-blue-300 text-[10px] font-mono mt-0.5">{row.mpn}</p>
                        </div>
                        <div className="bg-blue-600/60 rounded-xl p-3 space-y-1">
                          <p className="text-blue-200 text-[10px] uppercase tracking-wide mb-1">Unit Price</p>
                          <p className="font-mono font-semibold text-white">{fmtUnit(row.unit_price_usd)}</p>
                          <p className={`text-xs ${row.can_fulfill ? 'text-emerald-300' : 'text-amber-300'}`}>
                            {row.can_fulfill ? `✅ Stock: ${row.inventory.toLocaleString()}` : `⚠ MOQ: ${row.moq.toLocaleString()}`}
                          </p>
                        </div>
                        <div className="bg-blue-600/60 rounded-xl p-3 space-y-1">
                          <p className="text-blue-200 text-[10px] uppercase tracking-wide mb-1">Total @ {displayQty.toLocaleString()} pcs</p>
                          <p className="font-mono font-semibold text-white">{fmtTotal(row.unit_price_usd * displayQty)}</p>
                          {row.requires_moq && <p className="text-amber-300 text-[10px]">MOQ applied</p>}
                        </div>
                        {diffPct != null && (
                          <div className="bg-blue-800/80 rounded-xl p-3">
                            <p className="text-blue-200 text-[10px] uppercase tracking-wide mb-1">vs SAP Best</p>
                            <p className={`text-xl font-bold ${diffPct <= 0 ? 'text-emerald-300' : 'text-red-300'}`}>
                              {diffPct > 0 ? '+' : ''}{diffPct.toFixed(1)}%
                            </p>
                            <p className="text-blue-300 text-xs">{row.packaging}</p>
                          </div>
                        )}
                        {row.click_url && (
                          <a href={row.click_url} target="_blank" rel="noopener noreferrer"
                            className="block text-center bg-blue-500 hover:bg-blue-400 text-white text-xs font-semibold py-2 px-4 rounded-xl transition-colors">
                            View Offer →
                          </a>
                        )}
                      </>
                    )
                  })()}
                </div>
              </div>
            )}

            <div className="w-full max-w-3xl h-screen flex flex-col bg-white shadow-2xl" onClick={e => e.stopPropagation()}>

              {/* ── Sticky header ── */}
              <div className="shrink-0 border-b border-slate-200 bg-white px-6 py-4">
                <div className="flex items-start justify-between gap-4">
                  <div className="min-w-0">
                    <p className="text-[10px] font-semibold text-slate-400 uppercase tracking-widest mb-1">Purchase Option Analysis</p>
                    <div className="flex items-center gap-2 flex-wrap">
                      <h2 className="text-2xl font-bold font-mono text-slate-900">{detailMaterial}</h2>
                      {res?.recommendation && res.recommendation !== 'No data' && (
                        <span className={`text-xs font-bold px-2.5 py-0.5 rounded-full ${
                          res.recommendation === 'Market' ? 'bg-blue-100 text-blue-700' : 'bg-slate-100 text-slate-700'
                        }`}>{res.recommendation}</span>
                      )}
                    </div>
                    {mat?.description && <p className="text-sm text-slate-500 mt-0.5 truncate">{mat.description}</p>}
                    {res?.mpns && res.mpns.length > 0 && (
                      <div className="flex flex-wrap gap-1 mt-2">
                        {res.mpns.map(m => (
                          <span key={m} className="font-mono text-[10px] bg-slate-100 text-slate-600 px-2 py-0.5 rounded">{m}</span>
                        ))}
                      </div>
                    )}
                  </div>
                  <button
                    className="shrink-0 w-8 h-8 rounded-full flex items-center justify-center text-slate-400 hover:bg-slate-100 hover:text-slate-700 transition-colors text-lg"
                    onClick={() => setDetailMaterial(null)}
                  >✕</button>
                </div>
              </div>

              {/* ── Scrollable body ── */}
              <div className="flex-1 overflow-y-auto p-6 flex flex-col gap-6">

                {/* Loading / Error */}
                {sc === 'loading' && (
                  <div className="flex items-center gap-3 text-slate-400 animate-pulse py-4">
                    <div className="w-4 h-4 rounded-full border-2 border-slate-300 border-t-slate-500 animate-spin" />
                    <span className="text-sm">Loading pricing data…</span>
                  </div>
                )}
                {sc === 'error' && (
                  <div className="flex items-center gap-3 text-red-500 text-sm py-2">
                    <span>⚠ Error fetching data.</span>
                    <button className="underline font-medium" onClick={() => fetchSourcing(detailMaterial, effQty)}>Retry</button>
                  </div>
                )}

                {/* Recommendation banner */}
                {res && res.recommendation !== 'No data' && (() => {
                  const isSAP = res.recommendation === 'SAP'
                  const price = isSAP ? res.sap?.unit_price_usd : res.market?.unit_price_usd
                  return (
                    <div className={`rounded-xl p-5 ${
                      isSAP
                        ? 'bg-gradient-to-br from-slate-50 to-slate-100 border border-slate-200'
                        : 'bg-gradient-to-br from-blue-50 to-indigo-50 border border-blue-200'
                    }`}>
                      <div className="flex flex-wrap gap-5 items-center">
                        <div>
                          <p className="text-[10px] font-semibold text-slate-400 uppercase tracking-widest">Best Option</p>
                          <p className={`text-3xl font-extrabold mt-0.5 ${isSAP ? 'text-slate-900' : 'text-blue-700'}`}>{res.recommendation}</p>
                        </div>
                        <div className="h-10 w-px bg-slate-300 hidden sm:block" />
                        <div>
                          <p className="text-[10px] font-semibold text-slate-400 uppercase tracking-widest">Unit Price</p>
                          <p className={`text-xl font-bold font-mono mt-0.5 ${isSAP ? 'text-slate-800' : 'text-blue-700'}`}>
                            {price != null ? fmtUnit(price) : '—'}
                          </p>
                        </div>
                        <div>
                          <p className="text-[10px] font-semibold text-slate-400 uppercase tracking-widest">Supplier</p>
                          <p className="text-sm font-semibold mt-0.5">{isSAP ? res.sap?.supplier : res.market?.seller}</p>
                          <p className="text-xs text-slate-400">
                            {isSAP ? res.sap?.site : `Stock: ${res.market?.inventory.toLocaleString()}`}
                            {!isSAP && res.market?.requires_moq && (
                              <span className="ml-2 inline-flex items-center bg-amber-100 text-amber-700 text-[10px] font-bold px-1.5 py-0.5 rounded">
                                ⚠ MOQ {res.market.moq.toLocaleString()} pcs
                              </span>
                            )}
                          </p>
                        </div>
                        {res.diff_pct != null && !isSAP && (
                          <span className="inline-flex items-center gap-1 bg-emerald-100 text-emerald-700 px-3 py-1.5 rounded-full font-bold text-sm">
                            ↓ {Math.abs(res.diff_pct).toFixed(1)}% vs SAP
                          </span>
                        )}
                        {price != null && (
                          <div className="ml-auto text-right">
                            <p className="text-[10px] font-semibold text-slate-400 uppercase tracking-widest">
                              Total @ {(!isSAP && res.market?.requires_moq ? res.market.effective_qty : effQty).toLocaleString()} pcs
                              {!isSAP && res.market?.requires_moq && (
                                <span className="ml-1 normal-case font-normal text-amber-600">(MOQ applied)</span>
                              )}
                            </p>
                            <p className={`text-2xl font-extrabold font-mono mt-0.5 ${isSAP ? 'text-slate-900' : 'text-blue-700'}`}>{fmtTotal(price * (!isSAP && res.market?.requires_moq ? res.market.effective_qty : effQty))}</p>
                          </div>
                        )}
                      </div>
                    </div>
                  )
                })()}
                {res?.recommendation === 'No data' && (
                  <div className="rounded-lg border border-dashed border-slate-200 p-8 text-center text-slate-400 text-sm">No pricing data found for this material.</div>
                )}

                {/* SAP Pricing — All Plants */}
                {res?.sap_all && res.sap_all.length > 0 && (
                  <div>
                    <div className="flex items-center gap-2 mb-3">
                      <div className="h-4 w-1 rounded-full bg-emerald-500" />
                      <p className="text-sm font-bold text-slate-700">SAP Pricing — All Plants</p>
                      <span className="text-xs text-slate-400">({res.sap_all.length} option{res.sap_all.length !== 1 ? 's' : ''} · cheapest first)</span>
                    </div>
                    <div className="overflow-x-auto rounded-lg border border-slate-200">
                      <table className="tbl text-xs">
                        <thead><tr>
                          <th>Site</th><th>MPN</th><th>Manufacturer</th><th>Supplier</th>
                          <th className="text-right">Last PO (USD)</th><th className="text-right">Std Price (USD)</th>
                          <th>Currency</th><th>PO Date</th>
                        </tr></thead>
                        <tbody>
                          {res.sap_all.map((row, i) => (
                            <tr key={i}
                              className={`cursor-pointer transition-colors ${selectedSapRow === row ? 'ring-2 ring-inset ring-blue-500 bg-blue-50 font-semibold' : i === 0 ? 'bg-emerald-50 hover:bg-emerald-100' : 'hover:bg-slate-50'}`}
                              onClick={() => { setSelectedSapRow(row === selectedSapRow ? null : row); setSelectedMarketRow(null) }}>
                              <td>
                                <span className={`font-mono text-[10px] px-1.5 py-0.5 rounded ${
                                  i === 0 ? 'bg-emerald-100 text-emerald-800 font-bold' : 'bg-slate-100 text-slate-600'
                                }`}>{row.site}</span>
                              </td>
                              <td className="font-mono">{row.mpn}</td>
                              <td>{row.manufacturer}</td>
                              <td>{row.supplier}</td>
                              <td className={`text-right font-mono font-semibold ${i === 0 ? 'text-emerald-700' : ''}`}>{fmtUnit(row.last_po_usd)}</td>
                              <td className="text-right font-mono text-slate-500">{row.standard_usd != null ? fmtUnit(row.standard_usd) : '—'}</td>
                              <td><span className="text-[10px] bg-slate-100 text-slate-500 px-1.5 py-0.5 rounded font-mono">{row.currency}</span></td>
                              <td className="text-slate-500">{row.last_po_date}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  </div>
                )}

                {/* Market Offers — Nexar */}
                {res?.market_all && res.market_all.length > 0 && (
                  <div>
                    <div className="flex items-center gap-2 mb-3">
                      <div className="h-4 w-1 rounded-full bg-blue-500" />
                      <p className="text-sm font-bold text-slate-700">Market Offers — Nexar</p>
                      <span className="text-xs text-slate-400">(in-stock · sorted by price)</span>
                    </div>
                    <div className="overflow-x-auto rounded-lg border border-slate-200">
                      <table className="tbl text-xs">
                        <thead><tr>
                          <th>#</th><th>MPN</th><th>Manufacturer</th><th>Supplier</th>
                          <th className="text-right">Unit Price</th>
                          <th className="text-right">Total (at order qty)</th>
                          <th className="text-right">Stock</th><th className="text-right">MOQ</th>
                          <th>Fulfills?</th><th>Packaging</th><th>Link</th>
                        </tr></thead>
                        <tbody>
                          {res.market_all.map((row, i) => (
                            <tr key={i}
                              className={`cursor-pointer transition-colors ${selectedMarketRow === row ? 'ring-2 ring-inset ring-blue-500 bg-blue-100 font-semibold' : i === 0 ? 'bg-blue-50 hover:bg-blue-100' : 'hover:bg-slate-50'}`}
                              onClick={() => { setSelectedMarketRow(row === selectedMarketRow ? null : row); setSelectedSapRow(null) }}>
                              <td className="text-center text-base">{RANKS[i] ?? `${i + 1}°`}</td>
                              <td className="font-mono">{row.mpn}</td>
                              <td>{row.manufacturer}</td>
                              <td className="font-medium">{row.seller}</td>
                              <td className={`text-right font-mono font-semibold ${i === 0 ? 'text-blue-700' : ''}`}>{fmtUnit(row.unit_price_usd)}</td>
                              <td className={`text-right font-mono font-semibold ${i === 0 ? 'text-blue-700' : ''}`}>
                                {fmtTotal(row.unit_price_usd * row.effective_qty)}
                                {row.requires_moq && (
                                  <span className="ml-1 text-[10px] font-bold bg-amber-100 text-amber-700 px-1.5 py-0.5 rounded whitespace-nowrap">
                                    {row.effective_qty.toLocaleString()} pcs
                                  </span>
                                )}
                              </td>
                              <td className={`text-right font-mono ${row.inventory > 0 ? 'text-emerald-600' : 'text-red-500'}`}>{row.inventory.toLocaleString()}</td>
                              <td className="text-right font-mono">
                                {row.requires_moq
                                  ? <span className="bg-amber-100 text-amber-700 font-bold px-1.5 py-0.5 rounded text-[10px]">⚠ {row.moq.toLocaleString()}</span>
                                  : row.moq.toLocaleString()
                                }
                              </td>
                              <td className="text-center">{row.can_fulfill ? '✅' : '⚠️'}</td>
                              <td className="text-slate-400">{row.packaging}</td>
                              <td>{row.click_url && (
                                <a href={row.click_url} target="_blank" rel="noopener noreferrer" className="text-blue-500 hover:underline whitespace-nowrap font-medium">View →</a>
                              )}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  </div>
                )}

              </div>

            </div>
          </div>
        )
      })()}

      {/* ── Vendor Price Trend Modal ─────────────────────────────────────── */}
      {showVendorTrend && detailMaterial && (
        <div
          className="fixed inset-0 z-[60] flex items-end justify-start p-4 pb-6 pl-6 pointer-events-none"
        >
          <div
            className="pointer-events-auto bg-white rounded-2xl shadow-2xl w-full max-w-xl flex flex-col"
            style={{ maxHeight: '70vh' }}
          >
            {/* Header */}
            <div className="flex items-center justify-between px-5 py-3 bg-slate-800 text-white rounded-t-2xl shrink-0">
              <div className="min-w-0">
                <p className="text-[10px] font-semibold opacity-60 uppercase tracking-widest">Vendor PO Price Trend</p>
                <h3 className="font-bold font-mono text-sm truncate">{detailMaterial}</h3>
              </div>
              <button
                onClick={() => setShowVendorTrend(false)}
                className="w-7 h-7 rounded-full bg-white/10 hover:bg-white/20 flex items-center justify-center transition-colors shrink-0 ml-3"
              >
                <X size={13} />
              </button>
            </div>

            {/* Body */}
            <div className="flex-1 overflow-y-auto p-4">
              {vendorTrendLoading && (
                <div className="flex items-center gap-3 text-slate-400 animate-pulse py-6 justify-center text-sm">
                  <div className="w-4 h-4 rounded-full border-2 border-slate-300 border-t-slate-500 animate-spin" />
                  Loading vendor trends…
                </div>
              )}

              {!vendorTrendLoading && vendorTrend && vendorTrend.vendors.length === 0 && (
                <p className="text-sm text-slate-400 italic text-center py-6">No vendor trend data for this material.</p>
              )}

              {!vendorTrendLoading && vendorTrend && vendorTrend.vendors.length > 0 && (() => {
                const COLORS = ['#3b82f6','#f59e0b','#10b981','#ef4444','#8b5cf6','#f97316','#06b6d4','#84cc16','#ec4899','#6366f1']
                const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec']
                const fmtYM = (ym: string) => {
                  if (ym.length !== 6) return ym
                  const m = parseInt(ym.slice(4), 10) - 1
                  return `${months[m] ?? ym.slice(4)} '${ym.slice(2,4)}`
                }
                const labels = vendorTrend.labels.map(fmtYM)
                const series = vendorTrend.vendors.map((v, i) => ({
                  label:  v.name,
                  values: v.po_price.map(p => p != null ? p / 1000 : null),
                  color:  COLORS[i % COLORS.length],
                  width:  2,
                }))

                // Reference line from selected SAP / Market row
                const effQty = rowQty[detailMaterial] ?? quantity
                let refLine: { value: number; label: string; color: string } | null = null
                let refTotal: number | null = null
                let refSupplier = ''
                let refIsSAP = false
                if (selectedSapRow) {
                  refLine     = { value: selectedSapRow.last_po_usd, label: `${selectedSapRow.supplier}  ${fmtUnit(selectedSapRow.last_po_usd)}/u`, color: '#10b981' }
                  refTotal    = selectedSapRow.last_po_usd * effQty
                  refSupplier = selectedSapRow.supplier
                  refIsSAP    = true
                } else if (selectedMarketRow) {
                  refLine     = { value: selectedMarketRow.unit_price_usd, label: `${selectedMarketRow.seller}  ${fmtUnit(selectedMarketRow.unit_price_usd)}/u`, color: '#3b82f6' }
                  refTotal    = selectedMarketRow.unit_price_usd * effQty
                  refSupplier = selectedMarketRow.seller
                  refIsSAP    = false
                }

                return (
                  <div className="flex flex-col gap-3">
                    <LineChart
                      labels={labels}
                      series={series}
                      height={220}
                      yLabel="Unit Price (USD)"
                      refLines={refLine ? [refLine] : undefined}
                    />

                    {/* Selected option summary */}
                    {refLine && refTotal != null && (
                      <div className={`rounded-xl px-4 py-3 flex items-center justify-between gap-3 ${refIsSAP ? 'bg-emerald-50 border border-emerald-200' : 'bg-blue-50 border border-blue-200'}`}>
                        <div className="flex items-center gap-2 min-w-0">
                          <span className="w-3 h-3 rounded-full shrink-0" style={{ background: refLine.color }} />
                          <div className="min-w-0">
                            <p className={`text-[10px] font-semibold uppercase tracking-wide ${refIsSAP ? 'text-emerald-600' : 'text-blue-600'}`}>
                              Selected — {refIsSAP ? 'SAP' : 'Market'}
                            </p>
                            <p className="text-xs font-medium text-slate-700 truncate" title={refSupplier}>{refSupplier}</p>
                          </div>
                        </div>
                        <div className="text-right shrink-0">
                          <p className="text-[10px] text-slate-500 uppercase tracking-wide">Total @ {effQty.toLocaleString()} pcs</p>
                          <p className={`text-base font-bold font-mono ${refIsSAP ? 'text-emerald-700' : 'text-blue-700'}`}>
                            {fmtTotal(refTotal)}
                          </p>
                        </div>
                      </div>
                    )}

                    {!refLine && (
                      <p className="text-[11px] text-slate-400 italic px-1">Select a row in Purchase Option Analysis to see its price on the chart.</p>
                    )}

                    {/* Legend */}
                    <div className="flex flex-wrap gap-x-4 gap-y-1 px-1">
                      {vendorTrend.vendors.map((v, i) => (
                        <div key={v.name} className="flex items-center gap-1.5 text-xs text-slate-600">
                          <span className="w-3 h-3 rounded-full shrink-0" style={{ background: COLORS[i % COLORS.length] }} />
                          <span className="truncate max-w-[160px]" title={v.name}>{v.name}</span>
                        </div>
                      ))}
                    </div>
                  </div>
                )
              })()}
            </div>
          </div>
        </div>
      )}

      {/* ── Month Records Modal ──────────────────────────────────────────── */}
      {monthModal && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center p-4"
          style={{ background: 'rgba(15,23,42,0.55)' }}
          onClick={() => setMonthModal(null)}
        >
          <div
            className="bg-white rounded-2xl shadow-2xl w-full max-w-5xl max-h-[85vh] flex flex-col overflow-hidden"
            onClick={e => e.stopPropagation()}
          >
            {/* Header */}
            <div className="flex items-center justify-between px-6 py-4 border-b border-slate-100">
              <div>
                <p className="text-xs text-slate-400 font-semibold uppercase tracking-widest">Month breakdown</p>
                <h2 className="text-lg font-bold text-slate-800">
                  {monthModal.vendor} — {monthModal.month}
                </h2>
              </div>
              <button
                className="text-slate-400 hover:text-slate-700 text-2xl leading-none font-light"
                onClick={() => setMonthModal(null)}
              >×</button>
            </div>

            {/* Body */}
            <div className="overflow-auto flex-1 p-4">
              {monthModal.loading ? (
                <div className="flex items-center justify-center h-40 text-slate-400 gap-3">
                  <svg className="animate-spin h-5 w-5" viewBox="0 0 24 24" fill="none">
                    <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"/>
                    <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8z"/>
                  </svg>
                  Loading records…
                </div>
              ) : monthModal.records.length === 0 ? (
                <p className="text-slate-400 text-center py-10">No records found for this month.</p>
              ) : (
                <table className="w-full text-xs">
                  <thead>
                    <tr className="bg-slate-50 text-slate-500 font-semibold">
                      {monthModal.columns.map(col => (
                        <th
                          key={col}
                          className={`px-3 py-2 whitespace-nowrap ${
                            ['PPV','PO Amount','Std Amount','PO Price/1k','Std Price/1k','Qty'].includes(col)
                              ? 'text-right' : 'text-left'
                          }`}
                        >{col}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {monthModal.records.map((row, i) => (
                      <tr key={i} className="border-t border-slate-100 hover:bg-slate-50">
                        {monthModal.columns.map(col => {
                          const val = row[col]
                          const isNum = ['PPV','PO Amount','Std Amount','PO Price/1k','Std Price/1k'].includes(col)
                          const isQty = col === 'Qty'
                          const isPPV = col === 'PPV'
                          const numVal = typeof val === 'number' ? val : parseFloat(val)
                          return (
                            <td
                              key={col}
                              className={`px-3 py-1.5 ${
                                isNum || isQty ? 'text-right font-mono' : ''
                              } ${isPPV ? (numVal > 0 ? 'text-red-600 font-semibold' : numVal < 0 ? 'text-emerald-600 font-semibold' : '') : ''}`}
                            >
                              {isNum && val != null
                                ? `$${numVal.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
                                : isQty && val != null
                                ? numVal.toLocaleString()
                                : val ?? '—'}
                            </td>
                          )
                        })}
                      </tr>
                    ))}
                  </tbody>
                  <tfoot>
                    <tr className="border-t-2 border-slate-200 bg-slate-50 font-semibold text-slate-700">
                      {monthModal.columns.map(col => {
                        if (!['PPV','PO Amount','Std Amount'].includes(col)) return <td key={col} className="px-3 py-2" />
                        const sum = monthModal.records.reduce((acc, r) => acc + (typeof r[col] === 'number' ? r[col] : parseFloat(r[col]) || 0), 0)
                        return (
                          <td key={col} className={`px-3 py-2 text-right font-mono ${col === 'PPV' ? (sum > 0 ? 'text-red-600' : sum < 0 ? 'text-emerald-600' : '') : ''}`}>
                            ${sum.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                          </td>
                        )
                      })}
                    </tr>
                  </tfoot>
                </table>
              )}
            </div>

            {/* Footer */}
            {!monthModal.loading && monthModal.records.length > 0 && (
              <div className="px-6 py-3 border-t border-slate-100 text-xs text-slate-400">
                {monthModal.records.length} record{monthModal.records.length !== 1 ? 's' : ''}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  )
}
