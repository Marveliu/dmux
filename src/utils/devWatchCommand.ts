/**
 * Build a shell-safe command for restarting dmux dev watch from a source path.
 * For respawned tmux panes, we append an interactive shell so the pane stays open
 * after dmux exits intentionally.
 */

import { sanitizePathForInstalledDmux } from './pathEnvironment.js';

const escapeForDoubleQuotedShell = (value: string): string =>
  value.replace(/([\\$"`])/g, "\\$1");

const shellQuote = (value: string): string =>
  `'${value.replace(/'/g, `'\\''`)}'`;

export function buildDevWatchCommand(sourcePath: string): string {
  const escapedPath = escapeForDoubleQuotedShell(sourcePath);
  const cleanPath = sanitizePathForInstalledDmux(process.env.PATH || '', sourcePath);
  return `cd "${escapedPath}" && env PATH=${shellQuote(cleanPath)} pnpm dev:watch`;
}

export function buildDevWatchRespawnCommand(sourcePath: string): string {
  const cleanPath = sanitizePathForInstalledDmux(process.env.PATH || '', sourcePath);
  return `${buildDevWatchCommand(sourcePath)}; exec env PATH=${shellQuote(cleanPath)} "\${SHELL:-/bin/zsh}" -l`;
}
