import { createOpencodeServer } from "@opencode-ai/sdk/v2";
import { createOpencodeClient } from "@opencode-ai/sdk/v2/client";
import type { ModelV2Info, ProviderV2Info } from "@opencode-ai/sdk/v2/types";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, rename, unlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, resolve } from "node:path";
import { createInterface } from "node:readline";

import { loadDefaultConfig } from "./defaults.js";
import { parseOverrides, readGlobalAriaOverrides, readProjectAriaOverrides, resolveAriaConfig } from "./overrides.js";
import type {
  AriaDefaults,
  AriaProjectOverrides,
  ResolvedAriaConfig,
  RoleDefaults,
  RoleName,
  RoleOverride,
} from "./types.js";

/**
 * An available model, normalized to ARIA's providerID/modelID identifier.
 */
export interface AvailableModel {
  /** ARIA model identifier in provider/model format (e.g. "opencode/deepseek-v4-pro"). */
  id: string;
  providerID: string;
  modelID: string;
  name: string;
  /** Model-reported variant IDs that are not disabled. */
  variants: string[];
}

/**
 * An active AI provider.
 */
export interface AvailableProvider {
  id: string;
  name: string;
}

/**
 * Available enabled models and active providers discovered for a worktree.
 */
export interface ModelDiscovery {
  models: AvailableModel[];
  providers: AvailableProvider[];
}

/**
 * Discovery failed; no configuration has been written or changed.
 */
export class ModelDiscoveryError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "ModelDiscoveryError";
  }
}

// The 1.18.1 SDK declares variants as { id, headers, body } only; the server
// representation may still report disabled entries, so read the flag defensively.
type VariantEntry = { id: string; disabled?: boolean };

function describeDiscoveryError(error: unknown): string {
  if (error instanceof Error && error.message) return error.message;
  if (error && typeof error === "object" && typeof (error as { message?: unknown }).message === "string") {
    return (error as { message: string }).message;
  }
  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
}

function ariaModelIdentifier(providerID: string, reportedID: string): string {
  return reportedID.startsWith(`${providerID}/`) ? reportedID : `${providerID}/${reportedID}`;
}

function ariaModelID(providerID: string, reportedID: string): string {
  return reportedID.startsWith(`${providerID}/`) ? reportedID.slice(providerID.length + 1) : reportedID;
}

function enabledVariantIds(variants: ModelV2Info["variants"]): string[] {
  return (variants as VariantEntry[])
    .filter((variant) => variant.disabled !== true && variant.id.trim().length > 0)
    .map((variant) => variant.id);
}

/**
 * Retain only enabled models whose provider is returned as active (not
 * disabled), normalizing each choice to ARIA's providerID/modelID identifier.
 */
export function normalizeAvailableModels(
  models: ModelV2Info[],
  providers: ProviderV2Info[],
): AvailableModel[] {
  const activeProviderIDs = new Set(
    providers.filter((provider) => provider.disabled !== true).map((provider) => provider.id),
  );
  return models
    .filter((model) => model.enabled && activeProviderIDs.has(model.providerID))
    .map((model) => ({
      id: ariaModelIdentifier(model.providerID, model.id),
      providerID: model.providerID,
      modelID: ariaModelID(model.providerID, model.id),
      name: model.name,
      variants: enabledVariantIds(model.variants),
    }));
}

/**
 * Retain only providers returned as active (not disabled).
 */
export function normalizeAvailableProviders(providers: ProviderV2Info[]): AvailableProvider[] {
  return providers
    .filter((provider) => provider.disabled !== true)
    .map((provider) => ({ id: provider.id, name: provider.name }));
}

/**
 * Discover available models and providers for a worktree.
 *
 * `aria setup` is a standalone CLI without a PluginInput client, so this
 * starts an ephemeral loopback OpenCode server through the SDK's server
 * bootstrap, creates the generated V2 directory-scoped client for the server
 * URL and worktree, and reads Model.list({ location }) and
 * Provider2.list({ location }).
 *
 * Server-startup, API-incompatibility, and discovery-response errors fail
 * discovery cleanly and leave configuration untouched.
 */
