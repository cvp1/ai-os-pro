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
  in your OS keyring (macOS Keychain, Linux Secret Service, Windows Credential
  Manager).
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

More native components will follow (sync, local indexing, and beyond).

## Install

AI-OS Pro is a set of **opt-in native components you add on top of a Core AI-OS
install.** It does **not** replace or convert Core — it drops components into the
same `~/ai-os/` tree and registers their skills. (No Core install yet? Set one up
first from [cvp1/ai-os](https://github.com/cvp1/ai-os).)

```sh
git clone https://github.com/cvp1/ai-os-pro
cd ai-os-pro
./install.sh                 # install all components (currently: secret-broker)
# …or one at a time:
./install.sh secret-broker
```

Installing the **secret-broker** component:

- installs the broker to `~/ai-os/bin/secret`
- registers the `/secret` skill at `~/.claude/skills/secret/SKILL.md`
- adds the secrets convention to your AI-OS `CLAUDE.md` if it finds one
- checks for an OS keyring and warns if none is present

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

**Early — staking the ground.** The edition is defined and the secrets broker is
specced; the first component is in development. Watch this space.

## Principles (unchanged from Core)

Free. Local. Yours. Single-operator. Propose-only on anything that's yours to own.
Pro inherits every one of them — it only adds the executables the prompt couldn't.
