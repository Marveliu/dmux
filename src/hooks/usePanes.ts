import { useEffect, useState, useRef } from 'react';
import fs from 'fs/promises';
import path from 'path';
import PQueue from 'p-queue';
import type { DmuxConfig, DmuxPane, SidebarProject } from '../types.js';
import { LogService } from '../services/LogService.js';
import { PANE_POLLING_INTERVAL } from '../constants/timing.js';
import {
  loadAndProcessPanes,
  loadSidebarProjectsFromFile,
  recreateKilledPanes,
  fetchTmuxPaneIds,
} from './usePaneLoading.js';
import {
  enforcePaneTitles,
  savePanesToFile,
  rebindAndFilterPanes,
  saveUpdatedPaneConfig,
  destroyWelcomePaneIfNeeded,
} from './usePaneSync.js';
import {
  detectAndAddShellPanes,
} from './useShellDetection.js';
import { rebindPaneByTitle } from '../utils/paneRebinding.js';
import { PaneEventService, type PaneEventMode } from '../services/PaneEventService.js';
import { atomicWriteJson } from '../utils/atomicWrite.js';
import { normalizeSidebarProjects } from '../utils/sidebarProjects.js';
import { syncPaneColorThemes } from '../utils/paneColors.js';
import { TerminalPaneNamingService } from '../services/TerminalPaneNamingService.js';
import {
  observePaneAgents,
  syncPaneAgentMetadata,
} from '../utils/paneAgentTracking.js';

// Use p-queue for proper concurrency control instead of manual write lock
// This prevents race conditions and provides better visibility into queue state
const configQueue = new PQueue({ concurrency: 1 });
const AGENT_TRACKING_INTERVAL_MS = 2000;

async function withWriteLock<T>(operation: () => Promise<T>): Promise<T> {
  return configQueue.add(operation);
}

export interface UsePanesOptions {
  panesFile: string;
  skipLoading: boolean;
  sessionName: string;
  controlPaneId?: string;
  useHooks?: boolean; // undefined = not yet decided, true = use hooks, false = use polling
}

