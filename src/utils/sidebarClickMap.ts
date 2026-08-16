import type {
  ProjectActionItem,
  ProjectActionLayout,
} from './projectActions.js';

/**
 * Maps a mouse click inside the sidebar (pane-relative row/col, 1-based) to
 * the selectable item index under the cursor.
 *
 * The line layout here must mirror PanesGrid's rendering exactly:
 * - one header line per project group
 * - one line per pane card
 * - one action row per group in multi-project mode (hidden while loading)
 * - one blank separator line between groups
 * - a single trailing action row in single-project mode (hidden while loading)
 */

export const SIDEBAR_ROW_WIDTH = 40;

export type SidebarLine =
  | { kind: 'header' }
  | { kind: 'blank' }
  | { kind: 'pane'; index: number }
  | { kind: 'actions'; actions: ProjectActionItem[]; isActiveGroup: boolean };

// Rendered label widths in PanesGrid.renderActionRow: "[n]ew agent"/"new agent",
// "[t]erminal"/"terminal", "[R]emove"/"remove", separated by two spaces.
const ACTION_LABEL_WIDTHS: Record<
  ProjectActionItem['kind'],
  { withHotkey: number; withoutHotkey: number }
> = {
  'new-agent': { withHotkey: 11, withoutHotkey: 9 },
  terminal: { withHotkey: 10, withoutHotkey: 8 },
  'remove-project': { withHotkey: 8, withoutHotkey: 6 },
};
const ACTION_SEPARATOR_WIDTH = 2;

function actionLabelWidth(action: ProjectActionItem, showHotkey: boolean): number {
  const widths = ACTION_LABEL_WIDTHS[action.kind];
  return showHotkey && action.hotkey ? widths.withHotkey : widths.withoutHotkey;
}

export function buildSidebarLines(
  layout: ProjectActionLayout,
  isLoading: boolean,
  activeProjectRoot: string | undefined
): SidebarLine[] {
  const lines: SidebarLine[] = [];

  const actionsByProject = new Map<string, ProjectActionItem[]>();
  for (const action of layout.actionItems) {
    const entry = actionsByProject.get(action.projectRoot) || [];
    entry.push(action);
    actionsByProject.set(action.projectRoot, entry);
  }
  const orderedGroupActions = (projectRoot: string): ProjectActionItem[] => {
    const entry = actionsByProject.get(projectRoot) || [];
    const byKind = (kind: ProjectActionItem['kind']) =>
      entry.find((action) => action.kind === kind);
    return [byKind('new-agent'), byKind('terminal'), byKind('remove-project')]
      .filter((action): action is ProjectActionItem => !!action);
  };

  layout.groups.forEach((group, groupIndex) => {
    lines.push({ kind: 'header' });

    for (const entry of group.panes) {
      lines.push({ kind: 'pane', index: entry.index });
    }

    if (!isLoading && layout.multiProjectMode) {
      const actions = orderedGroupActions(group.projectRoot);
      if (actions.length > 0) {
        lines.push({
          kind: 'actions',
          actions,
          isActiveGroup: activeProjectRoot === group.projectRoot,
        });
      }
    }

    if (groupIndex < layout.groups.length - 1) {
      lines.push({ kind: 'blank' });
    }
  });

  if (!isLoading && !layout.multiProjectMode) {
    const actions = layout.actionItems.filter(
      (item) => item.kind === 'new-agent' || item.kind === 'terminal'
    );
    if (actions.length > 0) {
      lines.push({ kind: 'actions', actions, isActiveGroup: true });
    }
  }

  return lines;
}

export function resolveSidebarClickIndex(
  layout: ProjectActionLayout,
  isLoading: boolean,
  activeProjectRoot: string | undefined,
  row: number,
  col: number
): number | null {
  const line = buildSidebarLines(layout, isLoading, activeProjectRoot)[row - 1];
  if (!line) {
    return null;
  }

  if (line.kind === 'pane') {
    return line.index;
  }

  if (line.kind !== 'actions') {
    return null;
  }

  // Action rows are right-aligned within the sidebar width; hit-test each
  // label's column extent, treating separators and padding as dead space.
  const widths = line.actions.map((action) =>
    actionLabelWidth(action, line.isActiveGroup)
  );
  const totalWidth =
    widths.reduce((sum, width) => sum + width, 0) +
    ACTION_SEPARATOR_WIDTH * (line.actions.length - 1);
  let startCol = SIDEBAR_ROW_WIDTH - totalWidth + 1;

  for (let i = 0; i < line.actions.length; i++) {
    if (col >= startCol && col < startCol + widths[i]) {
      return line.actions[i].index;
    }
    startCol += widths[i] + ACTION_SEPARATOR_WIDTH;
  }

  return null;
}
