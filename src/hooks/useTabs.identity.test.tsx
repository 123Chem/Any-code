import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { PropsWithChildren } from 'react';
import { api, type Session } from '@/lib/api';
import { onWindowSyncEvent, type WindowSyncEvent } from '@/lib/windowManager';
import { TabProvider, useTabs } from './useTabs';

vi.mock('@/lib/api', () => ({ api: { resolveClaudeSessionIdentity: vi.fn() } }));
vi.mock('@/lib/windowManager', () => ({
  onWindowSyncEvent: vi.fn(), isSessionWindow: vi.fn(() => false),
  createSessionWindow: vi.fn(async () => 'window'), emitWindowSyncEvent: vi.fn(async () => undefined),
}));

const FIRST = '00000000-0000-4000-8000-000000000001';
const SECOND = '00000000-0000-4000-8000-000000000002';
const STORAGE_KEY = 'claude-workbench-tabs-state';
const projectOne = 'D:/中文甲';
const projectTwo = 'D:/中文乙';
const session = (id = FIRST, project = projectOne, engine: Session['engine'] = 'claude'): Session => ({
  id, project_id: project === projectOne ? 'claude-project-one' : 'claude-project-two',
  project_path: project, created_at: 1, engine,
});
const wrapper = ({ children }: PropsWithChildren) => <TabProvider>{children}</TabProvider>;
const owner = (id: string, path: string) => ({ session_id: id,
  project_id: path === projectOne ? 'claude-project-one' : 'claude-project-two',
  project_path: path, project_verified: true });

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}

