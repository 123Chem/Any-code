import { beforeEach, describe, expect, it, vi } from 'vitest';

const invokeMock = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
vi.mock('@tauri-apps/api/core', () => ({ invoke: invokeMock }));

import { api } from './api';

function lastWireArguments() {
  const calls = invokeMock.mock.calls;
  return JSON.parse(JSON.stringify(calls[calls.length - 1][1]));
}

describe('native session IPC contracts', () => {
  beforeEach(() => invokeMock.mockClear());

  it('preserves omitted effort for an automatic continuation', async () => {
    await api.continueClaudeCode('D:/projects/example', 'next', 'default', false,
      undefined, 'tab-a', false, 'original-uuid');
    expect(lastWireArguments()).toMatchObject({ sessionId: 'original-uuid', tabId: 'tab-a' });
    expect(lastWireArguments()).not.toHaveProperty('effort');
  });

  it('transmits an explicit reset to Claude defaults without losing its meaning', async () => {
    await api.resumeClaudeCode('D:/projects/example', 'original-uuid', 'next',
      'default', false, undefined, 'tab-a', false, null);
    expect(lastWireArguments()).toMatchObject({
      sessionId: 'original-uuid', effort: { level: null },
    });
  });

  it('transmits real Max only to the selected new work process', async () => {
    await api.executeClaudeCode('D:/projects/example', 'start', 'default', false,
      undefined, 'tab-a', false, 'max');
    expect(lastWireArguments()).toMatchObject({
      projectPath: 'D:/projects/example', tabId: 'tab-a', effort: { level: 'max' },
    });
    expect(invokeMock).toHaveBeenCalledTimes(1);
  });

  it('keeps effort and percentage writes as distinct field updates', async () => {
    await api.setClaudeSessionEffort('original-uuid', 'D:/projects/example', 'max');
    expect(invokeMock).toHaveBeenLastCalledWith('set_claude_session_effort', {
      sessionId: 'original-uuid', projectPath: 'D:/projects/example', effort: 'max',
    });
    await api.setClaudeSessionPolicy('original-uuid', 'D:/projects/example', 60);
    expect(lastWireArguments()).toEqual({
      sessionId: 'original-uuid', projectPath: 'D:/projects/example', percent: 60,
    });
  });

  it('asks the backend to resolve the original session instead of guessing its directory', async () => {
    await api.resolveClaudeSessionIdentity('original-uuid', 'legacy-physical-id');
    expect(invokeMock).toHaveBeenLastCalledWith('resolve_claude_session_identity', {
      sessionId: 'original-uuid', projectId: 'legacy-physical-id',
    });
  });
});
