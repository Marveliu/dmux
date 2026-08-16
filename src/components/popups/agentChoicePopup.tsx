#!/usr/bin/env node

/**
 * Standalone popup for choosing one or more agents.
 * Runs in a tmux popup modal and writes result to a file.
 */

import React, { useMemo, useRef, useState } from 'react';
import { render, Box, Text, useInput, useApp } from 'ink';
import { PopupContainer, PopupWrapper, writeSuccessAndExit } from './shared/index.js';
import { POPUP_CONFIG } from './config.js';
import {
  buildAgentLaunchCounts,
  MAX_AGENT_LAUNCH_COUNT,
  normalizeAgentLaunchCount,
  resolveAgentsToLaunchOnEnter,
  type AgentLaunchCounts,
} from './agentChoiceSelection.js';
import {
  getAgentLabel,
  getAgentShortLabel,
  isAgentName,
  type AgentName,
} from '../../utils/agentLaunch.js';

interface AgentChoicePopupProps {
  resultFile: string;
  availableAgents: AgentName[];
  initialSelectedAgents: AgentName[];
}

const AgentChoicePopupApp: React.FC<AgentChoicePopupProps> = ({
  resultFile,
  availableAgents,
  initialSelectedAgents,
}) => {
  const { exit } = useApp();
  const [selectedIndex, setSelectedIndex] = useState(() => {
    const firstSelectedIndex = availableAgents.findIndex((agent) =>
      initialSelectedAgents.includes(agent)
    );
    return firstSelectedIndex >= 0 ? firstSelectedIndex : 0;
  });
  const [selectedAgentCounts, setSelectedAgentCounts] = useState<AgentLaunchCounts>(
    () => buildAgentLaunchCounts(availableAgents, initialSelectedAgents)
  );
  const [validationMessage, setValidationMessage] = useState<string | null>(null);
  const selectedIndexRef = useRef(selectedIndex);
  const selectedAgentCountsRef = useRef(selectedAgentCounts);
  selectedIndexRef.current = selectedIndex;
  selectedAgentCountsRef.current = selectedAgentCounts;

  const selectedPaneCount = useMemo(
    () => availableAgents.reduce(
      (total, agent) => total + normalizeAgentLaunchCount(selectedAgentCounts[agent]),
      0
    ),
    [availableAgents, selectedAgentCounts]
  );
  const selectedAgentKindCount = useMemo(
    () => availableAgents.filter(
      (agent) => normalizeAgentLaunchCount(selectedAgentCounts[agent]) > 0
    ).length,
    [availableAgents, selectedAgentCounts]
  );
  const agentLabelColumnWidth = useMemo(
    () => availableAgents.reduce(
      (width, agent) => Math.max(
        width,
        getAgentLabel(agent).length + 1 + getAgentShortLabel(agent).length
      ),
      0
    ),
    [availableAgents]
  );

  const setSelectedIndexValue = (nextIndex: number) => {
    selectedIndexRef.current = nextIndex;
    setSelectedIndex(nextIndex);
  };

  const setSelectedAgentCountsValue = (nextSelectedAgentCounts: AgentLaunchCounts) => {
    selectedAgentCountsRef.current = nextSelectedAgentCounts;
    setValidationMessage(null);
    setSelectedAgentCounts(nextSelectedAgentCounts);
  };

  const setFocusedAgentCount = (nextCount: number) => {
    const agent = availableAgents[selectedIndexRef.current];
    if (!agent) return;

    const normalizedCount = normalizeAgentLaunchCount(nextCount);
    const next = { ...selectedAgentCountsRef.current };
    if (normalizedCount > 0) {
      next[agent] = normalizedCount;
    } else {
      delete next[agent];
    }

    setSelectedAgentCountsValue(next);
  };

  const adjustFocusedAgentCount = (delta: number) => {
    const agent = availableAgents[selectedIndexRef.current];
    if (!agent) return;

    const currentCount = normalizeAgentLaunchCount(selectedAgentCountsRef.current[agent]);
    setFocusedAgentCount(currentCount + delta);
  };

  const toggleFocusedAgent = () => {
    const agent = availableAgents[selectedIndexRef.current];
    if (!agent) return;

    const currentCount = normalizeAgentLaunchCount(selectedAgentCountsRef.current[agent]);
    setFocusedAgentCount(currentCount > 0 ? 0 : 1);
  };

  useInput((input, key) => {
    if (availableAgents.length === 0) {
      if (key.return) {
        writeSuccessAndExit(resultFile, [], exit);
      }
      return;
    }

    if (key.upArrow) {
      setSelectedIndexValue(Math.max(0, selectedIndexRef.current - 1));
      return;
    }

    if (key.downArrow) {
      setSelectedIndexValue(
        Math.min(availableAgents.length - 1, selectedIndexRef.current + 1)
      );
      return;
    }

    if (key.leftArrow) {
      adjustFocusedAgentCount(-1);
      return;
    }

    if (key.rightArrow) {
      adjustFocusedAgentCount(1);
      return;
    }

    if (input === ' ') {
      toggleFocusedAgent();
      return;
    }

    if (key.return) {
      const launchAgents = resolveAgentsToLaunchOnEnter(
        availableAgents,
        selectedAgentCountsRef.current
      );
      if (launchAgents.length === 0) {
        setValidationMessage('Select at least one pane');
        return;
      }
      writeSuccessAndExit(resultFile, launchAgents, exit);
    }
  });

  return (
    <PopupWrapper resultFile={resultFile}>
      <PopupContainer footer="↑↓ navigate • ←/→ count • Space 1x/0x • Enter launch • ESC cancel">
        <Box flexDirection="column" marginBottom={1}>
          <Text dimColor>
            Space toggles 1x/0x. Left/right changes count up to {MAX_AGENT_LAUNCH_COUNT}x.
          </Text>
          <Text color={POPUP_CONFIG.titleColor}>
            Panes: {selectedPaneCount} • Agents: {selectedAgentKindCount}/{availableAgents.length}
          </Text>
          {validationMessage && (
            <Text color={POPUP_CONFIG.errorColor}>
              {validationMessage}
            </Text>
          )}
        </Box>

        <Box flexDirection="column">
          {availableAgents.length === 0 && (
            <Text dimColor>No enabled agents available</Text>
          )}
          {availableAgents.map((agent, index) => {
            const isSelectedRow = index === selectedIndex;
            const count = normalizeAgentLaunchCount(selectedAgentCounts[agent]);
            const isChecked = count > 0;
            const label = getAgentLabel(agent);
            const shortLabel = getAgentShortLabel(agent);
            const labelWidth = label.length + 1 + shortLabel.length;
            const spacer = ' '.repeat(Math.max(2, agentLabelColumnWidth - labelWidth + 3));
            const filledSlots = '■'.repeat(count);
            const emptySlots = ' '.repeat(MAX_AGENT_LAUNCH_COUNT - count);
            const countText = `${count}x`;
            const countColor = isChecked ? POPUP_CONFIG.successColor : 'gray';

            return (
              <Box key={agent}>
                <Text color={isSelectedRow ? POPUP_CONFIG.titleColor : 'gray'} bold={isSelectedRow}>
                  {isSelectedRow ? '›' : ' '}
                </Text>
                <Text
                  color={isSelectedRow ? POPUP_CONFIG.titleColor : 'white'}
                  bold={isSelectedRow}
                >
                  {' '}
                  {label}
                </Text>
                <Text color={isSelectedRow ? POPUP_CONFIG.titleColor : 'gray'}>
                  {' '}
                  {shortLabel}
                </Text>
                <Text>{spacer}</Text>
                <Text color={isSelectedRow ? POPUP_CONFIG.titleColor : 'gray'}>
                  [
                </Text>
                <Text color={POPUP_CONFIG.successColor} bold={isChecked}>
                  {filledSlots}
                </Text>
                <Text>
                  {emptySlots}
                </Text>
                <Text color={isSelectedRow ? POPUP_CONFIG.titleColor : 'gray'}>
                  ]
                </Text>
                <Text color={countColor} bold={isSelectedRow || isChecked}>
                  {' '}
                  {countText}
                </Text>
              </Box>
            );
          })}
        </Box>
      </PopupContainer>
    </PopupWrapper>
  );
};

// Entry point
function main() {
  const resultFile = process.argv[2];
  const agentsJson = process.argv[3];
  const initialSelectedJson = process.argv[4];

  if (!resultFile || !agentsJson) {
    console.error('Error: Result file and agents JSON required');
    process.exit(1);
  }

  let availableAgents: AgentName[];
  try {
    availableAgents = JSON.parse(agentsJson);
  } catch {
    console.error('Error: Failed to parse agents JSON');
    process.exit(1);
  }

  let initialSelectedAgents: AgentName[] = [];
  if (initialSelectedJson) {
    try {
      const parsed = JSON.parse(initialSelectedJson);
      if (Array.isArray(parsed)) {
        initialSelectedAgents = parsed.filter((agent): agent is AgentName =>
          isAgentName(agent)
        );
      }
    } catch {
      // Ignore invalid initial selection payloads and fall back to no preselection.
    }
  }

  render(
    <AgentChoicePopupApp
      resultFile={resultFile}
      availableAgents={availableAgents}
      initialSelectedAgents={initialSelectedAgents}
    />
  );
}

main();
