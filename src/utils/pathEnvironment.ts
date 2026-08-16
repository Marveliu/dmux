import fs from 'fs';
import path from 'path';

function normalizeEntry(entry: string): string {
  return entry === '' ? entry : path.resolve(entry);
}

function isWithin(parentPath: string, childPath: string): boolean {
  const relative = path.relative(parentPath, childPath);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function isLocalNodeModulesBin(entry: string, projectRoot?: string): boolean {
  const normalized = normalizeEntry(entry);
  const nodeModulesBin = `${path.sep}node_modules${path.sep}.bin`;

  if (entry === './node_modules/.bin' || entry === 'node_modules/.bin') {
    return true;
  }

  if (!normalized.endsWith(nodeModulesBin)) {
    return false;
  }

  if (normalized.includes(`${path.sep}.dmux${path.sep}worktrees${path.sep}`)) {
    return true;
  }

  return Boolean(projectRoot && isWithin(path.resolve(projectRoot), normalized));
}

function isLocalDmuxCandidate(candidatePath: string, projectRoot?: string): boolean {
  const normalized = normalizeEntry(candidatePath);

  if (candidatePath.includes(`${path.sep}node_modules${path.sep}.bin${path.sep}dmux`)) {
    return true;
  }

  return Boolean(projectRoot && isWithin(path.resolve(projectRoot), normalized));
}

export function sanitizePathForInstalledDmux(
  rawPath: string = process.env.PATH || '',
  projectRoot?: string
): string {
  return rawPath
    .split(path.delimiter)
    .filter((entry) => entry && !isLocalNodeModulesBin(entry, projectRoot))
    .join(path.delimiter);
}

export function resolveInstalledDmuxExecutable(options: {
  projectRoot?: string;
  pathValue?: string;
} = {}): string {
  const pathValue = sanitizePathForInstalledDmux(
    options.pathValue || process.env.PATH || '',
    options.projectRoot
  );
  const seen = new Set<string>();

  for (const entry of pathValue.split(path.delimiter)) {
    if (!entry) continue;

    const candidate = path.join(entry, 'dmux');
    if (seen.has(candidate)) continue;
    seen.add(candidate);

    if (isLocalDmuxCandidate(candidate, options.projectRoot)) continue;

    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      return candidate;
    } catch {
      // Keep looking for the installed executable.
    }
  }

  return 'dmux';
}

