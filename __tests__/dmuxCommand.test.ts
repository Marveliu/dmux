import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  buildDmuxCommand,
  buildFilesOnlyCommand,
} from '../src/utils/dmuxCommand.js';
import { sanitizePathForInstalledDmux } from '../src/utils/pathEnvironment.js';

let tempDir: string | null = null;

afterEach(() => {
  if (tempDir) {
    fs.rmSync(tempDir, { recursive: true, force: true });
    tempDir = null;
  }
});

function makeExecutable(filePath: string): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, '#!/bin/sh\nexit 0\n');
  fs.chmodSync(filePath, 0o755);
}

describe('dmux command resolution', () => {
  it('uses an installed dmux executable instead of local worktree package shims', () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dmux-command-'));
    const projectRoot = path.join(tempDir, 'repo');
    const installedBin = path.join(tempDir, 'installed-bin');
    const worktreeBin = path.join(projectRoot, '.dmux', 'worktrees', 'feature', 'node_modules', '.bin');
    const rootBin = path.join(projectRoot, 'node_modules', '.bin');

    makeExecutable(path.join(worktreeBin, 'dmux'));
    makeExecutable(path.join(rootBin, 'dmux'));
    makeExecutable(path.join(installedBin, 'dmux'));

    const originalPath = process.env.PATH;
    process.env.PATH = [worktreeBin, rootBin, installedBin].join(path.delimiter);

    try {
      expect(buildDmuxCommand([], projectRoot)).toBe(
        `env PATH='${installedBin}' '${path.join(installedBin, 'dmux')}'`
      );
      expect(buildFilesOnlyCommand(projectRoot)).toBe(
        `env PATH='${installedBin}' '${path.join(installedBin, 'dmux')}' --files-only`
      );
      expect(sanitizePathForInstalledDmux(process.env.PATH, projectRoot)).toBe(installedBin);
    } finally {
      process.env.PATH = originalPath;
    }
  });
});
