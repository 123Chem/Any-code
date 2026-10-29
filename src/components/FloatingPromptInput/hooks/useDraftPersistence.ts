import { useEffect, useCallback, useRef, useState } from 'react';

const DRAFT_KEY_PREFIX = 'prompt_draft_';
const DRAFT_DEBOUNCE_MS = 300;
const LEGACY_DRAFT_KEY = DRAFT_KEY_PREFIX + 'global';
const LEGACY_OWNER_KEY = DRAFT_KEY_PREFIX + 'legacy_owner';
const LEGACY_CLAIM_EVENT = 'anycode-legacy-draft-claimed';

interface UseDraftPersistenceOptions {
  sessionId?: string;
  draftScope?: string;
  onRestore?: (draft: string) => void;
}

function persistDraft(key: string, content: string) {
  try {
    if (content.trim()) localStorage.setItem(key, content);
    else localStorage.removeItem(key);
  } catch (error) {
    console.warn('[DraftPersistence] Failed to save draft:', error);
  }
}

function legacyAvailable() {
  try {
    return !!localStorage.getItem(LEGACY_DRAFT_KEY)?.trim()
      && !localStorage.getItem(LEGACY_OWNER_KEY);
  } catch { return false; }
}

/** Preserve pending text and keep unbound tabs out of the legacy shared draft. */
export function useDraftPersistence({
  sessionId, draftScope, onRestore,
}: UseDraftPersistenceOptions) {
  const fallbackScope = useRef<string>();
  if (!fallbackScope.current) fallbackScope.current = crypto.randomUUID();
  const scopedKey = DRAFT_KEY_PREFIX + 'tab_' + (draftScope || fallbackScope.current);
  const storageKey = sessionId ? DRAFT_KEY_PREFIX + sessionId : scopedKey;
  const debounceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pendingRef = useRef<{ key: string; content: string } | null>(null);
  const [hasLegacyDraft, setHasLegacyDraft] = useState(legacyAvailable);

  const flushPending = useCallback(() => {
    if (debounceTimerRef.current) clearTimeout(debounceTimerRef.current);
    debounceTimerRef.current = null;
    const pending = pendingRef.current;
    pendingRef.current = null;
    if (pending) persistDraft(pending.key, pending.content);
  }, []);

  const saveDraft = useCallback((content: string) => {
    if (pendingRef.current && pendingRef.current.key !== storageKey) flushPending();
    if (debounceTimerRef.current) clearTimeout(debounceTimerRef.current);
    pendingRef.current = { key: storageKey, content };
    debounceTimerRef.current = setTimeout(flushPending, DRAFT_DEBOUNCE_MS);
  }, [storageKey, flushPending]);

  const clearDraft = useCallback(() => {
    if (debounceTimerRef.current) clearTimeout(debounceTimerRef.current);
    debounceTimerRef.current = null;
    pendingRef.current = null;
    persistDraft(storageKey, '');
    if (storageKey !== scopedKey) persistDraft(scopedKey, '');
  }, [storageKey, scopedKey]);

  const restoreDraft = useCallback((): string | null => {
    try { return localStorage.getItem(storageKey); }
    catch (error) {
      console.warn('[DraftPersistence] Failed to restore draft:', error);
      return null;
    }
  }, [storageKey]);

  useEffect(() => {
    flushPending();
    try {
      // Only this tab's draft may move to its newly confirmed native UUID.
      const ownDraft = localStorage.getItem(scopedKey);
      if (sessionId && ownDraft !== null && localStorage.getItem(storageKey) === null) {
        localStorage.setItem(storageKey, ownDraft);
        localStorage.removeItem(scopedKey);
      }
    } catch (error) {
      console.warn('[DraftPersistence] Failed to bind draft to session:', error);
    }
    onRestore?.(restoreDraft() || '');
  }, [sessionId, scopedKey, storageKey, flushPending, restoreDraft, onRestore]);

  const restoreLegacyDraft = useCallback(() => {
    try {
      if (!legacyAvailable()) return false;
      const draft = localStorage.getItem(LEGACY_DRAFT_KEY);
      if (!draft) return false;
      flushPending();
      localStorage.setItem(storageKey, draft);
      localStorage.setItem(LEGACY_OWNER_KEY, storageKey);
      // Retain the original text as a recovery copy; never auto-distribute it.
      onRestore?.(draft);
      window.dispatchEvent(new Event(LEGACY_CLAIM_EVENT));
      return true;
    } catch (error) {
      console.warn('[DraftPersistence] Failed to recover legacy draft:', error);
      return false;
    }
  }, [storageKey, flushPending, onRestore]);

  useEffect(() => {
    const refresh = () => setHasLegacyDraft(legacyAvailable());
    window.addEventListener(LEGACY_CLAIM_EVENT, refresh);
    window.addEventListener('storage', refresh);
    refresh();
    return () => {
      window.removeEventListener(LEGACY_CLAIM_EVENT, refresh);
      window.removeEventListener('storage', refresh);
    };
  }, []);

  useEffect(() => () => flushPending(), [flushPending]);

  return { saveDraft, clearDraft, restoreDraft, hasLegacyDraft, restoreLegacyDraft };
}
