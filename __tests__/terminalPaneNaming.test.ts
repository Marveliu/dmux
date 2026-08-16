import { describe, expect, it, vi } from 'vitest';
import type { DmuxPane } from '../src/types.js';
import {
  TERMINAL_NAME_CAPTURE_INTERVAL_MS,
  TERMINAL_NAME_FAST_SETTLE_MS,
  TERMINAL_NAME_NAMED_CHECK_INTERVAL_MS,
  TERMINAL_NAME_SETTLE_MS,
  TERMINAL_RENAME_COOLDOWN_MS,
  TerminalPaneNamingService,
  hasMeaningfulTerminalWork,
  isHumanNamedTerminalPane,
  isLowInformationTerminalName,
  sanitizeGeneratedTerminalName,
} from '../src/services/TerminalPaneNamingService.js';

function shellPane(overrides: Partial<DmuxPane> = {}): DmuxPane {
  return {
    id: 'dmux-1',
    slug: 'shell-1',
    prompt: '',
    paneId: '%1',
    type: 'shell',
    shellType: 'zsh',
    shellCwd: '/repo',
    ...overrides,
  };
}

describe('terminal pane auto-naming', () => {
  it('names a terminal after meaningful output settles', async () => {
    let panes = [shellPane()];
    const savePanes = vi.fn(async (updated: DmuxPane[]) => {
      panes = updated;
    });
    const generateName = vi.fn(async () => 'Run Unit Tests');
    const setPaneTitle = vi.fn(async () => {});
    const service = new TerminalPaneNamingService({
      getPanes: () => panes,
      savePanes,
      capturePane: async () => '$ pnpm test\n42 tests passed in 3.2s\n$ ',
      generateName,
      probePaneActivity: async () => null,
      canGenerateName: () => true,
      setPaneTitle,
    });

    await service.checkNow(1_000);
    expect(generateName).not.toHaveBeenCalled();

    await service.checkNow(1_000 + TERMINAL_NAME_SETTLE_MS);

    expect(generateName).toHaveBeenCalledOnce();
    expect(panes[0]).toMatchObject({
      displayName: 'Run Unit Tests',
      displayNameSource: 'auto',
      lastAutoNamedAt: 1_000 + TERMINAL_NAME_SETTLE_MS,
    });
    expect(setPaneTitle).toHaveBeenCalledWith(
      '%1',
      'Run Unit Tests__dmux__shell-1'
    );
  });

  it('never replaces a human-designated name, including legacy names', async () => {
    const generateName = vi.fn(async () => 'Generated Name');
    const panes = [shellPane({ displayName: 'My Logs' })];
    const service = new TerminalPaneNamingService({
      getPanes: () => panes,
      savePanes: async () => {},
      capturePane: async () => '$ tail app.log\nserver started successfully\n$ ',
      generateName,
      probePaneActivity: async () => null,
      canGenerateName: () => true,
      setPaneTitle: async () => {},
    });

    await service.checkNow(1_000);
    await service.checkNow(1_000 + TERMINAL_NAME_SETTLE_MS);

    expect(generateName).not.toHaveBeenCalled();
    expect(isHumanNamedTerminalPane(panes[0])).toBe(true);
  });

  it('names a brand-new terminal quickly even while output is still streaming', async () => {
    let tick = 0;
    let panes = [shellPane()];
    const generateName = vi.fn(async () => 'Refactor Auth Middleware');
    const service = new TerminalPaneNamingService({
      getPanes: () => panes,
      savePanes: async (updated) => { panes = updated; },
      capturePane: async () =>
        `⏺ Refactoring auth middleware\nEditing src/auth.ts line ${tick}\n(esc to interrupt)`,
      generateName,
      probePaneActivity: async () => null,
      canGenerateName: () => true,
      setPaneTitle: async () => {},
    });

    // The agent redraws its screen between every capture, so the content
    // never settles — the first title must not wait for stability.
    for (tick = 0; tick * TERMINAL_NAME_CAPTURE_INTERVAL_MS <= TERMINAL_NAME_FAST_SETTLE_MS; tick++) {
      await service.checkNow(1_000 + tick * TERMINAL_NAME_CAPTURE_INTERVAL_MS);
    }

    expect(generateName).toHaveBeenCalledOnce();
    expect(panes[0]).toMatchObject({
      displayName: 'Refactor Auth Middleware',
      displayNameSource: 'auto',
    });
  });

  it('keeps the first generated title when an untitled pane changes mid-request', async () => {
    let content = '⏺ Running tests\n42 tests passed in 3.2s\n(esc to interrupt)';
    let panes = [shellPane()];
    const savePanes = vi.fn(async (updated: DmuxPane[]) => { panes = updated; });
    let resolveName!: (name: string) => void;
    const generateName = vi.fn(() => new Promise<string>((resolve) => {
      resolveName = resolve;
    }));
    const service = new TerminalPaneNamingService({
      getPanes: () => panes,
      savePanes,
      capturePane: async () => content,
      generateName,
      probePaneActivity: async () => null,
      canGenerateName: () => true,
      setPaneTitle: async () => {},
    });

    await service.checkNow(1_000);
    const pendingCheck = service.checkNow(1_000 + TERMINAL_NAME_FAST_SETTLE_MS);
    await vi.waitFor(() => expect(generateName).toHaveBeenCalledOnce());
    content = '⏺ Running tests\nnow checking types\n(esc to interrupt)';
    resolveName('Run Unit Tests');
    await pendingCheck;

    expect(panes[0]).toMatchObject({
      displayName: 'Run Unit Tests',
      displayNameSource: 'auto',
    });
  });

  it('discards a stale name when a titled terminal changes during the request', async () => {
    let content = '$ pnpm test\n42 tests passed in 3.2s\n$ ';
    const panes = [shellPane({
      displayName: 'Run Unit Tests',
      displayNameSource: 'auto',
    })];
    const savePanes = vi.fn(async () => {});
    let resolveName!: (name: string) => void;
    const generateName = vi.fn(() => new Promise<string>((resolve) => {
      resolveName = resolve;
    }));
    const service = new TerminalPaneNamingService({
      getPanes: () => panes,
      savePanes,
      capturePane: async () => content,
      generateName,
      probePaneActivity: async () => null,
      canGenerateName: () => true,
      setPaneTitle: async () => {},
    });

    await service.checkNow(1_000);
    const pendingCheck = service.checkNow(1_000 + TERMINAL_NAME_SETTLE_MS);
    await vi.waitFor(() => expect(generateName).toHaveBeenCalledOnce());
    content = '$ pnpm build\ncreated a new release bundle\n$ ';
    resolveName('Build Release Bundle');
    await pendingCheck;

    expect(savePanes).not.toHaveBeenCalled();
  });

  it('relaxes the capture cadence once a pane has a title', async () => {
    const capturePane = vi.fn(async () => '$ pnpm test\n42 tests passed in 3.2s\n$ ');
    const service = new TerminalPaneNamingService({
      getPanes: () => [shellPane({
        displayName: 'Run Unit Tests',
        displayNameSource: 'auto',
      })],
      savePanes: async () => {},
      capturePane,
      generateName: async () => null,
      probePaneActivity: async () => null,
      canGenerateName: () => true,
      setPaneTitle: async () => {},
    });

    await service.checkNow(1_000);
    await service.checkNow(1_000 + TERMINAL_NAME_CAPTURE_INTERVAL_MS);
    expect(capturePane).toHaveBeenCalledOnce();

    await service.checkNow(1_000 + TERMINAL_NAME_NAMED_CHECK_INTERVAL_MS);
    expect(capturePane).toHaveBeenCalledTimes(2);
  });

  it('renames an automatically named terminal again only after new work and the cooldown', async () => {
    let content = '$ pnpm test\n42 tests passed in 3.2s\n$ ';
    let panes = [shellPane()];
    const generateName = vi
      .fn<() => Promise<string | null>>()
      .mockResolvedValueOnce('Run Unit Tests')
      .mockResolvedValueOnce('Build Release Bundle');
    const service = new TerminalPaneNamingService({
      getPanes: () => panes,
      savePanes: async (updated) => { panes = updated; },
      capturePane: async () => content,
      generateName,
      probePaneActivity: async () => null,
      canGenerateName: () => true,
      setPaneTitle: async () => {},
    });

    const firstNamedAt = 1_000 + TERMINAL_NAME_SETTLE_MS;
    await service.checkNow(1_000);
    await service.checkNow(firstNamedAt);
    content = '$ pnpm build\ncreated dist/index.js successfully\n$ ';
    await service.checkNow(firstNamedAt + 1_000);
    await service.checkNow(firstNamedAt + TERMINAL_NAME_SETTLE_MS + 1_000);
    expect(generateName).toHaveBeenCalledTimes(1);

    await service.checkNow(firstNamedAt + TERMINAL_RENAME_COOLDOWN_MS);
    expect(generateName).toHaveBeenCalledTimes(2);
    expect(panes[0].displayName).toBe('Build Release Bundle');
    expect(generateName.mock.calls[1]?.[0]).toContain('pnpm test');
    expect(generateName.mock.calls[1]?.[0]).toContain('pnpm build');
  });

  it('never replaces a useful title with a generic activity state', async () => {
    let panes = [shellPane({
      displayName: 'Run Unit Tests',
      displayNameSource: 'auto',
    })];
    const savePanes = vi.fn(async (updated: DmuxPane[]) => { panes = updated; });
    const service = new TerminalPaneNamingService({
      getPanes: () => panes,
      savePanes,
      capturePane: async () => '$ pnpm test\n42 tests passed in 3.2s\n$ ',
      generateName: async () => 'Idle In Dmux Project',
      probePaneActivity: async () => null,
      canGenerateName: () => true,
      setPaneTitle: async () => {},
    });

    await service.checkNow(1_000);
    await service.checkNow(1_000 + TERMINAL_NAME_SETTLE_MS);

    expect(savePanes).not.toHaveBeenCalled();
    expect(panes[0].displayName).toBe('Run Unit Tests');
  });

  it('captures only when the activity probe reports new output', async () => {
    const signature = 'hist:100';
    let panes = [shellPane()];
    const capturePane = vi.fn(async () => '$ pnpm test\n42 tests passed in 3.2s\n$ ');
    const generateName = vi.fn(async () => 'Run Unit Tests');
    const service = new TerminalPaneNamingService({
      getPanes: () => panes,
      savePanes: async (updated) => { panes = updated; },
      capturePane,
      probePaneActivity: async () => new Map([
        ['%1', { signature, alternateScreen: false }],
      ]),
      generateName,
      canGenerateName: () => true,
      setPaneTitle: async () => {},
    });

    await service.checkNow(1_000);
    expect(capturePane).toHaveBeenCalledOnce();

    // No counter movement: the tick reuses the previous capture...
    await service.checkNow(1_000 + TERMINAL_NAME_CAPTURE_INTERVAL_MS);
    expect(capturePane).toHaveBeenCalledOnce();

    // ...and naming still proceeds from the cached content once due. The only
    // extra capture is the staleness re-check made when applying the name.
    await service.checkNow(1_000 + TERMINAL_NAME_FAST_SETTLE_MS);
    expect(generateName).toHaveBeenCalledOnce();
    expect(panes[0].displayName).toBe('Run Unit Tests');
    expect(capturePane).toHaveBeenCalledTimes(2);
  });

  it('always recaptures full-screen apps whose counters cannot be trusted', async () => {
    let frame = 0;
    const capturePane = vi.fn(async () =>
      `Codex TUI frame\nstreaming tokens ${frame}\nesc to interrupt`);
    const service = new TerminalPaneNamingService({
      getPanes: () => [shellPane()],
      savePanes: async () => {},
      capturePane,
      probePaneActivity: async () => new Map([
        ['%1', { signature: 'frozen', alternateScreen: true }],
      ]),
      generateName: async () => null,
      canGenerateName: () => true,
      setPaneTitle: async () => {},
    });

    await service.checkNow(1_000);
    frame++;
    await service.checkNow(1_000 + TERMINAL_NAME_CAPTURE_INTERVAL_MS);
    expect(capturePane).toHaveBeenCalledTimes(2);
  });

  it('waits for new content before retrying a rejected name', async () => {
    let content = '$ ls\ndocs src package.json readme and more files\n$ ';
    let panes = [shellPane()];
    const generateName = vi.fn(async () => 'Working In Terminal');
    const service = new TerminalPaneNamingService({
      getPanes: () => panes,
      savePanes: async (updated) => { panes = updated; },
      capturePane: async () => content,
      probePaneActivity: async () => null,
      generateName,
      canGenerateName: () => true,
      setPaneTitle: async () => {},
    });

    await service.checkNow(1_000);
    await service.checkNow(1_000 + TERMINAL_NAME_FAST_SETTLE_MS);
    expect(generateName).toHaveBeenCalledOnce();

    // Same content, well past the retry backoff: still no new model call.
    await service.checkNow(1_000 + TERMINAL_NAME_FAST_SETTLE_MS + 60_000);
    expect(generateName).toHaveBeenCalledOnce();

    // New output invalidates the rejection and retries promptly.
    content = '$ pnpm run migrate\napplied 12 database migrations\n$ ';
    await service.checkNow(1_000 + TERMINAL_NAME_FAST_SETTLE_MS + 61_000);
    expect(generateName).toHaveBeenCalledTimes(2);
  });

  it('sanitizes model output and ignores prompt-only captures', () => {
    expect(sanitizeGeneratedTerminalName('```text\nBuild Release Bundle\n```')).toBe(
      'Build Release Bundle'
    );
    expect(sanitizeGeneratedTerminalName('Idle In Dmux Project')).toBeNull();
    expect(isLowInformationTerminalName('Waiting in Terminal')).toBe(true);
    expect(isLowInformationTerminalName('Waiting for Database Migration')).toBe(false);
    expect(hasMeaningfulTerminalWork('user@host:/repo$\n$')).toBe(false);
    expect(hasMeaningfulTerminalWork('$ pnpm test\n42 tests passed in 3.2s\n$')).toBe(true);
  });
});
