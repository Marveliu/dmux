import React from 'react';
import { render } from 'ink';
import { InferenceSetupApp } from '../components/popups/inferenceSetupPopup.js';
import type { InferenceTarget } from '../types.js';
import type { InferenceModel, InferenceProviderDefinition } from './inferenceProviders.js';
import { rankInferenceModels, rankInferenceProviders } from './inferenceWizard.js';

export interface InferenceSetupResult {
  primary: InferenceTarget;
  backup: InferenceTarget | null;
}

/**
 * Backwards-compatible search exports for integrations that used the original
 * readline setup flow. The Ink wizard uses the same fuzzy ranking helpers.
 */
export function searchInferenceProviders(query: string): InferenceProviderDefinition[] {
  return rankInferenceProviders(query);
}

export function searchInferenceModels(
  models: InferenceModel[],
  query: string
): InferenceModel[] {
  return rankInferenceModels(models, query);
}

/**
 * Render the same interactive wizard used by the settings popup during
 * first-run onboarding. Keeping one UI prevents the old numbered/readline
 * selector from resurfacing outside tmux popups.
 */
export async function runInferenceSetup(): Promise<InferenceSetupResult | null> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) return null;

  return new Promise((resolve) => {
    let settled = false;
    const settle = (result: InferenceSetupResult | null) => {
      if (settled) return;
      settled = true;
      resolve(result);
    };

    const app = render(
      React.createElement(InferenceSetupApp, { onComplete: settle }),
      { exitOnCtrlC: false }
    );

    app.waitUntilExit()
      .then(() => settle(null))
      .catch(() => settle(null));
  });
}
