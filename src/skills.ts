import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Curated skills ship in `skills/<id>/SKILL.md` and are registered with the native skill
 * registry on load. They are never copied into a user skill directory, so they are always the
 * version that matches the loaded plugin. Which role may load which skill is a `skill` permission
 * rule in roles.ts; a skill that no rule allows is simply invisible to that role.
 */

export interface SkillFile {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly path: string;
  readonly content: string;
}

/** Minimal frontmatter reader: top-level `key: value` lines only (all ARIA skills use that form). */
export function parseSkill(id: string, path: string, text: string): SkillFile {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(text);
  const data: Record<string, string> = {};
  for (const line of (match?.[1] ?? "").split(/\r?\n/)) {
    const kv = /^([A-Za-z][\w-]*):\s*(.*)$/.exec(line);
    if (kv?.[1]) data[kv[1]] = (kv[2] ?? "").replace(/^["']|["']$/g, "");
  }
  return { id, name: data.name || id, description: data.description ?? "", path, content: (match?.[2] ?? text).trim() };
}

export function discoverSkills(packageRoot: string): SkillFile[] {
  const base = join(packageRoot, "skills");
  if (!existsSync(base)) return [];
  const out: SkillFile[] = [];
  for (const id of readdirSync(base).sort()) {
    const path = join(base, id, "SKILL.md");
    if (existsSync(path)) out.push(parseSkill(id, path, readFileSync(path, "utf8")));
  }
  return out;
}
