# Twofold brand

**Twofold** is a local desktop app with two modes, one for Claude and one for ChatGPT, that runs on your own API keys and shows what every message costs.

## Name

"Twofold" means double: two assistants in one app, and twice the use out of a subscription (the app for everyday work, the API credits through Twofold). It is one word, capital T, never "TwoFold" or "2fold".

Tagline: **Two assistants. One local app. Your own API credits.**

Short description (under 120 characters): *A local Mac app for Claude and ChatGPT that runs on your API keys and shows the cost of every message live.*

## The mark

Two overlapping rounded sheets. The left sheet is Ember, the right is Ink, and the overlap shows through in a lighter tone. The two sheets are the two modes; the overlap is the one app they share.

| File | Use |
|---|---|
| `twofold-mark.svg` | The mark on light backgrounds |
| `twofold-mark-on-dark.svg` | The mark on dark backgrounds |
| `twofold-wordmark.svg` | Mark plus name, for headers and the README |
| `twofold-icon.svg` | App icon source (1024 px, macOS icon grid) |
| `twofold-icon-512.png` | Rendered icon for listings and social cards |

Regenerate the app icon (`build/icon.icns`, `build/icon.png`) with `pnpm icons`.

Rules for the mark:

- Keep clear space of at least one quarter of the mark's width on every side.
- Do not recolour the sheets, rotate the mark, add effects, or separate the sheets.
- Minimum size 16 px. Below 24 px use the mark alone, without the name.

## Colour

| Name | Hex | Role |
|---|---|---|
| Ember | `#C2571A` | Brand accent, the left sheet, live cost indicators, the credit meter |
| Ink | `#1F2430` | The right sheet, wordmark, toasts |
| Paper | `#F7F4EC` | Icon background, Claude mode canvas |
| Fold | `#F2C9A8` | The overlap in the mark |

Ember always means "money is being spent right now": the pulsing dot, the live cost figure, the meter bar. Do not use it for decoration elsewhere in the interface.

### Mode palettes

Each mode has its own canvas so you always know which API a message will go to. The full token list is in `src/renderer/src/styles/tokens.css`.

| | Claude mode | ChatGPT mode |
|---|---|---|
| Light canvas | `#F7F4EC` warm paper | `#FFFFFF` white |
| Dark canvas | `#262522` warm charcoal | `#1E1F22` neutral charcoal |
| Accent | `#B4541A` rust (light), `#E08A4F` (dark) | `#18181B` ink (light), `#F2F2F3` (dark) |
| Reading face | System serif (New York) | System sans (SF Pro) |
| Corner style | Soft rectangles (18 px composer) | Pills (26 px composer, round buttons) |

## Type

Twofold uses the fonts already on the Mac and ships none of its own.

- Interface: SF Pro (`-apple-system`)
- Claude mode headings and replies: the system serif (`ui-serif`, New York)
- Code: SF Mono (`ui-monospace`)

## Voice

- Plain and specific. Say what a thing costs, not that it is "affordable".
- Never hide a number. If a figure is an estimate, mark it with "≈" and say so.
- No hype and no exclamation marks. The app is a tool.
- Sentence case everywhere: "New chat", "Import history".

## What Twofold must never look like

Twofold is independent. It is not made by, affiliated with or endorsed by Anthropic or OpenAI.

- Never use the Claude or ChatGPT logos, icons, app icons, or brand artwork.
- Use the words "Claude" and "ChatGPT" only as plain text to name a mode or an API, never in the product name, the icon, or a headline that could read as an official product.
- Always include the independence statement wherever the app is described (README, About screen, store listings).
