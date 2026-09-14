# Security policy

## Reporting a vulnerability

Please **do not open a public issue**. Use GitHub's private vulnerability reporting —
the **Security** tab → **Report a vulnerability** — and you will get a reply.

Include what you did, what happens, and what an attacker gains. A proof of concept helps;
please do not test against anyone's data but your own.

## What is in scope

Neo is a desktop client of Neo Cloud. Everything you make is stored in your Neo Cloud
account, and the only thing kept on the machine is the sign-in, sealed in the OS
keychain. So the interesting surface is what can reach the main process, and what can
reach somebody else's account:

- The IPC bridge between renderer and main (`src/preload/`, `src/shared/api.ts`) — the
  renderer has `contextIsolation` on and no Node integration, and everything crosses
  through a single typed `invoke`. A way around that is a finding.
- Anything that lets rendered content — a note, a Markdown file, a filename, an assistant
  reply — execute code or reach the filesystem.
- The device token: a way for the renderer to read it, for it to be written anywhere but
  the sealed session file, or for it to be sent anywhere but Neo Cloud.
- The assistant's tools (`src/main/lib/ai/tools.ts`): a write that happens without the
  confirmation step, or a read that crosses a workspace boundary, is a finding. So is
  prompt-injected content in a note or an attachment causing either.
- Anything that exposes the OpenAI API key stored on a workspace. It is kept in Neo
  Cloud, used there and by the main process, and the renderer is only ever told whether
  one is set. A way for the *renderer* to read it back, or for it to reach anywhere other
  than OpenAI and Neo Cloud, is a finding.
- Anything that lets one Neo Cloud account read or change another's work or files
  (`neo-sync-server`).

## What is not

- **The fact that Neo Cloud can read what you store in it.** It is not end-to-end
  encrypted: the server stores your work as rows so that it can be queried, searched
  and summarised. That is a documented trade for now rather than a flaw.
- Someone with your logged-in machine being able to use Neo as you. The sign-in is the
  only thing on it, and a lost Mac is signed out from Settings → Account → Devices.
- Content you deliberately send to OpenAI by typing a question into the assistant.

## Supported versions

The latest release on `main`. This is a personal project maintained in spare time — fixes
land there rather than being backported.
