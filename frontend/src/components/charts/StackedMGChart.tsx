// src/components/charts/StackedMGChart.tsx
// Stacked bar chart: X = material groups, stacks = plants (color-coded)
// Shows how each plant contributes to each material group's PPV
import { useEffect, useRef, useState, useCallback } from 'react'
import { PLANT_FLAGS, PLANT_NAMES, PLANT_COLORS } from '../../utils/plants'

interface Props {
  labels:    string[]                    // material group names
  byPlant:   Record<string, number[]>   // plant -> value per group index
  height?:   number
  selected?: string | null
  onSelect?: (label: string | null) => void
}

const PAD  = { l: 72, r: 20, t: 24, b: 92 }
const GRID = 5

const fmtK = (v: number) => {
  const abs = Math.abs(v)
  if (abs >= 1_000_000) return `$${(v / 1_000_000).toFixed(1)}M`
  if (abs >= 1_000)     return `$${(v / 1_000).toFixed(0)}K`
  return `$${v.toFixed(0)}`
}

interface TipState {
  cx: number
  cy: number
  label: string
  items: { plant: string; value: number }[]
  total: number
}

export default function StackedMGChart({ labels, byPlant, height = 400, selected, onSelect }: Props) {
  const wrapRef   = useRef<HTMLDivElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const [hidden, setHidden] = useState<Set<string>>(new Set())
  const [tip, setTip]       = useState<TipState | null>(null)

  const allPlants = Object.keys(byPlant).sort()
  const plants    = allPlants.filter(p => !hidden.has(p))

  const togglePlant = (p: string) =>
    setHidden(prev => {
      const next = new Set(prev)
      next.has(p) ? next.delete(p) : next.add(p)
      return next
    })

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
    const barW = Math.max(6, step * 0.72)

    // Y-axis scale from visible plants
    const posSums = labels.map((_, i) =>
      plants.reduce((s, p) => s + Math.max(0, byPlant[p]?.[i] ?? 0), 0))
    const negSums = labels.map((_, i) =>
      plants.reduce((s, p) => s + Math.min(0, byPlant[p]?.[i] ?? 0), 0))
    const yMax   = Math.max(1, ...posSums) * 1.12
    const yMin   = Math.min(-1, ...negSums) * 1.12
    const yRange = yMax - yMin
    const toY    = (v: number) => PAD.t + cH * (1 - (v - yMin) / yRange)
    const y0     = toY(0)

    ctx.clearRect(0, 0, w, H)

    // Grid lines + left labels
    ctx.font      = '10.5px system-ui, sans-serif'
    ctx.textAlign = 'right'
    for (let g = 0; g <= GRID; g++) {
      const val = yMin + (yRange * g) / GRID
      const gy  = toY(val)
      ctx.strokeStyle = '#e2e8f0'; ctx.lineWidth = 1
      ctx.beginPath(); ctx.moveTo(PAD.l, gy); ctx.lineTo(PAD.l + cW, gy); ctx.stroke()
      ctx.fillStyle = '#64748b'
      ctx.fillText(fmtK(val), PAD.l - 5, gy + 3.5)
    }

    // Zero line
    ctx.strokeStyle = '#94a3b8'; ctx.lineWidth = 1.5
    ctx.beginPath(); ctx.moveTo(PAD.l, y0); ctx.lineTo(PAD.l + cW, y0); ctx.stroke()

    // Stacked bars
    labels.forEach((lbl, i) => {
      const cx = PAD.l + i * step + step / 2
      const isSel = selected === lbl
      let posY = y0
      let negY = y0

      // Selection highlight background
      if (isSel) {
        ctx.fillStyle = 'rgba(79,70,229,0.07)'
        ctx.fillRect(cx - barW / 2 - 3, PAD.t, barW + 6, cH)
      }

      plants.forEach(plant => {
        const val = byPlant[plant]?.[i] ?? 0
        if (val === 0) return
        const barH  = Math.abs(val) / yRange * cH
        const color = PLANT_COLORS[plant] ?? '#94a3b8'
        // Dim slightly when something else is selected
        ctx.fillStyle = (!selected || isSel) ? color : color + '99'

        if (val > 0) {
          posY -= barH
          ctx.fillRect(cx - barW / 2, posY, barW, barH)
          ctx.strokeStyle = 'rgba(255,255,255,0.35)'; ctx.lineWidth = 0.5
          ctx.strokeRect(cx - barW / 2, posY, barW, barH)
        } else {
          ctx.fillRect(cx - barW / 2, negY, barW, barH)
          ctx.strokeStyle = 'rgba(255,255,255,0.35)'; ctx.lineWidth = 0.5
          ctx.strokeRect(cx - barW / 2, negY, barW, barH)
          negY += barH
        }
      })

      // X-axis label (rotated -40°)
      ctx.save()
      ctx.fillStyle  = isSel ? '#4f46e5' : '#475569'
      ctx.font       = isSel ? 'bold 10.5px system-ui, sans-serif' : '10.5px system-ui, sans-serif'
      ctx.textAlign  = 'right'
      ctx.translate(cx, H - PAD.b + 12)
      ctx.rotate(-Math.PI / 4.5)
      ctx.fillText(lbl.length > 20 ? lbl.slice(0, 18) + '…' : lbl, 0, 0)
      ctx.restore()
    })

    // Left axis border
    ctx.strokeStyle = '#cbd5e1'; ctx.lineWidth = 1
    ctx.beginPath(); ctx.moveTo(PAD.l, PAD.t); ctx.lineTo(PAD.l, PAD.t + cH); ctx.stroke()

  }, [labels, byPlant, height, plants, selected])

  useEffect(() => {
    if (!wrapRef.current) return
    draw(wrapRef.current.clientWidth || 800)
    const ro = new ResizeObserver(() => {
      if (wrapRef.current) draw(wrapRef.current.clientWidth)
    })
    ro.observe(wrapRef.current)
    return () => ro.disconnect()
  }, [draw])

  function handleMouseMove(e: React.MouseEvent<HTMLCanvasElement>) {
    const canvas = canvasRef.current
    if (!canvas) return
    const rect  = canvas.getBoundingClientRect()
    const mx    = e.clientX - rect.left
    const cW    = rect.width - PAD.l - PAD.r
    const step  = cW / labels.length
    const idx   = Math.floor((mx - PAD.l) / step)
    if (idx < 0 || idx >= labels.length) { setTip(null); return }

    const items = plants
      .map(p => ({ plant: p, value: byPlant[p]?.[idx] ?? 0 }))
      .filter(it => it.value !== 0)
      .sort((a, b) => Math.abs(b.value) - Math.abs(a.value))
    const total = items.reduce((s, it) => s + it.value, 0)
    setTip({ cx: mx, cy: e.clientY - rect.top, label: labels[idx], items, total })
  }

  function handleClick(e: React.MouseEvent<HTMLCanvasElement>) {
    const canvas = canvasRef.current
    if (!canvas) return
    const rect = canvas.getBoundingClientRect()
    const mx   = e.clientX - rect.left
    const cW   = rect.width - PAD.l - PAD.r
    const step = cW / labels.length
    const idx  = Math.floor((mx - PAD.l) / step)
    if (idx < 0 || idx >= labels.length) { onSelect?.(null); return }
    onSelect?.(selected === labels[idx] ? null : labels[idx])
  }

  return (
    <div ref={wrapRef} className="relative select-none">
      <canvas
        ref={canvasRef}
        style={{ display: 'block', cursor: 'pointer' }}
        onMouseMove={handleMouseMove}
        onMouseLeave={() => setTip(null)}
        onClick={handleClick}
      />

      {/* Tooltip */}
      {tip && tip.items.length > 0 && (
        <div
          className="pointer-events-none absolute z-20 bg-white border border-slate-200 rounded-xl shadow-xl px-3 py-2.5 text-xs min-w-[190px]"
          style={{
            left: tip.cx + 14,
            top:  Math.max(4, tip.cy - 16),
            transform: tip.cx > (canvasRef.current?.getBoundingClientRect().width ?? 600) * 0.6
              ? 'translateX(-110%)' : undefined,
          }}
        >
          <p className="font-bold text-slate-700 mb-1.5 border-b border-slate-100 pb-1 max-w-[220px] truncate">
            {tip.label}
          </p>
          {tip.items.map(it => (
            <div key={it.plant} className="flex items-center justify-between gap-3 py-0.5">
              <span className="flex items-center gap-1.5">
                <span className="w-2.5 h-2.5 rounded-sm shrink-0" style={{ background: PLANT_COLORS[it.plant] ?? '#94a3b8' }} />
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
            <span>Total</span>
            <span className={tip.total > 0 ? 'text-red-600' : 'text-green-600'}>{fmtK(tip.total)}</span>
          </div>
        </div>
      )}

      {/* Legend / plant pills */}
      <div className="flex flex-wrap gap-2 mt-3 justify-center items-center">
        {allPlants.map(p => {
          const isHidden = hidden.has(p)
          const color    = PLANT_COLORS[p] ?? '#94a3b8'
          return (
            <button
              key={p}
              type="button"
              onClick={() => togglePlant(p)}
              title={isHidden ? `Show ${PLANT_NAMES[p] ?? p}` : `Hide ${PLANT_NAMES[p] ?? p}`}
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
      </div>

      {hidden.size > 0 && (
        <p className="text-center text-[11px] text-slate-400 mt-1">
          {hidden.size} plant{hidden.size > 1 ? 's' : ''} hidden — click to show
        </p>
      )}
    </div>
  )
}
