/** Bind Claude's displayed capacity and snapshots to the same primary session and turn. */
import type { ClaudeStreamMessage } from '@/types/claude';
import { getContextWindowSize } from './tokenCounter';

type JsonObject = Record<string, unknown>;

function object(value: unknown): JsonObject | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as JsonObject : undefined;
}

function identifier(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim().toLowerCase() : undefined;
}

function baseModel(model: string): string {
  return model.replace(/(?:\[1m\]|-1m)$/, '');
}

function sameModel(first: string, second: string): boolean {
  return baseModel(first) === baseModel(second);
}

function familySelector(model: string | undefined): string | undefined {
  const family = model && baseModel(model);
  return family && ['opus', 'sonnet', 'haiku', 'fable'].includes(family) ? family : undefined;
}

function inFamily(model: string, family: string): boolean {
  return baseModel(model) === family || new RegExp(`(?:^|[./])claude-${family}(?:-|$)`).test(model);
}

function compatibleModel(first: string, second: string): boolean {
  const firstFamily = familySelector(first);
  const secondFamily = familySelector(second);
  return sameModel(first, second) || Boolean(firstFamily && inFamily(second, firstFamily))
    || Boolean(secondFamily && inFamily(first, secondFamily));
}

function primary(message: ClaudeStreamMessage): boolean {
  return message.engine !== 'codex' && message.engine !== 'gemini'
    && !message.parent_tool_use_id && !message.parentToolUseId
    && message.isSidechain !== true && message.is_sidechain !== true && message.isAgentMessage !== true;
}

function sessionOf(message: ClaudeStreamMessage): string | undefined {
  return identifier(message.session_id) ?? identifier(message.sessionId);
}

function modelOf(message: ClaudeStreamMessage): string | undefined {
  if (!['system', 'assistant', 'result'].includes(message.type)) return undefined;
  const model = identifier(object(message.message)?.model) ?? identifier(message.model)
    ?? identifier(object(message.model)?.id);
  // CLI API error messages use a placeholder instead of a served model.
  return model && !['default', 'best', 'opusplan', '<synthetic>'].includes(model) ? model : undefined;
}

function capacity(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : undefined;
}

function modelMapCapacity(value: unknown, target: string | undefined, family: string | undefined): number | undefined {
  const models = object(value);
  if (!models) return undefined;
  const entries = Object.entries(models);
  let matched = target ? entries.filter(([name]) => identifier(name) === target) : [];
  if (!matched.length) {
    matched = target ? entries.filter(([name]) => {
      const model = identifier(name);
      return model && sameModel(model, target);
    }) : family ? entries.filter(([name]) => {
      const model = identifier(name);
      return model && inFamily(model, family);
    }) : entries.length === 1 ? entries : [];
  }
  // Multiple matching variants or an unknown multi-model default have no proven primary capacity.
  return matched.length === 1 ? capacity(object(matched[0][1])?.contextWindow) : undefined;
}

function primaryContext(messages: ClaudeStreamMessage[]): ClaudeStreamMessage[] {
  let start = 0;
  let session: string | undefined;
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index];
    if (primary(message) && message.type === 'system' && message.subtype === 'init') {
      start = index;
      session = sessionOf(message);
      break;
    }
  }
  if (!session) {
    for (let index = messages.length - 1; index >= start; index--) {
      if (primary(messages[index]) && sessionOf(messages[index])) {
        session = sessionOf(messages[index]);
        break;
      }
    }
  }
  const scoped = messages.slice(start).filter(message => primary(message)
    && (!sessionOf(message) || !session || sessionOf(message) === session));
  let mainModel: string | undefined;
  let modelStart = 0;
  for (let index = scoped.length - 1; index >= 0; index--) {
    const model = modelOf(scoped[index]);
    if (!model) continue;
    if (mainModel && !compatibleModel(mainModel, model)) {
      // Unidentified snapshots before the first new-model event belong to the previous model.
      return scoped.slice(modelStart);
    }
    mainModel ??= model;
    modelStart = index;
  }
  return scoped;
}

function windowFromPrimary(messages: ClaudeStreamMessage[], selectedModel?: string): number {
  const selected = identifier(selectedModel);
  const family = familySelector(selected);
  const inferredSelector = !selected || ['default', 'best', 'opusplan'].includes(selected);
  let mainModel: string | undefined;
  for (let index = messages.length - 1; index >= 0; index--) {
    mainModel = modelOf(messages[index]);
    if (mainModel) break;
  }
  const fallback = getContextWindowSize(inferredSelector && mainModel
    ? mainModel : selectedModel, 'claude');
  if (family && mainModel && !inFamily(mainModel, family)) return fallback;
  const target = family ? (mainModel && !familySelector(mainModel) ? mainModel : undefined)
    : inferredSelector ? mainModel : selected;
  // A newly selected concrete model must not inherit the previous model's metadata.
  if (target && mainModel && !compatibleModel(target, mainModel)) return fallback;
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index];
    const model = modelOf(message);
    // Anonymous metadata before a primary-model transition belongs to the older model.
    if (model && ((target && !compatibleModel(target, model)) || (family && !inFamily(model, family)))) break;
    const direct = capacity(object(message.context_window)?.context_window_size)
      ?? capacity(message.context_window_size);
    if (direct !== undefined) return direct;
    if (message.type === 'result') {
      const reported = modelMapCapacity(message.modelUsage, target, family);
      if (reported !== undefined) return reported;
    }
  }
  return fallback;
}

export function resolveClaudeContext(messages: ClaudeStreamMessage[], selectedModel?: string): {
  messages: ClaudeStreamMessage[];
  contextWindowSize: number;
} {
  const scoped = primaryContext(messages);
  return { messages: scoped, contextWindowSize: windowFromPrimary(scoped, selectedModel) };
}
