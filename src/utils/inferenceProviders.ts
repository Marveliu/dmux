import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import type { InferenceTarget } from '../types.js';

export type InferenceProtocol =
  | 'openai-compatible'
  | 'openai-responses'
  | 'anthropic'
  | 'cohere'
  | 'chatgpt'
  | 'grok-build';

export interface InferenceProviderDefinition {
  id: string;
  name: string;
  description: string;
  envKeys: string[];
  baseUrl?: string;
  protocol: InferenceProtocol;
  modelDiscovery?: 'openai' | 'google' | 'cohere' | 'chatgpt' | 'grok-build';
  maxTokensParam?: 'max_tokens' | 'max_completion_tokens';
  custom?: boolean;
}

export interface InferenceModel {
  id: string;
  name: string;
  description?: string;
}

/**
 * Providers with a stable text-generation API. Model ids intentionally do not
 * live here: the setup flow asks each provider for its current catalog.
 */
export const INFERENCE_PROVIDERS: readonly InferenceProviderDefinition[] = [
  {
    id: 'chatgpt',
    name: 'ChatGPT subscription',
    description: 'Use a Codex/ChatGPT login and included plan usage',
    envKeys: [],
    protocol: 'chatgpt',
    modelDiscovery: 'chatgpt',
  },
  {
    id: 'grok-build',
    name: 'Grok Build subscription',
    description: 'Use a SpaceXAI Grok Build login and included plan usage',
    envKeys: [],
    protocol: 'grok-build',
    modelDiscovery: 'grok-build',
  },
  {
    id: 'openrouter',
    name: 'OpenRouter',
    description: 'One API key for models from many providers',
    envKeys: ['OPENROUTER_API_KEY'],
    baseUrl: 'https://openrouter.ai/api/v1',
    protocol: 'openai-compatible',
    modelDiscovery: 'openai',
  },
  {
    id: 'openai',
    name: 'OpenAI API',
    description: 'Usage-based OpenAI Platform access',
    envKeys: ['OPENAI_API_KEY'],
    baseUrl: 'https://api.openai.com/v1',
    protocol: 'openai-responses',
    modelDiscovery: 'openai',
  },
  {
    id: 'anthropic',
    name: 'Anthropic',
    description: 'Claude models through the Anthropic API',
    envKeys: ['ANTHROPIC_API_KEY'],
    baseUrl: 'https://api.anthropic.com/v1',
    protocol: 'anthropic',
    modelDiscovery: 'openai',
  },
  {
    id: 'google',
    name: 'Google Gemini',
    description: 'Gemini models through Google AI Studio',
    envKeys: ['GOOGLE_GENERATIVE_AI_API_KEY', 'GOOGLE_API_KEY', 'GEMINI_API_KEY'],
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai',
    protocol: 'openai-compatible',
    modelDiscovery: 'google',
  },
  {
    id: 'xai',
    name: 'xAI',
    description: 'Grok models through the xAI API',
    envKeys: ['XAI_API_KEY'],
    baseUrl: 'https://api.x.ai/v1',
    protocol: 'openai-compatible',
    modelDiscovery: 'openai',
  },
  {
    id: 'groq',
    name: 'Groq',
    description: 'Low-latency inference on Groq',
    envKeys: ['GROQ_API_KEY'],
    baseUrl: 'https://api.groq.com/openai/v1',
    protocol: 'openai-compatible',
    modelDiscovery: 'openai',
  },
  {
    id: 'cerebras',
    name: 'Cerebras',
    description: 'Fast inference through Cerebras Inference',
    envKeys: ['CEREBRAS_API_KEY'],
    baseUrl: 'https://api.cerebras.ai/v1',
    protocol: 'openai-compatible',
    modelDiscovery: 'openai',
    maxTokensParam: 'max_completion_tokens',
  },
  {
    id: 'deepseek',
    name: 'DeepSeek',
    description: 'DeepSeek chat and reasoning models',
    envKeys: ['DEEPSEEK_API_KEY'],
    baseUrl: 'https://api.deepseek.com',
    protocol: 'openai-compatible',
    modelDiscovery: 'openai',
  },
  {
    id: 'mistral',
    name: 'Mistral AI',
    description: 'Mistral models through La Plateforme',
    envKeys: ['MISTRAL_API_KEY'],
    baseUrl: 'https://api.mistral.ai/v1',
    protocol: 'openai-compatible',
    modelDiscovery: 'openai',
  },
  {
    id: 'together',
    name: 'Together AI',
    description: 'Open and proprietary models on Together',
    envKeys: ['TOGETHER_API_KEY', 'TOGETHER_AI_API_KEY'],
    baseUrl: 'https://api.together.xyz/v1',
    protocol: 'openai-compatible',
    modelDiscovery: 'openai',
  },
  {
    id: 'fireworks',
    name: 'Fireworks AI',
    description: 'Serverless inference through Fireworks',
    envKeys: ['FIREWORKS_API_KEY'],
    baseUrl: 'https://api.fireworks.ai/inference/v1',
    protocol: 'openai-compatible',
    modelDiscovery: 'openai',
  },
  {
    id: 'perplexity',
    name: 'Perplexity',
    description: 'Agent API models and search-oriented Sonar presets',
    envKeys: ['PERPLEXITY_API_KEY'],
    baseUrl: 'https://api.perplexity.ai/v1',
    protocol: 'openai-responses',
    modelDiscovery: 'openai',
  },
  {
    id: 'cohere',
    name: 'Cohere',
    description: 'Command models through the Cohere API',
    envKeys: ['COHERE_API_KEY'],
    baseUrl: 'https://api.cohere.com',
    protocol: 'cohere',
    modelDiscovery: 'cohere',
  },
  {
    id: 'vercel',
    name: 'Vercel AI Gateway',
    description: 'Models routed through Vercel AI Gateway',
    envKeys: ['AI_GATEWAY_API_KEY'],
    baseUrl: 'https://ai-gateway.vercel.sh/v1',
    protocol: 'openai-compatible',
    modelDiscovery: 'openai',
  },
  {
    id: 'huggingface',
    name: 'Hugging Face',
    description: 'Models available through the HF inference router',
    envKeys: ['HF_TOKEN', 'HUGGING_FACE_HUB_TOKEN'],
    baseUrl: 'https://router.huggingface.co/v1',
    protocol: 'openai-compatible',
    modelDiscovery: 'openai',
  },
  {
    id: 'custom',
    name: 'Custom OpenAI-compatible',
    description: 'Any service exposing /models and /chat/completions',
    envKeys: [],
    protocol: 'openai-compatible',
    modelDiscovery: 'openai',
    custom: true,
  },
] as const;

