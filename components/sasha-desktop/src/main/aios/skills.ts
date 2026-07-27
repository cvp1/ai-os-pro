import { readdirSync, readFileSync, statSync, existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

/**
 * What Sasha can do — discovered, not declared.
 *
 * A skill is a folder with a SKILL.md in it. The install has some; the harness has
 * more in `~/.claude/skills`. Nothing here is a hardcoded list, because a hardcoded
 * list is a promise the app cannot keep: skills arrive and leave on the user's disk,
 * and a menu that shows a capability the machine does not have is worse than no menu.
 *
 * The panel this feeds exists because of a specific failure in personal-AI products:
 * people cannot tell what the thing is capable of, so they use it for three obvious
 * things and never find the rest. Discovery is the feature.
 *
 * TWO HONEST DETAILS this module goes out of its way to surface:
 *
 *  1. Where the skill came from. A skill from your install and a skill from your
 *     harness are both real, but they are not the same thing, and a user deciding
 *     whether to trust one deserves to know which is which.
 *
 *  2. The command behind the button. When a skill's SKILL.md dispatches to a repo
 *     tool, we show that command line. The button is convenience; the command is the
 *     capability, and it keeps working with no GUI, no harness, and no us. Showing it
 *     is how the app stays a window onto your system instead of a wrapper around it.
 */

/** Plenty for any real install; a cap so a stray directory cannot stall the panel. */
const MAX_SKILLS = 300
/** Only the head of a SKILL.md is parsed — frontmatter plus the dispatch line. */
const MAX_HEAD_BYTES = 20_000

export interface Skill {
  /** The slash command, without the slash: `weather`, `triage`. */
  name: string
  /** One line, from frontmatter. Empty when the file does not describe itself. */
  description: string
  /** Where it was found, in words the user can act on. */
  source: 'install' | 'harness'
  /** Absolute path to the SKILL.md, for the "show me the file" affordance. */
  path: string
  /**
   * The command line this skill dispatches to, when it has one — the D2 shape, where
   * the capability lives in a repo tool and the skill is a shim. Undefined is not a
   * failure: plenty of good skills are pure instruction.
   */
  command?: string
}

/** `---\nname: x\ndescription: y\n---` — a bounded reader, not a YAML parser. */
function parseFrontmatter(head: string): Record<string, string> {
  const fields: Record<string, string> = {}
  const lines = head.split('\n')
  if (lines[0]?.trim() !== '---') return fields
  for (const raw of lines.slice(1, 60)) {
    const line = raw.trim()
    if (line === '---') break
    const match = /^([A-Za-z][A-Za-z0-9_-]*)\s*:\s*(.*)$/.exec(line)
    if (!match?.[1]) continue
    let value = (match[2] ?? '').trim()
    // Strip one layer of quoting; anything fancier belongs to a real YAML file.
    if (
      (value.startsWith('"') && value.endsWith('"') && value.length > 1) ||
      (value.startsWith("'") && value.endsWith("'") && value.length > 1)
    ) {
      value = value.slice(1, -1)
    }
    fields[match[1].toLowerCase()] = value
  }
  return fields
}

/**
 * The first runnable command in the body — the capability behind the shim.
 *
 * Deliberately narrow: an interpreter invocation on a script path. We are looking for
 * the D2 dispatch line ("run this tool"), not trying to understand shell. A miss just
 * means no command is shown, which is the safe direction — this string is displayed
 * to the user and is NEVER executed by this app.
 */
function findCommand(body: string): string | undefined {
  const re = /^\s*(?:\$\s*)?((?:\/usr\/bin\/)?(?:python3|node|bash|sh)\s+\S+[^\n]*)$/m
  const match = re.exec(body)
  if (!match?.[1]) return undefined
  const command = match[1].trim()
  if (command.length > 300) return undefined
  return command
}

function readSkill(dir: string, name: string, source: Skill['source']): Skill | null {
  const path = join(dir, name, 'SKILL.md')
  try {
    if (!statSync(path).isFile()) return null
  } catch {
    return null
  }

  let head = ''
  try {
    head = readFileSync(path, 'utf8').slice(0, MAX_HEAD_BYTES)
  } catch {
    return null
  }

  const fields = parseFrontmatter(head)
  const skill: Skill = {
    // Frontmatter `name` wins when present; the folder name is the fallback, because
    // the folder is what the harness actually dispatches on.
    name: (fields.name || name).trim(),
    description: (fields.description || '').trim(),
    source,
    path,
  }
  const command = findCommand(head)
  if (command) skill.command = command
  return skill
}

function readSkillDir(dir: string, source: Skill['source'], budget: number): Skill[] {
  if (!existsSync(dir)) return []
  let entries: string[]
  try {
    entries = readdirSync(dir)
  } catch {
    return []
  }

  const skills: Skill[] = []
  for (const entry of entries.sort()) {
    if (skills.length >= budget) break
    if (entry.startsWith('.')) continue
    const skill = readSkill(dir, entry, source)
    if (skill) skills.push(skill)
  }
  return skills
}

/** Where the harness keeps user skills. Split out so tests can point it elsewhere. */
export function harnessSkillDir(home = homedir()): string {
  return join(home, '.claude', 'skills')
}

/**
 * Everything this machine can do, install-first.
 *
 * A name collision resolves to the install's copy: it is the one shipped with the
 * product the user chose, and showing two rows with the same slash command would
 * misrepresent what typing that command actually does.
 */
export function discoverSkills(root: string | undefined, home = homedir()): Skill[] {
  const fromInstall = root ? readSkillDir(join(root, 'skills'), 'install', MAX_SKILLS) : []
  const remaining = MAX_SKILLS - fromInstall.length
  const fromHarness =
    remaining > 0 ? readSkillDir(harnessSkillDir(home), 'harness', remaining) : []

  const seen = new Set(fromInstall.map((skill) => skill.name))
  const merged = [...fromInstall]
  for (const skill of fromHarness) {
    if (seen.has(skill.name)) continue
    seen.add(skill.name)
    merged.push(skill)
  }
  merged.sort((a, b) => a.name.localeCompare(b.name))
  return merged
}
