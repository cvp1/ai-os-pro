# AI-OS Pro

**The free power-user edition of [AI-OS](https://github.com/cvp1/ai-os).**

AI-OS Pro is *not* a paid tier. It's the same free gift as Core — aimed at a
different audience: the power user who has outgrown what a prompt alone can do.

## Two editions, split by substrate — not by price

- **[AI-OS Core](https://github.com/cvp1/ai-os)** — the copy-paste setup prompt
  that turns Claude Code into a personal AI operating system. Prompt-only:
  nothing to install, no code to edit. This is where everyone starts, and where
  most people happily stay.
- **AI-OS Pro** — Core, *plus* **native components**: opt-in executables that do
  things a prompt categorically cannot.

**New here? Start with Core.** Pro is waiting for when you hit its edges — it is
never the beginner's first screen, and it takes nothing away from the free
prompt-only experience.

## Native components

A native component is a small local program AI-OS installs on your machine to
cross a line the prompt substrate can't — real code, on disk, that a setup prompt
alone could never express. They are opt-in, one at a time, and dormant until you
ask for one.

The first — and the reason this edition exists — is a **local secrets broker**:

- You register a credential once (an API key, an app password, a token), stored
  in your OS keyring — macOS Keychain or Linux Secret Service today (Windows
  Credential Manager is planned, not yet built; the installer itself is
  bash-only, so Windows means WSL for now).
- Your skills reference it only by a stable **handle** — `secret://gmail-app-password` —
  never the value.
- A thin local broker holds the secret, performs the authenticated action on your
  behalf, and returns **only the outcome**. There is deliberately no verb that
  returns the raw value.

**The honest guarantee.** The secret stays out of the model's reach, out of your
transcript, and out of your logs; it's encrypted at rest and you can revoke it any
time. What this edition does *not* claim is "impossible to exfiltrate" — a
copy-paste tool ships no sandbox, so the guarantee is zero-knowledge *by
convention of the interface*, not by an enforced jail. We'd rather tell you the
true shape of the protection than oversell it.

The newest one is a different shape: **`sasha-desktop`**, a local-only desktop app
that puts a real interface on the command-line AI-OS. **You talk to it** — type,
watch the answer stream, see each tool call as it happens; slash commands work
because they are just prompts. **And you choose who answers:** Claude through the
Claude Code login you already have, or any model Ollama has pulled, running entirely
on your own machine. Same window, same workspace, same skills; different brain.

**Its honest guarantee:** it contacts no remote host of its own — not a policy, a
tested property. No account, no gateway, no telemetry. Exactly one file is permitted
to open a socket (the local-model backend), it is allowlisted by name, and a guard
refuses any address that is not this machine. See
[`components/sasha-desktop/`](components/sasha-desktop/) for how each claim is
enforced rather than asserted. Source build for now — no binaries yet, no Windows.

More native components will follow (sync, local indexing, and beyond).

## Install

AI-OS Pro is a set of **opt-in native components you add on top of a Core AI-OS
install.** It does **not** replace or convert Core — it drops components into the
same `~/ai-os/` tree and registers their skills. (No Core install yet? Set one up
first from [cvp1/ai-os](https://github.com/cvp1/ai-os).)

```sh
git clone https://github.com/cvp1/ai-os-pro
cd ai-os-pro
./install.sh                        # install default components (secret-broker)
# …or by name:
./install.sh secret-broker model-keys
```

**Components:**

- **`secret-broker`** — the credential capability. Installs the broker to
  `~/ai-os/bin/secret`, registers the `/secret` skill, adds the secrets
  convention to your AI-OS `CLAUDE.md` if it finds one, and checks for a store.
  Uses your **OS keyring** (macOS Keychain / Linux Secret Service); with no
  keyring it falls back to `0600` files in an encrypted dir (`AIOS_SECRET_STORE_DIR`,
  or an fscrypt `~/.key/aios` if present).
- **`model-keys`** — an example: the `/ask-model` skill calls OpenRouter / Gemini /
  DeepSeek using keys held by the broker, so a provider key never enters the chat.
- **`sasha-desktop`** — the local desktop window (Node 22+, Electron). Not part of
  the default install; build it directly with
  `components/sasha-desktop/install.sh`, then `npm start`. Linux and macOS only.

Then **start a fresh Claude Code session** so `/secret` registers, and store your
first credential:

```sh
~/ai-os/bin/secret set secret://gmail-app-password    # prompts you, no echo
# …or add it in your OS keyring app under service "ai-os", account "gmail-app-password"
```

Override locations with `AIOS_HOME` (default `~/ai-os`) and `CLAUDE_SKILLS_DIR`
(default `~/.claude/skills`). To uninstall a component, delete `~/ai-os/bin/secret`
and `~/.claude/skills/secret/`.

## Status

**Early, but real.** Three components ship today: the secrets broker (built,
self-tested — 29 checks — and validated live with real provider keys on macOS
Keychain and the file/fscrypt fallback), `model-keys` (`/ask-model` through
broker-held keys), and `sasha-desktop` (v0.2 — 48 tests, driven end-to-end live on
Linux: a message typed into the window reached Claude Code over its streaming
protocol and the reply rendered back with cost and token counts; the doorbell rings;
the zero-network probe passes with a positive control and a liveness check).

Unproven so far, stated plainly: the Linux Secret-Service *daemon* path on a
headless box; Windows entirely; and for `sasha-desktop` specifically — **it has not
yet run on macOS outside CI**, notifications have not been observed firing on a real
desktop session, the Ollama backend has not been exercised against a live daemon,
and no binary has been published. Claims track reality here — if
it isn't listed as validated, treat it as not yet.

## Principles (unchanged from Core)

Free. Local. Yours. Single-operator. Propose-only on anything that's yours to own.
Pro inherits every one of them — it only adds the executables the prompt couldn't.
