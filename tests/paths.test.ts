import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { openCodeGlobalDir } from "../src/paths.js";

const FAKE_HOME = "/tmp/fake-home-for-paths-test";

describe("openCodeGlobalDir", () => {
  let originalHome: string | undefined;
  let originalXdg: string | undefined;

  beforeEach(() => {
    originalHome = process.env.HOME;
    originalXdg = process.env.XDG_CONFIG_HOME;
    // os.homedir() follows $HOME on POSIX, so pinning HOME pins homedir().
    process.env.HOME = FAKE_HOME;
  });

  afterEach(() => {
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
    if (originalXdg === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = originalXdg;
  });

  it("falls back to ~/.config/opencode when XDG_CONFIG_HOME is unset", () => {
    delete process.env.XDG_CONFIG_HOME;
    expect(openCodeGlobalDir()).toBe(join(FAKE_HOME, ".config", "opencode"));
  });

  it("uses $XDG_CONFIG_HOME/opencode when set", () => {
    process.env.XDG_CONFIG_HOME = "/tmp/custom-config";
    expect(openCodeGlobalDir()).toBe(join("/tmp/custom-config", "opencode"));
  });

  it("treats empty XDG_CONFIG_HOME as unset", () => {
    process.env.XDG_CONFIG_HOME = "";
    expect(openCodeGlobalDir()).toBe(join(FAKE_HOME, ".config", "opencode"));
    process.env.XDG_CONFIG_HOME = "   ";
    expect(openCodeGlobalDir()).toBe(join(FAKE_HOME, ".config", "opencode"));
  });

  it("prefers an explicit override over env and fallback", () => {
    process.env.XDG_CONFIG_HOME = "/tmp/custom-config";
    expect(openCodeGlobalDir("/tmp/explicit-global")).toBe("/tmp/explicit-global");
    delete process.env.XDG_CONFIG_HOME;
    expect(openCodeGlobalDir("/tmp/explicit-global")).toBe("/tmp/explicit-global");
    process.env.XDG_CONFIG_HOME = "/tmp/custom-config";
    expect(openCodeGlobalDir("   ")).toBe(join("/tmp/custom-config", "opencode"));
  });
});
