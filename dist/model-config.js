import { createOpencodeServer } from "@opencode-ai/sdk/v2";
import { createOpencodeClient } from "@opencode-ai/sdk/v2/client";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, rename, unlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, resolve } from "node:path";
import { createInterface } from "node:readline";
import { loadDefaultConfig } from "./defaults.js";
import { parseOverrides, readGlobalAriaOverrides, readProjectAriaOverrides, resolveAriaConfig } from "./overrides.js";
/**
 * Discovery failed; no configuration has been written or changed.
 */
export class ModelDiscoveryError extends Error {
    constructor(message, options) {
        super(message, options);
        this.name = "ModelDiscoveryError";
    }
}
function describeDiscoveryError(error) {
    if (error instanceof Error && error.message)
        return error.message;
    if (error && typeof error === "object" && typeof error.message === "string") {
        return error.message;
    }
    try {
        return JSON.stringify(error);
    }
    catch {
        return String(error);
    }
}
function ariaModelIdentifier(providerID, reportedID) {
    return reportedID.startsWith(`${providerID}/`) ? reportedID : `${providerID}/${reportedID}`;
}
function ariaModelID(providerID, reportedID) {
    return reportedID.startsWith(`${providerID}/`) ? reportedID.slice(providerID.length + 1) : reportedID;
}
function enabledVariantIds(variants) {
    return variants
        .filter((variant) => variant.disabled !== true && variant.id.trim().length > 0)
        .map((variant) => variant.id);
}
/**
 * Retain only enabled models whose provider is returned as active (not
 * disabled), normalizing each choice to ARIA's providerID/modelID identifier.
 */
