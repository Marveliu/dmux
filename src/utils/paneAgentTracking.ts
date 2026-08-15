import { execFile } from 'child_process';
import fs from 'fs/promises';
import { promisify } from 'util';
import type { DmuxPane } from '../types.js';
import {
  getAgentDefinitions,
  getAgentProcessName,
  type AgentName,
} from './agentLaunch.js';

const execFileAsync = promisify(execFile);

const AGENT_PACKAGE_MARKERS: Partial<Record<AgentName, string[]>> = {
  claude: ['@anthropic-ai/claude-code'],
  codex: ['@openai/codex'],
  gemini: ['@google/gemini-cli'],
  qwen: ['@qwen-code/qwen-code'],
  copilot: ['@github/copilot'],
};

const AGENT_TRACKING_COMMAND_TIMEOUT_MS = 1500;

export interface ProcessSnapshot {
  pid: number;
  parentPid: number;
  command: string;
}

export interface PaneProcessSnapshot {
  paneId: string;
  rootPid: number;
  currentCommand: string;
}

export interface ActivePaneAgent {
  agent: AgentName;
  processId: number;
  sessionId?: string;
}

export interface PaneAgentObservationResult {
  // A null value means the pane was observed successfully and no agent is active.
  observations: Map<string, ActivePaneAgent | null>;
}

const executableAgentMap = new Map<string, AgentName>(
  getAgentDefinitions().map((definition) => [
    getAgentProcessName(definition.id).toLowerCase(),
    definition.id,
  ])
);

function normalizeExecutable(value: string): string {
  const basename = value.split('/').pop() || value;
  return basename
    .toLowerCase()
    .replace(/\.(?:c?js|mjs|exe)$/i, '');
}

