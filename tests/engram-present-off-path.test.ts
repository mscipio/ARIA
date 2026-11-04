import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { Executor } from "../src/deps";
import { ensureEngram } from "../src/engram";

// An Engram binary present at a standard location but absent from PATH is an
// existing installation. ARIA must report it and must not reinstall it: a second
// copy would shadow the user's own Engram. Simulated executors only.

let root: string;
let previousHome: string | undefined;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "aria-engram-offpath-"));
  previousHome = process.env.HOME;
  process.env.HOME = join(root, "home");
  await mkdir(join(root, "home", ".local", "bin"), { recursive: true });
  await writeFile(join(root, "home", ".local", "bin", "engram"), "#!/bin/sh\n", { mode: 0o755 });
});

afterEach(async () => {
  if (previousHome === undefined) delete process.env.HOME;
  else process.env.HOME = previousHome;
  await rm(root, { recursive: true, force: true });
});

describe("Engram present but not on PATH", () => {
  it("reports the existing install and performs zero mutation (no brew, GitHub, or setup call)", async () => {
    const calls: string[] = [];
    const executor: Executor = async (command, args) => {
      const key = `${command} ${args.join(" ")}`;
      calls.push(key);
      // Not on PATH: the executable lookup fails, exactly as with a missing binary.
      if (command === "engram" || command === "which" || command === "brew") {
        throw Object.assign(new Error(`spawn ${command} ENOENT`), { code: "ENOENT" });
      }
      throw new Error(`unexpected in test: ${key}`);
    };

    const result = await ensureEngram(executor);

    expect(result.status).toBe("report-only");
    expect(result.mutated).toBe(false);
    expect(result.detail).toContain(join(root, "home", ".local", "bin", "engram"));
    expect(result.detail).toContain("not on PATH");
    expect(calls.some((call) => /install|upgrade|setup|api\.github/.test(call))).toBe(false);
  });

  it("still treats a genuinely absent Engram as missing (no standard location present)", async () => {
    await rm(join(root, "home", ".local", "bin", "engram"), { force: true });
    const calls: string[] = [];
    const executor: Executor = async (command, args) => {
      calls.push(`${command} ${args.join(" ")}`);
      throw Object.assign(new Error(`spawn ${command} ENOENT`), { code: "ENOENT" });
    };

    const result = await ensureEngram(executor);

    expect(result.detail).not.toContain("not on PATH");
    expect(calls.some((call) => call.startsWith("brew which") || call.startsWith("which brew"))).toBe(true);
  });
});
