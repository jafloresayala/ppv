// src/components/charts/LineChart.tsx
// uPlot line chart with optional 2-sigma bands and trend line
import { useEffect, useRef } from 'react'
import uPlot from 'uplot'

function uTooltip(getContent: (u: uPlot, idx: number) => string): uPlot.Plugin {
  let el: HTMLDivElement
  return {
    hooks: {
      init(u: uPlot) {
        el = document.createElement('div')
        el.className = 'u-tooltip'
        el.style.display = 'none'
        u.over.appendChild(el)
      },
      setCursor(u: uPlot) {
        const left = u.cursor.left ?? -1
        if (left < 0) { el.style.display = 'none'; return }
        const idx  = u.cursor.idx ?? -1
        if (idx < 0) { el.style.display = 'none'; return }
        const txt  = getContent(u, idx)
        if (!txt) { el.style.display = 'none'; return }
        el.textContent = txt
        el.style.display = ''
        const W  = u.over.clientWidth
        const tW = el.offsetWidth || 170
        el.style.left = (left + tW + 20 > W ? left - tW - 8 : left + 12) + 'px'
        el.style.top  = Math.max(4, (u.cursor.top ?? 0) - 30) + 'px'
      },
    },
  }
}

export interface LineSeries {
  label:      string
  values:     (number | null)[]
  color:      string
  width?:     number
  dash?:      number[]
  fill?:      string
  pointOnly?: boolean  // render dots only, no connecting line
  noPoints?:  boolean  // suppress dot markers (e.g. fence lines)
}

export interface RefLine {
  value: number      // Y value in chart units
  label: string      // text shown on the line
  color: string
}

interface Props {
  labels:        string[]
  series:        LineSeries[]
  height?:       number
  yLabel?:       string
  refLines?:     RefLine[]
  onClickPoint?: (label: string, idx: number) => void
}

export default function LineChart({ labels, series, height = 260, yLabel, refLines, onClickPoint }: Props) {
  const wrapRef = useRef<HTMLDivElement>(null)
  const uRef    = useRef<uPlot | null>(null)

  useEffect(() => {
    if (!wrapRef.current || !labels.length) return
    const w  = wrapRef.current.clientWidth || 700
    const xs = labels.map((_, i) => i)
    const dpr = window.devicePixelRatio || 1

    const fmtUSD = (v: number | null | undefined) =>
      v == null ? '—' : v.toLocaleString('en-US', { style: 'currency', currency: 'USD', minimumFractionDigits: 2, maximumFractionDigits: 2 })

    const uSeries: uPlot.Series[] = [{ value: (_u, v) => labels[Math.round(v)] ?? '' }]
    for (const s of series) {
      uSeries.push({
        label:  s.label,
        stroke: s.color,
        width:  s.pointOnly ? 0 : (s.width ?? 2),
        fill:   s.pointOnly ? undefined : s.fill,
        dash:   s.dash,
        paths:  s.pointOnly ? () => null : undefined,
        points: { show: s.noPoints ? false : true, size: s.pointOnly ? 7 : 4, fill: s.color },
        value:  (_u, v) => fmtUSD(v),
      })
    }

    const refLinesPlugin: uPlot.Plugin = {
      hooks: {
        draw(u: uPlot) {
          if (!refLines?.length) return
          const ctx = u.ctx
          for (const rl of refLines) {
            const yPx = u.valToPos(rl.value, 'y', true)
            if (yPx < u.bbox.top || yPx > u.bbox.top + u.bbox.height) continue
            ctx.save()
            ctx.strokeStyle = rl.color
            ctx.lineWidth   = 2 * dpr
            ctx.setLineDash([7 * dpr, 4 * dpr])
            ctx.beginPath()
            ctx.moveTo(u.bbox.left, yPx)
            ctx.lineTo(u.bbox.left + u.bbox.width, yPx)
            ctx.stroke()
            // pill label at right edge
            ctx.setLineDash([])
            ctx.font = `bold ${11 * dpr}px -apple-system,sans-serif`
            const tw   = ctx.measureText(rl.label).width
            const pad  = 5 * dpr
            const rh   = 15 * dpr
            const rx   = u.bbox.left + u.bbox.width - tw - pad * 2
            const ry   = yPx - rh
            ctx.fillStyle = rl.color
            ctx.beginPath()
            ctx.roundRect(rx, ry, tw + pad * 2, rh, 3 * dpr)
            ctx.fill()
            ctx.fillStyle = '#ffffff'
            ctx.fillText(rl.label, rx + pad, yPx - 3 * dpr)
            ctx.restore()
          }
        },
      },
    }

    const plugin = uTooltip((_u, idx) => {
      const header = labels[idx] ?? ''
      const lines = series.map((s, i) => {
        const val = (_u.data[i + 1] as (number | null)[])?.[idx]
        return `${s.label}: ${fmtUSD(val)}`
      }).join('\n')
      const rlLines = refLines?.map(rl => `${rl.label}: ${fmtUSD(rl.value)}`).join('\n') ?? ''
      return [header, lines, rlLines].filter(Boolean).join('\n')
    })

    const opts: uPlot.Options = {
      width: w, height,
      plugins: [plugin, refLinesPlugin],
      scales: (() => {
        // Expand Y range to always include refLine values
        if (refLines?.length) {
          const allVals = series.flatMap(s => s.values.filter((v): v is number => v != null))
          const refVals = refLines.map(r => r.value)
          const combined = [...allVals, ...refVals]
          if (combined.length) {
            const lo = Math.min(...combined)
            const hi = Math.max(...combined)
            const pad = (hi - lo) * 0.1 || Math.abs(hi) * 0.1 || 1
            return { x: { time: false }, y: { min: Math.max(0, lo - pad), max: hi + pad } } as uPlot.Scales
          }
        }
        return { x: { time: false } } as uPlot.Scales
      })(),
      axes: [
        { values: (_u, ticks) => ticks.map(t => labels[t] ?? ''), gap: 5, size: 55 },
        { label: yLabel ?? 'USD', size: 75 },
      ],
      series: uSeries,
    }

    if (uRef.current) { uRef.current.destroy(); uRef.current = null }
    uRef.current = new uPlot(opts, [xs, ...series.map(s => s.values as (number | null)[])] as any, wrapRef.current)

    // Click-on-point handler
    if (onClickPoint) {
      uRef.current.over.addEventListener('click', () => {
        const u   = uRef.current
        if (!u) return
        const idx = u.cursor.idx
        if (idx != null && idx >= 0 && idx < labels.length)
          onClickPoint(labels[idx], idx)
      })
    }

    const ro = new ResizeObserver(() => {
      if (uRef.current && wrapRef.current)
        uRef.current.setSize({ width: wrapRef.current.clientWidth, height })
    })
    ro.observe(wrapRef.current)
    return () => { ro.disconnect(); uRef.current?.destroy(); uRef.current = null }
  }, [labels, series, height, yLabel, refLines, onClickPoint])

  return <div ref={wrapRef} className="chart-wrap" />
}
