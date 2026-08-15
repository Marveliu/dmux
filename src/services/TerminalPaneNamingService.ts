import { createHash } from 'crypto';
import type { DmuxPane } from '../types.js';
import { callInference } from '../utils/aiMerge.js';
import { hasConfiguredInferenceSync } from './InferenceService.js';
import { capturePaneContentAsync } from '../utils/paneCapture.js';
import { getPaneTmuxTitle, sanitizePaneDisplayName } from '../utils/paneTitle.js';
import { LogService } from './LogService.js';
import { TmuxService } from './TmuxService.js';

export const TERMINAL_NAME_CAPTURE_INTERVAL_MS = 10_000;
export const TERMINAL_NAME_SETTLE_MS = 15_000;
export const TERMINAL_RENAME_COOLDOWN_MS = 5 * 60_000;
const TERMINAL_NAME_FAILURE_RETRY_MS = 60_000;
const TERMINAL_NAME_MAX_LENGTH = 48;
const TERMINAL_CAPTURE_LINES = 60;
const TERMINAL_CAPTURE_MAX_CHARS = 6_000;
const TERMINAL_HISTORY_MAX_SNAPSHOTS = 4;
const TERMINAL_HISTORY_MAX_CHARS = 12_000;

interface CaptureState {
  fingerprint: string;
  stableSince: number;
  meaningful: boolean;
  history: string[];
  lastAttemptAt?: number;
}

interface TerminalPaneNamingOptions {
  getPanes: () => DmuxPane[];
  savePanes: (panes: DmuxPane[]) => Promise<void>;
  capturePane?: (paneId: string) => Promise<string>;
  generateName?: (content: string, pane: DmuxPane) => Promise<string | null>;
  canGenerateName?: () => boolean;
  setPaneTitle?: (paneId: string, title: string) => Promise<void>;
  intervalMs?: number;
  settleMs?: number;
  renameCooldownMs?: number;
}

function fingerprintContent(content: string): string {
  return createHash('sha256').update(content).digest('hex').slice(0, 20);
}

export function normalizeTerminalCapture(content: string): string {
  return content
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '')
    .replace(/\r/g, '')
    .split('\n')
    .map((line) => line.replace(/\s+$/g, ''))
    .filter((line, index, lines) => {
      if (line.trim()) return true;
      return index > 0 && index < lines.length - 1;
    })
    .slice(-TERMINAL_CAPTURE_LINES)
    .join('\n')
    .trim()
    .slice(-TERMINAL_CAPTURE_MAX_CHARS);
}

