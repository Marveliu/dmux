import { afterEach, describe, expect, it, vi } from 'vitest';

const grokBuildMocks = vi.hoisted(() => ({
  generateText: vi.fn(),
  listModels: vi.fn(),
}));

vi.mock('../src/services/GrokBuildClient.js', () => ({
  generateGrokBuildText: grokBuildMocks.generateText,
  listGrokBuildModels: grokBuildMocks.listModels,
}));

import {
  discoverInferenceModels,
  generateInferenceText,
} from '../src/services/InferenceService.js';

describe('InferenceService', () => {
  afterEach(() => {
    delete process.env.DMUX_TEST_PRIMARY_KEY;
    delete process.env.DMUX_TEST_BACKUP_KEY;
    delete process.env.OPENAI_API_KEY;
    vi.unstubAllGlobals();
    grokBuildMocks.generateText.mockReset();
    grokBuildMocks.listModels.mockReset();
  });

  it('uses the configured backup when the primary provider fails', async () => {
    process.env.DMUX_TEST_PRIMARY_KEY = 'primary';
    process.env.DMUX_TEST_BACKUP_KEY = 'backup';
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.startsWith('https://primary.test')) {
        return new Response(JSON.stringify({ error: { message: 'unavailable' } }), { status: 503 });
      }
      return new Response(JSON.stringify({
        choices: [{ message: { content: 'backup worked' } }],
      }), { status: 200 });
    });
    vi.stubGlobal('fetch', fetchMock);

    await expect(generateInferenceText('hello', {
      targets: [
        {
          providerId: 'custom',
          providerName: 'Primary',
          baseUrl: 'https://primary.test/v1',
          envKey: 'DMUX_TEST_PRIMARY_KEY',
          modelId: 'primary-model',
        },
        {
          providerId: 'custom',
          providerName: 'Backup',
          baseUrl: 'https://backup.test/v1',
          envKey: 'DMUX_TEST_BACKUP_KEY',
          modelId: 'backup-model',
        },
      ],
    })).resolves.toBe('backup worked');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('discovers models from the selected provider /models endpoint', async () => {
    process.env.DMUX_TEST_PRIMARY_KEY = 'primary';
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      data: [
        { id: 'z-model', name: 'Z Model' },
        { id: 'a-model', name: 'A Model' },
      ],
    }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    const models = await discoverInferenceModels({
      providerId: 'custom',
      providerName: 'Primary',
      baseUrl: 'https://primary.test/v1',
      envKey: 'DMUX_TEST_PRIMARY_KEY',
    });
    expect(models.map((model) => model.id)).toEqual(['a-model', 'z-model']);
    expect(fetchMock).toHaveBeenCalledWith(
      'https://primary.test/v1/models',
      expect.objectContaining({ headers: expect.objectContaining({ Authorization: 'Bearer primary' }) })
    );
  });

  it('uses the Responses API for the OpenAI provider', async () => {
    process.env.OPENAI_API_KEY = 'openai-key';
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      output: [{ content: [{ type: 'output_text', text: 'responses worked' }] }],
    }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(generateInferenceText('hello', {
      targets: [{ providerId: 'openai', modelId: 'gpt-test' }],
    })).resolves.toBe('responses worked');
    expect(fetchMock).toHaveBeenCalledWith(
      'https://api.openai.com/v1/responses',
      expect.objectContaining({
        body: expect.stringContaining('"max_output_tokens"'),
      })
    );
  });

  it('uses the authenticated Grok Build CLI for subscription inference and models', async () => {
    grokBuildMocks.generateText.mockResolvedValue('subscription worked');
    grokBuildMocks.listModels.mockResolvedValue([
      { id: 'grok-4.6', name: 'Grok 4.6' },
      { id: 'grok-4.5', name: 'Grok 4.5' },
    ]);

    await expect(generateInferenceText('hello', {
      targets: [{ providerId: 'grok-build', modelId: 'grok-4.6' }],
    })).resolves.toBe('subscription worked');
    expect(grokBuildMocks.generateText).toHaveBeenCalledWith(
      'grok-4.6',
      'hello',
      expect.objectContaining({})
    );

    await expect(discoverInferenceModels({ providerId: 'grok-build' })).resolves.toEqual([
      { id: 'grok-4.6', name: 'Grok 4.6' },
      { id: 'grok-4.5', name: 'Grok 4.5' },
    ]);
  });
});
