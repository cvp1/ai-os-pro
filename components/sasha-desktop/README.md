# Sasha Desktop

**Your Claude Code session, in a window — and not only Claude.**

Native component #3. A local-only desktop app that puts a real interface on the
command-line AI-OS you already have, and lets you point it at a different model
without changing anything else.

---

## What it does

**You talk to it.** Type a message, watch the answer stream, see every tool call it
makes on your machine as it makes it. Slash commands work because they are just
prompts — `/status`, `/brief`, `/doctor`, any skill you have installed. It runs in
your AI-OS workspace, with your memory, your skills, and your files.

**You choose which Claude answers.** A model picker sits in the header: Fable,
Opus, Sonnet or Haiku, through the Claude Code login you already have.

**You can see what it knows about you.** Your `me/` and `memory/` files, listed and
readable in the window — the things you told it and the things it learned. This is
the difference between a personal AI and a chat box, and it is only a real claim if
you can look. The panel is **read-only on purpose**: changing what Sasha remembers
happens by asking Sasha, in the conversation, where the install's own rules about
what is worth keeping still apply. A GUI that wrote memory directly would be a
second writer with none of those gates.

**You can see what it can do.** Every skill on the machine, discovered rather than
hardcoded, with a Run button that puts the command in the chat where you can watch
it work. Where a skill dispatches to a tool, the panel shows that command line too —
the capability keeps working with no GUI, no harness, and no us.

**You can see where your data goes.** One panel, derived from live state, that says
plainly what leaves this machine and what does not. When you are talking to a cloud
model it says so first, in those words, above the reassuring rows.

