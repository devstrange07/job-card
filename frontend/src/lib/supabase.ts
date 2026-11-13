import { createClient } from '@supabase/supabase-js'

function authUrl(value: string | undefined) {
  try {
    const url = new URL(value?.trim() ?? '')
    return url.protocol === 'https:' || url.protocol === 'http:' ? url.href : null
  } catch {
    return null
  }
}

const url = authUrl(import.meta.env.VITE_SUPABASE_URL)
const publishableKey = (import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY as string | undefined)?.trim()

export const supabase = url && publishableKey
  ? createClient(url, publishableKey, {
      global: {
        fetch: (input, init) => {
          const requestUrl = new URL(input instanceof Request ? input.url : input)
          if (requestUrl.pathname.endsWith('/auth/v1/token') && requestUrl.searchParams.get('grant_type') === 'password') {
            const timeout = AbortSignal.timeout(15_000)
            const signal = init?.signal ?? (input instanceof Request ? input.signal : undefined)
            return fetch(input, { ...init, signal: signal ? AbortSignal.any([signal, timeout]) : timeout })
          }
          return fetch(input, init)
        },
      },
      auth: {
        autoRefreshToken: true,
        persistSession: true,
        detectSessionInUrl: true,
      },
    })
  : null

export const hasSupabaseConfig = Boolean(supabase)
