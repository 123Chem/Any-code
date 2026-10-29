/** Claude Code's actual supported effort values; Max is the highest level. */
export type ClaudeThinkingEffort = 'low' | 'medium' | 'high' | 'xhigh' | 'max';

/** Native controls and observations, scoped to one real session. */
export interface NativeSessionPolicy {
  schema: number;
  history_root: string;
  session_id: string;
  project_path: string;
  configured_percent: number | null;
  configured_effort: ClaudeThinkingEffort | null;
  observation: {
    active: boolean;
    applied_percent: number | null;
    applied_effort: ClaudeThinkingEffort | null;
    compaction_count: number;
    current_tokens: number | null;
    last_error: string | null;
  };
}

export function nativeThresholdEstimate(window: number, percent: number | null): number | null {
  if (!Number.isFinite(window) || window <= 33000 || percent === null
      || !Number.isFinite(percent) || percent < 1 || percent > 100) return null;
  const effectiveWindow = window - 20000;
  return Math.min(Math.floor(effectiveWindow * percent / 100), effectiveWindow - 13000);
}
