// src/components/MGRecDrillModal.tsx
// Two-panel drilldown modal opened when clicking a recommendation:
//   Left  panel → loser plant  (red)  — top 20 unfavorable components + SAP price comparison
//   Right panel → winner plant (green) — full component breakdown
import { useEffect, useRef, useState, useCallback } from 'react'
import { PLANT_FLAGS, PLANT_NAMES, PLANT_COLORS, SAP_SITE_NAMES, SAP_SITE_FLAGS } from '../utils/plants'
import { usePPV } from '../store/ppvStore'
import type { MGPlantComponentsData, MGComponentItem, SapComponentResult } from '../types/api.types'
import { getMGPlantComponents, getMGSapBatch } from '../api/client'

interface Props {
  group:       string
  loserPlant:  string
  winnerPlant: string
  loserValue:  number
  winnerValue: number
  gap:         number
  onClose:     () => void
}

const fmtK = (v: number) => {
  const abs = Math.abs(v)
  if (abs >= 1_000_000) return `$${(v / 1_000_000).toFixed(2)}M`
  if (abs >= 1_000)     return `$${(v / 1_000).toFixed(1)}K`
  return `$${v.toFixed(0)}`
}

// ── Horizontal bar chart ──────────────────────────────────────────────────────
function HBarChart({ items, color }: { items: MGComponentItem[]; color: string }) {
  const wrapRef   = useRef<HTMLDivElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)

  const draw = useCallback(() => {
    const canvas = canvasRef.current
    const wrap   = wrapRef.current
    if (!canvas || !wrap || !items.length) return

    const W = wrap.clientWidth
    if (!W) return

    const dpr = window.devicePixelRatio || 1
    const BAR = 24
    const GAP = 4
    const PAD = { t: 6, b: 6, l: 132, r: 72 }
    const H   = PAD.t + PAD.b + items.length * (BAR + GAP)

    canvas.width        = W * dpr
    canvas.height       = H * dpr
    canvas.style.width  = `${W}px`
    canvas.style.height = `${H}px`

    const ctx = canvas.getContext('2d')!
    ctx.scale(dpr, dpr)
    ctx.clearRect(0, 0, W, H)

    const cW     = W - PAD.l - PAD.r
    const maxAbs = Math.max(1, ...items.map(d => Math.abs(d.ppv)))

    items.forEach((d, i) => {
      const y  = PAD.t + i * (BAR + GAP)
      const bW = (Math.abs(d.ppv) / maxAbs) * cW

      // Track background
      ctx.fillStyle = '#f1f5f9'
      ctx.fillRect(PAD.l, y, cW, BAR)

      // Colored bar
      ctx.fillStyle   = color
      ctx.globalAlpha = 0.80
      ctx.fillRect(PAD.l, y, bW, BAR)
      ctx.globalAlpha = 1

      // Material number (bold monospace, right-aligned)
      ctx.font      = 'bold 10.5px monospace'
      ctx.textAlign = 'right'
      ctx.fillStyle = '#1e293b'
      ctx.fillText(d.material, PAD.l - 5, y + BAR / 2 + 4)

      // Description below material number
      if (d.description && d.description !== d.material) {
        const desc = d.description.length > 17 ? d.description.slice(0, 16) + '…' : d.description
        ctx.font      = '9px system-ui, sans-serif'
        ctx.fillStyle = '#94a3b8'
        ctx.fillText(desc, PAD.l - 5, y + BAR - 3)
      }

      // PPV value (right of bar)
      ctx.textAlign = 'left'
      ctx.font      = 'bold 10px system-ui, sans-serif'
      ctx.fillStyle = d.ppv > 0 ? '#dc2626' : '#16a34a'
      const label   = (d.ppv > 0 ? '+' : '') + fmtK(d.ppv)
      ctx.fillText(label, PAD.l + bW + 5, y + BAR / 2 + 4)
    })
  }, [items, color])

  useEffect(() => {
    draw()
    const ro = new ResizeObserver(draw)
    if (wrapRef.current) ro.observe(wrapRef.current)
    return () => ro.disconnect()
  }, [draw])

  return (
    <div ref={wrapRef} className="w-full">
      <canvas ref={canvasRef} style={{ display: 'block' }} />
    </div>
  )
}

