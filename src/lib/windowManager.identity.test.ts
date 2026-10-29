import { afterEach, describe, expect, it, vi } from 'vitest';
import { invoke } from '@tauri-apps/api/core';
import { createSessionWindow, parseSessionWindowParams } from './windowManager';

afterEach(() => { window.history.replaceState({}, '', '/'); });

describe('detached window directory encoding and logical identity', () => {
  it('decodes Chinese and literal percent-containing directories exactly once', () => {
    const path = String.raw`D:\中文丙\文件%20名`;
    const params = new URLSearchParams({ window: 'session', tab_id: 'original-tab',
      session_id: 'original-uuid', project_id: 'claude-project-real', project_path: path });
    window.history.replaceState({}, '', `/?${params}`);
    expect(parseSessionWindowParams()).toEqual({ isSessionWindow: true, tabId: 'original-tab',
      sessionId: 'original-uuid', projectId: 'claude-project-real', projectPath: path, engine: undefined });
  });

  it('passes the logical project ID separately from its unchanged working directory', async () => {
    vi.mocked(invoke).mockResolvedValueOnce({ success: true, window_label: 'window' });
    await createSessionWindow({ tabId: 'tab', sessionId: 'uuid', projectId: 'claude-unverified-real',
      title: 'inspect history', engine: 'claude' });
    expect(invoke).toHaveBeenCalledWith('create_session_window', { params: {
      tab_id: 'tab', session_id: 'uuid', project_id: 'claude-unverified-real',
      project_path: null, title: 'inspect history', engine: 'claude',
    } });
  });
});
