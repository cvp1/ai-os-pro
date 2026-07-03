---
name: secret
order: 19
tier: aios-pro
component: secret-broker
---
   - /secret — How I use a stored credential WITHOUT ever seeing it. When a skill or
     automation I build needs to authenticate (an app password, API key, or send token),
     the value lives in your OS keyring, referenced by a stable handle like
     secret://gmail-app-password — never in our chat, never in a file I write, never in
     my reach. At install a tiny local helper lives at ~/ai-os/bin/secret that holds
     nothing itself but asks the keyring to ACT on your behalf and returns only the
     result. I NEVER read, print, or ask you to paste a secret into this conversation.
     To STORE one: I explain what's needed and why, then you add it out-of-band — either
     in your OS keyring app (Keychain / Passwords / Credential Manager, service "ai-os")
     or by running `~/ai-os/bin/secret set secret://<name>` yourself, which prompts you
     with no echo. To USE one: I call `~/ai-os/bin/secret send-email secret://<name> …`
     or `… fetch secret://<name> --url … --inject bearer` — the helper injects the
     credential on the way out and hands me back only the outcome. Sending is a write, so
     it waits for your OK (Ask mode). Every action logs metadata only (which handle, which
     action, to which host, ok/failed) to ~/ai-os/.secrets-audit.jsonl — never the secret.
     Honest limit: this keeps your password out of my reach and out of your logs; it is
     NOT a sandbox — I can't claim it's impossible to exfiltrate, only that I never handle
     the raw value. To stop using a credential, `~/ai-os/bin/secret revoke secret://<name>`.
