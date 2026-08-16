import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import { installGrokPaneHooks } from '../src/utils/grokHooks.js';

const tempDirs: string[] = [];

afterEach(() => {
  while (tempDirs.length > 0) {
    const tempDir = tempDirs.pop();
    if (tempDir) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  }
});

describe('grokHooks', () => {
  it('installs local Grok hooks that record dmux pane events', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dmux-grok-hooks-'));
    tempDirs.push(tempDir);

    const result = installGrokPaneHooks({
      worktreePath: tempDir,
      dmuxPaneId: 'dmux-1',
      tmuxPaneId: '%7',
    });

    expect(result.eventFile).toBe(path.join(tempDir, '.grok', 'dmux', 'dmux-1.json'));

    const hooksConfig = JSON.parse(
      fs.readFileSync(path.join(tempDir, '.grok', 'hooks', 'dmux-hooks.json'), 'utf-8')
    );
    expect(hooksConfig.hooks.Stop).toHaveLength(1);
    expect(hooksConfig.hooks.Notification).toHaveLength(1);
    expect(hooksConfig.hooks.Stop[0].hooks[0].command).toContain('dmux-status-hook.cjs');
    expect(hooksConfig.hooks.Stop[0].hooks[0].env).toMatchObject({
      DMUX_PANE_ID: 'dmux-1',
      DMUX_TMUX_PANE_ID: '%7',
    });

    const hookScript = fs.readFileSync(
      path.join(tempDir, '.grok', 'hooks', 'dmux-status-hook.cjs'),
      'utf-8'
    );
    expect(hookScript).toContain('grok-status-hook');
    expect(hookScript).toContain('GROK_HOOK_EVENT');
    expect(hookScript).toContain('expectedDmuxPaneId');
  });
});
