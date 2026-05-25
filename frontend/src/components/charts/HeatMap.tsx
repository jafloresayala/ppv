// src/components/charts/HeatMap.tsx
// Canvas2D correlation matrix heatmap
import { useEffect, useRef, useState } from 'react'
import type { CorrelationMatrix } from '../../types/api.types'

interface Props { data: CorrelationMatrix; height?: number }

function lerp3(t: number, c1: [number,number,number], cm: [number,number,number], c2: [number,number,number]): string {
  const half = 0.5
  let r, g, b
  if (t < half) {
    const s = t / half
    r = c1[0] + (cm[0] - c1[0]) * s
    g = c1[1] + (cm[1] - c1[1]) * s
    b = c1[2] + (cm[2] - c1[2]) * s
  } else {
    const s = (t - half) / half
    r = cm[0] + (c2[0] - cm[0]) * s
    g = cm[1] + (c2[1] - cm[1]) * s
    b = cm[2] + (c2[2] - cm[2]) * s
  }
  return `rgb(${r|0},${g|0},${b|0})`
}

// RdBu: -1 → blue, 0 → white, +1 → red
function corrColor(v: number) {
  const t = (v + 1) / 2
  return lerp3(t, [59,130,246], [248,250,252], [239,68,68])
}

export default function HeatMap({ data, height }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const wrapRef   = useRef<HTMLDivElement>(null)
  const [tip, setTip] = useState<{ x: number; y: number; text: string } | null>(null)
  const n = data.labels.length
  const autoH = height ?? Math.max(200, n * 36 + 80)

  const draw = () => {
    const canvas = canvasRef.current; const wrap = wrapRef.current
    if (!canvas || !wrap || !n) return
    const dpr = window.devicePixelRatio || 1
    const W   = wrap.clientWidth; const H = autoH
    canvas.width = W * dpr; canvas.height = H * dpr
    canvas.style.width = W + 'px'; canvas.style.height = H + 'px'
    const ctx = canvas.getContext('2d')!
    ctx.scale(dpr, dpr); ctx.clearRect(0, 0, W, H)

    const PAD = { t: 12, b: 60, l: 60, r: 12 }
    const availW = W - PAD.l - PAD.r; const availH = H - PAD.t - PAD.b
    const cellW  = availW / n;          const cellH  = availH / n

    data.values.forEach((row, ri) => {
      row.forEach((val, ci) => {
        const cx = PAD.l + ci * cellW; const cy = PAD.t + ri * cellH
        ctx.fillStyle = corrColor(val)
        ctx.fillRect(cx, cy, cellW, cellH)
        ctx.strokeStyle = '#fff'; ctx.lineWidth = 0.5; ctx.strokeRect(cx, cy, cellW, cellH)
        const fs = Math.max(8, Math.min(12, cellW / 4))
        if (cellW > 28) {
          ctx.fillStyle = Math.abs(val) > 0.5 ? '#fff' : '#1e293b'
          ctx.font = `${fs}px Inter,sans-serif`
          ctx.textAlign = 'center'; ctx.textBaseline = 'middle'
          ctx.fillText(val.toFixed(2), cx + cellW / 2, cy + cellH / 2)
        }
      })
    })
    // x labels (bottom)
    ctx.fillStyle = '#64748b'; ctx.font = '10px Inter,sans-serif'; ctx.textAlign = 'center'
    data.labels.forEach((lbl, i) => {
      const x = PAD.l + i * cellW + cellW / 2
      ctx.save(); ctx.translate(x, H - PAD.b + 5)
      ctx.rotate(-Math.PI / 4); ctx.fillText(lbl, 0, 0); ctx.restore()
    })
    // y labels (left)
    ctx.textAlign = 'right'; ctx.textBaseline = 'middle'
    data.labels.forEach((lbl, i) => {
      ctx.fillText(lbl, PAD.l - 5, PAD.t + i * cellH + cellH / 2)
    })
  }

  useEffect(() => {
    draw()
    const ro = new ResizeObserver(draw)
    if (wrapRef.current) ro.observe(wrapRef.current)
    return () => ro.disconnect()
  }, [data, autoH])

  const handleMouseMove = (e: React.MouseEvent) => {
    if (!wrapRef.current || !n) return
    const rect = wrapRef.current.getBoundingClientRect()
    const mx = e.clientX - rect.left; const my = e.clientY - rect.top
    const PAD = { t: 12, b: 60, l: 60, r: 12 }
    const W = wrapRef.current.clientWidth; const H = autoH
    const availW = W - PAD.l - PAD.r; const availH = H - PAD.t - PAD.b
    const ci = Math.floor((mx - PAD.l) / (availW / n))
    const ri = Math.floor((my - PAD.t) / (availH / n))
    if (ci >= 0 && ci < n && ri >= 0 && ri < n) {
      setTip({ x: e.nativeEvent.offsetX + 12, y: e.nativeEvent.offsetY - 10,
               text: `${data.labels[ri]} × ${data.labels[ci]}\nr = ${data.values[ri][ci].toFixed(3)}` })
    } else setTip(null)
  }

  return (
    <div ref={wrapRef} className="chart-wrap relative" style={{ height: autoH }}>
      <canvas ref={canvasRef} onMouseMove={handleMouseMove} onMouseLeave={() => setTip(null)} />
      {tip && <div className="u-tooltip" style={{ left: tip.x, top: tip.y }}>{tip.text}</div>}
    </div>
  )
}
