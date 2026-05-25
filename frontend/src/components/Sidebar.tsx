// src/components/Sidebar.tsx â€” floating filter widget
import { useState } from 'react'
import type { ReactNode } from 'react'
import { Filter, X, ChevronDown, Search } from 'lucide-react'
import { usePPV } from '../store/ppvStore'

// â”€â”€ Reusable collapsible filter section â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
interface FilterSectionProps {
  title: string
  selectedCount: number
  totalCount: number
  allSelected: boolean
  onToggleAll: () => void
  search: string
  onSearch: (v: string) => void
  children: ReactNode
}

function FilterSection({
  title, selectedCount, totalCount, allSelected, onToggleAll,
  search, onSearch, children,
}: FilterSectionProps) {
  const [expanded, setExpanded] = useState(true)
  const deselected = totalCount - selectedCount

  return (
    <div className="flex flex-col border border-slate-200 rounded-xl overflow-hidden">
      {/* Section header â€” click to collapse */}
      <button
        type="button"
        className="flex items-center justify-between px-3 py-2.5 bg-slate-50 hover:bg-slate-100 transition-colors text-left"
        onClick={() => setExpanded(e => !e)}
      >
        <div className="flex items-center gap-2">
          <ChevronDown
            className={`w-3.5 h-3.5 text-slate-400 transition-transform duration-200 ${expanded ? '' : '-rotate-90'}`}
          />
          <span className="text-xs font-semibold text-slate-600 uppercase tracking-wide">{title}</span>
        </div>
        <div className="flex items-center gap-2">
          {deselected > 0 && (
            <span className="text-[10px] bg-brand/10 text-brand font-semibold px-1.5 py-0.5 rounded-full">
              {deselected} off
            </span>
          )}
          <button
            type="button"
            className="text-[11px] text-brand font-medium hover:underline"
            onClick={e => { e.stopPropagation(); onToggleAll() }}
          >
            {allSelected ? 'None' : 'All'}
          </button>
        </div>
      </button>

      {/* Collapsible body */}
      {expanded && (
        <div className="flex flex-col gap-2 p-3">
          {/* Search bar */}
          <div className="relative">
            <Search className="absolute left-2 top-1/2 -translate-y-1/2 w-3 h-3 text-slate-400 pointer-events-none" />
            <input
              type="text"
              value={search}
              onChange={e => onSearch(e.target.value)}
              placeholder={`Search ${title.toLowerCase()}â€¦`}
              className="w-full pl-6 pr-2 py-1.5 text-xs border border-slate-200 rounded-lg bg-white focus:outline-none focus:ring-1 focus:ring-brand/50 placeholder:text-slate-300"
            />
            {search && (
              <button
                type="button"
                className="absolute right-2 top-1/2 -translate-y-1/2"
                onClick={() => onSearch('')}
              >
                <X className="w-3 h-3 text-slate-400 hover:text-slate-600" />
              </button>
            )}
          </div>
          {/* Checkbox list */}
          <div className="flex flex-col gap-1 max-h-44 overflow-y-auto">
            {children}
          </div>
        </div>
      )}
    </div>
  )
}

