import { resolve } from "node:path";
import { cleanScratch, listScratch } from "../scratch.ts";
import { describePlan, loadPlans } from "../plans.ts";
import { allDeps, disableDep, enableDep, installDep, probeDep, readiness } from "./deps.ts";
import { MANIFEST } from "./manifest.ts";
import { doctor, failing } from "./doctor.ts";
import { isAriaPackage } from "./config.ts";
import { packageRoot } from "./env.ts";
import { checkUpdate, repair, rollback, setup, update } from "./install.ts";
import { pack } from "./pack.ts";
import { inspect } from "./release.ts";
import { reconcile } from "./reconcile.ts";
import { modelView, restoreModel, setModel } from "./models.ts";
import { listAgents, listModels } from "./opencode.ts";
import type { Check, OperationResult } from "./types.ts";

/**
 * Non-interactive commands. Each one is a thin call into the same backend the management TUI uses.
 *
 * Exit codes: 0 ok · 1 problem found / operation failed · 2 usage error · 3 preview only (mutation
 * needs --yes) · 4 blocked by a conflict that needs a decision.
 */

export const EXIT = { ok: 0, problem: 1, usage: 2, confirm: 3, blocked: 4 } as const;

const version = () => isAriaPackage(packageRoot)?.version ?? "unknown";

export const USAGE = `aria ${version()} — ARIA manager

  aria                         open the management TUI (interactive terminal only)
  aria ui                      same
  aria doctor [--runtime]      health report (--runtime also queries OpenCode)
  aria setup [--scope global|project] [--dev [path] | --release [--from <dir|tgz>] [--sha256 <hex>]]
             [--with zotero-mcp,context7,playwright-mcp] [--adopt] [--link-bin] [--force]
  aria update [--check] --from <dir|tgz> [--sha256 <hex>] [--force]
  aria pack [--out <dir>] [--source <dir>]   build aria-<version>.tgz + .sha256 from the release inventory
  aria inspect [<dir|tgz>] [--sha256 <hex>]  release identity, version and file count (read-only)
  aria reconcile               would this package work with the current environment? (read-only)
  aria rollback [--to <version>] [--keep-tools]   journaled; --keep-tools leaves ARIA-managed tool paths alone
  aria repair [--keep-changed] revert an interrupted operation (never overwrites files you changed since;
                               --keep-changed keeps them and rebuilds state around them)
  aria models [list] [--runtime]
  aria models set <role|default> <provider/model[#variant]> [--scope project|global] [--force]
  aria models reset <role|default> [--scope project|global]     remove the pin
  aria models restore <role|default>                            undo ARIA's last change
  aria models available        models OpenCode lists for this project
  aria deps [list]
  aria deps install|update <id> · enable <id> [--scope] [--replace] · disable <id> · probe <id>
  aria deps check [<id>]       operational readiness of enabled integrations (may use the network)
  aria plans · aria scratch list · aria scratch clean [--stale N]
  aria version

  Mutating commands preview by default; add --yes to apply (--dry-run forces a preview).
  Common: --dir <project> (default: cwd), --json (structured output).
  Exit codes: 0 ok, 1 problem, 2 usage, 3 needs --yes, 4 blocked by a conflict.`;

export interface Args {
  readonly positional: string[];
  readonly flags: Map<string, string | true>;
}

export function parseArgs(argv: readonly string[]): Args {
  const positional: string[] = [];
  const flags = new Map<string, string | true>();
  const valued = new Set(["scope", "from", "sha256", "with", "to", "dir", "stale", "out", "source"]);
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i] as string;
    if (a.startsWith("--")) {
      const [key, inline] = a.slice(2).split("=", 2) as [string, string | undefined];
      if (inline !== undefined) flags.set(key, inline);
      else if (valued.has(key) && argv[i + 1] !== undefined && !(argv[i + 1] as string).startsWith("--")) flags.set(key, argv[++i] as string);
      else if (key === "dev" && argv[i + 1] !== undefined && !(argv[i + 1] as string).startsWith("--")) flags.set(key, argv[++i] as string);
      else flags.set(key, true);
    } else positional.push(a);
  }
  return { positional, flags };
}

