export function localPhoneDigits(value: string) {
  return value.replace(/[\s().-]/g, '').replace(/^(?:\+91|91)(\d{10})$/, '$1')
}

export function normalizePhone(value: string) {
  const cleaned = value.replace(/[\s().-]/g, '')
  if (/^[0-9]{10}$/.test(cleaned)) return `+91${cleaned}`
  if (/^91[0-9]{10}$/.test(cleaned)) return `+${cleaned}`
  return cleaned
}

export const validPhone = (value: string) => /^\+[1-9][0-9]{7,14}$/.test(value)

export function displayCustomerPhone(phone: string) {
  return phone.replace(/^\+91(\d{5})(\d{5})$/, '+91 $1 $2')
}
