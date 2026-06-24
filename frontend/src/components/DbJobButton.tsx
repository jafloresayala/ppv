// src/components/DbJobButton.tsx — Top-right control for the daily MPN pre-compute job
import { useEffect, useRef, useState, useCallback } from 'react'
import {
  Database, RefreshCw, Download, AlertTriangle, X, ShieldCheck,
  Play, Square, CheckCircle2, Clock, Loader2,
} from 'lucide-react'
import {
  getDbJobStatus, runDbJob, retryDbJobErrors, cancelDbJob, dbJobExportUrl,
  adminLogin, getAdminDashboard,
  type DbJobStatus, type AdminDashboard,
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

  const handleRun = async () => {
    setBusy(true)
    try { await runDbJob(undefined, false); await refresh() } finally { setBusy(false) }
  }
  const handleForceRun = async () => {
    if (!window.confirm('Force a full re-run? This re-processes every MPN from the file, ignoring today\u2019s cache.')) return
    setBusy(true)
    try { await runDbJob(undefined, true); await refresh() } finally { setBusy(false) }
  }
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
            {running ? (
              <button
                onClick={handleCancel} disabled={busy}
                className="flex items-center justify-center gap-2 px-3 py-2 rounded-lg text-xs font-semibold bg-red-50 text-red-700 border border-red-200 hover:bg-red-100 disabled:opacity-50"
              >
                <Square size={13} /> Cancel job
              </button>
            ) : (
              <button
                onClick={handleRun} disabled={busy}
                className="flex items-center justify-center gap-2 px-3 py-2 rounded-lg text-xs font-semibold bg-blue-600 text-white hover:bg-blue-700 disabled:opacity-50"
              >
                <Play size={13} /> Run job (pending only)
              </button>
            )}

            {!running && (status?.cached_count ?? 0) > 0 && (
              <button
                onClick={handleForceRun} disabled={busy}
                className="flex items-center justify-center gap-2 px-3 py-2 rounded-lg text-xs font-semibold bg-white text-gray-600 border border-gray-200 hover:border-gray-300 disabled:opacity-50"
              >
                <RefreshCw size={13} /> Force full re-run
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

  const login = async () => {
    setBusy(true); setError('')
    try {
      const { token: t } = await adminLogin(user, pass)
      setToken(t)
      setData(await getAdminDashboard(t))
    } catch {
      setError('Invalid credentials')
    } finally { setBusy(false) }
  }

  const reload = async () => {
    if (!token) return
    setBusy(true)
    try { setData(await getAdminDashboard(token)) } finally { setBusy(false) }
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
              <table className="min-w-full text-xs">
                <thead className="bg-gray-50 text-gray-500 sticky top-0">
                  <tr>
                    <th className="px-3 py-2 text-left">MPN</th>
                    <th className="px-3 py-2 text-left">Type</th>
                    <th className="px-3 py-2 text-left">Message</th>
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
