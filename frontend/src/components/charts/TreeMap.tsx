// src/components/charts/TreeMap.tsx
// Canvas2D squarified treemap
import { useEffect, useRef, useState } from 'react'

export interface TreeItem { label: string; value: number; type: 'Favorable' | 'Unfavorable' }
interface Rect { x: number; y: number; w: number; h: number; item: TreeItem }

function squarify(items: TreeItem[], x: number, y: number, w: number, h: number): Rect[] {
  if (!items.length) return []
  const total = items.reduce((s, d) => s + d.value, 0)
  if (total === 0) return []

  const rects: Rect[] = []
  let remaining = [...items].sort((a, b) => b.value - a.value)
  let cx = x, cy = y, cw = w, ch = h

  while (remaining.length) {
    const area = cw * ch
    const batch: TreeItem[] = []
    let batchSum = 0

    for (const item of remaining) {
      const newBatch = [...batch, item]
      const newSum   = batchSum + item.value
      const aspect = (ratio: number) => Math.max(ratio, 1 / ratio)
      const worstBefore = batch.length
        ? Math.max(...batch.map(b => {
            const r = (b.value / batchSum) * area / (cw > ch ? cw : ch)
            return aspect(cw > ch ? cw / r : r / ch)
          }))
        : Infinity
      const worstAfter  = Math.max(...newBatch.map(b => {
        const r = (b.value / newSum) * area / (cw > ch ? cw : ch)
        return aspect(cw > ch ? cw / r : r / ch)
      }))
      if (batch.length && worstAfter > worstBefore) break
      batch.push(item)
      batchSum = newSum
    }

    if (cw >= ch) {
      const colW = (batchSum / total) * cw
      let ey = cy
      batch.forEach(item => {
        const iH = (item.value / batchSum) * ch
        rects.push({ x: cx, y: ey, w: colW, h: iH, item })
        ey += iH
      })
      cx += colW; cw -= colW
    } else {
      const rowH = (batchSum / total) * ch
      let ex = cx
      batch.forEach(item => {
        const iW = (item.value / batchSum) * cw
        rects.push({ x: ex, y: cy, w: iW, h: rowH, item })
        ex += iW
      })
      cy += rowH; ch -= rowH
    }

    remaining = remaining.filter(r => !batch.includes(r))
    if (!batch.length) break
  }
  return rects
}

interface Props { data: TreeItem[]; height?: number; onSelect?: (label: string | null) => void }

export default function TreeMap({ data, height = 300, onSelect }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const wrapRef   = useRef<HTMLDivElement>(null)
  const rectsRef  = useRef<Rect[]>([])
  const hoverRef  = useRef<number>(-1)
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

    const normalised = data.map(d => ({ ...d, value: Math.abs(d.value) }))
    const rects = squarify(normalised, 0, 0, W, H)
    rectsRef.current = rects

    const fmtShort = (v: number) =>
      v >= 1e6 ? `$${(v / 1e6).toFixed(1)}M` : v >= 1e3 ? `$${(v / 1e3).toFixed(0)}K` : `$${v.toFixed(0)}`

    rects.forEach((r, i) => {
      const isHov = hoverRef.current === i
      const isFav = r.item.type === 'Favorable'

      // Background
      ctx.fillStyle = isFav
        ? (isHov ? '#4ade80' : '#bbf7d0')
        : (isHov ? '#f87171' : '#fecaca')
      ctx.fillRect(r.x, r.y, r.w, r.h)

      // Coloured border – green for Favorable, red for Unfavorable
      ctx.strokeStyle = isFav ? '#16a34a' : '#dc2626'
      ctx.lineWidth = isHov ? 2.5 : 1.5
      ctx.strokeRect(r.x + 0.75, r.y + 0.75, r.w - 1.5, r.h - 1.5)

      // Text
      const fntLbl = Math.max(9, Math.min(14, r.w / 7, r.h / 3))
      const fntVal = Math.max(8, Math.min(11, r.w / 9, r.h / 5))
      const textColor = isFav ? '#14532d' : '#7f1d1d'
      const hasVal = r.w > 40 && r.h > 42

      if (r.w > 35 && r.h > 20) {
        const lbl = r.item.label.length > 18 ? r.item.label.slice(0, 17) + '…' : r.item.label
        ctx.fillStyle = textColor
        ctx.font = `bold ${fntLbl}px Inter,sans-serif`
        ctx.textAlign = 'center'; ctx.textBaseline = 'middle'
        ctx.fillText(lbl, r.x + r.w / 2, r.y + r.h / 2 - (hasVal ? fntLbl * 0.7 : 0))

        if (hasVal) {
          ctx.font = `${fntVal}px Inter,sans-serif`
          ctx.fillText(fmtShort(r.item.value), r.x + r.w / 2, r.y + r.h / 2 + fntLbl * 0.7)
        }
      }
    })
  }

  useEffect(() => {
    draw()
    const ro = new ResizeObserver(draw)
    if (wrapRef.current) ro.observe(wrapRef.current)
    return () => ro.disconnect()
  }, [data, height])

  const handleMouseMove = (e: React.MouseEvent) => {
    if (!wrapRef.current) return
    const rect = wrapRef.current.getBoundingClientRect()
    const mx = e.clientX - rect.left; const my = e.clientY - rect.top
    const hitIdx = rectsRef.current.findIndex(r => mx >= r.x && mx <= r.x + r.w && my >= r.y && my <= r.y + r.h)
    if (hitIdx !== hoverRef.current) { hoverRef.current = hitIdx; draw() }
    if (hitIdx >= 0) {
      const r = rectsRef.current[hitIdx]
      const fmtUSD = (v: number) => `$${v.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
      setTip({ x: e.nativeEvent.offsetX + 12, y: e.nativeEvent.offsetY - 52,
        text: `${r.item.label}\n${r.item.type}\n${fmtUSD(r.item.value)}` })
    } else setTip(null)
  }

  const handleClick = (e: React.MouseEvent) => {
    if (!wrapRef.current || !onSelect) return
    const rect = wrapRef.current.getBoundingClientRect()
    const mx = e.clientX - rect.left; const my = e.clientY - rect.top
    const hit = rectsRef.current.find(r => mx >= r.x && mx <= r.x + r.w && my >= r.y && my <= r.y + r.h)
    onSelect(hit ? hit.item.label : null)
  }

  return (
    <div ref={wrapRef} className="chart-wrap cursor-pointer" style={{ height }}>
      <canvas ref={canvasRef} onClick={handleClick} onMouseMove={handleMouseMove} onMouseLeave={() => { hoverRef.current = -1; draw(); setTip(null) }} />
      {tip && <div className="u-tooltip" style={{ left: tip.x, top: tip.y }}>{tip.text}</div>}
    </div>
  )
}
