// Reads a ChatGPT or Claude data export (the ZIP as downloaded, or the
// conversations.json inside it) and saves the conversations locally.

import fs from 'node:fs'
import yauzl from 'yauzl'
import type { ImportResult, Provider } from '@shared/types'
import { parseExport } from './importers'
import type { Store } from './store'

const CONVERSATIONS_FILE = /(^|\/)conversations(-\d+)?\.json$/i
/** Google Takeout: Takeout/My Activity/Gemini Apps/MyActivity.json */
const GEMINI_ACTIVITY_FILE = /(^|\/)Gemini[^/]*\/My ?Activity\.json$/i
const MAX_JSON_BYTES = 1_500_000_000

function readZipEntries(file: string, wanted: RegExp): Promise<string[]> {
  return new Promise((resolve, reject) => {
    yauzl.open(file, { lazyEntries: true }, (openError, zip) => {
      if (openError || !zip) {
        reject(openError ?? new Error('Could not open the ZIP file.'))
        return
      }
      const contents: string[] = []
      zip.on('error', reject)
      zip.on('end', () => resolve(contents))
      zip.on('entry', (entry: yauzl.Entry) => {
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

async function readExport(provider: Provider, file: string): Promise<unknown[]> {
  const wanted = provider === 'gemini' ? GEMINI_ACTIVITY_FILE : CONVERSATIONS_FILE
  const texts = /\.zip$/i.test(file) ? await readZipEntries(file, wanted) : [await fs.promises.readFile(file, 'utf8')]
  if (texts.length === 0) {
    throw new Error(
      provider === 'gemini'
        ? 'No Gemini activity file was found in that ZIP. In Google Takeout choose My Activity, keep only Gemini Apps, and set the format to JSON.'
        : 'No conversations.json was found in that ZIP file.',
    )
  }
  const all: unknown[] = []
  for (const text of texts) {
    const parsed: unknown = JSON.parse(text)
    if (Array.isArray(parsed)) all.push(...parsed)
    else if (parsed && typeof parsed === 'object' && Array.isArray((parsed as { conversations?: unknown }).conversations)) {
      all.push(...(parsed as { conversations: unknown[] }).conversations)
    }
  }
  return all
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
