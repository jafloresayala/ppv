// src/App.tsx — Main application shell
import { Routes, Route } from 'react-router-dom'
import { usePPV } from './store/ppvStore'
import QueryForm    from './components/QueryForm'
import KPICards     from './components/KPICards'
import Sidebar      from './components/Sidebar'
import PriceCalculatorWidget from './components/PriceCalculatorWidget'
import TabTrend         from './tabs/TabTrend'
import TabMaterialGroup from './tabs/TabMaterialGroup'
import TabVendors       from './tabs/TabVendors'
import TabMaterials     from './tabs/TabMaterials'
import TabHierarchy     from './tabs/TabHierarchy'
import TabDistribution  from './tabs/TabDistribution'
import TabImpact        from './tabs/TabImpact'
import TabAI            from './tabs/TabAI'
import TabData          from './tabs/TabData'
import {
  TrendingUp, Package2, Truck, Boxes,
  Network, BarChart2, Crosshair, BrainCircuit, Table2,
  AlertCircle, X, RefreshCw,
} from 'lucide-react'

const TABS = [
  { id: 'trend',         label: 'Trend',          Icon: TrendingUp  },
  { id: 'material_group',label: 'Mat. Groups',     Icon: Package2    },
  { id: 'vendors',       label: 'Vendors',         Icon: Truck       },
  { id: 'materials',     label: 'Materials',       Icon: Boxes       },
  { id: 'hierarchy',     label: 'Hierarchy',       Icon: Network     },
  { id: 'distribution',  label: 'Distribution',    Icon: BarChart2   },
  { id: 'impact',        label: 'Impact',          Icon: Crosshair   },
  { id: 'ai',            label: 'AI Assistant',    Icon: BrainCircuit},
  { id: 'data',          label: 'Data',            Icon: Table2      },
]

const TAB_CONTENT: JSX.Element[] = [
  <TabTrend />,
  <TabMaterialGroup />,
  <TabVendors />,
  <TabMaterials />,
  <TabHierarchy />,
  <TabDistribution />,
  <TabImpact />,
  <TabAI />,
  <TabData />,
]

