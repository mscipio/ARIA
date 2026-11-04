import { createElement as h, useEffect, useRef, useState, type ReactElement } from "react";
import { useInput, useStdout } from "ink";

import { fit, ModelManagerApp, renderLines, type Line } from "./model-manager-tui.js";
import {
  MENU_ITEMS,
  consoleOwnsKeys,
  initialConsoleState,
  reduceConsole,
  screenTitle,
  summarizeFindings,
  type ConsoleEffect,
  type ConsoleEvent,
  type ConsoleServices,
  type ConsoleState,
  type MenuStatus,
  type ToolScreen,
} from "./management-console-state.js";
import type { ModelManagerSnapshot, PersistOutcome } from "./model-manager-store.js";
import type { DoctorFinding } from "./doctor.js";
import { ownershipLabel, type IntegrationEntry } from "./integrations.js";

/**
 * Ink view for the ARIA Management Console. Every decision is made by
 * `reduceConsole`; this module maps keys to events, performs the effects the
 * reducer requests through the injected services, and renders the state with
 * the same line vocabulary as the Model Manager.
 */

export interface ManagementConsoleAppProps {
  services: ConsoleServices;
  initialStatus: MenuStatus;
  /** Closes the console. Never abandons a configuration change (see Ctrl+C handling). */
  onExit: () => void;
}

const SPINNER = ["|", "/", "-", "\\"];

function pad(text: string, width: number): string {
  return text.length >= width ? text.slice(0, width) : `${text}${" ".repeat(width - text.length)}`;
}