// â”€â”€ Main component â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
export default function Sidebar() {
  const {
    filterOptions, selectedGroups, selectedVendors,
    setGroups, setVendors, applyFilters, loading,
  } = usePPV()
  const [open, setOpen]               = useState(false)
  const [groupSearch, setGroupSearch] = useState('')
  const [vendorSearch, setVendorSearch] = useState('')

  if (!filterOptions) return null

  const toggleGroup = (g: string) => {
    const next = selectedGroups.includes(g)
      ? selectedGroups.filter(x => x !== g)
      : [...selectedGroups, g]
    setGroups(next)
  }
  const toggleVendor = (v: string) => {
    const next = selectedVendors.includes(v)
      ? selectedVendors.filter(x => x !== v)
      : [...selectedVendors, v]
    setVendors(next)
  }

  const allGroups  = selectedGroups.length === filterOptions.material_groups.length
  const allVendors = selectedVendors.length === filterOptions.vendors.length

  const filteredGroups  = filterOptions.material_groups.filter(g =>
    g.toLowerCase().includes(groupSearch.toLowerCase()))
  const filteredVendors = filterOptions.vendors.filter(v =>
    v.toLowerCase().includes(vendorSearch.toLowerCase()))

  // Badge: total items deselected
  const activeCount =
    (allGroups  ? 0 : filterOptions.material_groups.length - selectedGroups.length) +
    (allVendors ? 0 : filterOptions.vendors.length          - selectedVendors.length)

  function handleApply() {
    applyFilters()
    setOpen(false)
  }

  return (
    <>
      {/* â”€â”€ Floating Action Button â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€ */}
      <button
        onClick={() => setOpen(o => !o)}
        className="fixed bottom-24 right-6 z-40 w-14 h-14 rounded-full bg-slate-700 text-white shadow-lg hover:bg-slate-800 active:scale-95 transition-all flex items-center justify-center group"
        title="Filters"
      >
        <Filter size={20} />
        {activeCount > 0 && (
          <span className="absolute -top-1 -right-1 w-5 h-5 rounded-full bg-brand text-white text-[10px] font-bold flex items-center justify-center">
            {activeCount}
          </span>
        )}
        <span className="absolute right-16 whitespace-nowrap bg-slate-800 text-white text-xs px-2 py-1 rounded-lg opacity-0 group-hover:opacity-100 transition-opacity pointer-events-none">
          Filters
        </span>
      </button>

      {/* â”€â”€ Backdrop â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€ */}
      {open && (
        <div className="fixed inset-0 z-40" onClick={() => setOpen(false)} />
      )}

      {/* â”€â”€ Floating panel â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€ */}
      {open && (
        <div
          className="fixed bottom-[10.5rem] right-6 z-50 w-76 bg-white rounded-2xl shadow-2xl border border-slate-200 flex flex-col max-h-[70vh]"
          style={{ width: '19rem' }}
          onClick={e => e.stopPropagation()}
        >
          {/* Header */}
          <div className="flex items-center justify-between px-4 py-3 border-b border-slate-100 shrink-0">
            <div className="flex items-center gap-2">
              <Filter className="w-4 h-4 text-brand" />
              <span className="text-sm font-bold text-slate-700">Filters</span>
              {activeCount > 0 && (
                <span className="text-[10px] bg-brand text-white font-bold px-1.5 py-0.5 rounded-full">
                  {activeCount} off
                </span>
              )}
            </div>
            <button
              onClick={() => setOpen(false)}
              className="w-6 h-6 rounded-full flex items-center justify-center hover:bg-slate-100 transition-colors"
            >
              <X className="w-3.5 h-3.5 text-slate-400" />
            </button>
          </div>

          {/* Scrollable content */}
          <div className="flex-1 overflow-y-auto p-3 flex flex-col gap-3">

            {/* Material Groups */}
            <FilterSection
              title="Material Group"
              selectedCount={selectedGroups.length}
              totalCount={filterOptions.material_groups.length}
              allSelected={allGroups}
              onToggleAll={() => setGroups(allGroups ? [] : filterOptions.material_groups)}
              search={groupSearch}
              onSearch={setGroupSearch}
            >
              {filteredGroups.length === 0
                ? <p className="text-xs text-slate-400 italic py-1">No matches</p>
                : filteredGroups.map(g => (
                    <label key={g} className="flex items-center gap-2 text-xs text-slate-600 cursor-pointer hover:text-slate-900">
                      <input
                        type="checkbox"
                        checked={selectedGroups.includes(g)}
                        onChange={() => toggleGroup(g)}
                        className="accent-brand rounded"
                      />
                      <span className="truncate">{g || '(blank)'}</span>
                    </label>
                  ))
              }
            </FilterSection>

            {/* Vendors */}
            <FilterSection
              title="Vendor"
              selectedCount={selectedVendors.length}
              totalCount={filterOptions.vendors.length}
              allSelected={allVendors}
              onToggleAll={() => setVendors(allVendors ? [] : filterOptions.vendors)}
              search={vendorSearch}
              onSearch={setVendorSearch}
            >
              {filteredVendors.length === 0
                ? <p className="text-xs text-slate-400 italic py-1">No matches</p>
                : filteredVendors.map(v => (
                    <label key={v} className="flex items-center gap-2 text-xs text-slate-600 cursor-pointer hover:text-slate-900">
                      <input
                        type="checkbox"
                        checked={selectedVendors.includes(v)}
                        onChange={() => toggleVendor(v)}
                        className="accent-brand rounded"
                      />
                      <span className="truncate">{v || '(blank)'}</span>
                    </label>
                  ))
              }
            </FilterSection>
          </div>

          {/* Footer */}
          <div className="px-4 py-3 border-t border-slate-100 shrink-0">
            <button
              onClick={handleApply}
              disabled={loading}
              className="btn-primary text-sm py-2 w-full"
            >
              Apply Filters
            </button>
          </div>
        </div>
      )}
    </>
  )
}
