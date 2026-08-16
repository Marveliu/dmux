import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  buildCodexHookedCommand,
  CODEX_ENABLE_GOALS_FLAG,
  CODEX_ENABLE_HOOKS_FLAG,
  enableCodexHooksFlag,
  installCodexPaneHooks,
} from '../src/utils/codexHooks.js';

const tempDirs: string[] = [];

afterEach(() => {
  while (tempDirs.length > 0) {
    const tempDir = tempDirs.pop();
    if (tempDir) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  }
});

describe('codexHooks', () => {
  it('uses the supported hooks feature flag when enabling Codex hooks', () => {
    expect(enableCodexHooksFlag('codex resume --last')).toBe(
      `codex ${CODEX_ENABLE_HOOKS_FLAG} resume --last`
    );
  });

  it('prefixes exported dmux variables before enabling hooks', () => {
    expect(buildCodexHookedCommand('codex resume --last', {
      dmuxPaneId: 'dmux-1',
      tmuxPaneId: '%9',
      eventFile: '/tmp/dmux-event.json',
    })).toBe(
      "export DMUX_PANE_ID='dmux-1'; export DMUX_TMUX_PANE_ID='%9'; export DMUX_CODEX_HOOK_EVENT_FILE='/tmp/dmux-event.json'; codex --enable hooks resume --last"
    );
  });

  it('can enable the Codex goals feature alongside hooks', () => {
    expect(buildCodexHookedCommand('codex resume --last', {
      dmuxPaneId: 'dmux-1',
      tmuxPaneId: '%9',
    }, {
      enableGoals: true,
    })).toBe(
      `export DMUX_PANE_ID='dmux-1'; export DMUX_TMUX_PANE_ID='%9'; codex ${CODEX_ENABLE_HOOKS_FLAG} ${CODEX_ENABLE_GOALS_FLAG} resume --last`
    );
  });

  it('installs a Stop hook that always returns valid JSON output', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dmux-codex-hooks-'));
    tempDirs.push(tempDir);

    const result = installCodexPaneHooks({
      worktreePath: tempDir,
      dmuxPaneId: 'dmux-1',
      tmuxPaneId: '%9',
    });

    const hookScriptPath = path.join(tempDir, '.codex', 'hooks', 'dmux-stop-hook.cjs');
    const hooksConfig = JSON.parse(
      fs.readFileSync(path.join(tempDir, '.codex', 'hooks.json'), 'utf-8')
    );
    expect(hooksConfig.hooks.Stop[0].hooks[0].command).toBe(
      "node '.codex/hooks/dmux-stop-hook.cjs'"
    );

    const stopOutput = execFileSync('node', [hookScriptPath], {
      input: JSON.stringify({
        hook_event_name: 'Stop',
        turn_id: 'turn-1',
        stop_hook_active: true,
      }),
      encoding: 'utf-8',
      env: {
        ...process.env,
        DMUX_PANE_ID: 'dmux-1',
        DMUX_TMUX_PANE_ID: '%9',
        DMUX_CODEX_HOOK_EVENT_FILE: result.eventFile,
      },
    });

    expect(stopOutput).toBe('{}');
    expect(JSON.parse(fs.readFileSync(result.eventFile, 'utf-8'))).toMatchObject({
      source: 'codex-stop-hook',
      dmuxPaneId: 'dmux-1',
      tmuxPaneId: '%9',
      stopHookActive: true,
    });

    fs.rmSync(result.eventFile);

    const ignoredOutput = execFileSync('node', [hookScriptPath], {
      input: JSON.stringify({ hook_event_name: 'Stop' }),
      encoding: 'utf-8',
      env: {
        ...process.env,
        DMUX_PANE_ID: '',
        DMUX_TMUX_PANE_ID: '%10',
        DMUX_CODEX_HOOK_EVENT_FILE: '',
      },
    });

    expect(ignoredOutput).toBe('{}');
    expect(fs.existsSync(result.eventFile)).toBe(false);
  });
});
