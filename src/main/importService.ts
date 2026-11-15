// Reads a ChatGPT, Claude or Gemini data export (the ZIP as downloaded, or the
// JSON file inside it) and saves the conversations locally.

import fs from 'node:fs'
import yauzl from 'yauzl'
import type { ImportResult, Provider } from '@shared/types'
import { detectExport, parseExport } from './importers'
import type { Store } from './store'

const CONVERSATIONS_FILE = /(^|\/)conversations(-\d+)?\.json$/i
/**
 * Google Takeout puts the activity at "Takeout/My Activity/Gemini Apps/MyActivity.json".
 * Folder and file names are translated in other languages, so only the product name is relied on.
 */
const GEMINI_ACTIVITY_FILE = /(^|\/)[^/]*(gemini|bard)[^/]*\/[^/]+\.json$/i
const GEMINI_ACTIVITY_HTML = /(^|\/)[^/]*(gemini|bard)[^/]*\/[^/]+\.html?$/i
const ANY_JSON = /\.json$/i
const MAX_JSON_BYTES = 1_500_000_000

interface ZipRead {
  contents: string[]
  /** Every file name in the archive, to explain what was found when nothing matched. */
  names: string[]
}

function readZipEntries(file: string, wanted: RegExp): Promise<ZipRead> {
  return new Promise((resolve, reject) => {
    yauzl.open(file, { lazyEntries: true }, (openError, zip) => {
      if (openError || !zip) {
        reject(openError ?? new Error('Could not open the ZIP file.'))
        return
      }
      const contents: string[] = []
      const names: string[] = []
      zip.on('error', reject)
      zip.on('end', () => resolve({ contents, names }))
      zip.on('entry', (entry: yauzl.Entry) => {
        names.push(entry.fileName)
        if (!wanted.test(entry.fileName) || entry.uncompressedSize > MAX_JSON_BYTES) {
          zip.readEntry()
          return
        }
        zip.openReadStream(entry, (streamError, stream) => {
          if (streamError || !stream) {
            reject(streamError ?? new Error('Could not read the ZIP file.'))
            return
          }
          const chunks: Buffer[] = []
          stream.on('data', (chunk: Buffer) => chunks.push(chunk))
          stream.on('error', reject)
          stream.on('end', () => {
            contents.push(Buffer.concat(chunks).toString('utf8'))
            zip.readEntry()
          })
        })
      })
      zip.readEntry()
    })
  })
}

function parseAll(texts: string[]): unknown[] {
  const all: unknown[] = []
  for (const text of texts) {
    let parsed: unknown
    try {
      parsed = JSON.parse(text)
    } catch {
      continue
    }
    if (Array.isArray(parsed)) all.push(...parsed)
    else if (parsed && typeof parsed === 'object' && Array.isArray((parsed as { conversations?: unknown }).conversations)) {
      all.push(...(parsed as { conversations: unknown[] }).conversations)
    }
  }
  return all
}

async function readGeminiZip(file: string): Promise<unknown[]> {
  const first = await readZipEntries(file, GEMINI_ACTIVITY_FILE)
  if (first.contents.length > 0) return parseAll(first.contents)
  // The usual path was not there. If the activity came as HTML, say exactly what to change.
  if (first.names.some((name) => GEMINI_ACTIVITY_HTML.test(name))) {
    throw new Error(
      'This Takeout archive holds your Gemini activity as HTML, which cannot be imported. Request the export again and, under My Activity, set "Activity records" to JSON.',
    )
  }
  // Last resort: look inside every JSON file for Gemini activity records.
  const every = await readZipEntries(file, ANY_JSON)
  const records = every.contents
    .map((text) => parseAll([text]))
    .filter((list) => detectExport(list) === 'gemini')
    .flat()
  if (records.length > 0) return records
  throw new Error(
    'No Gemini activity was found in that ZIP. In Google Takeout tick My Activity, keep only Gemini Apps inside it, and set "Activity records" to JSON. (The separate "Gemini" entry in Takeout holds Gems, not chats.)',
  )
}

async function readExport(provider: Provider, file: string): Promise<unknown[]> {
  if (!/\.zip$/i.test(file)) return parseAll([await fs.promises.readFile(file, 'utf8')])
  if (provider === 'gemini') return readGeminiZip(file)
  const { contents } = await readZipEntries(file, CONVERSATIONS_FILE)
  if (contents.length === 0) {
    throw new Error(
      `No conversations.json was found in that ZIP file. Use the ZIP that ${provider === 'claude' ? 'Claude' : 'ChatGPT'} emailed you, unchanged.`,
    )
  }
  return parseAll(contents)
}

export async function importExport(store: Store, provider: Provider, file: string): Promise<ImportResult> {
  const result: ImportResult = { provider, found: 0, imported: 0, updated: 0, skipped: 0, errors: [] }
  let data: unknown[]
  try {
    data = await readExport(provider, file)
  } catch (error) {
    result.errors.push(error instanceof Error ? error.message : String(error))
    return result
  }

  const parsed = parseExport(provider, data)
  result.found = parsed.found
  result.errors.push(...parsed.errors)
  const model = store.getSettings().defaultModel[provider]

  for (const conversation of parsed.conversations) {
    conversation.model = model
    const existing = store.getMeta(conversation.id)
    if (existing) {
      // Imported before. Refresh it only if the export is newer and the local
      // copy was never continued here (continuing adds cost).
      const untouched = existing.costUsd === 0 && existing.messageCount <= conversation.messages.length
      if (untouched && conversation.updatedAt > existing.updatedAt) {
        conversation.pinned = existing.pinned
        conversation.projectId = existing.projectId
        store.saveConversation(conversation, { deferIndex: true })
        result.updated += 1
      } else {
        result.skipped += 1
      }
      continue
    }
    store.saveConversation(conversation, { deferIndex: true })
    result.imported += 1
  }
  store.flushIndex()
  result.skipped += parsed.found - parsed.conversations.length
  return result
}