// ── SAP comparison cell ───────────────────────────────────────────────────────
function SapCell({
  material, sapResults, loadSap,
}: {
  material:   string
  sapResults: Map<string, SapComponentResult>
  loadSap:    boolean
}) {
  if (loadSap) return (
    <div className="w-4 h-4 border-2 border-slate-200 border-t-blue-400 rounded-full animate-spin" />
  )
  const r = sapResults.get(material)
  if (!r || !r.found) return <span className="text-slate-300 text-xs">—</span>
  if (r.is_cheapest_at_loser) return (
    <span className="text-green-600 font-semibold text-[11px]">✓ Min SAP</span>
  )
  const siteKey = (r.best_site ?? '').toUpperCase()
  return (
    <div className="space-y-0.5">
      <p className="text-[11px] font-semibold text-slate-700 whitespace-nowrap leading-tight">
        {SAP_SITE_FLAGS[siteKey] ?? '🏭'}&nbsp;
        {SAP_SITE_NAMES[siteKey] ?? r.best_site ?? '—'}
      </p>
      {r.best_internal_pn && (
        <p className="text-[10px] text-slate-400 font-mono leading-tight">PN:&nbsp;{r.best_internal_pn}</p>
      )}
      {r.saving_pct != null && r.saving_pct > 0 && (
        <p className="text-[10px] text-green-600 font-semibold leading-tight">−{r.saving_pct}%</p>
      )}
    </div>
  )
}

