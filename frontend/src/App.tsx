import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type FormEvent, type ReactNode } from 'react'
import type { Session } from '@supabase/supabase-js'
import {
  Activity, ArrowDownLeft, ArrowRight, Bell, Check, CheckCircle2, ChevronDown,
  ChevronRight, CircleAlert, ClipboardList, Clock3, Copy, Filter,
  Home, Menu, MoreHorizontal, Package, Plus, Search, Settings2, ShieldCheck,
  ShoppingBag, Smartphone, Users, Wallet, Wifi, X, Zap,
} from 'lucide-react'
import { charges as demoCharges, formatMoney, jobQuote, products as demoProducts, seedJobs, totalConfirmed } from './demoData'
import type { CatalogCharge, CatalogProduct, Job, JobCharge, JobLine, JobStatus, Payment, StaffRole } from './types'
import { apiRequest } from './lib/api'
import { hasSupabaseConfig, supabase } from './lib/supabase'
import './App.css'

const demoMode = import.meta.env.DEV && (!hasSupabaseConfig || import.meta.env.VITE_DEMO_MODE === 'true')
const demoJobsKey = 'job-card-demo-jobs-v1'
const rolePermissions: Record<StaffRole, string[]> = {
  salesperson: ['jobs.create', 'jobs.read_own', 'jobs.submit', 'payments.record_cash', 'payments.record_upi', 'catalog.read'],
  cashier: ['jobs.read_store', 'jobs.checkout', 'jobs.return', 'jobs.complete', 'payments.record_cash', 'payments.record_upi', 'payments.confirm_upi', 'billing.record', 'catalog.read'],
  manager: ['*'],
}

type NavKey = 'overview' | 'checkout' | 'customers' | 'catalog' | 'team'
type QueueFilter = 'all' | 'ready' | 'checkout' | 'returned' | 'completed'
type StoreMembership = {
  store_id: string
  role: string
  permissions: string[]
  display_name?: string | null
  store?: { id: string; name: string; currency_code: string; timezone: string }
}
type SessionResponse = { user: { id: string; email?: string }; stores: StoreMembership[] }
type ApiJob = Record<string, any>

const roleLabel: Record<StaffRole, string> = { salesperson: 'Salesperson', cashier: 'Cashier', manager: 'Manager' }
const statusText: Record<JobStatus, string> = {
  draft: 'Draft', ready: 'Ready for checkout', returned: 'Needs correction',
  checkout: 'At checkout', completed: 'Completed', cancelled: 'Cancelled',
}

function mapApiJob(source: ApiJob): Job {
  return {
    id: source.id,
    version: Number(source.version),
    jobNumber: Number(source.job_number),
    customerName: source.customer_name_snapshot || 'Customer',
    customerPhone: source.customer_phone_snapshot,
    createdAt: source.created_at,
    timeLabel: new Date(source.created_at).toLocaleTimeString('en-IN', { hour: 'numeric', minute: '2-digit' }),
    status: source.status,
    owner: 'Sales team',
    contributors: (source.job_contributors || []).map((item: any) => item.display_name_snapshot || 'Team member'),
    lines: (source.job_line_items || []).map((item: any) => ({
      id: item.product_id || `custom-${item.id}`, label: item.label_snapshot, sku: item.sku_snapshot,
      quantity: item.quantity, unitPriceMinor: Number(item.unit_price_minor), contributor: 'Sales team',
    })),
    charges: (source.job_charge_items || []).map((item: any) => ({
      id: item.charge_id || `custom-${item.id}`, name: item.name_snapshot, quantity: item.quantity,
      unitAmountMinor: Number(item.unit_amount_minor),
    })),
    note: source.staff_note || undefined,
    correctionReason: source.correction_reason || undefined,
    invoiceReference: source.invoice_reference || undefined,
    finalBilledTotalMinor: source.final_billed_total_minor == null ? undefined : Number(source.final_billed_total_minor),
    discrepancyReason: source.invoice_discrepancy_reason || undefined,
    payments: (source.payments || []).map((payment: any): Payment => ({
      id: payment.id, method: payment.method, amountMinor: Number(payment.amount_minor),
      status: payment.status, reference: payment.reference || undefined,
      time: new Date(payment.created_at).toLocaleTimeString('en-IN', { hour: 'numeric', minute: '2-digit' }),
    })),
  }
}

function loadDemoJobs(): Job[] {
  try {
    const stored = localStorage.getItem(demoJobsKey)
    return stored ? JSON.parse(stored) as Job[] : seedJobs
  } catch {
    return seedJobs
  }
}

export default function App() {
  const [session, setSession] = useState<Session | null>(null)
  const [authReady, setAuthReady] = useState(demoMode || !supabase)
  const [authError, setAuthError] = useState('')

  useEffect(() => {
    if (demoMode || !supabase) return
    let live = true
    supabase.auth.getSession().then(({ data }) => {
      if (live) { setSession(data.session); setAuthReady(true) }
    }).catch(() => { if (live) setAuthReady(true) })
    const { data: listener } = supabase.auth.onAuthStateChange((_event, nextSession) => setSession(nextSession))
    return () => { live = false; listener.subscription.unsubscribe() }
  }, [])

  if (demoMode) return <Workspace demo />
  if (!hasSupabaseConfig) return <SetupScreen />
  if (!authReady) return <div className="auth-loading"><span className="loading-orb" />Checking your session…</div>
  if (!session) return <SignInScreen error={authError} onSignIn={async (email, password) => {
    if (!supabase) return
    setAuthError('')
    const { error } = await supabase.auth.signInWithPassword({ email, password })
    if (error) setAuthError(error.message)
  }} />
  return <Workspace accessToken={session.access_token} onSignOut={async () => { await supabase?.auth.signOut(); setSession(null) }} />
}

function SetupScreen() {
  return <main className="setup-screen">
    <div className="setup-card">
      <BrandMark />
      <span className="eyebrow">One last setup step</span>
      <h1>Connect your store workspace</h1>
      <p>Add the Supabase project URL and publishable key to <code>frontend/.env.local</code>, and set the API URL. The server-only Supabase secret belongs in <code>backend/.env</code>, never in the browser.</p>
      <div className="setup-code">VITE_SUPABASE_URL=…<br />VITE_SUPABASE_PUBLISHABLE_KEY=…<br />VITE_API_URL=http://localhost:8000</div>
      <div className="setup-note"><ShieldCheck size={17} /> The browser only receives the publishable key. Privileged data access stays in FastAPI.</div>
    </div>
  </main>
}

function SignInScreen({ onSignIn, error }: { onSignIn: (email: string, password: string) => Promise<void>; error: string }) {
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [busy, setBusy] = useState(false)
  const submit = async (event: FormEvent) => {
    event.preventDefault(); setBusy(true)
    try { await onSignIn(email.trim(), password) } finally { setBusy(false) }
  }
  return <main className="signin-screen">
    <section className="signin-story">
      <div className="story-orbit orbit-a" /><div className="story-orbit orbit-b" />
      <BrandMark light />
      <div className="story-copy">
        <span className="eyebrow eyebrow-light">A calmer counter starts here</span>
        <h1>Every detail<br />arrives with the sale.</h1>
        <p>One clear handoff from the shop floor to checkout. No second telling, no lost details.</p>
      </div>
      <div className="story-footer"><span><span className="status-dot" /> Your store workspace</span><span>Job Card · Staff access</span></div>
    </section>
    <section className="signin-panel">
      <div className="signin-form-wrap">
        <span className="eyebrow">Staff sign-in</span>
        <h2>Welcome back</h2>
        <p className="muted">Use the account invited by your store manager.</p>
        <form onSubmit={submit} className="signin-form">
          <label>Email address<input type="email" autoComplete="username" autoCapitalize="none" required value={email} onChange={(e) => setEmail(e.target.value)} placeholder="you@yourshop.in" /></label>
          <label>Password<input type="password" autoComplete="current-password" required value={password} onChange={(e) => setPassword(e.target.value)} placeholder="Enter your password" /></label>
          {error && <div className="form-error" role="alert"><CircleAlert size={16} />{error}</div>}
          <button className="button button-dark button-wide" disabled={busy}>{busy ? 'Signing in…' : 'Sign in'}<ArrowRight size={17} /></button>
        </form>
        <div className="signin-foot"><ShieldCheck size={16} /> Access is limited to your assigned store role.</div>
      </div>
    </section>
  </main>
}

