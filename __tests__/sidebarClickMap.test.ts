import { describe, expect, it } from 'vitest';
import type { DmuxPane, SidebarProject } from '../src/types.js';
import { buildProjectActionLayout } from '../src/utils/projectActions.js';
import {
  buildSidebarLines,
  resolveSidebarClickIndex,
} from '../src/utils/sidebarClickMap.js';

function pane(id: string, slug: string, projectRoot: string): DmuxPane {
  return {
    id,
    slug,
    prompt: `prompt-${slug}`,
    paneId: `%${id.replace('dmux-', '')}`,
    projectRoot,
  };
}

describe('sidebarClickMap', () => {
  describe('single-project mode', () => {
    const layout = buildProjectActionLayout(
      [
        pane('dmux-1', 'pane-one', '/repo-main'),
        pane('dmux-2', 'pane-two', '/repo-main'),
      ],
      [{ projectRoot: '/repo-main', projectName: 'repo-main' }],
      '/repo-main',
      'repo-main'
    );

    it('mirrors the rendered line order: header, panes, action row', () => {
      expect(buildSidebarLines(layout, false, '/repo-main')).toEqual([
        { kind: 'header' },
        { kind: 'pane', index: 0 },
        { kind: 'pane', index: 1 },
        {
          kind: 'actions',
          actions: layout.actionItems,
          isActiveGroup: true,
        },
      ]);
    });

    it('maps clicks on pane rows to pane indices regardless of column', () => {
      expect(resolveSidebarClickIndex(layout, false, '/repo-main', 2, 1)).toBe(0);
      expect(resolveSidebarClickIndex(layout, false, '/repo-main', 3, 39)).toBe(1);
    });

    it('returns null for header, out-of-range rows, and dead space', () => {
      expect(resolveSidebarClickIndex(layout, false, '/repo-main', 1, 5)).toBeNull();
      expect(resolveSidebarClickIndex(layout, false, '/repo-main', 99, 5)).toBeNull();
      // Left padding of the right-aligned action row is dead space.
      expect(resolveSidebarClickIndex(layout, false, '/repo-main', 4, 2)).toBeNull();
    });

    it('hit-tests action buttons by column', () => {
      // Row: "[n]ew agent  [t]erminal" right-aligned in 40 cols.
      // new-agent (11) + 2 + terminal (10) = 23 → starts at col 18.
      expect(resolveSidebarClickIndex(layout, false, '/repo-main', 4, 18)).toBe(2);
      expect(resolveSidebarClickIndex(layout, false, '/repo-main', 4, 28)).toBe(2);
      expect(resolveSidebarClickIndex(layout, false, '/repo-main', 4, 29)).toBeNull(); // separator
      expect(resolveSidebarClickIndex(layout, false, '/repo-main', 4, 31)).toBe(3);
      expect(resolveSidebarClickIndex(layout, false, '/repo-main', 4, 40)).toBe(3);
    });

    it('hides the action row while loading', () => {
      expect(buildSidebarLines(layout, true, '/repo-main')).toEqual([
        { kind: 'header' },
        { kind: 'pane', index: 0 },
        { kind: 'pane', index: 1 },
      ]);
      expect(resolveSidebarClickIndex(layout, true, '/repo-main', 4, 30)).toBeNull();
    });
  });

  describe('multi-project mode', () => {
    const sidebarProjects: SidebarProject[] = [
      { projectRoot: '/repo-main', projectName: 'repo-main' },
      { projectRoot: '/repo-empty', projectName: 'repo-empty' },
    ];
    const layout = buildProjectActionLayout(
      [pane('dmux-1', 'main-pane', '/repo-main')],
      sidebarProjects,
      '/repo-main',
      'repo-main'
    );

    it('includes per-group action rows and blank separators', () => {
      // Layout: header, pane 0, actions(main), blank, header, actions(empty w/ remove)
      const lines = buildSidebarLines(layout, false, '/repo-main');
      expect(lines.map((line) => line.kind)).toEqual([
        'header',
        'pane',
        'actions',
        'blank',
        'header',
        'actions',
      ]);
    });

    it('maps pane and per-group action clicks', () => {
      expect(resolveSidebarClickIndex(layout, false, '/repo-main', 2, 10)).toBe(0);

      // Active group (repo-main) shows hotkeys: new-agent(11) + 2 + terminal(10) = 23.
      expect(resolveSidebarClickIndex(layout, false, '/repo-main', 3, 20)).toBe(1);
      expect(resolveSidebarClickIndex(layout, false, '/repo-main', 3, 35)).toBe(2);

      // Blank separator and second header are dead space.
      expect(resolveSidebarClickIndex(layout, false, '/repo-main', 4, 10)).toBeNull();
      expect(resolveSidebarClickIndex(layout, false, '/repo-main', 5, 10)).toBeNull();

      // Inactive group hides hotkeys: new agent(9) + 2 + terminal(8) + 2 + remove(6) = 27 → starts col 14.
      expect(resolveSidebarClickIndex(layout, false, '/repo-main', 6, 14)).toBe(3);
      expect(resolveSidebarClickIndex(layout, false, '/repo-main', 6, 26)).toBe(4);
      expect(resolveSidebarClickIndex(layout, false, '/repo-main', 6, 36)).toBe(5);
    });

    it('widens the clicked group buttons when that group is active', () => {
      // With repo-empty active, its action row shows hotkeys:
      // new-agent(11) + 2 + terminal(10) + 2 + remove(8) = 33 → starts col 8.
      expect(resolveSidebarClickIndex(layout, false, '/repo-empty', 6, 8)).toBe(3);
      expect(resolveSidebarClickIndex(layout, false, '/repo-empty', 6, 40)).toBe(5);
    });
  });
});
