// src/components/FullQuoteDataTab.tsx
// Full demand database view. All rows (not just one page) are handed to a
// single DataGrid so filters/search/sort operate over the entire dataset.
// FX conversions (LAST PO ITEM PRICE → USD) are computed for every row up
// front, with rates persisted in localStorage so repeat loads for the same
// currency+date pairs never hit the API again — only unseen pairs are fetched.
// BEST PRICE is computed per MANUFACTURER PART NO: the cheapest converted
// price within a configurable day-window counted back from that MPN's most
// recent LAST ORDERED ON date.
import { useMemo, useState, useEffect, useRef } from 'react'
import { getCurrencyRate } from '../api/client'
import DataGrid, { DataGridColumn } from './DataGrid'

interface FullQuoteRow {
  [key: string]: string | number | boolean | null | undefined
  'TO USD'?: number | string
  'TO USD - BEST PRICE'?: number | string
  'SAVING STATUS'?: number | string
  'GROSS DEMAND X TO USD -BEST PRICE'?: number | string
  'BEST PRICE PLANT'?: string
  'BEST PRICE LAST PO'?: string
  'BEST PRICE VENDOR'?: string
  'BEST PRICE FOR MPN'?: number | string
  'LAST PO QTY x TO USD'?: number | string
  'LAST PO QTY x BEST PRICE'?: number | string
  'LAST PO QTY X STD PRICE'?: number | string
  'PO SAVINGS'?: number | string
  'STD SAVINGS'?: number | string
  '_currencyEmpty'?: boolean
  '_fxFallback'?: boolean
}

interface FullQuoteDataTabProps {
  data: { columns: string[]; rows: Array<Record<string, string | number | null>> } | null
  loading: boolean
  lastPoPriceCol: string
  poQtyCol: string
}

// v2: bumped from 'fx_rates_cache' because the previous version could persist
// SAP's 1.0 last-resort fallback as if it were a genuine rate (e.g. EUR/GBP/CNY
// showing rate=1.0 on dates SAP had no data for). Only genuine, non-fallback
// rates are ever written to this key now.
const FX_CACHE_KEY = 'fx_rates_cache_v2'
const FX_CONCURRENCY = 10
const WINDOW_PRESETS = [30, 45, 90, 365]
const DAY_MS = 86400000

function loadFxCache(): Record<string, number> {
  try {
    const raw = localStorage.getItem(FX_CACHE_KEY)
    return raw ? JSON.parse(raw) : {}
  } catch {
    return {}
  }
}

function saveFxCache(rates: Record<string, number>) {
  try {
    localStorage.setItem(FX_CACHE_KEY, JSON.stringify(rates))
  } catch {
    // Silently ignore localStorage errors (quota, private browsing, etc.)
  }
}

// ── Money formatting (in-app + Excel export) ────────────────────────────────
// ARGB hex colors mirroring the Tailwind bg-*/text-* highlight classes used on
// screen, so the exported Excel file keeps the same visual cues.
const XLSX_COLORS = {
  emeraldFill: 'FFD1FAE5', emeraldFont: 'FF047857',
  redFill: 'FFFEE2E2', redFont: 'FFB91C1C',
  yellowFill: 'FFFEF9C3', yellowFont: 'FFA16207',
  orangeFill: 'FFFFEDD5', orangeFont: 'FFC2410C',
}
// '0.00' forces at least 2 decimals; each trailing '#' adds up to 4 more
// *optional* decimals (only shown if non-zero) — mirrors the 2–6 decimal
// on-screen formatting for per-unit prices without padding round totals.
const MONEY_FORMAT_6DP = '"$"#,##0.00####'
const MONEY_FORMAT_2DP = '"$"#,##0.00'

const moneyFormatter = new Intl.NumberFormat('en-US', {
  style: 'currency', currency: 'USD', minimumFractionDigits: 2, maximumFractionDigits: 6,
})
function formatMoney(v: string | number | null | undefined): string {
  if (v == null || v === '') return '—'
  const n = typeof v === 'number' ? v : Number(v)
  if (!Number.isFinite(n)) return String(v)
  return moneyFormatter.format(n)
}

