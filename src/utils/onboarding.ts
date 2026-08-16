import chalk from 'chalk';
import os from 'os';
import { createInterface } from 'node:readline/promises';
import { LogService } from '../services/LogService.js';
import { runTmuxConfigOnboardingIfNeeded } from './tmuxConfigOnboarding.js';
import {
  hasCompletedInferenceProviderOnboarding,
  writeInferenceProviderOnboardingState,
} from './openRouterApiKeySetup.js';
import { runInferenceSetup } from './inferenceSetup.js';
import { SettingsManager } from './settingsManager.js';

async function promptYesNo(question: string, defaultYes: boolean = true): Promise<boolean> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    return false;
  }

  const suffix = defaultYes ? '[Y/n]' : '[y/N]';
  const rl = createInterface({ input: process.stdin, output: process.stdout });

  try {
    const answer = (await rl.question(`${question} ${suffix} `)).trim().toLowerCase();
    if (!answer) return defaultYes;
    if (answer === 'y' || answer === 'yes') return true;
    if (answer === 'n' || answer === 'no') return false;
    return defaultYes;
  } finally {
    rl.close();
  }
}

export async function runInferenceProviderOnboardingIfNeeded(): Promise<void> {
  const logger = LogService.getInstance();

  try {
    const homeDir = process.env.HOME || os.homedir();
    if (!homeDir) {
      return;
    }

    const settingsManager = new SettingsManager(process.cwd());
    if (settingsManager.getSettings().inferencePrimary) {
      await writeInferenceProviderOnboardingState(homeDir, 'configured');
      return;
    }

    const completed = await hasCompletedInferenceProviderOnboarding(homeDir);
    if (completed) {
      return;
    }

    if (!process.stdin.isTTY || !process.stdout.isTTY) {
      logger.debug(
        'Skipping inference provider onboarding because terminal is non-interactive',
        'onboarding'
      );
      return;
    }

    const shouldConfigure = await promptYesNo(
      'Configure an inference provider for AI-powered dmux features?',
      true
    );

    if (!shouldConfigure) {
      await writeInferenceProviderOnboardingState(homeDir, 'skip');
      return;
    }

    const configured = await runInferenceSetup();
    if (!configured) {
      console.log(chalk.yellow('Skipping inference setup.'));
      await writeInferenceProviderOnboardingState(homeDir, 'skip');
      return;
    }
    settingsManager.updateSettings(
      {
        inferencePrimary: configured.primary,
        inferenceBackup: configured.backup,
      },
      'global'
    );
    await writeInferenceProviderOnboardingState(homeDir, 'configured');
    console.log(chalk.green('Saved inference provider settings.'));
  } catch (error) {
    logger.warn(
      `Inference provider onboarding failed: ${error instanceof Error ? error.message : String(error)}`,
      'onboarding'
    );
  }
}

/** @deprecated Kept for API compatibility with older integrations. */
export const runOpenRouterApiKeyOnboardingIfNeeded = runInferenceProviderOnboardingIfNeeded;

/**
 * Run all first-run onboarding checks in one place.
 * This currently includes:
 * - tmux config suggestion/setup
 * - inference provider/model setup
 */
export async function runFirstRunOnboardingIfNeeded(): Promise<void> {
  await runTmuxConfigOnboardingIfNeeded();
  await runInferenceProviderOnboardingIfNeeded();
}
