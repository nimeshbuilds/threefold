---
name: threefolds
description: Writes a handoff summary of the current conversation so it can be continued in another assistant or in the Threefold app without exporting chat history, and can pass it straight into Threefold when that app is installed on this Mac. Use when the user types "threefolds" or "/threefolds", or asks for a handoff summary, or wants to hand off, move, transfer or continue this conversation somewhere else. Also use when the user asks to install, download, set up or update the Threefold app.
---

# Writing a Threefold handoff

Write a handoff summary of this whole conversation, so that a different assistant with no access to it can pick up exactly where it stops. The user will take your summary into another app, such as Threefold, and keep working there.

## What to reply

Reply with the handoff: no greeting and no explanation before it. Do not continue the task and do not ask questions about it. Use exactly the layout below. Keep the first line and the "end of handoff" line as they are, because the receiving app looks for them.

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
- Stop at the "end of handoff" line. What comes after it is described under "Passing it on".

## Passing it on

After the "end of handoff" line, finish in one of two ways. In both, NAME stands for you: write `claude` if you are Claude, `chatgpt` if you are ChatGPT or Codex, and `gemini` if you are Gemini.

**If you can run shell commands on the user's own computer** (for example in Claude Code, Codex or Gemini CLI; a sandbox in the cloud does not count), find out before you write the handoff whether the Threefold app is installed:

```
ls -d /Applications/Threefold.app ~/Applications/Threefold.app 2>/dev/null
```

If that prints a path, write the handoff as described above and then ask, after the "end of handoff" line: "Threefold is installed on this Mac. Shall I open it and pass this handoff in?" Then stop and wait. Only if the user says yes:

1. Save the handoff, from its first line to the "end of handoff" line and nothing else, as a new file in the folder `~/Library/Application Support/Threefold/inbox/`. Create the folder if it is missing. Name the file `handoff-`, then the date and time in digits, then `.md`: for example `handoff-20260115-143000.md`.
2. Run `open "threefold://handoff?from=NAME"`.
3. Tell the user that Threefold is showing the handoff and is waiting for them to choose where to continue. If a step failed, say which one, and tell them to copy the handoff and paste it into Threefold under File > Continue from a Handoff.

**In every other case** (you cannot run commands, the check printed nothing, or it failed), add one sentence after the "end of handoff" line. It tells the user to copy this message, and then either to paste it into the app they are moving to, or to open https://nimeshbuilds.github.io/threefold/open/?from=NAME to send it to Threefold. If you ran the check and it printed nothing, add that Threefold is not installed on this Mac and that you can install it if they ask.

Use the command and the link exactly as they are written here, changing only NAME. Never add anything else to them, and never put any part of the handoff or of the conversation into a link, a web address or a command. The handoff travels only as the text of your reply or as the saved file.

## Installing Threefold

Follow this section only when the user asks you to install, download, set up or update the Threefold app. Do it instead of writing a handoff.

Threefold is a free Mac app with public source code at https://github.com/nimeshbuilds/threefold. The ready-made app needs a Mac with Apple Silicon and macOS 13 or later. It is not signed with an Apple Developer ID and it is not notarized, which means Apple has not checked it.

**If you cannot run shell commands on the user's own computer**, do not act as if you had installed anything. Give the user this link: https://nimeshbuilds.github.io/threefold/#start. Tell them that the quick start there has the download, and that because the app is not signed by Apple they have to allow it once under System Settings > Privacy & Security, as the page describes.

**If you can**, go through these steps in order and stop at the first one that fails, telling the user what happened:

1. Check the Mac. `uname -m` must print `arm64`, and `sw_vers -productVersion` must print 13 or higher. If not, say that the ready-made app does not run on this Mac, point to "Build it from source" at the link above, and stop.
2. Ask first. Tell the user all of this, in plain words: the app is not signed by Apple or notarized, so Apple has not checked it; installed this way, macOS does not show its usual warning for an app from an unidentified developer, so they should go ahead only if they trust the project; the download is about 290 MB; it goes into the Applications folder. Then ask whether to go ahead, and wait for a yes.
3. Download the app and its checksum into a new, empty temporary folder with `curl -fL -O`, from these two addresses and no others:
   - https://github.com/nimeshbuilds/threefold/releases/latest/download/Threefold-mac-arm64.zip
   - https://github.com/nimeshbuilds/threefold/releases/latest/download/Threefold-mac-arm64.zip.sha256
4. Check the download. In that folder, `shasum -a 256 -c Threefold-mac-arm64.zip.sha256` must print `OK`.
5. Unpack it with `ditto -x -k Threefold-mac-arm64.zip .` and check what came out. `codesign --verify --deep --strict Threefold.app` must succeed, and `plutil -extract CFBundleIdentifier raw Threefold.app/Contents/Info.plist` must print `dev.nimeshbuilds.threefold`.
6. Put it in place. Use `/Applications`, or `~/Applications` (create it) if `/Applications` cannot be written to without a password. If a `Threefold.app` is already there, ask the user to quit Threefold, then move the old copy to the Trash with `mv`, under a name that is not taken; the user's chats and saved keys live elsewhere and are kept. Then move the new `Threefold.app` in with `mv`.
7. Open it with `open` followed by the path of the installed app, and delete the temporary folder. Tell the user that a short wizard opens in which they connect their own API keys, and that the `threefolds` skill can be added to their other assistants under Settings > Handoff skill.

Limits that have no exceptions:

- Never use `sudo`. Never ask for, or type, the user's password.
- Never change a system or security setting. Do not turn off Gatekeeper, do not touch System Settings, and do not remove quarantine or any other attribute from a file.
- If macOS blocks the app all the same, do not work around it. Send the user to the quick start at the link above, which has Apple's own steps for allowing an app.
- Never ask for, read or handle the user's API keys. Only the user enters them, in the app itself.
- Download only from the two addresses above, and run nothing else that comes from the internet.