const str = (args: Args, key: string) => {
  const v = args.flags.get(key);
  return typeof v === "string" ? v : undefined;
};

function printResult(r: OperationResult, json: boolean): number {
  if (json) {
    console.log(JSON.stringify(r, null, 2));
  } else {
    if (r.changes.length) {
      const head = r.dryRun ? "Would change:" : r.outcome === "partial" ? "Applied (partially; see the failed steps):" : r.ok ? "Changed:" : "Planned (not applied):";
      console.log(head);
      for (const c of r.changes) console.log(`  [${c.kind}] ${c.summary}${c.network ? "  (needs network)" : ""}`);
    }
    if (!r.dryRun && r.steps?.length) {
      console.log("Steps:");
      for (const st of r.steps) console.log(`  ${st.status === "done" ? "done  " : st.status === "failed" ? "FAILED" : "skip  "} ${st.name}${st.detail ? ` — ${st.detail}` : ""}`);
    }
    if (!r.dryRun && r.outcome) console.log(`Result: ${r.outcome}`);
    for (const m of r.messages) console.log(m);
    if (r.blocked) console.log(`BLOCKED: ${r.blocked}`);
    for (const e of r.errors) console.error(`error: ${e}`);
    if (r.ok && r.dryRun && r.changes.length) console.log("Preview only. Re-run with --yes to apply.");
  }
  if (r.blocked) return EXIT.blocked;
  if (!r.ok) return EXIT.problem;
  return r.dryRun && r.changes.length ? EXIT.confirm : EXIT.ok;
}

const marker: Record<Check["status"], string> = {
  healthy: "ok  ", missing: "MISS", disabled: "off ", outdated: "OLD ", incompatible: "INCP",
  "config-error": "CONF", "runtime-error": "RUN!", unverified: "??  ",
};

export function formatCheck(c: Check, verbose = false): string[] {
  const lines = [`[${marker[c.status]}] ${c.component}: ${c.summary}  (${c.status}, ${c.basis})`];
  if (verbose || !["healthy", "disabled"].includes(c.status)) for (const e of c.evidence) lines.push(`         ${e}`);
  if (c.repair) lines.push(`         repair: ${c.repair.automatic ? c.repair.command ?? "automatic" : "manual"} — ${c.repair.changes.join("; ")}`);
  return lines;
}

export async function main(argv: readonly string[]): Promise<number> {
  try {
    return await dispatch(argv);
  } catch (error) {
    // Expected failures (lock held, unreadable config, …) are reported, not dumped as a stack.
    const message = (error as Error).message ?? String(error);
    if (argv.includes("--json")) console.log(JSON.stringify({ ok: false, outcome: "failed", errors: [message] }));
    else console.error(`error: ${message}`);
    return (error as Error).name === "BlockedError" ? EXIT.blocked : EXIT.problem;
  }
}

