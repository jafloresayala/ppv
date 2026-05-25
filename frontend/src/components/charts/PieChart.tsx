// src/components/charts/PieChart.tsx
// Canvas2D donut / pie chart
import { useEffect, useRef, useState } from 'react'

export interface PieItem { label: string; value: number }

const PALETTE = [
  '#1d4ed8','#15803d','#b91c1c','#b45309','#7c3aed','#0e7490',
  '#be123c','#4d7c0f','#c2410c','#1e40af',
]

interface Props { data: PieItem[]; height?: number; donut?: boolean; title?: string }

export default function PieChart({ data, height = 220, donut = true, title }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const wrapRef   = useRef<HTMLDivElement>(null)
  const [tip, setTip] = useState<{ x: number; y: number; text: string } | null>(null)
  const slicesRef = useRef<{ startAngle: number; endAngle: number; label: string }[]>([])

  const draw = () => {
    const canvas = canvasRef.current; const wrap = wrapRef.current
    if (!canvas || !wrap || !data.length) return
    const dpr = window.devicePixelRatio || 1
    const W   = wrap.clientWidth; const H = height
    canvas.width = W * dpr; canvas.height = H * dpr
    canvas.style.width = W + 'px'; canvas.style.height = H + 'px'
    const ctx = canvas.getContext('2d')!
    ctx.scale(dpr, dpr); ctx.clearRect(0, 0, W, H)

    const total = data.reduce((s, d) => s + Math.abs(d.value), 0)
    if (!total) return

    const LEG_W = 130
    const cx    = (W - LEG_W) / 2; const cy = H / 2
    const R     = Math.min(cx, cy) - 16
    const iR    = donut ? R * 0.52 : 0

    let angle = -Math.PI / 2
    slicesRef.current = []

    data.forEach((item, i) => {
      const sweep = (Math.abs(item.value) / total) * Math.PI * 2
      ctx.beginPath()
      ctx.moveTo(cx, cy)
      ctx.arc(cx, cy, R, angle, angle + sweep)
      if (donut) ctx.arc(cx, cy, iR, angle + sweep, angle, true)
      ctx.closePath()
      ctx.fillStyle = PALETTE[i % PALETTE.length]
      ctx.fill()
      ctx.strokeStyle = '#fff'; ctx.lineWidth = 2; ctx.stroke()

      slicesRef.current.push({ startAngle: angle, endAngle: angle + sweep, label: item.label })
      angle += sweep
    })

    // Center label
    if (donut && title) {
      ctx.fillStyle = '#1e293b'; ctx.font = 'bold 11px Inter,sans-serif'
      ctx.textAlign = 'center'; ctx.textBaseline = 'middle'
      ctx.fillText(title, cx, cy)
    }

    // Legend
    data.slice(0, 8).forEach((item, i) => {
      const lx = W - LEG_W + 4; const ly = 18 + i * 22
      ctx.fillStyle = PALETTE[i % PALETTE.length]
      ctx.beginPath(); if (ctx.roundRect) ctx.roundRect(lx, ly, 12, 12, 3); else ctx.rect(lx, ly, 12, 12); ctx.fill()
      ctx.fillStyle = '#475569'; ctx.font = '10px Inter,sans-serif'
      ctx.textAlign = 'left'; ctx.textBaseline = 'top'
      const pct = ((Math.abs(item.value) / total) * 100).toFixed(1)
      const lbl = item.label.length > 13 ? item.label.slice(0, 12) + '…' : item.label
      ctx.fillText(`${lbl} (${pct}%)`, lx + 16, ly)
    })
  }

  useEffect(() => {
    draw()
    const ro = new ResizeObserver(draw)
    if (wrapRef.current) ro.observe(wrapRef.current)
    return () => ro.disconnect()
  }, [data, height, donut, title])

  const getSlice = (e: React.MouseEvent) => {
    if (!wrapRef.current) return null
    const rect = wrapRef.current.getBoundingClientRect()
    const mx = e.clientX - rect.left; const my = e.clientY - rect.top
    const W  = wrapRef.current.clientWidth; const H = height
    const LEG_W = 130; const cx = (W - LEG_W) / 2; const cy = H / 2
    const R = Math.min(cx, cy) - 16; const iR = donut ? R * 0.52 : 0
    const dx = mx - cx; const dy = my - cy; const dist = Math.sqrt(dx * dx + dy * dy)
    if (dist > R || dist < iR) return null
    let a = Math.atan2(dy, dx) - (-Math.PI / 2)
    if (a < 0) a += Math.PI * 2
    return slicesRef.current.find(s => {
      let sa = s.startAngle + Math.PI / 2; let ea = s.endAngle + Math.PI / 2
      if (sa < 0) { sa += Math.PI * 2; ea += Math.PI * 2 }
      return a >= sa && a <= ea
    }) ?? null
  }

  return (
    <div ref={wrapRef} className="chart-wrap" style={{ height }}>
      <canvas
        ref={canvasRef}
        onMouseMove={e => {
          const s = getSlice(e)
          const item = s ? data.find(d => d.label === s.label) : null
          if (item) setTip({ x: e.nativeEvent.offsetX + 10, y: e.nativeEvent.offsetY - 10,
            text: `${item.label}\n$${item.value.toLocaleString(undefined, { minimumFractionDigits: 2 })}` })
          else setTip(null)
        }}
        onMouseLeave={() => setTip(null)}
      />
      {tip && <div className="u-tooltip" style={{ left: tip.x, top: tip.y }}>{tip.text}</div>}
    </div>
  )
}
