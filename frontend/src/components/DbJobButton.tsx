// src/components/DbJobButton.tsx — Top-right control for the daily MPN pre-compute job
import { useEffect, useRef, useState, useCallback } from 'react'
import {
  Database, RefreshCw, Download, AlertTriangle, X, ShieldCheck,
  Play, Square, CheckCircle2, Clock, Loader2, Search, RotateCw,
} from 'lucide-react'
import {
  getDbJobStatus, runDbJob, retryDbJobErrors, cancelDbJob, dbJobExportUrl,
  adminLogin, getAdminDashboard,
  adminSearchMpns, adminRequeryMpns, adminRequeryFailed,
  adminListDatabases, adminActivateDatabase, adminRemoveDatabase,
  adminListDemandDatabases, adminConvertDemand, adminActivateDemand, adminRemoveDemand,
  type DbJobStatus, type AdminDashboard, type MpnBestEntry, type DbVersion,
  type DemandDbVersion, type DemandConvertState,
} from '../api/client'

function fmtDateTime(iso: string | null): string {
  if (!iso) return '—'
  try {
    const d = new Date(iso)
    return d.toLocaleString('en-US', {
      month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit',
    })
  } catch { return iso }
}

export default function DbJobButton() {
  const [status, setStatus]   = useState<DbJobStatus | null>(null)
  const [open, setOpen]       = useState(false)
  const [busy, setBusy]       = useState(false)
  const [adminOpen, setAdminOpen] = useState(false)
  const panelRef = useRef<HTMLDivElement | null>(null)

  const refresh = useCallback(async () => {
    try { setStatus(await getDbJobStatus()) } catch { /* backend may be down */ }
  }, [])

  // Poll: 2s while running, 30s otherwise
  useEffect(() => {
    refresh()
    const interval = setInterval(refresh, status?.running ? 2000 : 30000)
    return () => clearInterval(interval)
  }, [refresh, status?.running])

  // Close panel on outside click
  useEffect(() => {
    if (!open) return
    const onClick = (e: MouseEvent) => {
      if (panelRef.current && !panelRef.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', onClick)
    return () => document.removeEventListener('mousedown', onClick)
  }, [open])

  const running   = status?.running ?? false
  const overdue   = status?.overdue ?? false
  const connErrs  = Number(status?.latest_run?.conn_errors ?? 0)
  const progress  = status && status.total > 0 ? Math.round((status.processed / status.total) * 100) : 0

  const handleCancel = async () => {
    setBusy(true)
    try { await cancelDbJob(); await refresh() } finally { setBusy(false) }
  }
  const handleRetry = async () => {
    setBusy(true)
    try { await retryDbJobErrors(); await refresh() } finally { setBusy(false) }
  }

  // Button colour state
  const btnClass = running
    ? 'bg-blue-50 border-blue-300 text-blue-700'
    : overdue
      ? 'bg-amber-50 border-amber-400 text-amber-700 animate-pulse'
      : 'bg-white border-gray-200 text-gray-600 hover:border-gray-300'

  return (
    <div className="relative" ref={panelRef}>
      <button
        onClick={() => setOpen(o => !o)}
        className={`flex items-center gap-2 px-3 py-1.5 rounded-lg border text-xs font-semibold transition-colors shadow-sm ${btnClass}`}
        title={overdue ? 'Daily job is overdue — click to run' : 'MPN price database job'}
      >
        {running
          ? <Loader2 size={14} className="animate-spin" />
          : overdue
            ? <AlertTriangle size={14} />
            : <Database size={14} />}
        <span className="hidden sm:inline">
          {running ? `Building… ${progress}%` : overdue ? 'DB overdue' : 'MPN DB'}
        </span>
        {!running && status && (
          <span className="hidden md:inline text-[10px] font-normal opacity-70">
            {fmtDateTime(status.last_run_at)}
          </span>
        )}
      </button>

      {open && (
        <div className="absolute right-0 top-10 z-50 w-80 bg-white rounded-xl border border-gray-200 shadow-2xl p-4">
          {/* Header */}
          <div className="flex items-center justify-between mb-3">
            <div className="flex items-center gap-2">
              <Database size={15} className="text-blue-600" />
              <span className="font-bold text-gray-800 text-sm">MPN Price Database</span>
            </div>
            <button onClick={() => setOpen(false)} className="text-gray-400 hover:text-gray-700">
              <X size={16} />
            </button>
          </div>

          {/* Stats */}
          <div className="grid grid-cols-2 gap-2 mb-3">
            <div className="rounded-lg bg-gray-50 p-2">
              <p className="text-[10px] text-gray-400 uppercase tracking-wide">Cached MPNs</p>
              <p className="text-lg font-bold text-gray-800">{status?.cached_count ?? 0}</p>
            </div>
            <div className="rounded-lg bg-gray-50 p-2">
              <p className="text-[10px] text-gray-400 uppercase tracking-wide">Last run</p>
              <p className="text-xs font-semibold text-gray-700 mt-1 flex items-center gap-1">
                <Clock size={11} className="text-gray-400" />
                {fmtDateTime(status?.last_run_at ?? null)}
              </p>
            </div>
          </div>

          {overdue && !running && (
            <div className="flex items-start gap-2 mb-3 p-2 rounded-lg bg-amber-50 border border-amber-200">
              <AlertTriangle size={14} className="text-amber-600 mt-0.5 flex-shrink-0" />
              <p className="text-[11px] text-amber-700">
                The {String(status?.schedule_hour ?? 6).padStart(2, '0')}:00 daily refresh hasn't run today.
                Run it to keep searches instant.
              </p>
            </div>
          )}

          {/* Progress */}
          {running && status && (
            <div className="mb-3">
              <div className="flex justify-between text-[11px] text-gray-500 mb-1">
                <span>{status.processed} / {status.total}</span>
                <span>{status.success} ok · {status.errors} err</span>
              </div>
              <div className="h-2 rounded-full bg-gray-100 overflow-hidden">
                <div className="h-full bg-blue-500 transition-all" style={{ width: `${progress}%` }} />
              </div>
            </div>
          )}

          {status?.status === 'failed' && status.message && (
            <p className="text-[11px] text-red-500 mb-3">{status.message}</p>
          )}

          {/* Actions */}
          <div className="flex flex-col gap-2">
            {running && (
              <button
                onClick={handleCancel} disabled={busy}
                className="flex items-center justify-center gap-2 px-3 py-2 rounded-lg text-xs font-semibold bg-red-50 text-red-700 border border-red-200 hover:bg-red-100 disabled:opacity-50"
              >
                <Square size={13} /> Cancel job
              </button>
            )}

            {!running && connErrs > 0 && (
              <button
                onClick={handleRetry} disabled={busy}
                className="flex items-center justify-center gap-2 px-3 py-2 rounded-lg text-xs font-semibold bg-amber-50 text-amber-700 border border-amber-300 hover:bg-amber-100 disabled:opacity-50"
              >
                <RefreshCw size={13} /> Retry {connErrs} connection error{connErrs > 1 ? 's' : ''}
              </button>
            )}

            <a
              href={dbJobExportUrl()}
              className={`flex items-center justify-center gap-2 px-3 py-2 rounded-lg text-xs font-semibold border transition-colors ${
                (status?.cached_count ?? 0) > 0
                  ? 'bg-emerald-50 text-emerald-700 border-emerald-200 hover:bg-emerald-100'
                  : 'bg-gray-50 text-gray-300 border-gray-200 pointer-events-none'
              }`}
            >
              <Download size={13} /> Export results
            </a>

            <button
              onClick={() => setAdminOpen(true)}
              className="flex items-center justify-center gap-2 px-3 py-2 rounded-lg text-xs font-semibold text-gray-600 border border-gray-200 hover:bg-gray-50"
            >
              <ShieldCheck size={13} /> Admin dashboard
            </button>
          </div>

          {status?.latest_run && (
            <p className="text-[10px] text-gray-400 mt-3 text-center">
              Last run: {status.success} ok · {status.errors} errors
              {connErrs > 0 ? ` (${connErrs} connection)` : ''}
            </p>
          )}
        </div>
      )}

      {adminOpen && <AdminDashboardModal onClose={() => setAdminOpen(false)} />}
    </div>
  )
}

// ── Admin dashboard modal ─────────────────────────────────────────────────────

function AdminDashboardModal({ onClose }: { onClose: () => void }) {
  const [token, setToken]   = useState<string | null>(null)
  const [user, setUser]     = useState('')
  const [pass, setPass]     = useState('')
  const [error, setError]   = useState('')
  const [busy, setBusy]     = useState(false)
  const [data, setData]     = useState<AdminDashboard | null>(null)

  // ── Search & re-query state ──
  const [query, setQuery]           = useState('')
  const [statusFilter, setStatusFilter] = useState('')   // '' | 'ok' | 'no_price' | 'error'
  const [searching, setSearching]   = useState(false)
  const [results, setResults]       = useState<MpnBestEntry[] | null>(null)
  const [counts, setCounts]         = useState<Record<string, number>>({})
  const [requerying, setRequerying] = useState<Set<string>>(new Set())
  const [bulkBusy, setBulkBusy]     = useState(false)
  const [notice, setNotice]         = useState('')

  // ── Local DB version control ──
  const [dbVersions, setDbVersions] = useState<DbVersion[]>([])
  const [dbBusy, setDbBusy]         = useState(false)
  const [dbNotice, setDbNotice]     = useState('')

  // ── Demand (dbquery) DB control ──
  const [demandDbs, setDemandDbs]       = useState<DemandDbVersion[]>([])
  const [demandXlsx, setDemandXlsx]     = useState<string[]>([])
  const [demandConvert, setDemandConvert] = useState<DemandConvertState | null>(null)
  const [demandBusy, setDemandBusy]     = useState(false)
  const [demandNotice, setDemandNotice] = useState('')

  // ── Pre-compute job control (moved here from the dropdown) ──
  const [jobStatus, setJobStatus]   = useState<DbJobStatus | null>(null)
  const [jobBusy, setJobBusy]       = useState(false)
  const [jobNotice, setJobNotice]   = useState('')

  const loadJobStatus = async () => {
    try { setJobStatus(await getDbJobStatus()) } catch { /* ignore */ }
  }

  // Poll job status while the admin modal is open (2s while running, 10s idle).
  useEffect(() => {
    if (!token) return
    loadJobStatus()
    const id = setInterval(loadJobStatus, jobStatus?.running ? 2000 : 10000)
    return () => clearInterval(id)
  }, [token, jobStatus?.running])

  const runPending = async () => {
    if (!token) return
    setJobBusy(true); setJobNotice('')
    try {
      const res = await runDbJob(undefined, false, token)
      setJobNotice(res.started ? 'Run started — processing pending MPNs.' : (res.reason ?? 'Could not start.'))
      await loadJobStatus()
    } catch { setJobNotice('Failed to start the run.') } finally { setJobBusy(false) }
  }

  const forceRun = async () => {
    if (!token) return
    setJobBusy(true); setJobNotice('')
    try {
      const res = await runDbJob(undefined, true, token)
      setJobNotice(res.started
        ? 'Force full re-run started — building a NEW database in the background. The current one stays live.'
        : (res.reason ?? 'Could not start.'))
      await loadJobStatus()
      loadDatabases(token)
    } catch { setJobNotice('Failed to start the force re-run.') } finally { setJobBusy(false) }
  }

  const cancelRun = async () => {
    if (!token) return
    setJobBusy(true)
    try { await cancelDbJob(); await loadJobStatus() } finally { setJobBusy(false) }
  }

  const loadDatabases = async (t: string) => {
    try {
      const res = await adminListDatabases(t)
      setDbVersions(res.databases)
    } catch { /* ignore */ }
  }

  const loadDemand = async (t: string) => {
    try {
      const res = await adminListDemandDatabases(t)
      setDemandDbs(res.databases)
      setDemandXlsx(res.xlsx_files)
      setDemandConvert(res.convert)
      return res.convert
    } catch { return null }
  }

  const convertDemand = async (force: boolean) => {
    if (!token) return
    setDemandBusy(true); setDemandNotice('')
    try {
      const res = await adminConvertDemand(token, force)
      if (!res.started) { setDemandNotice(res.reason ?? 'Already running.'); setDemandBusy(false); return }
      setDemandNotice('Converting Excel files to .db…')
      // Poll until the background conversion finishes.
      const poll = setInterval(async () => {
        const st = await loadDemand(token)
        if (st && !st.running) {
          clearInterval(poll)
          setDemandBusy(false)
          setDemandNotice(st.message || 'Conversion finished.')
        }
      }, 1500)
    } catch (e) {
      setDemandBusy(false)
      setDemandNotice(e instanceof Error ? e.message : 'Conversion failed.')
    }
  }

  const activateDemand = async (file: string) => {
    if (!token) return
    setDemandBusy(true); setDemandNotice('')
    try {
      const res = await adminActivateDemand(token, file)
      setDemandDbs(res.databases)
      setDemandNotice(`Active demand DB: "${res.active}".`)
    } catch (e) {
      setDemandNotice(e instanceof Error ? e.message : 'Failed to switch demand DB.')
    } finally { setDemandBusy(false) }
  }

  const removeDemand = async (file: string) => {
    if (!token) return
    setDemandBusy(true); setDemandNotice('')
    try {
      const res = await adminRemoveDemand(token, file, false)
      setDemandDbs(res.databases)
      setDemandNotice(`Removed "${file}" from the demand registry.`)
    } catch (e) {
      setDemandNotice(e instanceof Error ? e.message : 'Failed to remove demand DB.')
    } finally { setDemandBusy(false) }
  }

  const login = async () => {
    setBusy(true); setError('')
    try {
      const { token: t } = await adminLogin(user, pass)
      setToken(t)
      const d = await getAdminDashboard(t)
      setData(d)
      setCounts(d.status_counts ?? {})
      loadDatabases(t)
      loadDemand(t)
    } catch {
      setError('Invalid credentials')
    } finally { setBusy(false) }
  }

  const activateDb = async (file: string) => {
    if (!token) return
    setDbBusy(true); setDbNotice('')
    try {
      const res = await adminActivateDatabase(token, file)
      setDbVersions(res.databases)
      setDbNotice(`Switched to "${res.active}" — ${res.cached_count.toLocaleString()} MPNs, ${res.deep_count.toLocaleString()} deep rows now live.`)
      // Refresh dashboard counts against the newly-active DB.
      const d = await getAdminDashboard(token)
      setData(d); setCounts(d.status_counts ?? {})
    } catch (e) {
      setDbNotice(e instanceof Error ? e.message : 'Failed to switch database.')
    } finally { setDbBusy(false) }
  }

  const removeDb = async (file: string) => {
    if (!token) return
    setDbBusy(true); setDbNotice('')
    try {
      const res = await adminRemoveDatabase(token, file, false)
      setDbVersions(res.databases)
      setDbNotice(`Removed "${file}" from the registry (file kept on disk).`)
    } catch (e) {
      setDbNotice(e instanceof Error ? e.message : 'Failed to remove database.')
    } finally { setDbBusy(false) }
  }

  const reload = async () => {
    if (!token) return
    setBusy(true)
    try {
      const d = await getAdminDashboard(token)
      setData(d)
      setCounts(d.status_counts ?? {})
    } finally { setBusy(false) }
  }

  const runSearch = async () => {
    if (!token) return
    setSearching(true); setNotice('')
    try {
      const res = await adminSearchMpns(token, query.trim(), statusFilter)
      setResults(res.results)
      setCounts(res.status_counts ?? {})
    } catch {
      setNotice('Search failed.')
    } finally { setSearching(false) }
  }

  const requeryOne = async (mpn: string) => {
    if (!token) return
    setRequerying(prev => new Set(prev).add(mpn))
    setNotice('')
    try {
      const res = await adminRequeryMpns(token, [mpn])
      const updated = res.results[0]
      if (updated) {
        setResults(prev => (prev ?? []).map(r => (r.mpn === mpn ? updated : r)))
      }
      setCounts(res.status_counts ?? {})
    } catch {
      setNotice(`Re-query failed for ${mpn}.`)
    } finally {
      setRequerying(prev => { const n = new Set(prev); n.delete(mpn); return n })
    }
  }

  const requeryAllFailed = async () => {
    if (!token) return
    setBulkBusy(true); setNotice('')
    try {
      const res = await adminRequeryFailed(token, ['no_price', 'error'])
      setNotice(res.started
        ? `Re-query job started for ${res.count} failed MPN(s). Track progress in the job panel.`
        : (res.reason ?? 'Nothing to re-query.'))
    } catch {
      setNotice('Failed to start bulk re-query.')
    } finally { setBulkBusy(false) }
  }

  // Re-query every MPN currently shown in the search results (synchronous,
  // chunked into batches of 50 to respect the backend's sync limit).
  const requeryAllResults = async () => {
    if (!token || !results || results.length === 0) return
    const mpns = [...new Set(results.map(r => r.mpn).filter(Boolean))]
    if (mpns.length === 0) return
    setBulkBusy(true); setNotice('')
    setRequerying(new Set(mpns))
    try {
      const CHUNK = 50
      let okTotal = 0
      const merged = new Map(results.map(r => [r.mpn, r]))
      for (let i = 0; i < mpns.length; i += CHUNK) {
        const batch = mpns.slice(i, i + CHUNK)
        const res = await adminRequeryMpns(token, batch)
        for (const u of res.results) if (u?.mpn) merged.set(u.mpn, u)
        okTotal += res.summary?.ok ?? 0
        setResults(Array.from(merged.values()))
        setCounts(res.status_counts ?? {})
        setNotice(`Re-querying… ${Math.min(i + CHUNK, mpns.length)}/${mpns.length} done`)
      }
      setNotice(`Re-queried ${mpns.length} MPN(s) — ${okTotal} resolved with a price.`)
    } catch {
      setNotice('Bulk re-query of searched MPNs failed.')
    } finally {
      setRequerying(new Set())
      setBulkBusy(false)
    }
  }

  return (
    <div className="fixed inset-0 z-[60] bg-black/40 flex items-center justify-center p-4" onMouseDown={onClose}>
      <div
        className="bg-white rounded-2xl shadow-2xl w-full max-w-3xl max-h-[85vh] overflow-hidden flex flex-col"
        onMouseDown={e => e.stopPropagation()}
      >
        <div className="flex items-center justify-between px-5 py-3 border-b border-gray-200">
          <div className="flex items-center gap-2">
            <ShieldCheck size={16} className="text-blue-600" />
            <h3 className="font-bold text-gray-800 text-sm">Admin — Job Error Dashboard</h3>
          </div>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-700"><X size={18} /></button>
        </div>

        {!token ? (
          <div className="p-6 max-w-sm mx-auto w-full">
            <p className="text-sm text-gray-500 mb-4">Sign in to view connection/error metrics.</p>
            <input
              value={user} onChange={e => setUser(e.target.value)} placeholder="Username"
              className="w-full mb-2 px-3 py-2 text-sm border border-gray-300 rounded-lg focus:outline-none focus:border-blue-400"
            />
            <input
              type="password" value={pass} onChange={e => setPass(e.target.value)} placeholder="Password"
              onKeyDown={e => e.key === 'Enter' && login()}
              className="w-full mb-3 px-3 py-2 text-sm border border-gray-300 rounded-lg focus:outline-none focus:border-blue-400"
            />
            {error && <p className="text-xs text-red-500 mb-2">{error}</p>}
            <button
              onClick={login} disabled={busy || !user || !pass}
              className="w-full px-3 py-2 rounded-lg text-sm font-semibold bg-blue-600 text-white hover:bg-blue-700 disabled:opacity-50"
            >
              {busy ? 'Signing in…' : 'Sign in'}
            </button>
          </div>
        ) : (
          <div className="p-5 overflow-y-auto">
            {/* Metrics */}
            <div className="grid grid-cols-3 gap-3 mb-5">
              <div className="rounded-xl bg-gray-50 p-3">
                <p className="text-[10px] text-gray-400 uppercase">Cached MPNs</p>
                <p className="text-2xl font-bold text-gray-800">{data?.cached_count ?? 0}</p>
              </div>
              <div className="rounded-xl bg-red-50 p-3">
                <p className="text-[10px] text-red-400 uppercase">Total errors</p>
                <p className="text-2xl font-bold text-red-700">{data?.metrics.total ?? 0}</p>
              </div>
              <div className="rounded-xl bg-amber-50 p-3">
                <p className="text-[10px] text-amber-500 uppercase">Connection errors</p>
                <p className="text-2xl font-bold text-amber-700">{data?.metrics.by_type?.connection ?? 0}</p>
              </div>
            </div>

            {/* ── Pre-compute job (Run pending / Force full re-run) ── */}
            <div className="rounded-xl border border-gray-200 p-3 mb-5">
              <div className="flex items-center justify-between mb-2">
                <h4 className="text-xs font-bold text-gray-600 uppercase tracking-wide flex items-center gap-1.5">
                  <Database size={13} /> Pre-compute job
                </h4>
                {jobStatus && (
                  <span className="text-[10px] text-gray-400">
                    {jobStatus.running ? 'Running…' : `Last run: ${fmtDateTime(jobStatus.last_run_at)}`}
                  </span>
                )}
              </div>

              {jobStatus?.running ? (
                <div className="mb-2">
                  <div className="flex justify-between text-[11px] text-gray-500 mb-1">
                    <span>{jobStatus.processed} / {jobStatus.total}</span>
                    <span>{jobStatus.success} ok · {jobStatus.errors} err</span>
                  </div>
                  <div className="h-2 rounded-full bg-gray-100 overflow-hidden">
                    <div className="h-full bg-blue-500 transition-all" style={{ width: `${jobStatus.total > 0 ? Math.round((jobStatus.processed / jobStatus.total) * 100) : 0}%` }} />
                  </div>
                </div>
              ) : (
                <p className="text-[10px] text-gray-400 mb-2">
                  Run only pending MPNs, or force a full rebuild into a fresh versioned database (the current one stays live — no data loss).
                </p>
              )}

              {jobNotice && <p className="text-[11px] text-blue-600 mb-2">{jobNotice}</p>}

              <div className="flex flex-wrap gap-2">
                {jobStatus?.running ? (
                  <button
                    onClick={cancelRun} disabled={jobBusy}
                    className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold bg-red-50 text-red-700 border border-red-200 hover:bg-red-100 disabled:opacity-50"
                  >
                    <Square size={12} /> Cancel job
                  </button>
                ) : (
                  <>
                    <button
                      onClick={runPending} disabled={jobBusy}
                      className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold bg-blue-600 text-white hover:bg-blue-700 disabled:opacity-50"
                    >
                      {jobBusy ? <Loader2 size={12} className="animate-spin" /> : <Play size={12} />} Run job (pending only)
                    </button>
                    <button
                      onClick={forceRun} disabled={jobBusy}
                      className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold bg-amber-500 text-white hover:bg-amber-600 disabled:opacity-50"
                      title="Build a fresh database from scratch in the background; current data is preserved until you switch."
                    >
                      {jobBusy ? <Loader2 size={12} className="animate-spin" /> : <RefreshCw size={12} />} Force full re-run
                    </button>
                  </>
                )}
                <a
                  href={dbJobExportUrl()}
                  className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold bg-emerald-50 text-emerald-700 border border-emerald-200 hover:bg-emerald-100"
                >
                  <Download size={12} /> Export results
                </a>
              </div>
            </div>

            {/* ── Search & re-query specific MPNs ── */}
            <div className="rounded-xl border border-gray-200 p-3 mb-5">
              <div className="flex items-center justify-between mb-2">
                <h4 className="text-xs font-bold text-gray-600 uppercase tracking-wide">Search & re-query MPNs</h4>
                <div className="flex items-center gap-1.5 text-[10px]">
                  <span className="px-1.5 py-0.5 rounded bg-emerald-100 text-emerald-700 font-semibold">ok {counts.ok ?? 0}</span>
                  <span className="px-1.5 py-0.5 rounded bg-gray-100 text-gray-600 font-semibold">no_price {counts.no_price ?? 0}</span>
                  <span className="px-1.5 py-0.5 rounded bg-red-100 text-red-700 font-semibold">error {counts.error ?? 0}</span>
                </div>
              </div>

              <div className="flex items-start gap-2 mb-2">
                <div className="relative flex-1">
                  <Search size={13} className="absolute left-2.5 top-2.5 text-gray-400" />
                  <textarea
                    value={query}
                    onChange={e => setQuery(e.target.value)}
                    onKeyDown={e => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); runSearch() } }}
                    placeholder="Paste one or many MPNs / Internal PNs (one per line, or comma/space separated)…"
                    rows={2}
                    className="w-full pl-8 pr-3 py-1.5 text-xs border border-gray-300 rounded-lg focus:outline-none focus:border-blue-400 resize-y font-mono leading-relaxed"
                  />
                </div>
                <div className="flex flex-col gap-1.5 w-[150px] shrink-0">
                  <select
                    value={statusFilter}
                    onChange={e => setStatusFilter(e.target.value)}
                    className="px-2 py-1.5 text-xs border border-gray-300 rounded-lg focus:outline-none focus:border-blue-400 bg-white"
                  >
                    <option value="">All statuses</option>
                    <option value="ok">OK</option>
                    <option value="no_price">No price</option>
                    <option value="error">Error</option>
                  </select>
                  <button
                    onClick={runSearch} disabled={searching}
                    className="flex items-center justify-center gap-1 px-3 py-1.5 rounded-lg text-xs font-semibold bg-blue-600 text-white hover:bg-blue-700 disabled:opacity-50"
                  >
                    {searching ? <Loader2 size={12} className="animate-spin" /> : <Search size={12} />} Search
                  </button>
                  <button
                    onClick={requeryAllFailed} disabled={bulkBusy}
                    title="Re-query all no_price + error entries (background job)"
                    className="flex items-center justify-center gap-1 px-3 py-1.5 rounded-lg text-xs font-semibold bg-amber-500 text-white hover:bg-amber-600 disabled:opacity-50"
                  >
                    {bulkBusy ? <Loader2 size={12} className="animate-spin" /> : <RotateCw size={12} />} Re-query all failed
                  </button>
                </div>
              </div>

              <div className="flex items-center justify-between mb-2 gap-2">
                <p className="text-[10px] text-gray-400">
                  {(() => {
                    const n = query.split(/[\s,;]+/).map(s => s.trim()).filter(Boolean).length
                    return n > 1 ? `${n} terms entered · Ctrl+Enter to search` : 'Tip: paste a list — one MPN/Internal PN per line. Ctrl+Enter to search.'
                  })()}
                </p>
                {results !== null && results.length > 0 && (
                  <button
                    onClick={requeryAllResults} disabled={bulkBusy}
                    title="Re-query every MPN in the results below (synchronous, updates in place)"
                    className="flex items-center gap-1 px-3 py-1.5 rounded-lg text-xs font-semibold bg-blue-50 text-blue-700 border border-blue-200 hover:bg-blue-100 disabled:opacity-50 whitespace-nowrap"
                  >
                    {bulkBusy ? <Loader2 size={12} className="animate-spin" /> : <RotateCw size={12} />} Re-query searched ({results.length})
                  </button>
                )}
              </div>

              {notice && <p className="text-[11px] text-blue-600 mb-2">{notice}</p>}

              {results !== null && (
                <div className="overflow-x-auto rounded-lg border border-gray-200 max-h-72 overflow-y-auto">
                  <table className="min-w-full text-xs border-separate border-spacing-0">
                    <thead className="text-gray-500 sticky top-0 z-[1]">
                      <tr>
                        <th className="px-3 py-2 text-left bg-gray-50 border-b border-gray-200">MPN</th>
                        <th className="px-3 py-2 text-left bg-gray-50 border-b border-gray-200">Internal PN</th>
                        <th className="px-3 py-2 text-left bg-gray-50 border-b border-gray-200">Status</th>
                        <th className="px-3 py-2 text-right bg-gray-50 border-b border-gray-200">Best USD</th>
                        <th className="px-3 py-2 text-left bg-gray-50 border-b border-gray-200">Source</th>
                        <th className="px-3 py-2 text-right bg-gray-50 border-b border-gray-200">Action</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-gray-100">
                      {results.map((r, i) => {
                        const st = r.status ?? (r.bestPriceUsd != null ? 'ok' : 'no_price')
                        const badge = st === 'ok'
                          ? 'bg-emerald-100 text-emerald-700'
                          : st === 'error' ? 'bg-red-100 text-red-700' : 'bg-gray-100 text-gray-600'
                        const isReq = requerying.has(r.mpn)
                        return (
                          <tr key={i} className="hover:bg-gray-50">
                            <td className="px-3 py-1.5 font-mono whitespace-nowrap">{r.mpn}</td>
                            <td className="px-3 py-1.5 font-mono text-gray-500 whitespace-nowrap">{r.internalPN ?? '—'}</td>
                            <td className="px-3 py-1.5">
                              <span className={`px-1.5 py-0.5 rounded text-[10px] font-semibold ${badge}`} title={r.errorDetail ?? ''}>
                                {st}
                              </span>
                            </td>
                            <td className="px-3 py-1.5 text-right tabular-nums">
                              {r.bestPriceUsd != null ? `$${r.bestPriceUsd.toFixed(4)}` : '—'}
                            </td>
                            <td className="px-3 py-1.5 text-gray-500 whitespace-nowrap">{r.bestSource ?? '—'}</td>
                            <td className="px-3 py-1.5 text-right">
                              <button
                                onClick={() => requeryOne(r.mpn)} disabled={isReq}
                                className="inline-flex items-center gap-1 px-2 py-1 rounded-md text-[11px] font-semibold bg-blue-50 text-blue-700 hover:bg-blue-100 disabled:opacity-50"
                              >
                                {isReq ? <Loader2 size={11} className="animate-spin" /> : <RotateCw size={11} />} Re-query
                              </button>
                            </td>
                          </tr>
                        )
                      })}
                      {results.length === 0 && (
                        <tr><td colSpan={6} className="px-3 py-4 text-center text-gray-400">No matching entries</td></tr>
                      )}
                    </tbody>
                  </table>
                </div>
              )}
            </div>

            {/* ── Local database version control ── */}
            <div className="rounded-xl border border-gray-200 p-3 mb-5">
              <div className="flex items-center justify-between mb-2">
                <h4 className="text-xs font-bold text-gray-600 uppercase tracking-wide flex items-center gap-1.5">
                  <Database size={13} /> Local databases (version control)
                </h4>
                <button onClick={() => token && loadDatabases(token)} className="flex items-center gap-1 text-xs text-blue-600 hover:underline">
                  <RefreshCw size={12} /> Refresh
                </button>
              </div>
              <p className="text-[10px] text-gray-400 mb-2">
                A Force full re-run builds a fresh database in the background — the current one stays live so no data is lost.
                Switch to the new version here when it's ready.
              </p>
              {dbNotice && <p className="text-[11px] text-blue-600 mb-2">{dbNotice}</p>}
              {dbVersions.length === 0 ? (
                <p className="text-xs text-gray-400 py-2 text-center">No databases registered.</p>
              ) : (
                <div className="space-y-1.5">
                  {dbVersions.map(db => (
                    <div key={db.file} className={`flex items-center gap-2 px-3 py-2 rounded-lg border ${db.active ? 'bg-emerald-50 border-emerald-200' : 'bg-gray-50 border-gray-200'}`}>
                      <Database size={14} className={db.active ? 'text-emerald-600' : 'text-gray-400'} />
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2">
                          <span className="font-mono text-xs text-gray-800 truncate">{db.file}</span>
                          {db.active && <span className="text-[9px] font-bold bg-emerald-200 text-emerald-800 px-1.5 py-0.5 rounded-full">ACTIVE</span>}
                          {!db.exists && <span className="text-[9px] font-bold bg-amber-200 text-amber-800 px-1.5 py-0.5 rounded-full">MISSING</span>}
                        </div>
                        <div className="text-[10px] text-gray-400">
                          {db.label} · {(db.size_bytes / 1_048_576).toFixed(1)} MB · {fmtDateTime(db.created_at)}
                        </div>
                      </div>
                      {!db.active && db.exists && (
                        <button
                          onClick={() => activateDb(db.file)} disabled={dbBusy}
                          className="flex items-center gap-1 px-2.5 py-1 rounded-md text-[11px] font-semibold bg-blue-600 text-white hover:bg-blue-700 disabled:opacity-50"
                        >
                          {dbBusy ? <Loader2 size={11} className="animate-spin" /> : <CheckCircle2 size={11} />} Activate
                        </button>
                      )}
                      {!db.active && (
                        <button
                          onClick={() => removeDb(db.file)} disabled={dbBusy}
                          className="px-2 py-1 rounded-md text-[11px] font-medium text-gray-500 hover:text-red-600 hover:bg-red-50 disabled:opacity-50"
                          title="Remove from registry (keeps the file on disk)"
                        >
                          <X size={12} />
                        </button>
                      )}
                    </div>
                  ))}
                </div>
              )}
            </div>

            {/* ── Demand databases (dbquery Excel → .db) ── */}
            <div className="rounded-xl border border-gray-200 p-3 mb-5">
              <div className="flex items-center justify-between mb-2">
                <h4 className="text-xs font-bold text-gray-600 uppercase tracking-wide flex items-center gap-1.5">
                  <Database size={13} /> Demand databases (dbquery)
                </h4>
                <div className="flex items-center gap-2">
                  <button onClick={() => token && loadDemand(token)} className="flex items-center gap-1 text-xs text-blue-600 hover:underline">
                    <RefreshCw size={12} /> Refresh
                  </button>
                  <button
                    onClick={() => convertDemand(false)} disabled={demandBusy}
                    title="Convert every Excel file in dbquery to a .db (keeps the originals)"
                    className="flex items-center gap-1 px-2.5 py-1 rounded-lg text-xs font-semibold bg-indigo-600 text-white hover:bg-indigo-700 disabled:opacity-50"
                  >
                    {demandBusy ? <Loader2 size={12} className="animate-spin" /> : <RotateCw size={12} />} Convert Excel files
                  </button>
                </div>
              </div>
              <p className="text-[10px] text-gray-400 mb-2">
                Builds a fast .db from each Excel in <span className="font-mono">dbquery/</span> (Total EAU, Onhand Qty, Gross Demand…). Pick the active one to feed the Supplier Savings Analysis.
                {demandXlsx.length > 0 && <span> · {demandXlsx.length} Excel file{demandXlsx.length !== 1 ? 's' : ''} found</span>}
              </p>
              {demandNotice && <p className="text-[11px] text-indigo-600 mb-2">{demandNotice}</p>}
              {demandDbs.length === 0 ? (
                <p className="text-xs text-gray-400 py-2 text-center">
                  No demand databases yet. Click "Convert Excel files" to build them.
                </p>
              ) : (
                <div className="space-y-1.5">
                  {demandDbs.map(db => (
                    <div key={db.file} className={`flex items-center gap-2 px-3 py-2 rounded-lg border ${db.active ? 'bg-indigo-50 border-indigo-200' : 'bg-gray-50 border-gray-200'}`}>
                      <Database size={14} className={db.active ? 'text-indigo-600' : 'text-gray-400'} />
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2">
                          <span className="font-mono text-xs text-gray-800 truncate">{db.file}</span>
                          {db.active && <span className="text-[9px] font-bold bg-indigo-200 text-indigo-800 px-1.5 py-0.5 rounded-full">ACTIVE</span>}
                          {!db.exists && <span className="text-[9px] font-bold bg-amber-200 text-amber-800 px-1.5 py-0.5 rounded-full">MISSING</span>}
                        </div>
                        <div className="text-[10px] text-gray-400">
                          {db.rows != null ? `${db.rows.toLocaleString()} rows · ` : ''}{(db.size_bytes / 1_048_576).toFixed(1)} MB · {fmtDateTime(db.created_at)}
                        </div>
                      </div>
                      {!db.active && db.exists && (
                        <button
                          onClick={() => activateDemand(db.file)} disabled={demandBusy}
                          className="flex items-center gap-1 px-2.5 py-1 rounded-md text-[11px] font-semibold bg-indigo-600 text-white hover:bg-indigo-700 disabled:opacity-50"
                        >
                          {demandBusy ? <Loader2 size={11} className="animate-spin" /> : <CheckCircle2 size={11} />} Use this
                        </button>
                      )}
                      {!db.active && (
                        <button
                          onClick={() => removeDemand(db.file)} disabled={demandBusy}
                          className="px-2 py-1 rounded-md text-[11px] font-medium text-gray-500 hover:text-red-600 hover:bg-red-50 disabled:opacity-50"
                          title="Remove from registry (keeps the file on disk)"
                        >
                          <X size={12} />
                        </button>
                      )}
                    </div>
                  ))}
                </div>
              )}
            </div>

            <div className="flex items-center justify-between mb-2">
              <h4 className="text-xs font-bold text-gray-600 uppercase tracking-wide">Run history</h4>
              <button onClick={reload} className="flex items-center gap-1 text-xs text-blue-600 hover:underline">
                <RefreshCw size={12} /> Refresh
              </button>
            </div>
            <div className="overflow-x-auto rounded-lg border border-gray-200 mb-5">
              <table className="min-w-full text-xs">
                <thead className="bg-gray-50 text-gray-500">
                  <tr>
                    <th className="px-3 py-2 text-left">Run</th>
                    <th className="px-3 py-2 text-left">Started</th>
                    <th className="px-3 py-2 text-left">Status</th>
                    <th className="px-3 py-2 text-right">Total</th>
                    <th className="px-3 py-2 text-right">OK</th>
                    <th className="px-3 py-2 text-right">Errors</th>
                    <th className="px-3 py-2 text-right">Conn.</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-100">
                  {(data?.runs ?? []).map((r, i) => (
                    <tr key={i} className="hover:bg-gray-50">
                      <td className="px-3 py-1.5 font-mono">#{String(r.id)}</td>
                      <td className="px-3 py-1.5">{fmtDateTime(String(r.started_at ?? ''))}</td>
                      <td className="px-3 py-1.5">
                        <StatusPill status={String(r.status ?? '')} />
                      </td>
                      <td className="px-3 py-1.5 text-right">{String(r.total_mpns ?? 0)}</td>
                      <td className="px-3 py-1.5 text-right text-emerald-600">{String(r.success_count ?? 0)}</td>
                      <td className="px-3 py-1.5 text-right text-red-500">{String(r.error_count ?? 0)}</td>
                      <td className="px-3 py-1.5 text-right text-amber-600">{String(r.conn_errors ?? 0)}</td>
                    </tr>
                  ))}
                  {(data?.runs ?? []).length === 0 && (
                    <tr><td colSpan={7} className="px-3 py-4 text-center text-gray-400">No runs yet</td></tr>
                  )}
                </tbody>
              </table>
            </div>

            <h4 className="text-xs font-bold text-gray-600 uppercase tracking-wide mb-2">Recent errors</h4>
            <div className="overflow-x-auto rounded-lg border border-gray-200 max-h-64 overflow-y-auto">
              <table className="min-w-full text-xs border-separate border-spacing-0">
                <thead className="text-gray-500 sticky top-0 z-[1]">
                  <tr>
                    <th className="px-3 py-2 text-left bg-gray-50 border-b border-gray-200">MPN</th>
                    <th className="px-3 py-2 text-left bg-gray-50 border-b border-gray-200">Type</th>
                    <th className="px-3 py-2 text-left bg-gray-50 border-b border-gray-200">Message</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-100">
                  {(data?.recent_errors ?? []).map((e, i) => (
                    <tr key={i} className="hover:bg-gray-50">
                      <td className="px-3 py-1.5 font-mono whitespace-nowrap">{String(e.mpn ?? '')}</td>
                      <td className="px-3 py-1.5">
                        <span className={`px-1.5 py-0.5 rounded text-[10px] font-semibold ${
                          String(e.error_type) === 'connection'
                            ? 'bg-amber-100 text-amber-700' : 'bg-red-100 text-red-700'
                        }`}>{String(e.error_type ?? '')}</span>
                      </td>
                      <td className="px-3 py-1.5 text-gray-500 max-w-md truncate" title={String(e.message ?? '')}>
                        {String(e.message ?? '')}
                      </td>
                    </tr>
                  ))}
                  {(data?.recent_errors ?? []).length === 0 && (
                    <tr><td colSpan={3} className="px-3 py-4 text-center text-gray-400 flex items-center justify-center gap-1">
                      <CheckCircle2 size={13} className="text-emerald-500" /> No errors recorded
                    </td></tr>
                  )}
                </tbody>
              </table>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}

function StatusPill({ status }: { status: string }) {
  const map: Record<string, string> = {
    done: 'bg-emerald-100 text-emerald-700',
    running: 'bg-blue-100 text-blue-700',
    failed: 'bg-red-100 text-red-700',
    cancelled: 'bg-gray-100 text-gray-500',
  }
  return <span className={`px-1.5 py-0.5 rounded text-[10px] font-semibold ${map[status] ?? 'bg-gray-100 text-gray-500'}`}>{status}</span>
}