function windowStart(cursor: number, length: number, size: number): number {
  return Math.min(Math.max(0, cursor - Math.floor(size / 2)), Math.max(0, length - size));
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function modelsNotice(outcome: PersistOutcome | undefined): { tone: "info" | "ok" | "error"; text: string } {
  if (outcome === undefined) return { tone: "info", text: "Models & Agents closed. No changes were written." };
  if (outcome.status === "saved") return { tone: "ok", text: `Models & Agents: ${outcome.message}` };
  if (outcome.status === "unchanged") return { tone: "info", text: `Models & Agents: ${outcome.message}` };
  return { tone: "error", text: `Models & Agents: ${outcome.error}` };
}

function menuLines(state: ConsoleState, width: number): Line[] {
  const status = state.status;
  const version = status.version ? `   v${status.version}` : "";
  const lines: Line[] = [
    { text: `ARIA Management Console${version}`, bold: true },
    {
      text: fit(
        `global config: ${status.globalConfig ? "present" : "none"}   project config: ${status.projectConfig ? "present" : "none"}   managed agents: ${status.managedAgents}/${status.totalAgents}`,
        width,
      ),
      dim: true,
    },
    { text: "" },
  ];
  MENU_ITEMS.forEach((item, index) => {
    const selected = index === state.menuCursor;
    lines.push({
      text: fit(`${selected ? ">" : " "} ${pad(item.label, 18)} ${item.hint}`, width),
      color: selected ? "cyan" : undefined,
      bold: selected,
    });
  });
  lines.push({ text: "" });
  if (state.notice) lines.push({ text: fit(state.notice.text, width), color: noticeColor(state.notice.tone) });
  lines.push({ text: "↑/↓ select   Enter open   Q quit   Ctrl+C exit", dim: true });
  return lines;
}

function noticeColor(tone: "info" | "ok" | "error"): string | undefined {
  if (tone === "ok") return "green";
  if (tone === "error") return "red";
  return "yellow";
}

function listRows(state: ConsoleState, screen: ToolScreen, width: number, height: number): { rows: Line[]; footer: string } {
  const cursor = state.cursor[screen];
  const size = Math.max(4, height - 16);
  const rowsFor = (items: Array<{ text: string }>): Line[] => {
    const start = windowStart(cursor, items.length, size);
    return items.slice(start, start + size).map((item, offset) => {
      const selected = start + offset === cursor;
      return {
        text: fit(`${selected ? ">" : " "} ${item.text}`, width),
        color: selected ? "cyan" : undefined,
        bold: selected,
      };
    });
  };

  if (screen === "setup") {
    return {
      rows: rowsFor([
        { text: "Inspect installation status   (read-only)" },
        { text: "Run setup / reconciliation     (asks for confirmation first)" },
        { text: "Install optional dependencies  (opt-in: checked, then confirmed)" },
        { text: `View last operation result     ${state.lastResult ? state.lastResult.title : "none yet"}` },
      ]),
      footer: "↑/↓ select   Enter run   Esc menu",
    };
  }
  if (screen === "updates") {
    return {
      rows: rowsFor([
        { text: "Update ARIA                    check, preview, then apply on confirmation" },
        { text: "Update managed dependencies    check, preview, then apply on confirmation" },
      ]),
      footer: "↑/↓ select   Enter check   Esc menu",
    };
  }
  if (screen === "doctor") {
    if (!state.findings) {
      return {
        rows: rowsFor([{ text: "Run diagnostics   (read-only; takes a few seconds)" }]),
        footer: "Enter run   Esc menu",
      };
    }
    const counts = summarizeFindings(state.findings);
    const header: Line = {
      text: fit(`PASS ${counts.PASS}   WARN ${counts.WARN}   FAIL ${counts.FAIL}   SKIP ${counts.SKIP}`, width),
      bold: true,
    };
    const items = state.findings.map((finding: DoctorFinding) => ({
      text: `[${finding.severity}] ${finding.area}: ${finding.title}`,
    }));
    return { rows: [header, ...rowsFor(items)], footer: "↑/↓ select   Enter detail   R rerun   Esc menu" };
  }
  // plugins
  if (!state.entries) {
    return {
      rows: rowsFor([{ text: "Load integrations   (local probes only; no network)" }]),
      footer: "Enter load   Esc menu",
    };
  }
  const items = state.entries.map((entry: IntegrationEntry) => ({
    text: `${pad(entry.kind, 6)} ${pad(entry.name, 30)} ${pad(entry.version ?? "-", 10)} ${pad(entry.runtime, 12)} ${ownershipLabel(entry.ownership)}`,
  }));
  return { rows: rowsFor(items), footer: "↑/↓ select   Enter detail   R reload   Esc menu" };
}

/** Pure line builder for one console state (exported for tests). */
export function consoleLines(state: ConsoleState, width: number, height: number): Line[] {
  if (state.screen === "menu") return menuLines(state, width);

  const screen = state.screen as ToolScreen;
  const lines: Line[] = [{ text: screenTitle(screen), bold: true }, { text: "" }];
  const running = state.running && state.running.screen === screen ? state.running : undefined;
  if (running) {
    const elapsed = Math.max(0, Math.floor((Date.now() - running.startedAt) / 1000));
    const spinner = SPINNER[elapsed % SPINNER.length] ?? "|";
    const note = running.mutating ? "   configuration change in progress" : "";
    lines.push({ text: fit(`${spinner} working… ${elapsed}s${note}`, width), color: "yellow" });
    lines.push({ text: "" });
  }

  let footer: string;
  if (state.confirm && state.confirm.screen === screen) {
    lines.push({ text: "Confirmation required", bold: true, color: "yellow" });
    for (const line of state.confirm.lines) lines.push({ text: fit(line, width) });
    lines.push({ text: "" });
    lines.push({ text: "Press Y to proceed, N or Esc to cancel. Nothing changes until you press Y.", color: "yellow" });
    footer = "Y confirm   N / Esc cancel";
  } else if (state.panel && state.panel.screen === screen) {
    const panel = state.panel;
    lines.push({ text: fit(panel.title, width), bold: true });
    const size = Math.max(4, height - 14);
    const start = Math.min(panel.scroll, Math.max(0, panel.lines.length - size));
    for (const line of panel.lines.slice(start, start + size)) {
      lines.push({ text: fit(line, width) });
    }
    if (panel.lines.length > size) {
      lines.push({ text: `lines ${start + 1}-${Math.min(panel.lines.length, start + size)} of ${panel.lines.length}`, dim: true });
    }
    footer = panel.offer
      ? "↑/↓ PgUp/PgDn scroll   A apply (asks for confirmation)   Esc close"
      : "↑/↓ PgUp/PgDn scroll   Esc close";
  } else {
    const list = listRows(state, screen, width, height);
    lines.push(...list.rows);
    footer = list.footer;
  }

  lines.push({ text: "" });
  if (state.notice) lines.push({ text: fit(state.notice.text, width), color: noticeColor(state.notice.tone) });
  lines.push({ text: footer, dim: true });
  return lines;
}

export function ManagementConsoleApp(props: ManagementConsoleAppProps): ReactElement {
  const { stdout } = useStdout();
  const [state, setState] = useState<ConsoleState>(() => initialConsoleState(props.initialStatus));
  const [modelSnapshot, setModelSnapshot] = useState<ModelManagerSnapshot | undefined>(undefined);
  const [, setTick] = useState(0);
  const stateRef = useRef(state);
  // A model save runs inside the embedded Model Manager, outside the console's
  // `running` state, so it is tracked separately for the Ctrl+C guard.
  const saveActiveRef = useRef(false);
  const busy = state.running !== undefined;

  const commit = (next: ConsoleState): void => {
    stateRef.current = next;
    setState(next);
  };

  const configurationChangeActive = (): boolean =>
    stateRef.current.running?.mutating === true || saveActiveRef.current;

  const dispatch = (event: ConsoleEvent): void => {
    const result = reduceConsole(stateRef.current, event);
    commit(result.state);
    if (result.effect) perform(result.effect);
  };

  const perform = (effect: ConsoleEffect): void => {
    if (effect.kind === "exit") {
      props.onExit();
      return;
    }
    if (effect.kind === "open-models") {
      try {
        setModelSnapshot(props.services.loadModelSnapshot());
        dispatch({ type: "models-open" });
      } catch (error) {
        commit({ ...stateRef.current, notice: { tone: "error", text: `Models & Agents unavailable: ${describe(error)}` } });
      }
      return;
    }
    props.services.run(effect.action).then(
      (outcome) => dispatch({ type: "result", outcome }),
      (error: unknown) => dispatch({ type: "result", outcome: { action: effect.action, ok: false, lines: [describe(error)] } }),
    );
  };

  // Ctrl+C is always live, including inside the embedded Model Manager. It
  // never interrupts a configuration change: setup, upgrades, and model saves
  // have no safe cancellation point, so the console refuses to close until they
  // finish. Read-only checks hold no configuration and may be abandoned.
  useInput((input, key) => {
    if (!(key.ctrl && input === "c")) return;
    if (configurationChangeActive()) {
      commit({
        ...stateRef.current,
        notice: {
          tone: "error",
          text: "A configuration change is in progress and cannot be interrupted safely. Ctrl+C is ignored until it finishes.",
        },
      });
      return;
    }
    props.onExit();
  });

  useInput((input, key) => {
    if (key.ctrl) return;
    dispatch({
      type: "key",
      key: {
        input,
        upArrow: key.upArrow,
        downArrow: key.downArrow,
        pageUp: key.pageUp,
        pageDown: key.pageDown,
        returnKey: key.return,
        escape: key.escape,
      },
    });
  }, { isActive: consoleOwnsKeys(state) });

  useEffect(() => {
    if (!busy) return;
    const timer = setInterval(() => setTick((value) => value + 1), 1000);
    return () => clearInterval(timer);
  }, [busy]);

  if (state.screen === "models" && modelSnapshot) {
    return h(ModelManagerApp, {
      snapshot: modelSnapshot,
      discover: () => props.services.discoverModels(),
      save: (pending) => {
        saveActiveRef.current = true;
        return props.services.saveModels(pending).finally(() => {
          saveActiveRef.current = false;
        });
      },
      onFinish: (outcome: PersistOutcome | undefined) => {
        setModelSnapshot(undefined);
        dispatch({ type: "models-closed", notice: modelsNotice(outcome), status: props.services.menuStatus() });
      },
      initialScope: "global",
      embedded: true,
    });
  }

  const width = Math.max(60, stdout.columns ?? 100);
  const height = stdout.rows ?? 24;
  return renderLines(consoleLines(state, width, height));
}
