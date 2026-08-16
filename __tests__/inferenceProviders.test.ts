import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  buildEnvironmentExportLine,
  persistEnvironmentKeyToShell,
  upsertEnvironmentKeyBlock,
} from '../src/utils/envKeySetup.js';
import {
  isValidInferenceTarget,
  resolveInferenceProvider,
} from '../src/utils/inferenceProviders.js';
import {
  searchInferenceModels,
  searchInferenceProviders,
} from '../src/utils/inferenceSetup.js';
import { SettingsManager } from '../src/utils/settingsManager.js';

describe('inference provider setup', () => {
  afterEach(() => vi.restoreAllMocks());

  it('searches provider metadata and environment key names', () => {
    expect(searchInferenceProviders('cerebras')).toEqual([
      expect.objectContaining({
        id: 'cerebras',
        maxTokensParam: 'max_completion_tokens',
      }),
    ]);
    expect(searchInferenceProviders('GROQ_API_KEY')[0]?.id).toBe('groq');
    expect(searchInferenceProviders('openai compatible').some((provider) => provider.id === 'custom')).toBe(true);
    expect(searchInferenceProviders('SpaceXAI subscription')[0]).toMatchObject({
      id: 'grok-build',
      protocol: 'grok-build',
      modelDiscovery: 'grok-build',
    });
  });

  it('searches provider-supplied model catalogs without a hard-coded list', () => {
    const models = [
      { id: 'fast-1', name: 'Fast One', description: 'low latency' },
      { id: 'smart-2', name: 'Smart Two', description: 'reasoning model' },
    ];
    expect(searchInferenceModels(models, 'reasoning')).toEqual([models[1]]);
    expect(searchInferenceModels(models, 'fast-1')).toEqual([models[0]]);
  });

  it('validates and resolves a custom OpenAI-compatible target', () => {
    const target = {
      providerId: 'custom',
      providerName: 'Acme',
      baseUrl: 'https://models.acme.test/v1',
      envKey: 'ACME_API_KEY',
      modelId: 'acme-chat',
    };
    expect(isValidInferenceTarget(target)).toBe(true);
    expect(resolveInferenceProvider(target)).toMatchObject({
      name: 'Acme',
      baseUrl: 'https://models.acme.test/v1',
      protocol: 'openai-compatible',
    });
  });

  it('persists a generic provider key in a managed shell block', async () => {
    const homeDir = mkdtempSync(join(tmpdir(), 'dmux-inference-env-'));
    try {
      const shellFile = join(homeDir, '.zshrc');
      writeFileSync(shellFile, '# existing\n', 'utf-8');
      await persistEnvironmentKeyToShell('CEREBRAS_API_KEY', 'secret-value', {
        homeDir,
        shellPath: '/bin/zsh',
      });
      const content = readFileSync(shellFile, 'utf-8');
      expect(content).toContain('# >>> dmux inference CEREBRAS_API_KEY >>>');
      expect(content).toContain("export CEREBRAS_API_KEY='secret-value'");

      const next = upsertEnvironmentKeyBlock(
        content,
        'CEREBRAS_API_KEY',
        buildEnvironmentExportLine('CEREBRAS_API_KEY', 'replacement', '/bin/zsh')
      );
      expect(next).not.toContain('secret-value');
      expect(next).toContain('replacement');
    } finally {
      rmSync(homeDir, { recursive: true, force: true });
    }
  });

  it('round-trips primary and backup selections through settings', () => {
    const projectRoot = mkdtempSync(join(tmpdir(), 'dmux-inference-settings-'));
    try {
      const manager = new SettingsManager(projectRoot);
      manager.updateSettings({
        inferencePrimary: { providerId: 'cerebras', modelId: 'fast-model' },
        inferenceBackup: { providerId: 'openrouter', modelId: 'provider/backup-model' },
      }, 'project');

      const reloaded = new SettingsManager(projectRoot).getSettings();
      expect(reloaded.inferencePrimary).toEqual({ providerId: 'cerebras', modelId: 'fast-model' });
      expect(reloaded.inferenceBackup).toEqual({
        providerId: 'openrouter',
        modelId: 'provider/backup-model',
      });
    } finally {
      rmSync(projectRoot, { recursive: true, force: true });
    }
  });
});