function Workspace({ demo = false, accessToken, onSignOut }: { demo?: boolean; accessToken?: string; onSignOut?: () => void }) {
  const [jobs, setJobs] = useState<Job[]>(demo ? loadDemoJobs() : [])
  const [products, setProducts] = useState<CatalogProduct[]>(demo ? demoProducts : [])
  const [charges, setCharges] = useState<CatalogCharge[]>(demo ? demoCharges : [])
  const [store, setStore] = useState<StoreMembership | null>(null)
  const [setupNeeded, setSetupNeeded] = useState(false)
  const [loading, setLoading] = useState(!demo)
  const [loadError, setLoadError] = useState('')
  const [activeNav, setActiveNav] = useState<NavKey>('overview')
  const [queueFilter, setQueueFilter] = useState<QueueFilter>('all')
  const [selectedId, setSelectedId] = useState<string | null>(demo ? loadDemoJobs()[0]?.id || null : null)
  const [search, setSearch] = useState('')
  const [role, setRole] = useState<StaffRole>('manager')
  const [permissions, setPermissions] = useState<string[]>(demo ? rolePermissions.manager : [])
  const [members, setMembers] = useState<Array<{ id: string; name: string; role: string }>>(
    demo ? [{ id: 'demo-rohan', name: 'Rohan K.', role: 'salesperson' }, { id: 'demo-dev', name: 'Dev · JBL', role: 'promoter' }, { id: 'demo-sara', name: 'Sara M.', role: 'cashier' }] : [],
  )
  const [newJobOpen, setNewJobOpen] = useState(false)
  const [editingJob, setEditingJob] = useState<Job | null>(null)
  const [mobileDetailOpen, setMobileDetailOpen] = useState(false)
  const [toast, setToast] = useState('')
  const [updateReady, setUpdateReady] = useState(false)
  const [todayLabel] = useState(() => new Intl.DateTimeFormat('en-IN', { weekday: 'short', day: 'numeric', month: 'short' }).format(new Date()))
  const [weekdayLabel] = useState(() => new Intl.DateTimeFormat('en-IN', { weekday: 'long' }).format(new Date()).toUpperCase())

  useEffect(() => {
    const announce = () => setUpdateReady(true)
    window.addEventListener('counterline:update-available', announce)
    return () => window.removeEventListener('counterline:update-available', announce)
  }, [])

  useEffect(() => {
    if (!demo) return
    localStorage.setItem(demoJobsKey, JSON.stringify(jobs))
  }, [demo, jobs])

  const reload = useCallback(async (storeId?: string) => {
    if (!accessToken) return
    try {
      const sessionInfo = await apiRequest<SessionResponse>('/api/session', accessToken)
      setLoadError('')
      if (sessionInfo.stores.length === 0) { setSetupNeeded(true); setLoading(false); return }
      const selectedStore = sessionInfo.stores.find((item) => item.store_id === storeId) || sessionInfo.stores[0]
      setStore(selectedStore)
      setRole((selectedStore.role in roleLabel ? selectedStore.role : 'salesperson') as StaffRole)
      setPermissions(selectedStore.permissions)
      const [jobRows, catalog, staffRows] = await Promise.all([
        apiRequest<ApiJob[]>(`/api/jobs?store_id=${selectedStore.store_id}`, accessToken),
        apiRequest<{ products: any[]; charges: any[] }>(`/api/catalog?store_id=${selectedStore.store_id}`, accessToken),
        (async () => {
          try { return await apiRequest<any[]>(`/api/staff?store_id=${selectedStore.store_id}`, accessToken) }
          catch { return [] }
        })(),
      ])
      const mapped = jobRows.map(mapApiJob)
      setJobs(mapped)
      setSelectedId((current) => mapped.some((job) => job.id === current) ? current : mapped[0]?.id || null)
      setProducts(catalog.products.map((item) => ({ id: item.id, name: item.name, brand: item.brand || '', sku: item.sku || '', unitPriceMinor: Number(item.default_unit_price_minor) })))
      setCharges(catalog.charges.map((item) => ({ id: item.id, name: item.name, amountMinor: Number(item.default_amount_minor) })))
      setMembers(staffRows.map((item) => ({ id: item.user_id, name: item.display_name || item.role, role: item.role })))
      setSetupNeeded(false)
    } catch (error) {
      setLoadError(error instanceof Error ? error.message : 'Unable to load your store data.')
    } finally { setLoading(false) }
  }, [accessToken])

  useEffect(() => {
    if (demo) return
    let active = true
    queueMicrotask(() => { if (active) void reload() })
    return () => { active = false }
  }, [demo, reload])

  useEffect(() => {
    if (demo || !accessToken) return
    const refreshWhenVisible = () => {
      if (document.visibilityState === 'visible') void reload(store?.store_id)
    }
    const interval = window.setInterval(refreshWhenVisible, 15_000)
    document.addEventListener('visibilitychange', refreshWhenVisible)
    return () => {
      window.clearInterval(interval)
      document.removeEventListener('visibilitychange', refreshWhenVisible)
    }
  }, [demo, reload, accessToken, store?.store_id])

  const can = (permission: string) => demo
    ? permissions.includes('*') || permissions.includes(permission)
    : permissions.includes('*') || permissions.includes(permission)
  const selected = jobs.find((job) => job.id === selectedId) || null
  const visibleJobs = useMemo(() => {
    let result = [...jobs]
    if (activeNav === 'checkout') result = result.filter((job) => ['ready', 'checkout', 'returned'].includes(job.status))
    else if (queueFilter !== 'all') result = result.filter((job) => job.status === queueFilter)
    if (search.trim()) {
      const query = search.toLowerCase()
      result = result.filter((job) => job.customerName.toLowerCase().includes(query) || job.customerPhone.includes(query) || String(job.jobNumber).includes(query))
    }
    return result.sort((a, b) => b.createdAt.localeCompare(a.createdAt))
  }, [jobs, activeNav, queueFilter, search])

  const showToast = (message: string) => {
    setToast(message)
    window.setTimeout(() => setToast(''), 2600)
  }

  const updateDemoJob = (id: string, updater: (job: Job) => Job) => setJobs((current) => current.map((job) => job.id === id ? { ...updater(job), version: (job.version || 1) + 1 } : job))

  const createJob = async (input: { phone: string; name: string; lines: JobLine[]; charges: JobCharge[]; contributors: Array<{ user_id: string; contribution: 'sales' | 'promoter' | 'assisted' }>; note: string; jobId?: string; version?: number }) => {
    if (input.jobId && (demo || input.version)) {
      if (demo) {
        updateDemoJob(input.jobId, (current) => ({ ...current, customerName: input.name || current.customerName, customerPhone: input.phone, lines: input.lines, charges: input.charges, contributors: input.contributors.map((member) => members.find((candidate) => candidate.id === member.user_id)?.name || 'Team member'), note: input.note || undefined, correctionReason: undefined, status: 'ready', createdAt: new Date().toISOString(), timeLabel: 'Just now' }))
      } else {
        if (!accessToken || !store) return
        const updated = await apiRequest<ApiJob>(`/api/jobs/${input.jobId}`, accessToken, {
          method: 'PATCH', body: JSON.stringify({
            store_id: store.store_id, expected_version: input.version,
            lines: input.lines.map((line, index) => ({ product_id: line.id.startsWith('custom-') ? null : line.id, label: line.label, sku: line.sku || null, quantity: line.quantity, unit_price_minor: line.unitPriceMinor, sort_order: index })),
            charges: input.charges.map((charge, index) => ({ charge_id: charge.id.startsWith('custom-') ? null : charge.id, name: charge.name, quantity: charge.quantity, unit_amount_minor: charge.unitAmountMinor, sort_order: index })),
            contributors: input.contributors, staff_note: input.note || null,
          }),
        })
        await apiRequest(`/api/jobs/${input.jobId}/transition`, accessToken, { method: 'POST', body: JSON.stringify({ store_id: store.store_id, to_status: 'ready', expected_version: updated.version, reason: null }) })
        await reload(store.store_id)
      }
      setSelectedId(input.jobId); setEditingJob(null); setNewJobOpen(false); showToast('Correction saved and returned to checkout'); return
    }
    if (demo) {
      const nextNumber = Math.max(1048, ...jobs.map((job) => job.jobNumber)) + 1
      const newJob: Job = {
        id: `demo-${nextNumber}`, jobNumber: nextNumber, customerName: input.name || 'Customer',
        customerPhone: input.phone, createdAt: new Date().toISOString(), timeLabel: 'Just now',
        status: 'ready', owner: 'Anika S.', contributors: input.contributors.map((member) => members.find((candidate) => candidate.id === member.user_id)?.name || 'Team member'), lines: input.lines,
        charges: input.charges, note: input.note || undefined, payments: [],
      }
      setJobs((current) => [newJob, ...current]); setSelectedId(newJob.id); setQueueFilter('all'); setActiveNav('overview')
      setEditingJob(null); setNewJobOpen(false); showToast(`Job #${nextNumber} sent to checkout`); return
    }
    if (!accessToken || !store) return
    const created = await apiRequest<ApiJob>('/api/jobs', accessToken, {
      method: 'POST', body: JSON.stringify({
        store_id: store.store_id, customer_phone: input.phone, customer_name: input.name || null,
        lines: input.lines.map((line, index) => ({
          product_id: line.id.startsWith('custom-') ? null : line.id,
          label: line.label, sku: line.sku || null, quantity: line.quantity,
          unit_price_minor: line.unitPriceMinor, sort_order: index,
        })),
        charges: input.charges.map((charge, index) => ({
          charge_id: charge.id.startsWith('custom-') ? null : charge.id,
          name: charge.name, quantity: charge.quantity, unit_amount_minor: charge.unitAmountMinor, sort_order: index,
        })),
        contributors: input.contributors,
        staff_note: input.note || null,
      }),
    })
    await reload(store.store_id)
    setSelectedId(created.id); setEditingJob(null); setNewJobOpen(false); showToast(`Job #${created.job_number} sent to checkout`)
  }

  const transition = async (job: Job, toStatus: JobStatus, reason?: string) => {
    if (demo) {
      updateDemoJob(job.id, (current) => ({ ...current, status: toStatus, correctionReason: toStatus === 'returned' ? reason : undefined, timeLabel: 'Just now', createdAt: new Date().toISOString() }))
      showToast(toStatus === 'checkout' ? 'Checkout started' : toStatus === 'returned' ? 'Sent back for correction' : toStatus === 'completed' ? 'Job completed' : 'Job updated')
      return
    }
    if (!accessToken || !store) return
    await apiRequest(`/api/jobs/${job.id}/transition`, accessToken, {
      method: 'POST', body: JSON.stringify({ store_id: store.store_id, to_status: toStatus, expected_version: job.version || 1, reason: reason || null }),
    })
    await reload(store.store_id)
    showToast(toStatus === 'completed' ? 'Job completed' : 'Job updated')
  }

  const addPayment = async (job: Job, method: 'cash' | 'upi', amountMinor: number, reference?: string) => {
    if (demo) {
      const payment: Payment = { id: crypto.randomUUID(), method, amountMinor, status: method === 'cash' ? 'confirmed' : 'pending', reference: reference || undefined, time: 'Just now' }
      updateDemoJob(job.id, (current) => ({ ...current, payments: [...current.payments, payment] }))
      showToast(method === 'cash' ? 'Cash recorded' : 'UPI recorded · confirm receipt when received')
      return
    }
    if (!accessToken || !store) return
    await apiRequest(`/api/jobs/${job.id}/payments`, accessToken, {
      method: 'POST', body: JSON.stringify({ store_id: store.store_id, method, amount_minor: amountMinor, reference: reference || null, idempotency_key: crypto.randomUUID() }),
    })
    await reload(store.store_id)
    showToast(method === 'cash' ? 'Cash recorded' : 'UPI recorded as pending confirmation')
  }

  const confirmUpi = async (job: Job, paymentId: string, reference: string) => {
    if (demo) {
      updateDemoJob(job.id, (current) => ({ ...current, payments: current.payments.map((payment) => payment.id === paymentId ? { ...payment, status: 'confirmed', reference: reference || payment.reference, time: 'Just now' } : payment) }))
      showToast('UPI receipt confirmed'); return
    }
    if (!accessToken || !store) return
    await apiRequest(`/api/jobs/${job.id}/payments/${paymentId}/confirm-upi`, accessToken, {
      method: 'POST', body: JSON.stringify({ store_id: store.store_id, reference: reference || null }),
    })
    await reload(store.store_id); showToast('UPI receipt confirmed')
  }

  const saveInvoice = async (job: Job, reference: string, totalMinor: number, reason: string) => {
    if (demo) {
      updateDemoJob(job.id, (current) => ({ ...current, invoiceReference: reference, finalBilledTotalMinor: totalMinor, discrepancyReason: reason || undefined }))
      showToast('Final bill total saved'); return
    }
    if (!accessToken || !store) return
    await apiRequest(`/api/jobs/${job.id}/invoice`, accessToken, {
      method: 'POST', body: JSON.stringify({ store_id: store.store_id, invoice_reference: reference, final_total_minor: totalMinor, discrepancy_reason: reason || null }),
    })
    await reload(store.store_id); showToast('Invoice details saved')
  }

  const startNewJob = () => {
    if (!can('jobs.create')) { showToast('Your role cannot create jobs'); return }
    setEditingJob(null)
    setNewJobOpen(true)
  }

  const startEditJob = (job: Job) => {
    if (!can('jobs.edit_own') && !can('jobs.edit_store')) { showToast('Your role cannot edit this job'); return }
    setEditingJob(job)
    setNewJobOpen(true)
  }

  const navItems: Array<{ key: NavKey; label: string; icon: typeof Home; count?: string }> = [
    { key: 'overview', label: 'Overview', icon: Home },
    { key: 'checkout', label: 'Checkout queue', icon: ClipboardList, count: String(jobs.filter((job) => job.status === 'ready' || job.status === 'checkout').length).padStart(2, '0') },
    { key: 'customers', label: 'Customers', icon: Users },
    { key: 'catalog', label: 'Catalog & charges', icon: Package },
    { key: 'team', label: 'Team access', icon: ShieldCheck },
  ]

  const queueTitle = activeNav === 'checkout' ? 'Checkout queue' : activeNav === 'customers' ? 'Customer book' : activeNav === 'catalog' ? 'Catalog & charges' : activeNav === 'team' ? 'Team access' : 'Today’s activity'

  if (setupNeeded) return <StoreSetup onComplete={async (storeName) => {
    if (!accessToken) return
    await apiRequest('/api/setup/store', accessToken, { method: 'POST', body: JSON.stringify({ store_name: storeName }) })
    setSetupNeeded(false); await reload()
  }} />

  return <div className={`app-shell ${demo ? 'is-demo' : ''}`}>
    <aside className="sidebar">
      <div className="brand-lockup"><BrandMark compact /><div><strong>counterline</strong><span>RETAIL WORKSPACE</span></div></div>
      <button className="store-switcher" type="button"><span className="store-avatar">{(store?.store?.name || 'M').slice(0, 1).toUpperCase()}</span><span className="store-name"><strong>{store?.store?.name || 'Mango Mobile'}</strong><small>Store workspace</small></span><ChevronDown size={15} /></button>
      <div className="nav-caption">WORKSPACE</div>
      <nav className="primary-nav" aria-label="Main navigation">
        {navItems.map(({ key, label, icon: Icon, count }) => <button key={key} className={`nav-item ${activeNav === key ? 'active' : ''}`} onClick={() => { setActiveNav(key); setMobileDetailOpen(false) }} type="button">
          <Icon size={18} strokeWidth={1.9} /><span>{label}</span>{count && <span className="nav-count">{count}</span>}
        </button>)}
      </nav>
      <div className="sidebar-spacer" />
      <div className="sidebar-pulse"><div className="pulse-icon"><Activity size={16} /></div><div><strong>Floor is moving</strong><span>{jobs.filter((job) => ['ready', 'checkout'].includes(job.status)).length} jobs in the handoff</span></div><span className="pulse-dot" /></div>
      <div className="sidebar-footer">
        <button className="nav-item support-link" type="button"><Settings2 size={18} /><span>Workspace settings</span></button>
        <div className="profile-button"><span className="avatar avatar-dark">AS</span><span className="profile-copy"><strong>{demo ? 'Anika Sharma' : store?.display_name || 'Store staff'}</strong><small>{demo ? roleLabel[role] : store?.role || 'Staff'}</small></span>{demo ? <select aria-label="Demo role" value={role} onChange={(e) => setRole(e.target.value as StaffRole)}><option value="manager">Manager</option><option value="cashier">Cashier</option><option value="salesperson">Salesperson</option></select> : <button className="profile-more" type="button" aria-label="Sign out" onClick={onSignOut}><MoreHorizontal size={18} /></button>}</div>
      </div>
    </aside>

    <main className="workspace-main">
      <header className="topbar">
        <div className="mobile-brand"><button className="icon-button mobile-menu" aria-label="Open menu"><Menu size={19} /></button><BrandMark compact /><strong>counterline</strong></div>
        <div className="crumbs"><span>Workspace</span><ChevronRight size={14} /><strong>{navItems.find((item) => item.key === activeNav)?.label}</strong></div>
        <div className="topbar-actions">
          {demo && <span className="demo-pill"><span /> DEMO DATA</span>}
          {updateReady && <button className="update-available" type="button" onClick={() => void navigator.serviceWorker?.getRegistration().then((registration) => registration?.waiting?.postMessage({ type: 'SKIP_WAITING' }))}>Update ready · Reload</button>}
          {!demo && <span className="connection-status"><span className="status-dot" /> Live</span>}
          <button className="icon-button search-trigger" onClick={() => document.getElementById('job-search')?.focus()} aria-label="Search jobs"><Search size={18} /></button>
          <button className="icon-button notification-button" aria-label="Notifications"><Bell size={18} /><i /></button>
          <span className="topbar-divider" />
          <span className="topbar-date">{todayLabel}</span>
        </div>
      </header>

      {loadError && !demo && <div className="load-error"><CircleAlert size={16} />{loadError}<button onClick={() => void reload(store?.store_id)}>Retry</button></div>}
      {loading && !demo ? <div className="page-loading"><span className="loading-orb" />Loading your store…</div> : activeNav === 'customers' ? <CustomerBook jobs={jobs} onSelect={(job) => { setSelectedId(job.id); setMobileDetailOpen(true); setActiveNav('overview') }} /> : activeNav === 'catalog' ? <CatalogPage products={products} charges={charges} /> : activeNav === 'team' ? <TeamPage demo={demo} /> : (
        <div className="main-grid">
          <section className="content-column">
            <div className="page-heading">
              <div><div className="eyebrow eyebrow-green"><span className="heading-live-dot" /> STORE FLOOR · {weekdayLabel}</div><h1>{activeNav === 'checkout' ? 'Checkout queue' : 'Good morning, Anika'}<span className="heading-period">.</span></h1><p>{activeNav === 'checkout' ? 'Everything arriving at the counter, in one clear line.' : 'A clear view of every sale moving through your store.'}</p></div>
              <button className="button button-primary new-job-button" onClick={startNewJob}><Plus size={18} /><span>New job</span></button>
            </div>

            <section className="metrics-grid" aria-label="Today's activity">
              <MetricCard label="Ready at counter" value={jobs.filter((job) => job.status === 'ready').length.toString().padStart(2, '0')} detail="Waiting for the cashier" icon={<ArrowDownLeft size={17} />} tone="green" />
              <MetricCard label="In checkout" value={jobs.filter((job) => job.status === 'checkout').length.toString().padStart(2, '0')} detail="Payment or bill in progress" icon={<Wallet size={17} />} tone="blue" />
              <MetricCard label="Needs a look" value={jobs.filter((job) => job.status === 'returned').length.toString().padStart(2, '0')} detail="Sent back to the floor" icon={<CircleAlert size={17} />} tone="amber" />
            </section>

            <section className="queue-card">
              <div className="queue-header">
                <div className="queue-title"><div><span className="eyebrow">CHECKOUT HANDOFF</span><h2>{queueTitle}<span className="count-bubble">{visibleJobs.length}</span></h2></div><span className="queue-pulse"><span /> Auto-refresh · 15s</span></div>
                <div className="queue-toolbar">
                  <div className="filter-tabs" role="tablist" aria-label="Filter jobs">
                    {(['all', 'ready', 'checkout', 'returned', 'completed'] as QueueFilter[]).map((filter) => <button type="button" role="tab" aria-selected={queueFilter === filter} className={queueFilter === filter ? 'selected' : ''} key={filter} onClick={() => { setQueueFilter(filter); setActiveNav('overview') }}>{filter === 'all' ? 'All' : filter === 'ready' ? 'Ready' : filter === 'checkout' ? 'In checkout' : filter === 'returned' ? 'Returned' : 'Done'}</button>)}
                  </div>
                  <div className="queue-tools"><label className="search-box"><Search size={16} /><input id="job-search" value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search jobs" /><kbd>⌘ K</kbd></label><button className="icon-button filter-button" aria-label="More filters"><Filter size={16} /></button></div>
                </div>
              </div>

              <div className="queue-list">
                {visibleJobs.length === 0 ? <div className="empty-queue"><div className="empty-icon"><ShoppingBag size={20} /></div><strong>No jobs in this view</strong><span>New customer jobs will appear here as the floor sends them over.</span><button className="button button-soft" onClick={startNewJob}><Plus size={16} /> Create a job</button></div> : visibleJobs.map((job, index) => <JobRow key={job.id} job={job} selected={selectedId === job.id} onClick={() => { setSelectedId(job.id); setMobileDetailOpen(true) }} index={index} />)}
              </div>
              <div className="queue-foot"><span><span className="status-dot" /> All jobs up to date</span><button type="button" className="text-button" onClick={() => !demo && void reload(store?.store_id)}>Refresh queue <Zap size={13} /></button></div>
            </section>
            <div className="privacy-note"><ShieldCheck size={14} /><span>Customer history in this workspace starts from the jobs created here.</span><button type="button">Privacy details</button></div>
          </section>

          <aside className={`detail-column ${mobileDetailOpen ? 'mobile-open' : ''}`}>
            {selected ? <JobDetail key={`${selected.id}-${selected.status}-${selected.version || 1}-${selected.payments.length}-${selected.invoiceReference || ''}`} job={selected} can={can} onEdit={startEditJob} onClose={() => setMobileDetailOpen(false)} onTransition={transition} onAddPayment={addPayment} onConfirmUpi={confirmUpi} onSaveInvoice={saveInvoice} toast={showToast} /> : <div className="detail-empty"><div className="detail-empty-icon"><ClipboardList size={22} /></div><strong>Select a job</strong><span>Choose a job from the queue to see its full handoff.</span></div>}
          </aside>
        </div>
      )}

      <footer className="app-footer"><span>COUNTERLINE <i>·</i> STORE OPERATIONS</span><span><Wifi size={13} /> {demo ? 'Local preview' : 'Secure connection'}</span></footer>
    </main>

    {newJobOpen && <NewJobDialog key={editingJob?.id || 'new'} products={products} charges={charges} members={members} demo={demo} existingJob={editingJob || undefined} onClose={() => { setNewJobOpen(false); setEditingJob(null) }} onSubmit={createJob} />}
    {toast && <div className="toast-message" role="status"><CheckCircle2 size={17} />{toast}</div>}
  </div>
}