export async function discoverAvailableModels(worktree: string): Promise<ModelDiscovery> {
  let server: { url: string; close(): void };
  try {
    server = await createOpencodeServer();
  } catch (error) {
    throw new ModelDiscoveryError(
      `OpenCode server failed to start: ${describeDiscoveryError(error)}`,
      { cause: error },
    );
  }

  try {
    const client = createOpencodeClient({ baseUrl: server.url, directory: worktree });
    const location = { directory: worktree };

    const modelsResult = await client.v2.model.list({ location }).catch((error: unknown) => {
      throw new ModelDiscoveryError(
        `model discovery failed: ${describeDiscoveryError(error)}`,
        { cause: error },
      );
    });
    if (modelsResult.error) {
      throw new ModelDiscoveryError(
        `model discovery failed: ${describeDiscoveryError(modelsResult.error)}`,
        { cause: modelsResult.error },
      );
    }

    const providersResult = await client.v2.provider.list({ location }).catch((error: unknown) => {
      throw new ModelDiscoveryError(
        `provider discovery failed: ${describeDiscoveryError(error)}`,
        { cause: error },
      );
    });
    if (providersResult.error) {
      throw new ModelDiscoveryError(
        `provider discovery failed: ${describeDiscoveryError(providersResult.error)}`,
        { cause: providersResult.error },
      );
    }

    return {
      models: normalizeAvailableModels(modelsResult.data.data, providersResult.data.data),
      providers: normalizeAvailableProviders(providersResult.data.data),
    };
  } finally {
    server.close();
  }
}

// ---------------------------------------------------------------------------
// Interactive model configuration (`aria setup --configure`)
// ---------------------------------------------------------------------------

/**
 * Discovery seam for `configureModels` (defaults to `discoverAvailableModels`).
 */
export type ModelDiscoverFn = (worktree: string) => Promise<ModelDiscovery>;

/**
 * Terminal input seam: resolve one trimmed line of user input.
 */
export type ModelConfigureInput = (prompt: string) => Promise<string>;

/**
 * Terminal output seam: emit one line of terminal text.
 */
export type ModelConfigureOutput = (text: string) => void;

/**
 * Injectable options for `configureModels`; every seam defaults to the real
 * implementation (SDK discovery, readline over stdin, stdout).
 */
export interface ModelConfigureOptions {
  /** Discovery override (defaults to `discoverAvailableModels`). */
  discovery?: ModelDiscoverFn;
  /** Input override (defaults to readline over `process.stdin`). */
  input?: ModelConfigureInput;
  /** Output override (defaults to `process.stdout`). */
  output?: ModelConfigureOutput;
  /** Explicit TTY override; defaults to `process.stdin.isTTY`. */
  tty?: boolean;
}

export type ModelConfigurationStatus = "configured" | "unchanged" | "skipped" | "failed";

/**
 * Outcome of `configureModels`. Exactly one of `configured`, `unchanged`,
 * `skipped`, or `failed`; configuration is only written for `configured`.
 */
export interface ModelConfigurationResult {
  status: ModelConfigurationStatus;
  /** Canonical global config path written, when status is "configured". */
  wrotePath?: string;
  /** Roles whose global assignment changed in the written file. */
  changedRoles?: RoleName[];
  /** Roles whose edit is masked by a project-local `aria.json` override. */
  maskedRoles?: RoleName[];
  /** Human-readable summary for setup output. */
  message: string;
  /** Error detail, when status is "failed". */
  error?: string;
}

// The nine configurable roles are fixed; discovery reports which models are
// available, never which roles exist.
const ROLES: RoleName[] = [
  "coder",
  "explorer",
  "visualizer",
  "planner",
  "architect",
  "implementer",
  "reviewer",
  "archivist",
  "writer",
];
const ROLE_SET = new Set<string>(ROLES);

const MAX_PROMPT_ATTEMPTS = 3;

type GlobalRoles = Partial<Record<RoleName, RoleOverride>>;
type TopChoice = "recommended" | "current" | "configure";
type AskResult<T> = { value: T } | { cancelled: true } | { failed: true };

function canonicalGlobalConfigPath(): string {
  return resolve(homedir(), ".config", "opencode", "aria.json");
}

function cloneGlobalRoles(roles: GlobalRoles): GlobalRoles {
  const clone: GlobalRoles = {};
  for (const role of Object.keys(roles) as RoleName[]) {
    const entry = roles[role];
    if (entry) clone[role] = { ...entry };
  }
  return clone;
}