// ── Single plant panel ────────────────────────────────────────────────────────
function PlantPanel({
  data, loading, plant, fallbackTotal, side, sapResults, loadSap,
}: {
  data:          MGPlantComponentsData | null
  loading:       boolean
  plant:         string
  fallbackTotal: number
  side:          'loser' | 'winner'
  sapResults?:   Map<string, SapComponentResult>
  loadSap?:      boolean
}) {
  const isLoser = side === 'loser'
  const color   = PLANT_COLORS[plant] ?? (isLoser ? '#ef4444' : '#22c55e')
  const total   = data?.total ?? fallbackTotal
  const items   = data?.components ?? []

  // Loser side: only positive-PPV components (where money is lost), top 20 worst
  const displayItems = sapResults !== undefined
    ? items.filter(c => c.ppv > 0).sort((a, b) => b.ppv - a.ppv).slice(0, 20)
    : items

  const showSap = sapResults !== undefined

  return (
    <div className={`flex flex-col h-full border-2 rounded-xl overflow-hidden ${
      isLoser ? 'border-red-200' : 'border-green-200'
    }`}>
      {/* Panel header */}
      <div className={`px-4 py-3 flex items-center justify-between shrink-0 ${
        isLoser ? 'bg-red-50' : 'bg-green-50'
      }`}>
        <div className="flex items-center gap-2.5">
          <span className="text-2xl">{PLANT_FLAGS[plant] ?? '🏭'}</span>
          <div>
            <p className={`text-sm font-bold leading-tight ${
              isLoser ? 'text-red-800' : 'text-green-800'
            }`}>
              {PLANT_NAMES[plant] ?? plant}
            </p>
            <p className={`text-xs font-semibold leading-tight ${
              isLoser ? 'text-red-600' : 'text-green-600'
            }`}>
              {isLoser && total > 0 ? '+' : ''}{fmtK(total)} total PPV
            </p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          {showSap && (
            <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-blue-50 border border-blue-200 text-blue-600 font-medium">
              SAP
            </span>
          )}
          <span className={`text-[11px] px-2.5 py-1 rounded-full font-medium border ${
            isLoser
              ? 'bg-red-100 text-red-700 border-red-200'
              : 'bg-green-100 text-green-700 border-green-200'
          }`}>
            {isLoser ? '⬆ Over benchmark' : '⬇ Best performer'}
          </span>
        </div>
      </div>

      {/* Scrollable content */}
      <div className="flex-1 min-h-0 overflow-y-auto p-4 space-y-4 bg-white">
        {loading ? (
          <div className="flex items-center justify-center h-32">
            <div className="flex items-center gap-2 text-slate-400">
              <div className="w-5 h-5 border-2 border-slate-200 border-t-slate-500 rounded-full animate-spin" />
              <span className="text-sm">Loading components…</span>
            </div>
          </div>
        ) : displayItems.length === 0 ? (
          <p className="text-sm text-slate-400 italic text-center py-10">
            {showSap && items.length > 0
              ? 'No unfavorable components in this group.'
              : 'No component data available.'}
          </p>
        ) : (
          <>
            {/* Bar chart */}
            <div>
              <p className="text-[11px] font-semibold text-slate-400 uppercase tracking-wider mb-2">
                {showSap
                  ? `Top ${displayItems.length} Unfavorable Components`
                  : 'Component Impact'}
              </p>
              <HBarChart items={displayItems.slice(0, 15)} color={color} />
            </div>

            {/* Table */}
            <div className="rounded-lg border border-slate-100 overflow-hidden">
              <div className="overflow-x-auto">
                <table className="w-full text-xs">
                  <thead>
                    <tr className="bg-slate-50 text-slate-500 font-semibold text-[11px]">
                      <th className="text-left px-3 py-2 whitespace-nowrap">Material</th>
                      <th className="text-left px-3 py-2">Description</th>
                      <th className="text-right px-3 py-2 whitespace-nowrap">PPV</th>
                      <th className="text-right px-3 py-2 whitespace-nowrap">Records</th>
                      {showSap && (
                        <th className="text-left px-3 py-2 whitespace-nowrap">Mejor en SAP</th>
                      )}
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-50">
                    {displayItems.map((it, idx) => (
                      <tr
                        key={it.material}
                        className={idx % 2 === 0 ? 'bg-white' : 'bg-slate-50/50'}
                      >
                        <td className="px-3 py-1.5 font-mono text-[11px] text-slate-700 whitespace-nowrap">
                          {it.material}
                        </td>
                        <td
                          className="px-3 py-1.5 text-slate-500 truncate"
                          style={{ maxWidth: 140 }}
                          title={it.description}
                        >
                          {it.description || '—'}
                        </td>
                        <td className={`px-3 py-1.5 text-right font-semibold whitespace-nowrap ${
                          it.ppv > 0 ? 'text-red-600' : 'text-green-600'
                        }`}>
                          {it.ppv > 0 ? '+' : ''}{fmtK(it.ppv)}
                        </td>
                        <td className="px-3 py-1.5 text-right text-slate-400">
                          {it.records.toLocaleString()}
                        </td>
                        {showSap && (
                          <td className="px-3 py-2">
                            <SapCell
                              material={it.material}
                              sapResults={sapResults!}
                              loadSap={loadSap ?? false}
                            />
                          </td>
                        )}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          </>
        )}
      </div>
    </div>
  )
}

// ── Main modal ────────────────────────────────────────────────────────────────
export default function MGRecDrillModal({
  group, loserPlant, winnerPlant, loserValue, winnerValue, gap, onClose,
}: Props) {
  const { sessionId, selectedGroups, selectedVendors } = usePPV()
  const [loserData,  setLoserData]  = useState<MGPlantComponentsData | null>(null)
  const [winnerData, setWinnerData] = useState<MGPlantComponentsData | null>(null)
  const [loadL, setLoadL]           = useState(true)
  const [loadW, setLoadW]           = useState(true)
  const [sapData, setSapData]       = useState<Map<string, SapComponentResult>>(new Map())
  const [loadSap, setLoadSap]       = useState(false)

  const filters = { material_groups: selectedGroups, vendors: selectedVendors }

  useEffect(() => {
    if (!sessionId) return
    setLoadL(true); setLoadW(true)
    setSapData(new Map()); setLoadSap(false)

    getMGPlantComponents(sessionId, filters, group, loserPlant)
      .then(d  => { setLoserData(d);  setLoadL(false) })
      .catch(() => setLoadL(false))

    getMGPlantComponents(sessionId, filters, group, winnerPlant)
      .then(d  => { setWinnerData(d); setLoadW(false) })
      .catch(() => setLoadW(false))
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId, group, loserPlant, winnerPlant])

  // Fetch SAP pricing for top 20 unfavorable components of the loser plant
  useEffect(() => {
    if (!loserData) return
    const mats = loserData.components
      .filter(c => c.ppv > 0)
      .sort((a, b) => b.ppv - a.ppv)
      .slice(0, 20)
      .map(c => c.material)
    if (!mats.length) return
    setLoadSap(true)
    getMGSapBatch(mats, loserPlant)
      .then(res => {
        const map = new Map<string, SapComponentResult>()
        for (const r of res.results) map.set(r.material, r)
        setSapData(map)
        setLoadSap(false)
      })
      .catch(() => setLoadSap(false))
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loserData, loserPlant])

  // Close on Escape
  useEffect(() => {
    const h = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', h)
    return () => window.removeEventListener('keydown', h)
  }, [onClose])

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-3 sm:p-6">
      {/* Backdrop */}
      <div
        className="absolute inset-0 bg-black/60 backdrop-blur-sm"
        onClick={onClose}
      />

      {/* Panel */}
      <div
        className="relative z-10 w-full max-w-[1300px] bg-white rounded-2xl shadow-2xl flex flex-col"
        style={{ maxHeight: 'calc(100vh - 48px)' }}
      >
        {/* Header */}
        <div className="px-5 py-4 border-b border-slate-100 flex items-start justify-between shrink-0">
          <div>
            <h2 className="text-base font-bold text-slate-800 leading-tight">
              🔬 {group}
            </h2>
            <p className="text-xs text-slate-500 mt-0.5">
              {PLANT_FLAGS[loserPlant] ?? '🏭'}&nbsp;{PLANT_NAMES[loserPlant] ?? loserPlant} can save&nbsp;
              <span className="font-semibold text-slate-700">{fmtK(gap)}</span> by
              matching {PLANT_FLAGS[winnerPlant] ?? '🏭'}&nbsp;{PLANT_NAMES[winnerPlant] ?? winnerPlant}'s
              sourcing strategy
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="ml-4 shrink-0 p-1.5 rounded-lg text-slate-400 hover:text-slate-600 hover:bg-slate-100 transition-colors"
            aria-label="Close"
          >
            <svg width="18" height="18" viewBox="0 0 18 18" fill="none"
              stroke="currentColor" strokeWidth="2.2" strokeLinecap="round">
              <line x1="4" y1="4" x2="14" y2="14" />
              <line x1="14" y1="4" x2="4" y2="14" />
            </svg>
          </button>
        </div>

        {/* Two-panel body */}
        <div className="flex-1 min-h-0 grid grid-cols-2 gap-3 p-4">
          <PlantPanel
            data={loserData}
            loading={loadL}
            plant={loserPlant}
            fallbackTotal={loserValue}
            side="loser"
            sapResults={sapData}
            loadSap={loadSap}
          />
          <PlantPanel
            data={winnerData}
            loading={loadW}
            plant={winnerPlant}
            fallbackTotal={winnerValue}
            side="winner"
          />
        </div>
      </div>
    </div>
  )
}
