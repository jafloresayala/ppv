// src/components/charts/HBarChart.tsx
// Canvas2D horizontal bar chart — ideal for Top-N lists
import { useEffect, useRef, useState } from 'react'

export interface HBarItem { label: string; value: number; sub?: string }
interface Props {
  data:       HBarItem[]
  height?:    number
  title?:     string
  onSelect?:  (item: HBarItem | null) => void
  selected?:  string | null
  maxItems?:  number
}

const C_GOOD = '#15803d'; const C_BAD = '#b91c1c'; const C_SEL = '#1d4ed8'
const fmt = (v: number) => v >= 1e6 ? `$${(v/1e6).toFixed(2)}M` : v >= 1e3 ? `$${(v/1e3).toFixed(1)}K` : `$${v.toFixed(0)}`

export default function HBarChart({ data, height, title, onSelect, selected, maxItems = 20 }: Props) {
  const items    = data.slice(0, maxItems)
  const autoH    = height ?? Math.max(220, items.length * 30 + 40)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const wrapRef   = useRef<HTMLDivElement>(null)
  const hoverRef  = useRef<number>(-1)
  const [tip, setTip] = useState<{ x: number; y: number; item: HBarItem } | null>(null)

  const draw = () => {
    const canvas = canvasRef.current; const wrap = wrapRef.current
    if (!canvas || !wrap || !items.length) return
    const dpr = window.devicePixelRatio || 1
    const W   = wrap.clientWidth; const H = autoH
    canvas.width = W * dpr; canvas.height = H * dpr
    canvas.style.width = W + 'px'; canvas.style.height = H + 'px'
    const ctx = canvas.getContext('2d')!
    ctx.scale(dpr, dpr); ctx.clearRect(0, 0, W, H)

    const LABEL_W = 140; const PAD = { t: title ? 24 : 6, b: 8, r: 70 }
    const chartW  = W - LABEL_W - PAD.r
    const rowH    = (H - PAD.t - PAD.b) / items.length
    const maxAbs  = Math.max(...items.map(d => Math.abs(d.value)), 1)

    if (title) {
      ctx.fillStyle = '#1e293b'; ctx.font = 'bold 12px Inter,sans-serif'
      ctx.textAlign = 'left'; ctx.fillText(title, 0, 16)
    }

    items.forEach((item, i) => {
      const y     = PAD.t + i * rowH
      const bw    = (Math.abs(item.value) / maxAbs) * chartW
      const isHov = hoverRef.current === i
      const isSel = selected === item.label

      // label
      ctx.fillStyle = '#334155'; ctx.font = `${isSel ? 'bold ' : ''}10px Inter,sans-serif`
      ctx.textAlign = 'right'
      const lbl = item.label.length > 20 ? item.label.slice(0, 19) + '…' : item.label
      ctx.fillText(lbl, LABEL_W - 6, y + rowH * 0.62)

      // bar
      ctx.fillStyle = isSel ? C_SEL : (item.value > 0 ? C_BAD : C_GOOD)
      if (isHov) ctx.globalAlpha = 0.72
      const barH = Math.max(rowH * 0.55, 8)
      const by   = y + (rowH - barH) / 2
      ctx.beginPath()
      if (ctx.roundRect) ctx.roundRect(LABEL_W, by, bw, barH, 4)
      else ctx.rect(LABEL_W, by, bw, barH)
      ctx.fill()
      ctx.globalAlpha = 1

      // value label
      ctx.fillStyle = '#475569'; ctx.font = '10px Inter,sans-serif'; ctx.textAlign = 'left'
      ctx.fillText(fmt(item.value), LABEL_W + bw + 5, y + rowH * 0.62)
    })
  }

  useEffect(() => {
    draw()
    const ro = new ResizeObserver(draw)
    if (wrapRef.current) ro.observe(wrapRef.current)
    return () => ro.disconnect()
  }, [items, selected])

  const getIdx = (e: React.MouseEvent) => {
    if (!wrapRef.current) return -1
    const rect = wrapRef.current.getBoundingClientRect()
    const my   = e.clientY - rect.top
    const H    = autoH
    const PAD_T = title ? 24 : 6; const PAD_B = 8
    const rowH = (H - PAD_T - PAD_B) / items.length
    return Math.floor((my - PAD_T) / rowH)
  }

  return (
    <div ref={wrapRef} className="chart-wrap cursor-pointer" style={{ height: autoH }}>
      <canvas
        ref={canvasRef}
        onClick={e => { const i = getIdx(e); onSelect?.(i >= 0 && i < items.length ? items[i] : null) }}
        onMouseMove={e => {
          const i = getIdx(e)
          if (i !== hoverRef.current) { hoverRef.current = i; draw() }
          if (i >= 0 && i < items.length) setTip({ x: e.nativeEvent.offsetX + 14, y: e.nativeEvent.offsetY - 44, item: items[i] })
          else setTip(null)
        }}
        onMouseLeave={() => { hoverRef.current = -1; draw(); setTip(null) }}
      />
      {tip && (
        <div className="u-tooltip" style={{ left: tip.x, top: tip.y }}>
          {`${tip.item.label}${tip.item.sub ? '\n' + tip.item.sub : ''}\n${fmt(tip.item.value)}`}
        </div>
      )}
    </div>
  )
}
