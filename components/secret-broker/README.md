# secret-broker — AI-OS Pro native component #1

Let your AI-OS **use** a credential without ever seeing it.

You register a password, API key, or token once in your OS keyring. Your skills
refer to it only by a **handle** — `secret://gmail-app-password` — never the value.
A tiny local helper (`~/ai-os/bin/secret`) holds nothing itself; it asks the
keyring to *act* on your behalf and hands back **only the result**.

## The honest guarantee

**What this promises:**
- The **AI never handles the raw value** — the interface has no verb that returns a
  stored secret. The helper acts (sends the email, makes the authed call) and
  returns outcomes only. This is true by construction, not by asking nicely.
- The secret is **not in your chat and not in your logs** — stored out-of-band,
  and the audit log records metadata only (which handle, which action, which host).
- **Encrypted at rest** by your OS keyring (macOS Keychain / Linux Secret Service).
- **Revocable** any time.

**What it does *not* promise — and we won't let the copy say otherwise:**
- **Not** "impossible to exfiltrate." This ships **no sandbox**. A program running
  as you, on your machine, can in principle reach your keyring. The guarantee is
  *out of the AI's reach and out of your logs* — **not** enforced isolation.

## Install

```sh
./install.sh          # copies the broker to ~/ai-os/bin/secret
```

Requires an OS keyring: macOS Keychain (built in) or, on Linux, the Secret Service
(`gnome-keyring` + `libsecret-tools`, i.e. the `secret-tool` command). Windows
Credential Manager support is a fast follow. A headless encrypted-file fallback is
planned but **not** in this build — the installer warns you if no keyring is found.

## Store a credential (two ways, both keep it off the transcript)

1. **OS keyring app (recommended):** add an entry under service `ai-os`, account
   `<name>` in Keychain Access / Passwords / Credential Manager.
2. **Terminal, no echo:** `~/ai-os/bin/secret set secret://<name>` — prompts you
   with hidden input. The AI never sees the value; it only tells you the command.

## Use it

```sh
# send email with a stored SMTP app password
~/ai-os/bin/secret send-email secret://gmail-app-password \
    --from you@gmail.com --to someone@example.com --subject "hi" --body "hello"

# authed HTTP call, injecting the secret as a bearer token
~/ai-os/bin/secret fetch secret://weather-api-key \
    --url https://api.example.com/v1/data --inject bearer

# list handles (names only, never values) · revoke one
~/ai-os/bin/secret list
~/ai-os/bin/secret revoke secret://weather-api-key
```

`send-email` and `fetch --method POST` are outbound writes — your AI-OS proposes
them and waits for your OK (Ask mode).

## Verbs

`set` · `send-email` · `fetch` · `list` · `revoke`. There is deliberately **no**
verb that returns a stored value.

## Tests

```sh
python3 tests/test_secret.py
```

Runs on any box (keyring + SMTP stubbed, `fetch` hits a local server). Proves the
interface, both actions, the metadata-only audit, the no-`get` guarantee, and the
zero-leak property. The native `security`/`secret-tool` calls must be
live-validated on a machine with a real keyring.

## Files

- `secret` — the broker (Python 3 stdlib, zero pip dependencies)
- `skill/secret.md` — the `/secret` skill fragment for your AI-OS build
- `convention.txt` — the agent-facing secrets convention line
- `tests/test_secret.py` — validation suite
