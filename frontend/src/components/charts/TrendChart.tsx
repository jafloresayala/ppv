// src/components/charts/TrendChart.tsx
// Dual-axis canvas: colored bars (Net PPV) on left axis + cumulative line on right axis.
// Visually identical to StackedBarChart (same PAD, same axis style, same cumulative line).
import { useEffect, useRef, useState, useCallback } from 'react'
import type { TrendData } from '../../types/api.types'

interface TooltipInfo {
  cx: number
  cy: number
  label: string
  value: number
  cumulative: number
}

interface Props { data: TrendData; height?: number; onBarClick?: (label: string) => void }

const PAD   = { l: 78, r: 76, t: 20, b: 52 }
const GRID  = 6
const C_POS = '#ef4444'  // unfavorable (positive PPV = bad)
const C_NEG = '#22c55e'  // favorable   (negative PPV = good)
const C_CUM = '#4f46e5'  // cumulative line
const C_RAX = '#6366f1'  // right axis labels / title

const fmtK = (v: number) => {
  const abs = Math.abs(v)
  if (abs >= 1_000_000) return `$${(v / 1_000_000).toFixed(1)}M`
  if (abs >= 1_000)     return `$${(v / 1_000).toFixed(0)}K`
  return `$${v.toFixed(0)}`
}

const fmtUSD = (v: number) =>
  `$${v.toLocaleString(undefined, { minimumFractionDigits: 0, maximumFractionDigits: 0 })}`

