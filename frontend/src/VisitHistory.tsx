import { ArrowLeft, ChevronRight } from 'lucide-react'
import type { JobStatus } from './types'

export interface VisitSummary {
  id: string
  job_number: number
  created_at: string
  status: JobStatus
  currency_code: string
  quoted_total_minor: number
  final_billed_total_minor: number | null
  staff_note?: string
  job_line_items: { label_snapshot: string }[]
}

export interface VisitDetail extends VisitSummary {
  job_line_items: { id: string; label_snapshot: string; sku_snapshot?: string; quantity: number; unit_price_minor: number }[]
  job_charge_items: { id: string; name_snapshot: string; quantity: number; unit_amount_minor: number }[]
}

export interface CustomerLookup {
  customer: { id: string; display_name: string | null } | null
  visits: VisitSummary[]
  active_job: VisitSummary | null
  next_offset: number | null
  history_available?: boolean
}

const visitStatus: Record<JobStatus, string> = {
  draft: 'Draft', ready: 'Ready for checkout', checkout: 'At checkout',
  returned: 'Needs correction', completed: 'Completed', cancelled: 'Cancelled',
}

function money(minor: number, currency: string) {
  return new Intl.NumberFormat('en-IN', { style: 'currency', currency, maximumFractionDigits: 2 }).format(minor / 100)
}

function amount(visit: VisitSummary) {
  const billed = visit.final_billed_total_minor != null
  return `${billed ? 'Billed' : 'Quoted'} ${money(visit.final_billed_total_minor ?? visit.quoted_total_minor, visit.currency_code)}`
}

function visitDate(visit: VisitSummary, timeZone?: string) {
  return new Intl.DateTimeFormat('en-IN', { day: 'numeric', month: 'short', year: 'numeric', timeZone }).format(new Date(visit.created_at))
}

function visitTitle(visit: VisitSummary) {
  return visit.job_line_items[0]?.label_snapshot || `Job #${visit.job_number}`
}

function VisitCard({ visit, timeZone, open }: {
  visit: VisitSummary; timeZone?: string; open: (visit: VisitSummary, button: HTMLButtonElement, pointer: boolean) => void
}) {
  return <button type="button" className="visit-card" onClick={(event) => open(visit, event.currentTarget, event.detail > 0)}>
    <span className="visit-card-meta"><time dateTime={visit.created_at}>{visitDate(visit, timeZone)}</time><span className={`status-pill ${visit.status}`}>{visitStatus[visit.status]}</span></span>
    <strong>{visitTitle(visit)}</strong>
    {visit.staff_note && <span className="visit-cue">{visit.staff_note}</span>}
    <span className="visit-card-bottom"><span>{amount(visit)}</span><span>#{visit.job_number} <ChevronRight size={14} /></span></span>
  </button>
}

export function VisitHistory({ lookup, open, loadMore, busy, timeZone }: {
  lookup: CustomerLookup; open: (visit: VisitSummary, button: HTMLButtonElement, pointer: boolean) => void
  loadMore: () => void; busy: boolean; timeZone?: string
}) {
  return <div className="visit-history">
    {lookup.active_job && <section aria-label="In-progress job">
      <h3>In-progress job</h3>
      <VisitCard visit={lookup.active_job} open={open} timeZone={timeZone} />
    </section>}
    <section aria-label="Past visits">
      <h3>Past visits</h3>
      {lookup.visits.length ? <div className="visit-grid">
        {lookup.visits.map((visit) => <VisitCard key={visit.id} visit={visit} open={open} timeZone={timeZone} />)}
      </div> : <p className="visit-empty">No completed visits yet.</p>}
      {lookup.next_offset !== null && <button type="button" className="button button-outline" disabled={busy} onClick={loadMore}>{busy ? 'Loading…' : 'Show older visits'}</button>}
    </section>
  </div>
}

export function ReadOnlyVisit({ summary, detail, error, back, retry, timeZone, pointer }: {
  summary: VisitSummary; detail: VisitDetail | null; error: string; back: () => void; retry: () => void; timeZone?: string; pointer: boolean
}) {
  return <div className="visit-preview" data-pointer-motion={pointer || undefined}>
    <button type="button" className="button button-outline" onClick={back}><ArrowLeft size={16} /> Back to past visits</button>
    <div className="visit-preview-summary">
      <div className="visit-card-meta"><span>Job #{summary.job_number} · {visitDate(summary, timeZone)}</span><span className={`status-pill ${summary.status}`}>{visitStatus[summary.status]}</span></div>
      <h3>{visitTitle(summary)}</h3>
      <strong>{amount(detail || summary)}</strong>
    </div>
    {error ? <div className="visit-preview-error"><p role="alert">{error}</p><button className="button button-outline" type="button" onClick={retry}>Retry</button></div>
      : !detail ? <p role="status">Loading visit…</p>
        : <>
          <section><h3>Items</h3><ul className="review-lines">
            {detail.job_line_items.map((item) => <li key={item.id}><span><strong>{item.label_snapshot}</strong><small>{item.quantity} × {money(item.unit_price_minor, detail.currency_code)}{item.sku_snapshot && ` · ${item.sku_snapshot}`}</small></span><strong>{money(item.quantity * item.unit_price_minor, detail.currency_code)}</strong></li>)}
          </ul></section>
          {detail.job_charge_items.length > 0 && <section><h3>Charges</h3><ul className="review-lines">
            {detail.job_charge_items.map((item) => <li key={item.id}><span>{item.name_snapshot} × {item.quantity}</span><strong>{money(item.quantity * item.unit_amount_minor, detail.currency_code)}</strong></li>)}
          </ul></section>}
          {detail.staff_note && <section><h3>Sales note</h3><p className="visit-note">{detail.staff_note}</p></section>}
        </>}
  </div>
}
