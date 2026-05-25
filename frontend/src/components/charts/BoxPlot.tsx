// src/components/charts/BoxPlot.tsx
// Canvas2D box-and-whisker plot — multiple groups side by side
import { useEffect, useRef, useState } from 'react'
import type { BoxStats } from '../../types/api.types'

interface Props { data: BoxStats[]; height?: number; onSelect?: (group: string | null) => void }

const C_BAD = '#b91c1c'; const C_GOOD = '#15803d'

export default function BoxPlot({ data, height = 320, onSelect }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const wrapRef   = useRef<HTMLDivElement>(null)
  const [tip, setTip] = useState<{ x: number; y: number; text: string } | null>(null)

  const draw = () => {
    const canvas = canvasRef.current; const wrap = wrapRef.current
    if (!canvas || !wrap || !data.length) return
    const dpr = window.devicePixelRatio || 1
    const W   = wrap.clientWidth; const H = height
    canvas.width = W * dpr; canvas.height = H * dpr
    canvas.style.width = W + 'px'; canvas.style.height = H + 'px'
    const ctx = canvas.getContext('2d')!
    ctx.scale(dpr, dpr); ctx.clearRect(0, 0, W, H)

    const PAD = { t: 16, b: 55, l: 70, r: 10 }
    const cW  = W - PAD.l - PAD.r; const cH = H - PAD.t - PAD.b
    const allVals = data.flatMap(d => [d.min, d.max, d.q1, d.q3, d.median])
    const vMin = Math.min(...allVals, 0); const vMax = Math.max(...allVals, 0)
    const vPad = (vMax - vMin) * 0.15 || 1
    const scaledMin = vMin - vPad; const scaledMax = vMax + vPad
    const scale = cH / (scaledMax - scaledMin + 1e-9)
    const py = (v: number) => PAD.t + cH - (v - scaledMin) * scale
    const zeroY = py(0)

    // zero line
    ctx.strokeStyle = '#94a3b8'; ctx.lineWidth = 1; ctx.setLineDash([4, 3])
    ctx.beginPath(); ctx.moveTo(PAD.l, zeroY); ctx.lineTo(W - PAD.r, zeroY); ctx.stroke()
    ctx.setLineDash([])

    // Y axis labels
    ctx.fillStyle = '#94a3b8'; ctx.font = '9px Inter,sans-serif'; ctx.textAlign = 'right'
    const step = (scaledMax - scaledMin) / 5
    for (let i = 0; i <= 5; i++) {
      const v = scaledMin + i * step; const y = py(v)
      const fmt = Math.abs(v) >= 1e3 ? `$${(v/1e3).toFixed(0)}K` : `$${v.toFixed(0)}`
      ctx.fillText(fmt, PAD.l - 4, y + 3)
    }

    const boxW = Math.max(16, Math.min(50, cW / data.length - 10))
    data.forEach((d, i) => {
      const cx = PAD.l + (i + 0.5) * (cW / data.length)
      const q1y = py(d.q1); const q3y = py(d.q3); const medy = py(d.median)
      const miny = py(d.min); const maxy = py(d.max)
      const color = d.median > 0 ? C_BAD : C_GOOD

      // box
      ctx.fillStyle = color + '25'
      ctx.fillRect(cx - boxW / 2, q3y, boxW, q1y - q3y)
      ctx.strokeStyle = color; ctx.lineWidth = 1.5
      ctx.strokeRect(cx - boxW / 2, q3y, boxW, q1y - q3y)

      // median line
      ctx.beginPath(); ctx.moveTo(cx - boxW / 2, medy); ctx.lineTo(cx + boxW / 2, medy)
      ctx.strokeStyle = color; ctx.lineWidth = 2.5; ctx.stroke()

      // whiskers
      ctx.strokeStyle = color; ctx.lineWidth = 1.2
      ctx.beginPath()
      ctx.moveTo(cx, q3y); ctx.lineTo(cx, maxy)
      ctx.moveTo(cx - boxW / 4, maxy); ctx.lineTo(cx + boxW / 4, maxy)
      ctx.moveTo(cx, q1y);  ctx.lineTo(cx, miny)
      ctx.moveTo(cx - boxW / 4, miny); ctx.lineTo(cx + boxW / 4, miny)
      ctx.stroke()

      // outliers (only draw those within visible Y range)
      d.outliers.forEach(ov => {
        const oy = py(ov)
        if (oy < PAD.t || oy > PAD.t + cH) return
        ctx.beginPath(); ctx.arc(cx, oy, 3, 0, Math.PI * 2)
        ctx.fillStyle = '#f97316'; ctx.fill()
      })

      // x label
      ctx.fillStyle = '#475569'; ctx.font = '9px Inter,sans-serif'; ctx.textAlign = 'center'
      const lbl = d.group.length > 12 ? d.group.slice(0, 11) + '…' : d.group
      ctx.save(); ctx.translate(cx, H - PAD.b + 8); ctx.rotate(-Math.PI / 5)
      ctx.fillText(lbl, 0, 0); ctx.restore()
    })
  }

  useEffect(() => {
    draw()
    const ro = new ResizeObserver(draw)
    if (wrapRef.current) ro.observe(wrapRef.current)
    return () => ro.disconnect()
  }, [data, height])

  const getGroup = (e: React.MouseEvent): string | null => {
    if (!wrapRef.current) return null
    const rect = wrapRef.current.getBoundingClientRect()
    const mx   = e.clientX - rect.left
    const PAD  = { l: 70, r: 10 }; const cW = wrapRef.current.clientWidth - PAD.l - PAD.r
    const i    = Math.floor((mx - PAD.l) / (cW / data.length))
    return i >= 0 && i < data.length ? data[i].group : null
  }

  return (
    <div ref={wrapRef} className="chart-wrap cursor-pointer" style={{ height }}>
      <canvas
        ref={canvasRef}
        onClick={e => onSelect?.(getGroup(e))}
        onMouseMove={e => {
          const g = getGroup(e)
          if (g) {
            const d = data.find(x => x.group === g)!
            setTip({ x: e.nativeEvent.offsetX + 10, y: e.nativeEvent.offsetY - 10,
              text: `${g}\nMedian: $${d.median.toLocaleString(undefined,{minimumFractionDigits:0})}\nQ1: $${d.q1.toLocaleString()}\nQ3: $${d.q3.toLocaleString()}\nOutliers: ${d.outliers.length}` })
          } else setTip(null)
        }}
        onMouseLeave={() => setTip(null)}
      />
      {tip && <div className="u-tooltip" style={{ left: tip.x, top: tip.y }}>{tip.text}</div>}
    </div>
  )
}
