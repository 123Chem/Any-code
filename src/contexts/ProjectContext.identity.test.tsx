import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { PropsWithChildren } from 'react';
import { api, type Project, type Session } from '@/lib/api';
import { ProjectProvider, useProject } from './ProjectContext';

vi.mock('react-i18next', () => {
  const translate = (key: string) => key;
  return { useTranslation: () => ({ t: translate }) };
});
vi.mock('@/lib/api', () => ({ api: {
  listProjects: vi.fn(), listCodexSessions: vi.fn(), getProjectSessions: vi.fn(),
  listGeminiSessions: vi.fn(), preindexProject: vi.fn(), deleteProject: vi.fn(),
} }));

const one: Project = { id: 'claude-project-one', path: 'D:/中文甲', sessions: [], created_at: 1 };
const two: Project = { id: 'claude-project-two', path: 'D:/中文乙', sessions: [], created_at: 1 };
const session = (project: Project): Session => ({ id: project.id, project_id: project.id,
  project_path: project.path, created_at: 1, engine: 'claude' });
const wrapper = ({ children }: PropsWithChildren) => <ProjectProvider>{children}</ProjectProvider>;

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}

describe('project selection keeps late results with their original owner', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.mocked(api.listProjects).mockResolvedValue([one, two]);
    vi.mocked(api.listCodexSessions).mockResolvedValue([]);
    vi.mocked(api.listGeminiSessions).mockResolvedValue([]);
    vi.mocked(api.preindexProject).mockResolvedValue(undefined);
  });

  it('does not let a slow first project replace the newly selected project', async () => {
    const slow = deferred<Session[]>();
    vi.mocked(api.getProjectSessions).mockReturnValueOnce(slow.promise).mockResolvedValueOnce([session(two)]);
    const { result } = renderHook(() => useProject(), { wrapper });
    await waitFor(() => expect(result.current.projects).toHaveLength(2));
    act(() => { void result.current.selectProject(one); });
    act(() => { void result.current.selectProject(two); });
    await waitFor(() => expect(result.current.sessions[0]?.project_id).toBe(two.id));
    await act(async () => { slow.resolve([session(one)]); await slow.promise; });
    expect(result.current.selectedProject?.id).toBe(two.id);
    expect(result.current.sessions[0].project_id).toBe(two.id);
    expect(api.preindexProject).not.toHaveBeenCalledWith(one.path);
  });

  it('does not restore the project after the user has returned to the list', async () => {
    const slow = deferred<Session[]>();
    vi.mocked(api.getProjectSessions).mockReturnValue(slow.promise);
    const { result } = renderHook(() => useProject(), { wrapper });
    await waitFor(() => expect(result.current.projects).toHaveLength(2));
    act(() => { void result.current.selectProject(one); });
    act(() => result.current.clearSelection());
    await act(async () => { slow.resolve([session(one)]); await slow.promise; });
    expect(result.current.selectedProject).toBeNull();
    expect(result.current.sessions).toEqual([]);
  });

  it('ignores a late failure from a previously selected project', async () => {
    const slow = deferred<Session[]>();
    vi.mocked(api.getProjectSessions).mockReturnValueOnce(slow.promise).mockResolvedValueOnce([session(two)]);
    const { result } = renderHook(() => useProject(), { wrapper });
    await waitFor(() => expect(result.current.projects).toHaveLength(2));
    act(() => { void result.current.selectProject(one); });
    act(() => { void result.current.selectProject(two); });
    await waitFor(() => expect(result.current.sessions).toHaveLength(1));
    await act(async () => { slow.reject(new Error('old failure')); await slow.promise.catch(() => undefined); });
    expect(result.current.selectedProject?.id).toBe(two.id);
    expect(result.current.error).toBeNull();
  });

  it('keeps unconfirmed history out of code indexing and Gemini discovery', async () => {
    const unknown: Project = { ...one, id: 'claude-unverified-one', path: '' };
    vi.mocked(api.getProjectSessions).mockResolvedValue([{ ...session(unknown), project_path: '' }]);
    const { result } = renderHook(() => useProject(), { wrapper });
    await waitFor(() => expect(result.current.projects).toHaveLength(2));
    await act(async () => result.current.selectProject(unknown));
    expect(result.current.sessions).toHaveLength(1);
    expect(api.listGeminiSessions).not.toHaveBeenCalled();
    expect(api.preindexProject).not.toHaveBeenCalled();
  });
});
