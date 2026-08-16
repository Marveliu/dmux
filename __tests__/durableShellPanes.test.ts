import { describe, expect, it } from 'vitest';
import { rebindAndFilterPanes } from '../src/hooks/usePaneSync.js';
import type { DmuxPane } from '../src/types.js';

describe('durable shell pane reconciliation', () => {
  it('keeps and queues a regular terminal when its tmux pane disappears', () => {
    const shellPane: DmuxPane = {
      id: 'dmux-7',
      slug: 'shell-7',
      prompt: '',
      paneId: '%7',
      type: 'shell',
      shellType: 'zsh',
      shellCwd: '/repo/packages/app',
    };

    const result = rebindAndFilterPanes(
      [shellPane],
      new Map(),
      ['%1'],
      false
    );

    expect(result.activePanes).toEqual([shellPane]);
    expect(result.panesToRecreate).toEqual([shellPane]);
  });
});
