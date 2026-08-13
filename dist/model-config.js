import { execFile } from "node:child_process";
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
// `opencode models` prints one usable model identifier per line; `opencode
// models --verbose` follows each identifier with its pretty-printed JSON
// metadata block (indented, so identifier lines start at column 0).
const MODEL_ID_PATTERN = /^[^/\s]+\/[^/\s]+(?:\/[^/\s]+)*$/;
function splitModelIdentifier(id) {
    const separator = id.indexOf("/");
    return { providerID: id.slice(0, separator), modelID: id.slice(separator + 1) };
}
/** Run an `opencode` CLI subcommand in the worktree, capturing stdout. */
function runOpencode(args, worktree) {
    return new Promise((resolveResult, rejectResult) => {
        execFile("opencode", args, { cwd: worktree, timeout: 60_000, maxBuffer: 64 * 1024 * 1024 }, (error, stdout, stderr) => {
            if (error) {
                rejectResult(error);
                return;
            }
            resolveResult({ stdout, stderr });
        });
    });
}
/**
 * Parse `opencode models` output: one usable model identifier per line,
 * without variant metadata.
 */
export function parseModelList(stdout) {
    const models = [];
    for (const rawLine of stdout.split("\n")) {
        const id = rawLine.trim();
        if (id.length === 0 || !MODEL_ID_PATTERN.test(id))
            continue;
        const { providerID, modelID } = splitModelIdentifier(id);
        models.push({ id, providerID, modelID, name: modelID, variants: [] });
    }
    return models;
}
function verboseModelFromBlock(id, jsonText) {
    let info;
    try {
        info = JSON.parse(jsonText);
    }
    catch {
        return undefined;
    }
    const { providerID, modelID } = splitModelIdentifier(id);
    const variants = info.variants && typeof info.variants === "object" && !Array.isArray(info.variants)
        ? Object.keys(info.variants).filter((variant) => variant.trim().length > 0)
        : [];
    return {
        id,
        providerID,
        modelID,
        name: typeof info.name === "string" && info.name.trim().length > 0 ? info.name : modelID,
        variants,
    };
}
/**
 * Parse `opencode models --verbose` output: each model identifier line is
 * followed by its JSON metadata block, whose `variants` object keys are the
 * reported variant IDs.
 */
export function parseModelVerbose(stdout) {
    const lines = stdout.split("\n");
    const models = [];
    let index = 0;
    while (index < lines.length) {
        const rawLine = lines[index];
        index++;
        // JSON content lines are indented; identifier lines start at column 0.
        if (rawLine.length === 0 || rawLine[0] === " " || rawLine[0] === "\t")
            continue;
        const id = rawLine.trim();
        if (!MODEL_ID_PATTERN.test(id))
            continue;
        let jsonText = "";
        let model;
        while (index < lines.length) {
            const candidate = lines[index];
            // The next identifier line starts a new block; stop before consuming it.
            if (jsonText.length > 0
                && candidate.length > 0
                && candidate[0] !== " "
                && candidate[0] !== "\t"
                && MODEL_ID_PATTERN.test(candidate.trim())) {
                break;
            }
            jsonText = jsonText.length === 0 ? candidate : `${jsonText}\n${candidate}`;
            index++;
            model = verboseModelFromBlock(id, jsonText);
            if (model)
                break;
        }
        if (model)
            models.push(model);
    }
    return models;
}
/**
 * Discover the models the installed `opencode` CLI reports as usable for a
 * worktree.
 *
 * `aria setup` is a standalone CLI without a PluginInput client, so this
 * shells out to `opencode models` for the usable identifier list and to
 * `opencode models --verbose` for metadata (names and reported variants),
 * merging the two by identifier.
 *
 * CLI failures (non-zero exit or no output) fail discovery cleanly and leave
 * configuration untouched.
 */
