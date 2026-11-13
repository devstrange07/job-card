import { ChevronDown, Minus, Pencil, Plus, X } from 'lucide-react'
import { useRef, useState, type Dispatch, type SetStateAction } from 'react'
import { publicError } from './lib/api'
import { PhoneKeypad } from './PhoneKeypad'
import { displayCustomerPhone, localPhoneDigits, normalizePhone, validPhone } from './lib/phone'
import type { RewardRecipient } from './types'

export type RecipientDraft = RewardRecipient & {
  id: string
  lookup?: { id: string; status: 'checking' | 'matched' | 'unmatched' | 'failed' }
}

function RecipientPhoneEntry({ phone, label, onChange, done }: {
  phone: string; label: string; onChange: (value: string) => void; done: (number: string) => void
}) {
  const [international, setInternational] = useState(() => phone.startsWith('+') && !/^\+91\d{10}$/.test(phone))
  const [error, setError] = useState('')
  const input = useRef<HTMLInputElement>(null)
  const digits = localPhoneDigits(phone)

  const enter = (value: string) => {
    const local = localPhoneDigits(value)
    if (local.startsWith('+')) {
      setInternational(true)
      onChange(local)
    } else if (/^\d{0,10}$/.test(local)) {
      if (local.length === 10) done(`+91${local}`)
      else onChange(local)
    }
    setError('')
  }

  const confirm = () => {
    const number = normalizePhone(phone)
    if (validPhone(number) && (!international || phone.trim().startsWith('+'))) done(number)
    else setError(international ? 'Enter the number with its country code, starting with +.' : 'Enter all 10 digits.')
  }

  return <div className="recipient-phone-entry">
    {international ? <div className="form-fields">
      <label>{label}<input ref={input} type="tel" autoFocus inputMode="tel" maxLength={40} value={phone} onChange={(event) => { onChange(event.target.value); setError('') }} onKeyDown={(event) => {
        if (event.key === 'Enter') { event.preventDefault(); confirm() }
      }} /></label>
    </div> : <PhoneKeypad value={digits} label={label} autoFocus inputRef={input} onChange={enter} onEnter={confirm} />}
    <div className="recipient-actions">
      <button type="button" className="link-button phone-mode-switch" onClick={() => {
        setInternational(!international)
        onChange(international ? '' : '+')
        setError('')
        window.requestAnimationFrame(() => input.current?.focus())
      }}>{international ? 'Use Indian keypad' : 'International number'}</button>
      <button type="button" className="button button-outline" onClick={confirm}>Done</button>
    </div>
    {error && <p className="form-error" role="alert">{error}</p>}
  </div>
}

