import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { triggerHookWithProgress, type HookProgressEvent } from '../src/utils/hooks.js';

const tempDirs: string[] = [];

function makeTempProject(): string {
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'dmux-hooks-progress-'));
  tempDirs.push(projectRoot);
  fs.mkdirSync(path.join(projectRoot, '.dmux-hooks'), { recursive: true });
  return projectRoot;
}

afterEach(() => {
  for (const tempDir of tempDirs.splice(0)) {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

describe('triggerHookWithProgress', () => {
  it('streams stdout and stderr lines while waiting for a blocking hook', async () => {
    const projectRoot = makeTempProject();
    const hookPath = path.join(projectRoot, '.dmux-hooks', 'worktree_created');
    fs.writeFileSync(
      hookPath,
      [
        '#!/bin/sh',
        'echo "DMUX_STATUS: installing dependencies"',
        'echo "warming cache" >&2',
        'echo "done"',
      ].join('\n'),
      'utf-8'
    );
    fs.chmodSync(hookPath, 0o755);

    const events: HookProgressEvent[] = [];
    const result = await triggerHookWithProgress(
      'worktree_created',
      projectRoot,
      undefined,
      undefined,
      (event) => events.push(event)
    );

    expect(result.success).toBe(true);
    expect(events).toContainEqual({
      stream: 'stdout',
      line: 'DMUX_STATUS: installing dependencies',
    });
    expect(events).toContainEqual({ stream: 'stdout', line: 'done' });
    expect(events).toContainEqual({ stream: 'stderr', line: 'warming cache' });
  });

  it('does not arm a timeout when callers disable it', async () => {
    const projectRoot = makeTempProject();
    const hookPath = path.join(projectRoot, '.dmux-hooks', 'worktree_created');
    fs.writeFileSync(
      hookPath,
      [
        '#!/bin/sh',
        'echo "DMUX_STATUS: setup complete"',
      ].join('\n'),
      'utf-8'
    );
    fs.chmodSync(hookPath, 0o755);

    const setTimeoutSpy = vi.spyOn(global, 'setTimeout');
    const events: HookProgressEvent[] = [];
    try {
      const result = await triggerHookWithProgress(
        'worktree_created',
        projectRoot,
        undefined,
        undefined,
        (event) => events.push(event),
        0
      );

      expect(result.success).toBe(true);
      expect(setTimeoutSpy).not.toHaveBeenCalled();
      expect(events).toContainEqual({
        stream: 'stdout',
        line: 'DMUX_STATUS: setup complete',
      });
    } finally {
      setTimeoutSpy.mockRestore();
    }
  });

  it('still reports explicit hook failures', async () => {
    const projectRoot = makeTempProject();
    const hookPath = path.join(projectRoot, '.dmux-hooks', 'worktree_created');
    fs.writeFileSync(
      hookPath,
      [
        '#!/bin/sh',
        'echo "setup failed intentionally" >&2',
        'exit 42',
      ].join('\n'),
      'utf-8'
    );
    fs.chmodSync(hookPath, 0o755);

    const events: HookProgressEvent[] = [];
    const result = await triggerHookWithProgress(
      'worktree_created',
      projectRoot,
      undefined,
      undefined,
      (event) => events.push(event),
      0
    );

    expect(result.success).toBe(false);
    expect(result.error).toContain('setup failed intentionally');
    expect(events).toContainEqual({
      stream: 'stderr',
      line: 'setup failed intentionally',
    });
  });
});
