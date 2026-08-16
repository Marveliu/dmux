import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DMUX_BOOTSTRAP_PANE_TITLE_PREFIX } from '../src/utils/paneBootstrapConfig.js';
import { getUntrackedPanes } from '../src/utils/shellPaneDetection.js';

const execSyncMock = vi.hoisted(() => vi.fn());

vi.mock('child_process', () => ({
  execSync: execSyncMock,
}));

describe('shell pane detection', () => {
  beforeEach(() => {
    execSyncMock.mockReset();
  });

  it('ignores dmux bootstrap panes before they are saved as worktree panes', async () => {
    execSyncMock.mockReturnValue(
      [
        `%1::${DMUX_BOOTSTRAP_PANE_TITLE_PREFIX}add-user::zsh`,
        '%2::manual-shell::zsh',
      ].join('\n')
    );

    const panes = await getUntrackedPanes('', [], undefined, undefined);

    expect(panes).toEqual([
      {
        paneId: '%2',
        title: 'manual-shell',
        command: 'zsh',
      },
    ]);
  });
});