/** Drop empty role entries and emit remaining roles in canonical order. */
function cleanGlobalRoles(roles: GlobalRoles): GlobalRoles {
  const clean: GlobalRoles = {};
  for (const role of ROLES) {
    const entry = roles[role];
    if (entry && (entry.model !== undefined || entry.variant !== undefined)) {
      clean[role] = { ...entry };
    }
  }
  return clean;
}

function roleEntryDiffers(a: RoleOverride | undefined, b: RoleOverride | undefined): boolean {
  return (a?.model ?? undefined) !== (b?.model ?? undefined)
    || (a?.variant ?? undefined) !== (b?.variant ?? undefined);
}

function changedRolesBetween(seed: GlobalRoles, final: GlobalRoles): RoleName[] {
  return ROLES.filter((role) => roleEntryDiffers(seed[role], final[role]));
}

function roleDivergesFromDefaults(entry: RoleOverride | undefined, defaults: RoleDefaults): boolean {
  if (!entry) return false;
  return (entry.model !== undefined && entry.model !== defaults.model)
    || (entry.variant !== undefined && entry.variant !== defaults.variant);
}

/** True when every remaining override field equals its packaged default. */
function isDefaultOnly(roles: GlobalRoles, defaults: AriaDefaults): boolean {
  for (const role of ROLES) {
    const entry = roles[role];
    if (!entry) continue;
    const roleDefaults = defaults.roles[role];
    if (roleDivergesFromDefaults(entry, roleDefaults)) return false;
  }
  return true;
}

function routeText(model: string, variant: string | undefined): string {
  return variant ? `${model} (${variant})` : model;
}

function routeAvailability(modelId: string, variant: string | undefined, models: AvailableModel[]): boolean {
  const model = models.find((candidate) => candidate.id === modelId);
  if (!model) return false;
  return variant === undefined || model.variants.includes(variant);
}

interface ProjectMask {
  model: boolean;
  variant: boolean;
}

/** A project-pinned role together with which of its fields are pinned. */
interface RoleMask extends ProjectMask {
  role: RoleName;
}

/**
 * Report which project-local override fields pin a role, masking global edits.
 * Presence is authoritative: a project field masks the role even when its
 * value happens to equal the current global value (editing the global would
 * leave the project pinned to the old route).
 */
function projectMasksFor(projectOverrides: AriaProjectOverrides, role: RoleName): ProjectMask {
  const entry = projectOverrides.roles?.[role];
  return {
    model: entry?.model !== undefined,
    variant: entry?.variant !== undefined,
  };
}

function renderRoleSummary(
  resolved: ResolvedAriaConfig,
  defaults: AriaDefaults,
  models: AvailableModel[],
  projectOverrides: AriaProjectOverrides,
): string {
  const lines = ["ARIA model configuration", ""];
  for (const role of ROLES) {
    const current = resolved.roles[role];
    const recommended = defaults.roles[role];
    const mask = projectMasksFor(projectOverrides, role);
    const maskSuffix = mask.model || mask.variant ? " [project override]" : "";
    const currentAvailability = routeAvailability(current.model, current.variant, models)
      ? "available"
      : "unavailable";
    const recommendedAvailability = routeAvailability(recommended.model, recommended.variant, models)
      ? "available"
      : "unavailable";
    lines.push(`  ${role.padEnd(11)} current:     ${routeText(current.model, current.variant)} [${currentAvailability}]${maskSuffix}`);
    lines.push(`  ${" ".repeat(11)} recommended: ${routeText(recommended.model, recommended.variant)} [${recommendedAvailability}]`);
  }
  return lines.join("\n");
}

function defaultInput(prompt: string): Promise<string> {
  return new Promise((resolveInput, rejectInput) => {
    const terminal = createInterface({ input: process.stdin, output: process.stdout });
    terminal.question(prompt, (answer) => {
      terminal.close();
      resolveInput(answer.trim());
    });
    terminal.on("error", rejectInput);
  });
}

function defaultOutput(text: string): void {
  process.stdout.write(`${text}\n`);
}

function parseTopChoice(answer: string): TopChoice | undefined {
  const text = answer.trim().toLowerCase();
  if (text === "1" || text === "defaults" || text === "recommended" || text === "recommended defaults") {
    return "recommended";
  }
  if (text === "2" || text === "current" || text === "current assignments" || text === "keep current") {
    return "current";
  }
  if (text === "3" || text === "configure" || text === "config") return "configure";
  return undefined;
}