function BrandMark({ compact, light }: { compact?: boolean; light?: boolean }) {
  return <span className={`brand-mark ${compact ? 'brand-mark-small' : ''} ${light ? 'brand-mark-light' : ''}`} aria-hidden="true"><span /><span /><span /><i /></span>
}

function MetricCard({ label, value, detail, icon, tone }: { label: string; value: string; detail: string; icon: ReactNode; tone: string }) {
  return <article className="metric-card"><div className={`metric-icon ${tone}`}>{icon}</div><div className="metric-number-row"><strong>{value}</strong><span className={`metric-trend ${tone}`}><ArrowRight size={12} /></span></div><span className="metric-label">{label}</span><span className="metric-detail">{detail}</span></article>
}

function JobRow({ job, selected, onClick, index }: { job: Job; selected: boolean; onClick: () => void; index: number }) {
  const quote = jobQuote(job)
  return <button className={`job-row ${selected ? 'selected' : ''}`} onClick={onClick} type="button" style={{ '--row-index': index } as CSSProperties}>
    <div className="row-avatar-wrap"><span className={`avatar customer-avatar color-${index % 5}`}>{job.customerName.split(' ').map((part) => part[0]).slice(0, 2).join('')}</span><span className={`row-status-dot ${job.status}`} /></div>
    <div className="row-main"><div className="row-name-line"><strong>{job.customerName}</strong><span className={`status-pill ${job.status}`}>{job.status === 'ready' ? 'Ready' : job.status === 'checkout' ? 'At counter' : job.status === 'returned' ? 'Correction' : job.status === 'completed' ? 'Complete' : statusText[job.status]}</span></div><span className="row-description">{job.lines.length} {job.lines.length === 1 ? 'item' : 'items'} <i>·</i> {job.lines.slice(0, 2).map((line) => line.label.split(' · ')[0]).join(', ')}</span><div className="row-meta"><span className="job-number">#{job.jobNumber}</span><span>{job.owner}</span><span className="meta-time"><Clock3 size={12} />{job.timeLabel}</span></div></div>
    <div className="row-total"><strong>{formatMoney(quote)}</strong><span>QUOTE</span></div><ChevronRight className="row-chevron" size={16} />
  </button>
}

