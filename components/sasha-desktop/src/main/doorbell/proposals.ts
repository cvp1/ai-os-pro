import { readdirSync, statSync, readFileSync } from 'node:fs'
import { join, relative, sep } from 'node:path'
import type { BellItem } from '../types.js'

/**
 * Proposal scanning — "is something waiting for my answer?"
 *
 * Reads the shipped Core convention verbatim (`core/sections/after-skills.txt`):
 * a staged draft lives in `~/ai-os/<domain>/proposals/` or
 * `~/ai-os/projects/<slug>/proposals/`.
 *
 * DESK introduces no new location, no index file, and no database. If a manager
 * stages a file the way it always has, DESK sees it; if DESK is uninstalled
 * tomorrow, every one of those files is exactly where the CLI expects it.
 */

/** Bound the sweep — a runaway workspace must not hang the app. */
const MAX_PROPOSALS = 200
const MAX_DOMAIN_DIRS = 100

const PROPOSAL_EXTENSIONS = ['.md', '.txt']

function safeReaddir(dir: string): string[] {
  try {
    return readdirSync(dir)
  } catch {
    return []
  }
}

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory()
  } catch {
    return false
  }
}

/**
 * Collect every `proposals/` directory the Core convention allows:
 *   ~/ai-os/<domain>/proposals/
 *   ~/ai-os/projects/<slug>/proposals/
 */
export function proposalDirs(root: string): string[] {
  const dirs: string[] = []

  for (const entry of safeReaddir(root).slice(0, MAX_DOMAIN_DIRS)) {
    if (entry.startsWith('.')) continue
    const domainDir = join(root, entry)
    if (!isDirectory(domainDir)) continue

    const direct = join(domainDir, 'proposals')
    if (isDirectory(direct)) dirs.push(direct)

    // projects/ nests one level deeper: projects/<slug>/proposals/
    if (entry === 'projects') {
      for (const slug of safeReaddir(domainDir).slice(0, MAX_DOMAIN_DIRS)) {
        if (slug.startsWith('.')) continue
        const nested = join(domainDir, slug, 'proposals')
        if (isDirectory(nested)) dirs.push(nested)
      }
    }
  }

  return dirs
}

/**
 * Pull a human headline out of a staged draft: its first markdown heading, else its
 * first non-empty line, else the filename. Bounded read — we look at the top of the
 * file, never the whole thing.
 */
export function headlineFor(filePath: string, fallback: string): string {
  let head: string
  try {
    head = readFileSync(filePath, 'utf8').slice(0, 4000)
  } catch {
    return fallback
  }

  for (const raw of head.split('\n').slice(0, 40)) {
    const line = raw.trim()
    if (line === '') continue
    if (line.startsWith('#')) return line.replace(/^#+\s*/, '').trim() || fallback
    // A non-heading first line is still better than a filename.
    return line.length > 120 ? `${line.slice(0, 117)}…` : line
  }
  return fallback
}

/** Turn a filename into something readable: `2026-07-27-weekly-status.md` → `weekly status`. */
function prettyName(name: string): string {
  return name
    .replace(/\.(md|txt)$/i, '')
    .replace(/^\d{4}-\d{2}-\d{2}[-_]?/, '')
    .replace(/[-_]+/g, ' ')
    .trim()
}

/**
 * The workspace that staged this — `projects/ranch-site/proposals/x.md` → `ranch-site`,
 * `career/proposals/x.md` → `career`. Used to say WHICH thing is waiting.
 */
function workspaceFor(root: string, filePath: string): string {
  const parts = relative(root, filePath).split(sep)
  if (parts[0] === 'projects' && parts.length >= 2) return parts[1]!
  return parts[0] ?? 'your workspace'
}

/** Every staged draft currently waiting, newest first. */
export function readProposals(root: string): BellItem[] {
  const items: BellItem[] = []

  for (const dir of proposalDirs(root)) {
    for (const entry of safeReaddir(dir)) {
      if (entry.startsWith('.')) continue
      if (!PROPOSAL_EXTENSIONS.some((ext) => entry.toLowerCase().endsWith(ext))) continue

      const full = join(dir, entry)
      let mtime: Date
      try {
        const stat = statSync(full)
        if (!stat.isFile()) continue
        mtime = stat.mtime
      } catch {
        continue
      }

      const workspace = workspaceFor(root, full)
      const title = headlineFor(full, prettyName(entry))
      // Drafts are usually titled "Weekly status for ranch-site"; appending the
      // workspace again would read "…for ranch-site for ranch-site".
      const named = title.toLowerCase().includes(workspace.toLowerCase())
      const headline = named
        ? `While you were away I drafted "${title}" — want to look?`
        : `While you were away I drafted "${title}" for ${workspace} — want to look?`

      items.push({
        // Relative path is the stable id: editing the draft must not resurrect a dismissal.
        id: relative(root, full),
        kind: 'proposal',
        headline,
        path: full,
        at: mtime.toISOString(),
        detail: `Staged ${mtime.toLocaleDateString()} in ${relative(root, dir)}`,
      })

      if (items.length >= MAX_PROPOSALS) break
    }
    if (items.length >= MAX_PROPOSALS) break
  }

  items.sort((a, b) => Date.parse(b.at) - Date.parse(a.at))
  return items
}
