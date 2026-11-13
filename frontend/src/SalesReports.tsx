import { useEffect, useState } from 'react'
import { ChevronLeft, ChevronRight } from 'lucide-react'
import { apiRequest, publicError } from './lib/api'
import type { Job } from './types'
import './SalesReports.css'

const periods = { day: 'Daily', week: 'Weekly', month: 'Monthly', year: 'Yearly' } as const
type Period = keyof typeof periods
type DateRange = { start: string; end: string }
type Breakdown = 'day' | 'month' | null
type Totals = { invoice_count: number; total_minor: number }
type Bucket = Totals & { date: string }
type Invoice = { job_number: number; invoice_reference: string; total_minor: number }
type SalesReport = Totals & { currency_code: string; buckets: Bucket[]; invoices: Invoice[] }
type ReportResult = { key: string; report: SalesReport } | { key: string; error: string }

const dayFormat = new Intl.DateTimeFormat('en-IN', { dateStyle: 'medium', timeZone: 'UTC' })
const monthFormat = new Intl.DateTimeFormat('en-IN', { month: 'long', year: 'numeric', timeZone: 'UTC' })
const earliestDate = '0001-01-01'

function storeDate(now: Date, timeZone: string) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone, year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(now)
  return ['year', 'month', 'day'].map((part) => parts.find(({ type }) => type === part)?.value).join('-')
}

// Date-only calculations use UTC so navigation never shifts at a daylight saving boundary.
function calendarDate(date: string) {
  return new Date(`${date}T00:00:00Z`)
}

function dateKey(date: Date) {
  return date.toISOString().slice(0, 10)
}

function startOfPeriod(date: string, period: Period) {
  const start = calendarDate(date)
  if (period === 'week') start.setUTCDate(start.getUTCDate() - (start.getUTCDay() + 6) % 7)
  if (period === 'month') start.setUTCDate(1)
  if (period === 'year') start.setUTCMonth(0, 1)
  return dateKey(start)
}

function movePeriod(start: string, period: Period, direction: number) {
  const next = calendarDate(start)
  if (period === 'year') next.setUTCFullYear(next.getUTCFullYear() + direction)
  else if (period === 'month') next.setUTCMonth(next.getUTCMonth() + direction)
  else next.setUTCDate(next.getUTCDate() + direction * (period === 'week' ? 7 : 1))
  return dateKey(next)
}

function demoReport(jobs: Job[], start: string, end: string, breakdown: Breakdown, timeZone: string): SalesReport {
  const buckets = new Map<string, Bucket>()
  const invoices: Invoice[] = []
  if (breakdown) {
    for (let date = startOfPeriod(start, breakdown); date <= end; date = movePeriod(date, breakdown, 1)) {
      buckets.set(date, { date, invoice_count: 0, total_minor: 0 })
    }
  }
  const report = { currency_code: 'INR', invoice_count: 0, total_minor: 0, buckets: [...buckets.values()], invoices }
  const billedJobs = jobs
    .filter((job) => job.status !== 'cancelled' && job.invoiceReference && job.finalBilledTotalMinor != null)
    .map((job) => ({ job, recordedAt: job.invoiceFirstRecordedAt ?? job.invoiceRecordedAt ?? job.createdAt }))
    .sort((a, b) => b.recordedAt.localeCompare(a.recordedAt) || b.job.jobNumber - a.job.jobNumber)
  for (const { job, recordedAt } of billedJobs) {
    const date = storeDate(new Date(recordedAt), timeZone)
    if (date < start || date > end || !job.invoiceReference || job.finalBilledTotalMinor == null) continue
    report.invoice_count++
    report.total_minor += job.finalBilledTotalMinor
    if (!breakdown) invoices.push({
      job_number: job.jobNumber, invoice_reference: job.invoiceReference, total_minor: job.finalBilledTotalMinor,
    })
    const bucket = buckets.get(breakdown === 'month' ? `${date.slice(0, 7)}-01` : date)
    if (bucket) {
      bucket.invoice_count++
      bucket.total_minor += job.finalBilledTotalMinor
    }
  }
  return report
}

