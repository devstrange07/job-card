import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type FormEvent, type ReactNode } from 'react'
import type { Session } from '@supabase/supabase-js'
import {
  ArrowLeft, ArrowRight, Bell, ChartColumn, Check, CheckCircle2,
  ChevronRight, CircleAlert, ClipboardList, Clock3, Copy, Eye, EyeOff,
  Home, Menu, Package, Pencil, Plus, Search, ShieldCheck,
  ShoppingBag, Smartphone, Users, Wallet, X,
} from 'lucide-react'
import { charges as demoCharges, formatMoney, jobQuote, products as demoProducts, seedJobs, totalConfirmed } from './demoData'
import type { CatalogCharge, CatalogProduct, Job, JobCharge, JobLine, JobStatus, Payment, RewardRecipient, StaffRole } from './types'
import { apiRequest, publicError, signInFallback } from './lib/api'
import { hasSupabaseConfig, supabase } from './lib/supabase'
import { ReadOnlyVisit, VisitHistory, type CustomerLookup, type VisitDetail, type VisitSummary } from './VisitHistory'
import { PhoneKeypad } from './PhoneKeypad'
import { displayCustomerPhone, localPhoneDigits, normalizePhone, validPhone } from './lib/phone'
import { RewardRecipients, type RecipientDraft } from './RewardRecipients'
import { PageDetails } from './PageDetails'
import { SalesReports } from './SalesReports'
import './App.css'

const demoMode = import.meta.env.DEV && (!hasSupabaseConfig || import.meta.env.VITE_DEMO_MODE === 'true')
const demoJobsKey = 'job-card-demo-jobs-v1'
const rolePermissions: Record<StaffRole, string[]> = {
  salesperson: ['jobs.create', 'jobs.read_own', 'jobs.edit_own', 'jobs.submit', 'payments.record_cash', 'payments.record_upi', 'catalog.read'],
  cashier: ['jobs.read_store', 'jobs.checkout', 'jobs.return', 'jobs.complete', 'payments.record_cash', 'payments.record_upi', 'payments.confirm_upi', 'billing.record', 'catalog.read', 'customers.read_phone'],
  manager: ['*'],
}

type NavKey = 'overview' | 'checkout' | 'customers' | 'catalog' | 'team' | 'sales'
const workspacePages: Record<NavKey, { title: string; description: string }> = {
  overview: { title: 'Jobs', description: 'Create, review, and send store job cards to checkout.' },
  checkout: { title: 'Checkout', description: 'Review job handoffs, record payments, and close jobs with their final invoice.' },
  customers: { title: 'Customer book', description: 'Find customers and review their recorded store visits.' },
  catalog: { title: 'Catalog & charges', description: 'Review the products and charges available when preparing a quote.' },
  team: { title: 'Team access', description: 'Review staff roles and manage invitations and access to the store.' },
  sales: { title: 'Sales reports', description: 'Review daily, weekly, and yearly invoice totals for the store.' },
}
type ToastKind = 'success' | 'error'
const supportPhone = import.meta.env.VITE_SUPPORT_PHONE?.trim()
const supportEmail = import.meta.env.VITE_SUPPORT_EMAIL?.trim()
type QueueFilter = 'open' | 'all' | 'ready' | 'checkout' | 'returned' | 'completed'
const filterLabels: Record<QueueFilter, string> = {
  open: 'Open', all: 'All', ready: 'Ready', checkout: 'In progress', returned: 'Returned', completed: 'Done',
}
type StoreMembership = {
  store_id: string
  role: string
  permissions: string[]
  deny_permissions?: string[]
  display_name?: string | null
  store?: { id: string; name: string; currency_code: string; timezone: string }
}
type SessionResponse = { stores: StoreMembership[]; can_initialize_store: boolean }
type ApiJob = Record<string, any>
type JobCardInput = {
  phone: string; name: string; lines: JobLine[]; charges: JobCharge[]; note: string
  contributors: Array<{ user_id: string; contribution: 'sales' | 'promoter' | 'assisted' }>
  accompanyingCount: number; rewardRecipients: RewardRecipient[]; submissionKey: string
  jobId?: string; version?: number
}

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
    customerId: source.customer_id,
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
    accompanyingCount: source.accompanying_count,
    rewardRecipients: (source.job_reward_recipients || []).map((item: { role: RewardRecipient['role']; phone_e164?: string; display_name_snapshot: string; saved_key?: string }) => ({
      role: item.role, phone: item.phone_e164, name: item.display_name_snapshot, savedKey: item.saved_key,
    })),
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

function demoVisit(job: Job): VisitDetail {
  return {
    id: job.id, job_number: job.jobNumber, created_at: job.createdAt, status: job.status,
    currency_code: 'INR', quoted_total_minor: jobQuote(job),
    final_billed_total_minor: job.finalBilledTotalMinor ?? null, staff_note: job.note,
    job_line_items: job.lines.map((line) => ({
      id: line.id, label_snapshot: line.label, sku_snapshot: line.sku, quantity: line.quantity, unit_price_minor: line.unitPriceMinor,
    })),
    job_charge_items: job.charges.map((charge) => ({
      id: charge.id, name_snapshot: charge.name, quantity: charge.quantity, unit_amount_minor: charge.unitAmountMinor,
    })),
  }
}

function storeClock(now: Date, timeZone?: string) {
  const hourOptions = { hour: 'numeric', hourCycle: 'h23' } as const
  const dateOptions = { weekday: 'short', month: 'short', day: 'numeric' } as const
  try {
    const hour = Number(new Intl.DateTimeFormat('en-GB', { ...hourOptions, timeZone }).format(now))
    const date = new Intl.DateTimeFormat('en-IN', { ...dateOptions, timeZone }).format(now)
    const greeting = hour >= 5 && hour < 12 ? 'Good morning' : hour >= 12 && hour < 17 ? 'Good afternoon' : 'Good evening'
    return { greeting, date }
  } catch (error) {
    if (timeZone && error instanceof RangeError) return storeClock(now)
    throw error
  }
}

function hasPermission(permissions: string[], permission: string, denied?: string[]) {
  return !denied?.includes(permission) && (permissions.includes('*') || permissions.includes(permission))
}

function canViewSales(role?: string) {
  return role === 'manager' || role === 'owner'
}

export default function App() {
  const path = window.location.pathname.replace(/\/+$/, '') || '/'
  if (path !== '/' && path !== '/auth/accept-invitation') {
    return <main className="setup-screen">
      <PageDetails title="Page not found" description="This Counterline page is unavailable. Return to the workspace to continue." />
      <div className="setup-card">
        <BrandLink />
        <h1>Page not found</h1>
        <p>This address doesn’t lead to a Counterline page.</p>
        <a className="button button-primary" href="/">Back to workspace <ArrowRight size={16} aria-hidden="true" /></a>
      </div>
    </main>
  }
  return <WorkspaceApp invitationRoute={path === '/auth/accept-invitation'} />
}

function WorkspaceApp({ invitationRoute }: { invitationRoute: boolean }) {
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

  if (demoMode) return invitationRoute
    ? <WorkspaceNotice title="Staff invitation">Open your invitation using your store’s live workspace address.</WorkspaceNotice>
    : <Workspace demo />
  if (!hasSupabaseConfig) return <WorkspaceNotice title="Workspace unavailable">Please try again later or contact your store manager.</WorkspaceNotice>
  if (!authReady) return <div className="auth-loading"><span className="loading-orb" />Checking your session…</div>
  if (!session) return <SignInScreen invited={invitationRoute} error={authError} onSignIn={async (email, password) => {
    if (!supabase) return
    setAuthError('')
    try {
      if (!navigator.onLine) throw new Error()
      const { error } = await supabase.auth.signInWithPassword({ email, password })
      if (error) throw error
    } catch (error) {
      setAuthError(publicError(error, signInFallback))
    }
  }} />
  if (invitationRoute) return <AcceptInvitationScreen accessToken={session.access_token} />
  return <Workspace key={session.user.id} accessToken={session.access_token} onSignOut={async () => {
    const result = await supabase?.auth.signOut({ scope: 'local' })
    if (result?.error) throw result.error
    setSession(null)
  }} />
}

function WorkspaceNotice({ title, children, onSignOut, error }: { title: string; children: ReactNode; onSignOut?: () => void; error?: string }) {
  return <main className="setup-screen">
    <div className="setup-card">
      <PageDetails title={title} description="Get help accessing your Counterline store workspace." />
      <BrandLink />
      <h1>{title}</h1>
      <p>{children}</p>
      {error && <div className="form-error" role="alert">{error}</div>}
      {onSignOut && <button type="button" className="button button-dark" onClick={onSignOut}>Sign out</button>}
    </div>
  </main>
}

function SignInScreen({ onSignIn, error, invited = false }: { onSignIn: (email: string, password: string) => Promise<void>; error: string; invited?: boolean }) {
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [showPassword, setShowPassword] = useState(false)
  const [busy, setBusy] = useState(false)
  const submit = async (event: FormEvent) => {
    event.preventDefault(); setBusy(true)
    try { await onSignIn(email.trim(), password) } finally { setBusy(false) }
  }
  return <main className="signin-screen">
    <PageDetails
      title={invited ? 'Sign in to accept your invitation' : 'Staff sign-in'}
      description={invited ? 'Sign in with your invited email address to activate your store account.' : 'Sign in to your Counterline store workspace to manage job cards and checkout.'}
    />
    <section className="signin-story">
      <div className="story-orbit orbit-a" /><div className="story-orbit orbit-b" />
      <BrandLink light />
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
        <p className="muted">{invited ? 'Sign in with the email address that received the invitation, then continue account setup.' : 'Use the account invited by your store manager.'}</p>
        <form onSubmit={submit} className="signin-form">
          <label>Email address<input type="email" autoComplete="username" autoCapitalize="none" required value={email} onChange={(e) => setEmail(e.target.value)} /></label>
          <div className="password-field">
            <label htmlFor="signin-password">Password</label>
            <div className="password-input">
              <input id="signin-password" type={showPassword ? 'text' : 'password'} autoComplete="current-password" required value={password} onChange={(e) => setPassword(e.target.value)} />
              <button type="button" aria-label={showPassword ? 'Hide password' : 'Show password'} onClick={() => setShowPassword(!showPassword)}>
                {showPassword ? <EyeOff size={18} aria-hidden="true" /> : <Eye size={18} aria-hidden="true" />}
              </button>
            </div>
          </div>
          {error && <div className="form-error" role="alert"><CircleAlert size={16} />{error}</div>}
          <button className="button button-primary button-wide" disabled={busy}>{busy ? 'Signing in…' : 'Sign in'}<ArrowRight size={17} /></button>
        </form>
        <div className="signin-foot"><ShieldCheck size={16} /> Access is limited to your assigned store role.</div>
      </div>
    </section>
  </main>
}

function AcceptInvitationScreen({ accessToken }: { accessToken: string }) {
  const [password, setPassword] = useState('')
  const [confirmPassword, setConfirmPassword] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const invitationId = new URLSearchParams(window.location.search).get('invitation_id') || ''

  const accept = async (event: FormEvent) => {
    event.preventDefault()
    setError('')
    if (!invitationId) { setError('This invitation link is incomplete. Ask your manager to send it again.'); return }
    if (password.length < 8) { setError('Use a password with at least 8 characters.'); return }
    if (password !== confirmPassword) { setError('The passwords do not match.'); return }
    if (!supabase) { setError('Account setup is temporarily unavailable. Try again later.'); return }
    setBusy(true)
    try {
      await apiRequest('/api/staff/invitations/accept', accessToken, {
        method: 'POST', body: JSON.stringify({ invitation_id: invitationId }),
      })
      const { error: passwordError } = await supabase.auth.updateUser({ password })
      if (passwordError) throw passwordError
      window.location.replace('/')
    } catch (e) {
      setError(publicError(e, 'We could not finish account setup. Ask your manager to check the invitation.'))
    } finally { setBusy(false) }
  }

  return <main className="setup-screen"><form className="setup-card" onSubmit={accept}>
    <PageDetails title="Accept staff invitation" description="Set a password and activate your Counterline store account." />
    <BrandLink /><span className="eyebrow">TEAM INVITATION</span><h1>Finish setting up</h1>
    <p>Choose a password to activate your store account. Your manager assigned your role before sending this invitation.</p>
    <label>Password<input type="password" autoComplete="new-password" minLength={8} required value={password} onChange={(e) => setPassword(e.target.value)} /></label>
    <label>Confirm password<input type="password" autoComplete="new-password" minLength={8} required value={confirmPassword} onChange={(e) => setConfirmPassword(e.target.value)} /></label>
    {error && <div className="form-error" role="alert"><CircleAlert size={16} />{error}</div>}
    <button className="button button-primary button-wide" disabled={busy}>{busy ? 'Activating account…' : 'Activate account'}<ArrowRight size={16} /></button>
  </form></main>
}