export default function usePanes(
  panesFile: string,
  skipLoading: boolean,
  sessionName?: string,
  controlPaneId?: string,
  useHooks?: boolean // undefined = not yet decided, true = use hooks, false = use polling
) {
  const [panes, setPanes] = useState<DmuxPane[]>([]);
  const panesRef = useRef<DmuxPane[]>([]);
  const [sidebarProjects, setSidebarProjects] = useState<SidebarProject[]>([]);
  const sidebarProjectsRef = useRef<SidebarProject[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [eventMode, setEventMode] = useState<PaneEventMode>('disabled');
  const initialLoadComplete = useRef(false);
  const isLoadingPanes = useRef(false); // Guard against concurrent loadPanes calls
  const pendingLoad = useRef(false);
  const paneEventService = useRef(PaneEventService.getInstance());

  useEffect(() => {
    panesRef.current = panes;
  }, [panes]);

  useEffect(() => {
    sidebarProjectsRef.current = sidebarProjects;
  }, [sidebarProjects]);

  const loadPanes = async () => {
    if (skipLoading) return;

    // Prevent concurrent loadPanes calls which can cause race conditions
    // and duplicate pane detection
    if (isLoadingPanes.current) {
      pendingLoad.current = true;
      return;
    }
    isLoadingPanes.current = true;

    try {
      do {
        pendingLoad.current = false;

        // Load panes from file and rebind IDs based on tmux state
        const {
          panes: loadedPanes,
          allPaneIds,
          titleToId,
          paneMetadataChanged,
        } = await loadAndProcessPanes(
          panesFile,
          !initialLoadComplete.current
        );
        const loadedSidebarProjects = await loadSidebarProjectsFromFile(panesFile, loadedPanes);

        // For initial load, set the loaded panes and mark as complete
        if (!initialLoadComplete.current) {
          panesRef.current = loadedPanes;
          setPanes(loadedPanes);
          sidebarProjectsRef.current = loadedSidebarProjects;
          setSidebarProjects(loadedSidebarProjects);
          initialLoadComplete.current = true;
          if (paneMetadataChanged) {
            await saveUpdatedPaneConfig(panesFile, loadedPanes, withWriteLock);
          }
          break; // Exit loop after initial load — pending loads are handled by the next polling/event cycle
        }

        // Rebind panes and identify any durable panes that need recreation.
        const { activePanes, panesToRecreate } = rebindAndFilterPanes(
          loadedPanes,
          titleToId,
          allPaneIds,
          !initialLoadComplete.current
        );

        // Recreate durable panes that were killed outside dmux (e.g., via Ctrl+b x).
        let finalPanes = activePanes;
        if (panesToRecreate.length > 0) {
          finalPanes = await recreateKilledPanes(activePanes, allPaneIds, panesFile);

          // Re-fetch pane IDs after recreation
          const freshData = await fetchTmuxPaneIds();
          const updatedIds = freshData.allPaneIds;
          const updatedTitleToId = freshData.titleToId;

          // Re-rebind after recreation using the utility function
          finalPanes = finalPanes.map(p => rebindPaneByTitle(p, updatedTitleToId, updatedIds));
        }

        // Detect untracked panes (only after initial load)
        let shellPanesAdded = false;
        if (initialLoadComplete.current) {
          const { updatedPanes, shellPanesAdded: added } = await detectAndAddShellPanes(
            panesFile,
            finalPanes,
            allPaneIds
          );
          finalPanes = updatedPanes;
          shellPanesAdded = added;
        }

        const nextSidebarProjects = await loadSidebarProjectsFromFile(panesFile, finalPanes);

        // Destroy welcome pane if transitioning from 0 to >0 panes
        await destroyWelcomePaneIfNeeded(panesFile, panesRef.current.length, finalPanes.length);

        // Enforce tmux pane titles so they keep a stable rebinding key while
        // reflecting any user-defined display names in the visible border title.
        await enforcePaneTitles(finalPanes, allPaneIds, controlPaneId);

        // Check if panes changed (compare IDs and paneIds only)
        const currentPaneIds = panesRef.current.map(p => `${p.id}:${p.paneId}`).sort().join(',');
        const newPaneIds = finalPanes.map(p => `${p.id}:${p.paneId}`).sort().join(',');

        // Check if IDs were remapped
        const idsChanged = finalPanes.some((pane, idx) =>
          loadedPanes[idx] && loadedPanes[idx].paneId !== pane.paneId
        );
        const sidebarProjectsChanged = JSON.stringify(sidebarProjectsRef.current)
          !== JSON.stringify(nextSidebarProjects);

        // Update state and save if panes changed OR if shell panes were added/removed
        if (
          currentPaneIds !== newPaneIds ||
          shellPanesAdded ||
          paneMetadataChanged ||
          sidebarProjectsChanged
        ) {
          panesRef.current = finalPanes;
          setPanes(finalPanes);
          if (sidebarProjectsChanged) {
            sidebarProjectsRef.current = nextSidebarProjects;
            setSidebarProjects(nextSidebarProjects);
          }

          // Persist remapped IDs, newly detected terminals, and refreshed runtime metadata.
          if (idsChanged || shellPanesAdded || paneMetadataChanged) {
            await saveUpdatedPaneConfig(panesFile, finalPanes, withWriteLock);
          }
        }
      } while (pendingLoad.current);
    } catch (error) {
      // Silently ignore errors during pane loading to prevent UI crashes
      // Most common errors are transient tmux state issues that resolve on next poll
      LogService.getInstance().debug(
        `Error loading panes: ${error instanceof Error ? error.message : String(error)}`,
        'usePanes'
      );
    } finally {
      isLoadingPanes.current = false;
      if (isLoading) setIsLoading(false);
    }
  };

  const savePanes = async (newPanes: DmuxPane[]) => {
    const updatedPanes = await savePanesToFile(panesFile, newPanes, withWriteLock);
    panesRef.current = updatedPanes;
    setPanes(updatedPanes);

    const fallbackProjectRoot = path.dirname(path.dirname(panesFile));
    const nextSidebarProjects = normalizeSidebarProjects(
      sidebarProjectsRef.current,
      updatedPanes,
      fallbackProjectRoot,
      path.basename(fallbackProjectRoot)
    );
    if (JSON.stringify(sidebarProjectsRef.current) !== JSON.stringify(nextSidebarProjects)) {
      sidebarProjectsRef.current = nextSidebarProjects;
      setSidebarProjects(nextSidebarProjects);
    }
  };

  const saveSidebarProjects = async (newSidebarProjects: SidebarProject[]) => {
    return withWriteLock(async () => {
      const fallbackProjectRoot = path.dirname(path.dirname(panesFile));
      let config: DmuxConfig = {
        projectName: path.basename(fallbackProjectRoot),
        projectRoot: fallbackProjectRoot,
        panes: panesRef.current,
        settings: {},
        lastUpdated: new Date().toISOString(),
      };

      try {
        const content = await fs.readFile(panesFile, 'utf-8');
        const parsed = JSON.parse(content);
        if (!Array.isArray(parsed)) {
          config = parsed;
        }
      } catch {}

      const projectRoot = config.projectRoot || fallbackProjectRoot;
      const projectName = config.projectName || path.basename(projectRoot);
      const normalizedProjects = normalizeSidebarProjects(
        newSidebarProjects,
        config.panes || panesRef.current,
        projectRoot,
        projectName
      );
      const syncedPanes = syncPaneColorThemes(
        panesRef.current,
        normalizedProjects,
        projectRoot
      );

      config.panes = syncedPanes;
      config.sidebarProjects = normalizedProjects;
      config.lastUpdated = new Date().toISOString();
      await atomicWriteJson(panesFile, config);

      if (panesRef.current !== syncedPanes) {
        panesRef.current = syncedPanes;
        setPanes(syncedPanes);
      }
      sidebarProjectsRef.current = normalizedProjects;
      setSidebarProjects(normalizedProjects);
      return normalizedProjects;
    });
  };

  // Regular terminals are named from settled screen captures. The service reads
  // through panesRef so a late LLM response cannot overwrite newer pane state.
  useEffect(() => {
    if (skipLoading) return;

    const namingService = new TerminalPaneNamingService({
      getPanes: () => panesRef.current,
      savePanes,
    });
    namingService.start();

    return () => namingService.stop();
  }, [panesFile, skipLoading]);

  // Agent ownership is discovered from the live process tree, including agents
  // launched manually from an ordinary terminal. Persist the active process and
  // exact session ID (when exposed by the CLI) so a missing pane can resume it.
  useEffect(() => {
    if (skipLoading) return;

    let stopped = false;
    let running = false;
    const syncAgents = async () => {
      if (running || stopped || panesRef.current.length === 0) return;
      running = true;
      try {
        const { observations } = await observePaneAgents(panesRef.current);
        if (stopped || observations.size === 0) return;

        // Use the newest pane state after async process inspection so an
        // unrelated pane add/rename is never overwritten by this refresh.
        const synced = syncPaneAgentMetadata(panesRef.current, observations);
        if (!synced.changed) return;

        panesRef.current = synced.panes;
        setPanes(synced.panes);
        await saveUpdatedPaneConfig(panesFile, synced.panes, withWriteLock);
      } catch (error) {
        LogService.getInstance().debug(
          `Failed to sync pane agents: ${error instanceof Error ? error.message : String(error)}`,
          'paneAgentTracking'
        );
      } finally {
        running = false;
      }
    };

    const initialTimer = setTimeout(() => void syncAgents(), 250);
    const interval = setInterval(() => void syncAgents(), AGENT_TRACKING_INTERVAL_MS);
    return () => {
      stopped = true;
      clearTimeout(initialTimer);
      clearInterval(interval);
    };
  }, [panesFile, skipLoading]);

  // Initialize PaneEventService when session info is available
  useEffect(() => {
    if (!sessionName) return;

    const service = paneEventService.current;
    service.initialize({
      sessionName,
      controlPaneId,
      pollInterval: PANE_POLLING_INTERVAL,
    });

    return () => {
      // Cleanup on unmount
      service.stop();
    };
  }, [sessionName, controlPaneId]);

  // Start event-driven updates when useHooks preference is determined
  useEffect(() => {
    if (!sessionName || useHooks === undefined) return;

    const service = paneEventService.current;

    const startEvents = async () => {
      try {
        const mode = await service.start(useHooks);
        setEventMode(mode);
        LogService.getInstance().info(
          `Pane event mode: ${mode}`,
          'paneEvents'
        );
      } catch (error) {
        LogService.getInstance().error(
          `Failed to start pane events: ${error}`,
          'paneEvents'
        );
        // Fall back to polling with interval
        setEventMode('polling');
      }
    };

    startEvents();

    return () => {
      service.stop();
    };
  }, [sessionName, useHooks]);

  // Subscribe to pane change events from PaneEventService
  useEffect(() => {
    if (skipLoading) return;

    const service = paneEventService.current;

    // Initial load
    loadPanes();

    // Subscribe to pane change events
    const unsubscribe = service.onPanesChanged(() => {
      LogService.getInstance().debug('Pane change event received', 'paneEvents');
      loadPanes();
    });

    // Listen for pane split events from SIGUSR2 signal (legacy support)
    const handlePaneSplit = () => {
      LogService.getInstance().debug('Pane split event received, triggering immediate detection', 'shellDetection');
      loadPanes();
      // Also trigger a force check on the service
      service.forceCheck();
    };
    process.on('pane-split-detected' as any, handlePaneSplit);

    // Keep a backup polling interval for resilience
    // This is much longer when hooks are active
    const backupInterval = setInterval(() => {
      loadPanes();
    }, eventMode === 'hooks' ? 30000 : PANE_POLLING_INTERVAL); // 30s backup for hooks, 5s for polling

    return () => {
      unsubscribe();
      clearInterval(backupInterval);
      process.off('pane-split-detected' as any, handlePaneSplit);
    };
  }, [skipLoading, panesFile, eventMode]);

  return {
    panes,
    setPanes,
    sidebarProjects,
    isLoading,
    loadPanes,
    savePanes,
    saveSidebarProjects,
    eventMode,
  } as const;
}
