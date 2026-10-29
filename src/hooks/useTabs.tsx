import { useState, useCallback, useRef, useContext, createContext, ReactNode, useEffect } from 'react';
import { api, type Session } from '@/lib/api';
import { createSessionWindow, emitWindowSyncEvent, onWindowSyncEvent, isSessionWindow } from '@/lib/windowManager';

/**
 * ✨ REFACTORED: Simplified Tab interface (Phase 1 optimization)
 * - Single interface (no dual TabSessionData/TabSession)
 * - Simplified state enum (merged streamingStatus into state)
 * - Flattened error structure
 * - isActive computed on-the-fly from activeTabId
 */
export interface Tab {
  id: string;
  title: string;
  type: 'session' | 'new';
  
  // Session data
  projectPath?: string;
  session?: Session;
  engine?: 'claude' | 'codex' | 'gemini';
  
  // State management (simplified)
  state: 'idle' | 'streaming' | 'error';
  errorMessage?: string; // Flattened from error object
  hasUnsavedChanges: boolean;
  
  // Metadata
  createdAt: number;
  lastActiveAt: number;
}

// Backward compatibility: Keep old interfaces as type aliases
/** @deprecated Use Tab instead */
export type TabSessionData = Tab;
/** @deprecated Use Tab instead */
export type TabSession = Tab & { isActive: boolean };

/**
 * ✨ REFACTORED: Context value interface (Phase 1 optimization)
 * - Updated method signatures to use simplified Tab interface
 * - Simplified updateTabState (merged streaming/error updates)
 */
interface TabContextValue {
  tabs: TabSession[];
  activeTabId: string | null;
  createNewTab: (session?: Session, projectPath?: string, activate?: boolean) => string;
  switchToTab: (tabId: string) => void;
  closeTab: (tabId: string, force?: boolean) => Promise<{ needsConfirmation?: boolean; tabId?: string } | void>;
  updateTabState: (tabId: string, state: Tab['state'], errorMessage?: string) => void;
  updateTabChanges: (tabId: string, hasChanges: boolean) => void;
  updateTabTitle: (tabId: string, title: string) => void;
  updateTabProjectPath: (tabId: string, projectPath: string) => void;
  updateTabEngine: (tabId: string, engine: 'claude' | 'codex' | 'gemini') => void;
  /** 🔧 FIX: 更新标签页的 session 信息（用于新建会话获取到 sessionId 后持久化） */
  updateTabSession: (tabId: string, sessionInfo: { sessionId: string; projectId: string; projectPath: string; engine?: 'claude' | 'codex' | 'gemini' }) => void;
  getTabById: (tabId: string) => TabSession | undefined;
  getActiveTab: () => TabSession | undefined;
  openSessionInBackground: (session: Session) => { tabId: string; isNew: boolean };
  getTabStats: () => { total: number; active: number; hasChanges: number };
  registerTabCleanup: (tabId: string, cleanup: () => Promise<void> | void) => void;
  canCloseTab: (tabId: string) => { canClose: boolean; hasUnsavedChanges: boolean };
  forceCloseTab: (tabId: string) => Promise<void>;
  reorderTabs: (fromIndex: number, toIndex: number) => void;

  // Multi-window support
  detachTab: (tabId: string) => Promise<string | null>;
  isTabDetached: (tabId: string) => boolean;
  getDetachedTabs: () => string[];
  createNewTabAsWindow: (session?: Session, projectPath?: string) => Promise<string | null>;

  // Backward compatibility aliases
  /** @deprecated Use updateTabState instead */
  updateTabStreamingStatus: (tabId: string, isStreaming: boolean, sessionId: string | null) => void;
  /** @deprecated Use updateTabState instead */
  clearTabError: (tabId: string) => void;
}

const TabContext = createContext<TabContextValue | null>(null);

