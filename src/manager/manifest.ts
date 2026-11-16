import { join } from "node:path";
import { isWindows, pythonEnvBinDirs, toolsDir } from "./env.ts";

/**
 * The one authoritative list of what ARIA depends on. Setup, update, diagnostics, the CLI and the
 * management TUI all read this; nothing else declares dependencies.
 *
 * Ownership:
 *   external  installed and upgraded by the user (or a hosted service); ARIA only detects it and
 *             never changes it
 *   aria      installed by ARIA under ARIA_HOME (tools/<id>) or inside an ARIA release; setup,
 *             update, rollback and repair cover it
 *   either    reused if an existing compatible installation is found, otherwise ARIA can install
 *             its own copy under ARIA_HOME; an existing copy is never modified
 *
 * Integrations ARIA neither needs nor manages are not listed at all (Engram and CodeGraph were
 * removed in alpha.5: nothing in ARIA depends on them, and a detect-only entry produced health
 * noise without a lifecycle). Users can still configure any MCP server themselves; its tools are
 * unclassified, so coding roles ask before each use and read-only roles cannot see them.
 *
 * No secrets live here. MCP configuration written by ARIA contains executable paths and fixed
 * environment flags only; credentials stay in the user's own config or the server's own store.
 */

export type Requirement = "required" | "optional";
export type Ownership = "external" | "aria" | "either";
export type Kind = "runtime" | "package" | "mcp";

export interface Install {
  /** `npm-prefix`: `npm install <package>@<pin>` into tools/<id>-<stamp>. `python-venv`: venv in tools/<id>-<stamp> + pip `<package>==<pin>`. `release-deps`: `npm ci --omit=dev` from the release lockfile. */
  readonly method: "npm-prefix" | "python-venv" | "release-deps";
  readonly package?: string;
  /** Exact version ARIA installs (reproducible); an upgrade of ARIA may move the pin. */
  readonly pin?: string;
  /** Executable inside the managed install, relative to tools/<id>. */
  readonly executable?: string;
  readonly network: true;
}

export interface Dependency {
  readonly id: string;
  readonly name: string;
  readonly purpose: string;
  readonly kind: Kind;
  readonly requirement: Requirement;
  /** Optional integrations are off until the user enables them. */
  readonly defaultEnabled: boolean;
  readonly ownership: Ownership;
  readonly platforms?: readonly NodeJS.Platform[];
  /** How to find an existing copy. */
  readonly executable?: string;
  readonly searchDirs?: () => string[];
  /** Arguments that print a version, and the compatible range. */
  readonly versionArgs?: readonly string[];
  readonly range?: string;
  readonly install?: Install;
  /** How the user installs an external dependency (shown, never executed by ARIA). */
  readonly installHint?: string;
  /** For MCP integrations: the OpenCode `mcp.servers.<name>` entry ARIA writes when enabled. */
  readonly mcp?: {
    readonly server: string;
    /** undefined: user-managed integration; ARIA detects it but never writes its entry. */
    readonly config?: (executable: string | undefined) => Record<string, unknown>;
    /** A tool inventory check is possible (local stdio server). */
    readonly probe: boolean;
    /** Operational readiness: a read-only tool call that needs the backing service (e.g. Zotero desktop). */
    readonly readyCall?: { readonly tool: string; readonly args: Record<string, unknown>; readonly needs: string };
    /** Remote server: readiness is an MCP `initialize` over HTTP (network). */
    readonly remoteUrl?: string;
  };
  /** Extra provisioning after install (Playwright browsers). */
  readonly provision?: { readonly what: string; readonly args: readonly string[]; readonly dir: string; readonly network: true };
  readonly upgrade: string;
  /** Network needed for its health check. */
  readonly healthNeedsNetwork?: boolean;
}

const bin = (name: string) => (isWindows ? join("Scripts", `${name}.exe`) : join("bin", name));