export function hasMeaningfulTerminalWork(content: string): boolean {
  const lines = content
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .filter((line) => !/^(?:[^\s]+@[^\s]+[: ])?[^\n]*[$#>%❯]\s*$/.test(line));

  return lines.length >= 2 && lines.join(' ').length >= 24;
}

export function isHumanNamedTerminalPane(
  pane: Pick<DmuxPane, 'displayName' | 'displayNameSource'>
): boolean {
  return Boolean(
    pane.displayName
    && pane.displayNameSource !== 'auto'
  );
}

export function sanitizeGeneratedTerminalName(value: string): string | null {
  const firstLine = value
    .trim()
    .replace(/^```(?:text)?\s*/i, '')
    .replace(/```$/i, '')
    .split('\n')[0]
    .replace(/^(?:title|name)\s*:\s*/i, '')
    .replace(/^[`"']+|[`"']+$/g, '');
  const sanitized = sanitizePaneDisplayName(firstLine)
    .replace(/[.!:;,-]+$/g, '')
    .trim();

  if (
    !sanitized
    || sanitized.length > TERMINAL_NAME_MAX_LENGTH
    || isLowInformationTerminalName(sanitized)
  ) {
    return null;
  }

  return sanitized;
}

const GENERIC_TERMINAL_TITLE_WORDS = new Set([
  'a', 'active', 'activity', 'an', 'at', 'command', 'dmux', 'empty', 'for',
  'idle', 'in', 'inactive', 'inside', 'on', 'pane', 'project', 'prompt',
  'ready', 'session', 'shell', 'terminal', 'the', 'waiting', 'work', 'working',
]);

/** Reject status-only labels that do not communicate what the pane is for. */
export function isLowInformationTerminalName(value: string): boolean {
  const words = value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  return words.length === 0 || words.every((word) => GENERIC_TERMINAL_TITLE_WORDS.has(word));
}

function appendTerminalHistory(history: string[], content: string, meaningful: boolean): string[] {
  if (!meaningful || history[history.length - 1] === content) return history;
  const next = [...history, content].slice(-TERMINAL_HISTORY_MAX_SNAPSHOTS);
  while (next.length > 1 && next.join('\n').length > TERMINAL_HISTORY_MAX_CHARS) {
    next.shift();
  }
  return next;
}

function formatTerminalHistory(history: string[], currentContent: string): string {
  const snapshots = history.length > 0 ? history : [currentContent];
  return snapshots
    .map((snapshot, index) => `[Activity snapshot ${index + 1} of ${snapshots.length}]\n${snapshot}`)
    .join('\n\n');
}

export async function generateTerminalPaneName(
  content: string,
  pane: DmuxPane
): Promise<string | null> {
  const response = await callInference(
    [
      'Create a concise 2-5 word title for this terminal pane based on its recent work.',
      'Infer the pane’s enduring purpose from the full activity timeline, not merely its latest idle state.',
      'Use plain title case. Describe the task, command, or result—not the shell, pane, project, or status itself.',
      'Never return generic state labels such as Idle, Waiting, Terminal, Shell, or Working in Project.',
      pane.displayName
        ? `Existing automatic title: ${pane.displayName}. Keep it unless the history supports a more specific title.`
        : 'There is no existing automatic title.',
      'Reply with only the title, with no quotes, punctuation, markdown, or explanation.',
      `Working directory: ${pane.shellCwd || pane.projectRoot || 'unknown'}`,
      'Terminal activity timeline (oldest to newest):',
      content,
    ].join('\n\n'),
    24,
    10_000
  );

  return response ? sanitizeGeneratedTerminalName(response) : null;
}

function isEligibleTerminalPane(pane: DmuxPane): boolean {
  return pane.type === 'shell'
    && !pane.browserPath
    && !isHumanNamedTerminalPane(pane);
}

export class TerminalPaneNamingService {
  private readonly getPanes: () => DmuxPane[];
  private readonly savePanes: (panes: DmuxPane[]) => Promise<void>;
  private readonly capturePane: (paneId: string) => Promise<string>;
  private readonly generateName: (content: string, pane: DmuxPane) => Promise<string | null>;
  private readonly canGenerateName: () => boolean;
  private readonly setPaneTitle: (paneId: string, title: string) => Promise<void>;
  private readonly intervalMs: number;
  private readonly settleMs: number;
  private readonly renameCooldownMs: number;
  private readonly captureStates = new Map<string, CaptureState>();
  private readonly inFlight = new Set<string>();
  private timer?: NodeJS.Timeout;
  private checking = false;

  constructor(options: TerminalPaneNamingOptions) {
    this.getPanes = options.getPanes;
    this.savePanes = options.savePanes;
    this.capturePane = options.capturePane
      || ((paneId) => capturePaneContentAsync(paneId, TERMINAL_CAPTURE_LINES));
    this.generateName = options.generateName || generateTerminalPaneName;
    this.canGenerateName = options.canGenerateName
      || (() => hasConfiguredInferenceSync());
    this.setPaneTitle = options.setPaneTitle
      || ((paneId, title) => TmuxService.getInstance().setPaneTitle(paneId, title));
    this.intervalMs = options.intervalMs ?? TERMINAL_NAME_CAPTURE_INTERVAL_MS;
    this.settleMs = options.settleMs ?? TERMINAL_NAME_SETTLE_MS;
    this.renameCooldownMs = options.renameCooldownMs ?? TERMINAL_RENAME_COOLDOWN_MS;
  }

  start(): void {
    if (this.timer) return;
    void this.checkNow();
    this.timer = setInterval(() => void this.checkNow(), this.intervalMs);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    this.captureStates.clear();
  }

  async checkNow(now: number = Date.now()): Promise<void> {
    if (this.checking || !this.canGenerateName()) return;
    this.checking = true;

    try {
      const panes = this.getPanes();
      const eligibleIds = new Set(
        panes.filter(isEligibleTerminalPane).map((pane) => pane.id)
      );
      for (const paneId of this.captureStates.keys()) {
        if (!eligibleIds.has(paneId)) this.captureStates.delete(paneId);
      }

      await Promise.all(
        panes
          .filter(isEligibleTerminalPane)
          .map((pane) => this.inspectPane(pane, now))
      );
    } finally {
      this.checking = false;
    }
  }

  private async inspectPane(pane: DmuxPane, now: number): Promise<void> {
    if (this.inFlight.has(pane.id)) return;

    let content: string;
    try {
      content = normalizeTerminalCapture(await this.capturePane(pane.paneId));
    } catch {
      return;
    }
    if (!content) return;

    const fingerprint = fingerprintContent(content);
    const existingState = this.captureStates.get(pane.id);
    if (!existingState || existingState.fingerprint !== fingerprint) {
      const meaningful = hasMeaningfulTerminalWork(content);
      this.captureStates.set(pane.id, {
        fingerprint,
        stableSince: now,
        meaningful,
        history: appendTerminalHistory(existingState?.history || [], content, meaningful),
      });
      return;
    }

    if (!existingState.meaningful || now - existingState.stableSince < this.settleMs) {
      return;
    }
    if (pane.lastAutoNameFingerprint === fingerprint) return;
    if (
      pane.lastAutoNamedAt
      && now - pane.lastAutoNamedAt < this.renameCooldownMs
    ) {
      return;
    }
    if (
      existingState.lastAttemptAt
      && now - existingState.lastAttemptAt < TERMINAL_NAME_FAILURE_RETRY_MS
    ) {
      return;
    }

    existingState.lastAttemptAt = now;
    this.inFlight.add(pane.id);
    try {
      const generatedName = await this.generateName(
        formatTerminalHistory(existingState.history, content),
        pane
      );
      if (!generatedName || isLowInformationTerminalName(generatedName)) return;

      // Do not apply a name generated from stale output if the user started
      // another command while the model request was in flight.
      const latestContent = normalizeTerminalCapture(await this.capturePane(pane.paneId));
      const latestFingerprint = latestContent
        ? fingerprintContent(latestContent)
        : '';
      if (latestFingerprint !== fingerprint) {
        if (latestFingerprint) {
          this.captureStates.set(pane.id, {
            fingerprint: latestFingerprint,
            stableSince: now,
            meaningful: hasMeaningfulTerminalWork(latestContent),
            history: appendTerminalHistory(
              existingState.history,
              latestContent,
              hasMeaningfulTerminalWork(latestContent)
            ),
          });
        }
        return;
      }

      const latestPanes = this.getPanes();
      const latestPane = latestPanes.find((candidate) => candidate.id === pane.id);
      if (!latestPane || !isEligibleTerminalPane(latestPane)) return;

      let updatedPane: DmuxPane | undefined;
      const updatedPanes = latestPanes.map((candidate) => {
        if (candidate.id !== pane.id) return candidate;
        updatedPane = {
          ...candidate,
          displayName: generatedName,
          displayNameSource: 'auto' as const,
          lastAutoNamedAt: now,
          lastAutoNameFingerprint: fingerprint,
        };
        return updatedPane;
      });
      await this.savePanes(updatedPanes);
      if (updatedPane) {
        try {
          await this.setPaneTitle(updatedPane.paneId, getPaneTmuxTitle(updatedPane));
        } catch {
          // Periodic title enforcement will reconcile transient tmux failures.
        }
      }
      LogService.getInstance().debug(
        `Automatically named terminal ${pane.id} "${generatedName}"`,
        'terminalNaming',
        pane.id
      );
    } catch (error) {
      LogService.getInstance().debug(
        `Terminal auto-naming failed for ${pane.id}: ${error instanceof Error ? error.message : String(error)}`,
        'terminalNaming',
        pane.id
      );
    } finally {
      this.inFlight.delete(pane.id);
    }
  }
}
