const API_URL = (import.meta.env.VITE_API_URL as string | undefined)?.replace(/\/$/, '') || 'http://localhost:8000'

const offline = 'You’re offline. Check your internet connection and try again.'
const unreachable = 'We couldn’t connect. Check your connection and try again.'
const rateLimited = 'Too many attempts. Wait a moment and try again.'
const publicDetails = new Set([
  'A selected catalog product is no longer available',
  'Enter a valid email address',
  "Enter the employee's name",
  'This employee already belongs to the store',
  'A pending invitation already exists for this email',
  'Confirm the invited email address before accepting',
  'This account already has a membership in the store',
  'Choose active staff from this store',
  'Only returned jobs can be edited',
  'Job changed; refresh before editing',
  'Saved recipient changed; refresh before editing',
  'Job changed; refresh before retrying',
  'Enter a name for each recipient without a saved name',
  'Enter the new customer’s name',
  'Remove duplicate recipients',
  'The customer cannot be their own recipient',
  'Add only one referrer',
  'The companion count must cover every identified companion',
  'Store setup has already been completed',
])

class ApiError extends Error {
  readonly status: number
  readonly publicDetail?: string

  constructor(status: number, publicDetail?: string) {
    super('Workspace request failed')
    this.status = status
    this.publicDetail = publicDetail
  }
}

export function publicError(error: unknown, fallback: string): string {
  if (!navigator.onLine) return offline
  if (error instanceof ApiError) {
    if (error.status === 0) return unreachable
    if (error.status === 401) return 'Your session has ended. Sign in again to continue.'
    if (error.status === 429) return rateLimited
    return error.publicDetail || fallback
  }
  if (error && typeof error === 'object') {
    const auth = error as { name?: string; code?: string; status?: number }
    if (auth.code === 'invalid_credentials') return 'That email or password doesn’t look right. Try again.'
    if (auth.code === 'email_not_confirmed') return 'Check your inbox for your invitation link. Ask your manager for a new one if needed.'
    if (auth.code === 'weak_password') return 'Choose a stronger password and try again.'
    if (auth.status === 429 || auth.code === 'over_request_rate_limit') return rateLimited
    if (auth.status === 0 || auth.name === 'TimeoutError' || auth.name === 'AbortError' || error instanceof TypeError) return unreachable
  }
  return fallback
}

export const signInFallback = 'Sign-in is temporarily unavailable. Try again in a moment.'

export async function apiRequest<T>(path: string, accessToken: string, init: RequestInit = {}): Promise<T> {
  if (!navigator.onLine) throw new ApiError(0)
  const response = await fetch(`${API_URL}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
      ...init.headers,
    },
  }).catch(() => { throw new ApiError(0) })
  if (!response.ok) {
    const error = await response.json().catch(() => null)
    const detail = error?.detail
    throw new ApiError(response.status, typeof detail === 'string' && publicDetails.has(detail) ? detail : undefined)
  }
  return response.json() as Promise<T>
}
