---
name: threefolds
description: Writes a handoff summary of the current conversation so it can be continued in another assistant or in the Threefold app without exporting chat history. Use when the user types "threefolds" or "/threefolds", or asks for a handoff summary, or wants to hand off, move, transfer or continue this conversation somewhere else.
---

# Writing a Threefold handoff

Write a handoff summary of this whole conversation, so that a different assistant with no access to it can pick up exactly where it stops. The user will paste your summary into another app, such as Threefold, and keep working there.

## What to reply

Reply with the handoff and nothing else: no greeting and no explanation before it. Do not continue the task and do not ask questions. Use exactly the layout below. Keep the first line and the "end of handoff" line as they are, because the receiving app looks for them.

```
# Threefold handoff

- **Title:** a short title for this conversation, under 60 characters
- **From:** your name and model if you know it, for example "Claude Opus" or "ChatGPT"
- **Date:** today's date if you know it

## Goal
What the user is trying to achieve, in one or two sentences.

## Background
The facts, constraints and preferences the user gave that still matter, as bullet points.

## What has been done
The decisions made and the work completed so far, in order. Give the reason for a decision where the reason matters.

## Current state
Where things stand right now. Include the latest version of anything being worked on (a text, code, a plan, a table) in full when it is under about 150 lines. When it is longer, include the parts that matter and describe the rest.

## Open questions and next steps
What is unresolved, what the user asked for last, and what should happen next.

## Details to keep
Exact names, numbers, dates, links, file names, commands and wording that must not be lost or paraphrased.

## How to work with this user
The tone, format, language and level of detail they prefer, and anything they asked you not to do.

--- end of handoff ---
```

## Rules

- Cover the whole conversation, not only the last few messages. Give the most room to what is recent and unresolved.
- Be specific and faithful. Do not invent anything. If something is uncertain or was never settled, say so.
- Make it self-contained. The reader cannot see this conversation, its files or its images, so describe any that matter by name and by what they contain.
- Leave out secrets. Replace passwords, API keys, tokens and card numbers with `[redacted]`.
- Keep every section. If a section has nothing to say, write "None."
- Be as long as the conversation needs: usually 300 to 1,200 words, plus any work in progress that you include in full.
- Write in the language the user has been using.
- After the "end of handoff" line, add one sentence telling the user to copy this message and paste it into the app they are moving to.
