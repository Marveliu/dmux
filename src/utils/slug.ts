import { generateInferenceText } from '../services/InferenceService.js';

const MAX_SLUG_LENGTH = 48;
const MAX_LOCAL_SLUG_WORDS = 4;

const STOP_WORDS = new Set([
  'a',
  'about',
  'after',
  'all',
  'also',
  'an',
  'and',
  'are',
  'as',
  'at',
  'be',
  'because',
  'but',
  'by',
  'can',
  'could',
  'do',
  'does',
  'for',
  'from',
  'get',
  'has',
  'have',
  'how',
  'i',
  'if',
  'in',
  'into',
  'is',
  'it',
  'its',
  'just',
  'me',
  'my',
  'need',
  'needs',
  'not',
  'of',
  'on',
  'or',
  'please',
  'should',
  'so',
  'that',
  'the',
  'then',
  'there',
  'this',
  'to',
  'up',
  'use',
  'using',
  'want',
  'when',
  'with',
  'would',
  'you',
  'your',
]);

const GENERIC_ACTION_WORDS = new Set([
  'add',
  'build',
  'change',
  'create',
  'debug',
  'fix',
  'implement',
  'improve',
  'make',
  'refactor',
  'remove',
  'resolve',
  'set',
  'update',
]);

function formatDateSlug(now = new Date()): string {
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, '0');
  const day = String(now.getDate()).padStart(2, '0');
  const hours = String(now.getHours()).padStart(2, '0');
  const minutes = String(now.getMinutes()).padStart(2, '0');
  const seconds = String(now.getSeconds()).padStart(2, '0');
  return `dmux-${year}-${month}-${day}-${hours}${minutes}${seconds}`;
}

export function normalizeSlugCandidate(value: string): string {
  const normalized = value
    .trim()
    .split('\n')[0]
    .toLowerCase()
    .replace(/[`'"]/g, '')
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '');

  if (!normalized) {
    return '';
  }

  if (normalized.length <= MAX_SLUG_LENGTH) {
    return normalized;
  }

  const parts = normalized.split('-');
  const kept: string[] = [];
  for (const part of parts) {
    const candidate = [...kept, part].join('-');
    if (candidate.length > MAX_SLUG_LENGTH) break;
    kept.push(part);
  }

  return kept.length > 0
    ? kept.join('-')
    : normalized.slice(0, MAX_SLUG_LENGTH).replace(/-+$/g, '');
}

function splitPromptIntoTokens(prompt: string): string[] {
  return prompt
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/[_/\\.-]+/g, ' ')
    .toLowerCase()
    .match(/[a-z0-9]+/g) || [];
}

function isUsefulToken(token: string): boolean {
  if (STOP_WORDS.has(token)) {
    return false;
  }

  if (token.length >= 3) {
    return true;
  }

  return ['ai', 'api', 'ci', 'db', 'ui', 'ux'].includes(token);
}

function scoreToken(token: string, frequency: number): number {
  let score = Math.min(token.length, 10) + frequency * 2;

  if (/\d/.test(token)) {
    score += 2;
  }

  if (GENERIC_ACTION_WORDS.has(token)) {
    score -= 3;
  }

  return score;
}

export function generateLocalSlugFromPrompt(prompt: string, now = new Date()): string {
  const trimmedPrompt = prompt.trim();
  if (!trimmedPrompt) {
    return formatDateSlug(now);
  }

  const tokens = splitPromptIntoTokens(trimmedPrompt).filter(isUsefulToken);
  if (tokens.length === 0) {
    return formatDateSlug(now);
  }

  const frequencies = new Map<string, number>();
  for (const token of tokens) {
    frequencies.set(token, (frequencies.get(token) || 0) + 1);
  }

  const firstIndexes = new Map<string, number>();
  tokens.forEach((token, index) => {
    if (!firstIndexes.has(token)) {
      firstIndexes.set(token, index);
    }
  });

  const selected = Array.from(frequencies.keys())
    .map((token) => ({
      token,
      score: scoreToken(token, frequencies.get(token) || 1),
      index: firstIndexes.get(token) || 0,
    }))
    .sort((left, right) => {
      if (right.score !== left.score) {
        return right.score - left.score;
      }
      return left.index - right.index;
    })
    .slice(0, MAX_LOCAL_SLUG_WORDS)
    .sort((left, right) => left.index - right.index)
    .map(({ token }) => token);

  return normalizeSlugCandidate(selected.join('-')) || formatDateSlug(now);
}

export const generateSlug = async (prompt: string): Promise<string> => {
  const fallbackSlug = generateLocalSlugFromPrompt(prompt);
  if (!prompt.trim()) return fallbackSlug;

  try {
    const content = await generateInferenceText(
      `Generate a 1-2 word kebab-case slug for this prompt. Only respond with the slug, nothing else: "${prompt}"`,
      { maxTokens: 10, temperature: 0.3 }
    );
    const slug = normalizeSlugCandidate(content || '');
    if (slug) return slug;
  } catch {
    // Fall back to deterministic local naming.
  }

  return fallbackSlug;
};