function Workspace({ demo = false, accessToken, onSignOut }: { demo?: boolean; accessToken?: string; onSignOut?: () => Promise<void> }) {
  const [jobs, setJobs] = useState<Job[]>(demo ? loadDemoJobs() : [])
  const [products, setProducts] = useState<CatalogProduct[]>(demo ? demoProducts : [])
  const [charges, setCharges] = useState<CatalogCharge[]>(demo ? demoCharges : [])
  const [store, setStore] = useState<StoreMembership | null>(null)
  const [setupNeeded, setSetupNeeded] = useState(false)
  const [noAccess, setNoAccess] = useState(false)
  const [loading, setLoading] = useState(!demo)
  const [loadError, setLoadError] = useState('')
  const [signOutError, setSignOutError] = useState('')
  const [activeNav, setActiveNav] = useState<NavKey>('overview')
  const [queueFilter, setQueueFilter] = useState<QueueFilter>('open')
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [jobTrigger, setJobTrigger] = useState<HTMLButtonElement | null>(null)
  const [search, setSearch] = useState('')
  const [role, setRole] = useState<StaffRole>('manager')
  const currentRole = demo ? role : store?.role
  const focusedJobView = currentRole === 'cashier' || currentRole === 'manager' || currentRole === 'owner' || currentRole === 'admin'
  const permissions = demo ? rolePermissions[role] : store?.permissions ?? []
  const [members, setMembers] = useState<Array<{ id: string; name: string; role: string }>>(
    demo ? [{ id: 'demo-rohan', name: 'Rohan K.', role: 'salesperson' }, { id: 'demo-dev', name: 'Dev · JBL', role: 'promoter' }, { id: 'demo-sara', name: 'Sara M.', role: 'cashier' }] : [],
  )
  const [newJobOpen, setNewJobOpen] = useState(false)
  const [jobOpenedByPointer, setJobOpenedByPointer] = useState(false)
  const [editingJob, setEditingJob] = useState<Job | null>(null)
  const [mobileDetailOpen, setMobileDetailOpen] = useState(false)
  const [toast, setToast] = useState<{ message: string; kind: ToastKind; visible: boolean } | null>(null)
  const toastTimers = useRef<number[]>([])
  const [updateReady, setUpdateReady] = useState(false)
  const [now, setNow] = useState(() => new Date())
  const { greeting, date } = storeClock(now, demo ? 'Asia/Kolkata' : store?.store?.timezone)
  const [moreOpen, setMoreOpen] = useState(false)
  const moreTrigger = useRef<HTMLButtonElement>(null)
  const morePanel = useRef<HTMLDivElement>(null)
  const landingStore = useRef<string | null>(null)

  useEffect(() => {
    const update = () => { if (!document.hidden) setNow(new Date()) }
    const interval = window.setInterval(update, 60_000)
    document.addEventListener('visibilitychange', update)
    return () => {
      window.clearInterval(interval)
      document.removeEventListener('visibilitychange', update)
    }
  }, [])

  useEffect(() => {
    if (!moreOpen) return
    morePanel.current?.querySelector('button')?.focus()
    const dismiss = (event: PointerEvent) => {
      const target = event.target as Node
      if (!moreTrigger.current?.contains(target) && !morePanel.current?.contains(target)) setMoreOpen(false)
    }
    document.addEventListener('pointerdown', dismiss)
    return () => document.removeEventListener('pointerdown', dismiss)
  }, [moreOpen])

  useEffect(() => {
    const announce = () => setUpdateReady(true)
    window.addEventListener('counterline:update-available', announce)
    return () => window.removeEventListener('counterline:update-available', announce)
  }, [])

  useEffect(() => () => { toastTimers.current.forEach(window.clearTimeout) }, [])

  useEffect(() => {
    if (!demo) return
    localStorage.setItem(demoJobsKey, JSON.stringify(jobs))
  }, [demo, jobs])

  const reload = useCallback(async (storeId?: string) => {
    if (!accessToken) return
    try {
      const sessionInfo = await apiRequest<SessionResponse>('/api/session', accessToken)
      setLoadError('')
      if (sessionInfo.stores.length === 0) {
        setStore(null)
        setJobs([])
        setSetupNeeded(sessionInfo.can_initialize_store === true)
        setNoAccess(sessionInfo.can_initialize_store !== true)
        return
      }
      const selectedStore = sessionInfo.stores.find((item) => item.store_id === storeId) || sessionInfo.stores[0]
      setNoAccess(false)
      setSetupNeeded(false)
      setStore(selectedStore)
      const canCheckout = hasPermission(selectedStore.permissions, 'jobs.checkout', selectedStore.deny_permissions)
      if (landingStore.current !== selectedStore.store_id) {
        landingStore.current = selectedStore.store_id
        const checkoutFirst = selectedStore.role === 'cashier' && canCheckout
        setActiveNav(checkoutFirst ? 'checkout' : 'overview')
        setQueueFilter(checkoutFirst ? 'all' : 'open')
      } else {
        const canManage = hasPermission(selectedStore.permissions, 'staff.manage', selectedStore.deny_permissions)
        const canReadCatalog = hasPermission(selectedStore.permissions, 'catalog.read', selectedStore.deny_permissions)
        setActiveNav((current) => (current === 'team' && !canManage) || (current === 'checkout' && !canCheckout)
          || (current === 'catalog' && !canReadCatalog) || (current === 'sales' && !canViewSales(selectedStore.role)) ? 'overview' : current)
      }
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
      setProducts(catalog.products.map((item) => ({ id: item.id, name: item.name, brand: item.brand || '', sku: item.sku || '', unitPriceMinor: Number(item.default_unit_price_minor) })))
      setCharges(catalog.charges.map((item) => ({ id: item.id, name: item.name, amountMinor: Number(item.default_amount_minor) })))
      setMembers(staffRows.filter((item) => item.status === 'active').map((item) => ({ id: item.user_id, name: item.display_name || item.role, role: item.role })))
    } catch (error) {
      setLoadError(publicError(error, 'We couldn’t load your workspace. Try again.'))
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

  const can = (permission: string) => hasPermission(permissions, permission, store?.deny_permissions)
  const showCustomerPhones = can('customers.read_phone')
  const effectiveFilter = activeNav !== 'checkout' && (queueFilter === 'ready' || queueFilter === 'checkout') ? 'open' : queueFilter
  const visibleJobs = useMemo(() => {
    let result = [...jobs]
    if (activeNav === 'checkout') result = result.filter((job) => job.status === 'ready' || job.status === 'checkout')
    if (effectiveFilter === 'open') result = result.filter((job) => job.status !== 'completed' && job.status !== 'cancelled')
    else if (effectiveFilter !== 'all') result = result.filter((job) => job.status === effectiveFilter)
    if (search.trim()) {
      const query = search.toLowerCase()
      result = result.filter((job) => job.customerName.toLowerCase().includes(query) || showCustomerPhones && job.customerPhone?.includes(query) || String(job.jobNumber).includes(query))
    }
    return result.sort((a, b) => b.createdAt.localeCompare(a.createdAt))
  }, [jobs, activeNav, effectiveFilter, search, showCustomerPhones])
  const selected = (focusedJobView ? jobs : visibleJobs).find((job) => job.id === selectedId) || null

  useEffect(() => {
    if (!selectedId || selected || (!focusedJobView && activeNav !== 'overview' && activeNav !== 'checkout')) return
    setSelectedId(null)
    setMobileDetailOpen(false)
  }, [activeNav, focusedJobView, selected, selectedId])

  const navigate = (view: NavKey) => {
    setActiveNav(view)
    setQueueFilter(view === 'checkout' ? 'all' : 'open')
    setSearch('')
    setSelectedId(null)
    setMobileDetailOpen(false)
    setMoreOpen(false)
  }

  const selectJob = (id: string, trigger?: HTMLButtonElement) => {
    setSelectedId(id)
    if (focusedJobView) setJobTrigger(trigger ?? null)
    else setMobileDetailOpen(true)
  }

  const openJob = (id: string, trigger?: HTMLButtonElement) => {
    if (!focusedJobView) {
      navigate('overview')
      setQueueFilter('all')
    }
    selectJob(id, trigger)
  }

  const showToast = (message: string, kind: ToastKind = 'success') => {
    toastTimers.current.forEach(window.clearTimeout)
    toastTimers.current = []
    setToast({ message, kind, visible: true })
    toastTimers.current.push(window.setTimeout(() => {
      setToast((current) => current ? { ...current, visible: false } : null)
      toastTimers.current.push(window.setTimeout(() => setToast(null), 170))
    }, kind === 'error' ? 6000 : 3000))
  }

  const updateDemoJob = (id: string, updater: (job: Job) => Job) => setJobs((current) => current.map((job) => job.id === id ? { ...updater(job), version: (job.version || 1) + 1 } : job))

  const lookupCustomer = async (phone: string, offset: number): Promise<CustomerLookup> => {
    if (demo) {
      const matches = jobs.filter((job) => job.customerPhone === phone).sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      const named = matches.find((job) => job.customerName !== 'Customer' && job.customerName.trim())
      const completed = matches.filter((job) => job.status === 'completed')
      const active = matches.find((job) => ['ready', 'checkout', 'returned'].includes(job.status))
      const end = offset + (offset === 0 ? 3 : 12)
      return {
        customer: matches.length ? { id: phone, display_name: named?.customerName || null } : null,
        visits: completed.slice(offset, end).map(demoVisit),
        active_job: offset === 0 && active ? demoVisit(active) : null,
        next_offset: completed.length > end ? end : null,
      }
    }
    if (!accessToken || !store) throw new Error('Store unavailable')
    return apiRequest<CustomerLookup>('/api/customers/lookup', accessToken, {
      method: 'POST', body: JSON.stringify({ store_id: store.store_id, phone, offset }),
    })
  }

  const loadVisit = async (customerId: string, visitId: string): Promise<VisitDetail> => {
    if (demo) {
      const job = jobs.find((item) => item.id === visitId && item.customerPhone === customerId)
      if (job) return demoVisit(job)
    }
    if (!accessToken || !store) throw new Error('Visit unavailable')
    return apiRequest<VisitDetail>(`/api/customers/${customerId}/visits/${visitId}?store_id=${store.store_id}`, accessToken)
  }

  const lookupRecipient = async (phone: string): Promise<string | null> => {
    if (demo) return jobs.find((job) => job.customerPhone === phone && job.customerName !== 'Customer')?.customerName || null
    if (!accessToken || !store) throw new Error('Store unavailable')
    const result = await apiRequest<{ name: string | null }>('/api/customers/recipient-lookup', accessToken, {
      method: 'POST', body: JSON.stringify({ store_id: store.store_id, phone }),
    })
    return result.name
  }

  const invoiceStoreId = store?.store_id
  const loadLatestInvoice = useCallback(async (): Promise<string | null> => {
    if (demo) {
      const previous = jobs.filter((job) => job.invoiceReference).sort((a, b) => (b.invoiceRecordedAt || b.createdAt).localeCompare(a.invoiceRecordedAt || a.createdAt))[0]
      return previous?.invoiceReference || null
    }
    if (!accessToken || !invoiceStoreId) throw new Error('Store unavailable')
    const result = await apiRequest<{ reference: string | null }>(`/api/billing/latest-invoice?store_id=${invoiceStoreId}`, accessToken)
    return result.reference
  }, [demo, jobs, accessToken, invoiceStoreId])

  const createJob = async (input: JobCardInput) => {
    const attribution = {
      accompanying_count: input.accompanyingCount,
      reward_recipients: input.rewardRecipients.map(({ role, phone, name, savedKey }) => ({ role, phone, name, saved_key: savedKey })),
      submission_key: input.submissionKey,
    }
    const demoRecipients = demo ? input.rewardRecipients.map((recipient) => ({
      ...recipient,
      name: jobs.find((job) => job.customerPhone === recipient.phone && job.customerName !== 'Customer')?.customerName || recipient.name,
    })) : []
    if (demoRecipients.some((recipient) => !recipient.name)) return 'Enter a name for each recipient without a saved name.'
    if (input.jobId && (demo || input.version)) {
      if (demo) {
        updateDemoJob(input.jobId, (current) => ({ ...current, lines: input.lines, charges: input.charges, contributors: input.contributors.map((member) => members.find((candidate) => candidate.id === member.user_id)?.name || 'Team member'), note: input.note || undefined, correctionReason: undefined, status: 'ready', accompanyingCount: input.accompanyingCount, rewardRecipients: demoRecipients }))
      } else {
        if (!accessToken || !store) throw new Error('Store unavailable')
        await apiRequest<ApiJob>(`/api/jobs/${input.jobId}`, accessToken, {
          method: 'PATCH', body: JSON.stringify({
            store_id: store.store_id, expected_version: input.version,
            lines: input.lines.map((line, index) => ({ product_id: line.id.startsWith('custom-') ? null : line.id, label: line.label, sku: line.sku || null, quantity: line.quantity, unit_price_minor: line.unitPriceMinor, sort_order: index })),
            charges: input.charges.map((charge, index) => ({ charge_id: charge.id.startsWith('custom-') ? null : charge.id, name: charge.name, quantity: charge.quantity, unit_amount_minor: charge.unitAmountMinor, sort_order: index })),
            contributors: input.contributors, staff_note: input.note || null, ...attribution,
          }),
        })
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
        charges: input.charges, note: input.note || undefined, payments: [], accompanyingCount: input.accompanyingCount, rewardRecipients: demoRecipients,
      }
      setJobs((current) => [newJob, ...current]); openJob(newJob.id)
      setEditingJob(null); setNewJobOpen(false); showToast(`Job #${nextNumber} sent to checkout`); return
    }
    if (!accessToken || !store) throw new Error('Store unavailable')
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
        ...attribution,
      }),
    })
    await reload(store.store_id)
    openJob(created.id); setEditingJob(null); setNewJobOpen(false); showToast(`Job #${created.job_number} sent to checkout`)
  }

  const transition = async (job: Job, toStatus: JobStatus, reason?: string) => {
    if (demo) {
      updateDemoJob(job.id, (current) => ({ ...current, status: toStatus, correctionReason: toStatus === 'returned' ? reason : undefined }))
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
      const recordedAt = new Date().toISOString()
      updateDemoJob(job.id, (current) => ({
        ...current,
        invoiceReference: reference,
        invoiceRecordedAt: recordedAt,
        invoiceFirstRecordedAt: current.invoiceFirstRecordedAt ?? current.invoiceRecordedAt ?? (current.invoiceReference ? current.createdAt : recordedAt),
        finalBilledTotalMinor: totalMinor,
        discrepancyReason: reason || undefined,
      }))
      showToast('Final bill total saved'); return
    }
    if (!accessToken || !store) return
    await apiRequest(`/api/jobs/${job.id}/invoice`, accessToken, {
      method: 'POST', body: JSON.stringify({ store_id: store.store_id, invoice_reference: reference, final_total_minor: totalMinor, discrepancy_reason: reason || null }),
    })
    await reload(store.store_id); showToast('Invoice details saved')
  }

  const startNewJob = (event: React.MouseEvent<HTMLButtonElement>) => {
    if (!can('jobs.create') || !can('jobs.submit')) { showToast('Your role cannot send jobs to checkout', 'error'); return }
    setEditingJob(null)
    setJobOpenedByPointer(event.detail > 0)
    setNewJobOpen(true)
  }

  const startEditJob = (job: Job, pointer: boolean) => {
    if (!can('jobs.submit') || (!can('jobs.edit_own') && !can('jobs.edit_store'))) { showToast('Your role cannot edit and submit this job', 'error'); return }
    setEditingJob(job)
    setJobOpenedByPointer(pointer)
    setNewJobOpen(true)
  }

  const primaryNav = [
    { key: 'overview' as const, label: 'Jobs', icon: Home },
    ...(can('jobs.checkout') ? [{ key: 'checkout' as const, label: 'Checkout', icon: ClipboardList }] : []),
  ]
  const secondaryNav = [
    { key: 'customers' as const, label: 'Customers', icon: Users },
    ...(can('catalog.read') ? [{ key: 'catalog' as const, label: 'Catalog & charges', icon: Package }] : []),
    ...(canViewSales(currentRole) ? [{ key: 'sales' as const, label: 'Sales reports', icon: ChartColumn }] : []),
    ...(can('staff.manage') ? [{ key: 'team' as const, label: 'Team Access', icon: ShieldCheck }] : []),
  ]
  const secondaryDestination = secondaryNav.find((item) => item.key === activeNav)
  const queueTitle = activeNav === 'checkout' ? 'Checkout' : currentRole === 'salesperson' ? 'My jobs' : currentRole === 'promoter' ? 'Assigned jobs' : 'Store jobs'
  const filters: QueueFilter[] = activeNav === 'checkout' ? ['all', 'ready', 'checkout'] : ['open', 'returned', 'completed', 'all']
  const staffName = demo ? 'Anika Sharma' : store?.display_name?.trim()
  const closeMore = () => {
    setMoreOpen(false)
    moreTrigger.current?.focus()
  }
  const signOut = async () => {
    setSignOutError('')
    try {
      await onSignOut?.()
    } catch (error) {
      setSignOutError(publicError(error, 'We couldn’t sign you out. Try again.'))
    }
  }

  const goHome = (event: React.MouseEvent<HTMLAnchorElement>) => {
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return
    event.preventDefault()
    navigate('overview')
    window.scrollTo(0, 0)
  }
  const applyUpdate = async () => {
    try {
      const registration = await navigator.serviceWorker?.getRegistration()
      if (registration?.waiting) registration.waiting.postMessage({ type: 'SKIP_WAITING' })
      else window.location.reload()
    } catch {
      showToast('The update couldn’t be applied. Try reloading the page.', 'error')
    }
  }

  if (noAccess) return <WorkspaceNotice title="Workspace access unavailable" error={signOutError} onSignOut={signOut}>You don’t have access to this workspace. Ask your store manager for help.</WorkspaceNotice>
  if (setupNeeded) return <StoreSetup onComplete={async (storeName) => {
    if (!accessToken) return
    await apiRequest('/api/setup/store', accessToken, { method: 'POST', body: JSON.stringify({ store_name: storeName }) })
    setSetupNeeded(false)
    await reload()
    showToast('Store workspace created')
  }} />

  const detail = selected && <JobDetail key={`${selected.id}-${selected.status}-${selected.version || 1}-${selected.payments.length}-${selected.invoiceReference || ''}`}
    job={selected} can={can} focused={focusedJobView} onEdit={startEditJob}
    onClose={() => focusedJobView ? setSelectedId(null) : setMobileDetailOpen(false)}
    onTransition={transition} onAddPayment={addPayment} onConfirmUpi={confirmUpi} onSaveInvoice={saveInvoice}
    loadLatestInvoice={loadLatestInvoice} toast={showToast}
  />
  const feedback = toast && <div className="toast-message" data-kind={toast.kind} data-visible={toast.visible} role={toast.kind === 'error' ? 'alert' : 'status'}>
    {toast.kind === 'error' ? <CircleAlert size={17} aria-hidden="true" /> : <CheckCircle2 size={17} aria-hidden="true" />}
    {toast.message}
  </div>

  return <div className={`app-shell ${demo ? 'is-demo' : ''}`}>
    <PageDetails {...workspacePages[activeNav]} title={activeNav === 'overview' ? queueTitle : workspacePages[activeNav].title} />
    <aside className="sidebar">
      <a className="brand-lockup" href="/" onClick={goHome} aria-label="Counterline home"><BrandMark compact /><strong>counterline</strong></a>
      <nav className="primary-nav" aria-label="Main navigation" onKeyDown={(event) => {
        if (event.key === 'Escape' && moreOpen) { event.stopPropagation(); closeMore() }
      }}>
        {primaryNav.map(({ key, label, icon: Icon }) => <button key={key} className={`nav-item ${activeNav === key ? 'active' : ''}`} aria-label={label} aria-current={activeNav === key ? 'page' : undefined} onClick={() => navigate(key)} type="button">
          <Icon size={18} aria-hidden="true" /><span>{label}</span>
        </button>)}
        <button ref={moreTrigger} className={`nav-item ${secondaryDestination ? 'active' : ''}`} aria-label="Workspace menu" aria-expanded={moreOpen} aria-controls="workspace-more" onClick={() => moreOpen ? closeMore() : setMoreOpen(true)} type="button">
          <Menu size={18} aria-hidden="true" /><span>Menu</span>
        </button>
        <div ref={morePanel} id="workspace-more" className="workspace-more" hidden={!moreOpen} onBlur={(event) => {
          if (!event.currentTarget.contains(event.relatedTarget) && event.relatedTarget !== moreTrigger.current) setMoreOpen(false)
        }}>
          {secondaryNav.map(({ key, label, icon: Icon }) => <button key={key} type="button" aria-current={activeNav === key ? 'page' : undefined} onClick={() => { navigate(key); moreTrigger.current?.focus() }}>
            <Icon size={16} aria-hidden="true" />{label}
          </button>)}
          {demo ? <label>Demo role<select value={role} onChange={(event) => {
            const nextRole = event.target.value as StaffRole
            setRole(nextRole)
            navigate(nextRole === 'cashier' ? 'checkout' : 'overview')
            moreTrigger.current?.focus()
          }}><option value="manager">Manager</option><option value="cashier">Cashier</option><option value="salesperson">Salesperson</option></select></label>
            : <button type="button" onClick={() => void signOut()}>Sign out</button>}
          {signOutError && <div className="form-error" role="alert">{signOutError}</div>}
        </div>
      </nav>
    </aside>

    <div className="workspace-main">
      <header className="topbar">
        <a className="mobile-brand" href="/" onClick={goHome} aria-label="Counterline home"><BrandMark compact /><strong>counterline</strong></a>
        <div className="workspace-store">{store?.store?.name || (demo ? 'Mango Mobile' : 'Workspace')}</div>
        <div className="topbar-actions">
          {demo && <span className="demo-pill">Demo</span>}
          {updateReady && <button className="update-available" type="button" onClick={applyUpdate}>Update ready · Reload</button>}
        </div>
      </header>

      {loadError && !demo && <div className="load-error" role="alert"><CircleAlert size={16} />{loadError}<button type="button" onClick={() => void reload(store?.store_id)}>Retry</button></div>}
      {loading && !demo ? <div className="page-loading"><span className="loading-orb" />Loading your store…</div> : activeNav === 'customers' ? <CustomerBook jobs={jobs} showPhones={can('customers.read_phone')} onSelect={(job, trigger) => openJob(job.id, trigger)} /> : activeNav === 'catalog' ? <CatalogPage products={products} charges={charges} /> : activeNav === 'team' && can('staff.manage') ? <TeamPage demo={demo} storeId={store?.store_id || ''} accessToken={accessToken || ''} role={store?.role || ''} notify={showToast} /> : activeNav === 'sales' && canViewSales(currentRole) ? (
        <SalesReports key={store?.store_id || 'demo'} storeId={store?.store_id || ''} accessToken={accessToken || ''}
          timeZone={demo ? 'Asia/Kolkata' : store?.store?.timezone || 'UTC'} now={now} demoJobs={demo ? jobs : undefined} />
      ) : (
        <main className={`main-grid ${focusedJobView ? 'queue-only' : ''}`}>
          <section className="content-column">
            <div className="page-heading">
              <div><p className="queue-greeting">{greeting}{staffName ? ', ' + staffName : ''} · {date}</p><h1>{queueTitle}</h1></div>
              {can('jobs.create') && can('jobs.submit') && <button className="button button-primary new-job-button" onClick={startNewJob}><Plus size={18} /><span>New job</span></button>}
            </div>

            <section className="queue-card" aria-label={queueTitle}>
              <div className="queue-header">
                <div className="queue-toolbar">
                  <label className="search-box"><Search size={16} aria-hidden="true" /><input id="job-search" aria-label="Search jobs" type="search" value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Search jobs" /></label>
                  <div className="filter-tabs" role="group" aria-label="Filter jobs">
                    {filters.map((filter) => <button type="button" aria-pressed={effectiveFilter === filter} className={effectiveFilter === filter ? 'selected' : ''} key={filter} onClick={() => setQueueFilter(filter)}>{filterLabels[filter]}</button>)}
                  </div>
                </div>
              </div>

              <div className="queue-list">
                {visibleJobs.length === 0 ? <div className="empty-queue"><strong>{search.trim() ? "No matching jobs" : "No jobs in this view"}</strong></div> : visibleJobs.map((job, index) => <JobRow key={job.id} job={job} selected={selectedId === job.id} opensDialog={focusedJobView} onClick={(event) => selectJob(job.id, event.currentTarget)} index={index} />)}
              </div>
            </section>
          </section>

          {!focusedJobView && <aside className={`detail-column ${mobileDetailOpen ? 'mobile-open' : ''}`}>
            {detail || <div className="detail-empty"><div className="detail-empty-icon"><ClipboardList size={22} /></div><strong>Select a job</strong><span>Choose a job from the queue to see its full handoff.</span></div>}
          </aside>}
        </main>
      )}

      <footer className="app-footer">
        <span>© {now.getFullYear()} Counterline</span>
        <nav aria-label="Footer">
          <a href="/" onClick={goHome}>Workspace home</a>
          {supportPhone && validPhone(normalizePhone(supportPhone)) && <PhoneLink phone={supportPhone} />}
          {supportEmail && <EmailLink email={supportEmail} />}
        </nav>
      </footer>
    </div>

    {focusedJobView && selected ? <FocusedJobDialog key={selected.id} trigger={jobTrigger} onClose={() => setSelectedId(null)}>{detail}{feedback}</FocusedJobDialog> : feedback}
    {newJobOpen && <NewJobDialog key={editingJob?.id || 'new'} products={products} charges={charges} members={members} demo={demo} pointer={jobOpenedByPointer} timeZone={store?.store?.timezone} existingJob={editingJob || undefined} onClose={() => { setNewJobOpen(false); setEditingJob(null) }} onSubmit={createJob} lookupCustomer={lookupCustomer} lookupRecipient={lookupRecipient} loadVisit={loadVisit} showPhones={can('customers.read_phone')} />}
  </div>
}

