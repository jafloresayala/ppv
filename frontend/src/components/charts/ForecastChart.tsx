// src/components/charts/ForecastChart.tsx
// uPlot multi-series forecast chart: historical + best model + CI band
import { useEffect, useRef } from 'react'
import uPlot from 'uplot'
import type { ForecastData } from '../../types/api.types'

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
        const tW = el.offsetWidth || 200
        el.style.left = (left + tW + 20 > W ? left - tW - 8 : left + 12) + 'px'
        el.style.top  = Math.max(4, (u.cursor.top ?? 0) - 30) + 'px'
      },
    },
  }
}

interface Props { data: ForecastData; height?: number }

const COLORS = ['#1d4ed8', '#15803d', '#b45309', '#7c3aed', '#b91c1c']

export default function ForecastChart({ data, height = 320 }: Props) {
  const wrapRef = useRef<HTMLDivElement>(null)
  const uRef    = useRef<uPlot | null>(null)

  useEffect(() => {
    if (!wrapRef.current || !data.available || !data.historical || !data.models?.length) return

    const allLabels = [...(data.historical.labels ?? []), ...(data.future_labels ?? [])]
    const xs        = allLabels.map((_, i) => i)
    const hist      = [...(data.historical.values ?? [])]

    // Pad historical with nulls for future positions
    const futurePad = (data.future_labels ?? []).map(() => null)
    const histFull  = [...hist, ...futurePad]

    const seriesData: (number | null)[][] = [histFull]
    const uSeries: uPlot.Series[] = [
      { value: (_u, v) => allLabels[Math.round(v)] ?? '' },
      {
        label:  'Historical',
        stroke: '#334155',
        width:  2,
        points: { show: true, size: 4, fill: '#334155' },
      },
    ]

    data.models.slice(0, 4).forEach((m, i) => {
      const histPad = hist.map(() => null)
      const fvals   = [...histPad, ...m.forecast]
      seriesData.push(fvals as any)
      uSeries.push({
        label:  `${m.model} (MASE ${m.mase.toFixed(2)})`,
        stroke: COLORS[i % COLORS.length],
        width:  i === 0 ? 2.5 : 1.5,
        dash:   i === 0 ? undefined : [6, 3],
        points: { show: i === 0, size: 5, fill: COLORS[i % COLORS.length] },
      })
    })

    // CI band for best model
    if (data.models[0]?.ci_lower) {
      const ciLo = [...hist.map(() => null), ...data.models[0].ci_lower]
      const ciHi = [...hist.map(() => null), ...data.models[0].ci_upper]
      seriesData.push(ciHi as any, ciLo as any)
      uSeries.push(
        { label: 'CI Upper', stroke: COLORS[0] + '60', width: 1, fill: COLORS[0] + '18', points: { show: false } },
        { label: 'CI Lower', stroke: COLORS[0] + '60', width: 1, points: { show: false } },
      )
    }

    const fmtUSD = (v: number | null | undefined) =>
      v == null ? '—' : `$${v.toLocaleString(undefined, { minimumFractionDigits: 0, maximumFractionDigits: 0 })}`
    const plugin = uTooltip((_u, idx) => {
      const label = allLabels[idx] ?? ''
      const lines = _u.series.slice(1, 5).map((s, i) => {
        const val = (_u.data[i + 1] as (number | null)[])?.[idx]
        if (val == null) return null
        return `${s.label}: ${fmtUSD(val)}`
      }).filter(Boolean).join('\n')
      return lines ? `${label}\n${lines}` : label
    })

    const w = wrapRef.current.clientWidth || 700
    const opts: uPlot.Options = {
      width: w, height,
      plugins: [plugin],
      scales: { x: { time: false } },
      axes: [
        { values: (_u, ticks) => ticks.map(t => allLabels[t] ?? ''), gap: 5, size: 55 },
        { label: 'Net PPV (USD)', size: 80 },
      ],
      series: uSeries,
    }

    if (uRef.current) { uRef.current.destroy(); uRef.current = null }
    uRef.current = new uPlot(opts, [xs, ...seriesData] as any, wrapRef.current)

    const ro = new ResizeObserver(() => {
      if (uRef.current && wrapRef.current)
        uRef.current.setSize({ width: wrapRef.current.clientWidth, height })
    })
    ro.observe(wrapRef.current)
    return () => { ro.disconnect(); uRef.current?.destroy(); uRef.current = null }
  }, [data, height])

  if (!data.available) return <p className="text-sm text-slate-400 italic">{data.reason ?? 'Forecast unavailable.'}</p>
  return <div ref={wrapRef} className="chart-wrap" />
}
