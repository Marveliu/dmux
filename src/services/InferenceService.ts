import { LogService } from './LogService.js';
import { getCodexAppServerClient } from './CodexAppServerClient.js';
import {
  generateGrokBuildText,
  listGrokBuildModels,
} from './GrokBuildClient.js';
import { SettingsManager } from '../utils/settingsManager.js';
import {
  getInferenceApiKey,
  getInferenceProvider,
  hasInferenceApiKeySync,
  resolveInferenceProvider,
  type InferenceModel,
  type InferenceProviderDefinition,
} from '../utils/inferenceProviders.js';
import type { InferenceTarget } from '../types.js';

export interface GenerateInferenceOptions {
  system?: string;
  maxTokens?: number;
  temperature?: number;
  timeoutMs?: number;
  signal?: AbortSignal;
  projectRoot?: string;
  outputSchema?: Record<string, unknown>;
  targets?: InferenceTarget[];
}

export class InferenceRequestError extends Error {
  constructor(
    message: string,
    public readonly providerId: string,
    public readonly modelId: string,
    public readonly status?: number
  ) {
    super(message);
    this.name = 'InferenceRequestError';
  }
}

const LEGACY_OPENROUTER_TARGETS: InferenceTarget[] = [
  { providerId: 'openrouter', modelId: 'google/gemini-2.5-flash' },
  { providerId: 'openrouter', modelId: 'openai/gpt-4o-mini' },
  { providerId: 'openrouter', modelId: 'openai/gpt-oss-120b:free' },
  { providerId: 'openrouter', modelId: 'nvidia/nemotron-3-super-120b-a12b:free' },
];

function configuredTargets(projectRoot?: string): InferenceTarget[] {
  const settings = new SettingsManager(projectRoot || process.cwd()).getSettings();
  const targets: InferenceTarget[] = [];
  if (settings.inferencePrimary) targets.push(settings.inferencePrimary);
  if (settings.inferenceBackup) targets.push(settings.inferenceBackup);
  if (targets.length > 0) return targets;

  const openRouter = getInferenceProvider('openrouter');
  return openRouter && hasInferenceApiKeySync(openRouter)
    ? LEGACY_OPENROUTER_TARGETS
    : [];
}

export function hasConfiguredInferenceSync(projectRoot?: string): boolean {
  return configuredTargets(projectRoot).length > 0;
}

function combineSignals(signal: AbortSignal | undefined, timeoutMs: number): {
  signal: AbortSignal;
  cleanup: () => void;
} {
  const timeoutController = new AbortController();
  const timeout = setTimeout(() => timeoutController.abort(), timeoutMs);
  return {
    signal: signal
      ? AbortSignal.any([signal, timeoutController.signal])
      : timeoutController.signal,
    cleanup: () => clearTimeout(timeout),
  };
}

function extractOpenAiText(data: any): string {
  const content = data?.choices?.[0]?.message?.content;
  if (typeof content === 'string') return content.trim();
  if (Array.isArray(content)) {
    return content
      .map((part) => typeof part === 'string' ? part : part?.text)
      .filter((part): part is string => typeof part === 'string')
      .join('')
      .trim();
  }
  return '';
}

async function readApiError(response: Response): Promise<string> {
  const text = (await response.text()).slice(0, 1000);
  try {
    const data = JSON.parse(text) as any;
    return data?.error?.message || data?.message || JSON.stringify(data);
  } catch {
    return text;
  }
}

function extractOpenAiResponsesText(data: any): string {
  if (typeof data?.output_text === 'string') return data.output_text.trim();
  return (data?.output || [])
    .flatMap((item: any) => Array.isArray(item?.content) ? item.content : [])
    .filter((part: any) => part?.type === 'output_text' && typeof part.text === 'string')
    .map((part: any) => part.text)
    .join('')
    .trim();
}

async function callOpenAiResponses(
  provider: InferenceProviderDefinition,
  target: InferenceTarget,
  apiKey: string,
  prompt: string,
  options: GenerateInferenceOptions,
  signal: AbortSignal
): Promise<string> {
  const response = await fetch(`${provider.baseUrl}/responses`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: target.modelId,
      input: prompt,
      ...(options.system ? { instructions: options.system } : {}),
      max_output_tokens: options.maxTokens ?? 1000,
    }),
    signal,
  });

  if (!response.ok) {
    throw new InferenceRequestError(
      `${provider.name} API error (${target.modelId}): ${response.status} ${await readApiError(response)}`,
      provider.id,
      target.modelId,
      response.status
    );
  }

  const text = extractOpenAiResponsesText(await response.json());
  if (!text) {
    throw new InferenceRequestError(
      `${provider.name} returned an empty response`,
      provider.id,
      target.modelId
    );
  }
  return text;
}