export function SalesReports({ storeId, accessToken, timeZone, now, demoJobs }: {
  storeId: string
  accessToken: string
  timeZone: string
  now: Date
  demoJobs?: Job[]
}) {
  const today = storeDate(now, timeZone)
  const [selectedDate, setSelectedDate] = useState<string | null>(null)
  const [period, setPeriod] = useState<Period>('day')
  const [customRange, setCustomRange] = useState<DateRange | null>(null)
  const [draftRange, setDraftRange] = useState<DateRange | null>(null)
  const [result, setResult] = useState<ReportResult | null>(null)
  const [retry, setRetry] = useState(0)
  const anchor = selectedDate ?? today
  const start = customRange?.start ?? startOfPeriod(anchor, period)
  const through = customRange?.end
  const end = through ?? movePeriod(movePeriod(start, period, 1), 'day', -1)
  const currentStart = startOfPeriod(today, period)
  const reportPeriod = customRange ? 'custom' : period
  const requestKey = `${storeId}/${reportPeriod}/${start}/${end}/${retry}`
  const isDemo = demoJobs !== undefined
  const breakdown: Breakdown = start === end ? null
    : reportPeriod === 'year' || (customRange && calendarDate(end).getTime() - calendarDate(start).getTime() >= 31 * 86_400_000)
      ? 'month' : 'day'

  useEffect(() => {
    if (isDemo) return
    const controller = new AbortController()
    const params = new URLSearchParams({ store_id: storeId, period: reportPeriod, on: start })
    if (through) params.set('through', through)
    void apiRequest<SalesReport>(`/api/reports/sales?${params}`, accessToken, { signal: controller.signal })
      .then((report) => {
        if (!controller.signal.aborted) setResult({ key: requestKey, report })
      })
      .catch((error) => {
        if (!controller.signal.aborted) setResult({ key: requestKey, error: publicError(error, 'Couldn’t load sales for this period.') })
      })
    return () => controller.abort()
  }, [accessToken, isDemo, reportPeriod, requestKey, start, storeId, through])

  const currentResult = result?.key === requestKey ? result : null
  const report = demoJobs ? demoReport(demoJobs, start, end, breakdown, timeZone)
    : currentResult && 'report' in currentResult ? currentResult.report : null
  const error = currentResult && 'error' in currentResult ? currentResult.error : null
  const money = report && new Intl.NumberFormat('en-IN', { style: 'currency', currency: report.currency_code })
  const formatMoney = (amount: number) => money?.format(amount / 100)
  const range = reportPeriod === 'year' ? start.slice(0, 4)
    : reportPeriod === 'month' ? monthFormat.format(calendarDate(start))
      : dayFormat.formatRange(calendarDate(start), calendarDate(end))

  function selectPeriod(nextPeriod: Period, date: string | null = null) {
    setPeriod(nextPeriod)
    setSelectedDate(date)
    setCustomRange(null)
    setDraftRange(null)
  }

  function navigatePeriod(direction: number) {
    const date = movePeriod(start, period, direction)
    setSelectedDate(date >= currentStart ? null : date)
  }

  return <main className="secondary-page sales-reports">
    <div className="page-heading"><h1>Sales reports</h1></div>

    <div className="sales-controls">
      <div className="sales-periods" role="group" aria-label="Report period">
        {(Object.keys(periods) as Period[]).map((option) => <button key={option} id={`sales-period-${option}`}
          type="button" className="button button-outline" aria-pressed={reportPeriod === option}
          onClick={() => selectPeriod(option)}>{periods[option]}</button>)}
        <button type="button" className="button button-outline" aria-expanded={draftRange !== null}
          data-active={reportPeriod === 'custom'}
          aria-controls="sales-custom-range" onClick={() => setDraftRange(draftRange ? null : {
            start, end: end > today ? today : end,
          })}>Custom range</button>
      </div>
      {!draftRange && !customRange && <div className="sales-date-actions">
        <label htmlFor="sales-date">Jump to date</label>
        <input id="sales-date" type="date" min={earliestDate} max={today} value={anchor} onChange={(event) => {
          if (event.target.value && event.target.validity.valid) setSelectedDate(event.target.value)
        }} />
      </div>}
      <form id="sales-custom-range" className="sales-date-actions sales-custom-range" hidden={!draftRange}
        onSubmit={(event) => {
          event.preventDefault()
          if (draftRange) setCustomRange(draftRange)
        }}>
        {draftRange && <>
          <label>From<input type="date" required min={earliestDate} max={today} value={draftRange.start}
            onChange={(event) => setDraftRange({ ...draftRange, start: event.target.value })} /></label>
          <label>To<input type="date" required min={draftRange.start || earliestDate} max={today} value={draftRange.end}
            onChange={(event) => setDraftRange({ ...draftRange, end: event.target.value })} /></label>
          <button type="submit" className="button button-outline">Apply range</button>
        </>}
      </form>
    </div>

    <div className={`sales-range${customRange ? ' sales-range-custom' : ''}`}>
      {!customRange && <button type="button" className="icon-button" aria-label={`Previous ${period}`}
        disabled={start === earliestDate} onClick={() => navigatePeriod(-1)}><ChevronLeft size={20} aria-hidden="true" /></button>}
      <h2 aria-live="polite">{range}</h2>
      {!customRange && <button type="button" className="icon-button" aria-label={`Next ${period}`}
        aria-disabled={start >= currentStart} onClick={() => { if (start < currentStart) navigatePeriod(1) }}><ChevronRight size={20} aria-hidden="true" /></button>}
    </div>

    <dl className="sales-totals" aria-busy={!report && !error}>
      <div><dt>Total billed</dt><dd>{report ? formatMoney(report.total_minor) : '—'}</dd></div>
      <div><dt>Invoice count</dt><dd>{report ? report.invoice_count.toLocaleString('en-IN') : '—'}</dd></div>
      <div><dt>Average invoice</dt><dd>{report?.invoice_count ? formatMoney(report.total_minor / report.invoice_count) : '—'}</dd></div>
    </dl>

    <p className="sales-basis">Sales are grouped by the date the invoice was first recorded in Counterline ({timeZone}).</p>

    <div className="sales-breakdown" aria-busy={!report && !error}>
      {error ? <div className="sales-status">
        <p role="alert">{error}</p>
        <button type="button" className="button button-outline" onClick={() => setRetry((value) => value + 1)}>Retry</button>
      </div> : !report ? <p className="sales-status" role="status">Loading sales…</p>
        : report.invoice_count === 0 ? <p className="sales-status" role="status">No invoices recorded for this period.</p>
          : !breakdown ? <table className="sales-table">
            <caption>Invoices</caption>
            <thead><tr><th scope="col">Invoice</th><th scope="col">Job</th><th scope="col">Total billed</th></tr></thead>
            <tbody>{report.invoices.map((invoice) => <tr key={invoice.job_number}>
              <th scope="row">{invoice.invoice_reference}</th>
              <td>#{invoice.job_number}</td>
              <td>{formatMoney(invoice.total_minor)}</td>
            </tr>)}</tbody>
          </table> : <table className="sales-table">
            <caption>{breakdown === 'day' ? 'Daily breakdown' : 'Monthly breakdown'}</caption>
            <thead><tr><th scope="col">{breakdown === 'day' ? 'Date' : 'Month'}</th><th scope="col">Invoices</th><th scope="col">Total billed</th></tr></thead>
            <tbody>{report.buckets.map((bucket) => <tr key={bucket.date}>
              <th scope="row">{breakdown === 'day' ? <button type="button" className="sales-day-link"
                disabled={bucket.date > today} onClick={() => {
                  selectPeriod('day', bucket.date)
                  document.getElementById('sales-period-day')?.focus()
                }}>{dayFormat.format(calendarDate(bucket.date))}</button> : monthFormat.format(calendarDate(bucket.date))}</th>
              <td>{bucket.invoice_count.toLocaleString('en-IN')}</td>
              <td>{formatMoney(bucket.total_minor)}</td>
            </tr>)}</tbody>
          </table>}
    </div>
  </main>
}
