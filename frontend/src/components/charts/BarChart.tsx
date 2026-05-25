// src/components/charts/BarChart.tsx
// Canvas2D vertical bar chart with sign-based color coding
import { useEffect, useRef, useState } from 'react'

interface BarItem { label: string; value: number }
interface Props {
  data:        BarItem[]
  height?:     number
  title?:      string
  splitIndex?: number            // index where positive group ends and negative begins
  onSelect?:   (item: BarItem | null) => void
  selected?:   string | null
}

const C_GOOD = '#15803d'; const C_BAD = '#b91c1c'; const C_SEL = '#1d4ed8'

export default function BarChart({ data, height = 280, title, splitIndex, onSelect, selected }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const wrapRef   = useRef<HTMLDivElement>(null)
  const hoverRef  = useRef<number>(-1)
  const [tip, setTip] = useState<{ x: number; y: number; label: string; value: number } | null>(null)

  const draw = () => {
    const canvas = canvasRef.current; const wrap = wrapRef.current
    if (!canvas || !wrap || !data.length) return
    const dpr = window.devicePixelRatio || 1
    const W   = wrap.clientWidth; const H = height
    canvas.width = W * dpr; canvas.height = H * dpr
    canvas.style.width = W + 'px'; canvas.style.height = H + 'px'
    const ctx = canvas.getContext('2d')!
    ctx.scale(dpr, dpr)
    ctx.clearRect(0, 0, W, H)

    const PAD = { t: 28, b: 80, l: 60, r: 10 }
    const chartW = W - PAD.l - PAD.r
    const chartH = H - PAD.t - PAD.b
    const n = data.length
    const gapFrac = 0.25
    const barW = (chartW / n) * (1 - gapFrac)
    // Cap scale at 80th-percentile so small bars stay visible; clipped bars get an overflow badge
    const absVals = data.map(d => Math.abs(d.value)).sort((a, b) => a - b)
    const p80     = absVals[Math.max(0, Math.floor(absVals.length * 0.80) - 1)] ?? 0
    const rawMax  = absVals[absVals.length - 1] ?? 1
    const maxV    = (rawMax > p80 * 2 && p80 > 0) ? Math.ceil(p80 * 1.5) : rawMax || 1
    const scale   = chartH / (maxV * 2)
    const zeroY   = PAD.t + chartH / 2

    // Zero line
    ctx.strokeStyle = '#cbd5e1'; ctx.lineWidth = 1; ctx.setLineDash([4, 3])
    ctx.beginPath(); ctx.moveTo(PAD.l, zeroY); ctx.lineTo(W - PAD.r, zeroY); ctx.stroke()
    ctx.setLineDash([])

    // Y axis labels
    ctx.fillStyle = '#94a3b8'; ctx.font = '10px Inter,sans-serif'; ctx.textAlign = 'right'
    for (let t = -1; t <= 1; t += 0.5) {
      const y = zeroY - t * maxV * scale
      const v = (t * maxV)
      ctx.fillText(v >= 1000 ? `$${(v/1000).toFixed(0)}K` : `$${v.toFixed(0)}`, PAD.l - 4, y + 3)
    }

    data.forEach((item, i) => {
      const x        = PAD.l + i * (chartW / n) + (chartW / n) * gapFrac / 2
      const clipped  = Math.abs(item.value) > maxV
      const effVal   = clipped ? (item.value > 0 ? maxV : -maxV) : item.value
      const bh = Math.abs(effVal) * scale
      const y  = effVal >= 0 ? zeroY : zeroY - bh

      const isHover  = hoverRef.current === i
      const isSelect = selected === item.label

      ctx.fillStyle = isSelect ? C_SEL : (item.value > 0 ? C_BAD : C_GOOD)
      if (isHover) { ctx.globalAlpha = 0.75 }
      ctx.beginPath()
      if (ctx.roundRect) ctx.roundRect(x, y, barW, bh, 4); else ctx.rect(x, y, barW, bh)
      ctx.fill()
      ctx.globalAlpha = 1

      // Overflow badge: show real value inside the clipped bar
      if (clipped && barW > 18) {
        const absVal = Math.abs(item.value)
        const fmtV   = absVal >= 1e6 ? `$${(absVal / 1e6).toFixed(1)}M` : `$${(absVal / 1e3).toFixed(0)}K`
        const midX   = x + barW / 2
        const isPos  = item.value > 0
        const badgeY = isPos ? (H - PAD.b - 10) : (PAD.t + 10)
        ctx.save()
        ctx.font = 'bold 9px Inter,sans-serif'
        const tw = ctx.measureText(fmtV).width + 8
        ctx.fillStyle = isPos ? 'rgba(185,28,28,0.85)' : 'rgba(21,128,61,0.85)'
        ctx.beginPath()
        if (ctx.roundRect) ctx.roundRect(midX - tw / 2, badgeY - 8, tw, 16, 3)
        else ctx.rect(midX - tw / 2, badgeY - 8, tw, 16)
        ctx.fill()
        ctx.fillStyle = '#fff'
        ctx.textAlign = 'center'; ctx.textBaseline = 'middle'
        ctx.fillText(fmtV, midX, badgeY)
        ctx.restore()
      }

      // X label – rotated –45° so long names don't overlap
      ctx.save()
      ctx.fillStyle = isSelect ? '#1e40af' : (isHover ? '#334155' : '#64748b')
      ctx.font = '10px Inter,sans-serif'
      ctx.textAlign = 'right'
      ctx.translate(x + barW / 2, H - PAD.b + 10)
      ctx.rotate(-Math.PI / 4)
      const lbl = item.label.length > 16 ? item.label.slice(0, 15) + '…' : item.label
      ctx.fillText(lbl, 0, 0)
      ctx.restore()
    })
    if (title) {
      ctx.fillStyle = '#1e293b'; ctx.font = 'bold 12px Inter,sans-serif'; ctx.textAlign = 'left'
      ctx.fillText(title, PAD.l, 14)
    }

    // Dashed divider + section labels between Unfavorable / Favorable groups
    if (splitIndex !== undefined && splitIndex > 0 && splitIndex < n) {
      const sx = PAD.l + splitIndex * (chartW / n)

      ctx.strokeStyle = '#94a3b8'; ctx.lineWidth = 1.5; ctx.setLineDash([5, 3])
      ctx.beginPath(); ctx.moveTo(sx, PAD.t); ctx.lineTo(sx, H - PAD.b); ctx.stroke()
      ctx.setLineDash([])

      ctx.font = 'bold 10px Inter,sans-serif'; ctx.textBaseline = 'alphabetic'
      const unfavCx = PAD.l + (splitIndex / 2) * (chartW / n)
      ctx.fillStyle = '#b91c1c'; ctx.textAlign = 'center'
      ctx.fillText('▲ Unfavorable', unfavCx, PAD.t - 6)

      const favCx = sx + ((n - splitIndex) / 2) * (chartW / n)
      ctx.fillStyle = '#15803d'; ctx.textAlign = 'center'
      ctx.fillText('▼ Favorable', favCx, PAD.t - 6)
    }
  }

  useEffect(() => {
    draw()
    const ro = new ResizeObserver(draw)
    if (wrapRef.current) ro.observe(wrapRef.current)
    return () => ro.disconnect()
  }, [data, selected])

  const handleClick = (e: React.MouseEvent) => {
    if (!onSelect || !wrapRef.current || !data.length) return
    const rect = wrapRef.current.getBoundingClientRect()
    const mx = e.clientX - rect.left
    const W  = wrapRef.current.clientWidth
    const PAD = { l: 60, r: 10 }
    const n = data.length; const gapFrac = 0.25
    const chartW = W - PAD.l - PAD.r
    const idx = Math.floor((mx - PAD.l) / (chartW / n))
    if (idx >= 0 && idx < n) onSelect(data[idx])
    else onSelect(null)
  }

  const handleMouseMove = (e: React.MouseEvent) => {
    if (!wrapRef.current || !data.length) return
    const rect = wrapRef.current.getBoundingClientRect()
    const mx = e.clientX - rect.left
    const W  = wrapRef.current.clientWidth
    const PAD = { l: 60, r: 10 }
    const n = data.length
    const chartW = W - PAD.l - PAD.r
    const idx = Math.floor((mx - PAD.l) / (chartW / n))
    if (idx !== hoverRef.current) { hoverRef.current = idx; draw() }
    if (idx >= 0 && idx < n) {
      setTip({ x: e.nativeEvent.offsetX + 12, y: e.nativeEvent.offsetY - 48, label: data[idx].label, value: data[idx].value })
    } else setTip(null)
  }

  return (
    <div ref={wrapRef} className="chart-wrap cursor-pointer" style={{ height }}>
      <canvas ref={canvasRef} onClick={handleClick} onMouseMove={handleMouseMove} onMouseLeave={() => { hoverRef.current = -1; draw(); setTip(null) }} />
      {tip && (
        <div className="u-tooltip" style={{ left: tip.x, top: tip.y }}>
          {`${tip.label}\n$${tip.value.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`}
        </div>
      )}
    </div>
  )
}