**Local models: not here — and here is the honest record.** For two days this app
carried an Anthropic→Ollama bridge so Claude Code could drive a local model with
its full system prompt, tools, skills and memory. It worked mechanically (eleven
multi-turn tool round-trips in live trials, one trial 4/4 on a real agentic task).
It then FAILED its pre-stated reliability gate — 1/2 task completion on live
hardware where the bar, set before the run, was 2/2 — and was deleted per that
falsifier rather than patched until green or shipped flaky. The record and the
revival conditions live in `src/main/session/manager.ts`; the code lives in git
history. For a local agent today, use [opencode](https://opencode.ai) with your
Ollama models — it is gate-passed for exactly that job. Selecting a local model
here tells you this instead of half-working.

## What it is not

- **Not a replacement for the terminal.** It drives the same `claude` binary you
  already installed, through its documented streaming protocol — not by scraping a
  terminal. Everything you do here you could do at the command line; this just makes
  it reachable without one.
- **Not a harness.** It ships no model, holds no key, and signs in to nothing.
- **Not a place your data goes.** No account, no server, no sync, no gateway.

## The honest guarantee

**It contacts no remote host of its own.** Not "we don't sell your data" — there is
no server to send it to. The only traffic is your own Claude Code talking to your
own model provider, exactly as it does from your terminal, or a local model that
never leaves the machine at all.

That is a strong claim, so it is tested rather than asserted:

| Claim | How it is enforced |
|---|---|
| No contact with any external host | `tests/no-network.test.mjs` boots the real app behind a proxy we control and inspects everything it tries to reach — with a positive control proving the probe can see traffic, and a liveness check proving the app was actually running (a crashed app also makes no connections). The Node plane is closed separately by `audit:surface`, which fails the build if `fetch`, `XMLHttpRequest`, or `node:http`/`https` appear anywhere in `src/`. |
| Exactly one file may open a socket | The local-model backend needs to reach the local model server, so `audit:surface` allows `src/main/session/ollama-backend.ts` **by name** and nothing else. That permission is kept honest by `assertLoopback`, which refuses any host that is not `127.0.0.1`/`::1`/`localhost` — including another machine on your own LAN — and `session.test.mjs` proves the guard bites. The audit also *requires* the guard to be present and applied, so deleting it breaks the build. |
| Zero runtime dependencies | `audit:deps` fails if `dependencies` is non-empty. Everything shipped is Electron, Node's standard library, and code in this folder. |
| The page cannot reach your machine | `audit:surface` requires `contextIsolation`, `sandbox`, and a `default-src 'self'` CSP, and forbids `nodeIntegration`, `eval`, remote loads, and `innerHTML`. |
| Your files stay yours | The app reads `~/ai-os`. The **only** thing it ever writes there is an aggregate count in `.aios-usage.jsonl` — and only if that file already exists, because Core says counting is opt-in. Its own bookkeeping lives in the app's data directory, not in your workspace. |

Run all of it yourself: `npm run verify`.

### The one thing we could not fully suppress

Writing no network code turns out not to be enough, and you should hear this from
us rather than from a packet capture. **Chromium fetches a spellcheck dictionary
from `redirector.gvt1.com` when a session first initialises.** It is not our code
and it carries none of your data, but it is a real outbound connection, and the
zero-telemetry probe caught it on its first full run.

Everything obvious was tried and none of it worked: `spellcheck: false` on the
window (the download belongs to the session, not the window),
`setSpellCheckerEnabled(false)` (too late — by `whenReady` the fetch is already
scheduled), and the switches `--disable-background-networking`,
`--disable-component-update`, `--disable-spell-checking` and the various
`SpellcheckService` feature flags. All still reached Google.

What does work is `setSpellCheckerDictionaryDownloadURL`, which repoints the fetch
at `0.0.0.0` — an unroutable address that cannot leave your machine. So the attempt
survives and the contact does not, and the test asserts the property that actually
matters: **zero connections to any external host.** The sunk attempt is printed on
every run rather than filtered out, so if it ever changes shape you will see it.

This is the shape of the protection. We would rather describe it exactly than round
it up to a claim that is easier to say.

## Propose-only survives the GUI

AI-OS's rule is that the system proposes and you decide, and a nice interface is
the easiest place in the world to quietly erode that. So:

- Every waiting item is a **card you act on one at a time**. There is no
  approve-all, no batch, and no auto-approve setting to discover later.
- **The notification has no action buttons.** Clicking it opens the window on the
  card, because a decision should require seeing the thing you are deciding about.
- Waving something off is remembered **forever** — dismissed once is dismissed for
  good, keyed on the file's path so editing a draft cannot resurrect it.
- **The side panels cannot act.** They read. The one thing they can do is write a
  sentence into the composer and stop — you read it and press Send. Nothing about
  your memory, your files, or your machine changes because you clicked a row in a
  list. There is no `writeDoc` on the bridge; look at `src/preload/index.ts`, that
  list is the whole surface.

## The bell's manners

Carried verbatim from the Core doorbell, because the discipline is what makes a
notification tolerable:

- **At most one outstanding bell.** If three things are waiting you get one
  notification, not three. Nothing new rings until you have dealt with the one you
  were told about. (A poll loop that walks the queue is just a burst with extra
  steps.)
- **Silence is the normal case.** No "all quiet", no daily summary, no badge that
  is always lit. If nothing is waiting, nothing happens.
- **Quiet hours, on by default, 9pm–5am.** Nothing rings in the window. Items wait;
  they are never dropped.

## Install

Requires **Node.js 22+**, an existing AI-OS install, and (for `/doctor`) Claude Code.

```bash
git clone https://github.com/cvp1/ai-os-pro.git
cd ai-os-pro/components/sasha-desktop
./install.sh
npm start
```

Binaries are not published yet — this is a source build on purpose while it is
young. When they land, Linux (AppImage + `.deb`) leads and macOS ships unsigned
with a published `sha256`: a hash you verify beats a certificate we rent.
**Windows is not supported yet** and is not pretended to be.

## Platforms

| Platform | State |
|---|---|
| Linux | First-class. Built and tested in CI. |
| macOS | Supported, built in CI. Unsigned for now — see above. |
| Windows | Not yet. The build has never run there; no claim is made. |

## Development

```bash
npm run dev       # build + launch
npm run verify    # deps + CVEs + security surface + types + tests
npm test          # 48 tests
```

The runtime network probe needs a display. On a headless Linux box:
`SASHA_NO_NOTIFICATIONS=1 xvfb-run -a node --test tests/no-network.test.mjs`

**`SASHA_NO_NOTIFICATIONS=1`** turns the bell off entirely. You want it on any
machine without a working notification daemon — see below.

### When notifications can freeze a desktop app

On Linux, `Notification.show()` calls libnotify, which makes a **synchronous D-Bus
call**. If nothing services it, that call blocks the main process for ~25 seconds
per attempt. Blocking the main process blocks *everything* — the window cannot even
paint. We found this the hard way: with items waiting in the workspace, the app
started, tried to ring, and no window ever appeared. A secondary feature was
silently preventing the primary one.

Three defences, in order of preference: the window is shown **before** anything that
touches system services; a background probe checks whether
`org.freedesktop.Notifications` actually has an owner before we ever make the call;
and if a call does stall past two seconds, the bell latches off for the session and
says so. The probe cannot detect a daemon that owns the name but never *replies* —
that is what the environment variable is for.

## Layout

```
src/main/           the only privileged code
  session/          the conversation: neutral protocol + one adapter per provider
  aios/             find the install and harness, run /doctor, read me/ + memory/,
                    discover skills, describe where the data goes — all read-only
  doorbell/         proposals, heartbeats, dismissal memory, the counter
src/preload/        the complete list of things the page may do
src/renderer/       the window — createElement + textContent, never innerHTML
scripts/            the audit gates
tests/              behaviour, not coverage theatre
```

**The filesystem is the API.** There is no database and no new schema; the app reads
the same flat markdown AI-OS has always written. Uninstall it and every file is
exactly where the CLI expects it.

## License

Apache-2.0, same as the rest of AI-OS Pro.
