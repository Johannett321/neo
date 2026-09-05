# Security policy

## Reporting a vulnerability

Please **do not open a public issue**. Use GitHub's private vulnerability reporting —
the **Security** tab → **Report a vulnerability** — and you will get a reply.

Include what you did, what happens, and what an attacker gains. A proof of concept helps;
please do not test against anyone's data but your own.

## What is in scope

Neo is a local desktop application. It has no server, no account and no network service,
so the interesting surface is small and mostly about what can reach the main process:

- The IPC bridge between renderer and main (`src/preload/`, `src/shared/api.ts`) — the
  renderer has `contextIsolation` on and no Node integration, and everything crosses
  through a single typed `invoke`. A way around that is a finding.
- Anything that lets rendered content — a note, a Markdown file, a filename, an assistant
  reply — execute code or reach the filesystem.
- The assistant's tools (`src/main/lib/ai/tools.ts`): a write that happens without the
  confirmation step, or a read that crosses a workspace boundary, is a finding. So is
  prompt-injected content in a note or an attachment causing either.
- Anything that exposes the OpenAI API key stored on a workspace. It lives in the local
  database, never leaves the main process, and the renderer is only ever told whether one
  is set.

## What is not

- Reading the local database or data folder. It is a plain, unencrypted folder in your
  Documents that you own; someone with your logged-in machine already has your files.
- The absence of encryption at rest, application passwords, or multi-user permissions.
  Single-user local software is the design.
- Content you deliberately send to OpenAI by typing a question into the assistant.

## Supported versions

The latest release on `main`. This is a personal project maintained in spare time — fixes
land there rather than being backported.