async function callOpenAiCompatible(
  provider: InferenceProviderDefinition,
  target: InferenceTarget,
  apiKey: string,
  prompt: string,
  options: GenerateInferenceOptions,
  signal: AbortSignal
): Promise<string> {
  const baseUrl = provider.baseUrl?.replace(/\/+$/, '');
  if (!baseUrl) throw new Error(`Provider ${provider.name} has no API URL`);

  const messages = [
    ...(options.system ? [{ role: 'system', content: options.system }] : []),
    { role: 'user', content: prompt },
  ];
  const tokenField = provider.maxTokensParam || 'max_tokens';
  const body: Record<string, unknown> = {
    model: target.modelId,
    messages,
    [tokenField]: options.maxTokens ?? 1000,
  };
  if (options.temperature !== undefined) body.temperature = options.temperature;

  const response = await fetch(`${baseUrl}/chat/completions`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
      ...(provider.id === 'openrouter'
        ? { 'HTTP-Referer': 'https://github.com/standardagents/dmux', 'X-Title': 'dmux' }
        : {}),
    },
    body: JSON.stringify(body),
    signal,
  });

  if (!response.ok) {
    const detail = await readApiError(response);
    throw new InferenceRequestError(
      `${provider.name} API error (${target.modelId}): ${response.status} ${detail}`,
      provider.id,
      target.modelId,
      response.status
    );
  }

  const text = extractOpenAiText(await response.json());
  if (!text) {
    throw new InferenceRequestError(
      `${provider.name} returned an empty response`,
      provider.id,
      target.modelId
    );
  }
  return text;
}

async function callAnthropic(
  provider: InferenceProviderDefinition,
  target: InferenceTarget,
  apiKey: string,
  prompt: string,
  options: GenerateInferenceOptions,
  signal: AbortSignal
): Promise<string> {
  const response = await fetch(`${provider.baseUrl}/messages`, {
    method: 'POST',
    headers: {
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: target.modelId,
      max_tokens: options.maxTokens ?? 1000,
      ...(options.system ? { system: options.system } : {}),
      ...(options.temperature !== undefined ? { temperature: options.temperature } : {}),
      messages: [{ role: 'user', content: prompt }],
    }),
    signal,
  });
  if (!response.ok) {
    throw new InferenceRequestError(
      `${provider.name} API error (${target.modelId}): ${response.status} ${await readApiError(response)}`,
      provider.id,
      target.modelId,
      response.status
    );
  }
  const data = await response.json() as any;
  const text = (data?.content || [])
    .filter((part: any) => part?.type === 'text' && typeof part.text === 'string')
    .map((part: any) => part.text)
    .join('')
    .trim();
  if (!text) throw new Error(`${provider.name} returned an empty response`);
  return text;
}

async function callCohere(
  provider: InferenceProviderDefinition,
  target: InferenceTarget,
  apiKey: string,
  prompt: string,
  options: GenerateInferenceOptions,
  signal: AbortSignal
): Promise<string> {
  const response = await fetch(`${provider.baseUrl}/v2/chat`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: target.modelId,
      messages: [
        ...(options.system ? [{ role: 'system', content: options.system }] : []),
        { role: 'user', content: prompt },
      ],
      max_tokens: options.maxTokens ?? 1000,
      ...(options.temperature !== undefined ? { temperature: options.temperature } : {}),
    }),
    signal,
  });
  if (!response.ok) {
    throw new InferenceRequestError(
      `${provider.name} API error (${target.modelId}): ${response.status} ${await readApiError(response)}`,
      provider.id,
      target.modelId,
      response.status
    );
  }
  const data = await response.json() as any;
  const text = (data?.message?.content || [])
    .map((part: any) => part?.text)
    .filter((part: unknown): part is string => typeof part === 'string')
    .join('')
    .trim();
  if (!text) throw new Error(`${provider.name} returned an empty response`);
  return text;
}

async function callTarget(
  target: InferenceTarget,
  prompt: string,
  options: GenerateInferenceOptions
): Promise<string> {
  const provider = resolveInferenceProvider(target);
  if (!provider) throw new Error(`Unknown inference provider: ${target.providerId}`);

  if (provider.protocol === 'chatgpt') {
    return getCodexAppServerClient().generateText(target.modelId, prompt, {
      system: options.system,
      timeoutMs: options.timeoutMs,
      signal: options.signal,
      outputSchema: options.outputSchema,
    });
  }

  if (provider.protocol === 'grok-build') {
    return generateGrokBuildText(target.modelId, prompt, {
      system: options.system,
      timeoutMs: options.timeoutMs,
      signal: options.signal,
      outputSchema: options.outputSchema,
    });
  }

  const credential = await getInferenceApiKey(provider);
  if (!credential) {
    throw new InferenceRequestError(
      `Missing ${provider.envKeys[0] || 'API key'} for ${provider.name}`,
      provider.id,
      target.modelId
    );
  }

  const combined = combineSignals(options.signal, options.timeoutMs ?? 12_000);
  try {
    if (provider.protocol === 'openai-responses') {
      return await callOpenAiResponses(
        provider,
        target,
        credential.apiKey,
        prompt,
        options,
        combined.signal
      );
    }
    if (provider.protocol === 'anthropic') {
      return await callAnthropic(provider, target, credential.apiKey, prompt, options, combined.signal);
    }
    if (provider.protocol === 'cohere') {
      return await callCohere(provider, target, credential.apiKey, prompt, options, combined.signal);
    }
    return await callOpenAiCompatible(
      provider,
      target,
      credential.apiKey,
      prompt,
      options,
      combined.signal
    );
  } finally {
    combined.cleanup();
  }
}

