import { createHash } from 'crypto';
import type { DmuxPane } from '../types.js';
import { callInference } from '../utils/aiMerge.js';
import { hasConfiguredInferenceSync } from './InferenceService.js';
import { capturePaneContentAsync } from '../utils/paneCapture.js';
import { execAsync } from '../utils/execAsync.js';
import { getPaneTmuxTitle, sanitizePaneDisplayName } from '../utils/paneTitle.js';
import { LogService } from './LogService.js';
import { TmuxService } from './TmuxService.js';

export const TERMINAL_NAME_CAPTURE_INTERVAL_MS = 2_500;
export const TERMINAL_NAME_NAMED_CHECK_INTERVAL_MS = 10_000;
export const TERMINAL_NAME_SETTLE_MS = 15_000;
export const TERMINAL_NAME_FAST_SETTLE_MS = 5_000;
export const TERMINAL_RENAME_COOLDOWN_MS = 5 * 60_000;
const TERMINAL_NAME_FAILURE_RETRY_MS = 60_000;
const TERMINAL_NAME_FAST_FAILURE_RETRY_MS = 10_000;
const TERMINAL_NAME_MAX_LENGTH = 48;
const TERMINAL_CAPTURE_LINES = 60;
const TERMINAL_CAPTURE_MAX_CHARS = 6_000;
const TERMINAL_HISTORY_MAX_SNAPSHOTS = 4;
const TERMINAL_HISTORY_MAX_CHARS = 12_000;

interface CaptureState {
  fingerprint: string;
  stableSince: number;
  lastCapturedAt: number;
  meaningful: boolean;
  meaningfulSince?: number;
  lastContent: string;
  activitySignature?: string;
  lastRejectedFingerprint?: string;
  history: string[];
  lastAttemptAt?: number;
}

export interface PaneActivity {
  signature: string;
  alternateScreen: boolean;
}

/**
 * One batched tmux call covering every pane on the server. Output only
 * reaches a pane's scrollback or moves its cursor when something actually
 * ran, so comparing these counters between ticks detects change without
 * capturing any content.
 */
async function probeTmuxPaneActivity(): Promise<Map<string, PaneActivity> | null> {
  const output = await execAsync(
    `tmux list-panes -a -F '#{pane_id}|#{alternate_on}|#{history_bytes},#{cursor_x},#{cursor_y},#{pane_width},#{pane_height},#{pane_current_command}'`,
    { silent: true, timeout: 5000 }
  );
  if (!output) return null;

  const activity = new Map<string, PaneActivity>();
  for (const line of output.split('\n')) {
    const first = line.indexOf('|');
    const second = line.indexOf('|', first + 1);
    if (first <= 0 || second < 0) continue;
    activity.set(line.slice(0, first), {
      alternateScreen: line.slice(first + 1, second) === '1',
      signature: line.slice(second + 1),
    });
  }
  return activity.size > 0 ? activity : null;
}

interface TerminalPaneNamingOptions {
  getPanes: () => DmuxPane[];
  savePanes: (panes: DmuxPane[]) => Promise<void>;
  capturePane?: (paneId: string) => Promise<string>;
  probePaneActivity?: () => Promise<Map<string, PaneActivity> | null>;
  generateName?: (content: string, pane: DmuxPane) => Promise<string | null>;
  canGenerateName?: () => boolean;
  setPaneTitle?: (paneId: string, title: string) => Promise<void>;
  intervalMs?: number;
  namedCheckIntervalMs?: number;
  settleMs?: number;
  fastSettleMs?: number;
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
  private readonly probePaneActivity: () => Promise<Map<string, PaneActivity> | null>;
  private readonly generateName: (content: string, pane: DmuxPane) => Promise<string | null>;
  private readonly canGenerateName: () => boolean;
  private readonly setPaneTitle: (paneId: string, title: string) => Promise<void>;
  private readonly intervalMs: number;
  private readonly namedCheckIntervalMs: number;
  private readonly settleMs: number;
  private readonly fastSettleMs: number;
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
    this.probePaneActivity = options.probePaneActivity || probeTmuxPaneActivity;
    this.generateName = options.generateName || generateTerminalPaneName;
    this.canGenerateName = options.canGenerateName
      || (() => hasConfiguredInferenceSync());
    this.setPaneTitle = options.setPaneTitle
      || ((paneId, title) => TmuxService.getInstance().setPaneTitle(paneId, title));
    this.intervalMs = options.intervalMs ?? TERMINAL_NAME_CAPTURE_INTERVAL_MS;
    this.namedCheckIntervalMs = options.namedCheckIntervalMs ?? TERMINAL_NAME_NAMED_CHECK_INTERVAL_MS;
    this.settleMs = options.settleMs ?? TERMINAL_NAME_SETTLE_MS;
    this.fastSettleMs = options.fastSettleMs ?? TERMINAL_NAME_FAST_SETTLE_MS;
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
      const eligible = panes.filter(isEligibleTerminalPane);
      const eligibleIds = new Set(eligible.map((pane) => pane.id));
      for (const paneId of this.captureStates.keys()) {
        if (!eligibleIds.has(paneId)) this.captureStates.delete(paneId);
      }

      // A tick where every pane is throttled or busy costs no tmux calls at
      // all; otherwise one batched probe decides which panes need capturing.
      const due = eligible.filter((pane) => this.isDueForInspection(pane, now));
      if (due.length === 0) return;
      const activity = await this.probePaneActivity();

