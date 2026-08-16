import { describe, expect, it } from 'vitest';
import { parseGrokModelsOutput } from '../src/services/GrokBuildClient.js';

describe('GrokBuildClient', () => {
  it('parses the dynamic CLI model catalog and authentication state', () => {
    expect(parseGrokModelsOutput([
      'Default model: grok-4.6',
      '',
      'Available models:',
      '  * grok-4.6 (default)',
      '  - grok-4.5',
    ].join('\n'))).toEqual({
      authenticated: true,
      defaultModel: 'grok-4.6',
      models: [
        { id: 'grok-4.6', name: 'grok-4.6' },
        { id: 'grok-4.5', name: 'grok-4.5' },
      ],
    });
  });

  it('does not confuse API-key model availability with a subscription login', () => {
    const status = parseGrokModelsOutput([
      'You are not authenticated.',
      'Default model: grok-4.6',
      'Available models:',
      '  * grok-4.6 (default)',
    ].join('\n'));
    expect(status.authenticated).toBe(false);
    expect(status.models.map((model) => model.id)).toEqual(['grok-4.6']);
  });
});
