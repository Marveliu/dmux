import { describe, expect, it } from 'vitest';
import {
  buildCustomPartialTarget,
  clampSelection,
  fuzzyMatchScore,
  getVisibleWindow,
  isValidCustomBaseUrl,
  isValidEnvKeyName,
  normalizeCustomBaseUrl,
  normalizeEnvKeyName,
  rankInferenceModels,
  rankInferenceProviders,
  sanitizeSearchQuery,
} from '../src/utils/inferenceWizard.js';
import { INFERENCE_PROVIDERS } from '../src/utils/inferenceProviders.js';

describe('fuzzyMatchScore', () => {
  it('matches everything with an empty query', () => {
    expect(fuzzyMatchScore('', 'anything')).toBe(0);
  });

  it('ranks exact > prefix > substring > subsequence', () => {
    const exact = fuzzyMatchScore('groq', 'groq')!;
    const prefix = fuzzyMatchScore('gro', 'groq')!;
    const substring = fuzzyMatchScore('roq', 'groq')!;
    const subsequence = fuzzyMatchScore('grq', 'groq')!;
    expect(exact).toBeGreaterThan(prefix);
    expect(prefix).toBeGreaterThan(substring);
    expect(substring).toBeGreaterThan(subsequence);
  });

  it('returns null when characters cannot be matched in order', () => {
    expect(fuzzyMatchScore('xyz', 'groq')).toBeNull();
    expect(fuzzyMatchScore('qg', 'groq')).toBeNull();
  });

  it('is case-insensitive', () => {
    expect(fuzzyMatchScore('OPENROUTER', 'OpenRouter')).toBe(100);
  });
});

describe('rankInferenceProviders', () => {
  it('returns the full registry, in order, for an empty query', () => {
    expect(rankInferenceProviders('')).toEqual([...INFERENCE_PROVIDERS]);
    expect(rankInferenceProviders('   ')).toEqual([...INFERENCE_PROVIDERS]);
  });

  it('puts the obvious provider first for a name search', () => {
    expect(rankInferenceProviders('openrouter')[0]?.id).toBe('openrouter');
    expect(rankInferenceProviders('gemini')[0]?.id).toBe('google');
  });

  it('supports abbreviated fuzzy queries', () => {
    expect(rankInferenceProviders('grq')[0]?.id).toBe('groq');
  });

  it('matches environment key names', () => {
    expect(rankInferenceProviders('GROQ_API_KEY')[0]?.id).toBe('groq');
  });

  it('matches multi-word queries against descriptions', () => {
    const matches = rankInferenceProviders('openai compatible');
    expect(matches.some((provider) => provider.id === 'custom')).toBe(true);
  });

  it('returns an empty list when nothing matches', () => {
    expect(rankInferenceProviders('zzzzqqqq')).toEqual([]);
  });

  it('ignores stray control characters from the terminal input buffer', () => {
    expect(rankInferenceProviders('groq \u001b\u001b')[0]?.id).toBe('groq');
    expect(rankInferenceProviders('gro\rq')[0]?.id).toBe('groq');
  });
});

describe('sanitizeSearchQuery', () => {
  it('replaces control characters and trims', () => {
    expect(sanitizeSearchQuery(' groq \u001b\u001b')).toBe('groq');
    expect(sanitizeSearchQuery('a\rb')).toBe('a b');
  });
});

describe('rankInferenceModels', () => {
  const models = [
    { id: 'fast-1', name: 'Fast One', description: 'low latency' },
    { id: 'smart-2', name: 'Smart Two', description: 'reasoning model' },
    { id: 'smart-2-mini', name: 'Smart Two Mini', description: 'small reasoning model' },
  ];

  it('returns everything for an empty query', () => {
    expect(rankInferenceModels(models, '')).toEqual(models);
  });

  it('ranks exact id matches above partial matches', () => {
    expect(rankInferenceModels(models, 'smart-2')[0]?.id).toBe('smart-2');
  });

  it('matches descriptions', () => {
    const matched = rankInferenceModels(models, 'reasoning');
    expect(matched.map((model) => model.id)).toEqual(['smart-2', 'smart-2-mini']);
  });

  it('excludes non-matching models', () => {
    expect(rankInferenceModels(models, 'nonexistent-model-xq')).toEqual([]);
  });
});

describe('getVisibleWindow', () => {
  it('shows the whole list when it fits', () => {
    expect(getVisibleWindow(0, 5, 10)).toEqual({ start: 0, end: 5 });
    expect(getVisibleWindow(4, 5, 5)).toEqual({ start: 0, end: 5 });
  });

  it('keeps the selection near the middle while scrolling', () => {
    expect(getVisibleWindow(10, 100, 10)).toEqual({ start: 5, end: 15 });
  });

  it('clamps at the top and bottom of the list', () => {
    expect(getVisibleWindow(0, 100, 10)).toEqual({ start: 0, end: 10 });
    expect(getVisibleWindow(99, 100, 10)).toEqual({ start: 90, end: 100 });
    expect(getVisibleWindow(500, 100, 10)).toEqual({ start: 90, end: 100 });
  });
});

describe('clampSelection', () => {
  it('clamps into [0, total)', () => {
    expect(clampSelection(-3, 5)).toBe(0);
    expect(clampSelection(2, 5)).toBe(2);
    expect(clampSelection(9, 5)).toBe(4);
    expect(clampSelection(3, 0)).toBe(0);
  });
});

describe('custom provider field helpers', () => {
  it('normalizes and validates base URLs', () => {
    expect(normalizeCustomBaseUrl(' https://api.acme.dev/v1/// ')).toBe('https://api.acme.dev/v1');
    expect(isValidCustomBaseUrl('https://api.acme.dev/v1')).toBe(true);
    expect(isValidCustomBaseUrl('http://localhost:8080/v1')).toBe(true);
    expect(isValidCustomBaseUrl('api.acme.dev/v1')).toBe(false);
    expect(isValidCustomBaseUrl('')).toBe(false);
  });

  it('normalizes and validates environment key names', () => {
    expect(normalizeEnvKeyName(' acme api-key ')).toBe('ACME_API_KEY');
    expect(isValidEnvKeyName('acme_api_key')).toBe(true);
    expect(isValidEnvKeyName('1BAD')).toBe(false);
    expect(isValidEnvKeyName('')).toBe(false);
  });

  it('builds a custom partial target with sensible defaults', () => {
    expect(
      buildCustomPartialTarget({ name: '  ', baseUrl: 'https://api.acme.dev/v1/', envKey: 'acme key' })
    ).toEqual({
      providerId: 'custom',
      providerName: 'Custom provider',
      baseUrl: 'https://api.acme.dev/v1',
      envKey: 'ACME_KEY',
    });
    expect(
      buildCustomPartialTarget({ name: 'Acme', baseUrl: 'https://api.acme.dev/v1', envKey: 'ACME_API_KEY' }).providerName
    ).toBe('Acme');
  });
});