function parseRoleSelection(answer: string): RoleName[] | undefined {
  const tokens = answer.split(",").map((token) => token.trim().toLowerCase()).filter((token) => token.length > 0);
  if (tokens.length === 0) return undefined;
  const roles: RoleName[] = [];
  const seen = new Set<string>();
  for (const token of tokens) {
    if (!ROLE_SET.has(token)) return undefined;
    if (!seen.has(token)) {
      seen.add(token);
      roles.push(token as RoleName);
    }
  }
  return roles;
}

function parseIndex(answer: string, max: number): number | undefined {
  const text = answer.trim();
  if (!/^\d+$/.test(text)) return undefined;
  const value = Number.parseInt(text, 10);
  if (!Number.isInteger(value) || value < 0 || value > max) return undefined;
  return value;
}

async function ask<T>(
  input: ModelConfigureInput,
  output: ModelConfigureOutput,
  prompt: string,
  parse: (answer: string) => T | undefined,
): Promise<AskResult<T>> {
  for (let attempt = 0; attempt < MAX_PROMPT_ATTEMPTS; attempt++) {
    const answer = await input(prompt);
    if (answer === "") return { cancelled: true };
    const value = parse(answer);
    if (value !== undefined) return { value };
    output("  Not recognized. Please try again.");
  }
  return { failed: true };
}

/**
 * Present the numbered model choices for one role and apply the user's
 * selection to the pending global roles:
 * - recommended default removes the role's global model and variant fields;
 * - a model choice replaces the model field and replaces or removes the old
 *   global variant according to the user's variant/no-variant choice.
 */
async function configureRole(
  role: RoleName,
  pending: GlobalRoles,
  input: ModelConfigureInput,
  output: ModelConfigureOutput,
  defaults: AriaDefaults,
  resolved: ResolvedAriaConfig,
  models: AvailableModel[],
): Promise<"done" | "cancelled" | "failed"> {
  const recommended = defaults.roles[role];
  const current = resolved.roles[role];
  output("");
  output(`Role ${role} — current: ${routeText(current.model, current.variant)}`);
  output(`  [0] ARIA recommended default (packaged: ${routeText(recommended.model, recommended.variant)})`);
  models.forEach((model, index) => {
    const variantText = model.variants.length > 0 ? ` (variants: ${model.variants.join(", ")})` : "";
    output(`  [${index + 1}] ${model.id}${variantText}`);
  });

  const modelResult = await ask(
    input,
    output,
    `Choose a model for ${role} (0 for recommended default): `,
    (answer) => parseIndex(answer, models.length),
  );
  if ("cancelled" in modelResult) return "cancelled";
  if ("failed" in modelResult) return "failed";

  if (modelResult.value === 0) {
    // Recommended default: remove the role's fields rather than copying them.
    delete pending[role];
    return "done";
  }

  const model = models[modelResult.value - 1];
  if (!model) return "failed";

  if (model.variants.length === 0) {
    const entry: RoleOverride = { ...pending[role], model: model.id };
    delete entry.variant;
    pending[role] = entry;
    return "done";
  }

  output(`Variants for ${model.id}:`);
  output("  [0] No variant");
  model.variants.forEach((variant, index) => output(`  [${index + 1}] ${variant}`));
  const variantResult = await ask(
    input,
    output,
    `Choose a variant for ${model.id} (0 for no variant): `,
    (answer) => parseIndex(answer, model.variants.length),
  );
  if ("cancelled" in variantResult) return "cancelled";
  if ("failed" in variantResult) return "failed";

  const entry: RoleOverride = { ...pending[role], model: model.id };
  if (variantResult.value === 0) {
    delete entry.variant;
  } else {
    const variant = model.variants[variantResult.value - 1];
    if (!variant) return "failed";
    entry.variant = variant;
  }
  pending[role] = entry;
  return "done";
}