function BrandLink({ light }: { light?: boolean }) {
  return <a className="brand-link" href="/" aria-label="Counterline home"><BrandMark light={light} /></a>
}

function PhoneLink({ phone }: { phone: string }) {
  const number = normalizePhone(phone)
  return validPhone(number)
    ? <a className="contact-link" href={`tel:${number}`}>{displayCustomerPhone(number)}</a>
    : <span>{phone}</span>
}

function EmailLink({ email }: { email: string }) {
  return <a className="contact-link" href={`mailto:${encodeURIComponent(email).replace('%40', '@')}`}>{email}</a>
}

function BrandMark({ compact, light }: { compact?: boolean; light?: boolean }) {
  return <span className={`brand-mark ${compact ? 'brand-mark-small' : ''} ${light ? 'brand-mark-light' : ''}`} aria-hidden="true"><span /><span /><span /><i /></span>
}

function JobRow({ job, selected, opensDialog, onClick, index }: { job: Job; selected: boolean; opensDialog: boolean; onClick: React.MouseEventHandler<HTMLButtonElement>; index: number }) {
  const quote = jobQuote(job)
  return <button className={`job-row ${selected ? 'selected' : ''}`} onClick={onClick} type="button" aria-haspopup={opensDialog ? 'dialog' : undefined} style={{ '--row-index': index } as CSSProperties}>
    <div className="row-avatar-wrap"><span className={`avatar customer-avatar color-${index % 5}`}>{job.customerName.split(' ').map((part) => part[0]).slice(0, 2).join('')}</span><span className={`row-status-dot ${job.status}`} /></div>
    <div className="row-main"><div className="row-name-line"><strong>{job.customerName}</strong><span className={`status-pill ${job.status}`}>{job.status === 'ready' ? 'Ready' : job.status === 'checkout' ? 'At counter' : job.status === 'returned' ? 'Correction' : job.status === 'completed' ? 'Complete' : statusText[job.status]}</span></div><span className="row-description">{job.lines.length} {job.lines.length === 1 ? 'item' : 'items'} <i>·</i> {job.lines.slice(0, 2).map((line) => line.label.split(' · ')[0]).join(', ')}</span><div className="row-meta"><span className="job-number">#{job.jobNumber}</span><span>{job.owner}</span><span className="meta-time"><Clock3 size={12} />{job.timeLabel}</span></div></div>
    <div className="row-total"><strong>{formatMoney(quote)}</strong><span>QUOTE</span></div><ChevronRight className="row-chevron" size={16} />
  </button>
}

