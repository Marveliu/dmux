import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { DmuxPane } from '../src/types.js';

const tmuxServiceMock = vi.hoisted(() => ({
  setPaneTitle: vi.fn(async () => {}),
  sendKeys: vi.fn(async () => {}),
  sendShellCommand: vi.fn(async () => {}),
  sendTmuxKeys: vi.fn(async () => {}),
  selectLayout: vi.fn(async () => {}),
  refreshClient: vi.fn(async () => {}),
}));

const splitPaneMock = vi.hoisted(() => vi.fn(() => '%9'));

vi.mock('../src/services/TmuxService.js', () => ({
  TmuxService: {
    getInstance: vi.fn(() => tmuxServiceMock),
  },
}));

vi.mock('../src/utils/tmux.js', () => ({
  splitPane: splitPaneMock,
}));

vi.mock('../src/utils/geminiTrust.js', () => ({
  ensureGeminiFolderTrusted: vi.fn(),
}));

describe('pane restoration', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    splitPaneMock.mockReturnValue('%9');
  });

  it('resumes restored worktree panes with their original agent command', async () => {
    const { recreateMissingPanes } = await import('../src/hooks/usePaneLoading.js');

    const pane: DmuxPane = {
      id: 'dmux-1',
      slug: 'feature-codex',
      prompt: 'fix the failing tests',
      paneId: '%2',
      worktreePath: '/repo/.dmux/worktrees/feature-codex',
      projectRoot: '/repo',
      agent: 'codex',
      permissionMode: 'bypassPermissions',
    };

    await recreateMissingPanes([pane], '/repo/.dmux/dmux.config.json');

    expect(tmuxServiceMock.sendShellCommand).toHaveBeenCalledWith(
      '%9',
      expect.stringContaining(
        "export DMUX_PANE_ID='dmux-1'; export DMUX_TMUX_PANE_ID='%9'; codex --enable hooks resume --last --dangerously-bypass-approvals-and-sandbox"
      )
    );
    expect(tmuxServiceMock.sendTmuxKeys).toHaveBeenCalledWith('%9', 'Enter');
  });

  it('restores a regular terminal in its persisted working directory', async () => {
    const { recreateMissingPanes } = await import('../src/hooks/usePaneLoading.js');
    const cwd = process.cwd();
    const pane: DmuxPane = {
      id: 'dmux-2',
      slug: 'shell-2',
      displayName: 'Run Integration Tests',
      displayNameSource: 'auto',
      prompt: '',
      paneId: '%3',
      type: 'shell',
      shellType: 'zsh',
      shellCwd: cwd,
      projectRoot: cwd,
    };

    await recreateMissingPanes([pane], `${cwd}/.dmux/dmux.config.json`);

    expect(splitPaneMock).toHaveBeenCalledWith({ cwd, command: undefined });
    expect(tmuxServiceMock.setPaneTitle).toHaveBeenCalledWith(
      '%9',
      'Run Integration Tests__dmux__shell-2'
    );
    expect(pane.paneId).toBe('%9');
    expect(tmuxServiceMock.sendShellCommand).not.toHaveBeenCalled();
    expect(tmuxServiceMock.sendKeys).not.toHaveBeenCalled();
  });

  it('resumes the exact manually launched agent session for a restored terminal', async () => {
    const { recreateMissingPanes } = await import('../src/hooks/usePaneLoading.js');
    const cwd = process.cwd();
    const pane: DmuxPane = {
      id: 'dmux-4',
      slug: 'shell-4',
      prompt: '',
      paneId: '%5',
      type: 'shell',
      shellType: 'zsh',
      shellCwd: cwd,
      agent: 'claude',
      activeAgent: 'claude',
      agentSessionId: '12345678-1234-1234-1234-123456789abc',
    };

    await recreateMissingPanes([pane], `${cwd}/.dmux/dmux.config.json`);

    expect(tmuxServiceMock.sendShellCommand).toHaveBeenCalledWith(
      '%9',
      "claude --resume '12345678-1234-1234-1234-123456789abc'"
    );
    expect(tmuxServiceMock.sendTmuxKeys).toHaveBeenCalledWith('%9', 'Enter');
  });

  it('relaunches a dmux-owned shell command when restoring it', async () => {
    const { recreateMissingPanes } = await import('../src/hooks/usePaneLoading.js');
    const cwd = process.cwd();
    const pane: DmuxPane = {
      id: 'dmux-3',
      slug: 'files-feature',
      prompt: '',
      paneId: '%4',
      type: 'shell',
      shellType: 'fb',
      shellCwd: cwd,
      shellCommand: 'dmux --files-only',
      browserPath: cwd,
    };

    await recreateMissingPanes([pane], `${cwd}/.dmux/dmux.config.json`);

    expect(splitPaneMock).toHaveBeenCalledWith({
      cwd,
      command: 'dmux --files-only',
    });
  });
});
