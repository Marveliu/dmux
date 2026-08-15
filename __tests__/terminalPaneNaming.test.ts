import { describe, expect, it, vi } from 'vitest';
import type { DmuxPane } from '../src/types.js';
import {
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
      canGenerateName: () => true,
      setPaneTitle: async () => {},
    });

    await service.checkNow(1_000);
    await service.checkNow(1_000 + TERMINAL_NAME_SETTLE_MS);

    expect(generateName).not.toHaveBeenCalled();
    expect(isHumanNamedTerminalPane(panes[0])).toBe(true);
  });

  it('discards a generated name when terminal output changes during the request', async () => {
    let content = '$ pnpm test\n42 tests passed in 3.2s\n$ ';
    const panes = [shellPane()];
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
      canGenerateName: () => true,
      setPaneTitle: async () => {},
    });

    await service.checkNow(1_000);
    const pendingCheck = service.checkNow(1_000 + TERMINAL_NAME_SETTLE_MS);
    await vi.waitFor(() => expect(generateName).toHaveBeenCalledOnce());
    content = '$ pnpm build\ncreated a new release bundle\n$ ';
    resolveName('Run Unit Tests');
    await pendingCheck;

    expect(savePanes).not.toHaveBeenCalled();
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
      canGenerateName: () => true,
      setPaneTitle: async () => {},
    });

    await service.checkNow(1_000);
    await service.checkNow(1_000 + TERMINAL_NAME_SETTLE_MS);

    expect(savePanes).not.toHaveBeenCalled();
    expect(panes[0].displayName).toBe('Run Unit Tests');
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
