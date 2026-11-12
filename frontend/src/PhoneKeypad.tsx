import { Delete } from 'lucide-react'
import type { Ref } from 'react'

export function PhoneKeypad({ value, label, inputRef, autoFocus, onChange, onEnter }: {
  value: string
  label: string
  inputRef?: Ref<HTMLInputElement>
  autoFocus?: boolean
  onChange: (value: string, pointer?: boolean) => void
  onEnter?: () => void
}) {
  const digit = (key: string) => <button key={key} className="phone-pebble" type="button" onClick={(event) => onChange(value + key, event.detail > 0)}>{key}</button>

  return <>
    <div className="phone-entry-display">
      <span aria-hidden="true">+91</span>
      <input ref={inputRef} type="tel" inputMode="none" autoComplete="off" autoFocus={autoFocus} aria-label={label} value={value} onChange={(event) => onChange(event.target.value)} onKeyDown={(event) => {
        if (event.key === 'Enter' && onEnter) { event.preventDefault(); onEnter() }
      }} />
    </div>
    <div className="phone-keypad" role="group" aria-label="Phone keypad">
      {'123456789'.split('').map(digit)}
      <button className="phone-pebble phone-pebble-action" type="button" disabled={!value} onClick={() => onChange('')}>Clear</button>
      {digit('0')}
      <button className="phone-pebble phone-pebble-action" type="button" disabled={!value} aria-label="Delete last digit" onClick={() => onChange(value.slice(0, -1))}><Delete size={21} aria-hidden="true" /></button>
    </div>
  </>
}