export async function discoverAvailableModels(worktree) {
    const [listResult, verboseResult] = await Promise.all([
        runOpencode(["models"], worktree).catch((error) => {
            throw new ModelDiscoveryError(`opencode models failed: ${describeDiscoveryError(error)}`, { cause: error });
        }),
        runOpencode(["models", "--verbose"], worktree).catch((error) => {
            throw new ModelDiscoveryError(`opencode models --verbose failed: ${describeDiscoveryError(error)}`, { cause: error });
        }),
    ]);
    const models = parseModelList(listResult.stdout);
    if (models.length === 0) {
        throw new ModelDiscoveryError("opencode models returned no usable models");
    }
    if (verboseResult.stdout.trim().length === 0) {
        throw new ModelDiscoveryError("opencode models --verbose returned no output");
    }
    const verboseModels = new Map(parseModelVerbose(verboseResult.stdout).map((model) => [model.id, model]));
    return {
        models: models.map((model) => verboseModels.get(model.id) ?? model),
    };
}
// The ten configurable roles are fixed; discovery reports which models are
// available, never which roles exist.
const ROLES = [
    "coder",
    "explorer",
    "visualizer",
    "planner",
    "architect",
    "implementer",
    "reviewer",
    "researcher",
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
const ABSENT_LAYER = "-";
/** Route text for an override layer; `-` when the layer is absent. */
function layerRouteText(entry) {
    if (!entry || (entry.model === undefined && entry.variant === undefined))
        return ABSENT_LAYER;
    const model = entry.model ?? ABSENT_LAYER;
    return entry.variant !== undefined ? `${model} (${entry.variant})` : model;
}
// ---------------------------------------------------------------------------
// ANSI styling (rendering-only; never written into config or result objects)
// ---------------------------------------------------------------------------
const ANSI_BOLD = "\x1b[1m";
const ANSI_RED = "\x1b[31m";
const ANSI_RESET = "\x1b[0m";
/**
 * ANSI styling applies only when the output is a terminal and NO_COLOR is
 * absent or empty (no-color.org convention).
 */
function ansiEnabled(tty) {
    if (!tty)
        return false;
    const noColor = process.env.NO_COLOR;
    return noColor === undefined;
}
/** Wrap `text` in ANSI bold when styling is enabled, otherwise return it plain. */
function ansiBold(text, tty) {
    return ansiEnabled(tty) ? `${ANSI_BOLD}${text}${ANSI_RESET}` : text;
}
/** Wrap `text` in ANSI red when styling is enabled, otherwise return it plain. */
function ansiRed(text, tty) {
    return ansiEnabled(tty) ? `${ANSI_RED}${text}${ANSI_RESET}` : text;
}
/** Fixed-width rule separating role blocks in the ten-role overview. */
const ROLE_SEPARATOR = `  ${"-".repeat(60)}`;
/** Four-layer precedence display for one role. */
function renderRoleLayers(role, resolved, defaults, models, globalOverrides, projectOverrides, tty) {
    const resolvedRoute = resolved.roles[role];
    const defaultRoute = defaults.roles[role];
    const listed = models.some((model) => model.id === resolvedRoute.model);
    const resolvedNote = listed ? "" : " [not listed by OpenCode]";
    return [
        `  ${role}`,
        `    default:   ${routeText(defaultRoute.model, defaultRoute.variant)}`,
        `    global:    ${layerRouteText(globalOverrides.roles?.[role])}`,
        `    project:   ${layerRouteText(projectOverrides.roles?.[role])}`,
        `    resolved:  ${ansiBold(routeText(resolvedRoute.model, resolvedRoute.variant), tty)}${resolvedNote}`,
    ];
}
/**
 * Ten-role overview: one four-layer block per role, separated by a fixed
 * 60-hyphen rule between blocks (never after the final role).
 */
function renderRoleSummary(resolved, defaults, models, globalOverrides, projectOverrides, tty) {
    const lines = ["ARIA model configuration", ""];
    ROLES.forEach((role, index) => {
        if (index > 0)
            lines.push(ROLE_SEPARATOR);
        lines.push(...renderRoleLayers(role, resolved, defaults, models, globalOverrides, projectOverrides, tty));
    });
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
/** Top-level menu: exit without changes or configure roles. */
function parseTopChoice(answer) {
    const text = answer.trim().toLowerCase();
    if (text === "1" || text === "current")
        return "current";
    if (text === "2" || text === "configure")
        return "configure";
    return undefined;
}
async function askTopChoice(input, output) {
    for (let attempt = 0; attempt < MAX_PROMPT_ATTEMPTS; attempt++) {
        const answer = await input("Choice [1-2]: ");
        if (answer.trim() === "")
            return { value: "current" };
        const value = parseTopChoice(answer);
        if (value !== undefined)
            return { value };
        output("  Not recognized. Please try again.");
    }
    return { failed: true };
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
/** Parse a 1-based selection index in [1, max]. */
function parseListIndex(answer, max) {
    const text = answer.trim();
    if (!/^\d+$/.test(text))
        return undefined;
    const value = Number.parseInt(text, 10);
    if (!Number.isInteger(value) || value < 1 || value > max)
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
 * Compact variant selection after a model is chosen: Enter keeps the model
 * with no variant (clearing any previous one), a number selects a reported
 * variant.
 */
async function chooseVariant(model, role, pending, input, output) {
    if (model.variants.length === 0) {
        const entry = { ...pending[role], model: model.id };
        delete entry.variant;
        pending[role] = entry;
        return "done";
    }
    output("");
    output("Variant:");
    output("  Enter   no variant override");
    model.variants.forEach((variant, index) => output(`  ${index + 1}) ${variant}`));
    for (let attempt = 0; attempt < MAX_PROMPT_ATTEMPTS; attempt++) {
        const answer = await input("> ");
        const text = answer.trim();
        if (text === "") {
            const entry = { ...pending[role], model: model.id };
            delete entry.variant;
            pending[role] = entry;
            return "done";
        }
        const index = parseListIndex(text, model.variants.length);
        if (index === undefined) {
            output("  Not recognized. Please try again.");
            continue;
        }
        const variant = model.variants[index - 1];
        if (!variant)
            return "failed";
        pending[role] = { ...pending[role], model: model.id, variant };
        return "done";
    }
    return "failed";
}
/**
 * Search-driven model selection for one role. Shows the four-layer
 * precedence, then accepts:
 * - Enter: keep the current assignment (no change);
 * - 0: use the ARIA default (remove the role's global override);
 * - an exact discovered model identifier: accept immediately;
 * - other text: case-insensitive substring search over discovered model IDs,
 *   with numbered selection when at most ten models match. A chosen model
 *   replaces the model field and its variant is set through the compact
 *   variant prompt.
 */
async function configureRole(role, pending, input, output, defaults, resolved, models, globalOverrides, projectOverrides, tty) {
    output("");
    output(renderRoleLayers(role, resolved, defaults, models, globalOverrides, projectOverrides, tty).join("\n"));
    output("");
    const mask = projectMasksFor(projectOverrides, role);
    if (mask.model || mask.variant) {
        output(ansiRed(roleMaskWarning(role, mask), tty));
        output("");
    }
    output("Model:");
    output("  Enter      keep current");
    output("  0          use ARIA default");
    output("  <text>     search OpenCode models");
    let listed;
    let unproductiveAttempts = 0;
    for (;;) {
        const answer = await input("> ");
        const text = answer.trim();
        if (text === "")
            return "done"; // keep current: no change
        if (text === "0") {
            // ARIA default: remove the role's global model and variant fields.
            delete pending[role];
            return "done";
        }
        if (listed) {
            const index = parseListIndex(text, listed.length);
            if (index !== undefined) {
                const model = listed[index - 1];
                if (!model)
                    return "failed";
                return chooseVariant(model, role, pending, input, output);
            }
            listed = undefined; // fall through to a fresh search
        }
        const exact = models.find((model) => model.id.toLowerCase() === text.toLowerCase());
        if (exact)
            return chooseVariant(exact, role, pending, input, output);
        const matches = models.filter((model) => model.id.toLowerCase().includes(text.toLowerCase()));
        if (matches.length === 0) {
            output("  No matches. Please try again.");
            unproductiveAttempts++;
            if (unproductiveAttempts >= MAX_PROMPT_ATTEMPTS)
                return "failed";
            continue;
        }
        if (matches.length > 10) {
            output(`  ${matches.length} matches — please refine your search.`);
            unproductiveAttempts++;
            if (unproductiveAttempts >= MAX_PROMPT_ATTEMPTS)
                return "failed";
            continue;
        }
        unproductiveAttempts = 0;
        listed = matches;
        matches.forEach((model, index) => output(`  [${index + 1}] ${model.id}`));
    }
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
 * Pre-prompt warning for one role whose project-local config masks global
 * fields: field-precise, so a model-only or variant-only override never
 * claims the entire resolved route is frozen.
 */
function roleMaskWarning(role, mask) {
    if (mask.model && mask.variant) {
        return `WARNING: Project-local aria.json overrides ${role}, so this global change does not affect its currently resolved route. Run \`aria routes\` for the authoritative result.`;
    }
    if (mask.model) {
        return `WARNING: Project-local aria.json pins the model field for ${role}, so this global change cannot alter its resolved model. Run \`aria routes\` for the authoritative result.`;
    }
    return `WARNING: Project-local aria.json pins the variant field for ${role}, so this global change cannot alter its resolved variant. Run \`aria routes\` for the authoritative result.`;
}
/**
 * Post-write masking warning: only the project-pinned fields are reported as
 * unchangeable, so a model-only or variant-only override never claims the
 * entire resolved route is frozen.
 */
function maskingWarning(masks) {
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
    return `WARNING: Project-local aria.json ${clauses.join("; ")}. Run \`aria routes\` for the authoritative result.`;
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
    const maskedRoles = params.masks.length > 0 ? params.masks.map((mask) => mask.role) : undefined;
    if (changedRoles.length === 0) {
        return { status: "unchanged", message: params.noChangeMessage, maskedRoles };
    }
    if (!params.canonicalExisted && !params.legacyExisted && isDefaultOnly(finalRoles, params.defaults)) {
        return {
            status: "unchanged",
            message: "Your selections match the ARIA packaged defaults, so no global configuration file was created.",
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
        message: `Wrote global model configuration to ${params.canonicalPath} (changed: ${changedRoles.join(", ")}).`,
    };
}
/**
 * Lightweight interactive model configuration for `aria setup --configure`.
 *
 * Discovers the models the installed `opencode` CLI reports once per run and
 * shows the ten configurable roles with their four-layer precedence
 * (packaged default, global override, project override, resolved route),
 * annotating resolved models the CLI did not list (purely diagnostic — no
 * fallback routing is added). The user may keep the current configuration
 * (never writes) or configure specific roles through a search-driven model
 * prompt and compact variant selection.
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
    let globalOverrides;
    let projectOverrides;
    try {
        defaults = loadDefaultConfig();
        resolved = resolveAriaConfig(worktree);
        globalOverrides = readGlobalAriaOverrides();
        projectOverrides = readProjectAriaOverrides(worktree);
        seeded = cleanGlobalRoles(globalOverrides.roles ?? {});
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
    output(renderRoleSummary(resolved, defaults, discovered.models, globalOverrides, projectOverrides, tty));
    output("");
    output("What would you like to do?");
    output("");
    output("  1) Exit without changes");
    output("  2) Configure roles");
    const topResult = await askTopChoice(input, output);
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
        return { status: "unchanged", message: "Keeping current configuration; existing global overrides are preserved." };
    }
    output("");
    output("Roles available: coder, explorer, visualizer, planner, architect, implementer, reviewer, researcher, archivist, writer");
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
        const outcome = await configureRole(role, pending, input, output, defaults, resolved, discovered.models, globalOverrides, projectOverrides, tty);
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
    const masks = roleMasks(editedRoles);
    const result = await finalizeGlobalConfiguration({
        seeded,
        pending,
        canonicalPath,
        canonicalExisted,
        legacyExisted,
        defaults,
        masks,
        noChangeMessage: "Your selections match the current global assignments; nothing was written.",
    });
    // Post-write masking warning rendered through the terminal seam (red when
    // ANSI styling is enabled); the result object itself stays unstyled.
    if (result.maskedRoles && result.maskedRoles.length > 0) {
        output(ansiRed(maskingWarning(masks), tty));
    }
    return result;
}
//# sourceMappingURL=model-config.js.map