function MainApp() {
  const {
    analytics, activeTab, setTab, error, clearError, loading,
    errorType, partialWarning, clearPartialWarning, lastQueryParams, query,
  } = usePPV()
  const hasData = !!analytics

  return (
    <div className="min-h-screen bg-slate-100 flex flex-col">
      {/* ── Header ───────────────────────────────────────────── */}
      <header className="sticky top-0 z-40 bg-white border-b border-slate-200 shadow-sm">
        <div className="max-w-screen-2xl mx-auto px-4 py-3 flex items-center gap-4 flex-wrap">
          {/* Logo / Title */}
          <div className="flex items-center gap-2 min-w-[160px]">
            <div className="w-8 h-8 rounded-lg bg-brand flex items-center justify-center">
              <TrendingUp size={16} className="text-white" />
            </div>
            <span className="font-bold text-slate-800 text-sm tracking-tight">PPV Analytics</span>
          </div>
          {/* Query form (takes remaining space) */}
          <div className="flex-1 min-w-[280px]">
            <QueryForm />
          </div>
        </div>
      </header>

      {/* ── Error toast ──────────────────────────────────────── */}
      {error && (
        <div className="fixed top-16 inset-x-0 z-50 flex justify-center pointer-events-none">
          <div className="pointer-events-auto bg-red-600 text-white rounded-xl shadow-lg px-5 py-3 flex items-center gap-3 max-w-xl fade-in">
            <AlertCircle size={18} className="flex-shrink-0" />
            <span className="text-sm flex-1">{error}</span>
            {(errorType === 'connection' || errorType === 'timeout') && lastQueryParams && (
              <button
                onClick={() => {
                  clearError()
                  query(lastQueryParams.plants, lastQueryParams.start, lastQueryParams.end)
                }}
                className="flex items-center gap-1.5 text-xs font-semibold bg-white/20 hover:bg-white/30 px-2.5 py-1 rounded-lg whitespace-nowrap transition-colors"
              >
                <RefreshCw size={12} />
                Retry
              </button>
            )}
            <button onClick={clearError}><X size={16} /></button>
          </div>
        </div>
      )}

      {/* ── Partial-data warning banner ───────────────────────────── */}
      {partialWarning && (
        <div className="bg-amber-50 border-b border-amber-200">
          <div className="max-w-screen-2xl mx-auto px-4 py-2 flex items-start gap-2">
            <AlertCircle size={14} className="text-amber-600 mt-0.5 flex-shrink-0" />
            <p className="text-xs text-amber-800 flex-1">
              <strong>Partial data —</strong>{' '}
              {partialWarning.message}
              {partialWarning.failedMonths.length > 0 && (
                <span className="ml-1 text-amber-700">
                  ({partialWarning.failedMonths.slice(0, 5).join(', ')}
                  {partialWarning.failedMonths.length > 5 ? '…' : ''})
                </span>
              )}
              {lastQueryParams && (
                <button
                  onClick={() => {
                    clearPartialWarning()
                    query(lastQueryParams.plants, lastQueryParams.start, lastQueryParams.end)
                  }}
                  className="ml-2 underline font-medium text-amber-700 hover:text-amber-900"
                >
                  Re-fetch missing months
                </button>
              )}
            </p>
            <button onClick={clearPartialWarning} className="text-amber-400 hover:text-amber-700 flex-shrink-0">
              <X size={14} />
            </button>
          </div>
        </div>
      )}

      {/* ── Body ─────────────────────────────────────────────── */}
      <div className="flex flex-1 max-w-screen-2xl mx-auto w-full">


        {/* Main content */}
        <main className="flex-1 p-4 min-w-0 flex flex-col gap-4">
          {/* Loading state */}
          {loading && (
            <div className="flex flex-col gap-3">
              <div className="skeleton h-24 rounded-xl" />
              <div className="skeleton h-64 rounded-xl" />
            </div>
          )}

          {/* Empty state */}
          {!loading && !hasData && (
            <div className="flex-1 flex flex-col items-center justify-center min-h-[60vh] text-center gap-5">
              <div className="w-20 h-20 rounded-2xl bg-brand/10 flex items-center justify-center">
                <TrendingUp size={36} className="text-brand" />
              </div>
              <div>
                <h2 className="text-2xl font-bold text-slate-700">PPV Analytics Dashboard</h2>
                <p className="text-slate-400 mt-2 max-w-sm">
                  Select one or more plants and a date range above, then click <strong>Query SAP</strong> to load and analyze your PPV data.
                </p>
              </div>
              <div className="grid grid-cols-3 gap-3 mt-2 opacity-60">
                {TABS.slice(0, 6).map(({ Icon, label }) => (
                  <div key={label} className="flex items-center gap-2 text-xs text-slate-500">
                    <Icon size={14} className="text-brand" />{label}
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Data loaded */}
          {!loading && hasData && (
            <>
              {/* KPI row */}
              <KPICards kpis={analytics!.kpis} />

              {/* Tab bar */}
              <div className="flex gap-1 flex-wrap bg-white rounded-xl border border-slate-200 p-1.5 shadow-sm">
                {TABS.map(({ id, label, Icon }, idx) => (
                  <button
                    key={id}
                    onClick={() => setTab(idx)}
                    className={`tab-btn flex items-center gap-1.5 ${activeTab === idx ? 'tab-btn-active' : 'tab-btn-inactive'}`}
                  >
                    <Icon size={13} />
                    <span className="hidden sm:inline">{label}</span>
                  </button>
                ))}
              </div>

              {/* Active tab content */}
              <div className="flex-1">
                {TAB_CONTENT[activeTab] ?? TAB_CONTENT[0]}
              </div>
            </>
          )}
        </main>
      </div>

      {/* ── Footer ───────────────────────────────────────────── */}
      <footer className="text-center text-xs text-slate-400 py-3 border-t border-slate-200 bg-white">
        PPV Analytics · Kimball Electronics · Powered by FastAPI + React + uPlot
      </footer>

      {/* ── Floating widgets ──────────────────────────────────── */}
      {hasData && <Sidebar />}
      <PriceCalculatorWidget />
    </div>
  )
}

function PriceCalculatorPage() {
  return (
    <div className="min-h-screen bg-gray-50">
      <PriceCalculatorWidget mode="page" />
    </div>
  )
}

export default function App() {
  return (
    <Routes>
      <Route path="/pricecalculator" element={<PriceCalculatorPage />} />
      <Route path="/*" element={<MainApp />} />
    </Routes>
  )
}