function JobDetail({ job, can, onEdit, onClose, onTransition, onAddPayment, onConfirmUpi, onSaveInvoice, toast }: {
  job: Job; can: (permission: string) => boolean; onClose: () => void
  onEdit: (job: Job) => void
  onTransition: (job: Job, status: JobStatus, reason?: string) => Promise<void>
  onAddPayment: (job: Job, method: 'cash' | 'upi', amountMinor: number, reference?: string) => Promise<void>
  onConfirmUpi: (job: Job, paymentId: string, reference: string) => Promise<void>
  onSaveInvoice: (job: Job, reference: string, totalMinor: number, reason: string) => Promise<void>
  toast: (message: string) => void
}) {
  const quote = jobQuote(job)
  const confirmed = totalConfirmed(job)
  const outstanding = Math.max(0, (job.finalBilledTotalMinor ?? quote) - confirmed)
  const [paymentAmount, setPaymentAmount] = useState(outstanding ? (outstanding / 100).toFixed(2).replace(/\.00$/, '') : '')
  const [paymentMethod, setPaymentMethod] = useState<'cash' | 'upi'>('cash')
  const [upiRef, setUpiRef] = useState('')
  const [paymentRefs, setPaymentRefs] = useState<Record<string, string>>({})
  const [invoiceRef, setInvoiceRef] = useState(job.invoiceReference || '')
  const [finalTotal, setFinalTotal] = useState(job.finalBilledTotalMinor == null ? '' : String(job.finalBilledTotalMinor / 100).replace(/\.00$/, ''))
  const [discrepancyReason, setDiscrepancyReason] = useState(job.discrepancyReason || '')
  const [returnReason, setReturnReason] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [invoiceFormOpen, setInvoiceFormOpen] = useState(!job.invoiceReference && job.status === 'checkout')
  const [paymentFormOpen, setPaymentFormOpen] = useState(false)

  const copyHandoff = async () => {
    const lines = [
      `JOB #${job.jobNumber}`,
      `Customer: ${job.customerName}`,
      `Phone: ${job.customerPhone}`,
      `Sales owner: ${job.owner}`,
      job.contributors.length ? `Contributors: ${job.contributors.join(', ')}` : '',
      '',
      'ITEMS',
      ...job.lines.map((line) => `${line.quantity} x ${line.label}${line.sku ? ` (${line.sku})` : ''} — ${formatMoney(line.quantity * line.unitPriceMinor)}`),
      ...job.charges.map((charge) => `${charge.quantity} x ${charge.name} — ${formatMoney(charge.quantity * charge.unitAmountMinor)}`),
      `QUOTE TOTAL: ${formatMoney(quote)}`,
      'Final tax and bill amount: enter from billing software.',
      job.note ? `Note: ${job.note}` : '',
    ].filter(Boolean).join('\n')
    try { await navigator.clipboard.writeText(lines); toast('Job summary copied for billing') }
    catch { toast('Clipboard is unavailable on this device') }
  }

  const run = async (action: () => Promise<void>) => {
    setBusy(true); setError('')
    try { await action() } catch (e) { setError(e instanceof Error ? e.message : 'Could not complete that action.') }
    finally { setBusy(false) }
  }

  const addPayment = () => {
    const amountMinor = Math.round(Number(paymentAmount) * 100)
    if (!Number.isFinite(amountMinor) || amountMinor <= 0) { setError('Enter an amount greater than ₹0.'); return }
    void run(() => onAddPayment(job, paymentMethod, amountMinor, paymentMethod === 'upi' ? upiRef : undefined))
  }

  const submitInvoice = (event: FormEvent) => {
    event.preventDefault()
    const totalMinor = Math.round(Number(finalTotal) * 100)
    if (!invoiceRef.trim()) { setError('Enter the invoice reference from your billing software.'); return }
    if (!finalTotal.trim() || !Number.isFinite(totalMinor) || totalMinor < 0) { setError('Enter the final bill total.'); return }
    if (totalMinor !== quote && !discrepancyReason.trim()) { setError('Add a reason for the difference from the quote.'); return }
    void run(() => onSaveInvoice(job, invoiceRef, totalMinor, discrepancyReason))
    setInvoiceFormOpen(false)
  }

  return <div className="detail-panel">
    <div className="detail-head"><div><span className="eyebrow">JOB CARD</span><div className="detail-job-title"><h2>#{job.jobNumber}</h2><span className={`status-pill ${job.status}`}>{statusText[job.status]}</span></div></div><div className="detail-head-actions"><button className="icon-button mobile-detail-back" onClick={onClose} aria-label="Back to queue"><ArrowRight className="back-arrow" size={18} /></button><button className="icon-button" aria-label="More job actions"><MoreHorizontal size={18} /></button></div></div>
    <div className="detail-scroll">
      {job.correctionReason && job.status === 'returned' && <div className="correction-banner"><CircleAlert size={16} /><div><strong>Cashier note</strong><span>{job.correctionReason}</span></div></div>}
      <section className="customer-block"><div className="customer-block-title"><span className="avatar customer-avatar color-2">{job.customerName.split(' ').map((part) => part[0]).slice(0, 2).join('')}</span><div><h3>{job.customerName}</h3><span>{job.customerPhone}</span></div><button className="icon-button customer-more" aria-label="Customer details"><MoreHorizontal size={18} /></button></div><div className="customer-history"><div><span className="history-spark">✳</span><span>Workspace history</span></div><strong>{job.status === 'completed' ? 'Past customer' : 'First recorded visit'}</strong></div></section>

      <section className="detail-section items-section"><div className="section-heading"><span>ITEMS IN THIS JOB</span><span>{job.lines.reduce((sum, line) => sum + line.quantity, 0)} items</span></div>
        <div className="detail-lines">{job.lines.map((line) => <div className="detail-line" key={line.id}><div className="item-icon"><Smartphone size={15} /></div><div className="item-description"><strong>{line.label}</strong><span>{line.sku || line.contributor}</span></div><span className="item-quantity">×{line.quantity}</span><strong className="item-price">{formatMoney(line.quantity * line.unitPriceMinor)}</strong></div>)}
          {job.charges.map((charge) => <div className="detail-line charge-line" key={charge.id}><div className="item-icon charge"><ShoppingBag size={15} /></div><div className="item-description"><strong>{charge.name}</strong><span>Additional charge</span></div><span className="item-quantity">×{charge.quantity}</span><strong className="item-price">{formatMoney(charge.quantity * charge.unitAmountMinor)}</strong></div>)}
        </div>
        <div className="quote-summary"><span>Quoted total <small>· tax confirmed in billing</small></span><strong>{formatMoney(quote)}</strong></div>
      </section>

      <section className="detail-section handoff-section"><div className="section-heading"><span>SALES HANDOFF</span><span className="handoff-time"><Clock3 size={12} />{job.timeLabel}</span></div><div className="handoff-person"><span className="avatar mini-avatar">{job.owner.split(' ').map((part) => part[0]).join('').slice(0, 2)}</span><div><strong>{job.owner}</strong><span>Salesperson</span></div><span className="handoff-contributors">{job.contributors.length > 1 ? `+${job.contributors.length - 1} contributed` : 'Primary'}</span></div>{job.note && <div className="job-note"><span>NOTE</span>{job.note}</div>}</section>

      <section className="detail-section cashier-section"><div className="section-heading"><span>PAYMENT & BILLING</span><span className={`payment-state ${outstanding === 0 && job.finalBilledTotalMinor != null ? 'paid' : ''}`}><span />{outstanding === 0 && job.finalBilledTotalMinor != null ? 'Settled' : job.payments.length ? 'Part paid' : 'Unpaid'}</span></div>
        <div className="billing-total-row"><span>Amount currently expected</span><strong>{formatMoney(job.finalBilledTotalMinor ?? quote)}</strong></div>
        {job.payments.length > 0 && <div className="payment-list">{job.payments.map((payment) => <div className="payment-entry" key={payment.id}><span className={`payment-method-icon ${payment.method}`}>{payment.method === 'cash' ? <Wallet size={14} /> : <Smartphone size={14} />}</span><span className="payment-entry-label"><strong>{payment.method === 'cash' ? 'Cash' : 'UPI'}</strong><small>{payment.reference || payment.time}</small></span><strong>{formatMoney(payment.amountMinor)}</strong><span className={`payment-status ${payment.status}`}>{payment.status === 'confirmed' ? <Check size={13} /> : <Clock3 size={13} />}{payment.status === 'confirmed' ? 'Received' : 'Pending'}</span>{payment.method === 'upi' && payment.status === 'pending' && can('payments.confirm_upi') && <><input aria-label="UPI transaction reference" className="upi-reference-input" value={paymentRefs[payment.id] || ''} onChange={(event) => setPaymentRefs((current) => ({ ...current, [payment.id]: event.target.value }))} placeholder="Reference" /><button className="link-button confirm-link" onClick={() => void run(() => onConfirmUpi(job, payment.id, paymentRefs[payment.id] || ''))}>Confirm received</button></>}</div>)}</div>}
        {job.invoiceReference ? <div className="invoice-recorded"><div className="invoice-icon"><Check size={15} /></div><div><strong>Invoice {job.invoiceReference}</strong><span>Final bill · {formatMoney(job.finalBilledTotalMinor ?? 0)}</span>{job.discrepancyReason && <small>Difference note: {job.discrepancyReason}</small>}</div><button type="button" className="link-button" onClick={() => setInvoiceFormOpen((open) => !open)}>Edit</button></div> : <div className="invoice-hint"><span className="invoice-hint-icon"><ClipboardList size={15} /></span><span><strong>Bill in your billing software</strong><small>Copy this job, create the official invoice, then record its final total.</small></span></div>}

        {paymentFormOpen && job.status === 'checkout' && <div className="inline-form payment-form"><div className="inline-form-heading"><strong>Record collection</strong><button className="icon-button tiny" onClick={() => setPaymentFormOpen(false)} aria-label="Close"><X size={15} /></button></div><div className="payment-method-tabs"><button className={paymentMethod === 'cash' ? 'active' : ''} onClick={() => setPaymentMethod('cash')}><Wallet size={14} /> Cash</button><button className={paymentMethod === 'upi' ? 'active' : ''} onClick={() => setPaymentMethod('upi')}><Smartphone size={14} /> UPI</button></div><label className="mini-label">AMOUNT (₹)<input inputMode="decimal" value={paymentAmount} onChange={(e) => setPaymentAmount(e.target.value)} placeholder="0" /></label>{paymentMethod === 'upi' && <><label className="mini-label">UPI REFERENCE <span className="optional">Optional</span><input value={upiRef} onChange={(e) => setUpiRef(e.target.value)} placeholder="Transaction ID, if available" /></label><div className="manual-upi-note"><CircleAlert size={14} /> UPI stays pending until a permitted staff member confirms receipt.</div></>}<button className="button button-dark button-wide" disabled={busy || !can(paymentMethod === 'cash' ? 'payments.record_cash' : 'payments.record_upi')} onClick={addPayment}>{busy ? 'Saving…' : paymentMethod === 'cash' ? 'Record cash received' : 'Record UPI as pending'}</button></div>}

        {invoiceFormOpen && job.status === 'checkout' && <form className="inline-form invoice-form" onSubmit={submitInvoice}><div className="inline-form-heading"><strong>Enter the final bill</strong><button type="button" className="icon-button tiny" onClick={() => setInvoiceFormOpen(false)} aria-label="Close"><X size={15} /></button></div><label className="mini-label">INVOICE REFERENCE<input value={invoiceRef} onChange={(e) => setInvoiceRef(e.target.value)} placeholder="e.g. INV-58158" /></label><label className="mini-label">FINAL BILL TOTAL (₹)<input inputMode="decimal" value={finalTotal} onChange={(e) => setFinalTotal(e.target.value)} placeholder="0" /></label>{Math.round(Number(finalTotal) * 100) !== quote && finalTotal !== '' && <label className="mini-label">REASON FOR DIFFERENCE<textarea value={discrepancyReason} onChange={(e) => setDiscrepancyReason(e.target.value)} placeholder="Briefly explain the difference" rows={2} /></label>}<p className="form-footnote">The billing software remains the source of truth for tax and invoice totals.</p><button className="button button-dark button-wide" disabled={busy || !can('billing.record')}>{busy ? 'Saving…' : 'Save invoice details'}</button></form>}

        {job.status === 'checkout' && <div className="cashier-actions"><button className="button button-soft" onClick={() => { void copyHandoff() }}><Copy size={15} /> Copy billing summary</button><button className="button button-outline" disabled={!can('payments.record_cash') && !can('payments.record_upi')} onClick={() => setPaymentFormOpen((open) => !open)}><Plus size={15} /> Record payment</button>{!job.invoiceReference && can('billing.record') && <button className="link-button enter-invoice" onClick={() => setInvoiceFormOpen((open) => !open)}>Enter final bill</button>}</div>}
      </section>

      {error && <div className="inline-error" role="alert"><CircleAlert size={15} />{error}</div>}
    </div>

    <div className="detail-footer">
      {job.status === 'ready' && can('jobs.checkout') && <button className="button button-primary button-wide" disabled={busy} onClick={() => void run(() => onTransition(job, 'checkout'))}>Start checkout <ArrowRight size={16} /></button>}
      {job.status === 'returned' && (can('jobs.edit_own') || can('jobs.edit_store')) && <button className="button button-soft button-wide" onClick={() => onEdit(job)}>Edit returned job <ClipboardList size={16} /></button>}
      {(job.status === 'draft' || job.status === 'returned') && can('jobs.submit') && <button className="button button-primary button-wide" disabled={busy} onClick={() => void run(() => onTransition(job, 'ready'))}>Send to checkout <ArrowRight size={16} /></button>}
      {job.status === 'ready' && can('jobs.return') && <div className="return-action"><input value={returnReason} onChange={(e) => setReturnReason(e.target.value)} aria-label="Correction reason" placeholder="Correction reason (required)" /><button className="button button-soft" disabled={!returnReason.trim() || busy} onClick={() => void run(() => onTransition(job, 'returned', returnReason))}>Return</button></div>}
      {job.status === 'checkout' && can('jobs.complete') && <button className="button button-primary button-wide" disabled={busy || !job.invoiceReference || outstanding > 0} onClick={() => void run(() => onTransition(job, 'completed'))}>{job.invoiceReference && outstanding === 0 ? 'Complete job' : 'Complete after bill & payment'}<CheckCircle2 size={16} /></button>}
      {job.status === 'completed' && <div className="completed-footer"><CheckCircle2 size={16} /> This job is closed and linked to its invoice.</div>}
      {(job.status === 'draft' || job.status === 'returned' || job.status === 'ready') && <button className="link-button save-draft" onClick={() => void copyHandoff()}><Copy size={14} /> Copy job summary</button>}
      {job.status === 'checkout' && <span className="footer-hint"><ShieldCheck size={13} /> Payments and invoices are recorded separately</span>}
    </div>
  </div>
}

