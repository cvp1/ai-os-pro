#!/usr/bin/env node
/**
 * audit:surface — the security baseline, as an executable gate.
 *
 * Sasha Desktop makes four constitutional claims (spec D71 / D71-A):
 *   1. The renderer is sandboxed and isolated — no Node in the page.
 *   2. Nothing remote is ever loaded or executed.
 *   3. The app makes no network calls of its own (zero telemetry).
 *   4. No secret value ever reaches the renderer.
 *
 * Prose can't hold those. This script can: it scans src/ for the patterns that
 * would break them and fails the build if any appear. It scans ONLY src/ — this
 * file necessarily contains the forbidden strings as data, and the discriminator
 * is "does it appear in shipped source", not "does the word exist in the repo".
 *
 * Run: npm run audit:surface   (part of `npm run verify`)
 */
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative, extname } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(fileURLToPath(new URL('.', import.meta.url)), '..')
const SRC = join(ROOT, 'src')

/** Each rule: a regex that must NOT match shipped source, and why it matters. */
const FORBIDDEN = [
  {
    id: 'node-integration',
    re: /nodeIntegration\s*:\s*true/,
    why: 'Node in the renderer breaks the sandbox — a rendering bug becomes filesystem access.',
  },
  {
    id: 'context-isolation-off',
    re: /contextIsolation\s*:\s*false/,
    why: 'Context isolation is what keeps page script off the preload bridge.',
  },
  {
    id: 'sandbox-off',
    re: /sandbox\s*:\s*false/,
    why: 'The renderer runs untrusted-shaped content (user markdown); it stays sandboxed.',
  },
  {
    id: 'web-security-off',
    re: /webSecurity\s*:\s*false/,
    why: 'Disabling web security defeats the CSP that blocks remote content.',
  },
  {
    id: 'insecure-content',
    re: /allowRunningInsecureContent/,
    why: 'No remote content is loaded at all; this flag has no legitimate use here.',
  },
  {
    id: 'experimental-features',
    re: /experimentalFeatures\s*:\s*true/,
    why: 'Experimental web features widen the renderer attack surface for no product gain.',
  },
  {
    id: 'eval',
    re: /(^|[^.\w])eval\s*\(/,
    why: 'Dynamic evaluation of user-derived text is the injection path this app must not have.',
  },
  {
    id: 'new-function',
    re: /new\s+Function\s*\(/,
    why: 'Same as eval — a code path that turns data into code.',
  },
  {
    id: 'remote-module',
    re: /require\(['"]@electron\/remote['"]\)|enableRemoteModule/,
    why: 'The remote module hands main-process objects to the page. Never.',
  },
  {
    id: 'open-external',
    re: /shell\.openExternal/,
    why: 'Sprint 1 opens only validated local paths (shell.openPath). openExternal takes a URL and is the classic path from user-supplied text to a launched browser/protocol handler.',
  },
  {
    id: 'remote-load',
    // The leading boundary matters: a bare /loadURL\(/ also matches the tail of
    // `setSpellCheckerDictionaryDownloadURL(`, which is a different API entirely.
    // The rule is about `webContents.loadURL`, so require loadURL to start a word.
    re: /(?:^|[^A-Za-z])loadURL\s*\(\s*['"`]https?:/,
    why: 'The window loads bundled files only. What you audit is what runs.',
  },
  {
    id: 'inner-html',
    re: /\.(innerHTML|outerHTML)\s*=|insertAdjacentHTML/,
    why: 'Staged drafts are agent-written markdown from the user\'s workspace. Rendering that text as markup is the injection path this app must not have — the renderer builds DOM with createElement + textContent, always.',
  },
  {
    id: 'network-client',
    re: /(^|[^.\w])(fetch|XMLHttpRequest)\s*\(|require\(['"](https?|node:https?)['"]\)|from\s+['"]node:https?['"]/,
    why: 'ZERO TELEMETRY is the product claim. The app makes no outbound requests; the only network traffic on the machine is the user\'s own harness talking to the user\'s own provider.',
  },
]

/** Files that must contain a given pattern — claims that need positive proof. */
const REQUIRED = [
  {
    id: 'csp-present',
    file: 'renderer/index.html',
    re: /<meta\s+http-equiv=["']Content-Security-Policy["']/i,
    why: 'The renderer must ship a Content-Security-Policy meta tag.',
  },
  {
    id: 'csp-no-remote',
    file: 'renderer/index.html',
    re: /default-src\s+'self'/i,
    why: "CSP must pin default-src to 'self' so no remote origin can load.",
  },
  {
    id: 'context-isolation-on',
    file: 'main/index.ts',
    re: /contextIsolation\s*:\s*true/,
    why: 'Context isolation must be explicitly enabled, not left to a default that may change.',
  },
  {
    id: 'sandbox-on',
    file: 'main/index.ts',
    re: /sandbox\s*:\s*true/,
    why: 'The sandbox must be explicitly enabled.',
  },
]

function walk(dir) {
  const out = []
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) out.push(...walk(full))
    else if (['.ts', '.js', '.mjs', '.html'].includes(extname(full))) out.push(full)
  }
  return out
}

/** Strip line/block comments so a rule's own documentation can't trip it. */
function stripComments(text) {
  return text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1')
}

const files = walk(SRC)
const failures = []

for (const file of files) {
  const rel = relative(ROOT, file)
  const source = stripComments(readFileSync(file, 'utf8'))
  source.split('\n').forEach((line, i) => {
    for (const rule of FORBIDDEN) {
      if (rule.re.test(line)) {
        failures.push({ rule: rule.id, why: rule.why, where: `${rel}:${i + 1}`, line: line.trim() })
      }
    }
  })
}

for (const req of REQUIRED) {
  const full = join(SRC, req.file)
  let source = ''
  try {
    source = readFileSync(full, 'utf8')
  } catch {
    failures.push({ rule: req.id, why: `${req.why} (file missing: ${req.file})`, where: req.file, line: '' })
    continue
  }
  if (!req.re.test(source)) {
    failures.push({ rule: req.id, why: req.why, where: req.file, line: '(required pattern absent)' })
  }
}

if (failures.length > 0) {
  console.error('\n✗ audit:surface FAILED — the security baseline is broken.\n')
  for (const f of failures) {
    console.error(`  [${f.rule}] ${f.where}`)
    console.error(`      ${f.line}`)
    console.error(`      why: ${f.why}\n`)
  }
  console.error(`${failures.length} violation(s). These are constitutional, not style.\n`)
  process.exit(1)
}

console.log(`✓ audit:surface — ${files.length} files scanned, ${FORBIDDEN.length} forbidden patterns absent, ${REQUIRED.length} required guarantees present.`)