export const normalizeTabProjectPath = (path?: string): string => {
  let value = (path || '').replace(/\\/g, '/');
  if (value.startsWith('//?/UNC/')) value = `//${value.slice(8)}`;
  else if (value.startsWith('//?/')) value = value.slice(4);
  return value.replace(/\/+$/, '').toLowerCase();
};

export const sameTabSessionIdentity = (first: Session | undefined, second: Session): boolean => {
  if (!first || first.id !== second.id || (first.engine || 'claude') !== (second.engine || 'claude')) return false;
  const firstPath = normalizeTabProjectPath(first.project_path);
  const secondPath = normalizeTabProjectPath(second.project_path);
  return firstPath === secondPath && (Boolean(firstPath) || first.project_id === second.project_id);
};

interface TabProviderProps {
  children: ReactNode;
}

/**
 * ✨ REFACTORED: TabProvider - Simplified state management (Phase 1)
 * - Removed Map cache (direct array operations)
 * - Single Tab[] state (no dual data structures)
 * - Cleaner persistence logic
 */
export const TabProvider: React.FC<TabProviderProps> = ({ children }) => {
  const [tabs, setTabs] = useState<Tab[]>([]);
  const [activeTabId, setActiveTabId] = useState<string | null>(null);
  const nextTabId = useRef(1);
  const [restored, setRestored] = useState(false);
  
  // Cleanup callbacks stored separately (not in state)
  const cleanupCallbacksRef = useRef<Map<string, () => Promise<void> | void>>(new Map());

  const STORAGE_KEY = 'claude-workbench-tabs-state';

  // ✨ REFACTORED: Load persisted state on mount (simplified)
  useEffect(() => {
    let current = true;
    const restoreTabs = async () => {
      try {
        const persistedState = localStorage.getItem(STORAGE_KEY);
        if (!persistedState) return;
        const backupKey = `${STORAGE_KEY}-before-project-identity-v1`;
        if (!localStorage.getItem(backupKey)) localStorage.setItem(backupKey, persistedState);
        const { tabs: savedTabs, activeTabId: savedActiveTabId } = JSON.parse(persistedState);
        if (!Array.isArray(savedTabs)) return;
        const validTabs: Tab[] = await Promise.all(savedTabs
          .filter((tab: any) => typeof tab.id === 'string' && typeof tab.title === 'string')
          .map(async (saved: any): Promise<Tab> => {
            const tab: Tab = { ...saved, type: saved.type || (saved.session ? 'session' : 'new'),
              state: saved.state === 'error' ? 'error' : 'idle',
              hasUnsavedChanges: saved.hasUnsavedChanges ?? saved.hasChanges ?? false };
            if (!tab.session || (tab.session.engine || tab.engine || 'claude') !== 'claude') return tab;
            try {
              const owner = await api.resolveClaudeSessionIdentity(tab.session.id, tab.session.project_id);
              const previousName = tab.session.project_path?.split(/[/\\]/).filter(Boolean).pop();
              return { ...tab, projectPath: owner.project_path,
                title: tab.title === previousName && owner.project_verified
                  ? owner.project_path.split(/[/\\]/).filter(Boolean).pop() || tab.title : tab.title,
                session: { ...tab.session, project_id: owner.project_id, project_path: owner.project_path },
                state: owner.project_verified ? 'idle' : 'error',
                errorMessage: owner.project_verified ? undefined : '原会话工作目录尚未确认，只能查看历史，请刷新原项目后续聊' };
            } catch (error) {
              return { ...tab, projectPath: '', session: { ...tab.session, project_path: '' },
                state: 'error', errorMessage: String(error) };
            }
          }));
        if (!current) return;
        setTabs(previous => [...validTabs.filter(saved => !previous.some(tab => tab.id === saved.id
          || (saved.session && sameTabSessionIdentity(tab.session, saved.session)))), ...previous]);
        setActiveTabId(previous => previous || (validTabs.some(tab => tab.id === savedActiveTabId)
          ? savedActiveTabId : validTabs[0]?.id || null));
      } catch (error) {
        console.error('[useTabs] Failed to restore tabs; original metadata remains in its backup:', error);
      } finally {
        if (current) setRestored(true);
      }
    };
    void restoreTabs();
    return () => { current = false; };
  }, []);

  // Wait for identity verification before overwriting the old saved tab metadata.
  useEffect(() => {
    if (!restored) return;
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify({ schema: 2, tabs, activeTabId }));
    } catch (error) {
      console.error('[useTabs] Failed to persist tabs:', error);
    }
  }, [tabs, activeTabId, restored]);

  // ✨ REFACTORED: Compute TabSession with isActive (simplified)
  const tabsWithActive: TabSession[] = tabs.map(tab => ({
    ...tab,
    isActive: tab.id === activeTabId,
  }));

  // Generate unique tab ID
  const generateTabId = useCallback(() => {
    return `tab-${Date.now()}-${nextTabId.current++}`;
  }, []);

  // Generate smart tab title
  const generateTabTitle = useCallback((session?: Session, projectPath?: string) => {
    // Helper function to extract project name from path
    const extractProjectName = (path: string): string => {
      if (!path) return '';

      // 判断是 Windows 路径还是 Unix 路径
      const isWindowsPath = path.includes('\\');
      const separator = isWindowsPath ? '\\' : '/';

      // 分割路径并获取最后一个片段
      const segments = path.split(separator);
      const projectName = segments[segments.length - 1] || '';

      // 格式化项目名：移除常见前缀，替换分隔符为空格
      const formattedName = projectName
        .replace(/^(my-|test-|demo-)/, '')
        .replace(/[-_]/g, ' ')
        .trim();

      // 调试日志（可在浏览器控制台查看）
      return formattedName;
    };

    if (session) {
      const projectName = extractProjectName(session.project_path);
      return projectName || '未命名会话';
    }

    if (projectPath) {
      const projectName = extractProjectName(projectPath);
      return projectName || '新会话';
    }

    return '新会话';
  }, []);

  // ✨ REFACTORED: Create new tab (simplified)
  const createNewTab = useCallback((session?: Session, projectPath?: string, activate: boolean = true): string => {
    const newTabId = generateTabId();
    const newTab: Tab = {
      id: newTabId,
      title: generateTabTitle(session, projectPath),
      type: session ? 'session' : 'new',
      projectPath: projectPath || session?.project_path,
      session,
      engine: session?.engine,
      state: 'idle',
      hasUnsavedChanges: false,
      createdAt: Date.now(),
      lastActiveAt: Date.now(),
    };

    setTabs(prev => [...prev, newTab]);
    
    if (activate) {
      setActiveTabId(newTabId);
    }

    return newTabId;
  }, [generateTabId, generateTabTitle]);

  // ✨ REFACTORED: Switch to tab (functional setState)
  const switchToTab = useCallback((tabId: string) => {
    setTabs(prev =>
      prev.map(tab =>
        tab.id === tabId
          ? { ...tab, lastActiveAt: Date.now() }
          : tab
      )
    );
    setActiveTabId(tabId);
  }, []);

  // Check if tab can be closed
  const canCloseTab = useCallback((tabId: string) => {
    const tab = tabs.find(t => t.id === tabId);
    return {
      canClose: !tab?.hasUnsavedChanges,
      hasUnsavedChanges: Boolean(tab?.hasUnsavedChanges),
    };
  }, [tabs]);

  // ✨ REFACTORED: Force close tab (use cleanup callbacks ref)
  const forceCloseTab = useCallback(async (tabId: string) => {
    // Execute cleanup callback if present
    const cleanup = cleanupCallbacksRef.current.get(tabId);
    if (cleanup) {
      try {
        await cleanup();
      } catch (error) {
        console.error(`[useTabs] Cleanup failed for tab ${tabId}:`, error);
        // Continue closing anyway
      }
      cleanupCallbacksRef.current.delete(tabId);
    }

    setTabs(prev => {
      const remaining = prev.filter(t => t.id !== tabId);

      // Switch to another tab if closing active tab
      if (activeTabId === tabId && remaining.length > 0) {
        const lastActiveTab = remaining.reduce((latest, current) =>
          current.lastActiveAt > latest.lastActiveAt ? current : latest
        );
        setActiveTabId(lastActiveTab.id);
      } else if (remaining.length === 0) {
        setActiveTabId(null);
      }

      return remaining;
    });
  }, [activeTabId]);

  // Close tab with UI confirmation
  const closeTab = useCallback(async (tabId: string, force = false): Promise<{ needsConfirmation?: boolean; tabId?: string } | void> => {
    if (force) {
      return forceCloseTab(tabId);
    }

    const { canClose, hasUnsavedChanges } = canCloseTab(tabId);

    if (!canClose && hasUnsavedChanges) {
      return { needsConfirmation: true, tabId };
    }

    return forceCloseTab(tabId);
  }, [canCloseTab, forceCloseTab]);

  // ✨ NEW: Unified state update method
  const updateTabState = useCallback((tabId: string, state: Tab['state'], errorMessage?: string) => {
    setTabs(prev =>
      prev.map(tab =>
        tab.id === tabId
          ? { ...tab, state, errorMessage, lastActiveAt: Date.now() }
          : tab
      )
    );
  }, []);

  // Update tab changes
  const updateTabChanges = useCallback((tabId: string, hasChanges: boolean) => {
    setTabs(prev =>
      prev.map(tab =>
        tab.id === tabId ? { ...tab, hasUnsavedChanges: hasChanges } : tab
      )
    );
  }, []);

  // Update tab title
  const updateTabTitle = useCallback((tabId: string, title: string) => {
    setTabs(prev =>
      prev.map(tab =>
        tab.id === tabId ? { ...tab, title } : tab
      )
    );
  }, []);

  // 🆕 Update tab engine - 更新标签页的执行引擎
  const updateTabProjectPath = useCallback((tabId: string, projectPath: string) => {
    setTabs(prev => prev.map(tab => {
      if (tab.id !== tabId) return tab;
      if (tab.session && normalizeTabProjectPath(tab.session.project_path) !== normalizeTabProjectPath(projectPath)) return tab;
      return { ...tab, projectPath };
    }));
  }, []);

  const updateTabEngine = useCallback((tabId: string, engine: 'claude' | 'codex' | 'gemini') => {
    setTabs(prev =>
      prev.map(tab => {
        if (tab.id !== tabId) return tab;
        const updatedSession = tab.session ? { ...tab.session, engine } : tab.session;
        return { ...tab, engine, session: updatedSession };
      })
    );
  }, []);

  // 🔧 FIX: Update tab session - 更新标签页的会话信息
  // 用于新建会话在获取到 sessionId 后持久化，解决页面切换后消息丢失问题
  const updateTabSession = useCallback((
    tabId: string,
    sessionInfo: { sessionId: string; projectId: string; projectPath: string; engine?: 'claude' | 'codex' | 'gemini' }
  ) => {
    setTabs(prev =>
      prev.map(tab => {
        if (tab.id !== tabId) return tab;

        // An established tab cannot adopt a late event for another UUID, engine or cwd.
        if (!tab.session && ((tab.projectPath && normalizeTabProjectPath(tab.projectPath) !== normalizeTabProjectPath(sessionInfo.projectPath))
          || (tab.engine || 'claude') !== (sessionInfo.engine || 'claude') || !sessionInfo.projectPath)) {
          console.warn('[useTabs] Rejected first session info outside the selected tab project or engine:', tabId);
          return tab;
        }
        if (tab.session && !sameTabSessionIdentity(tab.session, {
          id: sessionInfo.sessionId, project_id: sessionInfo.projectId, project_path: sessionInfo.projectPath,
          created_at: tab.session.created_at, engine: sessionInfo.engine || tab.engine,
        })) {
          console.warn('[useTabs] Rejected session info that belongs to another tab owner:', tabId);
          return tab;
        }

        // 构建完整的 Session 对象
        const newSession: Session = {
          ...tab.session,
          id: sessionInfo.sessionId,
          project_id: sessionInfo.projectId,
          project_path: sessionInfo.projectPath,
          created_at: tab.session?.created_at || Math.floor(tab.createdAt / 1000),
          engine: sessionInfo.engine || tab.engine,
        };

        console.debug('[useTabs] Updating tab session:', { tabId, sessionInfo });

        return {
          ...tab,
          type: 'session' as const,
          session: newSession,
          projectPath: sessionInfo.projectPath,
          engine: sessionInfo.engine || tab.engine,
          lastActiveAt: Date.now(),
        };
      })
    );
  }, []);

  // Get tab by ID
  const getTabById = useCallback((tabId: string): TabSession | undefined => {
    const tab = tabs.find(t => t.id === tabId);
    if (!tab) return undefined;

    return {
      ...tab,
      isActive: tab.id === activeTabId,
    };
  }, [tabs, activeTabId]);

  // Get active tab
  const getActiveTab = useCallback((): TabSession | undefined => {
    if (!activeTabId) return undefined;
    return getTabById(activeTabId);
  }, [activeTabId, getTabById]);

  // Open session in background
  const openSessionInBackground = useCallback((session: Session): { tabId: string; isNew: boolean } => {
    const existingTab = tabs.find(tab => sameTabSessionIdentity(tab.session, session));
    if (existingTab) {
      return { tabId: existingTab.id, isNew: false };
    }

    const newTabId = createNewTab(session, undefined, false);
    return { tabId: newTabId, isNew: true };
  }, [tabs, createNewTab]);

  // Get tab stats
  const getTabStats = useCallback(() => {
    return {
      total: tabs.length,
      active: tabs.filter(tab => tab.state === 'streaming').length,
      hasChanges: tabs.filter(tab => tab.hasUnsavedChanges).length,
    };
  }, [tabs]);

  // Register cleanup callback
  const registerTabCleanup = useCallback((tabId: string, cleanup: () => Promise<void> | void) => {
    cleanupCallbacksRef.current.set(tabId, cleanup);
  }, []);

  // Reorder tabs (drag & drop)
  const reorderTabs = useCallback((fromIndex: number, toIndex: number) => {
    if (fromIndex === toIndex) return;

    setTabs(prev => {
      const newTabs = [...prev];
      const [removed] = newTabs.splice(fromIndex, 1);
      newTabs.splice(toIndex, 0, removed);
      return newTabs;
    });
  }, []);

  // Track detached tabs (tabs that have been opened in separate windows)
  const detachedTabsRef = useRef<Set<string>>(new Set());

  // Listen for window sync events (for tab_attached from detached windows)
  useEffect(() => {
    // Skip if this is a session window (not main window)
    if (isSessionWindow()) return;

    let unlisten: (() => void) | null = null;
    let current = true;

    const setupListener = async () => {
      const stop = await onWindowSyncEvent(async (event) => {
        if (!current) return;
        if (event.type === 'tab_attached') {
          // A detached window wants to merge back to main window
          // Remove from detached set
          detachedTabsRef.current.delete(event.tabId);

          // Create new tab with the session data
          let session = event.data?.session as Session | undefined;
          let projectPath = event.projectPath || session?.project_path;
          if (session && (session.engine || 'claude') === 'claude') {
            try {
              const owner = await api.resolveClaudeSessionIdentity(session.id, session.project_id);
              if (!current) return;
              session = { ...session, project_id: owner.project_id, project_path: owner.project_path };
              projectPath = owner.project_path;
            } catch (error) {
              console.warn('[useTabs] Detached session ownership could not be confirmed:', error);
              return;
            }
          }
          if (!session && !projectPath) return;
          const newTabId = event.tabId || `tab-${Date.now()}-attached`;
          const incomingSession = session;
          const newTab: Tab = { id: newTabId,
            title: projectPath?.split(/[/\\]/).filter(Boolean).pop() || session?.id.slice(0, 8) || '新会话',
            type: session ? 'session' : 'new', projectPath, session, engine: session?.engine,
            state: session && !projectPath ? 'error' : 'idle', hasUnsavedChanges: false,
            createdAt: Date.now(), lastActiveAt: Date.now() };
          setTabs(prev => {
            const byId = prev.find(tab => tab.id === newTabId);
            if (byId && incomingSession && !sameTabSessionIdentity(byId.session, incomingSession)) return prev;
            const existing = byId || (incomingSession && prev.find(tab => sameTabSessionIdentity(tab.session, incomingSession)));
            setActiveTabId(existing?.id || newTabId);
            return existing ? prev : [...prev, newTab];
          });
        }
      });
      if (!current) stop();
      else unlisten = stop;
    };

    setupListener();

    return () => {
      current = false;
      if (unlisten) unlisten();
    };
  }, []);

  // Detach tab into a new window
  const detachTab = useCallback(async (tabId: string): Promise<string | null> => {
    const tab = tabs.find(t => t.id === tabId);
    if (!tab) {
      console.error('[useTabs] Cannot detach: tab not found:', tabId);
      return null;
    }

    // Check if already detached
    if (detachedTabsRef.current.has(tabId)) {
      console.warn('[useTabs] Tab already detached:', tabId);
      return null;
    }

    try {
      // Create new window
      const windowLabel = await createSessionWindow({
        tabId: tab.id,
        sessionId: tab.session?.id,
        projectId: tab.session?.project_id,
        projectPath: tab.projectPath,
        title: `${tab.title} - Any Code`,
        engine: tab.session?.engine,
      });

      // Mark as detached
      detachedTabsRef.current.add(tabId);

      // Emit sync event
      await emitWindowSyncEvent({
        type: 'tab_detached',
        tabId,
        sessionId: tab.session?.id,
        projectPath: tab.projectPath,
      });

      // Close the tab in main window (force close since it's now in a separate window)
      await forceCloseTab(tabId);
      return windowLabel;
    } catch (error) {
      console.error('[useTabs] Failed to detach tab:', error);
      return null;
    }
  }, [tabs, forceCloseTab]);

  // Check if a tab is detached
  const isTabDetached = useCallback((tabId: string): boolean => {
    return detachedTabsRef.current.has(tabId);
  }, []);

  // Get all detached tab IDs
  const getDetachedTabs = useCallback((): string[] => {
    return Array.from(detachedTabsRef.current);
  }, []);

  // Create a new session directly as an independent window
  const createNewTabAsWindow = useCallback(async (session?: Session, projectPath?: string): Promise<string | null> => {
    try {
      const newTabId = generateTabId();
      const title = session
        ? (projectPath?.split(/[/\\]/).pop() || session.project_path?.split(/[/\\]/).pop() || '新会话')
        : (projectPath?.split(/[/\\]/).pop() || '新会话');

      // Create the window directly without creating a tab first
      const windowLabel = await createSessionWindow({
        tabId: newTabId,
        sessionId: session?.id,
        projectId: session?.project_id,
        projectPath: projectPath || session?.project_path,
        title: `${title} - Any Code`,
        engine: session?.engine,
      });

      // Mark as detached
      detachedTabsRef.current.add(newTabId);

      // Emit sync event
      await emitWindowSyncEvent({
        type: 'tab_detached',
        tabId: newTabId,
        sessionId: session?.id,
        projectPath: projectPath || session?.project_path,
      });
      return windowLabel;
    } catch (error) {
      console.error('[useTabs] Failed to create new session as window:', error);
      return null;
    }
  }, [generateTabId]);

  // ✨ REFACTORED: Backward compatibility aliases
  const updateTabStreamingStatus = useCallback((tabId: string, isStreaming: boolean, _sessionId: string | null) => {
    updateTabState(tabId, isStreaming ? 'streaming' : 'idle');
  }, [updateTabState]);

  const clearTabError = useCallback((tabId: string) => {
    updateTabState(tabId, 'idle');
  }, [updateTabState]);

  const contextValue: TabContextValue = {
    tabs: tabsWithActive,
    activeTabId,
    createNewTab,
    switchToTab,
    closeTab,
    updateTabState,
    updateTabChanges,
    updateTabTitle,
    updateTabProjectPath,
    updateTabEngine,
    updateTabSession,
    getTabById,
    getActiveTab,
    openSessionInBackground,
    getTabStats,
    registerTabCleanup,
    canCloseTab,
    forceCloseTab,
    reorderTabs,
    // Multi-window support
    detachTab,
    isTabDetached,
    getDetachedTabs,
    createNewTabAsWindow,
    // Backward compatibility
    updateTabStreamingStatus,
    clearTabError,
  };

  return (
    <TabContext.Provider value={contextValue}>
      {children}
    </TabContext.Provider>
  );
};

