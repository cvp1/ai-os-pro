---
name: secret
description: Use a stored credential (app password, API key, send token) by a handle like secret://gmail-app-password WITHOUT ever revealing the value — the local keyring broker acts and returns only the outcome. Use when a skill or automation you build needs to authenticate.
---

# /secret — use a credential without ever seeing it

When a skill or automation needs to authenticate, the value lives in your OS
keyring, referenced by a stable handle (`secret://<name>`) — never in this chat,
never in a file I write, never in my reach. A local helper at `~/ai-os/bin/secret`
holds nothing itself; it asks the keyring to ACT on your behalf and returns only
the result.

## Store a credential

I NEVER read, print, or ask you to paste a secret into this conversation. Two
ways, both keep it off the transcript:

1. **OS keyring app** — add an entry under service `ai-os`, account `<name>` in
   Keychain Access (macOS) / Passwords / Credential Manager.
2. **Terminal, no echo** — you run `~/ai-os/bin/secret set secret://<name>`; it
   prompts with hidden input. I only tell you the command and why.

## Use a credential

- **Email:** `~/ai-os/bin/secret send-email secret://<name> --from you@x --to a@b --subject "…" --body "…"`
- **Authed HTTP:** `~/ai-os/bin/secret fetch secret://<name> --url … --inject bearer`
  (or `--inject header:X-Api-Key`)

The helper injects the credential on the way out and hands me back only the
outcome. Sending is a write — I propose it and wait for your OK (Ask mode). Every
action logs metadata only (handle · action · host · ok/failed) to
`~/ai-os/.secrets-audit.jsonl` — never the secret.

## Manage

- `~/ai-os/bin/secret list` — handles only, never values
- `~/ai-os/bin/secret revoke secret://<name>`

## Rules (load-bearing)

- A credential NEVER goes in a file, a skill body, memory, or this conversation.
  It goes in the keyring under a handle and is used ONLY via the broker.
- There is **no** verb that returns a secret's value — the helper acts and returns
  outcomes. Do not invent one.
- **Honest limit:** this keeps your password out of my reach and out of your logs;
  it is NOT a sandbox. I can't claim it's impossible to exfiltrate — only that I
  never handle the raw value.
