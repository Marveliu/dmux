import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { resolveShellConfigPath } from './openRouterApiKeySetup.js';

function quoteForPosix(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function quoteForFish(value: string): string {
  return `"${value
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/\$/g, '\\$')
    .replace(/`/g, '\\`')}"`;
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function buildEnvironmentExportLine(
  envKey: string,
  value: string,
  shellPath?: string
): string {
  if (path.basename(shellPath || '').toLowerCase().includes('fish')) {
    return `set -gx ${envKey} ${quoteForFish(value.trim())}`;
  }
  return `export ${envKey}=${quoteForPosix(value.trim())}`;
}

export function upsertEnvironmentKeyBlock(
  existingContent: string,
  envKey: string,
  exportLine: string
): string {
  const normalized = existingContent.replace(/\r\n/g, '\n');
  const start = `# >>> dmux inference ${envKey} >>>`;
  const end = `# <<< dmux inference ${envKey} <<<`;
  const block = `${start}\n${exportLine}\n${end}`;
  const pattern = new RegExp(`${escapeRegex(start)}[\\s\\S]*?${escapeRegex(end)}\\n?`, 'm');

  if (pattern.test(normalized)) {
    const replaced = normalized.replace(pattern, `${block}\n`);
    return replaced.endsWith('\n') ? replaced : `${replaced}\n`;
  }
  const prefix = normalized
    ? `${normalized.endsWith('\n') ? normalized : `${normalized}\n`}\n`
    : '';
  return `${prefix}${block}\n`;
}

export async function persistEnvironmentKeyToShell(
  envKey: string,
  value: string,
  options?: { shellPath?: string; homeDir?: string }
): Promise<{ shellConfigPath: string; exportLine: string }> {
  const homeDir = options?.homeDir || process.env.HOME || os.homedir();
  if (!homeDir) throw new Error('Unable to determine HOME directory');
  const shellPath = options?.shellPath || process.env.SHELL;
  const shellConfigPath = await resolveShellConfigPath(shellPath, homeDir);
  let existingContent = '';
  try {
    existingContent = await fs.readFile(shellConfigPath, 'utf-8');
  } catch {
    // The selected shell startup file does not exist yet.
  }

  const exportLine = buildEnvironmentExportLine(envKey, value, shellPath);
  const updated = upsertEnvironmentKeyBlock(existingContent, envKey, exportLine);
  await fs.mkdir(path.dirname(shellConfigPath), { recursive: true });
  await fs.writeFile(shellConfigPath, updated, 'utf-8');
  return { shellConfigPath, exportLine };
}