function FocusedJobDialog({ trigger, onClose, children }: { trigger: HTMLButtonElement | null; onClose: () => void; children: ReactNode }) {
  const dialog = useRef<HTMLDialogElement>(null)

  useLayoutEffect(() => {
    const element = dialog.current
    if (!element) return
    element.showModal()
    element.querySelector<HTMLElement>('#focused-job-title')?.focus()
    return () => {
      element.close()
      queueMicrotask(() => {
        if (element.open) return
        if (trigger?.isConnected) trigger.focus()
        else document.getElementById('job-search')?.focus()
      })
    }
  }, [trigger])

  return <dialog ref={dialog} className="focused-job-card" aria-labelledby="focused-job-title" onCancel={(event) => {
    event.preventDefault()
    onClose()
  }}>{children}</dialog>
}

function incrementInvoice(reference: string | null) {
  const match = reference?.match(/^(.*?)(\d+)$/)
  if (!match) return ''
  const [, prefix, digits] = match
  return prefix + String(BigInt(digits) + 1n).padStart(digits.length, '0')
}

function JobDetail({ job, can, focused, onEdit, onClose, onTransition, onAddPayment, onConfirmUpi, onSaveInvoice, loadLatestInvoice, toast }: {
  job: Job; can: (permission: string) => boolean; onClose: () => void
  focused: boolean
  onEdit: (job: Job, pointer: boolean) => void
  onTransition: (job: Job, status: JobStatus, reason?: string) => Promise<void>
  onAddPayment: (job: Job, method: 'cash' | 'upi', amountMinor: number, reference?: string) => Promise<void>
  onConfirmUpi: (job: Job, paymentId: string, reference: string) => Promise<void>
  onSaveInvoice: (job: Job, reference: string, totalMinor: number, reason: string) => Promise<void>
  loadLatestInvoice: () => Promise<string | null>
  toast: (message: string, kind?: ToastKind) => void
}) {
  const quote = jobQuote(job)
  const confirmed = totalConfirmed(job)
  const outstanding = Math.max(0, (job.finalBilledTotalMinor ?? quote) - confirmed)
  const [paymentAmount, setPaymentAmount] = useState(outstanding ? (outstanding / 100).toFixed(2).replace(/\.00$/, '') : '')
  const [paymentMethod, setPaymentMethod] = useState<'cash' | 'upi'>(() => can('payments.record_cash') ? 'cash' : 'upi')
  const [upiRef, setUpiRef] = useState('')
  const [paymentRefs, setPaymentRefs] = useState<Record<string, string>>({})
  const [invoiceRef, setInvoiceRef] = useState(job.invoiceReference || '')
  const invoiceEdited = useRef(false)
  const [finalTotal, setFinalTotal] = useState(String((job.finalBilledTotalMinor ?? quote) / 100))
  const [discrepancyReason, setDiscrepancyReason] = useState(job.discrepancyReason || '')
  const [returnReason, setReturnReason] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [invoiceFormOpen, setInvoiceFormOpen] = useState(!job.invoiceReference && job.status === 'checkout')
  const [paymentFormOpen, setPaymentFormOpen] = useState(false)
  const [manualCopy, setManualCopy] = useState(false)
  const manualCopyField = useRef<HTMLTextAreaElement>(null)
  const title = useRef<HTMLHeadingElement>(null)
  const errorNotice = useRef<HTMLDivElement>(null)
  const canRecordBill = can('billing.record')
  const canReadPhone = can('customers.read_phone')
  const showPhone = canReadPhone && job.customerPhone
  const recipients = focused && (can('jobs.edit_store') || can('jobs.edit_own')) ? job.rewardRecipients ?? [] : []

  useLayoutEffect(() => {
    const element = title.current
    if (element?.closest('dialog')?.open && document.activeElement === document.body) element.focus({ preventScroll: true })
  }, [])

  useEffect(() => {
    if (!manualCopy) return
    manualCopyField.current?.focus()
    manualCopyField.current?.select()
  }, [manualCopy])

  useEffect(() => {
    if (error) errorNotice.current?.focus()
  }, [error])

  useEffect(() => {
    if (!invoiceFormOpen || !canRecordBill || job.status !== 'checkout' || job.invoiceReference || invoiceEdited.current) return
    let current = true
    void loadLatestInvoice().then((reference) => {
      if (current && !invoiceEdited.current) setInvoiceRef(incrementInvoice(reference))
    }).catch(() => { /* Manual entry remains available. */ })
    return () => { current = false }
  }, [invoiceFormOpen, canRecordBill, job.status, job.invoiceReference, loadLatestInvoice])

  const handoffText = () => {
    const lines = [
      `JOB #${job.jobNumber}`,
      focused ? `Status: ${statusText[job.status]}` : '',
      `Customer: ${job.customerName}`,
      showPhone ? `Phone: ${showPhone}` : '',
      `Sales owner: ${job.owner}`,
      job.contributors.length ? `Contributors: ${job.contributors.join(', ')}` : '',
      'ITEMS',
      ...job.lines.map((line) => `${line.quantity} x ${line.label}${line.sku ? ` (${line.sku})` : ''}${focused ? ` @ ${formatMoney(line.unitPriceMinor)}` : ''} — ${formatMoney(line.quantity * line.unitPriceMinor)}`),
      ...job.charges.map((charge) => `${charge.quantity} x ${charge.name}${focused ? ` @ ${formatMoney(charge.unitAmountMinor)}` : ''} — ${formatMoney(charge.quantity * charge.unitAmountMinor)}`),
      `QUOTE TOTAL: ${formatMoney(quote)}`,
      !focused || !job.invoiceReference ? 'Final tax and bill amount: enter from billing software.' : '',
      job.note ? `Note: ${job.note}` : '',
    ]
    if (focused) {
      if (job.correctionReason) lines.push(`Correction: ${job.correctionReason}`)
      if (job.accompanyingCount != null) lines.push(`Accompanying customers: ${job.accompanyingCount}`)
      for (const recipient of recipients) {
        lines.push(`${recipient.role === 'companion' ? 'Companion' : 'Referrer'}: ${recipient.name}${canReadPhone && recipient.phone ? ` (${recipient.phone})` : ''}`)
      }
      if (job.invoiceReference) lines.push(`Invoice: ${job.invoiceReference}`)
      if (job.finalBilledTotalMinor != null) lines.push(`Final bill: ${formatMoney(job.finalBilledTotalMinor)}`)
      if (job.discrepancyReason) lines.push(`Bill difference: ${job.discrepancyReason}`)
      for (const payment of job.payments) {
        lines.push(`${payment.method === 'cash' ? 'Cash' : 'UPI'}: ${formatMoney(payment.amountMinor)} (${payment.status})${payment.reference ? ` · ${payment.reference}` : ''}`)
      }
    }
    return lines.filter(Boolean).join('\n')
  }

  const copyHandoff = async () => {
    try {
      await navigator.clipboard.writeText(handoffText())
      setManualCopy(false)
      toast(focused ? 'Job details copied' : 'Job summary copied for billing')
    } catch {
      if (focused) {
        setManualCopy(true)
        manualCopyField.current?.focus()
        manualCopyField.current?.select()
      } else toast('Couldn’t copy the job summary. Check your browser’s clipboard permissions and try again.', 'error')
    }
  }

  const run = async (action: () => Promise<void>) => {
    setBusy(true); setError('')
    try { await action() } catch (e) { setError(publicError(e, 'We couldn’t complete that action. Try again.')) }
    finally { setBusy(false) }
  }

  const addPayment = (event: FormEvent) => {
    event.preventDefault()
    const amountMinor = Math.round(Number(paymentAmount) * 100)
    if (!Number.isFinite(amountMinor) || amountMinor <= 0) { setError('Enter an amount greater than ₹0.'); return }
    void run(() => onAddPayment(job, paymentMethod, amountMinor, paymentMethod === 'upi' ? upiRef : undefined))
  }

  const submitInvoice = (event: FormEvent) => {
    event.preventDefault()
    const totalMinor = Math.round(Number(finalTotal) * 100)
    if (!invoiceRef.trim()) { setError('Enter the invoice reference from your billing software.'); return }
    if (!finalTotal.trim() || !Number.isFinite(totalMinor) || totalMinor < 0) { setError('Enter the final bill total.'); return }
    if (totalMinor !== quote && !can('billing.approve_discrepancy')) { setError('Ask a manager to approve and save a bill total that differs from the quote.'); return }
    if (totalMinor !== quote && !discrepancyReason.trim()) { setError('Add a reason for the difference from the quote.'); return }
    void run(async () => {
      await onSaveInvoice(job, invoiceRef.trim(), totalMinor, discrepancyReason)
      setInvoiceFormOpen(false)
    })
  }

  return <div className="detail-panel">
    {focused ? <header className="detail-head">
      <div className="detail-job-title">
        <h2 id="focused-job-title" ref={title} tabIndex={-1}>Job #{job.jobNumber}</h2>
        <span className={`status-pill ${job.status}`}>{statusText[job.status]}</span>
      </div>
      <div className="detail-head-actions">
        <button type="button" className="button button-primary" onClick={() => void copyHandoff()}><Copy size={16} aria-hidden="true" /> Copy details</button>
        <button type="button" className="icon-button" onClick={onClose} aria-label="Close job card"><X size={20} aria-hidden="true" /></button>
      </div>
    </header> : <div className="detail-head"><div><span className="eyebrow">JOB CARD</span><div className="detail-job-title"><h2>#{job.jobNumber}</h2><span className={`status-pill ${job.status}`}>{statusText[job.status]}</span></div></div><div className="detail-head-actions"><button className="icon-button mobile-detail-back" onClick={onClose} aria-label="Back to queue"><ArrowRight className="back-arrow" size={18} /></button></div></div>}
    <div className="detail-scroll">
      {manualCopy && <div className="manual-job-copy">
        <label htmlFor="manual-job-details" role="status">Clipboard access is unavailable. Copy the selected text below.</label>
        <textarea id="manual-job-details" readOnly rows={5} ref={manualCopyField} value={handoffText()} />
      </div>}
      <div className="job-sale-details">
        {job.correctionReason && job.status === 'returned' && <div className="correction-banner"><CircleAlert size={16} /><div><strong>Cashier note</strong><span>{job.correctionReason}</span></div></div>}
        <section className="customer-block"><div className="customer-block-title"><span className="avatar customer-avatar color-2">{job.customerName.split(' ').map((part) => part[0]).slice(0, 2).join('')}</span><div><h3>{job.customerName}</h3>{showPhone && <PhoneLink phone={showPhone} />}</div></div>{!focused && <div className="customer-history"><div><span className="history-spark">✳</span><span>Workspace history</span></div><strong>{job.status === 'completed' ? 'Past customer' : 'First recorded visit'}</strong></div>}</section>

        <section className="detail-section items-section"><div className="section-heading"><span>ITEMS IN THIS JOB</span><span>{job.lines.reduce((sum, line) => sum + line.quantity, 0)} items</span></div>
          <div className="detail-lines">{job.lines.map((line) => <div className="detail-line" key={line.id}><div className="item-icon"><Smartphone size={15} /></div><div className="item-description"><strong>{line.label}</strong><span>{focused ? [line.sku, formatMoney(line.unitPriceMinor) + " each"].filter(Boolean).join(" · ") : line.sku || line.contributor}</span></div><span className="item-quantity">×{line.quantity}</span><strong className="item-price">{formatMoney(line.quantity * line.unitPriceMinor)}</strong></div>)}
            {job.charges.map((charge) => <div className="detail-line charge-line" key={charge.id}><div className="item-icon charge"><ShoppingBag size={15} /></div><div className="item-description"><strong>{charge.name}</strong><span>Additional charge{focused && ` · ${formatMoney(charge.unitAmountMinor)} each`}</span></div><span className="item-quantity">×{charge.quantity}</span><strong className="item-price">{formatMoney(charge.quantity * charge.unitAmountMinor)}</strong></div>)}
          </div>
          <div className="quote-summary"><span>Quoted total <small>· tax confirmed in billing</small></span><strong>{formatMoney(quote)}</strong></div>
        </section>

        <section className="detail-section handoff-section"><div className="section-heading"><span>SALES HANDOFF</span><span className="handoff-time"><Clock3 size={12} />{job.timeLabel}</span></div><div className="handoff-person"><span className="avatar mini-avatar">{job.owner.split(' ').map((part) => part[0]).join('').slice(0, 2)}</span><div><strong>{job.owner}</strong><span>Salesperson</span></div>{focused && job.contributors.length ? <span className="handoff-contributors">{job.contributors.join(", ")}</span> : !focused && <span className="handoff-contributors">{job.contributors.length > 1 ? `+${job.contributors.length - 1} contributed` : 'Primary'}</span>}</div>{job.note && <div className="job-note"><span>NOTE</span>{job.note}</div>}</section>

        {focused && (job.accompanyingCount != null || recipients.length > 0) && <section className="detail-section job-visit-details">
          <div className="section-heading"><span>VISIT DETAILS</span></div>
          {job.accompanyingCount != null && <p>Accompanying customers: {job.accompanyingCount}</p>}
          {recipients.length > 0 && <ul>{recipients.map((recipient, index) => <li key={index}>
            {recipient.role === 'companion' ? 'Companion' : 'Referrer'}: {recipient.name}
            {canReadPhone && recipient.phone && <> · <PhoneLink phone={recipient.phone} /></>}
          </li>)}</ul>}
        </section>}
      </div>
      <section className="detail-section cashier-section"><div className="section-heading"><span>PAYMENT & BILLING</span><span className={`payment-state ${outstanding === 0 && job.finalBilledTotalMinor != null ? 'paid' : ''}`}><span />{outstanding === 0 && job.finalBilledTotalMinor != null ? 'Settled' : job.payments.length ? 'Part paid' : 'Unpaid'}</span></div>
        <div className="billing-total-row"><span>Amount currently expected</span><strong>{formatMoney(job.finalBilledTotalMinor ?? quote)}</strong></div>
        {job.payments.length > 0 && <div className="payment-list">{job.payments.map((payment) => <div className="payment-entry" key={payment.id}><span className={`payment-method-icon ${payment.method}`}>{payment.method === 'cash' ? <Wallet size={14} /> : <Smartphone size={14} />}</span><span className="payment-entry-label"><strong>{payment.method === 'cash' ? 'Cash' : 'UPI'}</strong><small>{payment.reference || payment.time}</small></span><strong>{formatMoney(payment.amountMinor)}</strong><span className={`payment-status ${payment.status}`}>{payment.status === 'confirmed' ? <Check size={13} /> : <Clock3 size={13} />}{payment.status === 'confirmed' ? 'Received' : 'Pending'}</span>{payment.method === 'upi' && payment.status === 'pending' && can('payments.confirm_upi') && <><label className="upi-reference-field">Transaction reference (optional)<input className="upi-reference-input" value={paymentRefs[payment.id] || ''} onChange={(event) => setPaymentRefs((current) => ({ ...current, [payment.id]: event.target.value }))} /></label><button className="link-button confirm-link" disabled={busy} onClick={() => void run(() => onConfirmUpi(job, payment.id, paymentRefs[payment.id] || ''))}>Confirm received</button></>}</div>)}</div>}
        {job.invoiceReference ? <div className="invoice-recorded"><div className="invoice-icon"><Check size={15} /></div><div><strong>Invoice {job.invoiceReference}</strong><span>Final bill · {formatMoney(job.finalBilledTotalMinor ?? 0)}</span>{job.discrepancyReason && <small>Difference note: {job.discrepancyReason}</small>}</div>{canRecordBill && job.status === 'checkout' && <button type="button" className="link-button" onClick={() => setInvoiceFormOpen((open) => !open)}>Edit</button>}</div> : <div className="invoice-hint"><span className="invoice-hint-icon"><ClipboardList size={15} /></span><span><strong>Bill in your billing software</strong><small>Copy this job, create the official invoice, then record its final total.</small></span></div>}

        {paymentFormOpen && job.status === 'checkout' && <form className="inline-form payment-form" onSubmit={addPayment}><div className="inline-form-heading"><strong>Record collection</strong><button type="button" className="icon-button tiny" onClick={() => setPaymentFormOpen(false)} aria-label="Close"><X size={15} /></button></div><div className="payment-method-tabs"><button type="button" disabled={!can('payments.record_cash')} aria-pressed={paymentMethod === 'cash'} className={paymentMethod === 'cash' ? 'active' : ''} onClick={() => setPaymentMethod('cash')}><Wallet size={14} /> Cash</button><button type="button" disabled={!can('payments.record_upi')} aria-pressed={paymentMethod === 'upi'} className={paymentMethod === 'upi' ? 'active' : ''} onClick={() => setPaymentMethod('upi')}><Smartphone size={14} /> UPI</button></div><label className="mini-label">AMOUNT (₹)<input inputMode="decimal" value={paymentAmount} onChange={(e) => setPaymentAmount(e.target.value)} /></label>{paymentMethod === 'upi' && <><label className="mini-label">UPI REFERENCE <span className="optional">Optional</span><input value={upiRef} onChange={(e) => setUpiRef(e.target.value)} /></label><div className="manual-upi-note"><CircleAlert size={14} /> UPI stays pending until a permitted staff member confirms receipt.</div></>}<button className="button button-dark button-wide" disabled={busy || !can(paymentMethod === 'cash' ? 'payments.record_cash' : 'payments.record_upi')}>{busy ? 'Saving…' : paymentMethod === 'cash' ? 'Record cash received' : 'Record UPI as pending'}</button></form>}

        {invoiceFormOpen && canRecordBill && job.status === 'checkout' && <form className="inline-form invoice-form" onSubmit={submitInvoice}><div className="inline-form-heading"><strong>Enter the final bill</strong><button type="button" className="icon-button tiny" onClick={() => setInvoiceFormOpen(false)} aria-label="Close"><X size={15} /></button></div><label className="mini-label">INVOICE REFERENCE<input value={invoiceRef} onChange={(e) => { invoiceEdited.current = true; setInvoiceRef(e.target.value) }} maxLength={120} /></label><label className="mini-label">FINAL BILL TOTAL (₹)<input inputMode="decimal" value={finalTotal} onChange={(e) => setFinalTotal(e.target.value)} /></label>{Math.round(Number(finalTotal) * 100) !== quote && finalTotal !== '' && <label className="mini-label">REASON FOR DIFFERENCE<textarea value={discrepancyReason} onChange={(e) => setDiscrepancyReason(e.target.value)} rows={2} /></label>}<p className="form-footnote">Check the suggested number and total against the official bill before saving.</p><button className="button button-dark button-wide" disabled={busy || !can('billing.record')}>{busy ? 'Saving…' : 'Save invoice details'}</button></form>}

        {job.status === 'checkout' && <div className="cashier-actions">{!focused && <button className="button button-soft" onClick={() => { void copyHandoff() }}><Copy size={15} /> Copy billing summary</button>}<button className="button button-outline" disabled={!can('payments.record_cash') && !can('payments.record_upi')} onClick={() => setPaymentFormOpen((open) => !open)}><Plus size={15} /> Record payment</button>{!job.invoiceReference && can('billing.record') && <button className="link-button enter-invoice" onClick={() => setInvoiceFormOpen((open) => !open)}>Enter final bill</button>}</div>}
      </section>

      {error && <div className="inline-error" ref={errorNotice} role="alert" tabIndex={-1}><CircleAlert size={15} />{error}</div>}
    </div>

    <div className="detail-footer">
      {job.status === 'ready' && can('jobs.checkout') && <button className="button button-primary button-wide" disabled={busy} onClick={() => void run(() => onTransition(job, 'checkout'))}>Start checkout <ArrowRight size={16} /></button>}
      {(job.status === 'draft' || job.status === 'returned') && can('jobs.submit') && (can('jobs.edit_own') || can('jobs.edit_store')) && <button className="button button-primary button-wide" onClick={(event) => onEdit(job, event.detail > 0)}>{job.status === 'returned' ? 'Edit returned job' : 'Review draft'} <ClipboardList size={16} /></button>}
      {(job.status === 'draft' || job.status === 'returned') && can('jobs.submit') && !can('jobs.edit_own') && !can('jobs.edit_store') && <button className="button button-primary button-wide" disabled={busy} onClick={() => void run(() => onTransition(job, 'ready'))}>Send to checkout <ArrowRight size={16} /></button>}
      {job.status === 'ready' && can('jobs.return') && <div className="return-action"><label htmlFor="correction-reason">Correction reason (required)</label><input id="correction-reason" value={returnReason} onChange={(e) => setReturnReason(e.target.value)} /><button className="button button-soft" disabled={!returnReason.trim() || busy} onClick={() => void run(() => onTransition(job, 'returned', returnReason))}>Return</button></div>}
      {job.status === 'checkout' && can('jobs.complete') && <button className="button button-primary button-wide" disabled={busy || !job.invoiceReference || outstanding > 0} onClick={() => void run(() => onTransition(job, 'completed'))}>{job.invoiceReference && outstanding === 0 ? 'Complete job' : 'Complete after bill & payment'}<CheckCircle2 size={16} /></button>}
      {job.status === 'completed' && <div className="completed-footer"><CheckCircle2 size={16} /> This job is closed and linked to its invoice.</div>}
      {!focused && (job.status === 'draft' || job.status === 'returned' || job.status === 'ready') && <button className="link-button save-draft" onClick={() => void copyHandoff()}><Copy size={14} /> Copy job summary</button>}
      {job.status === 'checkout' && <span className="footer-hint"><ShieldCheck size={13} /> Payments and invoices are recorded separately</span>}
    </div>
  </div>
}

function NewJobDialog({ products, charges, members, demo, pointer, timeZone, existingJob, onClose, onSubmit, lookupCustomer, lookupRecipient, loadVisit, showPhones }: {
  products: CatalogProduct[]; charges: CatalogCharge[]; members: Array<{ id: string; name: string; role: string }>; demo: boolean
  timeZone?: string
  pointer: boolean
  showPhones: boolean
  existingJob?: Job
  onClose: () => void
  onSubmit: (input: JobCardInput) => Promise<string | undefined>
  lookupCustomer: (phone: string, offset: number) => Promise<CustomerLookup>
  lookupRecipient: (phone: string) => Promise<string | null>
  loadVisit: (customerId: string, visitId: string) => Promise<VisitDetail>
}) {
  const dialog = useRef<HTMLDialogElement>(null)
  const phoneInput = useRef<HTMLInputElement>(null)
  const phoneLabel = useRef<HTMLSpanElement>(null)
  const phoneOrigin = useRef<{ rect: DOMRect; fontSize: number }>(null)
  const lookupRequest = useRef(0)
  const nameInput = useRef<HTMLInputElement>(null)
  const dialogTitle = useRef<HTMLHeadingElement>(null)
  const visitTrigger = useRef<HTMLButtonElement>(null)
  const historyTrigger = useRef<HTMLButtonElement>(null)
  const visitScroll = useRef(0)
  const historyScroll = useRef(0)
  const visitRequest = useRef(0)
  const submissionKey = useRef<string>(null)
  const submitting = useRef(false)
  const [step, setStep] = useState<'customer' | 'details' | 'review'>(existingJob ? 'details' : 'customer')
  const [lookup, setLookup] = useState<CustomerLookup | null>(null)
  const [lookupBusy, setLookupBusy] = useState(false)
  const [historyOpen, setHistoryOpen] = useState(false)
  const [visit, setVisit] = useState<VisitSummary | null>(null)
  const [visitPointer, setVisitPointer] = useState(false)
  const [visitDetail, setVisitDetail] = useState<VisitDetail | null>(null)
  const [visitError, setVisitError] = useState('')
  const [phone, setPhone] = useState('')
  const [dockedPhone, setDockedPhone] = useState(existingJob?.customerPhone || '')
  const [international, setInternational] = useState(false)
  const [name, setName] = useState(existingJob?.customerName || '')
  const [note, setNote] = useState(existingJob?.note || '')
  const [jobCharges, setJobCharges] = useState<JobCharge[]>(existingJob?.charges || [])
  const [accompanyingCount, setAccompanyingCount] = useState(String(existingJob?.accompanyingCount || ''))
  const [rewardOpen, setRewardOpen] = useState(false)
  const [recipients, setRecipients] = useState<RecipientDraft[]>(() => (existingJob?.rewardRecipients || []).map((recipient) => ({ ...recipient, id: crypto.randomUUID() })))
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
    phoneInput.current?.focus()
    return () => { if (element.open) element.close() }
  }, [])

  useLayoutEffect(() => {
    const origin = phoneOrigin.current
    const label = phoneLabel.current
    phoneOrigin.current = null
    if (!origin || !label || window.matchMedia('(prefers-reduced-motion: reduce)').matches) return
    const target = label.getBoundingClientRect()
    const x = origin.rect.left + (origin.rect.width - target.width) / 2 - target.left
    const y = origin.rect.top + (origin.rect.height - target.height) / 2 - target.top
    const styles = getComputedStyle(label)
    const scale = origin.fontSize / parseFloat(styles.fontSize)
    const animation = label.animate([
      { transform: `translate(${x}px, ${y}px) scale(${scale})` },
      { transform: 'none' },
    ], {
      duration: 180,
      easing: styles.getPropertyValue('--ease-out').trim(),
    })
    return () => animation.cancel()
  }, [dockedPhone])

  const phoneForSubmit = dockedPhone
  const quote = jobQuote({ lines: lines.map((line) => ({ ...line, contributor: '' })), charges: jobCharges })
  const displayedName = name.trim() || 'Customer'
  const needsName = lookup && !lookup.customer?.display_name
  const hasHistory = Boolean(lookup?.customer && lookup.history_available !== false)

  const focusTitle = () => window.requestAnimationFrame(() => {
    dialog.current?.scrollTo(0, 0)
    dialogTitle.current?.focus({ preventScroll: true })
  })

  const goTo = (next: typeof step) => {
    setError('')
    setStep(next)
    if (next === 'customer' && !lookup) window.requestAnimationFrame(() => phoneInput.current?.focus())
    else focusTitle()
  }

  const findCustomer = async (number: string, offset = 0) => {
    if (lookupBusy) return
    const request = ++lookupRequest.current
    setLookupBusy(true)
    setError('')
    try {
      const result = await lookupCustomer(number, offset)
      if (request !== lookupRequest.current) return
      if (offset === 0) {
        setLookup(result)
        setName(result.customer?.display_name || '')
        if (result.customer?.display_name) focusTitle()
        else window.requestAnimationFrame(() => nameInput.current?.focus())
      } else {
        setLookup((current) => current && { ...current, visits: [...current.visits, ...result.visits], next_offset: result.next_offset })
      }
    } catch (e) {
      if (request === lookupRequest.current) {
        setError(publicError(e, offset ? 'We couldn’t load older visits. Try again.' : 'We couldn’t look up this number. Try again.'))
      }
    } finally {
      if (request === lookupRequest.current) setLookupBusy(false)
    }
  }

  const confirmPhone = (number: string, animate: boolean) => {
    const input = phoneInput.current
    if (animate && input && showPhones) phoneOrigin.current = {
      rect: input.getBoundingClientRect(), fontSize: parseFloat(getComputedStyle(input).fontSize),
    }
    setDockedPhone(number)
    void findCustomer(number)
  }

  const enterLocalPhone = (value: string, animate = false) => {
    const local = localPhoneDigits(value)
    if (local.startsWith('+')) {
      setInternational(true)
      setPhone(local)
      setError('')
      return
    }
    if (!/^\d{0,10}$/.test(local)) return
    setPhone(local)
    setError('')
    if (local.length === 10) confirmPhone(`+91${local}`, animate)
  }

  const editPhone = () => {
    lookupRequest.current++
    const local = /^\+91\d{10}$/.test(dockedPhone)
    setPhone(showPhones ? local ? dockedPhone.slice(3) : dockedPhone : '')
    setInternational(showPhones && !local)
    setDockedPhone('')
    setLookup(null)
    setLookupBusy(false)
    setHistoryOpen(false)
    setName('')
    setError('')
    setStep('customer')
    window.requestAnimationFrame(() => {
      dialog.current?.scrollTo(0, 0)
      phoneInput.current?.focus()
    })
  }

  const toggleInternational = () => {
    setInternational(!international)
    setPhone(international ? '' : '+')
    setError('')
    window.requestAnimationFrame(() => phoneInput.current?.focus())
  }

  const openVisit = async (summary: VisitSummary, button?: HTMLButtonElement, pointer = false) => {
    if (!lookup?.customer) return
    if (button) {
      visitTrigger.current = button
      visitScroll.current = dialog.current?.scrollTop ?? 0
      setVisitPointer(pointer)
    }
    const request = ++visitRequest.current
    setVisit(summary)
    setVisitDetail(null)
    setVisitError('')
    focusTitle()
    try {
      const result = await loadVisit(lookup.customer.id, summary.id)
      if (request === visitRequest.current) setVisitDetail(result)
    } catch (e) {
      if (request === visitRequest.current) setVisitError(publicError(e, 'We couldn’t load this visit. Try again.'))
    }
  }

  const closeVisit = () => {
    visitRequest.current++
    setVisit(null)
    window.requestAnimationFrame(() => {
      dialog.current?.scrollTo(0, visitScroll.current)
      visitTrigger.current?.focus({ preventScroll: true })
    })
  }

  const closeHistory = () => {
    setHistoryOpen(false)
    setError('')
    window.requestAnimationFrame(() => {
      dialog.current?.scrollTo(0, historyScroll.current)
      historyTrigger.current?.focus({ preventScroll: true })
    })
  }

  const close = () => {
    if (submitting.current) return
    if (visit) closeVisit()
    else if (historyOpen) closeHistory()
    else onClose()
  }

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

  const showRecipientError = (message: string) => {
    setRewardOpen(true)
    setError(message)
    window.requestAnimationFrame(() => dialog.current?.querySelector<HTMLElement>('.job-form > .form-error')?.focus())
  }

  const submit = async (event: FormEvent) => {
    event.preventDefault()
    if (submitting.current || lookupBusy && !lookup || historyOpen) return
    setError('')
    if (step === 'customer') {
      if (!lookup) {
        if (dockedPhone) void findCustomer(dockedPhone)
        else if (international) {
          const number = normalizePhone(phone)
          if (!phone.trim().startsWith('+') || !validPhone(number)) {
            setError('Enter the phone number with its country code, starting with +.')
            return
          }
          confirmPhone(number, false)
        }
        return
      }
      if (!lookup.customer && !name.trim()) { setError('Enter the customer’s name.'); nameInput.current?.focus(); return }
      goTo('details')
      return
    }
    if (!lines.length) { setError('Add at least one product or custom line.'); return }
    if (step === 'details') {
      if (customOpen && (customName.trim() || customPrice.trim())) { setError('Add the custom line before reviewing the job.'); return }
      goTo('review')
      return
    }
    const count = Number(accompanyingCount)
    const rewardRecipients = recipients.map(({ role, phone: recipientPhone, name: recipientName, savedKey }) => ({
      role, phone: savedKey ? undefined : normalizePhone(recipientPhone || ''), name: recipientName.trim(), savedKey,
    }))
    if (!Number.isInteger(count) || count < 0 || count > 100) { showRecipientError('Enter a companion count from 0 to 100.'); return }
    if (rewardRecipients.some((recipient) => !recipient.savedKey && !validPhone(recipient.phone || ''))) { showRecipientError('Enter a valid phone number for each recipient, or remove that recipient.'); return }
    if (recipients.some((recipient) => recipient.lookup?.status === 'checking' || recipient.lookup?.status === 'failed')) { showRecipientError('Finish checking the saved name for each recipient.'); return }
    if (recipients.some((recipient) => recipient.lookup?.status === 'unmatched' && !recipient.name.trim())) { showRecipientError('Enter a name for each recipient without a saved name.'); return }
    if (rewardRecipients.some((recipient) => recipient.phone === phoneForSubmit)) { showRecipientError('The customer cannot be their own recipient.'); return }
    if (new Set(rewardRecipients.map(({ role, phone: recipientPhone, savedKey }) => `${role}:${recipientPhone ?? savedKey}`)).size !== rewardRecipients.length) {
      showRecipientError('Remove duplicate recipients.'); return
    }
    if (rewardRecipients.filter((recipient) => recipient.role === 'companion').length > count) {
      showRecipientError('The companion count must cover every identified companion.'); return
    }
    submitting.current = true
    setBusy(true)
    try {
      const jobLines: JobLine[] = lines.map((line) => ({ id: line.productId || line.id, label: line.label, sku: line.sku, quantity: line.quantity, unitPriceMinor: line.unitPriceMinor, contributor: 'Sales team' }))
      const contributors = selectedMembers.map((user_id) => ({ user_id, contribution: (members.find((member) => member.id === user_id)?.role === 'promoter' ? 'promoter' : 'sales') as 'sales' | 'promoter' }))
      submissionKey.current ??= crypto.randomUUID()
      const validationError = await onSubmit({
        phone: phoneForSubmit, name: name.trim(), lines: jobLines, charges: jobCharges, contributors, note: note.trim(),
        accompanyingCount: count, rewardRecipients, submissionKey: submissionKey.current,
        jobId: existingJob?.id, version: existingJob?.version ?? 1,
      })
      if (validationError) setError(validationError)
    } catch (e) { setError(publicError(e, 'We couldn’t save this job. Try again.')) }
    finally { submitting.current = false; setBusy(false) }
  }

  const customerTitle = step === 'customer' ? lookup?.customer?.display_name?.trim() : name.trim()
  const stepTitle = step === 'customer' ? 'Find the customer' : step === 'details' ? 'Build the job card' : 'Review job card'
  const heading = visit ? 'View visit' : historyOpen ? 'Customer history' : customerTitle || stepTitle
  const showDetails = step === 'details' && !historyOpen
  const showReview = step === 'review' && !historyOpen
  const showCustomer = step === 'customer' && !historyOpen
  const showCustomerSummary = historyOpen || !customerTitle && (showReview || showCustomer && lookup)
  const showSavedPhone = showPhones && existingJob && phoneForSubmit && (historyOpen || showReview)
  const showPastVisits = showReview && hasHistory
  const showPhoneEntry = showCustomer && !dockedPhone
  const showPhoneRetry = showCustomer && dockedPhone && !lookup && !lookupBusy && error

  return <dialog ref={dialog} className="job-dialog" data-pointer-motion={pointer || undefined} aria-labelledby="job-editor-title" onCancel={(event) => {
    event.preventDefault()
    if (submitting.current) return
    if (showReview && rewardOpen && !visit) {
      setRewardOpen(false)
      dialog.current?.querySelector<HTMLButtonElement>('#reward-toggle')?.focus()
    } else close()
  }} onClick={(e) => { if (e.target === dialog.current) close() }}>
    <div className="dialog-layout">
      <div className="dialog-head"><div>
        {!historyOpen && !visit && <p className="job-current-step">Step {step === 'customer' ? 1 : step === 'details' ? 2 : 3} of 3{customerTitle && step !== 'customer' ? ` · ${stepTitle}` : ''}{existingJob ? ` · Job #${existingJob.jobNumber}` : ''}</p>}
        <h2 id="job-editor-title" ref={dialogTitle} tabIndex={-1}>{heading}</h2>
      </div>
        <div className="job-heading-actions">
          {showCustomer && dockedPhone && !existingJob && !visit && <button className="customer-phone-chip" type="button" onClick={editPhone} disabled={busy} aria-label="Change customer phone number">
            <span ref={phoneLabel} className="customer-phone-label">{showPhones ? displayCustomerPhone(dockedPhone) : 'Change number'}</span><Pencil size={13} aria-hidden="true" />
          </button>}
          <button className="icon-button" type="button" onClick={close} disabled={busy} aria-label={visit ? 'Close visit' : historyOpen ? 'Close customer history' : 'Close job editor'}><X size={18} /></button>
        </div>
      </div>
      <form onSubmit={submit} className="job-form" hidden={Boolean(visit)}>
        <fieldset className="job-fields" disabled={busy}>
        {showPhoneEntry && <section className="form-section intake-phone">
          {international ? <div className="form-fields"><label>Customer phone number <small>Include the country code, starting with +.</small>
            <input ref={phoneInput} type="tel" inputMode="tel" autoComplete="tel" required maxLength={40} value={phone} onChange={(e) => { setPhone(e.target.value); setError('') }} />
          </label></div> : <PhoneKeypad value={phone} label="Customer phone number" inputRef={phoneInput} onChange={enterLocalPhone} />}
          <button type="button" className="link-button phone-mode-switch" onClick={toggleInternational}>{international ? 'Use Indian keypad' : 'International number'}</button>
        </section>}
        {(showCustomerSummary || showSavedPhone || showPastVisits) && <section className="form-section intake-customer">
          {(showCustomerSummary || showSavedPhone) && <div>
            {showCustomerSummary && <strong>{showCustomer && !lookup?.customer ? 'New customer' : displayedName}</strong>}
            {showSavedPhone && <PhoneLink phone={phoneForSubmit} />}
          </div>}
          {showPastVisits && <div className="intake-actions">
            <button ref={historyTrigger} className="link-button" type="button" onClick={() => {
              historyScroll.current = dialog.current?.scrollTop ?? 0
              setHistoryOpen(true); setError(''); focusTitle()
            }}>Past visits</button>
          </div>}
        </section>}
        {showCustomer && needsName && <section className="form-section">
          <div className="form-fields"><label>Customer name {lookup.customer && <span className="optional">Optional</span>}
            <input ref={nameInput} value={name} onChange={(e) => setName(e.target.value)} required={!lookup.customer} maxLength={120} autoComplete="name" />
          </label></div>
        </section>}
        {(showCustomer || historyOpen) && lookup && hasHistory && <VisitHistory lookup={lookup} open={openVisit} loadMore={() => { if (lookup.next_offset !== null) void findCustomer(dockedPhone, lookup.next_offset) }} busy={lookupBusy} timeZone={timeZone} />}

        {showDetails && <>
        <section className="form-section"><div className="form-section-title"><div><strong>Items in this job</strong><small>Prices are a quote. The cashier confirms tax and final bill.</small></div></div>
          <div className="product-picker">{products.map((product) => <button type="button" key={product.id} onClick={() => addProduct(product.id)}><span className="picker-plus"><Plus size={15} /></span><span className="picker-copy"><strong>{product.name}</strong><small>{product.brand} {product.sku && `· ${product.sku}`}</small></span><span className="picker-price">{formatMoney(product.unitPriceMinor)}</span></button>)}{products.length === 0 && <div className="picker-empty">The product catalog is empty. Add a custom line below.</div>}</div>
          {lines.length > 0 && <div className="draft-lines">{lines.map((line) => <div className="draft-line" key={line.id}><div><strong>{line.label}</strong><small>{line.sku || 'Custom item'}</small></div><div className="qty-stepper"><button type="button" aria-label="Decrease quantity" disabled={line.quantity <= 1} onClick={() => setLines((current) => current.map((item) => item.id === line.id ? { ...item, quantity: Math.max(1, item.quantity - 1) } : item))}>−</button><span>{line.quantity}</span><button type="button" aria-label="Increase quantity" onClick={() => setLines((current) => current.map((item) => item.id === line.id ? { ...item, quantity: item.quantity + 1 } : item))}>+</button></div><strong>{formatMoney(line.quantity * line.unitPriceMinor)}</strong><button type="button" className="remove-line" aria-label={`Remove ${line.label}`} onClick={() => setLines((current) => current.filter((item) => item.id !== line.id))}><X size={15} /></button></div>)}</div>}
          {customOpen ? <div className="custom-line-form"><label>Custom item<input value={customName} onChange={(e) => setCustomName(e.target.value)} /></label><label>Quote (₹)<input inputMode="decimal" value={customPrice} onChange={(e) => setCustomPrice(e.target.value)} /></label><button type="button" className="button button-dark" onClick={addCustomLine}>Add line</button></div> : <button type="button" className="custom-line-trigger" onClick={() => setCustomOpen(true)}><Plus size={15} /> Add a custom line</button>}
        </section>

        {(charges.length > 0 || jobCharges.length > 0) && <section className="form-section"><div className="form-section-title"><div><strong>Additional charges</strong></div></div><div className="charge-choices">
          {[...charges, ...jobCharges.filter((charge) => !charges.some((item) => item.id === charge.id)).map((charge) => ({ id: charge.id, name: charge.name, amountMinor: charge.unitAmountMinor }))].map((charge) => {
            const selected = jobCharges.find((item) => item.id === charge.id)
            return <label key={charge.id} className={`charge-choice ${selected ? 'checked' : ''}`}><input type="checkbox" checked={Boolean(selected)} onChange={() => setJobCharges((current) => selected ? current.filter((item) => item.id !== charge.id) : [...current, { id: charge.id, name: charge.name, quantity: 1, unitAmountMinor: charge.amountMinor }])} /><span className="custom-checkbox"><Check size={13} /></span><span>{selected?.name || charge.name}{selected && selected.quantity > 1 ? ` × ${selected.quantity}` : ''}</span><strong>{formatMoney(selected ? selected.quantity * selected.unitAmountMinor : charge.amountMinor)}</strong></label>
          })}
        </div></section>}

        {members.length > 0 && <section className="form-section"><div className="form-section-title"><div><strong>Staff attribution</strong><small>Who helped with this sale?</small></div></div><div className="charge-choices">{members.map((member) => <label key={member.id} className={`charge-choice ${selectedMembers.includes(member.id) ? 'checked' : ''}`}><input type="checkbox" checked={selectedMembers.includes(member.id)} onChange={() => setSelectedMembers((current) => current.includes(member.id) ? current.filter((id) => id !== member.id) : [...current, member.id])} /><span className="custom-checkbox"><Check size={13} /></span><span>{member.name}</span><small>{member.role}</small></label>)}</div></section>}

        <section className="form-section note-section"><label>Note for the cashier <span className="optional">Optional</span><textarea value={note} onChange={(e) => setNote(e.target.value)} rows={2} maxLength={2000} /></label></section>
        </>}
        {showReview && <>
          <section className="form-section">
            <h3 className="job-section-heading">Items and charges</h3>
            <ul className="review-lines">
              {lines.map((line) => <li key={line.id}><span>{line.label} × {line.quantity}</span><strong>{formatMoney(line.quantity * line.unitPriceMinor)}</strong></li>)}
              {jobCharges.map((charge) => <li key={charge.id}><span>{charge.name} × {charge.quantity}</span><strong>{formatMoney(charge.quantity * charge.unitAmountMinor)}</strong></li>)}
            </ul>
          </section>
          <RewardRecipients open={rewardOpen} setOpen={setRewardOpen} count={accompanyingCount} setCount={setAccompanyingCount} recipients={recipients} setRecipients={setRecipients} lookupRecipient={lookupRecipient} showPhones={showPhones} />
        </>}
        </fieldset>
        {error && <div className="form-error" role="alert" tabIndex={-1}><CircleAlert size={16} />{error}</div>}
        {lookupBusy && <p className={lookup ? 'sr-only' : 'phone-lookup-status'} role="status">Looking up customer…</p>}
        {(historyOpen || showDetails || showReview || lookup || showPhoneRetry || showPhoneEntry && international) && <div className="dialog-footer intake-footer">
          {historyOpen ? <button className="button button-outline" type="button" onClick={closeHistory}><ArrowLeft size={16} /> Back to job card</button> : <>
            {(showReview || showDetails && !existingJob) && <button className="button button-outline" type="button" disabled={busy} onClick={() => goTo(showReview ? 'details' : 'customer')}><ArrowLeft size={16} /> Back</button>}
            {(showReview || showDetails) && <div className="intake-total"><span>Quoted total</span><strong>{formatMoney(quote)}</strong></div>}
            <button className="button button-primary intake-continue" disabled={busy || lookupBusy && !lookup}>
              {busy ? 'Sending…' : showCustomer ? lookup ? 'Start job card' : dockedPhone ? 'Retry lookup' : 'Look up number' : showDetails ? 'Review job card' : existingJob ? 'Save and resubmit' : 'Send to checkout'}<ArrowRight size={16} />
            </button>
          </>}
        </div>}
      </form>
      {visit && <ReadOnlyVisit summary={visit} detail={visitDetail} error={visitError} back={closeVisit} retry={() => { void openVisit(visit) }} timeZone={timeZone} pointer={visitPointer} />}
      {demo && <div className="demo-note"><span /> This is a local demo. Changes are saved in this browser only.</div>}
    </div>
  </dialog>
}

