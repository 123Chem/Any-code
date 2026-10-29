/** Receive actual native boundaries; saving a threshold does not synthesize success. */
import { useEffect, useRef, useState } from 'react';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import { api } from '@/lib/api';
import type { ClaudeThinkingEffort, NativeSessionPolicy } from '@/types/nativeCompactPolicy';

export function useNativeSessionPolicy(sessionId?: string, projectPath?: string, enabled = true) {
  const key = `${sessionId || ''}\0${projectPath || ''}`;
  const currentKey = useRef(key);
  const busyKey = useRef<string | null>(null);
  const revision = useRef(0);
  const accepted = useRef<{ key: string; policy: NativeSessionPolicy } | null>(null);
  currentKey.current = key;
  const [value, setValue] = useState<{ key: string; policy: NativeSessionPolicy } | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const valid = enabled && !!projectPath && !!sessionId
    && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(sessionId);

  useEffect(() => {
    setSaving(false);
    setError(null);
    if (!valid || !sessionId || !projectPath) return;
    let alive = true;
    let unlisten: UnlistenFn | undefined;
    let queued: NativeSessionPolicy | null = null;
    const readRevision = ++revision.current;
    setError(null);
    api.getClaudeSessionPolicy(sessionId, projectPath).then(policy => {
      if (alive && revision.current === readRevision) {
        const latest = queued?.history_root === policy.history_root && queued.project_path === policy.project_path
          ? queued : policy;
        accepted.current = { key, policy: latest };
        setValue(accepted.current);
      }
    }).catch(reason => {
      if (alive && revision.current === readRevision) setError(String(reason));
    });
    listen<NativeSessionPolicy>('claude-native-policy', event => {
      if (!alive || event.payload.session_id !== sessionId) return;
      const previous = accepted.current;
      if (previous?.key !== key) { queued = event.payload; return; }
      if (previous.policy.history_root !== event.payload.history_root
          || previous.policy.project_path !== event.payload.project_path) return;
      revision.current += 1;
      accepted.current = { key, policy: event.payload };
      setValue(accepted.current);
    }).then(stop => {
      if (alive) unlisten = stop;
      else stop();
    }).catch(reason => {
      if (alive) setError(String(reason));
    });
    return () => { alive = false; unlisten?.(); };
  }, [key, projectPath, sessionId, valid]);

  async function saveChange(update: () => Promise<NativeSessionPolicy>): Promise<boolean> {
    if (!valid || !sessionId || !projectPath || busyKey.current === key) return false;
    const requestKey = key;
    busyKey.current = requestKey;
    const saveRevision = ++revision.current;
    setSaving(true);
    setError(null);
    try {
      const policy = await update();
      if (currentKey.current === requestKey && revision.current === saveRevision) {
        accepted.current = { key: requestKey, policy };
        setValue(accepted.current);
      }
      return true;
    } catch (reason) {
      if (currentKey.current === requestKey) setError(String(reason));
      return false;
    } finally {
      if (busyKey.current === requestKey) busyKey.current = null;
      if (currentKey.current === requestKey) setSaving(false);
    }
  }

  function save(percent: number | null) {
    return saveChange(() => api.setClaudeSessionPolicy(sessionId!, projectPath!, percent));
  }

  function saveEffort(effort: ClaudeThinkingEffort | null) {
    return saveChange(() => api.setClaudeSessionEffort(sessionId!, projectPath!, effort));
  }

  return { policy: valid && value?.key === key ? value.policy : null, saving, error, save, saveEffort, valid };
}
