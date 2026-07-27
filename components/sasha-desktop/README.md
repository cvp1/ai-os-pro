# Sasha Desktop

**The window your AI-OS opens when it has something for you.**

Native component #3. A small, local-only desktop app that sits on top of an
existing AI-OS install and your own Claude Code login.

---

## The one thing it does

AI-OS can already work for you while you are away — a project manager drafts your
weekly status, a scheduled check-in runs, something gets staged in a `proposals/`
folder. Until now, finding out required *showing up and asking*: the bell only rang
at the start of a session, because a copy-paste prompt has no way to tap you on the
shoulder.

Sasha Desktop is that shoulder tap. When something is staged for you, or when a
scheduled job goes quietly dead, it says so once — a native notification, one line,
one item. Then it gets out of the way.

That is the whole product. Everything else here exists to make that trustworthy.

## What it is not

- **Not a chat client.** Claude Code's own desktop app is the front door for
  conversation, and it is better at it than we would be. This is the surface for
  the things you did *not* think to ask about.
- **Not a harness.** It ships no model, holds no key, and signs in to nothing. It
  runs the `claude` binary you already installed, under the login you already have.
- **Not a place your data goes.** There is no account, no server, no sync.

## The honest guarantee

**It contacts no remote host.** Not "we don't sell your data" — there is no server
to send it to. The only outbound traffic on your machine is your own Claude Code
talking to your own model provider, exactly as it does from your terminal.

That is a strong claim, so it is tested rather than asserted:

| Claim | How it is enforced |
|---|---|
| No contact with any external host | `tests/no-network.test.mjs` boots the real app behind a proxy we control and inspects everything it tries to reach — with a positive control proving the probe can see traffic, and a liveness check proving the app was actually running (a crashed app also makes no connections). The Node plane is closed separately by `audit:surface`, which fails the build if `fetch`, `XMLHttpRequest`, or `node:http`/`https` appear anywhere in `src/`. |
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
npm test          # 36 tests
```

The runtime network probe needs a display. On a headless Linux box:
`xvfb-run -a node --test tests/no-network.test.mjs`

## Layout

```
src/main/           the only privileged code
  aios/             find the install, find the harness, run /doctor
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