const CREDENTIALS_PATH = path.join(os.homedir(), '.dmux', 'inference-credentials.json');

export function getInferenceProvider(id: string): InferenceProviderDefinition | undefined {
  return INFERENCE_PROVIDERS.find((provider) => provider.id === id);
}

export function resolveInferenceProvider(target: InferenceTarget): InferenceProviderDefinition | undefined {
  const registered = getInferenceProvider(target.providerId);
  if (registered && !registered.custom) {
    return registered;
  }

  if (
    target.providerId === 'custom'
    && target.baseUrl
    && target.envKey
  ) {
    return {
      id: 'custom',
      name: target.providerName || 'Custom provider',
      description: 'Custom OpenAI-compatible inference provider',
      envKeys: [target.envKey],
      baseUrl: target.baseUrl.replace(/\/+$/, ''),
      protocol: 'openai-compatible',
      modelDiscovery: 'openai',
      custom: true,
    };
  }

  return registered;
}

async function readStoredCredentials(): Promise<Record<string, string>> {
  try {
    const parsed = JSON.parse(await fs.readFile(CREDENTIALS_PATH, 'utf-8')) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    return Object.fromEntries(
      Object.entries(parsed as Record<string, unknown>)
        .filter((entry): entry is [string, string] => typeof entry[1] === 'string')
    );
  } catch {
    return {};
  }
}

export async function getInferenceApiKey(
  provider: InferenceProviderDefinition
): Promise<{ envKey: string; apiKey: string } | null> {
  for (const envKey of provider.envKeys) {
    const apiKey = process.env[envKey]?.trim();
    if (apiKey) return { envKey, apiKey };
  }

  const stored = await readStoredCredentials();
  for (const envKey of provider.envKeys) {
    const apiKey = stored[envKey]?.trim();
    if (apiKey) return { envKey, apiKey };
  }

  return null;
}

export function hasInferenceApiKeySync(provider: InferenceProviderDefinition): boolean {
  return provider.envKeys.some((envKey) => Boolean(process.env[envKey]?.trim()));
}

export async function storeInferenceCredential(envKey: string, apiKey: string): Promise<void> {
  const normalizedEnvKey = envKey.trim();
  const normalizedApiKey = apiKey.trim();
  if (!/^[A-Z_][A-Z0-9_]*$/.test(normalizedEnvKey)) {
    throw new Error('Environment variable names may only contain uppercase letters, digits, and underscores');
  }
  if (!normalizedApiKey) {
    throw new Error('API key cannot be empty');
  }

  const stored = await readStoredCredentials();
  await fs.mkdir(path.dirname(CREDENTIALS_PATH), { recursive: true, mode: 0o700 });
  await fs.writeFile(
    CREDENTIALS_PATH,
    JSON.stringify({ ...stored, [normalizedEnvKey]: normalizedApiKey }, null, 2),
    { encoding: 'utf-8', mode: 0o600 }
  );
  await fs.chmod(CREDENTIALS_PATH, 0o600);
  process.env[normalizedEnvKey] = normalizedApiKey;
}

export function isValidInferenceTarget(value: unknown): value is InferenceTarget {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const target = value as Record<string, unknown>;
  if (
    typeof target.providerId !== 'string'
    || !target.providerId
    || typeof target.modelId !== 'string'
    || !target.modelId
  ) {
    return false;
  }

  if (target.providerId !== 'custom') {
    return Boolean(getInferenceProvider(target.providerId));
  }

  return (
    typeof target.baseUrl === 'string'
    && /^https?:\/\//.test(target.baseUrl)
    && typeof target.envKey === 'string'
    && /^[A-Z_][A-Z0-9_]*$/.test(target.envKey)
    && (target.providerName === undefined || typeof target.providerName === 'string')
  );
}

export function describeInferenceTarget(target: InferenceTarget | null | undefined): string {
  if (!target) return 'Not configured';
  const provider = resolveInferenceProvider(target);
  return `${provider?.name || target.providerName || target.providerId} / ${target.modelId}`;
}