function NewJobDialog({ products, charges, members, demo, existingJob, onClose, onSubmit }: {
  products: CatalogProduct[]; charges: CatalogCharge[]; members: Array<{ id: string; name: string; role: string }>; demo: boolean
  existingJob?: Job
  onClose: () => void
  onSubmit: (input: { phone: string; name: string; lines: JobLine[]; charges: JobCharge[]; contributors: Array<{ user_id: string; contribution: 'sales' | 'promoter' | 'assisted' }>; note: string; jobId?: string; version?: number }) => Promise<void>
}) {
  const dialog = useRef<HTMLDialogElement>(null)
  const [phone, setPhone] = useState(existingJob?.customerPhone || '')
  const [name, setName] = useState(existingJob?.customerName || '')
  const [note, setNote] = useState(existingJob?.note || '')
  const [selectedCharges, setSelectedCharges] = useState<string[]>(existingJob?.charges.map((charge) => charge.id).filter((id) => charges.some((charge) => charge.id === id)) || [])
  const [selectedMembers, setSelectedMembers] = useState<string[]>(existingJob?.contributors.map((name) => members.find((member) => member.name === name)?.id).filter((id): id is string => Boolean(id)) || [])
  const [lines, setLines] = useState<Array<{ id: string; productId?: string; label: string; sku?: string; quantity: number; unitPriceMinor: number }>>(existingJob?.lines.map((line) => ({ id: line.id, productId: line.id.startsWith('custom-') ? undefined : line.id, label: line.label, sku: line.sku, quantity: line.quantity, unitPriceMinor: line.unitPriceMinor })) || [])
  const [customName, setCustomName] = useState('')
  const [customPrice, setCustomPrice] = useState('')
  const [customOpen, setCustomOpen] = useState(false)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    const element = dialog.current
    if (!element) return
    if (!element.open) element.showModal()
    return () => { if (element.open) element.close() }
  }, [])

  const normalizedPhone = (value: string) => {
    const trimmed = value.trim()
    const digits = trimmed.replace(/\D/g, '')
    if (trimmed.startsWith('+')) return `+${digits}`
    if (digits.length === 10) return `+91${digits}`
    if (digits.startsWith('91') && digits.length === 12) return `+${digits}`
    return digits ? `+${digits}` : ''
  }
  const phoneForSubmit = normalizedPhone(phone)
  const phoneValid = /^\+[1-9][0-9]{7,14}$/.test(phoneForSubmit)
  const quote = lines.reduce((total, line) => total + line.quantity * line.unitPriceMinor, 0) + charges.filter((charge) => selectedCharges.includes(charge.id)).reduce((total, charge) => total + charge.amountMinor, 0)

  const addProduct = (productId: string) => {
    const product = products.find((item) => item.id === productId)
    if (!product) return
    setLines((current) => {
      const existing = current.find((line) => line.productId === productId)
      if (existing) return current.map((line) => line.id === existing.id ? { ...line, quantity: line.quantity + 1 } : line)
      return [...current, { id: product.id, productId, label: product.name, sku: product.sku, quantity: 1, unitPriceMinor: product.unitPriceMinor }]
    })
  }

  const addCustomLine = () => {
    const price = Math.round(Number(customPrice) * 100)
    if (!customName.trim() || !customPrice.trim() || !Number.isFinite(price) || price < 0) { setError('Enter an item name and a valid quoted price.'); return }
    setLines((current) => [...current, { id: `custom-${crypto.randomUUID()}`, label: customName.trim(), quantity: 1, unitPriceMinor: price }])
    setCustomName(''); setCustomPrice(''); setCustomOpen(false); setError('')
  }

  const submit = async (event: FormEvent) => {
    event.preventDefault(); setError('')
    if (!phoneValid) { setError('Enter a valid phone number with country code.'); return }
    if (!lines.length) { setError('Add at least one product or custom line.'); return }
    setBusy(true)
    try {
      const jobLines: JobLine[] = lines.map((line) => ({ id: line.productId || line.id, label: line.label, sku: line.sku, quantity: line.quantity, unitPriceMinor: line.unitPriceMinor, contributor: 'Sales team' }))
      const jobCharges: JobCharge[] = charges.filter((charge) => selectedCharges.includes(charge.id)).map((charge) => ({ id: charge.id, name: charge.name, quantity: 1, unitAmountMinor: charge.amountMinor }))
      const contributors = selectedMembers.map((user_id) => ({ user_id, contribution: (members.find((member) => member.id === user_id)?.role === 'promoter' ? 'promoter' : 'sales') as 'sales' | 'promoter' }))
      await onSubmit({ phone: phoneForSubmit, name: name.trim(), lines: jobLines, charges: jobCharges, contributors, note: note.trim(), jobId: existingJob?.id, version: existingJob?.version ?? 1 })
    } catch (e) { setError(e instanceof Error ? e.message : 'Could not create this job.') }
    finally { setBusy(false) }
  }

  return <dialog ref={dialog} className="job-dialog" onCancel={(e) => { e.preventDefault(); onClose() }} onClick={(e) => { if (e.target === dialog.current) onClose() }}>
    <div className="dialog-layout">
      <div className="dialog-head"><div><span className="eyebrow">{existingJob ? 'CORRECT CUSTOMER HANDOFF' : 'NEW CUSTOMER HANDOFF'}</span><h2>{existingJob ? `Edit job #${existingJob.jobNumber}` : 'Build a job card'}</h2><p>{existingJob ? 'Update the returned details, then send the corrected job back.' : 'Capture the customer and what the floor has agreed.'}</p></div><button className="icon-button" type="button" onClick={onClose} aria-label="Close job editor"><X size={18} /></button></div>
      <form onSubmit={submit} className="job-form">
        <section className="form-section"><div className="form-section-title"><span className="step-number">01</span><div><strong>Customer details</strong><small>A phone number is required for every job.</small></div></div><div className="form-fields two-columns"><label>Phone number <em>Required</em><input type="tel" inputMode="tel" autoComplete="tel" required value={phone} onChange={(e) => setPhone(e.target.value)} placeholder="+91 98765 43210" />{phone && <span className={`field-hint ${phoneValid ? 'valid' : 'invalid'}`}>{phoneValid ? `Saved as ${phoneForSubmit}` : 'Include the country code or enter a 10-digit Indian number.'}</span>}</label><label>Name <span className="optional">Optional</span><input value={name} onChange={(e) => setName(e.target.value)} maxLength={120} placeholder="Customer name" /></label></div></section>

        <section className="form-section"><div className="form-section-title"><span className="step-number">02</span><div><strong>Items in this job</strong><small>Prices are a quote. The cashier confirms tax and final bill.</small></div></div>
          <div className="product-picker">{products.map((product) => <button type="button" key={product.id} onClick={() => addProduct(product.id)}><span className="picker-plus"><Plus size={15} /></span><span className="picker-copy"><strong>{product.name}</strong><small>{product.brand} {product.sku && `· ${product.sku}`}</small></span><span className="picker-price">{formatMoney(product.unitPriceMinor)}</span></button>)}{products.length === 0 && <div className="picker-empty">The product catalog is empty. Add a custom line below.</div>}</div>
          {lines.length > 0 && <div className="draft-lines">{lines.map((line) => <div className="draft-line" key={line.id}><div><strong>{line.label}</strong><small>{line.sku || 'Custom item'}</small></div><div className="qty-stepper"><button type="button" aria-label="Decrease quantity" disabled={line.quantity <= 1} onClick={() => setLines((current) => current.map((item) => item.id === line.id ? { ...item, quantity: Math.max(1, item.quantity - 1) } : item))}>−</button><span>{line.quantity}</span><button type="button" aria-label="Increase quantity" onClick={() => setLines((current) => current.map((item) => item.id === line.id ? { ...item, quantity: item.quantity + 1 } : item))}>+</button></div><strong>{formatMoney(line.quantity * line.unitPriceMinor)}</strong><button type="button" className="remove-line" aria-label={`Remove ${line.label}`} onClick={() => setLines((current) => current.filter((item) => item.id !== line.id))}><X size={15} /></button></div>)}</div>}
          {customOpen ? <div className="custom-line-form"><label>Custom item<input value={customName} onChange={(e) => setCustomName(e.target.value)} placeholder="e.g. Camera lens protector" /></label><label>Quote (₹)<input inputMode="decimal" value={customPrice} onChange={(e) => setCustomPrice(e.target.value)} placeholder="0" /></label><button type="button" className="button button-dark" onClick={addCustomLine}>Add line</button></div> : <button type="button" className="custom-line-trigger" onClick={() => setCustomOpen(true)}><Plus size={15} /> Add a custom line</button>}
        </section>

        {charges.length > 0 && <section className="form-section"><div className="form-section-title"><span className="step-number">03</span><div><strong>Additional charges</strong><small>Price snapshots stay with this job.</small></div></div><div className="charge-choices">{charges.map((charge) => <label key={charge.id} className={`charge-choice ${selectedCharges.includes(charge.id) ? 'checked' : ''}`}><input type="checkbox" checked={selectedCharges.includes(charge.id)} onChange={() => setSelectedCharges((current) => current.includes(charge.id) ? current.filter((id) => id !== charge.id) : [...current, charge.id])} /><span className="custom-checkbox"><Check size={13} /></span><span>{charge.name}</span><strong>{formatMoney(charge.amountMinor)}</strong></label>)}</div></section>}

        {members.length > 0 && <section className="form-section"><div className="form-section-title"><span className="step-number">04</span><div><strong>Staff attribution</strong><small>Who helped with this sale?</small></div></div><div className="charge-choices">{members.map((member) => <label key={member.id} className={`charge-choice ${selectedMembers.includes(member.id) ? 'checked' : ''}`}><input type="checkbox" checked={selectedMembers.includes(member.id)} onChange={() => setSelectedMembers((current) => current.includes(member.id) ? current.filter((id) => id !== member.id) : [...current, member.id])} /><span className="custom-checkbox"><Check size={13} /></span><span>{member.name}</span><small>{member.role}</small></label>)}</div></section>}

        <section className="form-section note-section"><label>Note for the cashier <span className="optional">Optional</span><textarea value={note} onChange={(e) => setNote(e.target.value)} rows={2} maxLength={2000} placeholder="Anything the cashier should know?" /></label></section>
        {error && <div className="form-error" role="alert"><CircleAlert size={16} />{error}</div>}
        <div className="dialog-footer"><div><span>QUOTED TOTAL</span><strong>{formatMoney(quote)}</strong><small>Tax and invoice total confirmed by cashier</small></div><button className="button button-primary" disabled={busy || !lines.length}>{busy ? 'Saving…' : existingJob ? 'Save and resubmit' : 'Send to checkout'}<ArrowRight size={16} /></button></div>
      </form>
      {demo && <div className="demo-note"><span /> This is a local demo. Changes are saved in this browser only.</div>}
    </div>
  </dialog>
}

