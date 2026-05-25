// src/components/charts/NetworkGraph.tsx
// Canvas2D circular network — center node + peripheral vendor nodes
import { useEffect, useRef, useState } from 'react'

export interface NetNode { name: string; size: number; color: string; isBest?: boolean }
interface Props {
  nodes:    NetNode[]
  center:   { label: string; value?: string }
  height?:  number
  onSelect?: (name: string | null) => void
}

export default function NetworkGraph({ nodes, center, height = 300, onSelect }: Props) {
  const canvasRef  = useRef<HTMLCanvasElement>(null)
  const wrapRef    = useRef<HTMLDivElement>(null)
  const [tip, setTip] = useState<{ x: number; y: number; text: string } | null>(null)
  const posRef = useRef<{ x: number; y: number; r: number; name: string }[]>([])

  const draw = () => {
    const canvas = canvasRef.current; const wrap = wrapRef.current
    if (!canvas || !wrap || !nodes.length) return
    const dpr = window.devicePixelRatio || 1
    const W   = wrap.clientWidth; const H = height
    canvas.width = W * dpr; canvas.height = H * dpr
    canvas.style.width = W + 'px'; canvas.style.height = H + 'px'
    const ctx = canvas.getContext('2d')!
    ctx.scale(dpr, dpr); ctx.clearRect(0, 0, W, H)

    const cx = W / 2; const cy = H / 2
    const radius = Math.min(W, H) / 2 - 40

    const maxSz = Math.max(...nodes.map(n => n.size), 1)
    posRef.current = []

    // Draw edges first
    nodes.forEach((node, i) => {
      const angle = (i / nodes.length) * Math.PI * 2 - Math.PI / 2
      const nx = cx + Math.cos(angle) * radius
      const ny = cy + Math.sin(angle) * radius
      ctx.strokeStyle = '#e2e8f0'; ctx.lineWidth = 1.5
      ctx.beginPath(); ctx.moveTo(cx, cy); ctx.lineTo(nx, ny); ctx.stroke()
    })

    // Center node
    ctx.beginPath(); ctx.arc(cx, cy, 26, 0, Math.PI * 2)
    ctx.fillStyle = '#1d4ed8'; ctx.fill()
    ctx.strokeStyle = '#fff'; ctx.lineWidth = 3; ctx.stroke()
    ctx.fillStyle = '#fff'; ctx.font = 'bold 9px Inter,sans-serif'
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle'
    const clbl = center.label.length > 10 ? center.label.slice(0, 9) + '…' : center.label
    ctx.fillText(clbl, cx, cy)
    if (center.value) { ctx.font = '8px Inter,sans-serif'; ctx.fillText(center.value, cx, cy + 11) }

    // Peripheral nodes
    nodes.forEach((node, i) => {
      const angle = (i / nodes.length) * Math.PI * 2 - Math.PI / 2
      const nx = cx + Math.cos(angle) * radius
      const ny = cy + Math.sin(angle) * radius
      const r  = 8 + (node.size / maxSz) * 16

      ctx.beginPath(); ctx.arc(nx, ny, r, 0, Math.PI * 2)
      ctx.fillStyle = node.color; ctx.fill()
      if (node.isBest) { ctx.strokeStyle = '#fbbf24'; ctx.lineWidth = 2.5; ctx.stroke() }
      else             { ctx.strokeStyle = '#fff';    ctx.lineWidth = 1.5; ctx.stroke() }

      posRef.current.push({ x: nx, y: ny, r, name: node.name })

      // Label
      const lx = nx + Math.cos(angle) * (r + 6)
      const ly = ny + Math.sin(angle) * (r + 6)
      ctx.fillStyle = '#334155'; ctx.font = '8px Inter,sans-serif'
      ctx.textAlign = Math.cos(angle) > 0 ? 'left' : 'right'; ctx.textBaseline = 'middle'
      const lbl = node.name.length > 14 ? node.name.slice(0, 13) + '…' : node.name
      ctx.fillText(lbl, lx, ly)
    })
  }

  useEffect(() => {
    draw()
    const ro = new ResizeObserver(draw)
    if (wrapRef.current) ro.observe(wrapRef.current)
    return () => ro.disconnect()
  }, [nodes, center, height])

  const getNode = (e: React.MouseEvent) => {
    if (!wrapRef.current) return null
    const rect = wrapRef.current.getBoundingClientRect()
    const mx = e.clientX - rect.left; const my = e.clientY - rect.top
    return posRef.current.find(p => Math.hypot(p.x - mx, p.y - my) <= p.r + 4) ?? null
  }

  return (
    <div ref={wrapRef} className="chart-wrap relative cursor-pointer" style={{ height }}>
      <canvas
        ref={canvasRef}
        onClick={e => { const n = getNode(e); onSelect?.(n?.name ?? null) }}
        onMouseMove={e => {
          const n = getNode(e)
          if (n) setTip({ x: e.nativeEvent.offsetX + 10, y: e.nativeEvent.offsetY - 10, text: n.name })
          else   setTip(null)
        }}
        onMouseLeave={() => setTip(null)}
      />
      {tip && <div className="u-tooltip" style={{ left: tip.x, top: tip.y }}>{tip.text}</div>}
    </div>
  )
}
