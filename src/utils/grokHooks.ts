import * as fs from 'fs';
import path from 'path';
import { atomicWriteFileSync, atomicWriteJsonSync } from './atomicWrite.js';
import { shellQuote } from './promptStore.js';

export interface GrokHookInstallResult {
  eventFile: string;
}

function escapeForSingleQuotedJs(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
}

export function installGrokPaneHooks(opts: {
  worktreePath: string;
  dmuxPaneId: string;
  tmuxPaneId: string;
}): GrokHookInstallResult {
  const grokDir = path.join(opts.worktreePath, '.grok');
  const hookDir = path.join(grokDir, 'hooks');
  const stateDir = path.join(grokDir, 'dmux');
  fs.mkdirSync(hookDir, { recursive: true });
  fs.mkdirSync(stateDir, { recursive: true });

  const eventFile = path.join(stateDir, `${opts.dmuxPaneId}.json`);
  const hookScriptPath = path.join(hookDir, 'dmux-status-hook.cjs');
  const hookScript = `#!/usr/bin/env node
const fs = require('fs');

function normalizeHookEventName(value) {
  const raw = String(value || '');
  const normalized = raw.trim().toLowerCase().replace(/-/g, '_');
  switch (normalized) {
    case 'stop':
      return 'Stop';
    case 'notification':
      return 'Notification';
    case 'user_prompt_submit':
    case 'userpromptsubmit':
      return 'UserPromptSubmit';
    case 'pre_tool_use':
    case 'pretooluse':
      return 'PreToolUse';
    case 'post_tool_use':
    case 'posttooluse':
      return 'PostToolUse';
    case 'post_tool_use_failure':
    case 'posttoolusefailure':
      return 'PostToolUseFailure';
    case 'session_start':
    case 'sessionstart':
      return 'SessionStart';
    case 'session_end':
    case 'sessionend':
      return 'SessionEnd';
    default:
      return raw;
  }
}

function stringValue(...values) {
  for (const value of values) {
    if (typeof value === 'string' && value.trim()) {
      return value;
    }
  }
  return '';
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

  const hookEventName = normalizeHookEventName(
    payload.hookEventName || payload.hook_event_name || process.env.GROK_HOOK_EVENT
  );
  const sessionId = stringValue(
    payload.sessionId,
    payload.session_id,
    process.env.GROK_SESSION_ID
  );
  const message = stringValue(
    payload.lastAssistantMessage,
    payload.last_assistant_message,
    payload.message,
    payload.notificationMessage,
    payload.notification_message
  );

  const event = {
    source: 'grok-status-hook',
    dmuxPaneId: process.env.DMUX_PANE_ID || '',
    tmuxPaneId: process.env.DMUX_TMUX_PANE_ID || '',
    expectedDmuxPaneId: '${escapeForSingleQuotedJs(opts.dmuxPaneId)}',
    expectedTmuxPaneId: '${escapeForSingleQuotedJs(opts.tmuxPaneId)}',
    hookEventName,
    sessionId,
    turnId: stringValue(payload.turnId, payload.turn_id, sessionId),
    lastAssistantMessage: message || null,
    transcriptPath: stringValue(payload.transcriptPath, payload.transcript_path) || null,
    cwd: stringValue(payload.cwd, payload.workspaceRoot, process.env.GROK_WORKSPACE_ROOT) || process.cwd(),
    timestamp: Date.now()
  };

  if (event.dmuxPaneId !== event.expectedDmuxPaneId) {
    process.exit(0);
  }

  try {
    fs.writeFileSync('${escapeForSingleQuotedJs(eventFile)}', JSON.stringify(event, null, 2));
  } catch (error) {
    process.exit(0);
  }
});
`;
  atomicWriteFileSync(hookScriptPath, hookScript);
  fs.chmodSync(hookScriptPath, 0o755);

  const hookCommand = `node ${shellQuote(hookScriptPath)}`;
  const hookConfigPath = path.join(hookDir, 'dmux-hooks.json');
  const hookHandler = {
    type: 'command',
    command: hookCommand,
    timeout: 5,
    env: {
      DMUX_PANE_ID: opts.dmuxPaneId,
      DMUX_TMUX_PANE_ID: opts.tmuxPaneId,
    },
  };
  atomicWriteJsonSync(hookConfigPath, {
    description: 'dmux pane status hooks for Grok Build',
    hooks: {
      Stop: [
        {
          hooks: [hookHandler],
        },
      ],
      Notification: [
        {
          hooks: [hookHandler],
        },
      ],
    },
  });

  return { eventFile };
}
