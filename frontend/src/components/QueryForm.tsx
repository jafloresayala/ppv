// src/components/QueryForm.tsx
import { useState } from 'react'
import { Search, Loader2 } from 'lucide-react'
import { usePPV } from '../store/ppvStore'
import { PLANT_FLAGS, PLANT_SHORT } from '../utils/plants'

function todayStr() { return new Date().toISOString().slice(0, 10) }
function weekAgoStr() {
  const d = new Date(); d.setDate(d.getDate() - 7); return d.toISOString().slice(0, 10)
}

const PLANTS: { code: string; name: string }[] = [
  { code: '0010', name: 'Jasper'   },
  { code: '0020', name: 'Mexico'   },
  { code: '0040', name: 'Poland'   },
  { code: '0045', name: 'Romania'  },
  { code: '0050', name: 'Thailand' },
  { code: '0070', name: 'China'    },
]

export default function QueryForm() {
  const [selectedPlants, setSelectedPlants] = useState<string[]>(['0020'])
  const [start, setStart]   = useState(weekAgoStr())
  const [end,   setEnd]     = useState(todayStr())
  const { query, loading, loadingPhase,
          fetchProgress, fetchMonthLabel, fetchMonthsDone, fetchTotalMonths, fetchRowsSoFar } = usePPV()

  // Estimate months between two date strings
  const monthSpan = (() => {
    try {
      const s = new Date(start); const e = new Date(end)
      return (e.getFullYear() - s.getFullYear()) * 12 + (e.getMonth() - s.getMonth()) + 1
    } catch { return 1 }
  })()

  const togglePlant = (code: string) => {
    setSelectedPlants(prev =>
      prev.includes(code) ? prev.filter(p => p !== code) : [...prev, code]
    )
  }

  const allSelected = selectedPlants.length === PLANTS.length
  const toggleAll   = () => setSelectedPlants(allSelected ? [] : PLANTS.map(p => p.code))

  const submit = (e: React.FormEvent) => {
    e.preventDefault()
    if (selectedPlants.length === 0) return
    query(selectedPlants, start, end)
  }

  return (
    <div className="flex flex-col gap-2">
      <form onSubmit={submit} className="card-p flex flex-wrap items-end gap-3">

        {/* ── Plant multi-select ─────────────────────────────────────────── */}
        <div className="flex flex-col gap-1.5">
          <div className="flex items-center justify-between gap-3">
            <label className="text-xs font-semibold text-slate-500 uppercase tracking-wide">
              Plant
              {selectedPlants.length > 0 && (
                <span className="ml-1.5 text-[10px] bg-brand/10 text-brand font-semibold px-1.5 py-0.5 rounded-full normal-case">
                  {selectedPlants.length} selected
                </span>
              )}
            </label>
            <button
              type="button"
              onClick={toggleAll}
              className="text-[11px] text-brand font-medium hover:underline"
            >
              {allSelected ? 'None' : 'All'}
            </button>
          </div>
          <div className="flex flex-wrap gap-1.5">
            {PLANTS.map(({ code, name }) => {
              const active = selectedPlants.includes(code)
              return (
                <button
                  key={code}
                  type="button"
                  onClick={() => togglePlant(code)}
                  className={[
                    'px-2.5 py-1 rounded-lg border text-xs font-medium transition-all',
                    active
                      ? 'bg-brand text-white border-brand shadow-sm'
                      : 'bg-white text-slate-500 border-slate-200 hover:border-brand/50 hover:text-brand',
                  ].join(' ')}
                >
                  {PLANT_FLAGS[code] ?? '🏭'}{' '}{PLANT_SHORT[code] ?? name}
                </button>
              )
            })}
          </div>
        </div>

        <div className="flex flex-col gap-1">
          <label className="text-xs font-semibold text-slate-500 uppercase tracking-wide">Start Date</label>
          <input
            type="date" className="input-field"
            value={start} onChange={e => setStart(e.target.value)} required
          />
        </div>

        <div className="flex flex-col gap-1">
          <label className="text-xs font-semibold text-slate-500 uppercase tracking-wide">End Date</label>
          <input
            type="date" className="input-field"
            value={end} onChange={e => setEnd(e.target.value)} required
          />
        </div>

        <button
          type="submit"
          disabled={loading || selectedPlants.length === 0}
          className="btn-primary flex items-center gap-2 h-[42px]"
        >
          {loading
            ? <><Loader2 className="w-4 h-4 animate-spin" /> {loadingPhase ?? 'Processing…'}</>
            : <><Search className="w-4 h-4" /> Query SAP</>
          }
        </button>

      </form>

      {loading && (
        <div className="card-p bg-brand/5 border border-brand/20 py-3">
          <div className="flex items-center gap-3">
            <Loader2 className="w-5 h-5 text-brand animate-spin flex-shrink-0" />
            <div className="flex-1 min-w-0">
              <p className="text-sm font-semibold text-brand">{loadingPhase ?? 'Processing…'}</p>
              {loadingPhase === 'Fetching SAP data…' ? (
                <p className="text-xs text-slate-500">
                  {fetchTotalMonths > 0
                    ? `${fetchMonthsDone} of ${fetchTotalMonths} month${fetchTotalMonths !== 1 ? 's' : ''} · ${fetchRowsSoFar.toLocaleString()} rows collected`
                    : 'Connecting to SAP…'}
                </p>
              ) : (
                <p className="text-xs text-slate-500">
                  {monthSpan > 3
                    ? `Large date range (${monthSpan} months). SAP data retrieval and analytics can take several minutes — please wait.`
                    : 'Contacting SAP and computing analytics…'}
                </p>
              )}
            </div>
          </div>

          {loadingPhase === 'Fetching SAP data…' && (
            <div className="mt-2.5 space-y-1">
              <div className="w-full h-2 bg-brand/20 rounded-full overflow-hidden">
                <div
                  className="h-full bg-brand rounded-full transition-all duration-500 ease-out"
                  style={{ width: `${fetchProgress}%` }}
                />
              </div>
              <div className="flex justify-between text-xs text-slate-400">
                <span className={`truncate max-w-[70%] ${fetchMonthLabel.startsWith('⚠') ? 'text-amber-500 font-medium' : ''}`}>
                  {fetchMonthLabel}
                </span>
                <span className="font-medium text-brand">{fetchProgress}%</span>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  )
}
