import { useEffect } from 'react'

export function PageDetails({ title, description }: { title: string; description: string }) {
  useEffect(() => {
    document.title = `${title} · Counterline`
    document.querySelector('meta[name="description"]')?.setAttribute('content', description)
  }, [title, description])

  return null
}
