import { realpathSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { SECRET_PATHS, matches } from "./permissions.ts";
import { SCRATCH_DIR } from "./scratch.ts";

/**
 * Two checks OpenCode v2.3.0 does not make natively, implemented as a `permission` `evaluate`
 * hook. Both can only DENY. The hook never writes `allow` or `ask`, so it cannot widen anything a
 * rule decided (hook source: packages/core/src/permission.ts `evaluateInput`; an explicit
 * configured deny is decided before the hook and is final).
 *
 * 1. Symlink boundary. OpenCode resolves paths lexically (`path.resolve`) and matches rules
 *    against that lexical path. This hook resolves symlinks and:
 *    - denies read/edit when a path lexically inside the project really lives outside it (the
 *      real path then goes through `external_directory` and the rules normally);
 *    - denies EDIT through any symlink inside the project, because the rule that allowed the
 *      lexical path (e.g. the planner's `.aria/plans/*.md`) says nothing about the real target;
 *    - denies READ when the real target is an env or credential file the lexical name hides.
 *
 * 2. Scratch ownership. Edits under `.aria/scratch/` are only allowed inside the caller's own
 *    `<root-session>/<session>/` directory (and the root session's DONE marker), so concurrent
 *    agents cannot overwrite each other's temporary files.
 *
 * Limits: this governs OpenCode tool calls. A shell command can still touch any path the host
 * user can; shell rules in permissions.ts are policy, not containment.
 */

export interface GuardEvent {
  readonly sessionID: string;
  readonly action: string;
  readonly resources: readonly string[];
  effect: "allow" | "ask" | "deny";
  message?: string | undefined;
}

export interface GuardDeps {
  /** Location directory: the base for relative resources and for `.aria/` paths. */
  readonly directory: string;
  /** Project (worktree) directory, when different from the location directory. */
  readonly projectDirectory?: string | undefined;
  /** Root session of a delegation tree (a root session is its own root). */
  readonly rootOf: (sessionID: string) => Promise<string>;
}

/**
 * Walks `parentOf` to the root session. A session's parent never changes, so a resolved root is
 * cached. A lookup error is NOT treated as "no parent": it propagates and nothing is cached, so a
 * transient failure cannot permanently assign a child its own scratch tree.
 */
export function createRootResolver(parentOf: (sessionID: string) => Promise<string | undefined>) {
  const roots = new Map<string, string>();
  return async (sessionID: string): Promise<string> => {
    const cached = roots.get(sessionID);
    if (cached) return cached;
    let current = sessionID;
    for (let hops = 0; ; hops++) {
      if (hops >= MAX_DEPTH) throw new Error(`session ${sessionID}: parent chain deeper than ${MAX_DEPTH}`);
      const parent = await parentOf(current);
      if (!parent) break;
      current = parent;
    }
    roots.set(sessionID, current);
    return current;
  };
}

const PATH_ACTIONS = new Set(["read", "edit"]);
const MAX_DEPTH = 16;

/** Resolve symlinks as far as the path exists; re-append the part that does not exist yet. */
export function canonical(path: string): string {
  let current = path;
  const tail: string[] = [];
  for (;;) {
    try {
      const real = realpathSync.native(current);
      return tail.length ? join(real, ...tail.reverse()) : real;
    } catch {
      const parent = dirname(current);
      if (parent === current) return path;
      tail.push(basename(current));
      current = parent;
    }
  }
}

export function contains(root: string, path: string): boolean {
  const rel = relative(root, path);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

const slashes = (value: string) => value.split(sep).join("/");

/** Real targets a read must not reach through an innocent-looking link. */
const HIDDEN_SECRET = [...SECRET_PATHS, "*.env", "*.env.*", ".env", ".env.*"];
const isSecret = (relativeOrAbsolute: string) =>
  !matches(relativeOrAbsolute, "*.env.example") && HIDDEN_SECRET.some((pattern) => matches(relativeOrAbsolute, pattern));
const fold = (value: string) => (process.platform === "win32" ? value.toLowerCase() : value);

export function createGuard(deps: GuardDeps) {
  const lexicalRoots = [resolve(deps.directory), ...(deps.projectDirectory ? [resolve(deps.projectDirectory)] : [])];
  const realRoots = lexicalRoots.map(canonical);
  const realBase = canonical(resolve(deps.directory));
  const rootOf = deps.rootOf;

  async function scratchVerdict(real: string, sessionID: string): Promise<string | undefined> {
    const rel = fold(slashes(relative(realBase, real)));
    const prefix = fold(`${SCRATCH_DIR}/`);
    if (rel !== fold(SCRATCH_DIR) && !rel.startsWith(prefix)) return undefined;
    const segments = rel.slice(prefix.length).split("/").filter(Boolean);
    const root = await rootOf(sessionID).catch(() => "");
    if (!/^ses_[A-Za-z0-9]{8,64}$/.test(root) || !/^ses_[A-Za-z0-9]{8,64}$/.test(sessionID)) {
      return `Scratch is unavailable for this session (root session could not be resolved).`;
    }
    const mine = [fold(root), fold(sessionID)];
    if (segments[0] === mine[0] && segments[1] === mine[1]) return undefined;
    if (segments.length === 2 && segments[0] === mine[0] && segments[1] === fold("DONE") && mine[0] === mine[1]) {
      return undefined;
    }
    return `Scratch is per session. Write only under ${SCRATCH_DIR}/${root}/${sessionID}/ (the root session may also create ${SCRATCH_DIR}/${root}/DONE).`;
  }

  return async (event: GuardEvent): Promise<void> => {
    if (!PATH_ACTIONS.has(event.action) || event.effect === "deny") return;
    for (const resource of event.resources) {
      const lexical = resolve(deps.directory, resource.replaceAll("\\", "/"));
      const real = canonical(lexical);
      const lexicalRoot = lexicalRoots.find((root) => contains(root, lexical));
      const realRoot = realRoots.find((root) => contains(root, real));
      if (lexicalRoot && !realRoot) {
        event.effect = "deny";
        event.message = `${resource} is a symlink that resolves outside the project (${real}). Use the real path instead so external-directory and ${event.action} rules apply to it.`;
        return;
      }
      if (lexicalRoot && realRoot) {
        const lexicalRel = fold(slashes(relative(lexicalRoot, lexical)));
        const realRel = fold(slashes(relative(realRoot, real)));
        if (lexicalRel !== realRel) {
          if (event.action === "edit") {
            event.effect = "deny";
            event.message = `${resource} goes through a symbolic link (real path: ${realRel}). Edit the real path so the permission rules for it apply.`;
            return;
          }
          if (isSecret(realRel) && !isSecret(lexicalRel)) {
            event.effect = "deny";
            event.message = `${resource} is a symbolic link to a protected file (${realRel}).`;
            return;
          }
        }
      } else if (!lexicalRoot && isSecret(slashes(real)) && !isSecret(slashes(lexical))) {
        event.effect = "deny";
        event.message = `${resource} is a symbolic link to a protected file (${real}).`;
        return;
      }
      if (event.action === "edit") {
        const verdict = await scratchVerdict(real, event.sessionID);
        if (verdict) {
          event.effect = "deny";
          event.message = verdict;
          return;
        }
      }
    }
  };
}
