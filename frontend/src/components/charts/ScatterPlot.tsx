// src/components/charts/ScatterPlot.tsx
// Canvas2D scatter with optional KNN decision-region background
import { useEffect, useRef, useState } from 'react'
import type { KnnGrid, VendorRow } from '../../types/api.types'

interface Props {
  vendors:   VendorRow[]
  knnGrid:   KnnGrid | null
  onSelect?: (name: string | null) => void
  selected?: string | null
  height?:   number
}

const REGION_COLORS = [
  'rgba(21,128,61,0.22)',   // 0 = favorable
  'rgba(100,116,139,0.15)', // 1 = neutral
  'rgba(185,28,28,0.22)',   // 2 = unfavorable
]

export default function ScatterPlot({ vendors, knnGrid, onSelect, selected, height = 340 }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const wrapRef   = useRef<HTMLDivElement>(null)
  const tooltipRef = useRef<HTMLDivElement>(null)
  const [tip, setTip] = useState<{ x: number; y: number; v: VendorRow } | null>(null)

  const proj = (val: number, min: number, max: number, pMin: number, pMax: number) =>
    ((val - min) / (max - min + 1e-9)) * (pMax - pMin) + pMin

  const draw = () => {
    const canvas = canvasRef.current; const wrap = wrapRef.current
    if (!canvas || !wrap || !vendors.length) return
    const dpr = window.devicePixelRatio || 1
    const W   = wrap.clientWidth; const H = height
    canvas.width = W * dpr; canvas.height = H * dpr
    canvas.style.width = W + 'px'; canvas.style.height = H + 'px'
    const ctx = canvas.getContext('2d')!
    ctx.scale(dpr, dpr); ctx.clearRect(0, 0, W, H)

    const PAD = { t: 20, b: 45, l: 65, r: 15 }
    const cW  = W - PAD.l - PAD.r; const cH = H - PAD.t - PAD.b

    const allRec = vendors.map(v => v.records)
    const allPPV = vendors.map(v => v.total)
    const xMin = Math.min(...allRec), xMax = Math.max(...allRec)
    const yMin = Math.min(...allPPV), yMax = Math.max(...allPPV)

    const px = (rec: number) => PAD.l + proj(rec, xMin, xMax, 0, cW)
    const py = (ppv: number) => PAD.t + cH - proj(ppv, yMin, yMax, 0, cH)

    // KNN background
    if (knnGrid) {
      const gcW = cW / (knnGrid.x.length - 1)
      const gcH = cH / (knnGrid.y.length - 1)
      knnGrid.z.forEach((row, ri) => {
        row.forEach((val, ci) => {
          ctx.fillStyle = REGION_COLORS[val] ?? REGION_COLORS[1]
          ctx.fillRect(
            PAD.l + ci * gcW,
            PAD.t + (knnGrid.y.length - 1 - ri) * gcH,
            gcW + 1, gcH + 1,
          )
        })
      })
    }

    // Axes
    ctx.strokeStyle = '#e2e8f0'; ctx.lineWidth = 1
    ctx.strokeRect(PAD.l, PAD.t, cW, cH)
    // zero line
    if (yMin < 0 && yMax > 0) {
      const zy = py(0)
      ctx.setLineDash([4, 3]); ctx.strokeStyle = '#94a3b8'
      ctx.beginPath(); ctx.moveTo(PAD.l, zy); ctx.lineTo(W - PAD.r, zy); ctx.stroke()
      ctx.setLineDash([])
    }

    // Axis labels
    ctx.fillStyle = '#94a3b8'; ctx.font = '10px Inter,sans-serif'
    ctx.textAlign = 'center'
    ctx.fillText('Number of Records', PAD.l + cW / 2, H - 6)
    ctx.save(); ctx.translate(14, PAD.t + cH / 2); ctx.rotate(-Math.PI / 2)
    ctx.fillText('PPV Total (USD)', 0, 0); ctx.restore()

    // Dots
    vendors.forEach(v => {
      const x   = px(v.records); const y = py(v.total)
      const isSel = selected === v.name
      const color = v.total < 0 ? '#15803d' : (v.total > 0 ? '#b91c1c' : '#64748b')
      ctx.beginPath(); ctx.arc(x, y, isSel ? 8 : 6, 0, Math.PI * 2)
      ctx.fillStyle = isSel ? '#1d4ed8' : color
      ctx.fill()
      ctx.strokeStyle = '#fff'; ctx.lineWidth = 1.5; ctx.stroke()
      // label
      ctx.fillStyle = '#334155'; ctx.font = '8px Inter,sans-serif'; ctx.textAlign = 'center'
      const lbl = v.name.split(' ')[0].slice(0, 10)
      ctx.fillText(lbl, x, y - 9)
    })
  }

  useEffect(() => {
    draw()
    const ro = new ResizeObserver(draw)
    if (wrapRef.current) ro.observe(wrapRef.current)
    return () => ro.disconnect()
  }, [vendors, knnGrid, selected, height])

  const getVendor = (e: React.MouseEvent) => {
    if (!wrapRef.current || !vendors.length) return null
    const rect = wrapRef.current.getBoundingClientRect()
    const mx = e.clientX - rect.left; const my = e.clientY - rect.top
    const PAD = { t: 20, b: 45, l: 65, r: 15 }
    const cW  = wrapRef.current.clientWidth - PAD.l - PAD.r
    const cH  = height - PAD.t - PAD.b
    const allRec = vendors.map(v => v.records); const allPPV = vendors.map(v => v.total)
    const xMin = Math.min(...allRec), xMax = Math.max(...allRec)
    const yMin = Math.min(...allPPV), yMax = Math.max(...allPPV)
    const px = (r: number) => PAD.l + ((r - xMin) / (xMax - xMin + 1e-9)) * cW
    const py = (p: number) => PAD.t + cH - ((p - yMin) / (yMax - yMin + 1e-9)) * cH
    return vendors.find(v => Math.hypot(px(v.records) - mx, py(v.total) - my) < 12) ?? null
  }

  return (
    <div ref={wrapRef} className="chart-wrap relative cursor-pointer" style={{ height }}>
      <canvas
        ref={canvasRef}
        onClick={e => { const v = getVendor(e); onSelect?.(v?.name ?? null) }}
        onMouseMove={e => {
          const v = getVendor(e)
          if (v) setTip({ x: e.nativeEvent.offsetX + 12, y: e.nativeEvent.offsetY - 10, v })
          else   setTip(null)
        }}
        onMouseLeave={() => setTip(null)}
      />
      {tip && (
        <div className="u-tooltip" style={{ left: tip.x, top: tip.y }}>
          <b>{tip.v.name}</b>{`\nPPV: $${tip.v.total.toLocaleString(undefined, { minimumFractionDigits: 2 })}\nRecords: ${tip.v.records}`}
        </div>
      )}
    </div>
  )
}