export async function generateInferenceText(
  prompt: string,
  options: GenerateInferenceOptions = {}
): Promise<string | null> {
  const targets = options.targets ?? configuredTargets(options.projectRoot);
  if (targets.length === 0) return null;

  const errors: string[] = [];
  for (const target of targets) {
    try {
      return await callTarget(target, prompt, options);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      errors.push(message);
      LogService.getInstance().debug(
        `Inference failed with ${target.providerId}/${target.modelId}: ${message}`,
        'inference'
      );
      if (options.signal?.aborted) throw error;
    }
  }

  throw new Error(`All inference targets failed. ${errors.join(' | ')}`);
}

function normalizeModels(models: InferenceModel[], sort = true): InferenceModel[] {
  const seen = new Set<string>();
  const normalized = models.filter((model) => {
      if (!model.id || seen.has(model.id)) return false;
      seen.add(model.id);
      return true;
    });
  return sort
    ? normalized.sort((left, right) => left.name.localeCompare(right.name))
    : normalized;
}

export async function discoverInferenceModels(
  target: Omit<InferenceTarget, 'modelId'>
): Promise<InferenceModel[]> {
  const provider = resolveInferenceProvider({ ...target, modelId: '__discovery__' });
  if (!provider) throw new Error(`Unknown inference provider: ${target.providerId}`);

  if (provider.modelDiscovery === 'chatgpt') {
    return normalizeModels(await getCodexAppServerClient().listModels());
  }

  if (provider.modelDiscovery === 'grok-build') {
    // `grok models` places the account's default model first.
    return normalizeModels(await listGrokBuildModels(), false);
  }

  const credential = await getInferenceApiKey(provider);
  if (!credential) throw new Error(`Missing ${provider.envKeys[0]} for ${provider.name}`);

  let url: string;
  const headers: Record<string, string> = { Accept: 'application/json' };
  if (provider.modelDiscovery === 'google') {
    url = `https://generativelanguage.googleapis.com/v1beta/models?pageSize=1000&key=${encodeURIComponent(credential.apiKey)}`;
  } else if (provider.modelDiscovery === 'cohere') {
    url = `${provider.baseUrl}/v1/models?page_size=1000`;
    headers.Authorization = `Bearer ${credential.apiKey}`;
  } else {
    const modelUrl = `${provider.baseUrl?.replace(/\/+$/, '')}/models`;
    if (provider.protocol === 'anthropic') {
      url = `${modelUrl}?limit=1000`;
      headers['x-api-key'] = credential.apiKey;
      headers['anthropic-version'] = '2023-06-01';
    } else {
      url = modelUrl;
      headers.Authorization = `Bearer ${credential.apiKey}`;
    }
  }

  const combined = combineSignals(undefined, 15_000);
  try {
    const response = await fetch(url, { headers, signal: combined.signal });
    if (!response.ok) {
      throw new Error(`${provider.name} model discovery failed: ${response.status} ${await readApiError(response)}`);
    }
    const data = await response.json() as any;

    if (provider.modelDiscovery === 'google') {
      return normalizeModels(
        (data?.models || [])
          .filter((model: any) => model?.supportedGenerationMethods?.includes('generateContent'))
          .map((model: any) => ({
            id: String(model.name || '').replace(/^models\//, ''),
            name: model.displayName || String(model.name || '').replace(/^models\//, ''),
            description: model.description,
          }))
      );
    }

    if (provider.modelDiscovery === 'cohere') {
      return normalizeModels(
        (data?.models || [])
          .filter((model: any) => !Array.isArray(model?.endpoints) || model.endpoints.includes('chat'))
          .map((model: any) => ({ id: model.name, name: model.name, description: model.description }))
      );
    }

    return normalizeModels(
      (data?.data || []).map((model: any) => ({
        id: model.id,
        name: model.name || model.display_name || model.id,
        description: model.description,
      }))
    );
  } finally {
    combined.cleanup();
  }
}
