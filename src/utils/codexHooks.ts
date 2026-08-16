import * as fs from 'fs';
import path from 'path';
import { atomicWriteFileSync, atomicWriteJsonSync } from './atomicWrite.js';
import { shellQuote } from './promptStore.js';

export interface CodexHookInstallResult {
  eventFile: string;
}

type ShellAssignment = [key: string, value: string];

function mergeDmuxStopHook(hooksPath: string, hookCommand: string): void {
  let hooksConfig: any = {};
  if (fs.existsSync(hooksPath)) {
    try {
      hooksConfig = JSON.parse(fs.readFileSync(hooksPath, 'utf-8'));
    } catch {
      hooksConfig = {};
    }
  }

  if (!hooksConfig || typeof hooksConfig !== 'object' || Array.isArray(hooksConfig)) {
    hooksConfig = {};
  }

  if (!hooksConfig.hooks || typeof hooksConfig.hooks !== 'object' || Array.isArray(hooksConfig.hooks)) {
    hooksConfig.hooks = {};
  }

  const stopHooks = Array.isArray(hooksConfig.hooks.Stop) ? hooksConfig.hooks.Stop : [];
  const nextStopHooks = stopHooks.filter((group: any) => {
    const handlers = Array.isArray(group?.hooks) ? group.hooks : [];
    return !handlers.some((handler: any) => (
      typeof handler?.command === 'string'
      && handler.command.includes('dmux-stop-hook.cjs')
    ));
  });
  nextStopHooks.push({
    hooks: [
      {
        type: 'command',
        command: hookCommand,
        timeout: 5,
        statusMessage: 'Notifying dmux',
      },
    ],
  });

  hooksConfig.hooks.Stop = nextStopHooks;
  atomicWriteJsonSync(hooksPath, hooksConfig);
}

export function installCodexPaneHooks(opts: {
  worktreePath: string;
  dmuxPaneId: string;
  tmuxPaneId: string;
}): CodexHookInstallResult {
  const codexDir = path.join(opts.worktreePath, '.codex');
  const hookDir = path.join(codexDir, 'hooks');
  const stateDir = path.join(codexDir, 'dmux');
  fs.mkdirSync(hookDir, { recursive: true });
  fs.mkdirSync(stateDir, { recursive: true });

  const eventFile = path.join(stateDir, `${opts.dmuxPaneId}.json`);
  const hookScriptPath = path.join(hookDir, 'dmux-stop-hook.cjs');
  const hookCommandPath = path.join('.codex', 'hooks', 'dmux-stop-hook.cjs');
  const hookScript = `#!/usr/bin/env node
const fs = require('fs');

function finish(payload = {}) {
  process.stdout.write(JSON.stringify(payload));
}

let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  input += chunk;
});
process.stdin.on('end', () => {
  let payload = {};
  try {
    payload = input.trim() ? JSON.parse(input) : {};
  } catch (error) {
    payload = { parse_error: String(error), raw: input };
  }

  const event = {
    source: 'codex-stop-hook',
    dmuxPaneId: process.env.DMUX_PANE_ID || '',
    tmuxPaneId: process.env.DMUX_TMUX_PANE_ID || '',
    hookEventName: payload.hook_event_name || payload.hookEventName || '',
    turnId: payload.turn_id || payload.turnId || '',
    stopHookActive: payload.stop_hook_active === true || payload.stopHookActive === true,
    lastAssistantMessage: payload.last_assistant_message || null,
    transcriptPath: payload.transcript_path || null,
    cwd: payload.cwd || process.cwd(),
    timestamp: Date.now()
  };

  if (event.hookEventName && event.hookEventName !== 'Stop') {
    finish();
    return;
  }

  const eventFile = process.env.DMUX_CODEX_HOOK_EVENT_FILE || '';
  if (!event.dmuxPaneId || !eventFile) {
    finish();
    return;
  }

  try {
    fs.writeFileSync(eventFile, JSON.stringify(event, null, 2));
  } catch (error) {
    finish();
    return;
  }

  finish();
});
`;
  atomicWriteFileSync(hookScriptPath, hookScript);
  fs.chmodSync(hookScriptPath, 0o755);

  const hooksPath = path.join(codexDir, 'hooks.json');
  mergeDmuxStopHook(hooksPath, `node ${shellQuote(hookCommandPath)}`);

  return { eventFile };
}

function buildCodexPaneAssignments(opts: {
  dmuxPaneId: string;
  tmuxPaneId: string;
  eventFile?: string;
}): ShellAssignment[] {
  const assignments: ShellAssignment[] = [
    ['DMUX_PANE_ID', opts.dmuxPaneId],
    ['DMUX_TMUX_PANE_ID', opts.tmuxPaneId],
  ];

  if (opts.eventFile) {
    assignments.push(['DMUX_CODEX_HOOK_EVENT_FILE', opts.eventFile]);
  }

  return assignments;
}

export function buildCodexPaneEnvironmentPrefix(opts: {
  dmuxPaneId: string;
  tmuxPaneId: string;
  eventFile?: string;
}): string {
  return buildCodexPaneAssignments(opts)
    .map(([key, value]) => `${key}=${shellQuote(value)}`)
    .join(' ');
}

export function buildCodexPaneExportSnippet(opts: {
  dmuxPaneId: string;
  tmuxPaneId: string;
  eventFile?: string;
}): string {
  return buildCodexPaneAssignments(opts)
    .map(([key, value]) => `${key}=${shellQuote(value)}`)
    .map((assignment) => `export ${assignment}`)
    .join('; ');
}

export const CODEX_ENABLE_HOOKS_FLAG = '--enable hooks';
export const CODEX_ENABLE_GOALS_FLAG = '--enable goals';

export function enableCodexHooksFlag(command: string): string {
  return enableCodexFeatureFlags(command, [CODEX_ENABLE_HOOKS_FLAG]);
}

export function enableCodexFeatureFlags(command: string, flags: string[]): string {
  const flagsToAdd = flags.filter((flag) => !command.includes(flag));
  if (flagsToAdd.length === 0) {
    return command;
  }

  return command.replace(/(^|;\s*)codex(?=\s|$)/, `$1codex ${flagsToAdd.join(' ')}`);
}

export function buildCodexHookedCommand(
  command: string,
  opts: {
    dmuxPaneId: string;
    tmuxPaneId: string;
    eventFile?: string;
  },
  featureOptions: {
    enableGoals?: boolean;
  } = {}
): string {
  const flags = [
    CODEX_ENABLE_HOOKS_FLAG,
    ...(featureOptions.enableGoals ? [CODEX_ENABLE_GOALS_FLAG] : []),
  ];
  return `${buildCodexPaneExportSnippet(opts)}; ${enableCodexFeatureFlags(command, flags)}`;
}