/** Atomic write: temp file in the same directory, then rename into place. */
async function writeGlobalConfigAtomic(filePath: string, overrides: { roles: GlobalRoles }): Promise<void> {
  await mkdir(dirname(filePath), { recursive: true });
  const temporaryPath = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporaryPath, `${JSON.stringify(overrides, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
    await rename(temporaryPath, filePath);
  } catch (error) {
    await unlink(temporaryPath).catch(() => undefined);
    throw error;
  }
}

interface FinalizeParameters {
  seeded: GlobalRoles;
  pending: GlobalRoles;
  canonicalPath: string;
  canonicalExisted: boolean;
  legacyExisted: boolean;
  defaults: AriaDefaults;
  masks: RoleMask[];
  noChangeMessage: string;
}

/**
 * Field-precise masking note: only the project-pinned fields are reported as
 * unchangeable, so a model-only or variant-only override never claims the
 * entire resolved route is frozen.
 */
function maskedFieldsNote(masks: RoleMask[]): string {
  if (masks.length === 0) return "";
  const rolesOf = (entries: RoleMask[]): string => entries.map((entry) => entry.role).join(", ");
  const clauses: string[] = [];
  const fullyMasked = masks.filter((mask) => mask.model && mask.variant);
  const modelOnly = masks.filter((mask) => mask.model && !mask.variant);
  const variantOnly = masks.filter((mask) => !mask.model && mask.variant);
  if (fullyMasked.length > 0) {
    clauses.push(
      `overrides ${rolesOf(fullyMasked)}; global configuration cannot change those roles' resolved routes`,
    );
  }
  if (modelOnly.length > 0) {
    clauses.push(
      `pins the model field for ${rolesOf(modelOnly)}; global configuration cannot change those roles' model`,
    );
  }
  if (variantOnly.length > 0) {
    clauses.push(
      `pins the variant field for ${rolesOf(variantOnly)}; global configuration cannot change those roles' variant`,
    );
  }
  return `\nNote: project-local aria.json ${clauses.join("; ")}. Run \`aria routes\` for the authoritative resolved result.`;
}

/**
 * Compare the edited global roles against the seeded ones and write the
 * canonical file only when the result is a real change: skip writes for
 * unchanged results, and skip creating the canonical file for a default-only
 * result when neither canonical nor legacy global config existed.
 */
async function finalizeGlobalConfiguration(params: FinalizeParameters): Promise<ModelConfigurationResult> {
  const finalRoles = cleanGlobalRoles(params.pending);
  const seedRoles = cleanGlobalRoles(params.seeded);
  const changedRoles = changedRolesBetween(seedRoles, finalRoles);

  const maskNote = maskedFieldsNote(params.masks);
  const maskedRoles = params.masks.length > 0 ? params.masks.map((mask) => mask.role) : undefined;

  if (changedRoles.length === 0) {
    return { status: "unchanged", message: `${params.noChangeMessage}${maskNote}`, maskedRoles };
  }

  if (!params.canonicalExisted && !params.legacyExisted && isDefaultOnly(finalRoles, params.defaults)) {
    return {
      status: "unchanged",
      message: `Your selections match the ARIA packaged defaults, so no global configuration file was created.${maskNote}`,
      maskedRoles,
    };
  }

  try {
    parseOverrides({ roles: finalRoles }, params.canonicalPath);
    await writeGlobalConfigAtomic(params.canonicalPath, { roles: finalRoles });
  } catch (error) {
    return {
      status: "failed",
      error: `failed to write ${params.canonicalPath}: ${describeDiscoveryError(error)}`,
      message: "Model configuration could not be written; no changes were persisted.",
    };
  }

  return {
    status: "configured",
    wrotePath: params.canonicalPath,
    changedRoles,
    maskedRoles,
    message: `Wrote global model configuration to ${params.canonicalPath} (changed: ${changedRoles.join(", ")}).${maskNote}`,
  };
}

/**
 * Lightweight interactive model configuration for `aria setup --configure`.
 *
 * Displays the nine configurable roles with their resolved current route and
 * the packaged recommended route, annotating each from discovery as available
 * or unavailable (purely diagnostic — no fallback routing is added). The user
 * may keep ARIA recommended defaults (removing any diverging global
 * overrides), keep current assignments (never writes), or configure specific
 * roles by selecting discovered models and their reported enabled variants.
 *
 * Only the canonical global config `~/.config/opencode/aria.json` is written
 * (atomically); project-local `aria.json` files and untouched global role
 * fields are preserved. When the canonical file is absent, legacy-global
 * choices seed the result only if an explicit edit is made. No file is
 * created for an unchanged or default-only result when none existed.
 */