describe('tab ownership and old project ID compatibility', () => {
  let deliver: (event: WindowSyncEvent) => void;

  beforeEach(() => {
    vi.resetAllMocks();
    localStorage.clear();
    vi.mocked(onWindowSyncEvent).mockImplementation(async callback => { deliver = callback; return () => undefined; });
    vi.mocked(api.resolveClaudeSessionIdentity).mockImplementation(async id => owner(id, id === FIRST ? projectOne : projectTwo));
  });

  it('opens the same UUID under different engines or cwd as different tabs', async () => {
    const { result } = renderHook(() => useTabs(), { wrapper });
    await waitFor(() => expect(onWindowSyncEvent).toHaveBeenCalled());
    act(() => { result.current.openSessionInBackground(session()); });
    act(() => { result.current.openSessionInBackground(session(FIRST, projectOne, 'codex')); });
    act(() => { result.current.openSessionInBackground(session(FIRST, projectTwo)); });
    expect(result.current.tabs).toHaveLength(3);
    act(() => { expect(result.current.openSessionInBackground(session()).isNew).toBe(false); });
    expect(result.current.tabs).toHaveLength(3);
  });

  it('rejects late updates from another UUID or working directory', async () => {
    const { result } = renderHook(() => useTabs(), { wrapper });
    await waitFor(() => expect(onWindowSyncEvent).toHaveBeenCalled());
    let tabId = '';
    act(() => { tabId = result.current.createNewTab(session()); });
    act(() => result.current.updateTabSession(tabId, { sessionId: SECOND, projectId: 'other', projectPath: projectTwo, engine: 'claude' }));
    act(() => result.current.updateTabSession(tabId, { sessionId: FIRST, projectId: 'other', projectPath: projectTwo, engine: 'claude' }));
    expect(result.current.tabs[0].session).toEqual(session());
    act(() => result.current.updateTabSession(tabId, { sessionId: FIRST, projectId: 'other', projectPath: projectOne, engine: 'codex' }));
    expect(result.current.tabs[0].session?.engine).toBe('claude');
  });

  it('rejects first UUID events outside a new tab selected cwd or engine', async () => {
    const { result } = renderHook(() => useTabs(), { wrapper });
    await waitFor(() => expect(onWindowSyncEvent).toHaveBeenCalled());
    let tabId = '';
    act(() => { tabId = result.current.createNewTab(undefined, projectOne); });
    act(() => result.current.updateTabSession(tabId, { sessionId: FIRST, projectId: 'other', projectPath: projectTwo, engine: 'claude' }));
    expect(result.current.tabs[0].session).toBeUndefined();
    act(() => result.current.updateTabEngine(tabId, 'codex'));
    act(() => result.current.updateTabSession(tabId, { sessionId: FIRST, projectId: 'other', projectPath: projectOne, engine: 'claude' }));
    expect(result.current.tabs[0].session).toBeUndefined();
    act(() => result.current.updateTabSession(tabId, { sessionId: FIRST, projectId: 'other', projectPath: projectOne, engine: 'codex' }));
    expect(result.current.tabs[0].session?.engine).toBe('codex');
  });

  it('allows choosing a new cwd before the first UUID and then freezes that owner', async () => {
    const { result } = renderHook(() => useTabs(), { wrapper });
    await waitFor(() => expect(onWindowSyncEvent).toHaveBeenCalled());
    let tabId = '';
    act(() => { tabId = result.current.createNewTab(undefined, projectOne); });
    act(() => result.current.updateTabProjectPath(tabId, projectTwo));
    act(() => result.current.updateTabSession(tabId, { sessionId: FIRST, projectId: 'two', projectPath: projectTwo, engine: 'claude' }));
    act(() => result.current.updateTabProjectPath(tabId, projectOne));
    expect(result.current.tabs[0].projectPath).toBe(projectTwo);
    expect(result.current.tabs[0].session?.project_path).toBe(projectTwo);
  });

  it('rechecks saved physical IDs by original UUID and preserves the old metadata backup', async () => {
    const saved = JSON.stringify({ tabs: [{ id: 'old-tab', title: '中文乙', type: 'session',
      session: { ...session(), project_id: 'D-----', project_path: projectTwo }, projectPath: projectTwo,
      createdAt: 1, lastActiveAt: 1 }], activeTabId: 'old-tab' });
    localStorage.setItem(STORAGE_KEY, saved);
    const { result } = renderHook(() => useTabs(), { wrapper });
    await waitFor(() => expect(result.current.tabs[0]?.session?.project_id).toBe('claude-project-one'));
    expect(result.current.tabs[0].session?.id).toBe(FIRST);
    expect(result.current.tabs[0].projectPath).toBe(projectOne);
    expect(result.current.tabs[0].title).toBe('中文甲');
    expect(result.current.activeTabId).toBe('old-tab');
    expect(localStorage.getItem(`${STORAGE_KEY}-before-project-identity-v1`)).toBe(saved);
  });

  it('does not erase saved tabs while a slow ownership read is pending', async () => {
    const saved = JSON.stringify({ tabs: [{ id: 'old', title: '中文甲', session: session(), createdAt: 1, lastActiveAt: 1 }], activeTabId: 'old' });
    localStorage.setItem(STORAGE_KEY, saved);
    const slow = deferred<ReturnType<typeof owner>>();
    vi.mocked(api.resolveClaudeSessionIdentity).mockReturnValue(slow.promise);
    const { result } = renderHook(() => useTabs(), { wrapper });
    expect(localStorage.getItem(STORAGE_KEY)).toBe(saved);
    let newTab = '';
    act(() => { newTab = result.current.createNewTab(undefined, projectTwo); });
    expect(localStorage.getItem(STORAGE_KEY)).toBe(saved);
    await act(async () => { slow.resolve(owner(FIRST, projectOne)); await slow.promise; });
    await waitFor(() => expect(result.current.tabs).toHaveLength(2));
    expect(result.current.activeTabId).toBe(newTab);
    expect(result.current.tabs.find(tab => tab.id === 'old')?.session?.id).toBe(FIRST);
  });

  it('keeps unconfirmed history read-only without adopting the old guessed cwd', async () => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ tabs: [{ id: 'old', title: 'old', session: session(), createdAt: 1, lastActiveAt: 1 }] }));
    vi.mocked(api.resolveClaudeSessionIdentity).mockResolvedValue({ ...owner(FIRST, ''), project_id: 'claude-unverified-one', project_verified: false });
    const { result } = renderHook(() => useTabs(), { wrapper });
    await waitFor(() => expect(result.current.tabs[0]?.state).toBe('error'));
    expect(result.current.tabs[0].session?.id).toBe(FIRST);
    expect(result.current.tabs[0].session?.project_path).toBe('');
    expect(result.current.tabs[0].session?.project_id).toBe('claude-unverified-one');
  });

  it('uses the original detached tab ID for both insertion and activation', async () => {
    const { result } = renderHook(() => useTabs(), { wrapper });
    await waitFor(() => expect(onWindowSyncEvent).toHaveBeenCalled());
    await act(async () => { deliver({ type: 'tab_attached', tabId: 'detached-original', data: { session: session() }, projectPath: projectTwo }); });
    await waitFor(() => expect(result.current.tabs[0]?.id).toBe('detached-original'));
    expect(result.current.activeTabId).toBe('detached-original');
    expect(result.current.tabs[0].projectPath).toBe(projectOne);
  });
});