function CustomerBook({ jobs, onSelect }: { jobs: Job[]; onSelect: (job: Job) => void }) {
  const customers = Array.from(new Map(jobs.map((job) => [job.customerPhone, job])).values()).sort((a, b) => b.createdAt.localeCompare(a.createdAt))
  return <main className="secondary-page"><div className="page-heading"><div><span className="eyebrow eyebrow-green">CUSTOMER HISTORY</span><h1>Customer book<span className="heading-period">.</span></h1><p>Only jobs created in this workspace appear in purchase history.</p></div></div><div className="secondary-card"><div className="secondary-card-head"><strong>Recent customers</strong><span>{customers.length} profiles</span></div>{customers.map((customer) => <button key={customer.customerPhone} className="customer-row" onClick={() => onSelect(customer)}><span className="avatar customer-avatar color-2">{customer.customerName.split(' ').map((part) => part[0]).slice(0, 2).join('')}</span><span className="customer-row-main"><strong>{customer.customerName}</strong><small>{customer.customerPhone}</small></span><span className="customer-last-job">Latest job <b>#{customer.jobNumber}</b></span><span className="customer-history-value">{jobs.filter((job) => job.customerPhone === customer.customerPhone).length} visits</span><ChevronRight size={16} /></button>)}</div></main>
}

function CatalogPage({ products, charges }: { products: CatalogProduct[]; charges: CatalogCharge[] }) {
  return <main className="secondary-page"><div className="page-heading"><div><span className="eyebrow eyebrow-green">APP-MANAGED</span><h1>Catalog & charges<span className="heading-period">.</span></h1><p>These are quote defaults. Your billing system still sets official tax and invoice totals.</p></div></div><div className="catalog-columns"><section className="secondary-card"><div className="secondary-card-head"><div><strong>Products</strong><small>Tap into a job to use a default quote.</small></div><span>{products.length} items</span></div>{products.map((item) => <div className="catalog-row" key={item.id}><span className="item-icon"><Smartphone size={15} /></span><span><strong>{item.name}</strong><small>{item.brand} {item.sku && `· ${item.sku}`}</small></span><b>{formatMoney(item.unitPriceMinor)}</b></div>)}</section><section className="secondary-card"><div className="secondary-card-head"><div><strong>Additional charges</strong><small>Snapshot when selected on a job.</small></div><span>{charges.length} charges</span></div>{charges.map((item) => <div className="catalog-row" key={item.id}><span className="item-icon charge"><ShoppingBag size={15} /></span><span><strong>{item.name}</strong><small>Copy into billing software</small></span><b>{formatMoney(item.amountMinor)}</b></div>)}</section></div></main>
}

function TeamPage({ demo }: { demo: boolean }) {
  return <main className="secondary-page"><div className="page-heading"><div><span className="eyebrow eyebrow-green">ACCESS CONTROL</span><h1>Team access<span className="heading-period">.</span></h1><p>Each staff member signs in individually so job actions have a clear owner.</p></div></div><div className="team-access-card"><div className="team-access-icon"><ShieldCheck size={20} /></div><div><strong>{demo ? 'Demo role preview' : 'Role and permission workspace'}</strong><p>{demo ? 'Use the role switcher in the lower-left corner to preview salesperson, cashier, and manager actions.' : 'Role permissions are loaded from your store membership when the API is connected.'}</p></div></div><div className="permission-grid"><div><strong>Salesperson</strong><span>Create and send jobs · record permitted collections</span></div><div><strong>Cashier</strong><span>Review queue · record bill · verify UPI receipts</span></div><div><strong>Manager</strong><span>Resolve discrepancies · manage store access</span></div></div></main>
}

function StoreSetup({ onComplete }: { onComplete: (name: string) => Promise<void> }) {
  const [name, setName] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  return <main className="setup-screen"><form className="setup-card" onSubmit={async (event) => { event.preventDefault(); setBusy(true); setError(''); try { await onComplete(name.trim()) } catch (e) { setError(e instanceof Error ? e.message : 'Unable to initialize the store.') } finally { setBusy(false) } }}><BrandMark /><span className="eyebrow">FIRST SIGN-IN</span><h1>Set up your store</h1><p>This first account will become the store owner. Staff can be added after setup.</p><label>Store name<input value={name} onChange={(e) => setName(e.target.value)} required maxLength={120} placeholder="Mango Mobile" /></label>{error && <div className="form-error"><CircleAlert size={16} />{error}</div>}<button className="button button-primary button-wide" disabled={busy}>{busy ? 'Setting up…' : 'Create store workspace'}<ArrowRight size={16} /></button></form></main>
}