      await Promise.all(
        due.map((pane) => this.inspectPane(
          pane,
          now,
          activity?.get(pane.paneId) ?? null,
          activity !== null
        ))
      );
    } finally {
      this.checking = false;
    }
  }

  // Once a pane has earned a title, watching it closely buys nothing: fall
  // back to a relaxed cadence. Untitled panes are looked at on every tick so
  // a fresh terminal gets its first title quickly.
  private isDueForInspection(pane: DmuxPane, now: number): boolean {
    if (this.inFlight.has(pane.id)) return false;
    const state = this.captureStates.get(pane.id);
    return !(
      Boolean(pane.displayName)
      && state
      && now - state.lastCapturedAt < this.namedCheckIntervalMs
    );
  }

  private async inspectPane(
    pane: DmuxPane,
    now: number,
    activity: PaneActivity | null,
    probed: boolean
  ): Promise<void> {
    if (!this.isDueForInspection(pane, now)) return;
    // A pane absent from a successful probe no longer exists in tmux.
    if (probed && !activity) return;

    const hasAutoName = Boolean(pane.displayName);
    const previousState = this.captureStates.get(pane.id);

    // When the probe shows no counter movement since the last look, the pane
    // produced no new output: reuse the previous capture instead of spawning
    // another capture-pane process. Full-screen apps (alternate_on) can
    // repaint without moving any counter, so they are always recaptured.
    const unchanged = Boolean(
      activity
      && !activity.alternateScreen
      && previousState?.activitySignature
      && previousState.activitySignature === activity.signature
    );

    let content: string;
    if (unchanged) {
      content = previousState!.lastContent;
    } else {
      try {
        content = normalizeTerminalCapture(await this.capturePane(pane.paneId));
      } catch {
        return;
      }
    }
    if (!content) {
      // Keep an existing state through a cleared or transiently empty screen
      // so an empty pane is not recaptured every tick.
      if (previousState) {
        previousState.lastCapturedAt = now;
        previousState.activitySignature = activity?.signature;
      } else {
        this.captureStates.set(pane.id, {
          fingerprint: fingerprintContent(''),
          stableSince: now,
          lastCapturedAt: now,
          meaningful: false,
          lastContent: '',
          activitySignature: activity?.signature,
          history: [],
        });
      }
      return;
    }

    const fingerprint = fingerprintContent(content);
    let state = this.captureStates.get(pane.id);
    if (!state || state.fingerprint !== fingerprint) {
      const meaningful = hasMeaningfulTerminalWork(content);
      state = {
        fingerprint,
        stableSince: now,
        lastCapturedAt: now,
        meaningful,
        meaningfulSince: meaningful ? state?.meaningfulSince ?? now : undefined,
        lastContent: content,
        activitySignature: activity?.signature,
        lastAttemptAt: state?.lastAttemptAt,
        history: appendTerminalHistory(state?.history || [], content, meaningful),
      };
      this.captureStates.set(pane.id, state);
      // A titled pane only renames from settled output; an untitled one keeps
      // going, since a streaming agent may never hold a stable screen.
      if (hasAutoName) return;
    } else {
      state.lastCapturedAt = now;
      state.activitySignature = activity?.signature;
    }

    if (!state.meaningful) return;

    const readyAt = hasAutoName
      ? state.stableSince + this.settleMs
      : (state.meaningfulSince ?? now) + this.fastSettleMs;
    if (now < readyAt) return;

    if (pane.lastAutoNameFingerprint === fingerprint) return;
    // Content that already produced an unusable name will produce one again;
    // wait for the pane to show something new before asking the model again.
    if (state.lastRejectedFingerprint === fingerprint) return;
    if (
      pane.lastAutoNamedAt
      && now - pane.lastAutoNamedAt < this.renameCooldownMs
    ) {
      return;
    }
    const failureRetryMs = hasAutoName
      ? TERMINAL_NAME_FAILURE_RETRY_MS
      : TERMINAL_NAME_FAST_FAILURE_RETRY_MS;
    if (
      state.lastAttemptAt
      && now - state.lastAttemptAt < failureRetryMs
    ) {
      return;
    }

    state.lastAttemptAt = now;
    this.inFlight.add(pane.id);
    try {
      const generatedName = await this.generateName(
        formatTerminalHistory(state.history, content),
        pane
      );
      if (!generatedName || isLowInformationTerminalName(generatedName)) {
        state.lastRejectedFingerprint = fingerprint;
        return;
      }

      // Do not replace a title using stale output if the user started another
      // command while the model request was in flight. An untitled pane keeps
      // the name anyway: its screen churns constantly while an agent streams,
      // and an early title about the pane's purpose beats having none.
      const latestContent = normalizeTerminalCapture(await this.capturePane(pane.paneId));
      const latestFingerprint = latestContent
        ? fingerprintContent(latestContent)
        : '';
      if (latestFingerprint !== fingerprint) {
        if (latestFingerprint) {
          const latestMeaningful = hasMeaningfulTerminalWork(latestContent);
          this.captureStates.set(pane.id, {
            fingerprint: latestFingerprint,
            stableSince: now,
            lastCapturedAt: now,
            meaningful: latestMeaningful,
            meaningfulSince: latestMeaningful ? state.meaningfulSince ?? now : undefined,
            lastContent: latestContent,
            lastAttemptAt: state.lastAttemptAt,
            history: appendTerminalHistory(
              state.history,
              latestContent,
              latestMeaningful
            ),
          });
        }
        if (hasAutoName) return;
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
