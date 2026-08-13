import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { afterAll } from "vitest";

const originalHome = process.env.HOME;
const testHome = mkdtempSync(resolve(tmpdir(), "aria-vitest-home-"));

process.env.HOME = testHome;

afterAll(() => {
  process.env.HOME = originalHome;
  rmSync(testHome, { recursive: true, force: true });
});
