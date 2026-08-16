import { spawnSync } from 'child_process';

function formatTmuxError(action: string, result: ReturnType<typeof spawnSync>): string {
  if (result.error) {
    return `Failed to ${action}: ${result.error.message}`;
  }

  const stderr = typeof result.stderr === 'string'
    ? result.stderr.trim()
    : result.stderr?.toString().trim();
  const detail = stderr ? `: ${stderr}` : '';
  return `Failed to ${action}${detail}`;
}

export function startDetachedTmuxSession(options: {
  sessionName: string;
  startDirectory: string;
  command: string;
}): void {
  const result = spawnSync(
    'tmux',
    [
      'new-session',
      '-d',
      '-s',
      options.sessionName,
      '-c',
      options.startDirectory,
      options.command,
    ],
    {
      encoding: 'utf-8',
      stdio: 'pipe',
    }
  );

  if (result.status !== 0) {
    throw new Error(formatTmuxError(`start tmux session ${options.sessionName}`, result));
  }
}

export function attachTmuxSession(sessionName: string): void {
  const result = spawnSync(
    'tmux',
    ['attach-session', '-t', sessionName],
    { stdio: 'inherit' }
  );

  if (result.status !== 0) {
    throw new Error(`Failed to attach tmux session ${sessionName}`);
  }
}
