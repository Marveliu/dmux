import { beforeEach, describe, expect, it, vi } from 'vitest';

const { spawnSyncMock } = vi.hoisted(() => ({
  spawnSyncMock: vi.fn(),
}));

vi.mock('child_process', () => ({
  spawnSync: spawnSyncMock,
}));

import {
  attachTmuxSession,
  startDetachedTmuxSession,
} from '../src/utils/tmuxSessionStart.js';

describe('tmux session startup', () => {
  beforeEach(() => {
    spawnSyncMock.mockReset();
  });

  it('starts dmux as the pane command instead of sending keys to a shell', () => {
    spawnSyncMock.mockReturnValue({ status: 0, stderr: '' });

    startDetachedTmuxSession({
      sessionName: 'dmux-demo',
      startDirectory: '/repo',
      command: "env PATH='/usr/local/bin' '/usr/local/bin/dmux'",
    });

    expect(spawnSyncMock).toHaveBeenCalledWith(
      'tmux',
      [
        'new-session',
        '-d',
        '-s',
        'dmux-demo',
        '-c',
        '/repo',
        "env PATH='/usr/local/bin' '/usr/local/bin/dmux'",
      ],
      {
        encoding: 'utf-8',
        stdio: 'pipe',
      }
    );
  });

  it('attaches to the target session through tmux arguments', () => {
    spawnSyncMock.mockReturnValue({ status: 0 });

    attachTmuxSession('dmux-demo');

    expect(spawnSyncMock).toHaveBeenCalledWith(
      'tmux',
      ['attach-session', '-t', 'dmux-demo'],
      { stdio: 'inherit' }
    );
  });

  it('throws when detached session startup fails', () => {
    spawnSyncMock.mockReturnValue({ status: 1, stderr: 'duplicate session' });

    expect(() => startDetachedTmuxSession({
      sessionName: 'dmux-demo',
      startDirectory: '/repo',
      command: 'dmux',
    })).toThrow('Failed to start tmux session dmux-demo: duplicate session');
  });
});