async function dispatch(argv: readonly string[]): Promise<number> {
  const args = parseArgs(argv);
  const [command, sub, ...rest] = args.positional;
  const json = args.flags.has("json");
  const project = resolve(str(args, "dir") ?? process.cwd());
  const apply = args.flags.has("yes") && !args.flags.has("dry-run");
  const scope = (str(args, "scope") ?? "project") as "project" | "global";
  if (scope !== "project" && scope !== "global") {
    console.error("--scope must be project or global");
    return EXIT.usage;
  }
  const progress = json ? () => undefined : (m: string) => console.error(`  … ${m}`);

  switch (command) {
    case "version":
      console.log(version());
      return EXIT.ok;
    case "pack": {
      const r = pack(str(args, "out") ?? process.cwd(), resolve(str(args, "source") ?? packageRoot));
      if (json) console.log(JSON.stringify(r));
      else console.log(`${r.file}\nsha256   ${r.sha256}\nidentity ${r.identity} (${r.files} files)`);
      return EXIT.ok;
    }
    case "inspect": {
      const s = inspect(sub ?? packageRoot, str(args, "sha256"));
      const view = { kind: s.kind, path: s.path, version: s.version, identity: s.digest, files: s.files, integrity: s.integrity, ...(s.sha256 ? { sha256: s.sha256 } : {}) };
      if (json) console.log(JSON.stringify(view, null, 2));
      else console.log(Object.entries(view).map(([k, v]) => `${k.padEnd(10)}${v}`).join("\n"));
      return EXIT.ok;
    }
    case "reconcile": {
      // Used by setup/update on a STAGED release before activation; read-only.
      const r = await reconcile(project);
      if (json) console.log(JSON.stringify(r));
      else console.log([...r.blocking.map((b) => `BLOCKING  ${b}`), ...r.advisory.map((a) => `advisory  ${a}`)].join("\n") || "compatible");
      return r.blocking.length ? EXIT.problem : EXIT.ok;
    }
    case "doctor": {
      const report = await doctor({ project, runtime: args.flags.has("runtime") });
      if (json) console.log(JSON.stringify(report, null, 2));
      else {
        for (const c of report.checks) for (const line of formatCheck(c, args.flags.has("verbose"))) console.log(line);
        const s = report.summary;
        console.log(`\n${s.healthy} healthy, ${s.unverified} unverified, ${s.disabled} disabled, ${s.missing + s.incompatible + s["config-error"] + s["runtime-error"] + s.outdated} problems${report.runtimeProbed ? "" : " (static checks; add --runtime to query OpenCode)"}`);
      }
      return failing(report).length ? EXIT.problem : EXIT.ok;
    }
    case "setup": {
      const dev = args.flags.get("dev");
      const r = await setup({
        scope, project, mode: args.flags.has("release") ? "release" : "dev",
        ...(typeof dev === "string" ? { from: dev } : str(args, "from") ? { from: str(args, "from") as string } : {}),
        ...(str(args, "sha256") ? { sha256: str(args, "sha256") as string } : {}),
        dryRun: !apply, adopt: args.flags.has("adopt"), linkBin: args.flags.has("link-bin"), force: args.flags.has("force"),
        with: (str(args, "with") ?? "").split(",").filter(Boolean), progress,
      });
      return printResult(r, json);
    }
    case "update": {
      if (args.flags.has("check")) {
        const c = await checkUpdate({ ...(str(args, "from") ? { from: str(args, "from") as string } : {}), ...(str(args, "sha256") ? { sha256: str(args, "sha256") as string } : {}) });
        if (json) console.log(JSON.stringify(c, null, 2));
        else console.log([`current: ${c.current ?? "unknown"}`, `channel: ${c.channel}`, c.candidate ? `available: ${c.candidate.version} (${c.candidate.kind}, ${c.candidate.integrity})` : "", c.error ?? ""].filter(Boolean).join("\n"));
        return c.error ? EXIT.problem : EXIT.ok;
      }
      return printResult(await update({ ...(str(args, "from") ? { from: str(args, "from") as string } : {}), ...(str(args, "sha256") ? { sha256: str(args, "sha256") as string } : {}), project, dryRun: !apply, force: args.flags.has("force"), progress }), json);
    }
    case "rollback":
      return printResult(await rollback({ ...(str(args, "to") ? { to: str(args, "to") as string } : {}), project, dryRun: !apply, keepTools: args.flags.has("keep-tools") }), json);
    case "repair":
      return printResult(await repair({ project, dryRun: !apply, keepChanged: args.flags.has("keep-changed") }), json);
    case "models": {
      const action = sub ?? "list";
      if (action === "list" || action === "available") {
        let runtime: { agents?: Awaited<ReturnType<typeof listAgents>>["value"]; models?: string[]; error?: string } = {};
        if (args.flags.has("runtime") || action === "available") {
          const [a, m] = await Promise.all([action === "available" ? Promise.resolve({ ok: false } as Awaited<ReturnType<typeof listAgents>>) : listAgents(project), listModels(project)]);
          runtime = { ...(a.ok && a.value ? { agents: a.value } : {}), ...(m.ok && m.value ? { models: m.value } : {}), ...(!m.ok ? { error: m.error ?? "model list unavailable" } : {}) };
        }
        const view = modelView(project, runtime);
        if (action === "available") {
          if (json) console.log(JSON.stringify(view.available ?? [], null, 2));
          else if (view.available) console.log(view.available.join("\n") || "(OpenCode lists no models)");
          else console.error(`cannot list models: ${runtime.error}`);
          return view.available ? EXIT.ok : EXIT.problem;
        }
        if (json) console.log(JSON.stringify(view, null, 2));
        else {
          console.log(`default model: ${view.defaultModel.value ?? "(none)"}  — ${view.defaultModel.source}`);
          console.log(`${"role".padEnd(11)}${"configured".padEnd(36)}${"source".padEnd(10)}${"resolved (runtime)".padEnd(32)}status`);
          for (const r of view.rows) {
            const src = r.configured ? (r.source.startsWith("project") ? "project" : r.source.startsWith("global") ? "global" : r.source.split(":")[0]) : "-";
            console.log(`${r.role.padEnd(11)}${(r.configured ?? "(session model)").padEnd(36)}${(src ?? "-").padEnd(10)}${(r.resolved ?? (view.runtime.agents ? "(none)" : "not probed")).padEnd(32)}${r.status}${r.note ? ` — ${r.note}` : ""}`);
          }
          if (!view.runtime.agents) console.log("\nConfigured values only. --runtime asks OpenCode for resolved agents and available models.");
        }
        return view.rows.some((r) => r.status === "invalid") ? EXIT.problem : EXIT.ok;
      }
      const role = rest[0];
      if (!role) {
        console.error(`usage: aria models ${action} <role|default>${action === "set" ? " <provider/model[#variant]>" : ""}`);
        return EXIT.usage;
      }
      if (action === "set" || action === "default") {
        const spec = action === "default" ? role : rest[1];
        const target = action === "default" ? "default" : role;
        if (!spec) {
          console.error("missing model");
          return EXIT.usage;
        }
        const available = args.flags.has("force") ? undefined : (await listModels(project)).value;
        return printResult(await setModel({ role: target, spec, scope, project, dryRun: !apply, ...(available ? { available } : {}), force: args.flags.has("force") }), json);
      }
      if (action === "reset") return printResult(await setModel({ role, spec: undefined, scope, project, dryRun: !apply }), json);
      if (action === "restore") return printResult(await restoreModel(role, project, !apply), json);
      console.error(`unknown models action ${action}`);
      return EXIT.usage;
    }
    case "deps": {
      const action = sub ?? "list";
      if (action === "list") {
        const deps = await allDeps(project);
        if (json) console.log(JSON.stringify(deps, null, 2));
        else for (const d of deps) {
          console.log(`${d.id.padEnd(16)}${d.requirement.padEnd(10)}${(d.kind === "mcp" ? (d.enabled ? "enabled" : "disabled") : "-").padEnd(10)}${(d.version ?? "-").padEnd(10)}${d.ownership.padEnd(14)}${d.health}`);
          for (const e of d.evidence) console.log(`${"".padEnd(16)}${e}`);
          if (d.actions.length) console.log(`${"".padEnd(16)}actions: ${d.actions.join(", ")}`);
        }
        return deps.some((d) => d.requirement === "required" && !["healthy", "unverified"].includes(d.health)) ? EXIT.problem : EXIT.ok;
      }
      if (action === "check") {
        const ids = rest[0] ? [rest[0]] : MANIFEST.filter((d) => d.mcp).map((d) => d.id);
        const results = await Promise.all(ids.map((i) => readiness(i, project, { requireEnabled: !rest[0] })));
        if (json) console.log(JSON.stringify(results, null, 2));
        else for (const r of results) {
          console.log(`${r.id.padEnd(16)}${r.state.padEnd(13)}${r.ownership.padEnd(24)}${r.detail}`);
          for (const st of r.steps) console.log(`${"".padEnd(16)}${st.status === "done" ? "ok    " : st.status === "failed" ? "FAILED" : "skip  "} ${st.name}${st.detail ? ` — ${st.detail}` : ""}`);
        }
        return results.every((r) => r.ok) ? EXIT.ok : EXIT.problem;
      }
      const id = rest[0];
      if (!id) {
        console.error(`usage: aria deps ${action} <id>`);
        return EXIT.usage;
      }
      if (action === "install" || action === "update") return printResult(await installDep(id, { dryRun: !apply, progress }), json);
      if (action === "enable") return printResult(await enableDep(id, { scope, project, dryRun: !apply, replace: args.flags.has("replace") }), json);
      if (action === "disable") return printResult(await disableDep(id, { project, dryRun: !apply }), json);
      if (action === "probe") {
        const r = await probeDep(id, false, project);
        if (json) console.log(JSON.stringify(r, null, 2));
        else {
          console.log(r.ok ? `server ${r.server?.name ?? "?"} ${r.server?.version ?? ""}: ${r.tools.length} tools` : `probe failed: ${r.error}`);
          if (r.ok) {
            console.log(`  read (allowed for researcher): ${r.classifiedRead.length}`);
            console.log(`  mutating (ask): ${r.classifiedMutating.length}`);
            console.log(`  unclassified (hidden until classified): ${r.unclassified.join(", ") || "none"}`);
            console.log(`  in ARIA's rules but not exposed: ${r.absent.join(", ") || "none"}`);
          }
        }
        return r.ok && r.unclassified.length === 0 ? EXIT.ok : EXIT.problem;
      }
      console.error(`unknown deps action ${action}`);
      return EXIT.usage;
    }
    case "plans": {
      const { plans, problems, state } = loadPlans(project);
      if (json) console.log(JSON.stringify({ state, plans, problems }, null, 2));
      else {
        if (!plans.length) console.log(state === "absent" ? "No .aria/plans/ directory." : "No plans in .aria/plans/.");
        for (const p of plans) console.log(`[${p.status}] ${describePlan(p)}${p.session ? ` (session ${p.session})` : " (no owner recorded)"}`);
        for (const p of problems) console.log(p);
      }
      return problems.length ? EXIT.problem : EXIT.ok;
    }
    case "scratch": {
      if (sub === "list") {
        const { entries, problems } = listScratch(project);
        if (json) console.log(JSON.stringify({ entries, problems }, null, 2));
        else {
          if (!entries.length && !problems.length) console.log("No scratch directories.");
          for (const e of entries) console.log(`${e.root}  ${e.done ? "DONE" : e.reopened ? "reopened" : "open"}  ${e.sessions.length} session dir(s)  last change ${e.modified.toISOString()}${e.problem ? `  MALFORMED: ${e.problem}` : ""}`);
          for (const p of problems) console.log(`problem: ${p}`);
        }
        return problems.length ? EXIT.problem : EXIT.ok;
      }
      if (sub === "clean") {
        const days = str(args, "stale");
        try {
          const r = cleanScratch(project, { dryRun: args.flags.has("dry-run"), ...(days !== undefined ? { staleDays: /^[0-9]+$/.test(days) ? Number(days) : Number.NaN } : {}) });
          if (json) console.log(JSON.stringify(r, null, 2));
          else {
            console.log(`${args.flags.has("dry-run") ? "Would remove" : "Removed"}: ${r.removed.join(", ") || "nothing"}`);
            for (const k of r.kept) console.log(`Kept ${k.root}: ${k.reason}`);
            for (const p of r.problems) console.log(`problem: ${p}`);
          }
          return r.problems.length ? EXIT.problem : EXIT.ok;
        } catch (error) {
          console.error((error as Error).message);
          return EXIT.usage;
        }
      }
      console.error("usage: aria scratch list | clean [--stale N] [--dry-run]");
      return EXIT.usage;
    }
    case undefined:
    case "help":
    case "--help":
      console.log(USAGE);
      return command === undefined ? EXIT.ok : EXIT.ok;
    default:
      console.error(`unknown command ${command}\n\n${USAGE}`);
      return EXIT.usage;
  }
}
