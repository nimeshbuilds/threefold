import { describe, expect, it } from 'vitest'
import { detectExport, htmlToMarkdown, parseExport, parseGeminiActivity } from '../src/main/importers'
import { geminiTokens } from '../src/main/providers/gemini'

describe('geminiTokens', () => {
  it('separates cached prompt tokens and bills tool results as input', () => {
    const tokens = geminiTokens({
      promptTokenCount: 1000,
      cachedContentTokenCount: 400,
      toolUsePromptTokenCount: 50,
      candidatesTokenCount: 200,
      thoughtsTokenCount: 300,
    })
    expect(tokens).toEqual({ inputTokens: 650, cacheReadTokens: 400, cacheWriteTokens: 0, outputTokens: 500 })
  })

  it('treats missing counts as zero and never reports negative input', () => {
    expect(geminiTokens(undefined)).toEqual({ inputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 0 })
    expect(geminiTokens({ promptTokenCount: 10, cachedContentTokenCount: 50 }).inputTokens).toBe(0)
  })
})

describe('htmlToMarkdown', () => {
  it('converts the common tags Takeout uses', () => {
    const html =
      '<h2>Plan</h2><p>Use <strong>pnpm</strong> and <em>Vitest</em>.</p><ul><li>one</li><li>two</li></ul>' +
      '<pre><code>const a = 1 &lt; 2</code></pre><p>See <a href="https://example.com">the docs</a> &amp; more.</p>'
    const text = htmlToMarkdown(html)
    expect(text).toContain('## Plan')
    expect(text).toContain('Use **pnpm** and *Vitest*.')
    expect(text).toContain('- one\n- two')
    expect(text).toContain('```\nconst a = 1 < 2\n```')
    expect(text).toContain('[the docs](https://example.com) & more.')
  })

  it('drops scripts and decodes numeric entities', () => {
    expect(htmlToMarkdown('<script>alert(1)</script><p>caf&#233; &#x1F600;</p>')).toBe('café 😀')
  })
})

function activity() {
  // Takeout lists the newest record first.
  return [
    { header: 'Gemini Apps', title: 'Used Gemini Apps', time: '2026-05-02T09:00:00.000Z', products: ['Gemini Apps'] },
    {
      header: 'Gemini Apps',
      title: 'Prompted And in winter?',
      time: '2026-05-01T10:05:00.000Z',
      products: ['Gemini Apps'],
      safeHtmlItem: [{ html: '<p>Colder, around <b>5°C</b>.</p>' }],
    },
    {
      header: 'Gemini Apps',
      title: 'Prompted What is the weather like in Oslo?',
      time: '2026-05-01T10:00:00.000Z',
      products: ['Gemini Apps'],
      safeHtmlItem: [{ html: '<p>Mild in summer.</p>' }],
    },
    {
      header: 'Gemini Apps',
      title: 'Prompted Write a haiku about rain',
      time: '2026-04-20T08:00:00.000Z',
      products: ['Gemini Apps'],
      safeHtmlItem: [{ html: '<p>Soft rain on the roof</p>' }],
    },
  ]
}

describe('parseGeminiActivity', () => {
  it('groups prompts that were close in time into one chat, oldest first', () => {
    const result = parseGeminiActivity(activity())
    expect(result.found).toBe(4)
    expect(result.conversations).toHaveLength(2)
    const [haiku, oslo] = result.conversations
    expect(haiku!.title).toBe('Write a haiku about rain')
    expect(oslo!.title).toBe('What is the weather like in Oslo?')
    expect(oslo!.messages.map((m) => m.role)).toEqual(['user', 'assistant', 'user', 'assistant'])
    expect(oslo!.messages[3]!.text).toBe('Colder, around **5°C**.')
    expect(oslo!.provider).toBe('gemini')
    expect(oslo!.origin).toBe('gemini-export')
  })

  it('gives each chat a stable id so a second import does not duplicate it', () => {
    const first = parseGeminiActivity(activity()).conversations.map((c) => c.id)
    const second = parseGeminiActivity(activity()).conversations.map((c) => c.id)
    expect(second).toEqual(first)
    expect(first[0]).toMatch(/^imp-gemini-\d+$/)
  })

  it('keeps a prompt whose reply was not saved, and skips records that are not prompts', () => {
    const result = parseGeminiActivity([
      { header: 'Gemini Apps', title: 'Prompted Hello', time: '2026-01-01T00:00:00Z' },
      { header: 'Gemini Apps', title: 'Created a Gem', time: '2026-01-01T00:01:00Z' },
      'junk',
    ])
    expect(result.conversations).toHaveLength(1)
    expect(result.conversations[0]!.messages).toHaveLength(1)
  })

  it('is detected and routed by parseExport, and refused in the wrong mode', () => {
    expect(detectExport(activity())).toBe('gemini')
    expect(parseExport('gemini', activity()).conversations).toHaveLength(2)
    expect(parseExport('claude', activity()).errors[0]).toMatch(/Gemini export/)
  })
})
