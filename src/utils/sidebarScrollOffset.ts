import { execSync } from 'child_process';

/**
 * Ink occasionally pushes a line of its frame into tmux history during
 * re-renders (e.g. when the footer height changes), which shifts the whole
 * sidebar up while mouse coordinates stay viewport-relative. Tracking the
 * pane's history growth since the frame was first drawn gives the number of
 * rows the frame has drifted, so clicks can be mapped back to frame rows.
 */
export function getPaneHistorySize(paneId?: string): number {
  if (!process.env.TMUX) {
    return 0;
  }

  try {
    const target = paneId ? `-t '${paneId}' ` : '';
    const output = execSync(
      `tmux display-message -p ${target}'#{history_size}'`,
      { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'] }
    );
    const value = Number(output.trim());
    return Number.isFinite(value) && value > 0 ? value : 0;
  } catch {
    return 0;
  }
}
