import { spawn } from 'child_process';
import os from 'os';
import type { InferenceModel } from '../utils/inferenceProviders.js';

interface GrokCommandResult {
  stdout: string;
  stderr: string;
  exitCode: number | null;
}

export interface GrokBuildStatus {
  authenticated: boolean;
  models: InferenceModel[];
  defaultModel?: string;
}

function grokSubscriptionEnvironment(): NodeJS.ProcessEnv {
  // A Grok Build subscription must use the cached OAuth session, not silently
  // fall back to usage-billed xAI API access when both are configured.
  const { XAI_API_KEY: _xaiApiKey, ...environment } = process.env;
  return environment;
}

function runGrokCommand(
  args: string[],
  options: {
    timeoutMs: number;
    signal?: AbortSignal;
    onOutput?: (text: string) => void;
  }
): Promise<GrokCommandResult> {
  return new Promise((resolve, reject) => {
    const child = spawn('grok', args, {
      env: grokSubscriptionEnvironment(),
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    let settled = false;
    let timedOut = false;

    const append = (kind: 'stdout' | 'stderr', chunk: Buffer | string) => {
      const text = chunk.toString();
      if (kind === 'stdout') stdout = `${stdout}${text}`.slice(-100_000);
      else stderr = `${stderr}${text}`.slice(-100_000);
      options.onOutput?.(text);
    };
    child.stdout.on('data', (chunk) => append('stdout', chunk));
    child.stderr.on('data', (chunk) => append('stderr', chunk));

    const abort = () => {
      if (settled) return;
      child.kill('SIGTERM');
    };
    options.signal?.addEventListener('abort', abort, { once: true });
    const timeout = setTimeout(() => {
      timedOut = true;
      child.kill('SIGTERM');
    }, options.timeoutMs);

    child.once('error', (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      options.signal?.removeEventListener('abort', abort);
      reject(
        (error as NodeJS.ErrnoException).code === 'ENOENT'
          ? new Error('Grok Build CLI is not installed. Install it from https://x.ai/cli')
          : error
      );
    });
    child.once('close', (exitCode) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      options.signal?.removeEventListener('abort', abort);
      if (options.signal?.aborted) {
        reject(new Error('Grok Build request aborted'));
        return;
      }
      if (timedOut) {
        reject(new Error('Grok Build request timed out'));
        return;
      }
      resolve({ stdout, stderr, exitCode });
    });
  });
}

export function parseGrokModelsOutput(output: string): GrokBuildStatus {
  const defaultModel = output.match(/^Default model:\s*(\S+)/mi)?.[1];
  const models = output
    .split('\n')
    .map((line) => line.match(/^\s*[*-]\s+(\S+?)(?:\s+\(default\))?\s*$/i)?.[1])
    .filter((id): id is string => Boolean(id))
    .map((id) => ({ id, name: id }));
  if (defaultModel && !models.some((model) => model.id === defaultModel)) {
    models.unshift({ id: defaultModel, name: defaultModel });
  }
  return {
    authenticated: !/not authenticated/i.test(output),
    models,
    defaultModel,
  };
}

export async function getGrokBuildStatus(timeoutMs = 5_000): Promise<GrokBuildStatus> {
  const result = await runGrokCommand(['models'], { timeoutMs });
  const output = `${result.stdout}\n${result.stderr}`;
  if (result.exitCode !== 0 && !output.trim()) {
    throw new Error(`Grok Build model discovery exited with code ${result.exitCode ?? 'unknown'}`);
  }
  return parseGrokModelsOutput(output);
}

export async function loginToGrokBuild(
  onOutput?: (text: string) => void,
  signal?: AbortSignal
): Promise<void> {
  const result = await runGrokCommand(['login', '--oauth'], {
    timeoutMs: 5 * 60_000,
    signal,
    onOutput,
  });
  if (result.exitCode !== 0) {
    const detail = (result.stderr || result.stdout).trim();
    throw new Error(detail || `Grok Build login exited with code ${result.exitCode ?? 'unknown'}`);
  }
  const status = await getGrokBuildStatus();
  if (!status.authenticated) {
    throw new Error('Grok Build did not report an authenticated subscription session.');
  }
}

export async function listGrokBuildModels(): Promise<InferenceModel[]> {
  const status = await getGrokBuildStatus();
  if (!status.authenticated) {
    throw new Error('Grok Build is not signed in. Run `grok login` or sign in from dmux.');
  }
  return status.models;
}

export async function generateGrokBuildText(
  model: string,
  prompt: string,
  options: {
    system?: string;
    timeoutMs?: number;
    signal?: AbortSignal;
    outputSchema?: Record<string, unknown>;
  } = {}
): Promise<string> {
  const args = [
    '--no-auto-update',
    '--cwd', os.tmpdir(),
    '--model', model,
    '--output-format', 'json',
    '--max-turns', '1',
    '--no-memory',
    '--no-subagents',
    '--disable-web-search',
    '--tools', '',
    '--verbatim',
    '--system-prompt-override',
    options.system || 'You are a text inference service. Never use tools. Return only the requested answer.',
    ...(options.outputSchema ? ['--json-schema', JSON.stringify(options.outputSchema)] : []),
    '--single', prompt,
  ];
  const result = await runGrokCommand(args, {
    timeoutMs: options.timeoutMs ?? 20_000,
    signal: options.signal,
  });
  if (result.exitCode !== 0) {
    const detail = (result.stderr || result.stdout).trim();
    throw new Error(detail || `Grok Build inference exited with code ${result.exitCode ?? 'unknown'}`);
  }
  let data: any;
  try {
    data = JSON.parse(result.stdout);
  } catch {
    throw new Error('Grok Build returned invalid JSON output');
  }
  const text = typeof data?.text === 'string' ? data.text.trim() : '';
  if (!text) throw new Error('Grok Build returned an empty response');
  return text;
}
