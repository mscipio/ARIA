import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

// ---------------------------------------------------------------------------
// R005 annotated-tag provenance: the verifier must compare the local peeled
// commit (`<tag>^{commit}`) against the REMOTE peeled commit
// (`refs/tags/<tag>^{}`), falling back to the direct ref only for
// lightweight tags (which have no `^{}` line). Comparing the direct tag
// ref instead falsely reports drift for every annotated tag (tag-object SHA
// vs commit SHA).
//
// These fixtures exercise that exact git semantics against fully local
// bare-origin repos (no network): annotated PASS via `^{}`, lightweight
// PASS via direct-ref fallback, mismatched peeled commit FAIL, missing tag
// FAIL. A source-shape assertion pins the verifier script to the
// peeled-first selection so the script and this semantics cannot drift
// apart (`scripts/verify-release-tag.mjs` is not importable — it executes
// on load — so the behavior contract is asserted here, not via import).
// ---------------------------------------------------------------------------

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const TEST_TIMEOUT_MS = 30_000;

const tempRoots: string[] = [];

afterEach(() => {
  while (tempRoots.length > 0) rmSync(tempRoots.pop()!, { recursive: true, force: true });
});

function git(cwd: string, ...args: string[]): string {
  return execFileSync(
    "git",
    [
      "-c",
      "user.name=aria-test",
      "-c",
      "user.email=aria-test@example.com",
      "-c",
      "commit.gpgsign=false",
      "-c",
      "tag.gpgsign=false",
      "-c",
      "protocol.file.allow=always",
      ...args,
    ],
    {
      cwd,
      encoding: "utf8",
      env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_TERMINAL_PROMPT: "0" },
    },
  ).trim();
}

/** Bare `origin` plus a work clone with one pushed commit; returns both paths. */
function initFixture(): { root: string; origin: string; work: string } {
  const root = mkdtempSync(join(tmpdir(), "aria-verify-tag-"));
  tempRoots.push(root);
  const origin = join(root, "origin.git");
  const work = join(root, "work");
  git(root, "init", "--bare", origin);
  git(root, "init", "-b", "main", work);
  git(work, "remote", "add", "origin", origin);
  writeFileSync(join(work, "file.txt"), "v1\n");
  git(work, "add", "file.txt");
  git(work, "commit", "-m", "fixture commit");
  return { root, origin, work };
}

/** Mirror of the verifier's remote-commit selection (peeled `^{}` first, direct ref fallback). */
function selectRemoteCommit(lsRemoteOutput: string, tag: string): string {
  const refs = new Map<string, string>();
  for (const entry of lsRemoteOutput.split("\n")) {
    const trimmed = entry.trim();
    if (!trimmed) continue;
    const [sha, ref] = trimmed.split(/\s+/);
    if (sha && ref) refs.set(ref, sha);
  }
  return refs.get(`refs/tags/${tag}^{}`) ?? refs.get(`refs/tags/${tag}`) ?? "";
}

function lsRemote(cwd: string, origin: string, tag: string): string {
  return git(cwd, "ls-remote", origin, `refs/tags/${tag}`, `refs/tags/${tag}^{}`);
}

describe("R005 verify-release-tag remote provenance (peeled commit)", () => {
  it("annotated tag passes via the peeled remote commit (direct ref is the tag object)", () => {
    const { origin, work } = initFixture();
    git(work, "tag", "-a", "v9.9.9", "-m", "annotated release");
    git(work, "push", "origin", "v9.9.9");

    const output = lsRemote(work, origin, "v9.9.9");
    const lines = output.split("\n").map((line) => line.trim()).filter(Boolean);
    // Annotated tags advertise both the tag object and its peeled commit.
    expect(lines).toHaveLength(2);
    const localCommit = git(work, "rev-parse", "v9.9.9^{commit}");
    const directSha = selectRemoteCommit(git(work, "ls-remote", origin, "refs/tags/v9.9.9"), "v9.9.9");
    // Pins the R005 bug shape: the direct ref is the tag object, NOT the commit.
    expect(directSha).not.toBe(localCommit);
    expect(selectRemoteCommit(output, "v9.9.9")).toBe(localCommit);
  }, TEST_TIMEOUT_MS);

  it("lightweight tag passes via the direct-ref fallback (no ^{} line)", () => {
    const { origin, work } = initFixture();
    git(work, "tag", "v9.9.8");
    git(work, "push", "origin", "v9.9.8");

    const output = lsRemote(work, origin, "v9.9.8");
    const lines = output.split("\n").map((line) => line.trim()).filter(Boolean);
    // Lightweight tags have no peeled line; the direct ref is the commit.
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(/refs\/tags\/v9\.9\.8$/);
    expect(lines[0]).not.toContain("^{}");
    const localCommit = git(work, "rev-parse", "v9.9.8^{commit}");
    expect(selectRemoteCommit(output, "v9.9.8")).toBe(localCommit);
  }, TEST_TIMEOUT_MS);

  it("mismatched peeled commit fails (remote drift detected)", () => {
    const { root, origin, work } = initFixture();
    git(work, "tag", "-a", "v9.9.7", "-m", "annotated release");
    git(work, "push", "origin", "v9.9.7");
    // Stale observer holding the original tag while origin moves forward.
    git(root, "clone", "--no-checkout", origin, join(root, "observer"));
    const observer = join(root, "observer");
    writeFileSync(join(work, "file.txt"), "v2\n");
    git(work, "commit", "-am", "second commit");
    git(work, "tag", "-f", "-a", "v9.9.7", "-m", "moved release");
    git(work, "push", "--force", "origin", "v9.9.7");

    const staleLocal = git(observer, "rev-parse", "v9.9.7^{commit}");
    const remoteCommit = selectRemoteCommit(lsRemote(observer, origin, "v9.9.7"), "v9.9.7");
    expect(remoteCommit).not.toBe("");
    // The verifier's equality check would FAIL here (drift), as required.
    expect(remoteCommit).not.toBe(staleLocal);
  }, TEST_TIMEOUT_MS);

  it("missing tag fails (origin has no such ref)", () => {
    const { origin, work } = initFixture();
    const remoteCommit = selectRemoteCommit(lsRemote(work, origin, "v0.0.0-missing"), "v0.0.0-missing");
    // The verifier's `if (!remoteCommit) fail(...)` branch: empty means missing.
    expect(remoteCommit).toBe("");
  }, TEST_TIMEOUT_MS);

  it("verifier queries the peeled ref first with direct-ref fallback", () => {
    const source = readFileSync(join(repoRoot, "scripts", "verify-release-tag.mjs"), "utf8");
    expect(source).toContain("`refs/tags/${tag}^{}`");
    expect(source).toContain("refs/tags/${tag}^{}");
    expect(source).toContain("??");
  });
});