export async function configureModels(
  worktree: string,
  options: ModelConfigureOptions = {},
): Promise<ModelConfigurationResult> {
  const discovery = options.discovery ?? discoverAvailableModels;
  const input = options.input ?? defaultInput;
  const output = options.output ?? defaultOutput;
  const tty = options.tty ?? (process.stdin.isTTY === true);

  if (!tty) {
    return {
      status: "skipped",
      message: "Interactive model configuration skipped: stdin is not a terminal. Run `aria setup --configure` from a terminal to configure models.",
    };
  }

  let discovered: ModelDiscovery;
  try {
    discovered = await discovery(worktree);
  } catch (error) {
    return {
      status: "failed",
      error: `model discovery failed: ${describeDiscoveryError(error)}`,
      message: "Model discovery failed; configuration was left untouched.",
    };
  }

  const canonicalPath = canonicalGlobalConfigPath();
  const canonicalExisted = existsSync(canonicalPath);
  const legacyExisted = existsSync(resolve(homedir(), ".config", "opencode", "review-driven-code.json"));

  let defaults: AriaDefaults;
  let resolved: ResolvedAriaConfig;
  let seeded: GlobalRoles;
  let projectOverrides: AriaProjectOverrides;
  try {
    defaults = loadDefaultConfig();
    resolved = resolveAriaConfig(worktree);
    projectOverrides = readProjectAriaOverrides(worktree);
    seeded = cleanGlobalRoles(readGlobalAriaOverrides().roles ?? {});
  } catch (error) {
    return {
      status: "failed",
      error: `configuration read failed: ${describeDiscoveryError(error)}`,
      message: "Model configuration could not be read; nothing was written.",
    };
  }

  const pending = cloneGlobalRoles(seeded);
  const hasProjectOverride = (role: RoleName): boolean => {
    const mask = projectMasksFor(projectOverrides, role);
    return mask.model || mask.variant;
  };
  const roleMasks = (roles: RoleName[]): RoleMask[] =>
    roles
      .filter(hasProjectOverride)
      .map((role) => ({ role, ...projectMasksFor(projectOverrides, role) }));

  output(renderRoleSummary(resolved, defaults, discovered.models, projectOverrides));
  output("");
  output("What would you like to do?");
  output("  1) Keep ARIA recommended defaults");
  output("  2) Keep current assignments");
  output("  3) Configure specific roles");

  const topResult = await ask(input, output, "Choice [1-3]: ", parseTopChoice);
  if ("cancelled" in topResult) {
    return { status: "unchanged", message: "Model configuration cancelled; nothing was written." };
  }
  if ("failed" in topResult) {
    return {
      status: "failed",
      error: "repeated invalid input",
      message: "Model configuration aborted after repeated invalid input; nothing was written.",
    };
  }

  if (topResult.value === "current") {
    return { status: "unchanged", message: "Keeping current assignments; existing global overrides are preserved." };
  }

  if (topResult.value === "recommended") {
    for (const role of ROLES) {
      if (roleDivergesFromDefaults(pending[role], defaults.roles[role])) {
        delete pending[role];
      }
    }
    return finalizeGlobalConfiguration({
      seeded,
      pending,
      canonicalPath,
      canonicalExisted,
      legacyExisted,
      defaults,
      masks: roleMasks(ROLES),
      noChangeMessage: "Global assignments already match the ARIA recommended defaults; nothing was written.",
    });
  }

  output("");
  output("Roles available: coder, explorer, visualizer, planner, architect, implementer, reviewer, archivist, writer");
  const rolesResult = await ask(
    input,
    output,
    "Which roles to configure (comma-separated): ",
    parseRoleSelection,
  );
  if ("cancelled" in rolesResult) {
    return { status: "unchanged", message: "Model configuration cancelled; nothing was written." };
  }
  if ("failed" in rolesResult) {
    return {
      status: "failed",
      error: "repeated invalid input",
      message: "Model configuration aborted after repeated invalid input; nothing was written.",
    };
  }

  const editedRoles: RoleName[] = [];
  for (const role of rolesResult.value) {
    const outcome = await configureRole(role, pending, input, output, defaults, resolved, discovered.models);
    if (outcome === "cancelled") {
      return { status: "unchanged", message: "Model configuration cancelled; nothing was written." };
    }
    if (outcome === "failed") {
      return {
        status: "failed",
        error: "repeated invalid input",
        message: `Model configuration for ${role} aborted after repeated invalid input; nothing was written.`,
      };
    }
    editedRoles.push(role);
  }

  return finalizeGlobalConfiguration({
    seeded,
    pending,
    canonicalPath,
    canonicalExisted,
    legacyExisted,
    defaults,
    masks: roleMasks(editedRoles),
    noChangeMessage: "Your selections match the current global assignments; nothing was written.",
  });
}
