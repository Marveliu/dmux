import { describe, expect, it } from 'vitest';
import {
  buildAgentLaunchCounts,
  resolveAgentsToLaunchOnEnter,
} from '../src/components/popups/agentChoiceSelection.js';
import type { AgentName } from '../src/utils/agentLaunch.js';

describe('resolveAgentsToLaunchOnEnter', () => {
  const availableAgents: AgentName[] = ['claude', 'codex', 'grok', 'opencode'];

  it('returns empty when no agents are selected', () => {
    const result = resolveAgentsToLaunchOnEnter(
      availableAgents,
      {}
    );

    expect(result).toEqual([]);
  });

  it('launches selected agents when one or more are selected', () => {
    const result = resolveAgentsToLaunchOnEnter(
      availableAgents,
      {
        opencode: 1,
        claude: 1,
      }
    );

    // Preserve UI order, not set insertion order.
    expect(result).toEqual(['claude', 'opencode']);
  });

  it('ignores unavailable selected agents', () => {
    const result = resolveAgentsToLaunchOnEnter(
      availableAgents,
      {
        cursor: 1,
      }
    );

    expect(result).toEqual([]);
  });

  it('expands per-agent counts up to three panes per agent', () => {
    const counts = buildAgentLaunchCounts(
      availableAgents,
      ['codex', 'codex', 'codex', 'codex', 'grok']
    );
    const result = resolveAgentsToLaunchOnEnter(
      availableAgents,
      counts
    );

    expect(result).toEqual(['codex', 'codex', 'codex', 'grok']);
  });
});
