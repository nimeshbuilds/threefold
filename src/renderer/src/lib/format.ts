import type { ConversationMeta, Provider } from '@shared/types'

export const MODE_NAME: Record<Provider, string> = { claude: 'Claude', chatgpt: 'ChatGPT', gemini: 'Gemini' }
export const API_NAME: Record<Provider, string> = { claude: 'Anthropic', chatgpt: 'OpenAI', gemini: 'Google' }

export interface ChatGroup {
  label: string
  items: ConversationMeta[]
}

/** Groups chats the way people look for them: pinned, then by how recent. */
export function groupByRecency(metas: ConversationMeta[], now = Date.now()): ChatGroup[] {
  const startOfToday = new Date(now)
  startOfToday.setHours(0, 0, 0, 0)
  const today = startOfToday.getTime()
  const day = 86_400_000
  const buckets: Array<[string, (m: ConversationMeta) => boolean]> = [
    ['Pinned', (m) => m.pinned === true],
    ['Today', (m) => m.updatedAt >= today],
    ['Yesterday', (m) => m.updatedAt >= today - day],
    ['Previous 7 days', (m) => m.updatedAt >= today - 7 * day],
    ['Previous 30 days', (m) => m.updatedAt >= today - 30 * day],
    ['Older', () => true],
  ]
  const groups = new Map<string, ConversationMeta[]>()
  for (const meta of metas) {
    const bucket = buckets.find(([, test]) => test(meta))!
    const list = groups.get(bucket[0]) ?? []
    list.push(meta)
    groups.set(bucket[0], list)
  }
  return buckets.filter(([label]) => groups.has(label)).map(([label]) => ({ label, items: groups.get(label)! }))
}

export function greeting(mode: Provider, name: string, now = new Date()): string {
  const who = name.trim().split(/\s+/)[0]
  if (mode === 'chatgpt') return who ? `What are we working on, ${who}?` : 'What are we working on?'
  if (mode === 'gemini') return who ? `Hi ${who}. Where should we start?` : 'Where should we start?'
  const hour = now.getHours()
  const part = hour < 5 ? 'Up late' : hour < 12 ? 'Morning' : hour < 18 ? 'Afternoon' : 'Evening'
  return who ? `${part}, ${who}. What's on your mind?` : `${part}. What's on your mind?`
}

export function fileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

export function daysUntil(timestamp: number, now = Date.now()): number {
  return Math.max(0, Math.ceil((timestamp - now) / 86_400_000))
}

export function shortDate(timestamp: number): string {
  return new Date(timestamp).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
}
