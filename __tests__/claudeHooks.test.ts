import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import { installClaudePaneHooks } from '../src/utils/claudeHooks.js';

const tempDirs: string[] = [];

afterEach(() => {
  while (tempDirs.length > 0) {
    const tempDir = tempDirs.pop();
    if (tempDir) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  }
});

describe('claudeHooks', () => {
  it('installs a local Stop hook that records dmux pane events', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dmux-claude-hooks-'));
    tempDirs.push(tempDir);

    const result = installClaudePaneHooks({
      worktreePath: tempDir,
      dmuxPaneId: 'dmux-1',
      tmuxPaneId: '%7',
    });

    expect(result.eventFile).toBe(path.join(tempDir, '.claude', 'dmux', 'dmux-1.json'));

    const settings = JSON.parse(
      fs.readFileSync(path.join(tempDir, '.claude', 'settings.local.json'), 'utf-8')
    );
    expect(settings.hooks.Stop).toHaveLength(1);
    expect(settings.hooks.Stop[0].hooks[0].command).toContain('dmux-stop-hook.cjs');

    const hookScript = fs.readFileSync(
      path.join(tempDir, '.claude', 'hooks', 'dmux-stop-hook.cjs'),
      'utf-8'
    );
    expect(hookScript).toContain('stopHookActive');
    expect(hookScript).toContain('claude-stop-hook');
  });
});