export function normalizeAvailableModels(models, providers) {
    const activeProviderIDs = new Set(providers.filter((provider) => provider.disabled !== true).map((provider) => provider.id));
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
export function normalizeAvailableProviders(providers) {
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
export async function discoverAvailableModels(worktree) {
    let server;
    try {
        server = await createOpencodeServer();
    }
    catch (error) {
        throw new ModelDiscoveryError(`OpenCode server failed to start: ${describeDiscoveryError(error)}`, { cause: error });
    }
    try {
        const client = createOpencodeClient({ baseUrl: server.url, directory: worktree });
        const location = { directory: worktree };
        const modelsResult = await client.v2.model.list({ location }).catch((error) => {
            throw new ModelDiscoveryError(`model discovery failed: ${describeDiscoveryError(error)}`, { cause: error });
        });
        if (modelsResult.error) {
            throw new ModelDiscoveryError(`model discovery failed: ${describeDiscoveryError(modelsResult.error)}`, { cause: modelsResult.error });
        }
        const providersResult = await client.v2.provider.list({ location }).catch((error) => {
            throw new ModelDiscoveryError(`provider discovery failed: ${describeDiscoveryError(error)}`, { cause: error });
        });
        if (providersResult.error) {
            throw new ModelDiscoveryError(`provider discovery failed: ${describeDiscoveryError(providersResult.error)}`, { cause: providersResult.error });
        }
        return {
            models: normalizeAvailableModels(modelsResult.data.data, providersResult.data.data),
            providers: normalizeAvailableProviders(providersResult.data.data),
        };
    }
    finally {
        server.close();
    }
}
// The nine configurable roles are fixed; discovery reports which models are
// available, never which roles exist.
const ROLES = [
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
const ROLE_SET = new Set(ROLES);
const MAX_PROMPT_ATTEMPTS = 3;
function canonicalGlobalConfigPath() {
    return resolve(homedir(), ".config", "opencode", "aria.json");
}
function cloneGlobalRoles(roles) {
    const clone = {};
    for (const role of Object.keys(roles)) {
        const entry = roles[role];
        if (entry)
            clone[role] = { ...entry };
    }
    return clone;
}
/** Drop empty role entries and emit remaining roles in canonical order. */
function cleanGlobalRoles(roles) {
    const clean = {};
    for (const role of ROLES) {
        const entry = roles[role];
        if (entry && (entry.model !== undefined || entry.variant !== undefined)) {
            clean[role] = { ...entry };
        }
    }
    return clean;
}
function roleEntryDiffers(a, b) {
    return (a?.model ?? undefined) !== (b?.model ?? undefined)
        || (a?.variant ?? undefined) !== (b?.variant ?? undefined);
}
function changedRolesBetween(seed, final) {
    return ROLES.filter((role) => roleEntryDiffers(seed[role], final[role]));
}
function roleDivergesFromDefaults(entry, defaults) {
    if (!entry)
        return false;
    return (entry.model !== undefined && entry.model !== defaults.model)
        || (entry.variant !== undefined && entry.variant !== defaults.variant);
}
/** True when every remaining override field equals its packaged default. */
function isDefaultOnly(roles, defaults) {
    for (const role of ROLES) {
        const entry = roles[role];
        if (!entry)
            continue;
        const roleDefaults = defaults.roles[role];
        if (roleDivergesFromDefaults(entry, roleDefaults))
            return false;
    }
    return true;
}
function routeText(model, variant) {
    return variant ? `${model} (${variant})` : model;
}
function routeAvailability(modelId, variant, models) {
    const model = models.find((candidate) => candidate.id === modelId);
    if (!model)
        return false;
    return variant === undefined || model.variants.includes(variant);
}
/**
 * Report which project-local override fields pin a role, masking global edits.
 * Presence is authoritative: a project field masks the role even when its
 * value happens to equal the current global value (editing the global would
 * leave the project pinned to the old route).
 */
function projectMasksFor(projectOverrides, role) {
    const entry = projectOverrides.roles?.[role];
    return {
        model: entry?.model !== undefined,
        variant: entry?.variant !== undefined,
    };
}
function renderRoleSummary(resolved, defaults, models, projectOverrides) {
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
function defaultInput(prompt) {
    return new Promise((resolveInput, rejectInput) => {
        const terminal = createInterface({ input: process.stdin, output: process.stdout });
        terminal.question(prompt, (answer) => {
            terminal.close();
            resolveInput(answer.trim());
        });
        terminal.on("error", rejectInput);
    });
}
function defaultOutput(text) {
    process.stdout.write(`${text}\n`);
}
function parseTopChoice(answer) {
    const text = answer.trim().toLowerCase();
    if (text === "1" || text === "defaults" || text === "recommended" || text === "recommended defaults") {
        return "recommended";
    }
    if (text === "2" || text === "current" || text === "current assignments" || text === "keep current") {
        return "current";
    }
    if (text === "3" || text === "configure" || text === "config")
        return "configure";
    return undefined;
}
function parseRoleSelection(answer) {
    const tokens = answer.split(",").map((token) => token.trim().toLowerCase()).filter((token) => token.length > 0);
    if (tokens.length === 0)
        return undefined;
    const roles = [];
    const seen = new Set();
    for (const token of tokens) {
        if (!ROLE_SET.has(token))
            return undefined;
        if (!seen.has(token)) {
            seen.add(token);
            roles.push(token);
        }
    }
    return roles;
}
function parseIndex(answer, max) {
    const text = answer.trim();
    if (!/^\d+$/.test(text))
        return undefined;
    const value = Number.parseInt(text, 10);
    if (!Number.isInteger(value) || value < 0 || value > max)
        return undefined;
    return value;
}
async function ask(input, output, prompt, parse) {
    for (let attempt = 0; attempt < MAX_PROMPT_ATTEMPTS; attempt++) {
        const answer = await input(prompt);
        if (answer === "")
            return { cancelled: true };
        const value = parse(answer);
        if (value !== undefined)
            return { value };
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
async function configureRole(role, pending, input, output, defaults, resolved, models) {
    const recommended = defaults.roles[role];
    const current = resolved.roles[role];
    output("");
    output(`Role ${role} — current: ${routeText(current.model, current.variant)}`);
    output(`  [0] ARIA recommended default (packaged: ${routeText(recommended.model, recommended.variant)})`);
    models.forEach((model, index) => {
        const variantText = model.variants.length > 0 ? ` (variants: ${model.variants.join(", ")})` : "";
        output(`  [${index + 1}] ${model.id}${variantText}`);
    });
    const modelResult = await ask(input, output, `Choose a model for ${role} (0 for recommended default): `, (answer) => parseIndex(answer, models.length));
    if ("cancelled" in modelResult)
        return "cancelled";
    if ("failed" in modelResult)
        return "failed";
    if (modelResult.value === 0) {
        // Recommended default: remove the role's fields rather than copying them.
        delete pending[role];
        return "done";
    }
    const model = models[modelResult.value - 1];
    if (!model)
        return "failed";
    if (model.variants.length === 0) {
        const entry = { ...pending[role], model: model.id };
        delete entry.variant;
        pending[role] = entry;
        return "done";
    }
    output(`Variants for ${model.id}:`);
    output("  [0] No variant");
    model.variants.forEach((variant, index) => output(`  [${index + 1}] ${variant}`));
    const variantResult = await ask(input, output, `Choose a variant for ${model.id} (0 for no variant): `, (answer) => parseIndex(answer, model.variants.length));
    if ("cancelled" in variantResult)
        return "cancelled";
    if ("failed" in variantResult)
        return "failed";
    const entry = { ...pending[role], model: model.id };
    if (variantResult.value === 0) {
        delete entry.variant;
    }
    else {
        const variant = model.variants[variantResult.value - 1];
        if (!variant)
            return "failed";
        entry.variant = variant;
    }
    pending[role] = entry;
    return "done";
}
/** Atomic write: temp file in the same directory, then rename into place. */
async function writeGlobalConfigAtomic(filePath, overrides) {
    await mkdir(dirname(filePath), { recursive: true });
    const temporaryPath = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
    try {
        await writeFile(temporaryPath, `${JSON.stringify(overrides, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
        await rename(temporaryPath, filePath);
    }
    catch (error) {
        await unlink(temporaryPath).catch(() => undefined);
        throw error;
    }
}
/**
 * Field-precise masking note: only the project-pinned fields are reported as
 * unchangeable, so a model-only or variant-only override never claims the
 * entire resolved route is frozen.
 */
function maskedFieldsNote(masks) {
    if (masks.length === 0)
        return "";
    const rolesOf = (entries) => entries.map((entry) => entry.role).join(", ");
    const clauses = [];
    const fullyMasked = masks.filter((mask) => mask.model && mask.variant);
    const modelOnly = masks.filter((mask) => mask.model && !mask.variant);
    const variantOnly = masks.filter((mask) => !mask.model && mask.variant);
    if (fullyMasked.length > 0) {
        clauses.push(`overrides ${rolesOf(fullyMasked)}; global configuration cannot change those roles' resolved routes`);
    }
    if (modelOnly.length > 0) {
        clauses.push(`pins the model field for ${rolesOf(modelOnly)}; global configuration cannot change those roles' model`);
    }
    if (variantOnly.length > 0) {
        clauses.push(`pins the variant field for ${rolesOf(variantOnly)}; global configuration cannot change those roles' variant`);
    }
    return `\nNote: project-local aria.json ${clauses.join("; ")}. Run \`aria routes\` for the authoritative resolved result.`;
}
/**
 * Compare the edited global roles against the seeded ones and write the
 * canonical file only when the result is a real change: skip writes for
 * unchanged results, and skip creating the canonical file for a default-only
 * result when neither canonical nor legacy global config existed.
 */
async function finalizeGlobalConfiguration(params) {
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
    }
    catch (error) {
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
export async function configureModels(worktree, options = {}) {
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
    let discovered;
    try {
        discovered = await discovery(worktree);
    }
    catch (error) {
        return {
            status: "failed",
            error: `model discovery failed: ${describeDiscoveryError(error)}`,
            message: "Model discovery failed; configuration was left untouched.",
        };
    }
    const canonicalPath = canonicalGlobalConfigPath();
    const canonicalExisted = existsSync(canonicalPath);
    const legacyExisted = existsSync(resolve(homedir(), ".config", "opencode", "review-driven-code.json"));
    let defaults;
    let resolved;
    let seeded;
    let projectOverrides;
    try {
        defaults = loadDefaultConfig();
        resolved = resolveAriaConfig(worktree);
        projectOverrides = readProjectAriaOverrides(worktree);
        seeded = cleanGlobalRoles(readGlobalAriaOverrides().roles ?? {});
    }
    catch (error) {
        return {
            status: "failed",
            error: `configuration read failed: ${describeDiscoveryError(error)}`,
            message: "Model configuration could not be read; nothing was written.",
        };
    }
    const pending = cloneGlobalRoles(seeded);
    const hasProjectOverride = (role) => {
        const mask = projectMasksFor(projectOverrides, role);
        return mask.model || mask.variant;
    };
    const roleMasks = (roles) => roles
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
    const rolesResult = await ask(input, output, "Which roles to configure (comma-separated): ", parseRoleSelection);
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
    const editedRoles = [];
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
//# sourceMappingURL=model-config.js.map