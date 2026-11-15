# Threefold brand

**Threefold** is a local desktop app with three modes, one each for Claude, ChatGPT and Gemini, that runs on your own API keys and shows what every message costs.

## Name

"Threefold" carries two meanings, and both are true of the product:

- **Three assistants in one app.** Claude mode, ChatGPT mode and Gemini mode.
- **An answer in three steps.** In the Threefold review tab one model drafts, the others review, and the first writes the final reply.

It is one word, capital T: never "ThreeFold", "3fold" or "Threefolds".

Tagline: **Three assistants. One local app. Your own API credits.**

Short description (under 120 characters): *A local Mac app for Claude, ChatGPT and Gemini that runs on your API keys and shows every message's cost live.*

> **Name check.** There is an existing, unrelated technology project called ThreeFold (threefold.io, decentralized cloud infrastructure, with some AI products). No trademark search has been done. Get advice before using this name commercially or registering it.

## The mark

Three overlapping rounded sheets: Ember on the left, Tide on the right and Ink raised in the middle, with the overlaps showing through in lighter tones. The sheets are the three modes; the overlaps are the one app they share.

| File | Use |
|---|---|
| `threefold-mark.svg` | The mark on light backgrounds |
| `threefold-mark-on-dark.svg` | The mark on dark backgrounds |
| `threefold-wordmark.svg` | Mark plus name, for headers and the README |
| `threefold-icon.svg` | App icon source (1024 px, macOS icon grid) |
| `threefold-icon-512.png` | Rendered icon for listings and social cards |

Regenerate the app icon (`build/icon.icns`, `build/icon.png`) with `pnpm icons`.

Rules for the mark:

- Keep clear space of at least one quarter of the mark's width on every side.
- Do not recolour the sheets, rotate the mark, add effects, reorder or separate the sheets.
- Minimum size 16 px. Below 24 px use the mark alone, without the name.

## Colour

| Name | Hex | Role |
|---|---|---|
| Ember | `#C2571A` | The left sheet. Brand accent, live cost indicators, the credit meter |
| Ink | `#1F2430` | The middle sheet. Wordmark, toasts |
| Tide | `#3B63D9` | The right sheet. Gemini mode accent |
| Paper | `#F7F4EC` | Icon background, Claude mode canvas. Not a background for the website |
| Warm fold | `#F2C9A8` | The Ember and Ink overlap |
| Cool fold | `#C9D6F7` | The Ink and Tide overlap |

Ember always means "money is being spent right now": the pulsing dot, the live cost figure, the meter bar, the billing notice in the Threefold review tab. Do not use it for decoration elsewhere in the interface.

In lists of models, a small dot shows which provider bills for it: Ember for Claude, Ink for ChatGPT, Tide for Gemini.

### The website

The website (`docs/`) shows Threefold's own colours, not any one mode's.

- **White canvas.** Not Paper, which is the canvas of Claude mode inside the app.
- **Three primaries, used together:** Ember, Ink and Tide. The headline's three lines take them in the order of the sheets, a bar of the three runs across the top of the page, and the same three name the providers on cards and dots. Buttons and the selected tab are Ink. Links are Tide.
- **Two secondaries, as tints:** Warm fold and Cool fold colour alternate sections, lightened, and sit behind the headline as two soft sheets. Each tinted section leans on the sheet next to its fold for bullets, numbers and notes: Ember on warm, Tide on cool.
- **The closing section is a band of Ink.**
- **Sans-serif headings.** The serif belongs to Claude mode in the app.

A page built on Paper with a serif and Ember alone reads as another company's product. The mark has five colours; the website uses all five.

### Mode palettes

Each mode has its own canvas so you always know which API a message will go to. The full token list is in `src/renderer/src/styles/tokens.css`.

| | Claude mode | ChatGPT mode | Gemini mode |
|---|---|---|---|
| Light canvas | `#F7F4EC` warm paper | `#FFFFFF` white | `#F8FAFD` cool white |
| Dark canvas | `#262522` warm charcoal | `#1E1F22` neutral charcoal | `#16181D` blue-black |
| Accent | `#B4541A` rust | `#18181B` ink | `#3B63D9` tide |
| Reading face | System serif (New York) | System sans (SF Pro) | System sans (SF Pro) |
| Corner style | Soft rectangles (18 px composer) | Pills (26 px composer) | Rounder pills (30 px composer) |

## Type

Threefold uses the fonts already on the Mac and ships none of its own.

- Interface: SF Pro (`-apple-system`)
- Claude mode headings and replies: the system serif (`ui-serif`, New York)
- Code: SF Mono (`ui-monospace`)

## Voice

- Plain and specific. Say what a thing costs, not that it is "affordable".
- Never hide a number. If a figure is an estimate, mark it with "≈" and say so.
- Say who gets billed. Wherever more than one provider is involved, name each one.
- No hype and no exclamation marks. The app is a tool.
- Sentence case everywhere: "New chat", "Import history".

## Credit

Threefold is built in public by Nimesh under NimeshBuilds (https://github.com/nimeshbuilds). The app carries a small credit at the bottom of the sidebar and a fuller one in Settings → About, each with the NimeshBuilds mark and a link to the organisation. Keep the credit quiet: muted text, the mark at 22 px or smaller in the sidebar, and no more than one per screen. The NimeshBuilds mark is used as supplied, never recoloured or combined with the Threefold mark.

## What Threefold must never look like

Threefold is independent. It is not made by, affiliated with or endorsed by Anthropic, OpenAI or Google.

- Never use the Claude, ChatGPT or Gemini logos, icons, app icons, or brand artwork.
- Use the words "Claude", "ChatGPT" and "Gemini" only as plain text to name a mode or an API, never in the product name, the icon, or a headline that could read as an official product.
- Always include the independence statement wherever the app is described (README, About screen, website, store listings).
