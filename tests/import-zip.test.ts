// Imports real ZIP archives laid out the way each provider's export is, to
// check that the right file is found inside them and the chats are saved.

import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { importExport } from '../src/main/importService'
import { Store } from '../src/main/store'

let dir: string
let store: Store

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'threefold-zip-'))
  store = new Store(path.join(dir, 'data'))
})
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }))

/** Builds a ZIP from a map of path -> content, using the system zip tool. */
function zip(name: string, files: Record<string, string>): string {
  const root = path.join(dir, `${name}-src`)
  for (const [file, content] of Object.entries(files)) {
    const target = path.join(root, file)
    fs.mkdirSync(path.dirname(target), { recursive: true })
    fs.writeFileSync(target, content)
  }
  const out = path.join(dir, `${name}.zip`)
  execFileSync('zip', ['-q', '-r', out, '.'], { cwd: root })
  return out
}

const geminiActivity = JSON.stringify([
  {
    header: 'Gemini Apps',
    title: 'Prompted Why is the sky blue?',
    time: '2026-06-01T09:00:00.000Z',
    products: ['Gemini Apps'],
    safeHtmlItem: [{ html: '<p>Because of <b>Rayleigh scattering</b>.</p>' }],
  },
  {
    header: 'Gemini Apps',
    title: 'Prompted And at sunset?',
    time: '2026-06-01T09:04:00.000Z',
    products: ['Gemini Apps'],
    safeHtmlItem: [{ html: '<p>The light travels through more air.</p>' }],
  },
])

const chatgptExport = JSON.stringify([
  {
    conversation_id: 'c1',
    title: 'Greeting',
    create_time: 1_750_000_000,
    update_time: 1_750_000_100,
    current_node: 'b',
    mapping: {
      a: { id: 'a', parent: null, children: ['b'], message: { id: 'a', author: { role: 'user' }, content: { content_type: 'text', parts: ['Hello'] } } },
      b: { id: 'b', parent: 'a', children: [], message: { id: 'b', author: { role: 'assistant' }, content: { content_type: 'text', parts: ['Hi there'] } } },
    },
  },
])

const claudeExport = JSON.stringify([
  {
    uuid: 'u1',
    name: 'Planning',
    created_at: '2026-05-01T10:00:00Z',
    updated_at: '2026-05-01T10:01:00Z',
    chat_messages: [
      { uuid: 'm1', sender: 'human', text: 'Plan my week', created_at: '2026-05-01T10:00:00Z' },
      { uuid: 'm2', sender: 'assistant', text: 'Here is a plan.', created_at: '2026-05-01T10:01:00Z' },
    ],
  },
])

describe('importing export ZIPs', () => {
  it('finds the Gemini activity file at its usual Takeout path', async () => {
    const file = zip('takeout', {
      'Takeout/My Activity/Gemini Apps/MyActivity.json': geminiActivity,
      'Takeout/archive_browser.html': '<html></html>',
    })
    const result = await importExport(store, 'gemini', file)
    expect(result.errors).toEqual([])
    expect(result.imported).toBe(1)
    const [meta] = store.listConversations()
    expect(meta!.provider).toBe('gemini')
    const chat = store.getConversation(meta!.id)!
    expect(chat.messages.map((m) => m.role)).toEqual(['user', 'assistant', 'user', 'assistant'])
    expect(chat.messages[1]!.text).toBe('Because of **Rayleigh scattering**.')
  })

  it('finds the Gemini activity when Takeout names the folders in another language', async () => {
    const file = zip('takeout-de', { 'Takeout/Meine Aktivitäten/Gemini-Apps/MeineAktivitäten.json': geminiActivity })
    const result = await importExport(store, 'gemini', file)
    expect(result.imported).toBe(1)
  })

  it('falls back to looking inside every JSON file for Gemini records', async () => {
    const file = zip('odd', { 'export/activity.json': geminiActivity, 'export/other.json': '{"unrelated": true}' })
    const result = await importExport(store, 'gemini', file)
    expect(result.imported).toBe(1)
  })

  it('says what to change when the Gemini activity was exported as HTML', async () => {
    const file = zip('takeout-html', { 'Takeout/My Activity/Gemini Apps/MyActivity.html': '<html>activity</html>' })
    const result = await importExport(store, 'gemini', file)
    expect(result.imported).toBe(0)
    expect(result.errors[0]).toMatch(/as HTML/)
    expect(result.errors[0]).toMatch(/Activity records.*JSON/)
  })

  it('explains the Gems mix-up when the archive has no Gemini activity at all', async () => {
    const file = zip('gems', { 'Takeout/Gemini/gems.csv': 'name\nMy gem' })
    const result = await importExport(store, 'gemini', file)
    expect(result.imported).toBe(0)
    expect(result.errors[0]).toMatch(/My Activity/)
    expect(result.errors[0]).toMatch(/Gems, not chats/)
  })

  it('imports a ChatGPT export ZIP, including one split into numbered files', async () => {
    const file = zip('chatgpt', {
      'conversations-000.json': chatgptExport,
      'chat.html': '<html></html>',
      'user.json': '{"id": "x"}',
    })
    const result = await importExport(store, 'chatgpt', file)
    expect(result.errors).toEqual([])
    expect(result.imported).toBe(1)
    expect(store.listConversations()[0]!.title).toBe('Greeting')
  })

  it('imports a Claude export ZIP and ignores its other files', async () => {
    const file = zip('claude', {
      'conversations.json': claudeExport,
      'users.json': '[{"uuid": "x"}]',
      'projects.json': '[]',
    })
    const result = await importExport(store, 'claude', file)
    expect(result.errors).toEqual([])
    expect(result.imported).toBe(1)
    expect(store.listConversations()[0]!.title).toBe('Planning')
  })

  it('does not duplicate chats when the same export is imported twice', async () => {
    const file = zip('claude-twice', { 'conversations.json': claudeExport })
    await importExport(store, 'claude', file)
    const second = await importExport(store, 'claude', file)
    expect(second.imported).toBe(0)
    expect(second.skipped).toBe(1)
    expect(store.listConversations()).toHaveLength(1)
  })

  it('refuses an export from another provider and says where it belongs', async () => {
    const file = zip('wrong-mode', { 'conversations.json': chatgptExport })
    const result = await importExport(store, 'claude', file)
    expect(result.imported).toBe(0)
    expect(result.errors[0]).toMatch(/ChatGPT export/)
  })

  it('reports a ZIP with no export in it', async () => {
    const file = zip('empty', { 'readme.txt': 'nothing here' })
    const result = await importExport(store, 'chatgpt', file)
    expect(result.imported).toBe(0)
    expect(result.errors[0]).toMatch(/No conversations\.json/)
  })

  it('reads a bare JSON file as well as a ZIP', async () => {
    const file = path.join(dir, 'MyActivity.json')
    fs.writeFileSync(file, geminiActivity)
    const result = await importExport(store, 'gemini', file)
    expect(result.imported).toBe(1)
  })
})
