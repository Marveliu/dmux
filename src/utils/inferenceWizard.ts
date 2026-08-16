import type { InferenceTarget } from '../types.js';
import {
  getInferenceApiKey,
  INFERENCE_PROVIDERS,
  type InferenceModel,
  type InferenceProviderDefinition,
} from './inferenceProviders.js';
import {
  getCodexAppServerClient,
  type CodexAccountInfo,
} from '../services/CodexAppServerClient.js';
import {
  getGrokBuildStatus,
  type GrokBuildStatus,
} from '../services/GrokBuildClient.js';

/**
 * Pure helpers backing the Ink inference-setup wizard. Everything here is
 * side-effect free (except the credential probes at the bottom) so the popup
 * UI stays a thin rendering layer.
 */

/**
 * Score how well `query` matches `text`. Higher is better; null means no
 * match. Exact > prefix > substring (word boundaries beat mid-word) >
 * scattered subsequence, so search-as-you-type surfaces the obvious pick
 * first while still tolerating abbreviations like "grq" for Groq.
 */
export function fuzzyMatchScore(query: string, text: string): number | null {
  const q = query.toLowerCase();
  const t = text.toLowerCase();
  if (!q) return 0;

  const index = t.indexOf(q);
  if (index >= 0) {
    if (t === q) return 100;
    if (index === 0) return 90;
    const boundaryBonus = /[\s\-_./(]/.test(t[index - 1]) ? 10 : 0;
    return 70 + boundaryBonus - Math.min(index, 20) * 0.5;
  }

  let searchFrom = 0;
  let gaps = 0;
  let lastFound = -2;
  for (const char of q) {
    const found = t.indexOf(char, searchFrom);
    if (found === -1) return null;
    if (found !== lastFound + 1) gaps++;
    lastFound = found;
    searchFrom = found + 1;
  }
  return Math.max(1, 40 - gaps * 4 - Math.max(0, t.length - q.length) * 0.1);
}

interface WeightedField {
  text: string;
  weight: number;
}

/** Drop control characters (stray escape bytes, etc.) that can sneak into a terminal input buffer. */
export function sanitizeSearchQuery(query: string): string {
  // eslint-disable-next-line no-control-regex
  return query.replace(/[\x00-\x1f\x7f]/g, ' ').trim();
}

function rankByFields<T>(
  items: readonly T[],
  query: string,
  fields: (item: T) => WeightedField[]
): T[] {
  const words = sanitizeSearchQuery(query).split(/\s+/).filter(Boolean);
  if (words.length === 0) return [...items];

  const scored: Array<{ item: T; score: number; index: number }> = [];
  outer: for (let index = 0; index < items.length; index++) {
    const item = items[index];
    const itemFields = fields(item);
    let total = 0;
    for (const word of words) {
      let best: number | null = null;
      for (const field of itemFields) {
        const score = fuzzyMatchScore(word, field.text);
        if (score !== null) {
          const weighted = score * field.weight;
          if (best === null || weighted > best) best = weighted;
        }
      }
      if (best === null) continue outer;
      total += best;
    }
    scored.push({ item, score: total, index });
  }

  return scored
    .sort((left, right) => right.score - left.score || left.index - right.index)
    .map((entry) => entry.item);
}

export function rankInferenceProviders(
  query: string,
  providers: readonly InferenceProviderDefinition[] = INFERENCE_PROVIDERS
): InferenceProviderDefinition[] {
  return rankByFields(providers, query, (provider) => [
    { text: provider.name, weight: 1 },
    { text: provider.id, weight: 0.9 },
    ...provider.envKeys.map((envKey) => ({ text: envKey, weight: 0.8 })),
    { text: provider.description, weight: 0.5 },
  ]);
}

export function rankInferenceModels(
  models: readonly InferenceModel[],
  query: string
): InferenceModel[] {
  return rankByFields(models, query, (model) => [
    { text: model.name, weight: 1 },
    { text: model.id, weight: 0.9 },
    { text: model.description || '', weight: 0.5 },
  ]);
}

/**
 * Compute the [start, end) slice of a list that keeps the selection visible
 * inside a fixed-height viewport, centering it once the list scrolls.
 */
export function getVisibleWindow(
  selectedIndex: number,
  total: number,
  maxVisible: number
): { start: number; end: number } {
  if (total <= maxVisible) return { start: 0, end: total };
  const clamped = Math.max(0, Math.min(selectedIndex, total - 1));
  let start = clamped - Math.floor(maxVisible / 2);
  start = Math.max(0, Math.min(start, total - maxVisible));
  return { start, end: start + maxVisible };
}

export function clampSelection(index: number, total: number): number {
  if (total <= 0) return 0;
  return Math.max(0, Math.min(index, total - 1));
}

export function normalizeCustomBaseUrl(input: string): string {
  return input.trim().replace(/\/+$/, '');
}

export function isValidCustomBaseUrl(input: string): boolean {
  return /^https?:\/\/\S+$/.test(normalizeCustomBaseUrl(input));
}

export function normalizeEnvKeyName(input: string): string {
  return input.trim().toUpperCase().replace(/[\s-]+/g, '_');
}

export function isValidEnvKeyName(input: string): boolean {
  return /^[A-Z_][A-Z0-9_]*$/.test(normalizeEnvKeyName(input));
}

export interface CustomProviderFields {
  name: string;
  baseUrl: string;
  envKey: string;
}

export function buildCustomPartialTarget(
  fields: CustomProviderFields
): Omit<InferenceTarget, 'modelId'> {
  return {
    providerId: 'custom',
    providerName: fields.name.trim() || 'Custom provider',
    baseUrl: normalizeCustomBaseUrl(fields.baseUrl),
    envKey: normalizeEnvKeyName(fields.envKey),
  };
}

export type ProviderCredentialBadge =
  | { kind: 'api-key'; envKey: string }
  | { kind: 'chatgpt'; email?: string }
  | { kind: 'grok-build' };

/**
 * Probe every registry provider for an existing credential (environment or
 * dmux credential store) so the picker can show a "key detected" badge.
 */
export async function detectProviderCredentials(
  providers: readonly InferenceProviderDefinition[] = INFERENCE_PROVIDERS
): Promise<Map<string, ProviderCredentialBadge>> {
  const badges = new Map<string, ProviderCredentialBadge>();
  await Promise.all(
    providers
      .filter((provider) => provider.envKeys.length > 0)
      .map(async (provider) => {
        try {
          const found = await getInferenceApiKey(provider);
          if (found) badges.set(provider.id, { kind: 'api-key', envKey: found.envKey });
        } catch {
          // Detection is best-effort; missing badges are fine.
        }
      })
  );
  return badges;
}

/**
 * Best-effort check for an existing ChatGPT (Codex) login. Bounded by a
 * timeout because it spawns the Codex app-server.
 */
export async function detectChatGptAccount(
  timeoutMs = 4000
): Promise<CodexAccountInfo | null> {
  try {
    const account = await Promise.race<CodexAccountInfo | null>([
      getCodexAppServerClient().getAccount(),
      new Promise<null>((resolve) => setTimeout(resolve, timeoutMs, null)),
    ]);
    return account?.type === 'chatgpt' ? account : null;
  } catch {
    return null;
  }
}

/** Best-effort check for a cached Grok Build subscription login. */
export async function detectGrokBuildAccount(
  timeoutMs = 4000
): Promise<GrokBuildStatus | null> {
  try {
    const status = await getGrokBuildStatus(timeoutMs);
    return status.authenticated ? status : null;
  } catch {
    return null;
  }
}