export default function FullQuoteDataTab({
  data,
  loading,
  lastPoPriceCol,
  poQtyCol,
}: FullQuoteDataTabProps) {
  const [windowDays, setWindowDays] = useState(45)
  const [currencyRates, setCurrencyRates] = useState<Record<string, number>>(() => loadFxCache())
  const [fxProgress, setFxProgress] = useState<{ total: number; done: number; cached: number }>({ total: 0, done: 0, cached: 0 })
  // currency|date pairs SAP could not resolve (rate is a 1.0 placeholder, not
  // a real conversion) — never persisted, only kept for this session so the
  // affected cells can be flagged and easily re-checked.
  const [fxFallbackKeys, setFxFallbackKeys] = useState<Set<string>>(new Set())
  const [refreshToken, setRefreshToken] = useState(0)
  const ratesRef = useRef(currencyRates)
  ratesRef.current = currencyRates

  const normalizeColumnName = (name: string) =>
    String(name ?? '').replace(/[^a-z0-9]+/gi, '').trim().toLowerCase()
  const resolveColumnName = (columns: string[], candidates: string[]) => {
    const map = new Map(columns.map(c => [normalizeColumnName(c), c]))
    for (const candidate of candidates) {
      const hit = map.get(normalizeColumnName(candidate))
      if (hit) return hit
    }
    const normalizedColumns = columns.map(c => ({ raw: c, norm: normalizeColumnName(c) }))
    for (const candidate of candidates) {
      const cand = normalizeColumnName(candidate)
      const loose = normalizedColumns.find(c => c.norm.includes(cand) || cand.includes(c.norm))
      if (loose) return loose.raw
    }
    return null
  }

  const discoverableColumns = useMemo(() => {
    if (!data) return []
    const fromRows = data.rows.length ? Object.keys(data.rows[0] ?? {}) : []
    return Array.from(new Set([...data.columns, ...fromRows]))
  }, [data])

  const resolvedPriceCol = useMemo(
    () => discoverableColumns.length
      ? resolveColumnName(discoverableColumns, ['LAST PO ITEM PRICE', 'Last PO Item Price'])
      : null,
    [discoverableColumns]
  )
  const resolvedQtyCol = useMemo(
    () => discoverableColumns.length
      ? resolveColumnName(discoverableColumns, ['PURCHASE ORDER QUANTITY', 'Purchase Order Quantity'])
      : null,
    [discoverableColumns]
  )
  const resolvedCurrencyCol = useMemo(
    () => discoverableColumns.length
      ? resolveColumnName(discoverableColumns, ['CURRENCY.2', 'CURRENCY 2', 'Currency', 'Currency 2'])
      : null,
    [discoverableColumns]
  )
  const resolvedDateCol = useMemo(
    () => discoverableColumns.length
      ? resolveColumnName(discoverableColumns, [
          'LAST ORDERER ON',
          'Last Orderer On',
          'LAST ORDERED ON',
          'Last Ordered On',
          'Last PO Date',
          'PO Date',
        ])
      : null,
    [discoverableColumns]
  )
  const resolvedStdPriceCol = useMemo(
    () => discoverableColumns.length
      ? resolveColumnName(discoverableColumns, ['STANDARD PRICE', 'Standard Price', 'STD PRICE', 'Std Price'])
      : null,
    [discoverableColumns]
  )
  const resolvedMpnCol = useMemo(
    () => discoverableColumns.length
      ? resolveColumnName(discoverableColumns, ['MANUFACTURER PART NO', 'MANUFACTURER PART NO.', 'Manufacturer Part No', 'MPN'])
      : null,
    [discoverableColumns]
  )
  const resolvedGrossDemandCol = useMemo(
    () => discoverableColumns.length
      ? resolveColumnName(discoverableColumns, ['GROSS DEMAND', 'Gross Demand'])
      : null,
    [discoverableColumns]
  )
  const resolvedPlantNameCol = useMemo(
    () => discoverableColumns.length
      ? resolveColumnName(discoverableColumns, ['plant_name', 'Plant Name', 'PLANT_NAME', 'Plant'])
      : null,
    [discoverableColumns]
  )
  const resolvedVendorCol = useMemo(
    () => discoverableColumns.length
      ? resolveColumnName(discoverableColumns, ['Last Vendor Name', 'Source Vendor Name',  'Vendor Name', 'Supplier Name'])
      : null,
    [discoverableColumns]
  )
  // Distinct from resolvedDateCol (LAST ORDERED ON, used for the best-price
  // window math) — this is the actual "LAST PO" column value shown in the
  // BEST PRICE LAST PO column.
  const resolvedLastPoCol = useMemo(
    () => discoverableColumns.length
      ? resolveColumnName(discoverableColumns, ['LAST PO', 'Last PO'])
      : null,
    [discoverableColumns]
  )

  const rawRows = useMemo(() => data?.rows || [], [data])
  const totalRows = rawRows.length

  // Fetch FX rates for every unique (currency, date) pair across the ENTIRE
  // dataset — not just one page — so every row's conversion (and therefore
  // every MPN's best price) is correct. Already-cached pairs (from a previous
  // session, via localStorage) never hit the API again.
  useEffect(() => {
    if (!resolvedCurrencyCol || !resolvedDateCol || !rawRows.length) {
      setFxProgress({ total: 0, done: 0, cached: 0 })
      return
    }

    const pending = new Map<string, { currency: string; date: string }>()
    let cachedCount = 0
    const seenKeys = new Set<string>()
    for (const row of rawRows) {
      const rawCurrency = String(row[resolvedCurrencyCol] ?? '').trim().toUpperCase()
      if (!rawCurrency || rawCurrency === 'USD') continue
      const rawDate = String(row[resolvedDateCol] ?? '').trim()
      const normalizedDate = rawDate ? rawDate.slice(0, 10) : ''
      if (!normalizedDate) continue
      const key = `${rawCurrency}|${normalizedDate}`
      if (seenKeys.has(key)) continue
      seenKeys.add(key)
      if (key in ratesRef.current) { cachedCount += 1; continue }
      pending.set(key, { currency: rawCurrency, date: normalizedDate })
    }

    if (!pending.size) {
      setFxProgress({ total: cachedCount, done: cachedCount, cached: cachedCount })
      return
    }

    let cancelled = false
    setFxProgress({ total: cachedCount + pending.size, done: cachedCount, cached: cachedCount })

    const run = async () => {
      const entries = [...pending.entries()]
      const allNewRates: Record<string, number> = {}
      const persistable: Record<string, number> = {}
      const fallbackKeysThisRun = new Set<string>()
      let doneCount = cachedCount

      for (let i = 0; i < entries.length; i += FX_CONCURRENCY) {
        if (cancelled) return
        const batch = entries.slice(i, i + FX_CONCURRENCY)
        const results = await Promise.all(batch.map(async ([key, req]) => {
          try {
            const res = await getCurrencyRate(req.currency, req.date)
            return { key, rate: res.rate, ok: true, isFallback: !!res.is_fallback }
          } catch {
            return { key, rate: 1, ok: false, isFallback: true }
          }
        }))
        if (cancelled) return
        for (const r of results) {
          allNewRates[r.key] = r.rate
          // Only genuine, non-fallback rates are safe to persist — SAP's 1.0
          // last-resort placeholder must never be cached as a real rate.
          if (r.ok && !r.isFallback) persistable[r.key] = r.rate
          if (r.isFallback) fallbackKeysThisRun.add(r.key)
        }
        doneCount += results.length
        setFxProgress({ total: cachedCount + pending.size, done: doneCount, cached: cachedCount })
      }

      if (!cancelled) {
        setCurrencyRates(prev => {
          const merged = { ...prev, ...allNewRates }
          if (Object.keys(persistable).length) saveFxCache({ ...prev, ...persistable })
          return merged
        })
        setFxFallbackKeys(prev => {
          const next = new Set(prev)
          // Clear the flag for every key we just re-attempted, then re-add
          // only the ones that are still unresolved this run.
          for (const [key] of entries) next.delete(key)
          for (const key of fallbackKeysThisRun) next.add(key)
          return next
        })
      }
    }

    void run()
    return () => { cancelled = true }
  }, [rawRows, resolvedCurrencyCol, resolvedDateCol, refreshToken])

  // Force a fresh lookup for every currency/date pair used by the currently
  // loaded rows, bypassing the local cache — useful when previously-cached
  // rates look wrong (e.g. stale 1.0 fallbacks from before this fix).
  const clearRatesAndRefetch = (keys: Set<string>) => {
    if (!keys.size) return
    setCurrencyRates(prev => {
      const next = { ...prev }
      for (const key of keys) delete next[key]
      saveFxCache(next)
      return next
    })
    setFxFallbackKeys(prev => {
      const next = new Set(prev)
      for (const key of keys) next.delete(key)
      return next
    })
    setRefreshToken(t => t + 1)
  }

  const handleRefetchRates = () => {
    if (!resolvedCurrencyCol || !resolvedDateCol || !rawRows.length) return
    const keysInUse = new Set<string>()
    for (const row of rawRows) {
      const rawCurrency = String(row[resolvedCurrencyCol] ?? '').trim().toUpperCase()
      if (!rawCurrency || rawCurrency === 'USD') continue
      const rawDate = String(row[resolvedDateCol] ?? '').trim()
      const normalizedDate = rawDate ? rawDate.slice(0, 10) : ''
      if (!normalizedDate) continue
      keysInUse.add(`${rawCurrency}|${normalizedDate}`)
    }
    clearRatesAndRefetch(keysInUse)
  }

  // Re-check only the currency/date pairs that currently returned SAP's 1.0
  // last-resort fallback (i.e. no genuine rate was found), instead of
  // re-querying every pair in the dataset.
  const handleRefetchFallbackRates = () => {
    clearRatesAndRefetch(new Set(fxFallbackKeys))
  }

  const displayRows = useMemo(() => {
    if (!rawRows.length) return []

    // Step 1: resolve TO-USD price + parsed date + MPN key for every row.
    const withUsd = rawRows.map(row => {
      const priceValue = Number(row[resolvedPriceCol ?? lastPoPriceCol] ?? 0)
      const qtyValue = Number(row[resolvedQtyCol ?? poQtyCol] ?? 0)
      const stdPriceValue = Number(row[resolvedStdPriceCol ?? ''] ?? 0)
      const currencyValue = String(row[resolvedCurrencyCol ?? ''] ?? '').trim().toUpperCase()
      const dateValue = String(row[resolvedDateCol ?? ''] ?? '').trim()
      const dateKey = dateValue ? dateValue.slice(0, 10) : ''
      const rate = currencyValue && currencyValue !== 'USD' && dateKey ? currencyRates[`${currencyValue}|${dateKey}`] ?? 1 : 1
      const currencyToUsd =
        !Number.isNaN(priceValue) && priceValue > 0 && currencyValue && currencyValue !== 'USD' && rate > 0
          ? priceValue / rate
          : priceValue
      const toUsd = Number.isFinite(currencyToUsd) ? currencyToUsd : priceValue
      const dateMs = dateKey ? new Date(dateKey).getTime() : NaN
      const mpnKey = resolvedMpnCol ? String(row[resolvedMpnCol] ?? '').trim().toUpperCase() : ''
      // An unresolved FX rate (SAP's 1.0 last-resort placeholder) leaves the
      // raw local-currency price masquerading as USD — it can be wildly wrong
      // (off by orders of magnitude) and must never be trusted for best-price math.
      const isFxFallback = currencyValue && currencyValue !== 'USD' && dateKey
        ? fxFallbackKeys.has(`${currencyValue}|${dateKey}`)
        : false

      return { row, priceValue, qtyValue, stdPriceValue, currencyValue, dateKey, toUsd, dateMs, mpnKey, isFxFallback }
    })

    // Step 2: per MPN, the best price is the cheapest TO-USD value within
    // `windowDays` of that MPN's latest LAST ORDERED ON date (falls back to
    // the cheapest overall if nothing falls inside the window). Rows with an
    // unresolved FX rate are excluded from this comparison whenever at least
    // one reliably-converted row exists for that MPN, so a bad conversion can
    // never win the MIN() over a genuine price (only used as a last resort if
    // literally every purchase of that MPN lacks a resolved rate). We keep the
    // whole winning row (not just its price) so we can surface which plant,
    // vendor and PO date that best price came from.
    const bestByMpn = new Map<string, { price: number; bestRow: typeof withUsd[number]['row'] }>()
    if (resolvedMpnCol) {
      const groups = new Map<string, typeof withUsd>()
      for (const item of withUsd) {
        if (!item.mpnKey || !(item.toUsd > 0)) continue
        const arr = groups.get(item.mpnKey)
        if (arr) arr.push(item)
        else groups.set(item.mpnKey, [item])
      }
      for (const [mpnKey, items] of groups) {
        const reliable = items.filter(i => !i.isFxFallback)
        const candidates = reliable.length ? reliable : items
        const validDates = candidates.map(i => i.dateMs).filter(t => Number.isFinite(t))
        const maxT = validDates.length ? Math.max(...validDates) : null
        const windowStart = maxT != null ? maxT - windowDays * DAY_MS : null
        const inWindow = windowStart != null
          ? candidates.filter(i => Number.isFinite(i.dateMs) && i.dateMs >= windowStart)
          : candidates
        const pool = inWindow.length ? inWindow : candidates
        const bestItem = pool.reduce((min, i) => (min == null || i.toUsd < min.toUsd ? i : min), null as typeof pool[number] | null)
        if (bestItem) bestByMpn.set(mpnKey, { price: bestItem.toUsd, bestRow: bestItem.row })
      }
    }

    // Step 3: build the final display rows with per-MPN best-price savings.
    return withUsd.map(({ row, qtyValue, stdPriceValue, currencyValue, dateKey, toUsd, mpnKey, isFxFallback }) => {
      const bestEntry = mpnKey ? bestByMpn.get(mpnKey) ?? null : null
      const bestPriceForMpn = bestEntry ? bestEntry.price : null
      const bestPlantValue = bestEntry ? String(bestEntry.bestRow[resolvedPlantNameCol ?? ''] ?? '').trim() : ''
      const bestLastPoValue = bestEntry
        ? String(bestEntry.bestRow[resolvedLastPoCol ?? resolvedDateCol ?? ''] ?? '').trim()
        : ''
      const bestVendorValue = bestEntry ? String(bestEntry.bestRow[resolvedVendorCol ?? ''] ?? '').trim() : ''
      const total = toUsd * (Number.isFinite(qtyValue) ? qtyValue : 0)
      const qtyXBestPrice = bestPriceForMpn != null && Number.isFinite(qtyValue) ? bestPriceForMpn * qtyValue : 0
      const qtyXStdPrice = stdPriceValue * (Number.isFinite(qtyValue) ? qtyValue : 0)
      const poSavings = total - qtyXBestPrice
      const stdSavings = stdPriceValue * qtyValue - qtyXBestPrice
      const toUsdMinusBest = bestPriceForMpn != null && Number.isFinite(toUsd) ? toUsd - bestPriceForMpn : null
      const grossDemandValue = resolvedGrossDemandCol ? Number(row[resolvedGrossDemandCol] ?? 0) : NaN
      // A negative GROSS DEMAND means excess inventory (no need to buy more),
      // so a "savings" figure computed from it is not a real opportunity —
      // SAVING STATUS flags this explicitly instead of silently letting two
      // negative numbers (negative demand × already-cheaper price) multiply
      // into a misleading positive "savings" result.
      const savingStatus = Number.isFinite(grossDemandValue) ? (grossDemandValue > 0 ? 1 : 0) : ''
      const grossDemandXToUsdBestPrice = toUsdMinusBest != null && Number.isFinite(grossDemandValue)
        ? grossDemandValue * toUsdMinusBest
        : null

      return {
        ...row,
        'TO USD': Number.isFinite(toUsd) ? Number(toUsd.toFixed(6)) : '',
        'TO USD - BEST PRICE': toUsdMinusBest != null ? Number(toUsdMinusBest.toFixed(6)) : '',
        'SAVING STATUS': savingStatus,
        'GROSS DEMAND X TO USD -BEST PRICE': grossDemandXToUsdBestPrice != null ? Number(grossDemandXToUsdBestPrice.toFixed(2)) : '',
        'BEST PRICE PLANT': bestPlantValue,
        'BEST PRICE LAST PO': bestLastPoValue,
        'BEST PRICE VENDOR': bestVendorValue,
        'BEST PRICE FOR MPN': bestPriceForMpn != null ? Number(bestPriceForMpn.toFixed(6)) : '',
        'LAST PO QTY x TO USD': Number.isFinite(total) ? Number(total.toFixed(2)) : '',
        'LAST PO QTY x BEST PRICE': Number.isFinite(qtyXBestPrice) ? Number(qtyXBestPrice.toFixed(2)) : '',
        'LAST PO QTY X STD PRICE': Number.isFinite(qtyXStdPrice) ? Number(qtyXStdPrice.toFixed(2)) : '',
        'PO SAVINGS': Number.isFinite(poSavings) ? Number(poSavings.toFixed(2)) : '',
        'STD SAVINGS': Number.isFinite(stdSavings) ? Number(stdSavings.toFixed(2)) : '',
        '_currencyEmpty': !currencyValue || currencyValue.trim() === '',
        '_fxFallback': isFxFallback,
      } as FullQuoteRow
    })
  }, [rawRows, currencyRates, fxFallbackKeys, lastPoPriceCol, poQtyCol, resolvedPriceCol, resolvedQtyCol, resolvedCurrencyCol, resolvedDateCol, resolvedStdPriceCol, resolvedMpnCol, resolvedGrossDemandCol, resolvedPlantNameCol, resolvedVendorCol, resolvedLastPoCol, windowDays])

  const uniqueMpnCount = useMemo(() => {
    if (!resolvedMpnCol || !rawRows.length) return 0
    const set = new Set<string>()
    for (const row of rawRows) {
      const v = String(row[resolvedMpnCol] ?? '').trim()
      if (v) set.add(v.toUpperCase())
    }
    return set.size
  }, [rawRows, resolvedMpnCol])

  if (loading) {
    return (
      <div className="flex flex-col h-full overflow-hidden">
        <div className="p-4 flex items-start justify-start">
          <div className="text-sm text-gray-500">⏳ Loading full demand data…</div>
        </div>
      </div>
    )
  }

  if (!data || !data.columns.length || !data.rows.length) {
    return (
      <div className="flex flex-col h-full overflow-hidden">
        <div className="p-4 text-sm text-gray-500 space-y-2">
          <div>❌ No demand database loaded yet.</div>
          <div className="text-xs text-gray-400 space-y-1 bg-gray-50 p-2 rounded border border-gray-200 font-mono">
            <div className="font-bold text-gray-600">Debug Info:</div>
            <div>• Data prop exists: {data ? 'yes' : 'no'}</div>
            <div>• Columns: {data?.columns?.length ?? 0}</div>
            <div>• Rows: {data?.rows?.length ?? 0}</div>
            {data && (
              <>
                <div>• First column: {data.columns?.[0] ?? 'N/A'}</div>
                <div>• Sample row keys: {data.rows?.[0] ? Object.keys(data.rows[0]).slice(0, 3).join(', ') : 'N/A'}</div>
              </>
            )}
            <div className="mt-1 text-gray-500">👉 Check browser console for full API response</div>
          </div>
        </div>
      </div>
    )
  }

  const excludedColumnNames = new Set(['PLANT_CODE', 'PLANT_NAME', 'PRICE UNIT2', 'CURRENCY3', 'PRICE UNIT4', 'CURRENCY5'])
  const normalizedColumnName = (name: string) => String(name ?? '').replace(/\s+/g, ' ').trim().toUpperCase()
  const visibleColumns = data.columns.filter(c => !excludedColumnNames.has(normalizedColumnName(c)))

  const cols: DataGridColumn<FullQuoteRow>[] = visibleColumns.map((c, i) => {
    const normalized = normalizedColumnName(c)
    // Only the two genuine money source columns get $ formatting — other
    // columns containing "PRICE" (e.g. PRICE UNIT) are quantities, not money.
    const isMoneyCol = c === resolvedPriceCol || c === resolvedStdPriceCol
    // Any column holding an actual date (LAST ORDERED ON doesn't have "DATE"
    // in its name, so it's matched explicitly; other columns like LAST PO
    // DELIVERY DUE DATE are caught by the "DATE" substring) get a date-range
    // filter instead of a plain text filter.
    const isDateCol = c === resolvedDateCol || normalizedColumnName(c).includes('DATE')
    let width = ''
    if (i === 0) {
      width = 'sticky left-0 z-[2] bg-white'
    } else if (
      normalized.includes('PRICE') ||
      normalized.includes('QUANTITY') ||
      normalized.includes('QTY') ||
      normalized.includes('DATE') ||
      normalized.includes('CURRENCY')
    ) {
      width = 'w-24'
    } else if (normalized.includes('PLANT') || normalized.includes('SUPPLIER')) {
      width = 'flex-1 min-w-32'
    }

    return {
      key: c,
      header: c,
      accessor: r => (r[c] ?? '') as string | number,
      render: r => {
        const raw = r[c]
        const norm = normalizedColumnName(c)
        if (norm === 'GROSS DEMAND') {
          const n = raw == null || raw === '' ? null : Number(raw)
          if (n == null || Number.isNaN(n)) return String(raw ?? '—')
          const cls = n < 0 ? 'bg-emerald-100 text-emerald-700' : n > 0 ? 'bg-red-100 text-red-700' : 'text-gray-700'
          return <span className={`inline-block w-full ${cls}`}>{String(raw)}</span>
        }
        if (isMoneyCol) return formatMoney(raw as string | number | null | undefined)
        return String(raw ?? '')
      },
      type: isMoneyCol ? 'number' : isDateCol ? 'date' : 'text',
      align: isMoneyCol ? 'right' : 'left',
      noSort: false,
      width: width,
      numberFormat: isMoneyCol ? MONEY_FORMAT_6DP : undefined,
    }
  })

  cols.push({
    key: 'BEST PRICE PLANT',
    header: 'BEST PRICE PLANT',
    accessor: r => r['BEST PRICE PLANT'] ?? '',
    render: r => String(r['BEST PRICE PLANT'] ?? '') || '—',
    type: 'select',
    align: 'left',
    width: 'w-24',
  })

  cols.push({
    key: 'BEST PRICE LAST PO',
    header: 'BEST PRICE LAST PO',
    accessor: r => r['BEST PRICE LAST PO'] ?? '',
    render: r => String(r['BEST PRICE LAST PO'] ?? '') || '—',
    type: 'text',
    align: 'left',
    width: 'w-24',
  })

  cols.push({
    key: 'BEST PRICE VENDOR',
    header: 'BEST PRICE VENDOR',
    accessor: r => r['BEST PRICE VENDOR'] ?? '',
    render: r => String(r['BEST PRICE VENDOR'] ?? '') || '—',
    type: 'text',
    align: 'left',
    width: 'flex-1 min-w-32',
  })

  cols.push({
    key: 'BEST PRICE FOR MPN',
    header: 'BEST PRICE (MPN)',
    accessor: r => r['BEST PRICE FOR MPN'] ?? '',
    render: r => formatMoney(r['BEST PRICE FOR MPN']),
    type: 'number',
    align: 'right',
    width: 'w-24',
    numberFormat: MONEY_FORMAT_6DP,
  })

  cols.push({
    key: 'TO USD',
    header: 'LAST PO ITEM PRICE TO USD',
    accessor: r => r['TO USD'] ?? '',
    render: r => {
      const v = r['TO USD']
      const isEmpty = r['_currencyEmpty']
      const isFallback = r['_fxFallback']
      if (v == null || v === '') return '—'
      const cls = isFallback ? 'bg-orange-100 text-orange-700' : isEmpty ? 'bg-yellow-100 text-yellow-700' : 'text-gray-700'
      return (
        <span className={`inline-block w-full ${cls}`} title={isFallback ? 'No se encontró tasa de cambio SAP para esta moneda/fecha — valor sin convertir (1:1) hasta volver a consultar' : undefined}>{formatMoney(v)}</span>
      )
    },
    type: 'number',
    align: 'right',
    width: 'w-24',
    numberFormat: MONEY_FORMAT_6DP,
    exportFill: r => r['_fxFallback'] ? XLSX_COLORS.orangeFill : r['_currencyEmpty'] ? XLSX_COLORS.yellowFill : null,
    exportFontColor: r => r['_fxFallback'] ? XLSX_COLORS.orangeFont : r['_currencyEmpty'] ? XLSX_COLORS.yellowFont : null,
  })

  cols.push({
    key: 'TO USD - BEST PRICE',
    header: 'TO USD - BEST PRICE',
    accessor: r => r['TO USD - BEST PRICE'] ?? '',
    render: r => {
      const v = r['TO USD - BEST PRICE']
      if (v == null || v === '') return '—'
      const n = typeof v === 'number' ? v : Number(v)
      const cls = n > 0 ? 'bg-emerald-100 text-emerald-700' : n < 0 ? 'bg-red-100 text-red-700' : 'text-gray-700'
      return (
        <span className={`inline-block w-full ${cls}`}>{formatMoney(v)}</span>
      )
    },
    type: 'number',
    align: 'right',
    width: 'w-28',
    numberFormat: MONEY_FORMAT_6DP,
    exportFill: r => {
      const v = r['TO USD - BEST PRICE']
      if (v == null || v === '') return null
      const n = typeof v === 'number' ? v : Number(v)
      return n > 0 ? XLSX_COLORS.emeraldFill : n < 0 ? XLSX_COLORS.redFill : null
    },
    exportFontColor: r => {
      const v = r['TO USD - BEST PRICE']
      if (v == null || v === '') return null
      const n = typeof v === 'number' ? v : Number(v)
      return n > 0 ? XLSX_COLORS.emeraldFont : n < 0 ? XLSX_COLORS.redFont : null
    },
  })

  cols.push({
    key: 'LAST PO QTY x BEST PRICE',
    header: 'LAST PO QTY X BEST PRICE (MPN)',
    accessor: r => r['LAST PO QTY x BEST PRICE'] ?? '',
    render: r => formatMoney(r['LAST PO QTY x BEST PRICE']),
    type: 'number',
    align: 'right',
    width: 'w-28',
    numberFormat: MONEY_FORMAT_2DP,
  })

  cols.push({
    key: 'PO QTY x TO CURRENCY',
    header: 'LAST PO QTY x TO USD',
    accessor: r => r['LAST PO QTY x TO USD'] ?? '',
    render: r => {
      const v = r['LAST PO QTY x TO USD']
      const isEmpty = r['_currencyEmpty']
      const isFallback = r['_fxFallback']
      if (v == null || v === '') return '—'
      const cls = isFallback ? 'bg-orange-100 text-orange-700' : isEmpty ? 'bg-yellow-100 text-yellow-700' : 'text-gray-700'
      return (
        <span className={`inline-block w-full ${cls}`} title={isFallback ? 'No se encontró tasa de cambio SAP para esta moneda/fecha — valor sin convertir (1:1) hasta volver a consultar' : undefined}>{formatMoney(v)}</span>
      )
    },
    type: 'number',
    align: 'right',
    width: 'w-28',
    numberFormat: MONEY_FORMAT_2DP,
    exportFill: r => r['_fxFallback'] ? XLSX_COLORS.orangeFill : r['_currencyEmpty'] ? XLSX_COLORS.yellowFill : null,
    exportFontColor: r => r['_fxFallback'] ? XLSX_COLORS.orangeFont : r['_currencyEmpty'] ? XLSX_COLORS.yellowFont : null,
  })

  cols.push({
    key: 'LAST PO QTY X STD PRICE',
    header: 'LAST PO QTY X STD PRICE',
    accessor: r => r['LAST PO QTY X STD PRICE'] ?? '',
    render: r => formatMoney(r['LAST PO QTY X STD PRICE']),
    type: 'number',
    align: 'right',
    width: 'w-28',
    numberFormat: MONEY_FORMAT_2DP,
  })

  cols.push({
    key: 'PO SAVINGS',
    header: 'PO SAVINGS',
    accessor: r => r['PO SAVINGS'] ?? '',
    render: r => {
      const v = r['PO SAVINGS']
      if (v == null || v === '') return '—'
      const n = typeof v === 'number' ? v : Number(v)
      const cls = n > 0 ? 'bg-emerald-100 text-emerald-700' : n < 0 ? 'bg-red-100 text-red-700' : 'text-gray-700'
      return (
        <span className={`inline-block w-full ${cls}`}>{formatMoney(v)}</span>
      )
    },
    type: 'number',
    align: 'right',
    width: 'w-24',
    numberFormat: MONEY_FORMAT_2DP,
    exportFill: r => {
      const v = r['PO SAVINGS']
      if (v == null || v === '') return null
      const n = typeof v === 'number' ? v : Number(v)
      return n > 0 ? XLSX_COLORS.emeraldFill : n < 0 ? XLSX_COLORS.redFill : null
    },
    exportFontColor: r => {
      const v = r['PO SAVINGS']
      if (v == null || v === '') return null
      const n = typeof v === 'number' ? v : Number(v)
      return n > 0 ? XLSX_COLORS.emeraldFont : n < 0 ? XLSX_COLORS.redFont : null
    },
  })

  cols.push({
    key: 'STD SAVINGS',
    header: 'STD SAVINGS',
    accessor: r => r['STD SAVINGS'] ?? '',
    render: r => {
      const v = r['STD SAVINGS']
      if (v == null || v === '') return '—'
      const n = typeof v === 'number' ? v : Number(v)
      const cls = n > 0 ? 'bg-emerald-100 text-emerald-700' : n < 0 ? 'bg-red-100 text-red-700' : 'text-gray-700'
      return (
        <span className={`inline-block w-full ${cls}`}>{formatMoney(v)}</span>
      )
    },
    type: 'number',
    align: 'right',
    width: 'w-24',
    numberFormat: MONEY_FORMAT_2DP,
    exportFill: r => {
      const v = r['STD SAVINGS']
      if (v == null || v === '') return null
      const n = typeof v === 'number' ? v : Number(v)
      return n > 0 ? XLSX_COLORS.emeraldFill : n < 0 ? XLSX_COLORS.redFill : null
    },
    exportFontColor: r => {
      const v = r['STD SAVINGS']
      if (v == null || v === '') return null
      const n = typeof v === 'number' ? v : Number(v)
      return n > 0 ? XLSX_COLORS.emeraldFont : n < 0 ? XLSX_COLORS.redFont : null
    },
  })

  cols.push({
    key: 'SAVING STATUS',
    header: 'SAVING STATUS',
    accessor: r => r['SAVING STATUS'] ?? '',
    render: r => {
      const v = r['SAVING STATUS']
      if (v == null || v === '') return '—'
      const isReal = Number(v) === 1
      const cls = isReal ? 'bg-emerald-100 text-emerald-700' : 'bg-gray-100 text-gray-500'
      return (
        <span
          className={`inline-block w-full text-center font-semibold ${cls}`}
          title={isReal ? 'GROSS DEMAND es positivo: oportunidad de ahorro real' : 'GROSS DEMAND no es positivo (exceso de inventario): no es una oportunidad de ahorro real'}
        >
          {String(v)}
        </span>
      )
    },
    type: 'select',
    align: 'center',
    width: 'w-20',
    exportFill: r => {
      const v = r['SAVING STATUS']
      if (v == null || v === '') return null
      return Number(v) === 1 ? XLSX_COLORS.emeraldFill : null
    },
    exportFontColor: r => {
      const v = r['SAVING STATUS']
      if (v == null || v === '') return null
      return Number(v) === 1 ? XLSX_COLORS.emeraldFont : null
    },
  })

  cols.push({
    key: 'GROSS DEMAND X TO USD -BEST PRICE',
    header: 'GROSS DEMAND X TO USD -BEST PRICE',
    accessor: r => r['GROSS DEMAND X TO USD -BEST PRICE'] ?? '',
    render: r => {
      const v = r['GROSS DEMAND X TO USD -BEST PRICE']
      if (v == null || v === '') return '—'
      // A negative GROSS DEMAND (excess inventory) means this is not a real
      // savings opportunity, regardless of the arithmetic sign of the
      // product — only color it as savings/overspend when SAVING STATUS = 1.
      const isRealOpportunity = r['SAVING STATUS'] === 1 || r['SAVING STATUS'] === '1'
      const n = typeof v === 'number' ? v : Number(v)
      const cls = !isRealOpportunity
        ? 'bg-gray-100 text-gray-400'
        : n > 0 ? 'bg-emerald-100 text-emerald-700' : n < 0 ? 'bg-red-100 text-red-700' : 'text-gray-700'
      return (
        <span
          className={`inline-block w-full ${cls}`}
          title={!isRealOpportunity ? 'GROSS DEMAND no es positivo (exceso de inventario) — no es una oportunidad de ahorro real' : undefined}
        >
          {formatMoney(v)}
        </span>
      )
    },
    type: 'number',
    align: 'right',
    width: 'w-32',
    numberFormat: MONEY_FORMAT_2DP,
    exportFill: r => {
      const v = r['GROSS DEMAND X TO USD -BEST PRICE']
      if (v == null || v === '') return null
      const isRealOpportunity = r['SAVING STATUS'] === 1 || r['SAVING STATUS'] === '1'
      if (!isRealOpportunity) return null
      const n = typeof v === 'number' ? v : Number(v)
      return n > 0 ? XLSX_COLORS.emeraldFill : n < 0 ? XLSX_COLORS.redFill : null
    },
    exportFontColor: r => {
      const v = r['GROSS DEMAND X TO USD -BEST PRICE']
      if (v == null || v === '') return null
      const isRealOpportunity = r['SAVING STATUS'] === 1 || r['SAVING STATUS'] === '1'
      if (!isRealOpportunity) return null
      const n = typeof v === 'number' ? v : Number(v)
      return n > 0 ? XLSX_COLORS.emeraldFont : n < 0 ? XLSX_COLORS.redFont : null
    },
  })

  const fxPending = fxProgress.total - fxProgress.cached
  const fxDone = Math.max(0, fxProgress.done - fxProgress.cached)
  const isRefetching = fxPending > 0 && fxDone < fxPending

  return (
    <div className="flex flex-col h-full overflow-hidden p-4 gap-2">
      {/* Header info */}
      <div className="text-[11px] text-gray-600 shrink-0 flex flex-wrap items-center gap-3">
        <span>
          Full demand database · Total rows: <span className="font-mono font-bold">{totalRows.toLocaleString()}</span> · Unique MPNs: <span className="font-mono font-bold">{uniqueMpnCount.toLocaleString()}</span>
        </span>
        <label className="flex items-center gap-1.5">
          <span className="text-gray-500">Window (days):</span>
          <input
            type="number" min={1} max={3650} value={windowDays}
            onChange={e => setWindowDays(Math.max(1, Number(e.target.value) || 1))}
            className="w-16 px-1.5 py-0.5 text-[11px] border border-gray-200 rounded focus:outline-none focus:ring-1 focus:ring-brand/40"
          />
          <div className="flex gap-0.5">
            {WINDOW_PRESETS.map(d => (
              <button
                key={d}
                onClick={() => setWindowDays(d)}
                className={`px-1.5 py-0.5 text-[10px] rounded font-semibold transition-colors ${windowDays === d ? 'bg-emerald-600 text-white' : 'bg-gray-100 text-gray-500 hover:bg-gray-200'}`}
              >
                {d}
              </button>
            ))}
          </div>
        </label>
        <span className="text-gray-500">
          · FX rates cached: <span className="font-mono">{fxProgress.cached.toLocaleString()}</span>
          {fxPending > 0 && (
            <> · fetching <span className="font-mono">{fxDone.toLocaleString()}</span>/<span className="font-mono">{fxPending.toLocaleString()}</span>…</>
          )}
        </span>
        {fxFallbackKeys.size > 0 && (
          <span className="text-orange-600 font-medium">
            ⚠ {fxFallbackKeys.size.toLocaleString()} moneda/fecha sin tasa SAP (usando 1:1)
          </span>
        )}
        <button
          onClick={handleRefetchRates}
          disabled={isRefetching || !totalRows}
          title="Re-query SAP for the exchange rates of all currency/date combinations in this report, bypassing the local cache."
          className="flex items-center gap-1 px-2 py-0.5 text-[11px] font-semibold rounded border border-blue-200 bg-blue-50 text-blue-700 hover:bg-blue-100 disabled:opacity-50 disabled:cursor-not-allowed"
        >
          ⟳ {isRefetching ? 'Consulting…' : 'Re-query exchange rates'}
        </button>
        <button
          onClick={handleRefetchFallbackRates}
          disabled={isRefetching || fxFallbackKeys.size === 0}
          title="Re-query SAP only for the currency/date combinations that currently returned a 1:1 rate (no exchange rate found)."
          className="flex items-center gap-1 px-2 py-0.5 text-[11px] font-semibold rounded border border-orange-200 bg-orange-50 text-orange-700 hover:bg-orange-100 disabled:opacity-50 disabled:cursor-not-allowed"
        >
          ⟳ {isRefetching ? 'Consulting…' : `Re-query 1:1 (${fxFallbackKeys.size})`}
        </button>
      </div>

      {/* DataGrid — receives every row, so filters/search/sort/pagination act on the full dataset */}
      <div className="flex-1 min-h-0 overflow-auto">
        <DataGrid
          rows={displayRows}
          columns={cols}
          rowKey={(_r, i) => i}
          pageSize={50}
          exportFileName={`fullquote_${new Date().toISOString().slice(0, 10)}`}
          exportSheetName="FullQuote"
          defaultShowFilters={true}
          freezeFirstColumn={true}
        />
      </div>
    </div>
  )
}