/**
 * useTabs - 使用标签页状态管理
 */
export const useTabs = (): TabContextValue => {
  const context = useContext(TabContext);
  if (!context) {
    throw new Error('useTabs must be used within a TabProvider');
  }
  return context;
};

/**
 * useActiveTab - 获取当前活跃标签页
 */
export const useActiveTab = (): TabSession | undefined => {
  const { getActiveTab } = useTabs();
  return getActiveTab();
};

/**
 * useTabSession - 获取特定标签页的会话管理钩子
 */
export const useTabSession = (tabId: string) => {
  const { getTabById, updateTabChanges, updateTabStreamingStatus, updateTabTitle, updateTabProjectPath, updateTabEngine, updateTabSession, registerTabCleanup } = useTabs();

  const tab = getTabById(tabId);

  const markAsChanged = useCallback(() => {
    updateTabChanges(tabId, true);
  }, [tabId, updateTabChanges]);

  const markAsUnchanged = useCallback(() => {
    updateTabChanges(tabId, false);
  }, [tabId, updateTabChanges]);

  const updateTitle = useCallback((title: string) => {
    updateTabTitle(tabId, title);
  }, [tabId, updateTabTitle]);

  const updateStreaming = useCallback((isStreaming: boolean, sessionId: string | null) => {
    updateTabStreamingStatus(tabId, isStreaming, sessionId);
  }, [tabId, updateTabStreamingStatus]);

  const updateProjectPath = useCallback((projectPath: string) => {
    updateTabProjectPath(tabId, projectPath);
  }, [tabId, updateTabProjectPath]);

  // 🆕 Update engine - 更新执行引擎
  const updateEngine = useCallback((engine: 'claude' | 'codex' | 'gemini') => {
    updateTabEngine(tabId, engine);
  }, [tabId, updateTabEngine]);

  // 🔧 FIX: Update session - 更新会话信息（用于新建会话持久化）
  const updateSession = useCallback((sessionInfo: { sessionId: string; projectId: string; projectPath: string; engine?: 'claude' | 'codex' | 'gemini' }) => {
    updateTabSession(tabId, sessionInfo);
  }, [tabId, updateTabSession]);

  // 🔧 NEW: Register cleanup callback
  const setCleanup = useCallback((cleanup: () => Promise<void> | void) => {
    registerTabCleanup(tabId, cleanup);
  }, [tabId, registerTabCleanup]);

  return {
    tab,
    markAsChanged,
    markAsUnchanged,
    updateTitle,
    updateProjectPath,
    updateStreaming,
    updateEngine,
    updateSession,
    setCleanup,
  };
};