export const MANIFEST: readonly Dependency[] = [
  {
    id: "opencode",
    name: "OpenCode",
    purpose: "Runs ARIA's server and TUI plugins.",
    kind: "runtime",
    requirement: "required",
    defaultEnabled: true,
    ownership: "external",
    executable: "opencode",
    versionArgs: ["--version"],
    range: ">=2.3.0 <3.0.0",
    installHint: "Install OpenCode v2 yourself (https://opencode.ai/docs). ARIA never installs or upgrades it.",
    upgrade: "User-managed. ARIA reports incompatibility but never upgrades OpenCode.",
  },
  {
    id: "node",
    name: "Node.js",
    purpose: "Runs the ARIA CLI and management TUI.",
    kind: "runtime",
    requirement: "required",
    defaultEnabled: true,
    ownership: "external",
    executable: "node",
    versionArgs: ["--version"],
    range: ">=22.18.0",
    installHint: "Install Node.js 22.18 or newer with your system package manager or nvm.",
    upgrade: "User-managed.",
  },
  {
    id: "git",
    name: "Git",
    purpose: "Backs the read-only aria_git tool.",
    kind: "runtime",
    requirement: "optional",
    defaultEnabled: true,
    ownership: "external",
    executable: "git",
    versionArgs: ["--version"],
    range: ">=2.20.0",
    installHint: "Install Git with your system package manager.",
    upgrade: "User-managed.",
  },
  {
    id: "aria-cli-deps",
    name: "ARIA CLI packages",
    purpose: "terminal-kit and jsonc-parser for the CLI and management TUI (the OpenCode plugins need none).",
    kind: "package",
    requirement: "required",
    defaultEnabled: true,
    ownership: "aria",
    install: { method: "release-deps", network: true },
    upgrade: "Installed per release; an update installs the new release's own copy and leaves the old release intact.",
  },
  {
    id: "zotero-mcp",
    name: "Zotero MCP (zotero-mcp-server)",
    purpose: "Read access to the Zotero library for the researcher role; library changes always ask.",
    kind: "mcp",
    requirement: "optional",
    defaultEnabled: false,
    ownership: "either",
    executable: "zotero-mcp",
    searchDirs: () => [join(toolsDir(), "zotero-mcp", isWindows ? "Scripts" : "bin"), ...pythonEnvBinDirs()],
    versionArgs: ["version"],
    install: { method: "python-venv", package: "zotero-mcp-server", pin: "0.17.2", executable: bin("zotero-mcp"), network: true },
    mcp: {
      server: "zotero",
      config: (exe) => ({ type: "local", command: [exe ?? "zotero-mcp", "serve"], environment: { ZOTERO_LOCAL: "true" } }),
      probe: true,
      // zotero_list_libraries answers even without a backend (it reports errors as text);
      // zotero_get_recent needs the local API. An answer starting with "Error" is a failure.
      readyCall: { tool: "zotero_get_recent", args: { limit: 1 }, needs: "Zotero desktop running with its local API enabled" },
    },
    upgrade: "An existing installation is reused and never upgraded by ARIA. A copy ARIA installed under ARIA_HOME/tools can be upgraded with `aria deps update zotero-mcp`.",
  },
  {
    id: "context7",
    name: "Context7 docs (remote MCP)",
    purpose: "Current library documentation lookups; read-only.",
    kind: "mcp",
    requirement: "optional",
    defaultEnabled: false,
    ownership: "external",
    mcp: { server: "context7", config: () => ({ type: "remote", url: "https://mcp.context7.com/mcp" }), probe: false, remoteUrl: "https://mcp.context7.com/mcp" },
    upgrade: "Hosted service; nothing to install.",
    healthNeedsNetwork: true,
  },
  {
    id: "playwright-mcp",
    name: "Playwright MCP",
    purpose: "Browser automation for UI work; every tool asks (no role allows it by default).",
    kind: "mcp",
    requirement: "optional",
    defaultEnabled: false,
    ownership: "aria",
    executable: "playwright-mcp",
    searchDirs: () => [join(toolsDir(), "playwright-mcp", "node_modules", ".bin")],
    versionArgs: ["--version"],
    install: { method: "npm-prefix", package: "@playwright/mcp", pin: "0.0.85", executable: join("node_modules", ".bin", isWindows ? "playwright-mcp.cmd" : "playwright-mcp"), network: true },
    // Browsers live in an ARIA-owned directory, passed to the server through its environment.
    // `--browser chromium` makes the server use that download (channel chrome-for-testing)
    // instead of a system Chrome.
    provision: { what: "Chromium for Playwright", args: ["install", "chromium"], dir: "playwright-browsers", network: true },
    mcp: {
      server: "playwright",
      config: (exe) => ({ type: "local", command: [exe ?? "playwright-mcp", "--headless", "--browser", "chromium"], environment: { PLAYWRIGHT_BROWSERS_PATH: join(toolsDir(), "playwright-browsers") } }),
      probe: true,
    },
    upgrade: "ARIA-managed under ARIA_HOME/tools/playwright-mcp-<stamp>, with Chromium in ARIA_HOME/tools/playwright-browsers.",
  },
];

export const dependency = (id: string) => MANIFEST.find((d) => d.id === id);