function CustomerBook({ jobs, showPhones, onSelect }: { jobs: Job[]; showPhones: boolean; onSelect: (job: Job, trigger: HTMLButtonElement) => void }) {
  const customerKey = (job: Job) => job.customerId || job.customerPhone || job.id
  const latestByCustomer = new Map<string, Job>()
  for (const job of jobs) {
    const key = customerKey(job)
    const latest = latestByCustomer.get(key)
    if (!latest || job.createdAt > latest.createdAt) latestByCustomer.set(key, job)
  }
  const customers = [...latestByCustomer.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt))
  return <main className="secondary-page">
    <div className="page-heading"><div><h1>Customer book</h1><p>Only jobs created in this workspace appear in purchase history.</p></div></div>
    <div className="secondary-card">
      <div className="secondary-card-head"><strong>Recent customers</strong><span>{customers.length} profiles</span></div>
      {customers.length === 0 && <p className="team-empty">No customer visits recorded yet.</p>}
      {customers.map((customer) => <article className="customer-record" key={customerKey(customer)}>
        <button type="button" className="customer-row" onClick={(event) => onSelect(customer, event.currentTarget)}>
          <span className="avatar customer-avatar color-2">{customer.customerName.split(' ').map((part) => part[0]).slice(0, 2).join('')}</span>
          <span className="customer-row-main"><strong>{customer.customerName}</strong></span>
          <span className="customer-last-job">Latest job <b>#{customer.jobNumber}</b></span>
          <span className="customer-history-value">{jobs.filter((job) => customerKey(job) === customerKey(customer)).length} visits</span>
          <ChevronRight size={16} aria-hidden="true" />
        </button>
        {showPhones && customer.customerPhone && <div className="customer-record-phone"><PhoneLink phone={customer.customerPhone} /></div>}
      </article>)}
    </div>
  </main>
}

