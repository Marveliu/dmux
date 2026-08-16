import { describe, expect, it } from 'vitest';
import type { DmuxPane } from '../src/types.js';
import {
  detectAgentProcesses,
  extractAgentSessionId,
  identifyAgentCommand,
  parsePaneProcessSnapshots,
  parseProcessSnapshots,
  syncPaneAgentMetadata,
} from '../src/utils/paneAgentTracking.js';

describe('pane agent tracking', () => {
  it('recognizes native and package-runner agent processes without reading prompt arguments', () => {
    expect(identifyAgentCommand('/usr/local/bin/codex')).toBe('codex');
    expect(identifyAgentCommand('node /opt/node_modules/@anthropic-ai/claude-code/cli.js')).toBe('claude');
    expect(identifyAgentCommand('zsh -c echo claude')).toBeUndefined();
  });

  it('finds an agent below the pane shell process', () => {
    const panes = parsePaneProcessSnapshots('%7\t100\tzsh\n%8\t200\tzsh\n');
    const processes = parseProcessSnapshots([
      '  100     1 /bin/zsh',
      '  110   100 /usr/local/bin/codex',
      '  111   110 /usr/local/bin/codex-code-mode-host',
      '  200     1 /bin/zsh',
    ].join('\n'));

    expect(detectAgentProcesses(panes, processes)).toEqual(new Map([
      ['%7', { agent: 'codex', processId: 110 }],
      ['%8', null],
    ]));
  });

  it('extracts exact Claude and Codex session IDs from open session files', () => {
    expect(extractAgentSessionId(
      'claude',
      'p42\nn/Users/me/.claude/projects/-repo/12345678-1234-1234-1234-123456789abc.jsonl\n'
    )).toBe('12345678-1234-1234-1234-123456789abc');
    expect(extractAgentSessionId(
      'codex',
      'p43\nn/Users/me/.codex/sessions/2026/08/15/rollout-date-abcdefab-1234-5678-9abc-abcdefabcdef.jsonl\n'
    )).toBe('abcdefab-1234-5678-9abc-abcdefabcdef');
  });

  it('tracks manual agent switches and clears only the active marker on exit', () => {
    const shellPane: DmuxPane = {
      id: 'dmux-3',
      slug: 'shell-3',
      prompt: '',
      paneId: '%3',
      type: 'shell',
      shellType: 'zsh',
    };

    const codex = syncPaneAgentMetadata(
      [shellPane],
      new Map([['%3', {
        agent: 'codex' as const,
        processId: 71,
        sessionId: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
      }]]),
      10
    ).panes[0];
    expect(codex).toMatchObject({
      agent: 'codex',
      activeAgent: 'codex',
      agentProcessId: 71,
      agentSessionId: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
      lastAgentObservedAt: 10,
    });

    const exited = syncPaneAgentMetadata(
      [codex],
      new Map([['%3', null]]),
      20
    ).panes[0];
    expect(exited.activeAgent).toBeUndefined();
    expect(exited.agent).toBe('codex');
    expect(exited.agentSessionId).toBe('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa');

    const claude = syncPaneAgentMetadata(
      [exited],
      new Map([['%3', {
        agent: 'claude' as const,
        processId: 88,
        sessionId: 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb',
      }]]),
      30
    ).panes[0];
    expect(claude).toMatchObject({
      agent: 'claude',
      activeAgent: 'claude',
      agentSessionId: 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb',
    });
  });
});
