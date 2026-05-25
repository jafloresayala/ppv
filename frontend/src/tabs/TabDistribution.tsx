// src/tabs/TabDistribution.tsx
import BoxPlot from '../components/charts/BoxPlot'
import { usePPV } from '../store/ppvStore'

export default function TabDistribution() {
  const { analytics } = usePPV()
  const dd = analytics?.distribution

  if (!dd?.box_data.length)
    return <p className="text-sm text-slate-400 italic">No distribution data available.</p>

  return (
    <div className="fade-in flex flex-col gap-5">
      <div className="card-p">
        <p className="section-title">PPV Distribution by Material Group — Box-and-Whisker</p>
        <p className="text-xs text-slate-400 mb-3">
          Boxes = IQR (Q1–Q3) · Center line = Median · Orange dots = Outliers (within whisker range)
        </p>
        <BoxPlot data={dd.box_data} height={460} />
      </div>
    </div>
  )
}