function CatalogPage({ products, charges }: { products: CatalogProduct[]; charges: CatalogCharge[] }) {
  return <main className="secondary-page"><div className="page-heading"><div><span className="eyebrow eyebrow-green">APP-MANAGED</span><h1>Catalog & charges<span className="heading-period">.</span></h1><p>These are quote defaults. Your billing system still sets official tax and invoice totals.</p></div></div><div className="catalog-columns"><section className="secondary-card"><div className="secondary-card-head"><div><strong>Products</strong><small>Tap into a job to use a default quote.</small></div><span>{products.length} items</span></div>{products.map((item) => <div className="catalog-row" key={item.id}><span className="item-icon"><Smartphone size={15} /></span><span><strong>{item.name}</strong><small>{item.brand} {item.sku && `· ${item.sku}`}</small></span><b>{formatMoney(item.unitPriceMinor)}</b></div>)}</section><section className="secondary-card"><div className="secondary-card-head"><div><strong>Additional charges</strong><small>Snapshot when selected on a job.</small></div><span>{charges.length} charges</span></div>{charges.map((item) => <div className="catalog-row" key={item.id}><span className="item-icon charge"><ShoppingBag size={15} /></span><span><strong>{item.name}</strong><small>Copy into billing software</small></span><b>{formatMoney(item.amountMinor)}</b></div>)}</section></div></main>
}

