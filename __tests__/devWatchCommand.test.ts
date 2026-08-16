import { afterEach, describe, expect, it } from 'vitest';
import {
  buildDevWatchCommand,
  buildDevWatchRespawnCommand,
} from '../src/utils/devWatchCommand.js';

const originalPath = process.env.PATH;

afterEach(() => {
  process.env.PATH = originalPath;
});

describe('dev watch command', () => {
  it('uses env instead of shell assignment for PATH', () => {
    process.env.PATH = '/usr/local/bin:/repo/node_modules/.bin';

    expect(buildDevWatchCommand('/repo')).toBe(
      'cd "/repo" && env PATH=\'/usr/local/bin\' pnpm dev:watch'
    );
  });

  it('respawns into a login shell with the sanitized PATH', () => {
    process.env.PATH = '/usr/local/bin:/repo/node_modules/.bin';

    expect(buildDevWatchRespawnCommand('/repo')).toBe(
      'cd "/repo" && env PATH=\'/usr/local/bin\' pnpm dev:watch; exec env PATH=\'/usr/local/bin\' "${SHELL:-/bin/zsh}" -l'
    );
  });
});
