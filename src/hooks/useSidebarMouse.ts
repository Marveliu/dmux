import { useEffect, useRef } from 'react';
import type { ProjectActionLayout } from '../utils/projectActions.js';
import { resolveSidebarClickIndex } from '../utils/sidebarClickMap.js';
import {
  MOUSE_LEFT_BUTTON,
  MOUSE_WHEEL_UP_BUTTON,
  MOUSE_WHEEL_DOWN_BUTTON,
  createDoubleClickTracker,
  type SidebarMouseEvent,
  type SidebarMouseEventSource,
} from '../utils/sidebarMouse.js';

interface UseSidebarMouseOptions {
  mouseEvents?: SidebarMouseEventSource;
  enabled: boolean;
  layout: ProjectActionLayout;
  isLoading: boolean;
  activeProjectRoot?: string;
  /** Rows the Ink frame has drifted into scrollback; added to click rows. */
  getRowOffset?: () => number;
  onSelectIndex: (index: number) => void;
  /** Double-click on an item: open the pane menu / run the action button. */
  onActivateIndex?: (index: number) => void;
  onWheel: (direction: 'up' | 'down') => void;
}

/**
 * Click-to-select in the sidebar: a left click on a pane row (or action
 * button) moves the selection highlight without changing which tmux pane has
 * focus. A double-click activates the item (pane menu / action button), and
 * the scroll wheel steps the selection up/down.
 */
export default function useSidebarMouse(options: UseSidebarMouseOptions) {
  const optionsRef = useRef(options);
  optionsRef.current = options;
  const isDoubleClickRef = useRef(createDoubleClickTracker());
  const { mouseEvents } = options;

  useEffect(() => {
    if (!mouseEvents) {
      return;
    }

    const handleMouse = (event: SidebarMouseEvent) => {
      const current = optionsRef.current;
      if (!current.enabled || event.type !== 'press') {
        return;
      }

      if (event.button === MOUSE_WHEEL_UP_BUTTON) {
        current.onWheel('up');
        return;
      }
      if (event.button === MOUSE_WHEEL_DOWN_BUTTON) {
        current.onWheel('down');
        return;
      }
      if (event.button !== MOUSE_LEFT_BUTTON) {
        return;
      }

      const rowOffset = Math.max(0, current.getRowOffset?.() ?? 0);
      const index = resolveSidebarClickIndex(
        current.layout,
        current.isLoading,
        current.activeProjectRoot,
        event.row + rowOffset,
        event.col
      );
      if (index !== null) {
        current.onSelectIndex(index);
        if (isDoubleClickRef.current(index, Date.now())) {
          current.onActivateIndex?.(index);
        }
      }
    };

    mouseEvents.on('mouse', handleMouse);
    return () => {
      mouseEvents.off('mouse', handleMouse);
    };
  }, [mouseEvents]);
}
