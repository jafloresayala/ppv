// src/components/charts/StackedBarChart.tsx
// Dual-axis stacked bar chart:
//   Left  axis → stacked bars per plant (only visible plants)
//   Right axis → cumulative PPV line (recomputed from visible plants)
// Click legend items to show/hide individual plants.
import { useEffect, useRef, useState, useCallback } from 'react'
import { PLANT_FLAGS, PLANT_NAMES, PLANT_COLORS } from '../../utils/plants'

interface TooltipInfo {
  cx: number
  cy: number
  label: string
  items: { plant: string; value: number }[]
  total: number
  cumulative: number
}

interface Props {
  labels:  string[]
  byPlant: Record<string, number[]>
  height?: number
}

const PAD  = { l: 78, r: 76, t: 20, b: 52 }
const GRID = 6

const fmtK = (v: number) => {
  const abs = Math.abs(v)
  if (abs >= 1_000_000) return `$${(v / 1_000_000).toFixed(1)}M`
  if (abs >= 1_000)     return `$${(v / 1_000).toFixed(0)}K`
  return `$${v.toFixed(0)}`
}

export default function StackedBarChart({ labels, byPlant, height = 360 }: Props) {
  const wrapRef   = useRef<HTMLDivElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const [tip, setTip]       = useState<TooltipInfo | null>(null)
  const [hidden, setHidden] = useState<Set<string>>(new Set())

  const allPlants = Object.keys(byPlant).sort()
  const plants    = allPlants.filter(p => !hidden.has(p))

  const togglePlant = (p: string) =>
    setHidden(prev => {
      const next = new Set(prev)
      next.has(p) ? next.delete(p) : next.add(p)
      return next
    })

  // ── draw ──────────────────────────────────────────────────────────────────
  const draw = useCallback((w: number) => {
    const canvas = canvasRef.current
    if (!canvas || !labels.length) return
    const ctx = canvas.getContext('2d')
    if (!ctx) return

    const dpr = window.devicePixelRatio || 1
    const H   = height
    canvas.width  = w * dpr
    canvas.height = H * dpr
    canvas.style.width  = `${w}px`
    canvas.style.height = `${H}px`
    ctx.scale(dpr, dpr)

    const cW   = w - PAD.l - PAD.r
    const cH   = H - PAD.t - PAD.b
    const step = cW / labels.length
    const barW = Math.max(4, step * 0.68)

    // ── cumulative line from visible plants only ───────────────────────────
    const periodTotals = labels.map((_, i) =>
      plants.reduce((s, p) => s + (byPlant[p]?.[i] ?? 0), 0))
    const cumLine = periodTotals.reduce<number[]>((acc, v) => {
      acc.push((acc[acc.length - 1] ?? 0) + v)
      return acc
    }, [])

    // ── LEFT axis scale (bars) ─────────────────────────────────────────────
    const posSums = labels.map((_, i) =>
      plants.reduce((s, p) => s + Math.max(0, byPlant[p]?.[i] ?? 0), 0))
    const negSums = labels.map((_, i) =>
      plants.reduce((s, p) => s + Math.min(0, byPlant[p]?.[i] ?? 0), 0))

    const yMax   = Math.max(1, ...posSums) * 1.12
    const yMin   = Math.min(-1, ...negSums) * 1.12
    const yRange = yMax - yMin
    const toY    = (v: number) => PAD.t + cH * (1 - (v - yMin) / yRange)
    const y0     = toY(0)

    // ── RIGHT axis scale (cumulative) ──────────────────────────────────────
    const rMax   = Math.max(1, ...cumLine) * 1.12
    const rMin   = Math.min(-1, ...cumLine) * 1.12
    const rRange = rMax - rMin
    const toYR   = (v: number) => PAD.t + cH * (1 - (v - rMin) / rRange)

    ctx.clearRect(0, 0, w, H)

    // ── grid lines + LEFT labels ───────────────────────────────────────────
    ctx.font      = '10.5px system-ui, sans-serif'
    ctx.textAlign = 'right'
    for (let g = 0; g <= GRID; g++) {
      const val = yMin + (yRange * g) / GRID
      const gy  = toY(val)
      ctx.strokeStyle = '#e2e8f0'
      ctx.lineWidth   = 1
      ctx.beginPath(); ctx.moveTo(PAD.l, gy); ctx.lineTo(PAD.l + cW, gy); ctx.stroke()
      ctx.fillStyle = '#64748b'
      ctx.fillText(fmtK(val), PAD.l - 5, gy + 3.5)
    }

    // ── RIGHT labels ──────────────────────────────────────────────────────
    ctx.textAlign = 'left'
    ctx.fillStyle = '#6366f1'
    for (let g = 0; g <= GRID; g++) {
      const val = rMin + (rRange * g) / GRID
      const gy  = toYR(val)
      ctx.fillText(fmtK(val), PAD.l + cW + 6, gy + 3.5)
    }

    // ── zero line (left axis) ──────────────────────────────────────────────
    ctx.strokeStyle = '#94a3b8'
    ctx.lineWidth   = 1.5
    ctx.beginPath(); ctx.moveTo(PAD.l, y0); ctx.lineTo(PAD.l + cW, y0); ctx.stroke()

    // ── stacked bars ──────────────────────────────────────────────────────
    labels.forEach((lbl, i) => {
      const cx = PAD.l + i * step + step / 2
      let posY = y0
      let negY = y0

      plants.forEach(plant => {
        const val  = byPlant[plant]?.[i] ?? 0
        if (val === 0) return
        const color = PLANT_COLORS[plant] ?? '#94a3b8'
        const barH  = Math.abs(val) / yRange * cH

        ctx.fillStyle = color
        if (val > 0) {
          posY -= barH
          ctx.fillRect(cx - barW / 2, posY, barW, barH)
          ctx.strokeStyle = 'rgba(255,255,255,0.35)'
          ctx.lineWidth   = 0.5
          ctx.strokeRect(cx - barW / 2, posY, barW, barH)
        } else {
          ctx.fillRect(cx - barW / 2, negY, barW, barH)
          ctx.strokeStyle = 'rgba(255,255,255,0.35)'
          ctx.lineWidth   = 0.5
          ctx.strokeRect(cx - barW / 2, negY, barW, barH)
          negY += barH
        }
      })

      // X label
      ctx.fillStyle = '#64748b'
      ctx.font      = '10.5px system-ui, sans-serif'
      ctx.textAlign = 'center'
      ctx.fillText(lbl, cx, H - PAD.b + 15)
    })

    // ── axis borders ──────────────────────────────────────────────────────
    ctx.strokeStyle = '#cbd5e1'; ctx.lineWidth = 1
    ctx.beginPath(); ctx.moveTo(PAD.l, PAD.t); ctx.lineTo(PAD.l, PAD.t + cH); ctx.stroke()
    ctx.strokeStyle = '#a5b4fc'; ctx.lineWidth = 1
    ctx.beginPath(); ctx.moveTo(PAD.l + cW, PAD.t); ctx.lineTo(PAD.l + cW, PAD.t + cH); ctx.stroke()

    // ── cumulative line (right axis) ───────────────────────────────────────
    ctx.save()
    ctx.strokeStyle = '#4f46e5'
    ctx.lineWidth   = 2.5
    ctx.lineJoin    = 'round'
    ctx.beginPath()
    cumLine.forEach((v, i) => {
      const cx = PAD.l + i * step + step / 2
      i === 0 ? ctx.moveTo(cx, toYR(v)) : ctx.lineTo(cx, toYR(v))
    })
    ctx.stroke()

    // dots on cumulative line
    ctx.fillStyle = '#4f46e5'
    cumLine.forEach((v, i) => {
      const cx = PAD.l + i * step + step / 2
      ctx.beginPath(); ctx.arc(cx, toYR(v), 3.5, 0, Math.PI * 2); ctx.fill()
    })
    ctx.restore()

    // ── axis title (right) ─────────────────────────────────────────────────
    ctx.save()
    ctx.font      = '10px system-ui, sans-serif'
    ctx.fillStyle = '#6366f1'
    ctx.textAlign = 'center'
    ctx.translate(w - 12, PAD.t + cH / 2)
    ctx.rotate(-Math.PI / 2)
    ctx.fillText('Cumulative PPV', 0, 0)
    ctx.restore()

  }, [labels, byPlant, height, plants])

  // ── mount / resize ────────────────────────────────────────────────────────
  useEffect(() => {
    if (!wrapRef.current) return
    draw(wrapRef.current.clientWidth || 800)
    const ro = new ResizeObserver(() => {
      if (wrapRef.current) draw(wrapRef.current.clientWidth)
    })
    ro.observe(wrapRef.current)
    return () => ro.disconnect()
  }, [draw])

  // ── tooltip ───────────────────────────────────────────────────────────────
  function handleMouseMove(e: React.MouseEvent<HTMLCanvasElement>) {
    const canvas = canvasRef.current
    if (!canvas) return
    const rect = canvas.getBoundingClientRect()
    const mx   = e.clientX - rect.left
    const cW   = rect.width - PAD.l - PAD.r
    const step = cW / labels.length
    const idx  = Math.floor((mx - PAD.l) / step)
    if (idx < 0 || idx >= labels.length) { setTip(null); return }

    const items = plants
      .map(p => ({ plant: p, value: byPlant[p]?.[idx] ?? 0 }))
      .filter(it => it.value !== 0)
      .sort((a, b) => b.value - a.value)

    const total = items.reduce((s, it) => s + it.value, 0)

    // compute cumulative up to idx from visible plants
    let cum = 0
    for (let i = 0; i <= idx; i++)
      cum += plants.reduce((s, p) => s + (byPlant[p]?.[i] ?? 0), 0)

    setTip({ cx: mx, cy: e.clientY - rect.top, label: labels[idx], items, total, cumulative: cum })
  }

  // ── render ────────────────────────────────────────────────────────────────
  return (
    <div ref={wrapRef} className="relative select-none">
      <canvas
        ref={canvasRef}
        style={{ display: 'block', cursor: 'crosshair' }}
        onMouseMove={handleMouseMove}
        onMouseLeave={() => setTip(null)}
      />

      {/* Floating tooltip */}
      {tip && tip.items.length > 0 && (
        <div
          className="pointer-events-none absolute z-20 bg-white border border-slate-200 rounded-xl shadow-xl px-3 py-2.5 text-xs min-w-[190px]"
          style={{
            left: tip.cx + 14,
            top:  Math.max(4, tip.cy - 16),
            transform: tip.cx > (canvasRef.current?.getBoundingClientRect().width ?? 600) * 0.6
              ? 'translateX(-110%)'
              : undefined,
          }}
        >
          <p className="font-bold text-slate-700 mb-1.5 border-b border-slate-100 pb-1">
            {tip.label}
          </p>
          {tip.items.map(it => (
            <div key={it.plant} className="flex items-center justify-between gap-3 py-0.5">
              <span className="flex items-center gap-1.5">
                <span className="w-2.5 h-2.5 rounded-sm shrink-0"
                  style={{ background: PLANT_COLORS[it.plant] ?? '#94a3b8' }} />
                <span className="text-slate-600">
                  {PLANT_FLAGS[it.plant] ?? '🏭'} {PLANT_NAMES[it.plant] ?? it.plant}
                </span>
              </span>
              <span className={`font-semibold ${it.value > 0 ? 'text-red-600' : 'text-green-600'}`}>
                {fmtK(it.value)}
              </span>
            </div>
          ))}
          <div className="mt-1 pt-1 border-t border-slate-100 flex justify-between text-slate-700 font-semibold">
            <span>Net PPV</span>
            <span className={tip.total > 0 ? 'text-red-600' : 'text-green-600'}>{fmtK(tip.total)}</span>
          </div>
          <div className="flex justify-between text-indigo-600 font-semibold pt-0.5">
            <span>Cumulative</span>
            <span>{fmtK(tip.cumulative)}</span>
          </div>
        </div>
      )}

      {/* Clickable legend */}
      <div className="flex flex-wrap gap-2 mt-3 justify-center items-center">
        {allPlants.map(p => {
          const isHidden = hidden.has(p)
          const color    = PLANT_COLORS[p] ?? '#94a3b8'
          return (
            <button
              key={p}
              type="button"
              onClick={() => togglePlant(p)}
              title={isHidden ? `Mostrar ${PLANT_NAMES[p] ?? p}` : `Ocultar ${PLANT_NAMES[p] ?? p}`}
              className={[
                'flex items-center gap-1.5 px-2.5 py-1 rounded-full border text-xs font-medium transition-all',
                isHidden
                  ? 'border-slate-200 text-slate-400 bg-white line-through'
                  : 'border-transparent text-white',
              ].join(' ')}
              style={isHidden ? {} : { background: color }}
            >
              <span>{PLANT_FLAGS[p] ?? '🏭'}</span>
              <span>{PLANT_NAMES[p] ?? p}</span>
            </button>
          )
        })}
        <span className="flex items-center gap-1.5 text-xs text-indigo-600 font-medium pl-2 ml-1 border-l border-slate-200">
          <svg width="22" height="10" viewBox="0 0 22 10">
            <line x1="0" y1="5" x2="22" y2="5" stroke="#4f46e5" strokeWidth="2.5"/>
            <circle cx="11" cy="5" r="3.5" fill="#4f46e5"/>
          </svg>
          Cumulative PPV
        </span>
      </div>

      {hidden.size > 0 && (
        <p className="text-center text-[11px] text-slate-400 mt-1">
          {hidden.size} planta{hidden.size > 1 ? 's' : ''} oculta{hidden.size > 1 ? 's' : ''} — haz clic para mostrarla
        </p>
      )}
    </div>
  )
}
