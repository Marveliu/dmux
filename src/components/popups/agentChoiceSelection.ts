import type { AgentName } from '../../utils/agentLaunch.js';

export const MAX_AGENT_LAUNCH_COUNT = 3;

export type AgentLaunchCounts = Partial<Record<AgentName, number>>;

export function normalizeAgentLaunchCount(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return 0;
  }

  return Math.max(0, Math.min(MAX_AGENT_LAUNCH_COUNT, Math.trunc(value)));
}

export function buildAgentLaunchCounts(
  availableAgents: AgentName[],
  selectedAgents: readonly AgentName[]
): AgentLaunchCounts {
  const availableAgentSet = new Set(availableAgents);
  const counts: AgentLaunchCounts = {};

  for (const agent of selectedAgents) {
    if (!availableAgentSet.has(agent)) {
      continue;
    }

    const currentCount = normalizeAgentLaunchCount(counts[agent]);
    if (currentCount < MAX_AGENT_LAUNCH_COUNT) {
      counts[agent] = currentCount + 1;
    }
  }

  return counts;
}

/**
 * Enter-key behavior for multi-agent popup:
 * - Launch the expanded selected counts in visible agent order.
 * - Return an empty list when the user has selected 0 panes.
 */
export function resolveAgentsToLaunchOnEnter(
  availableAgents: AgentName[],
  selectedAgentCounts: Readonly<AgentLaunchCounts>
): AgentName[] {
  return availableAgents.flatMap((agent) => {
    const count = normalizeAgentLaunchCount(selectedAgentCounts[agent]);
    return Array.from({ length: count }, () => agent);
  });
}