function tokenizeCommand(command: string): string[] {
  // Process argv emitted by ps is only used to identify executable paths. A
  // lightweight tokenizer is sufficient and deliberately avoids evaluating it.
  return command.match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g)?.map((token) =>
    token.replace(/^["']|["']$/g, '')
  ) || [];
}

export function identifyAgentCommand(command: string): AgentName | undefined {
  const tokens = tokenizeCommand(command);
  if (tokens.length === 0) return undefined;

  const direct = executableAgentMap.get(normalizeExecutable(tokens[0]));
  if (direct) return direct;

  // JavaScript CLIs commonly appear as `node /path/to/package/cli.js`. Only
  // inspect executable/script tokens, never later prompt arguments.
  const runtime = normalizeExecutable(tokens[0]);
  if (['node', 'nodejs', 'bun', 'deno'].includes(runtime)) {
    const scriptTokens = tokens.slice(1, 5).filter((token) => !token.startsWith('-'));
    for (const token of scriptTokens) {
      const scriptNameMatch = executableAgentMap.get(normalizeExecutable(token));
      if (scriptNameMatch) return scriptNameMatch;

      const normalizedPath = token.toLowerCase();
      for (const definition of getAgentDefinitions()) {
        if (AGENT_PACKAGE_MARKERS[definition.id]?.some((marker) => normalizedPath.includes(marker))) {
          return definition.id;
        }
      }
    }
  }

  return undefined;
}

export function parseProcessSnapshots(output: string): ProcessSnapshot[] {
  return output.split('\n').flatMap((line) => {
    const match = line.match(/^\s*(\d+)\s+(\d+)\s+(.+)$/);
    if (!match) return [];
    return [{
      pid: Number(match[1]),
      parentPid: Number(match[2]),
      command: match[3],
    }];
  });
}

export function parsePaneProcessSnapshots(output: string): PaneProcessSnapshot[] {
  return output.split('\n').flatMap((line) => {
    const [paneId, pidValue, currentCommand = ''] = line.split('\t');
    const rootPid = Number(pidValue);
    if (!paneId?.startsWith('%') || !Number.isInteger(rootPid) || rootPid <= 0) {
      return [];
    }
    return [{ paneId, rootPid, currentCommand }];
  });
}

export function detectAgentProcesses(
  paneProcesses: PaneProcessSnapshot[],
  processes: ProcessSnapshot[]
): Map<string, Omit<ActivePaneAgent, 'sessionId'> | null> {
  const processById = new Map(processes.map((process) => [process.pid, process]));
  const childrenByParent = new Map<number, ProcessSnapshot[]>();
  for (const process of processes) {
    const children = childrenByParent.get(process.parentPid) || [];
    children.push(process);
    childrenByParent.set(process.parentPid, children);
  }

  const result = new Map<string, Omit<ActivePaneAgent, 'sessionId'> | null>();
  for (const pane of paneProcesses) {
    const queue: Array<{ process: ProcessSnapshot; depth: number }> = [];
    const root = processById.get(pane.rootPid);
    if (root) queue.push({ process: root, depth: 0 });
    for (const child of childrenByParent.get(pane.rootPid) || []) {
      queue.push({ process: child, depth: 1 });
    }

    let match: { agent: AgentName; processId: number; depth: number } | undefined;
    const visited = new Set<number>();
    while (queue.length > 0) {
      const current = queue.shift()!;
      if (visited.has(current.process.pid)) continue;
      visited.add(current.process.pid);

      const agent = identifyAgentCommand(current.process.command);
      if (agent && (!match || current.depth < match.depth)) {
        match = { agent, processId: current.process.pid, depth: current.depth };
      }

      for (const child of childrenByParent.get(current.process.pid) || []) {
        queue.push({ process: child, depth: current.depth + 1 });
      }
    }

    // pane_current_command remains useful for wrappers whose executable path
    // does not identify the npm package. Prefer the matched child PID for exact
    // session lookup when one exists.
    const currentAgent = identifyAgentCommand(pane.currentCommand);
    if (!match && currentAgent) {
      match = { agent: currentAgent, processId: pane.rootPid, depth: 0 };
    }

    result.set(
      pane.paneId,
      match ? { agent: match.agent, processId: match.processId } : null
    );
  }

  return result;
}

export function extractAgentSessionId(
  agent: AgentName,
  openFilesOutput: string
): string | undefined {
  const paths = openFilesOutput
    .split('\n')
    .filter((line) => line.startsWith('n'))
    .map((line) => line.slice(1));

  if (agent === 'claude') {
    const sessionFile = paths.find((filePath) =>
      filePath.includes('/.claude/projects/')
      && !filePath.includes('/subagents/')
      && /\/[0-9a-f-]{36}\.jsonl$/i.test(filePath)
    );
    return sessionFile?.match(/\/([0-9a-f-]{36})\.jsonl$/i)?.[1];
  }

  if (agent === 'codex') {
    const sessionFile = paths.find((filePath) =>
      filePath.includes('/.codex/sessions/')
      && /\/rollout-.*-[0-9a-f-]{36}\.jsonl$/i.test(filePath)
    );
    return sessionFile?.match(/-([0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12})\.jsonl$/i)?.[1];
  }

  return undefined;
}

async function resolveOpenSessionId(
  agent: AgentName,
  processId: number
): Promise<string | undefined> {
  if (agent !== 'claude' && agent !== 'codex') return undefined;

  // Linux exposes open descriptors directly. This avoids requiring lsof and
  // gives us the same exact-session behavior as macOS.
  try {
    const descriptorRoot = `/proc/${processId}/fd`;
    const descriptors = await fs.readdir(descriptorRoot);
    const openFiles = await Promise.all(descriptors.map(async (descriptor) => {
      try {
        return await fs.readlink(`${descriptorRoot}/${descriptor}`);
      } catch {
        return '';
      }
    }));
    const sessionId = extractAgentSessionId(
      agent,
      openFiles.filter(Boolean).map((filePath) => `n${filePath}`).join('\n')
    );
    if (sessionId) return sessionId;
  } catch {
    // /proc is unavailable on macOS and some restricted Linux environments.
  }

  try {
    const { stdout } = await execFileAsync('lsof', ['-Fn', '-p', String(processId)], {
      encoding: 'utf8',
      timeout: AGENT_TRACKING_COMMAND_TIMEOUT_MS,
      maxBuffer: 2 * 1024 * 1024,
    });
    return extractAgentSessionId(agent, stdout);
  } catch {
    // lsof is optional (and may not be installed on Linux). Resume-latest is
    // still available through the agent registry when no exact ID is found.
    return undefined;
  }
}

export async function observePaneAgents(
  panes: DmuxPane[]
): Promise<PaneAgentObservationResult> {
  if (panes.length === 0) return { observations: new Map() };

  try {
    const [{ stdout: paneOutput }, { stdout: processOutput }] = await Promise.all([
      execFileAsync('tmux', [
        'list-panes',
        '-s',
        '-F',
        '#{pane_id}\t#{pane_pid}\t#{pane_current_command}',
      ], {
        encoding: 'utf8',
        timeout: AGENT_TRACKING_COMMAND_TIMEOUT_MS,
      }),
      execFileAsync('ps', ['-axo', 'pid=,ppid=,args='], {
        encoding: 'utf8',
        timeout: AGENT_TRACKING_COMMAND_TIMEOUT_MS,
        maxBuffer: 8 * 1024 * 1024,
      }),
    ]);

    const trackedPaneIds = new Set(panes.map((pane) => pane.paneId));
    const paneProcesses = parsePaneProcessSnapshots(paneOutput)
      .filter((pane) => trackedPaneIds.has(pane.paneId));
    const detected = detectAgentProcesses(
      paneProcesses,
      parseProcessSnapshots(processOutput)
    );

    const observations = new Map<string, ActivePaneAgent | null>();
    await Promise.all(Array.from(detected.entries()).map(async ([paneId, observation]) => {
      if (!observation) {
        observations.set(paneId, null);
        return;
      }

      const previousPane = panes.find((pane) => pane.paneId === paneId);
      const sameProcess = previousPane?.activeAgent === observation.agent
        && previousPane.agentProcessId === observation.processId;
      const sessionId = sameProcess && previousPane.agentSessionId
        ? previousPane.agentSessionId
        : await resolveOpenSessionId(observation.agent, observation.processId);
      observations.set(paneId, { ...observation, sessionId });
    }));

    return { observations };
  } catch {
    // An empty map means observation failed. Callers must preserve metadata,
    // unlike null entries which explicitly mean "no agent is active".
    return { observations: new Map() };
  }
}

export function syncPaneAgentMetadata(
  panes: DmuxPane[],
  observations: Map<string, ActivePaneAgent | null>,
  observedAt = Date.now()
): { panes: DmuxPane[]; changed: boolean } {
  let changed = false;
  const nextPanes = panes.map((pane) => {
    if (!observations.has(pane.paneId)) return pane;
    const observation = observations.get(pane.paneId) ?? null;

    if (!observation) {
      if (!pane.activeAgent && pane.agentProcessId === undefined) return pane;
      changed = true;
      return {
        ...pane,
        activeAgent: undefined,
        agentProcessId: undefined,
        agentStatus: undefined,
        needsAttention: undefined,
      };
    }

    const sameProcess = pane.activeAgent === observation.agent
      && pane.agentProcessId === observation.processId;
    const sessionId = observation.sessionId
      ?? (sameProcess ? pane.agentSessionId : undefined);
    if (
      pane.agent === observation.agent
      && pane.activeAgent === observation.agent
      && pane.agentProcessId === observation.processId
      && pane.agentSessionId === sessionId
    ) {
      return pane;
    }

    changed = true;
    return {
      ...pane,
      agent: observation.agent,
      activeAgent: observation.agent,
      agentProcessId: observation.processId,
      agentSessionId: sessionId,
      lastAgentObservedAt: observedAt,
    };
  });

  return { panes: nextPanes, changed };
}
