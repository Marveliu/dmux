import { describe, expect, it } from 'vitest';
import type { DmuxPane, SidebarProject } from '../src/types.js';
import {
  buildProjectActionLayout,
  buildVisualNavigationRows,
  resolveSelectionAfterPaneClose,
} from '../src/utils/projectActions.js';

function pane(id: string, slug: string, projectRoot: string): DmuxPane {
  return {
    id,
    slug,
    prompt: `prompt-${slug}`,
    paneId: `%${id.replace('dmux-', '')}`,
    projectRoot,
  };
}

describe('projectActions', () => {
  it('adds remove-project only for empty non-root sidebar projects', () => {
    const panes: DmuxPane[] = [
      pane('dmux-1', 'main-pane', '/repo-main'),
      pane('dmux-2', 'aux-pane', '/repo-aux'),
    ];
    const sidebarProjects: SidebarProject[] = [
      { projectRoot: '/repo-main', projectName: 'repo-main' },
      { projectRoot: '/repo-empty', projectName: 'repo-empty' },
      { projectRoot: '/repo-aux', projectName: 'repo-aux' },
    ];

    const layout = buildProjectActionLayout(
      panes,
      sidebarProjects,
      '/repo-main',
      'repo-main'
    );

    expect(layout.multiProjectMode).toBe(true);
    expect(
      layout.actionItems
        .filter((action) => action.kind === 'remove-project')
        .map((action) => action.projectRoot)
    ).toEqual(['/repo-empty']);
  });

  it('adds action rows to navigation for empty projects', () => {
    const layout = buildProjectActionLayout(
      [],
      [
        { projectRoot: '/repo-main', projectName: 'repo-main' },
        { projectRoot: '/repo-empty', projectName: 'repo-empty' },
      ],
      '/repo-main',
      'repo-main'
    );

    expect(buildVisualNavigationRows(layout)).toEqual([
      [0, 1],
      [2, 3, 4],
    ]);
  });

  it('selects the next pane down in the same project after closing a pane', () => {
    const panes: DmuxPane[] = [
      pane('dmux-1', 'main-pane', '/repo-main'),
      pane('dmux-2', 'aux-one', '/repo-aux'),
      pane('dmux-3', 'aux-two', '/repo-aux'),
      pane('dmux-4', 'main-two', '/repo-main'),
    ];
    const sidebarProjects: SidebarProject[] = [
      { projectRoot: '/repo-main', projectName: 'repo-main' },
      { projectRoot: '/repo-aux', projectName: 'repo-aux' },
    ];

    const selection = resolveSelectionAfterPaneClose(
      panes,
      '%2',
      sidebarProjects,
      '/repo-main',
      'repo-main'
    );

    expect(selection?.selectedIndex).toBe(1);
    expect(selection?.pane?.slug).toBe('aux-two');
  });

  it('selects the project new-agent action when closing the last pane in that project', () => {
    const panes: DmuxPane[] = [
      pane('dmux-1', 'main-pane', '/repo-main'),
      pane('dmux-2', 'aux-one', '/repo-aux'),
    ];
    const sidebarProjects: SidebarProject[] = [
      { projectRoot: '/repo-main', projectName: 'repo-main' },
      { projectRoot: '/repo-aux', projectName: 'repo-aux' },
    ];

    const selection = resolveSelectionAfterPaneClose(
      panes,
      '%2',
      sidebarProjects,
      '/repo-main',
      'repo-main'
    );

    expect(selection?.pane).toBeUndefined();
    expect(selection?.action?.kind).toBe('new-agent');
    expect(selection?.action?.projectRoot).toBe('/repo-aux');
    expect(selection?.selectedIndex).toBe(3);
  });
});
