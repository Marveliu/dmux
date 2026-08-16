import { describe, expect, it } from 'vitest';
import {
  buildPaneActivityFingerprint,
  getAgentHookStatus,
  hasAgentWorkingIndicators,
  isLikelyUserTyping,
} from '../src/utils/paneAttentionHeuristics.js';

describe('paneAttentionHeuristics', () => {
  it('detects interrupt-based working indicators', () => {
    expect(hasAgentWorkingIndicators('Planning changes\n(esc to interrupt)')).toBe(true);
  });

  it('detects generic progress lines for non-claude agents', () => {
    expect(hasAgentWorkingIndicators('● Working... collecting files', 'codex')).toBe(true);
    expect(hasAgentWorkingIndicators('◆ Thought for 3.8s\n⠋ analyzing files', 'grok')).toBe(true);
    expect(hasAgentWorkingIndicators('⏳ Processing repository state', 'gemini')).toBe(true);
  });

  it('detects small prompt edits as user typing', () => {
    expect(isLikelyUserTyping('> fix auth bug', '> fix auth bug please')).toBe(true);
    expect(isLikelyUserTyping('│ > add tests', '│ > add tests now')).toBe(true);
    expect(isLikelyUserTyping('', '> start here')).toBe(true);
  });

  it('detects long multi-line prompt drafting as user typing', () => {
    const previous = [
      'Updated auth.ts',
      '> write the follow-up note for the migration',
      '  and mention the config change',
    ].join('\n');
    const current = [
      'Updated auth.ts',
      '> write the follow-up note for the migration',
      '  and mention the config change',
      '  plus the rollback plan before I send it',
    ].join('\n');

    expect(isLikelyUserTyping(previous, current)).toBe(true);
  });

  it('does not treat large multi-line changes as user typing', () => {
    const previous = [
      'Reading files',
      'Checking auth.ts',
      '> fix auth bug',
    ].join('\n');
    const current = [
      'Updated auth.ts',
      'Added tests',
      'Build succeeded',
    ].join('\n');

    expect(isLikelyUserTyping(previous, current)).toBe(false);
  });

  it('ignores top-of-window context shifts when building activity fingerprints', () => {
    const stableTail = Array.from({ length: 12 }, (_, index) => `stable line ${index + 1}`);
    const previous = [
      'older context 1',
      'older context 2',
      'older context 3',
      ...stableTail,
    ].join('\n');
    const current = [
      'different context a',
      'different context b',
      'different context c',
      ...stableTail,
    ].join('\n');

    expect(buildPaneActivityFingerprint(previous)).toBe(
      buildPaneActivityFingerprint(current)
    );
  });

  it('classifies agent lifecycle hook events before they reach notification handling', () => {
    expect(getAgentHookStatus({ hookEventName: 'PreToolUse' })).toBe('working');
    expect(getAgentHookStatus({ hook_event_name: 'PostToolUse' })).toBe('working');
    expect(getAgentHookStatus({ hookEventName: 'PermissionRequest' })).toBe('waiting');
    expect(getAgentHookStatus({ hookEventName: 'Notification' })).toBe('waiting');
    expect(getAgentHookStatus({ hookEventName: 'Stop' })).toBe('idle');
    expect(getAgentHookStatus({ dmuxStatus: 'working', hookEventName: 'Stop' })).toBe('working');
    expect(getAgentHookStatus({ hookEventName: 'UnknownEvent' })).toBe(null);
  });
});
