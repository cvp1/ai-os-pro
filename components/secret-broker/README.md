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
./install.sh
```

This installs the broker to `~/ai-os/bin/secret`, **registers the `/secret` skill**
at `~/.claude/skills/secret/SKILL.md`, adds the secrets convention to your AI-OS
`CLAUDE.md` if it finds one, and checks for a keyring. **Start a fresh Claude Code
session afterward** so `/secret` registers. Override locations with `AIOS_HOME` /
`CLAUDE_SKILLS_DIR`.

**Preferred store: an OS keyring** — macOS Keychain (built in) or, on Linux, the
Secret Service (`gnome-keyring` + `libsecret-tools`, i.e. the `secret-tool`
command). Windows Credential Manager support is a fast follow.

**Headless fallback (no keyring):** set `AIOS_SECRET_STORE_DIR` to an **encrypted**
directory and the broker stores secrets as `0600` files there. If a `~/.key` vault
exists (e.g. an **fscrypt**-encrypted vault), it's used automatically at
`~/.key/aios/`. **At-rest protection is that directory's** (fscrypt / LUKS / etc.)
— the broker does not add its own encryption, and it says so on every file-mode
`set`. Without a keyring *and* without an encrypted store dir, the broker refuses
to store and tells you why.

**Locked-vault awareness.** An fscrypt-style vault is *locked* until you unlock it
(e.g. after a reboot). The broker detects this via a `.vault_unlocked` canary at
the vault root (`~/.key/.vault_unlocked` for `~/.key/aios`, or point
`AIOS_SECRET_VAULT_CANARY` at your own) and fails with a clean
`🔒 secret store is locked` instead of a misleading "not found". Set
`AIOS_SECRET_UNLOCK_HINT` to your unlock command to have it shown in the message.
Auto-detection applies only to the `~/.key/aios` convention; an explicit
`AIOS_SECRET_STORE_DIR` opts out unless it also sets a canary.

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
- `install.sh` — installs the broker + registers the skill + convention
- `skill/SKILL.md` — the `/secret` skill, registered into `~/.claude/skills/secret/`
- `convention.txt` — the agent-facing secrets convention line
- `tests/test_secret.py` — validation suite