export function RewardRecipients({ open, setOpen, count, setCount, recipients, setRecipients, lookupRecipient, showPhones }: {
  open: boolean; setOpen: (open: boolean) => void
  count: string; setCount: (value: string) => void
  recipients: RecipientDraft[]
  setRecipients: Dispatch<SetStateAction<RecipientDraft[]>>
  lookupRecipient: (phone: string) => Promise<string | null>
  showPhones: boolean
}) {
  const [active, setActive] = useState<string | null>(null)
  const [animateOpen, setAnimateOpen] = useState(false)
  const [lookupError, setLookupError] = useState('')
  const toggle = useRef<HTMLButtonElement>(null)
  const phoneButtons = useRef(new Map<string, HTMLButtonElement>())
  const companionCount = recipients.filter((recipient) => recipient.role === 'companion').length
  const hasReferrer = recipients.some((recipient) => recipient.role === 'referrer')
  const summary = [hasReferrer && 'Referrer added', Number(count) > 0 && `${count} accompanying`].filter(Boolean).join(' · ')

  const add = (role: RewardRecipient['role']) => {
    const id = crypto.randomUUID()
    setRecipients((current) => [...current, { id, role, phone: '', name: '' }])
    setActive(id)
    if (role === 'companion' && Number(count) <= companionCount) setCount(String(companionCount + 1))
  }

  const update = (id: string, change: Partial<RewardRecipient>) => {
    setRecipients((current) => current.map((recipient) => recipient.id === id ? { ...recipient, ...change } : recipient))
  }

  const identify = async (id: string, phone: string) => {
    const request = crypto.randomUUID()
    setLookupError('')
    setRecipients((current) => current.map((recipient) => recipient.id === id ? {
      ...recipient, phone, savedKey: undefined, name: '', lookup: { id: request, status: 'checking' },
    } : recipient))
    try {
      const name = await lookupRecipient(phone)
      setRecipients((current) => current.map((recipient) => recipient.id === id && recipient.lookup?.id === request ? {
        ...recipient, name: name || '', lookup: { id: request, status: name ? 'matched' : 'unmatched' },
      } : recipient))
    } catch (error) {
      setLookupError(publicError(error, 'Couldn’t check for a saved name. Try again.'))
      setRecipients((current) => current.map((recipient) => recipient.id === id && recipient.lookup?.id === request ? {
        ...recipient, lookup: { id: request, status: 'failed' },
      } : recipient))
    }
  }

  return <section className="form-section reward-recipients" aria-labelledby="reward-toggle">
    <button ref={toggle} className="reward-toggle" id="reward-toggle" type="button" aria-expanded={open} aria-controls="reward-panel" onClick={(event) => {
      setAnimateOpen(!open && event.detail > 0)
      setOpen(!open)
    }}>
      <span><strong>Referrals &amp; companions</strong><small>{summary || 'Optional'}</small></span>
      {open ? <ChevronDown size={18} aria-hidden="true" /> : <Plus size={18} aria-hidden="true" />}
    </button>
    <div id="reward-panel" hidden={!open} className="reward-panel" data-pointer-motion={animateOpen && open || undefined}>
      {open && <>
        <div className="recipient-count">
          <label htmlFor="companion-count">People accompanying the customer</label>
          <div className="recipient-stepper">
            <button type="button" className="icon-button" aria-label="Decrease companion count" disabled={Number(count) <= companionCount} onClick={() => setCount(String(Number(count) - 1))}><Minus size={16} /></button>
            <input id="companion-count" type="number" min={0} max={100} step={1} inputMode="numeric" value={count} onChange={(event) => setCount(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter') event.preventDefault() }} />
            <button type="button" className="icon-button" aria-label="Increase companion count" disabled={Number(count) >= 100} onClick={() => setCount(String(Number(count) + 1))}><Plus size={16} /></button>
          </div>
        </div>
        <div className="recipient-actions">
          {!hasReferrer && <button type="button" className="button button-outline" onClick={() => add('referrer')}><Plus size={15} /> Add referrer</button>}
          {companionCount < 20 && <button type="button" className="button button-outline" onClick={() => add('companion')}><Plus size={15} /> Add companion</button>}
        </div>
        {recipients.map((recipient) => {
          const label = recipient.role === 'referrer' ? 'Referrer' : 'Companion'
          const complete = Boolean(recipient.savedKey || validPhone(normalizePhone(recipient.phone || '')))
          return <div className="recipient-card" key={recipient.id}>
            <div className="recipient-heading"><strong>{label}</strong><button type="button" className="icon-button" aria-label={`Remove ${recipient.role}`} onClick={() => {
              setRecipients(recipients.filter(({ id }) => id !== recipient.id))
              if (active === recipient.id) setActive(null)
              toggle.current?.focus()
            }}><X size={16} /></button></div>
            {active === recipient.id ? <RecipientPhoneEntry phone={recipient.phone || ''} label={`${label} phone number`} onChange={(phone) => {
              setRecipients((current) => current.map((item) => item.id === recipient.id ? { ...item, phone, lookup: undefined } : item))
            }} done={(phone) => {
              void identify(recipient.id, phone)
              setActive(null)
              window.requestAnimationFrame(() => phoneButtons.current.get(recipient.id)?.focus())
            }} /> : <>
              {recipient.lookup?.status === 'checking' && <p className="recipient-lookup-status" role="status">Looking up saved name…</p>}
              {recipient.lookup?.status === 'failed' && <div className="recipient-actions"><span role="alert">{lookupError || 'Couldn’t check for a saved name.'}</span><button type="button" className="button button-outline" onClick={() => { if (recipient.phone) void identify(recipient.id, recipient.phone) }}>Retry lookup</button></div>}
              {recipient.name && recipient.lookup?.status !== 'unmatched' && <strong className="recipient-name">{recipient.name}</strong>}
              <button ref={(button) => { if (button) phoneButtons.current.set(recipient.id, button); else phoneButtons.current.delete(recipient.id) }} type="button" className="customer-phone-chip recipient-phone-chip" onClick={() => {
                if (recipient.savedKey || !showPhones && complete) setRecipients((current) => current.map((item) => item.id === recipient.id ? { ...item, phone: '', savedKey: undefined, name: '', lookup: undefined } : item))
                setActive(recipient.id)
              }} aria-label={`${complete ? 'Change' : 'Enter'} ${recipient.role} phone number`}>
                {showPhones && recipient.phone ? displayCustomerPhone(recipient.phone) : complete ? 'Change number' : 'Enter phone number'}<Pencil size={13} aria-hidden="true" />
              </button>
              {recipient.lookup?.status === 'unmatched' && <div className="form-fields"><label>Name <span className="optional">No saved name for this number</span>
                <input value={recipient.name} maxLength={120} onChange={(event) => update(recipient.id, { name: event.target.value })} onKeyDown={(event) => { if (event.key === 'Enter') event.preventDefault() }} />
              </label></div>}
            </>}
          </div>
        })}
      </>}
    </div>
  </section>
}
