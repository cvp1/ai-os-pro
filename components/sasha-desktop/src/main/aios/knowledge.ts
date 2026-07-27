import { readdirSync, readFileSync, statSync, existsSync, realpathSync } from 'node:fs'
import { join, resolve, relative, isAbsolute, extname } from 'node:path'

/**
 * What Sasha knows about you — read, and only read.
 *
 * Two folders answer the question "why does it say that?": `me/` (who you are, what
 * you want, how you like to work — the things you told it) and `memory/` (what it
 * learned along the way). Together they are the reason the product can claim to be
 * YOURS rather than a chat window: the context is on your disk, in plain markdown,
 * and you can look at all of it.
 *
 * THIS MODULE NEVER WRITES. Not a convenience gap — a boundary. Memory and me/ are
 * human-owned state, and the AI-OS install already has one sanctioned path for
 * changing them (the session itself, with its lineage and dedup rules). A GUI that
 * wrote memory directly would be a second writer with none of those gates, which is
 * exactly how a personal AI quietly starts remembering things nobody agreed to. So
 * the browser shows you what is there and routes every change back through Sasha.
 *
 * Bounds are enforced here rather than trusted to the caller: a workspace is the
 * user's own directory, so it can contain anything — a thousand files, a 400 MB log
 * someone dropped in `me/`. The panel stays responsive because this refuses to read
 * more than it should.
 */

/** Enough to fill a panel; more than anyone keeps by hand. */
const MAX_DOCS_PER_FOLDER = 200
/** A single doc we will read in full. Beyond this the file is not prose any more. */
const MAX_DOC_BYTES = 400_000
/** The one-line teaser on the list row. */
const PREVIEW_CHARS = 160

export interface Doc {
  /** `me/VALUES.md` — folder-relative, and the identity the renderer hands back. */
  id: string
  /** `VALUES.md` — what the user sees. */
  name: string
  folder: 'me' | 'memory'
  bytes: number
  /** ISO. When this was last changed — "learned 3 days ago" is the useful part. */
  modified: string
  /** First readable prose line, so a list row says something. */
  preview: string
}

export interface Knowledge {
  me: Doc[]
  memory: Doc[]
  /** Plain words when a folder is missing — an empty list must never read as "empty". */
  problem?: string
}

/**
 * Resolve `relativePath` inside `root`, or return null.
 *
 * The renderer hands back ids that came from a listing, but "came from a listing" is
 * an assumption about a process we do not control, so it is checked rather than
 * believed: anything that escapes the root — `../`, an absolute path — is refused.
 *
 * THE CHECK IS ON THE REAL PATH, after symlinks are resolved. A lexical check alone
 * passes `me/notes.md` while the file on the other end is `~/.ssh/id_rsa`, and the
 * panel would then render a private key as if it were something Sasha knows about
 * you. Nobody needs to attack the app to get there: an agent that can write in the
 * workspace can be talked into making that link, which is exactly the kind of
 * second-order path this app is supposed to close rather than trust.
 */
export function confine(root: string, relativePath: string): string | null {
  if (typeof relativePath !== 'string' || relativePath === '') return null
  if (relativePath.includes('\0')) return null

  try {
    // Resolve BOTH sides: the root itself is often reached through a link
    // (/tmp → /private/tmp on macOS), and comparing a real path against a
    // symlinked root would reject perfectly legitimate files.
    const realRoot = realpathSync(resolve(root))
    const full = realpathSync(resolve(root, relativePath))
    const rel = relative(realRoot, full)
    if (rel === '' || rel.startsWith('..') || isAbsolute(rel)) return null
    if (!statSync(full).isFile()) return null
    return full
  } catch {
    // Missing, unreadable, or a broken link — all the same answer: not readable.
    return null
  }
}

/** First line with actual words in it — headings and frontmatter are not a preview. */
function firstProseLine(text: string): string {
  const lines = text.slice(0, 4000).split('\n')
  let inFrontmatter = false
  for (const [index, raw] of lines.entries()) {
    const line = raw.trim()
    if (index === 0 && line === '---') {
      inFrontmatter = true
      continue
    }
    if (inFrontmatter) {
      if (line === '---') inFrontmatter = false
      continue
    }
    if (line === '' || line.startsWith('#') || line.startsWith('<!--')) continue
    return line.slice(0, PREVIEW_CHARS)
  }
  return ''
}

function readFolder(root: string, folder: 'me' | 'memory'): Doc[] {
  const dir = join(root, folder)
  if (!existsSync(dir)) return []

  let entries: string[]
  try {
    entries = readdirSync(dir)
  } catch {
    return []
  }

  const docs: Doc[] = []
  for (const entry of entries.sort()) {
    if (docs.length >= MAX_DOCS_PER_FOLDER) break
    if (entry.startsWith('.')) continue
    if (!['.md', '.markdown', '.txt'].includes(extname(entry).toLowerCase())) continue

    const full = join(dir, entry)
    try {
      const stats = statSync(full)
      if (!stats.isFile()) continue
      const preview =
        stats.size <= MAX_DOC_BYTES ? firstProseLine(readFileSync(full, 'utf8')) : ''
      docs.push({
        id: `${folder}/${entry}`,
        name: entry,
        folder,
        bytes: stats.size,
        modified: stats.mtime.toISOString(),
        preview,
      })
    } catch {
      // A file that cannot be read is simply not listed; one bad entry must not
      // cost the user the whole panel.
    }
  }
  return docs
}

export function readKnowledge(root: string): Knowledge {
  const me = readFolder(root, 'me')
  const memory = readFolder(root, 'memory')

  const missing: string[] = []
  if (!existsSync(join(root, 'me'))) missing.push('me/')
  if (!existsSync(join(root, 'memory'))) missing.push('memory/')

  const knowledge: Knowledge = { me, memory }
  if (missing.length > 0) {
    knowledge.problem =
      `This install has no ${missing.join(' or ')} folder yet. Sasha writes ` +
      'these as it learns about you — they appear here once there is something in them.'
  }
  return knowledge
}

/**
 * Read one doc for display. Returns null rather than throwing: a file that moved
 * between the listing and the click is an ordinary race, not an error worth a dialog.
 */
export function readDoc(root: string, id: string): string | null {
  if (!/^(me|memory)\//.test(id)) return null
  const full = confine(root, id)
  if (!full) return null
  try {
    if (statSync(full).size > MAX_DOC_BYTES) {
      return readFileSync(full, 'utf8').slice(0, MAX_DOC_BYTES) + '\n\n… (truncated for display)'
    }
    return readFileSync(full, 'utf8')
  } catch {
    return null
  }
}
