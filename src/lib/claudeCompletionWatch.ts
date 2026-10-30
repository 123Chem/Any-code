/** Reconcile a missed completion event with the native worker's recorded state. */
import type { NativeSessionPolicy } from '@/types/nativeCompactPolicy';

interface CompletionWatchOptions {
  sessionId: string;
  projectPath: string;
  isCurrent: () => boolean;
  readPolicy: () => Promise<NativeSessionPolicy>;
  onEnded: () => Promise<void>;
  intervalMs?: number;
}

function normalizedPath(path: string): string {
  const value = path.replace(/\\/g, '/').replace(/^\/\/\?\/UNC\//i, '//')
    .replace(/^\/\/\?\//, '').replace(/\/+$/, '');
  return /^[a-z]:/i.test(value) || value.startsWith('//') ? value.toLowerCase() : value;
}

export function sameClaudeProjectPath(first?: string, second?: string): boolean {
  return typeof first === 'string' && typeof second === 'string'
    && normalizedPath(first) === normalizedPath(second);
}

export function watchClaudeCompletion(options: CompletionWatchOptions): () => void {
  let stopped = false;
  let inactiveChecks = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const current = () => !stopped && options.isCurrent();
  const schedule = () => {
    if (current()) timer = setTimeout(() => { void check(); }, options.intervalMs ?? 5000);
  };
  const check = async () => {
    if (!current()) return;
    try {
      const policy = await options.readPolicy();
      if (!current()) return;
      const sameOwner = policy?.schema === 1
        && policy.session_id?.toLowerCase() === options.sessionId.toLowerCase()
        && sameClaudeProjectPath(policy.project_path, options.projectPath);
      if (sameOwner && policy.observation?.active === false) {
        inactiveChecks += 1;
        // Two native observations avoid treating a transient state read as an exit.
        if (inactiveChecks >= 2) {
          await options.onEnded();
          stopped = true;
          return;
        }
      } else {
        inactiveChecks = 0;
      }
    } catch {
      // A failed status read says nothing about whether the worker has finished.
      inactiveChecks = 0;
    }
    schedule();
  };

  schedule();
  return () => {
    stopped = true;
    if (timer !== undefined) clearTimeout(timer);
  };
}