type StaffRosterMember = { user_id: string; email?: string | null; display_name?: string | null; role: string; status: 'active' | 'suspended' }
type StaffInvite = { id: string; email: string; display_name: string; role: string; status: 'pending' | 'failed' | 'expired'; expires_at: string }

function TeamPage({ demo, storeId, accessToken, role, notify }: { demo: boolean; storeId: string; accessToken: string; role: string; notify: (message: string) => void }) {
  const [staff, setStaff] = useState<StaffRosterMember[]>([])
  const [invitations, setInvitations] = useState<StaffInvite[]>([])
  const [email, setEmail] = useState('')
  const [displayName, setDisplayName] = useState('')
  const [inviteRole, setInviteRole] = useState('salesperson')
  const [draftRoles, setDraftRoles] = useState<Record<string, string>>({})
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState('')
  const [error, setError] = useState('')
  const roleChoices = role === 'manager'
    ? ['salesperson', 'cashier', 'promoter']
    : ['manager', 'salesperson', 'cashier', 'promoter']

  const loadTeam = async () => {
    if (!storeId || !accessToken) return
    setLoading(true); setError('')
    try {
      const [members, pending] = await Promise.all([
        apiRequest<StaffRosterMember[]>(`/api/staff?store_id=${storeId}`, accessToken),
        apiRequest<StaffInvite[]>(`/api/staff/invitations?store_id=${storeId}`, accessToken),
      ])
      setStaff(members)
      setInvitations(pending)
      setDraftRoles(Object.fromEntries(members.map((member) => [member.user_id, member.role])))
    } catch (e) {
      setError(publicError(e, 'We couldn’t load team access. Try again.'))
    } finally { setLoading(false) }
  }

  useEffect(() => { if (!demo) void loadTeam() }, [demo, storeId, accessToken])

  const runAction = async (key: string, action: () => Promise<void>) => {
    setBusy(key); setError('')
    try { await action(); await loadTeam() }
    catch (e) { setError(publicError(e, 'We couldn’t save the team change. Try again.')) }
    finally { setBusy('') }
  }

  const submitInvite = async (event: FormEvent) => {
    event.preventDefault()
    await runAction('invite', async () => {
      await apiRequest('/api/staff/invitations', accessToken, {
        method: 'POST', body: JSON.stringify({ store_id: storeId, email: email.trim(), display_name: displayName.trim(), role: inviteRole }),
      })
      setEmail(''); setDisplayName(''); setInviteRole('salesperson')
      notify(`Invitation sent to ${email.trim()}`)
    })
  }

  const updateMember = async (member: StaffRosterMember, patch: { role?: string; status?: 'active' | 'suspended' }) => {
    await runAction(`member:${member.user_id}`, async () => {
      await apiRequest(`/api/staff/${member.user_id}`, accessToken, {
        method: 'PATCH', body: JSON.stringify({ store_id: storeId, ...patch }),
      })
      notify(patch.role ? `${member.display_name || member.email || 'Staff member'} role updated` : patch.status === 'suspended' ? 'Store access suspended' : 'Store access reactivated')
    })
  }

  if (demo) return <main className="secondary-page"><div className="page-heading"><div><span className="eyebrow eyebrow-green">ACCESS CONTROL</span><h1>Team access<span className="heading-period">.</span></h1><p>Manage invitations, staff roles, and store access from the live workspace.</p></div></div><div className="team-access-card"><div className="team-access-icon"><ShieldCheck size={20} /></div><div><strong>Demo role preview</strong><p>Open the workspace menu to preview salesperson, cashier, and manager actions. Invitations are only sent from the live workspace.</p></div></div><div className="permission-grid"><div><strong>Salesperson</strong><span>Create and send jobs · record permitted collections</span></div><div><strong>Cashier</strong><span>Review queue · record bill · verify UPI receipts</span></div><div><strong>Manager</strong><span>Resolve discrepancies · manage store access</span></div></div></main>

  return <main className="secondary-page team-page">
    <div className="page-heading team-heading"><div><span className="eyebrow eyebrow-green">ACCESS CONTROL</span><h1>Team access<span className="heading-period">.</span></h1><p>Invite each employee with the access they need. Membership activates when they accept.</p></div><span className="team-role-chip"><ShieldCheck size={14} /> {role}</span></div>
    <section className="team-invite-card">
      <div className="team-section-heading"><div><span className="eyebrow eyebrow-green">NEW INVITATION</span><h2>Invite a teammate</h2><p>They’ll receive an email link to set a password and activate their store account.</p></div></div>
      <form className="team-invite-form" onSubmit={submitInvite}>
        <label>Full name<input required maxLength={120} value={displayName} onChange={(e) => setDisplayName(e.target.value)} /></label>
        <label>Work email<input type="email" required maxLength={254} autoCapitalize="none" value={email} onChange={(e) => setEmail(e.target.value)} /></label>
        <label>Role<select value={inviteRole} onChange={(e) => setInviteRole(e.target.value)}>{roleChoices.map((value) => <option key={value} value={value}>{roleLabel[value as StaffRole] || value}</option>)}</select></label>
        <button className="button button-primary" disabled={busy === 'invite'}><Users size={15} />{busy === 'invite' ? 'Sending…' : 'Send invitation'}</button>
      </form>
    </section>

    {error && <div className="team-error" role="alert"><CircleAlert size={16} />{error}<button type="button" onClick={() => void loadTeam()}>Retry</button></div>}
    <section className="team-list-card">
      <div className="team-section-heading team-list-heading"><div><span className="eyebrow eyebrow-green">STORE MEMBERS</span><h2>People with access</h2></div><span>{staff.filter((item) => item.status === 'active').length} active</span></div>
      {loading ? <div className="team-empty"><span className="loading-orb" />Loading team access…</div> : staff.length === 0 ? <div className="team-empty">No staff memberships found.</div> : <div className="staff-list">{staff.map((member) => {
        const protectedMember = member.role === 'owner' || (member.role === 'admin' && role !== 'owner') || (member.role === 'manager' && role === 'manager')
        const canEdit = !protectedMember && member.status !== 'suspended'
        return <article className="staff-row" key={member.user_id}>
          <span className="avatar staff-avatar">{(member.display_name || member.email || 'S').split(/\s+/).slice(0, 2).map((part) => part[0]).join('').toUpperCase()}</span>
          <div className="staff-identity"><strong>{member.display_name || 'Staff member'}</strong><small>{member.email ? <EmailLink email={member.email} /> : 'Email unavailable'}</small></div>
          <span className={`staff-status ${member.status}`}>{member.status === 'active' ? 'Active' : 'Suspended'}</span>
          <div className="staff-controls">
            {protectedMember ? <span className="staff-role-static">{member.role}</span> : <select aria-label={`Role for ${member.display_name || member.email}`} disabled={!canEdit || Boolean(busy)} value={draftRoles[member.user_id] || member.role} onChange={(e) => setDraftRoles((current) => ({ ...current, [member.user_id]: e.target.value }))}>{roleChoices.map((value) => <option key={value} value={value}>{roleLabel[value as StaffRole] || value}</option>)}</select>}
            {!protectedMember && member.status === 'active' && <button className="button button-soft staff-save" type="button" disabled={Boolean(busy) || draftRoles[member.user_id] === member.role} onClick={() => void updateMember(member, { role: draftRoles[member.user_id] })}>{busy === `member:${member.user_id}` ? 'Saving…' : 'Save role'}</button>}
            {!protectedMember && <button className="staff-access-action" type="button" disabled={Boolean(busy)} onClick={() => { const nextStatus = member.status === 'active' ? 'suspended' : 'active'; if (nextStatus === 'suspended' && !window.confirm(`Suspend ${member.display_name || member.email || 'this staff member'}? They will immediately lose access to this store.`)) return; void updateMember(member, { status: nextStatus }) }}>{member.status === 'active' ? 'Suspend' : 'Reactivate'}</button>}
          </div>
        </article>
      })}</div>}
    </section>

    <section className="team-list-card pending-card">
      <div className="team-section-heading team-list-heading"><div><span className="eyebrow eyebrow-green">INVITATIONS</span><h2>Waiting for acceptance</h2></div><span>{invitations.filter((item) => item.status === 'pending').length} pending</span></div>
      {loading ? <div className="team-empty">Loading invitations…</div> : invitations.length === 0 ? <div className="team-empty">No pending invitations.</div> : <div className="staff-list">{invitations.map((invitation) => <article className="staff-row invite-row" key={invitation.id}>
        <span className="invite-icon"><Bell size={16} /></span>
        <div className="staff-identity"><strong>{invitation.display_name}</strong><small><EmailLink email={invitation.email} /> · {roleLabel[invitation.role as StaffRole] || invitation.role}</small></div>
        <span className={`staff-status ${invitation.status}`}>{invitation.status}</span>
        <div className="staff-controls"><button className="button button-soft staff-save" type="button" disabled={Boolean(busy)} onClick={() => void runAction(`resend:${invitation.id}`, async () => { await apiRequest(`/api/staff/invitations/${invitation.id}/resend?store_id=${storeId}`, accessToken, { method: 'POST' }); notify(`Invitation resent to ${invitation.email}`) })}>{busy === `resend:${invitation.id}` ? 'Sending…' : 'Resend'}</button><button className="staff-access-action" type="button" disabled={Boolean(busy)} onClick={() => void runAction(`cancel:${invitation.id}`, async () => { await apiRequest(`/api/staff/invitations/${invitation.id}/cancel?store_id=${storeId}`, accessToken, { method: 'POST' }); notify('Invitation cancelled') })}>Cancel</button></div>
      </article>)}</div>}
    </section>
  </main>
}

function StoreSetup({ onComplete }: { onComplete: (name: string) => Promise<void> }) {
  const [name, setName] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  return <main className="setup-screen"><form className="setup-card" onSubmit={async (event) => { event.preventDefault(); setBusy(true); setError(''); try { await onComplete(name.trim()) } catch (e) { setError(publicError(e, 'We couldn’t set up the store. Try again.')) } finally { setBusy(false) } }}>
    <PageDetails title="Set up your store" description="Create the Counterline workspace for your store and start adding staff." />
    <BrandLink /><span className="eyebrow">FIRST SIGN-IN</span><h1>Set up your store</h1><p>This first account will become the store owner. Staff can be added after setup.</p><label>Store name<input value={name} onChange={(e) => setName(e.target.value)} required maxLength={120} /></label>{error && <div className="form-error" role="alert"><CircleAlert size={16} />{error}</div>}<button className="button button-primary button-wide" disabled={busy}>{busy ? 'Setting up…' : 'Create store workspace'}<ArrowRight size={16} /></button></form></main>
}
