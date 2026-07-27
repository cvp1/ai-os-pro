import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer, Socket } from 'node:net'
import { spawn } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'

/**
 * ZERO TELEMETRY — the runtime half of the proof.
 *
 * The product claim is that Sasha Desktop never contacts a remote host. That claim is
 * defended on two planes, because one test cannot see both:
 *
 *   · The CHROMIUM plane (renderer, network service) — covered here. We boot the real
 *     app pointed at a proxy we control and inspect everything it tries to reach.
 *   · The NODE plane (main process) — covered structurally by `audit:surface`, which
 *     fails the build if `fetch`, `XMLHttpRequest`, or node:http/https appear anywhere
 *     in src/. A Node-level request would bypass Chromium's proxy, so a runtime probe
 *     alone would give false comfort; the static rule is what closes that gap.
 *
 * Read those two together. Neither is sufficient alone, and saying so is the point.
 *
 * THE ONE ATTEMPT WE CANNOT SUPPRESS — stated plainly, because rounding it off to
 * "zero connections" would be a lie a packet capture could catch:
 *
 *   Chromium fetches a hunspell spellcheck dictionary from `redirector.gvt1.com` when
 *   a session first initialises. It is not our code and it carries no user data, but
 *   it IS an outbound connection. `spellcheck: false` on the window does not stop it
 *   (the download belongs to the session). Neither does `setSpellCheckerEnabled(false)`
 *   — by the time `whenReady` fires, the fetch is already scheduled — nor any of
 *   `--disable-background-networking`, `--disable-component-update`,
 *   `--disable-spell-checking`, or the `SpellcheckService` feature flags. All were
 *   tried; all still hit gvt1.com.
 *
 *   What DOES work is `setSpellCheckerDictionaryDownloadURL`, which repoints it at
 *   `0.0.0.0` — an unroutable address that never leaves the machine. So the attempt
 *   survives and the contact does not.
 *
 * This test therefore asserts the true, meaningful property: ZERO CONNECTIONS TO ANY
 * EXTERNAL HOST. A sunk request to the dead local address is reported, not ignored —
 * if it ever changes shape, you will see it here.
 *
 * The POSITIVE CONTROL below is load-bearing: a listener that cannot detect a
 * connection would report "no traffic" for a broken probe exactly as loudly as for a
 * clean app. We prove the instrument sees a real connection before we trust its silence.
 */

/** Destinations that provably cannot leave this machine. */
const SUNK = [/^0\.0\.0\.0(:|$)/, /^127\.0\.0\.1(:|$)/, /^\[::1\](:|$)/, /^localhost(:|$)/i]

function isExternal(requestLine) {
  // e.g. "CONNECT redirector.gvt1.com:443 HTTP/1.1" → "redirector.gvt1.com:443"
  const target = requestLine.split(/\s+/)[1] ?? requestLine
  return !SUNK.some((pattern) => pattern.test(target))
}

const ROOT = join(fileURLToPath(new URL('.', import.meta.url)), '..')
const IDLE_WATCH_MS = 6000

/**
 * A listener that records every connection attempt made to it — including the first
 * bytes sent, so a failure names the destination instead of just the count. "One
 * connection happened" is not actionable; "CONNECT accounts.google.com:443" is.
 */
function connectionRecorder() {
  const connections = []
  const server = createServer((socket) => {
    const record = { at: Date.now(), request: '' }
    connections.push(record)
    socket.once('data', (chunk) => {
      record.request = chunk.toString('utf8').split('\r\n')[0] ?? ''
      socket.destroy()
    })
    // Some clients connect and send nothing; do not hold the socket open for them.
    setTimeout(() => socket.destroy(), 1500)
  })
  return { server, connections }
}

function listen(server) {
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve(server.address().port))
  })
}

function close(server) {
  return new Promise((resolve) => server.close(() => resolve()))
}

test('POSITIVE CONTROL: the recorder detects a connection when one is made', async () => {
  const { server, connections } = connectionRecorder()
  const port = await listen(server)

  await new Promise((resolve, reject) => {
    const socket = new Socket()
    socket.connect(port, '127.0.0.1', () => {
      socket.end()
      resolve()
    })
    socket.on('error', reject)
  })

  // Give the server a tick to register it.
  await new Promise((r) => setTimeout(r, 200))
  await close(server)

  assert.ok(
    connections.length > 0,
    'the probe must be able to see traffic — otherwise its silence proves nothing',
  )
})

test('the app contacts no external host while idle', async (t) => {
  const electronBin = join(ROOT, 'node_modules', '.bin', 'electron')
  const built = join(ROOT, 'out', 'main', 'index.js')

  if (!existsSync(electronBin)) {
    t.skip('electron is not installed — run `npm install` to enable the runtime probe')
    return
  }
  if (!existsSync(built)) {
    t.skip('app is not built — run `npm run build` to enable the runtime probe')
    return
  }
  if (process.platform === 'linux' && !process.env.DISPLAY && !process.env.XVFB_RUN) {
    t.skip('no display available — run under xvfb-run to enable the runtime probe')
    return
  }

  const { server, connections } = connectionRecorder()
  const port = await listen(server)

  // An empty workspace: the app boots, finds nothing waiting, and should sit silent.
  const emptyHome = mkdtempSync(join(tmpdir(), 'sasha-desk-idle-'))
  const userData = mkdtempSync(join(tmpdir(), 'sasha-desk-userdata-'))

  const child = spawn(
    electronBin,
    [
      ROOT,
      `--proxy-server=127.0.0.1:${port}`,
      '--proxy-bypass-list=<-loopback>',
      `--user-data-dir=${userData}`,
      '--no-sandbox',
    ],
    {
      env: { ...process.env, AIOS_HOME: emptyHome },
      stdio: 'ignore',
    },
  )

  let exitedEarly = null
  child.on('exit', (code, signal) => {
    exitedEarly = { code, signal }
  })

  t.after(async () => {
    child.kill('SIGKILL')
    await close(server)
    rmSync(emptyHome, { recursive: true, force: true })
    rmSync(userData, { recursive: true, force: true })
  })

  await new Promise((resolve) => setTimeout(resolve, IDLE_WATCH_MS))

  // LIVENESS FIRST. A crashed app also makes zero connections — without this check
  // the assertion below would pass most loudly exactly when the app was most broken.
  assert.equal(
    exitedEarly,
    null,
    `the app exited during the watch window (${JSON.stringify(exitedEarly)}) — ` +
      'a dead process proves nothing about network silence.',
  )

  const attempts = connections.map((c) => c.request || '(connected, sent nothing)')
  const external = attempts.filter(isExternal)
  const sunk = attempts.filter((line) => !isExternal(line))

  // Visible, not silent: the sunk attempt is expected, but it should never be a
  // surprise to whoever reads this output.
  if (sunk.length > 0) {
    console.log(`  note: ${sunk.length} attempt(s) redirected to a dead local address: ${sunk.join(' · ')}`)
  }

  assert.deepEqual(
    external,
    [],
    `the app contacted ${external.length} external host(s): ${external.join(' · ')}. ` +
      'Nothing in this app may reach a remote host — that is the core product claim.',
  )
})