export default function TrendChart({ data, height = 340, onBarClick }: Props) {
  const wrapRef   = useRef<HTMLDivElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const [tip, setTip] = useState<TooltipInfo | null>(null)

  const draw = useCallback((w: number) => {
    const canvas = canvasRef.current
    if (!canvas || !data.labels.length) return
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
    const step = cW / data.labels.length
    const barW = Math.max(4, step * 0.68)

    // LEFT axis scale (bars)
    const yMax   = Math.max(1, ...data.values.map(v => Math.max(0, v))) * 1.12
    const yMin   = Math.min(-1, ...data.values.map(v => Math.min(0, v))) * 1.12
    const yRange = yMax - yMin
    const toY    = (v: number) => PAD.t + cH * (1 - (v - yMin) / yRange)
    const y0     = toY(0)

    // RIGHT axis scale (cumulative)
    const rMax   = Math.max(1, ...data.cumulative) * 1.12
    const rMin   = Math.min(-1, ...data.cumulative) * 1.12
    const rRange = rMax - rMin
    const toYR   = (v: number) => PAD.t + cH * (1 - (v - rMin) / rRange)

    ctx.clearRect(0, 0, w, H)

    // LEFT axis tick labels (no grid lines)
    ctx.font      = '10.5px system-ui, sans-serif'
    ctx.textAlign = 'right'
    ctx.fillStyle = '#64748b'
    for (let g = 0; g <= GRID; g++) {
      const val = yMin + (yRange * g) / GRID
      ctx.fillText(fmtK(val), PAD.l - 5, toY(val) + 3.5)
    }

    // RIGHT axis tick labels
    ctx.textAlign = 'left'
    ctx.fillStyle = C_RAX
    for (let g = 0; g <= GRID; g++) {
      const val = rMin + (rRange * g) / GRID
      ctx.fillText(fmtK(val), PAD.l + cW + 6, toYR(val) + 3.5)
    }

    // zero line
    ctx.strokeStyle = '#94a3b8'; ctx.lineWidth = 1.5
    ctx.beginPath(); ctx.moveTo(PAD.l, y0); ctx.lineTo(PAD.l + cW, y0); ctx.stroke()

    // bars
    data.labels.forEach((_lbl, i) => {
      const val = data.values[i]
      if (val === 0) return
      const cx   = PAD.l + i * step + step / 2
      const barH = Math.abs(val) / yRange * cH
      ctx.fillStyle = val > 0 ? C_POS : C_NEG
      ctx.fillRect(cx - barW / 2, val > 0 ? y0 - barH : y0, barW, barH)
      ctx.strokeStyle = 'rgba(255,255,255,0.35)'; ctx.lineWidth = 0.5
      ctx.strokeRect(cx - barW / 2, val > 0 ? y0 - barH : y0, barW, barH)
    })

    // x-axis labels
    ctx.fillStyle = '#64748b'
    ctx.font      = '10.5px system-ui, sans-serif'
    ctx.textAlign = 'center'
    data.labels.forEach((lbl, i) => {
      ctx.fillText(lbl, PAD.l + i * step + step / 2, H - PAD.b + 15)
    })

    // axis borders
    ctx.strokeStyle = '#cbd5e1'; ctx.lineWidth = 1
    ctx.beginPath(); ctx.moveTo(PAD.l, PAD.t); ctx.lineTo(PAD.l, PAD.t + cH); ctx.stroke()
    ctx.strokeStyle = '#a5b4fc'; ctx.lineWidth = 1
    ctx.beginPath(); ctx.moveTo(PAD.l + cW, PAD.t); ctx.lineTo(PAD.l + cW, PAD.t + cH); ctx.stroke()

    // cumulative line (right axis) — identical to StackedBarChart
    ctx.save()
    ctx.strokeStyle = C_CUM; ctx.lineWidth = 2.5; ctx.lineJoin = 'round'
    ctx.beginPath()
    data.cumulative.forEach((v, i) => {
      const cx = PAD.l + i * step + step / 2
      i === 0 ? ctx.moveTo(cx, toYR(v)) : ctx.lineTo(cx, toYR(v))
    })
    ctx.stroke()
    ctx.fillStyle = C_CUM
    data.cumulative.forEach((v, i) => {
      const cx = PAD.l + i * step + step / 2
      ctx.beginPath(); ctx.arc(cx, toYR(v), 3.5, 0, Math.PI * 2); ctx.fill()
    })

    // right axis rotated title — identical to StackedBarChart
    ctx.font      = '10px system-ui, sans-serif'
    ctx.fillStyle = C_RAX; ctx.textAlign = 'center'
    ctx.translate(w - 11, PAD.t + cH / 2)
    ctx.rotate(-Math.PI / 2)
    ctx.fillText('Cumulative PPV', 0, 0)
    ctx.restore()

  }, [data, height])

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
    const rect = canvas.getBoundingClientRect()
    const mx   = e.clientX - rect.left
    const cW   = rect.width - PAD.l - PAD.r
    const step = cW / data.labels.length
    const idx  = Math.floor((mx - PAD.l) / step)
    if (idx < 0 || idx >= data.labels.length) { setTip(null); return }
    setTip({
      cx: mx, cy: e.clientY - rect.top,
      label: data.labels[idx],
      value: data.values[idx],
      cumulative: data.cumulative[idx],
    })
  }

  function handleClick(e: React.MouseEvent<HTMLCanvasElement>) {
    if (!onBarClick) return
    const canvas = canvasRef.current
    if (!canvas) return
    const rect = canvas.getBoundingClientRect()
    const mx   = e.clientX - rect.left
    const cW   = rect.width - PAD.l - PAD.r
    const step = cW / data.labels.length
    const idx  = Math.floor((mx - PAD.l) / step)
    if (idx < 0 || idx >= data.labels.length) return
    onBarClick(data.labels[idx])
  }

  return (
    <div ref={wrapRef} className="relative select-none">
      <canvas
        ref={canvasRef}
        style={{ display: 'block', cursor: onBarClick ? 'pointer' : 'crosshair' }}
        onMouseMove={handleMouseMove}
        onMouseLeave={() => setTip(null)}
        onClick={handleClick}
      />

      {tip && (
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
          <p className="font-bold text-slate-700 mb-1.5 border-b border-slate-100 pb-1">{tip.label}</p>
          <div className="flex justify-between gap-3 py-0.5">
            <span className="text-slate-600">Net PPV</span>
            <span className={`font-semibold ${tip.value > 0 ? 'text-red-600' : 'text-green-600'}`}>
              {fmtUSD(tip.value)}
            </span>
          </div>
          <div className="flex justify-between gap-3 pt-1 border-t border-slate-100 mt-1">
            <span className="text-indigo-600 font-semibold">Cumulative</span>
            <span className={`font-semibold ${tip.cumulative > 0 ? 'text-red-600' : 'text-green-600'}`}>
              {fmtUSD(tip.cumulative)}
            </span>
          </div>
          {onBarClick && (
            <p className="text-[10px] text-slate-400 mt-1.5 border-t border-slate-100 pt-1">Click to see records</p>
          )}
        </div>
      )}

      <div className="flex flex-wrap gap-4 mt-3 justify-center items-center text-xs">
        <span className="flex items-center gap-1.5 font-medium" style={{ color: C_POS }}>
          <span className="w-3 h-3 rounded-sm inline-block" style={{ background: C_POS }} />
          Unfavorable PPV
        </span>
        <span className="flex items-center gap-1.5 font-medium" style={{ color: C_NEG }}>
          <span className="w-3 h-3 rounded-sm inline-block" style={{ background: C_NEG }} />
          Favorable PPV
        </span>
        <span className="flex items-center gap-1.5 font-medium pl-2 ml-1 border-l border-slate-200" style={{ color: C_CUM }}>
          <svg width="22" height="10" viewBox="0 0 22 10">
            <line x1="0" y1="5" x2="22" y2="5" stroke={C_CUM} strokeWidth="2.5" />
            <circle cx="11" cy="5" r="3.5" fill={C_CUM} />
          </svg>
          Cumulative PPV
        </span>
      </div>
    </div>
  )
}
