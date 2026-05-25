// src/components/KPICards.tsx
import type { KPIs } from '../types/api.types'

const fmt = (n: number) => {
  const abs = Math.abs(n)
  if (abs >= 1_000_000) return `$${(n / 1_000_000).toFixed(2)}M`
  if (abs >= 1_000)     return `$${(n / 1_000).toFixed(1)}K`
  return `$${n.toFixed(2)}`
}

interface Props { kpis: KPIs }

export default function KPICards({ kpis }: Props) {
  const cards = [
    {
      label: 'Net PPV',
      value: fmt(kpis.total_ppv),
      bg:    kpis.total_ppv <= 0 ? 'bg-success-light border-success/20' : 'bg-danger-light border-danger/20',
      text:  kpis.total_ppv <= 0 ? 'text-success' : 'text-danger',
    },
    { label: 'Favorable',  value: fmt(kpis.favorable),   bg: 'bg-success-light border-success/20', text: 'text-success' },
    { label: 'Unfavorable', value: fmt(kpis.unfavorable), bg: 'bg-danger-light  border-danger/20',  text: 'text-danger'  },
    { label: 'Records',    value: kpis.records.toLocaleString(),   bg: 'bg-white border-slate-100', text: 'text-slate-800' },
    { label: 'Vendors',    value: kpis.vendors.toLocaleString(),   bg: 'bg-white border-slate-100', text: 'text-slate-800' },
    { label: 'Materials',  value: kpis.materials.toLocaleString(), bg: 'bg-white border-slate-100', text: 'text-slate-800' },
  ]
  return (
    <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-3">
      {cards.map(c => (
        <div key={c.label} className={`kpi-card border ${c.bg}`}>
          <span className="kpi-label">{c.label}</span>
          <span className={`kpi-value ${c.text}`}>{c.value}</span>
        </div>
      ))}
    </div>
  )
}
