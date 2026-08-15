#!/usr/bin/env node

/**
 * Standalone popup for configuring inference providers.
 *
 * A progressive wizard: provider picker (fuzzy search) → credential entry when
 * missing → dynamically discovered model picker → optional backup target →
 * review-and-save summary. Writes the standard popup result shape
 * `{ primary, backup }` consumed by PopupManager.
 */

import React, { useEffect, useMemo, useRef, useState } from 'react';
import { render, Box, Text, useApp, useInput } from 'ink';
import { pathToFileURL } from 'url';
import CleanTextInput from '../inputs/CleanTextInput.js';
import Spinner from '../indicators/Spinner.js';
import {
  PopupContainer,
  PopupWrapper,
  writeCancelAndExit,
  writeSuccessAndExit,
} from './shared/index.js';
import { POPUP_CONFIG } from './config.js';
import type { InferenceTarget } from '../../types.js';
import {
  getInferenceApiKey,
  resolveInferenceProvider,
  storeInferenceCredential,
  type InferenceModel,
  type InferenceProviderDefinition,
} from '../../utils/inferenceProviders.js';
import { persistEnvironmentKeyToShell } from '../../utils/envKeySetup.js';
import { discoverInferenceModels } from '../../services/InferenceService.js';
import {
  getCodexAppServerClient,
  resetCodexAppServerClient,
} from '../../services/CodexAppServerClient.js';
import {
  getGrokBuildStatus,
  loginToGrokBuild,
} from '../../services/GrokBuildClient.js';
import {
  buildCustomPartialTarget,
  clampSelection,
  detectChatGptAccount,
  detectGrokBuildAccount,
  detectProviderCredentials,
  getVisibleWindow,
  isValidCustomBaseUrl,
  isValidEnvKeyName,
  normalizeEnvKeyName,
  rankInferenceModels,
  rankInferenceProviders,
  sanitizeSearchQuery,
  type ProviderCredentialBadge,
} from '../../utils/inferenceWizard.js';

type TargetLabel = 'primary' | 'backup';

interface TargetDraft {
  provider?: InferenceProviderDefinition;
  partialTarget?: Omit<InferenceTarget, 'modelId'>;
  credentialNote?: string;
  models?: InferenceModel[];
  modelId?: string;
}

type Step =
  | { kind: 'provider'; target: TargetLabel }
  | { kind: 'custom'; target: TargetLabel }
  | { kind: 'credential'; target: TargetLabel }
  | { kind: 'chatgpt'; target: TargetLabel }
  | { kind: 'grokBuild'; target: TargetLabel }
  | { kind: 'models'; target: TargetLabel }
  | { kind: 'backupOffer' }
  | { kind: 'summary' };

const LIST_MAX_VISIBLE = 8;
const ROW_MAX_WIDTH = 78;
const LIST_COL_WIDTH = 48;
const DETAIL_COL_WIDTH = 34;
// Fixed 2-character marker gutter so every row label starts at the same x.
const MARKER_SELECTED = '▸ ';
const MARKER_BLANK = '  ';

function truncate(text: string, maxWidth = ROW_MAX_WIDTH): string {
  // eslint-disable-next-line no-control-regex
  const clean = text.replace(/[\x00-\x1f\x7f]/g, '');
  return clean.length > maxWidth ? `${clean.slice(0, maxWidth - 1)}…` : clean;
}

function targetTitle(target: TargetLabel): string {
  return target === 'primary' ? 'Primary' : 'Backup';
}

/* ------------------------------------------------------------------ */
/* Small building blocks                                              */
/* ------------------------------------------------------------------ */

interface ScrollListProps<T> {
  items: T[];
  selectedIndex: number;
  maxVisible?: number;
  renderItem: (item: T, isSelected: boolean, index: number) => React.ReactNode;
}

function ScrollList<T>({
  items,
  selectedIndex,
  maxVisible = LIST_MAX_VISIBLE,
  renderItem,
}: ScrollListProps<T>) {
  const { start, end } = getVisibleWindow(selectedIndex, items.length, maxVisible);
  return (
    <Box flexDirection="column">
      {start > 0 && <Text dimColor>{'  ↑ '}{start} more</Text>}
      {items.slice(start, end).map((item, offset) => {
        const index = start + offset;
        return (
          <React.Fragment key={index}>
            {renderItem(item, index === selectedIndex, index)}
          </React.Fragment>
        );
      })}
      {end < items.length && <Text dimColor>{'  ↓ '}{items.length - end} more</Text>}
    </Box>
  );
}

interface SearchFieldProps {
  value: string;
  onChange: (next: string) => void;
  onSubmit: () => void;
  placeholder: string;
}

/** Full-width bordered search input shared by the list screens. */
const SearchField: React.FC<SearchFieldProps> = ({ value, onChange, onSubmit, placeholder }) => (
  <Box
    borderStyle="round"
    borderColor={POPUP_CONFIG.inputBorderColor}
    paddingX={1}
    width="100%"
  >
    <CleanTextInput
      value={value}
      onChange={onChange}
      onSubmit={onSubmit}
      placeholder={placeholder}
      maxWidth={ROW_MAX_WIDTH}
      disableUpDownArrows={true}
      disableEscape={true}
      ignoreFocus={true}
    />
  </Box>
);

interface MaskedSecretInputProps {
  onSubmit: (secret: string) => void;
  onBack: () => void;
}

/**
 * A write-only secret field: characters are captured but rendered as bullets
 * and the buffer never leaves this component except through onSubmit.
 */
const MaskedSecretInput: React.FC<MaskedSecretInputProps> = ({ onSubmit, onBack }) => {
  const [length, setLength] = useState(0);
  const bufferRef = useRef('');

  useInput((input, key) => {
    if (key.escape) {
      bufferRef.current = '';
      onBack();
      return;
    }
    if (key.return) {
      const secret = bufferRef.current.trim();
      if (secret) {
        bufferRef.current = '';
        onSubmit(secret);
      }
      return;
    }
    if (key.backspace || key.delete) {
      bufferRef.current = bufferRef.current.slice(0, -1);
      setLength(bufferRef.current.length);
      return;
    }
    if (key.ctrl && input === 'u') {
      bufferRef.current = '';
      setLength(0);
      return;
    }
    if (key.ctrl || key.meta || key.upArrow || key.downArrow || key.leftArrow || key.rightArrow || key.tab) {
      return;
    }
    const printable = input
      .replace(/\u001b\[\d+~/g, '')
      // eslint-disable-next-line no-control-regex
      .replace(/[\x00-\x1f\x7f]/g, '');
    if (printable) {
      bufferRef.current += printable;
      setLength(bufferRef.current.length);
    }
  });

  const shown = Math.min(length, 40);
  return (
    <Box borderStyle={POPUP_CONFIG.inputBorderStyle} borderColor={POPUP_CONFIG.inputBorderColor} paddingX={1}>
      <Text color={POPUP_CONFIG.titleColor}>{'> '}</Text>
      <Text>
        {'•'.repeat(shown)}
        {length > shown ? '…' : ''}
      </Text>
      <Text inverse> </Text>
      {length === 0 && <Text dimColor> paste or type your API key</Text>}
    </Box>
  );
};

/* ------------------------------------------------------------------ */
/* Provider picker                                                    */
/* ------------------------------------------------------------------ */

interface ProviderScreenProps {
  target: TargetLabel;
  badges: Map<string, ProviderCredentialBadge>;
  onChoose: (provider: InferenceProviderDefinition) => void;
  onBack: () => void;
}

const ProviderScreen: React.FC<ProviderScreenProps> = ({
  target,
  badges,
  onChoose,
  onBack,
}) => {
  const [query, setQuery] = useState('');
  const [selectedIndex, setSelectedIndex] = useState(0);

  const ranked = useMemo(() => rankInferenceProviders(query), [query]);

  const prevQueryRef = useRef(query);
  if (prevQueryRef.current !== query) {
    prevQueryRef.current = query;
    if (selectedIndex !== 0) setSelectedIndex(0);
  }

  useInput((_input, key) => {
    if (key.escape) {
      if (query) setQuery('');
      else onBack();
      return;
    }
    if (key.downArrow) {
      setSelectedIndex((prev) => clampSelection(prev + 1, ranked.length));
      return;
    }
    if (key.upArrow) {
      setSelectedIndex((prev) => clampSelection(prev - 1, ranked.length));
    }
  });

  const handleSubmit = () => {
    const provider = ranked[clampSelection(selectedIndex, ranked.length)];
    if (provider) onChoose(provider);
  };

  const selected = ranked[clampSelection(selectedIndex, ranked.length)];

  return (
    <Box flexDirection="column">
      <Text bold>{targetTitle(target)} provider</Text>
      <Text dimColor>
        {target === 'primary'
          ? 'Powers pane analysis, names, summaries, and merges.'
          : 'Used automatically when the primary provider fails.'}
      </Text>
      <Box marginTop={1}>
        <SearchField
          value={query}
          onChange={setQuery}
          onSubmit={handleSubmit}
          placeholder="Search providers…"
        />
      </Box>
      <Box marginTop={1}>
        {ranked.length === 0 ? (
          <Text color={POPUP_CONFIG.errorColor}>
            No providers match “{truncate(query, 40)}”. Press ESC to clear the search.
          </Text>
        ) : (
          <>
            <Box width={LIST_COL_WIDTH} flexDirection="column">
              <ScrollList
                items={ranked}
                selectedIndex={selectedIndex}
                renderItem={(provider, isSelected) => {
                  const badge = badges.get(provider.id);
                  const badgeText = badge
                    ? badge.kind === 'api-key'
                      ? '✓ key detected'
                      : '✓ signed in'
                    : provider.custom
                      ? 'your endpoint'
                      : '';
                  return (
                    <Box key={provider.id} width={LIST_COL_WIDTH} paddingRight={1}>
                      <Text color={isSelected ? POPUP_CONFIG.titleColor : undefined} bold={isSelected}>
                        {isSelected ? MARKER_SELECTED : MARKER_BLANK}
                        {truncate(provider.name, 30)}
                      </Text>
                      <Box flexGrow={1} />
                      {badgeText && (
                        <Text color={badge ? POPUP_CONFIG.successColor : undefined} dimColor={!badge}>
                          {badgeText}
                        </Text>
                      )}
                    </Box>
                  );
                }}
              />
            </Box>
            <Box
              width={DETAIL_COL_WIDTH}
              flexDirection="column"
              borderStyle="single"
              borderColor="gray"
              borderTop={false}
              borderRight={false}
              borderBottom={false}
              paddingLeft={1}
            >
              {selected && (
                <>
                  <Text bold>{truncate(selected.name, DETAIL_COL_WIDTH - 2)}</Text>
                  <Text dimColor wrap="wrap">{selected.description}</Text>
                  {badges.get(selected.id)?.kind === 'api-key' && (
                    <Box marginTop={1}>
                      <Text color={POPUP_CONFIG.successColor} wrap="wrap">
                        Found {(badges.get(selected.id) as { envKey: string }).envKey} — no key entry needed.
                      </Text>
                    </Box>
                  )}
                </>
              )}
            </Box>
          </>
        )}
      </Box>
    </Box>
  );
};

/* ------------------------------------------------------------------ */
/* Custom provider form                                               */
/* ------------------------------------------------------------------ */

interface CustomScreenProps {
  onComplete: (fields: { name: string; baseUrl: string; envKey: string }) => void;
  onBack: () => void;
}

const CUSTOM_FIELDS = [
  {
    key: 'name' as const,
    label: 'Display name',
    placeholder: 'Acme AI (optional)',
    hint: 'Shown in dmux settings and summaries.',
  },
  {
    key: 'baseUrl' as const,
    label: 'Base URL',
    placeholder: 'https://api.acme.dev/v1',
    hint: 'An OpenAI-compatible endpoint exposing /models and /chat/completions.',
  },
  {
    key: 'envKey' as const,
    label: 'API-key environment variable',
    placeholder: 'ACME_API_KEY',
    hint: 'Uppercase letters, digits, and underscores.',
  },
];

const CustomScreen: React.FC<CustomScreenProps> = ({ onComplete, onBack }) => {
  const [fieldIndex, setFieldIndex] = useState(0);
  const [values, setValues] = useState({ name: '', baseUrl: '', envKey: '' });
  const [error, setError] = useState<string | null>(null);

  const field = CUSTOM_FIELDS[fieldIndex];

  useInput((_input, key) => {
    if (key.escape) {
      setError(null);
      if (fieldIndex > 0) setFieldIndex(fieldIndex - 1);
      else onBack();
    }
  });

  const handleSubmit = () => {
    const value = values[field.key].trim();
    if (field.key === 'baseUrl' && !isValidCustomBaseUrl(value)) {
      setError('Enter a full http:// or https:// URL.');
      return;
    }
    if (field.key === 'envKey') {
      if (!isValidEnvKeyName(value)) {
        setError('Use uppercase letters, digits, and underscores (for example ACME_API_KEY).');
        return;
      }
      onComplete({ ...values, envKey: normalizeEnvKeyName(value) });
      return;
    }
    setError(null);
    setFieldIndex(fieldIndex + 1);
  };

  return (
    <Box flexDirection="column">
      <Text bold>Custom OpenAI-compatible provider</Text>
      <Text dimColor>
        Step {fieldIndex + 1} of {CUSTOM_FIELDS.length}
      </Text>
      {CUSTOM_FIELDS.slice(0, fieldIndex).map((done) => (
        <Box key={done.key} marginTop={done.key === 'name' ? 1 : 0}>
          <Text color={POPUP_CONFIG.successColor}>✓ </Text>
          <Text dimColor>
            {done.label}: {values[done.key].trim() || (done.key === 'name' ? 'Custom provider' : '')}
          </Text>
        </Box>
      ))}
      <Box marginTop={1} flexDirection="column">
        <Text>{field.label}</Text>
        <CleanTextInput
          value={values[field.key]}
          onChange={(next) => {
            setError(null);
            setValues((prev) => ({ ...prev, [field.key]: next }));
          }}
          onSubmit={handleSubmit}
          placeholder={field.placeholder}
          maxWidth={ROW_MAX_WIDTH}
          disableUpDownArrows={true}
          disableEscape={true}
          ignoreFocus={true}
        />
        <Text dimColor>{field.hint}</Text>
      </Box>
      {error && (
        <Box marginTop={1}>
          <Text color={POPUP_CONFIG.errorColor}>{error}</Text>
        </Box>
      )}
    </Box>
  );
};

/* ------------------------------------------------------------------ */
/* API-key credential screen                                          */
/* ------------------------------------------------------------------ */

interface CredentialScreenProps {
  provider: InferenceProviderDefinition;
  onReady: (note: string) => void;
  onBack: () => void;
}

const CredentialScreen: React.FC<CredentialScreenProps> = ({ provider, onReady, onBack }) => {
  const [phase, setPhase] = useState<'checking' | 'enter' | 'saving' | 'error'>('checking');
  const [errorMessage, setErrorMessage] = useState('');
  const aliveRef = useRef(true);
  const envKey = provider.envKeys[0];

  useEffect(() => {
    (async () => {
      try {
        const existing = await getInferenceApiKey(provider);
        if (!aliveRef.current) return;
        if (existing) {
          onReady(`Using ${existing.envKey} from your environment`);
          return;
        }
      } catch {
        // Fall through to manual entry.
      }
      if (aliveRef.current) setPhase(envKey ? 'enter' : 'error');
      if (aliveRef.current && !envKey) {
        setErrorMessage(`${provider.name} does not define an API-key environment variable.`);
      }
    })();
    return () => {
      aliveRef.current = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useInput((_input, key) => {
    if (phase !== 'enter' && key.escape) {
      onBack();
      return;
    }
    if (phase === 'error' && key.return && envKey) {
      setErrorMessage('');
      setPhase('enter');
    }
  });

  const handleSecret = async (secret: string) => {
    setPhase('saving');
    try {
      await storeInferenceCredential(envKey, secret);
      const { shellConfigPath } = await persistEnvironmentKeyToShell(envKey, secret);
      if (!aliveRef.current) return;
      onReady(`Saved ${envKey} to ${shellConfigPath}`);
    } catch (error) {
      if (!aliveRef.current) return;
      setErrorMessage(error instanceof Error ? error.message : String(error));
      setPhase('error');
    }
  };

  return (
    <Box flexDirection="column">
      <Text bold>{provider.name} API key</Text>
      {phase === 'checking' && (
        <Box marginTop={1}>
          <Spinner color={POPUP_CONFIG.titleColor} />
          <Text> Checking for an existing key…</Text>
        </Box>
      )}
      {phase === 'enter' && (
        <>
          <Text dimColor>No {envKey} was found. Paste one to continue.</Text>
          <Box marginTop={1} flexDirection="column">
            <Text>{envKey}</Text>
            <MaskedSecretInput onSubmit={(secret) => void handleSecret(secret)} onBack={onBack} />
            <Text dimColor>
              Input stays hidden. The key is saved to your shell profile and ~/.dmux for future sessions.
            </Text>
          </Box>
        </>
      )}
      {phase === 'saving' && (
        <Box marginTop={1}>
          <Spinner color={POPUP_CONFIG.titleColor} />
          <Text> Saving {envKey}…</Text>
        </Box>
      )}
      {phase === 'error' && (
        <Box marginTop={1} flexDirection="column">
          <Text color={POPUP_CONFIG.errorColor}>{truncate(errorMessage, 160)}</Text>
          {envKey ? (
            <Text dimColor>Enter to try again • ESC to go back</Text>
          ) : (
            <Text dimColor>ESC to go back</Text>
          )}
        </Box>
      )}
    </Box>
  );
};

/* ------------------------------------------------------------------ */
/* ChatGPT (Codex) sign-in screen                                     */
/* ------------------------------------------------------------------ */

interface ChatGptScreenProps {
  onReady: (note: string) => void;
  onBack: () => void;
}

const ChatGptScreen: React.FC<ChatGptScreenProps> = ({ onReady, onBack }) => {
  const [phase, setPhase] = useState<'checking' | 'signedOut' | 'waiting' | 'error'>('checking');
  const [authUrl, setAuthUrl] = useState<string | null>(null);
  const [errorMessage, setErrorMessage] = useState('');
  const aliveRef = useRef(true);

  useEffect(() => {
    return () => {
      aliveRef.current = false;
    };
  }, []);

  const checkAccount = async () => {
    setPhase('checking');
    try {
      const account = await getCodexAppServerClient().getAccount();
      if (!aliveRef.current) return;
      if (account?.type === 'chatgpt') {
        onReady(`Using ChatGPT${account.email ? ` as ${account.email}` : ''}`);
        return;
      }
      setPhase('signedOut');
    } catch (error) {
      if (!aliveRef.current) return;
      setErrorMessage(
        `Codex CLI is required for ChatGPT subscription inference: ${
          error instanceof Error ? error.message : String(error)
        }`
      );
      setPhase('error');
    }
  };

  useEffect(() => {
    void checkAccount();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const startLogin = async () => {
    setPhase('waiting');
    setAuthUrl(null);
    try {
      const client = getCodexAppServerClient();
      const login = await client.startChatGptLogin();
      if (!aliveRef.current) return;
      setAuthUrl(login.authUrl || login.verificationUrl || null);
      await client.waitForLogin(login.loginId);
      if (!aliveRef.current) return;
      const account = await client.getAccount();
      if (!aliveRef.current) return;
      if (account?.type === 'chatgpt') {
        onReady(`Using ChatGPT${account.email ? ` as ${account.email}` : ''}`);
      } else {
        setErrorMessage('Codex is not signed in with a ChatGPT subscription.');
        setPhase('error');
      }
    } catch (error) {
      if (!aliveRef.current) return;
      setErrorMessage(error instanceof Error ? error.message : String(error));
      setPhase('error');
    }
  };

  useInput((_input, key) => {
    if (key.escape) {
      onBack();
      return;
    }
    if (key.return) {
      if (phase === 'signedOut') void startLogin();
      if (phase === 'error') {
        resetCodexAppServerClient();
        setErrorMessage('');
        void checkAccount();
      }
    }
  });

  return (
    <Box flexDirection="column">
      <Text bold>ChatGPT subscription</Text>
      {phase === 'checking' && (
        <Box marginTop={1}>
          <Spinner color={POPUP_CONFIG.titleColor} />
          <Text> Checking your Codex login…</Text>
        </Box>
      )}
      {phase === 'signedOut' && (
        <Box marginTop={1} flexDirection="column">
          <Text>No ChatGPT login was found.</Text>
          <Text dimColor>Press Enter to sign in — your browser will open to authorize Codex.</Text>
        </Box>
      )}
      {phase === 'waiting' && (
        <Box marginTop={1} flexDirection="column">
          <Box>
            <Spinner color={POPUP_CONFIG.titleColor} />
            <Text> Waiting for you to finish signing in…</Text>
          </Box>
          {authUrl && (
            <Box marginTop={1} flexDirection="column">
              <Text dimColor>If your browser did not open, visit:</Text>
              <Text color={POPUP_CONFIG.titleColor} wrap="wrap">{authUrl}</Text>
            </Box>
          )}
        </Box>
      )}
      {phase === 'error' && (
        <Box marginTop={1} flexDirection="column">
          <Text color={POPUP_CONFIG.errorColor} wrap="wrap">{truncate(errorMessage, 240)}</Text>
          <Text dimColor>Enter to retry • ESC to go back</Text>
        </Box>
      )}
    </Box>
  );
};

/* ------------------------------------------------------------------ */
/* Grok Build subscription sign-in                                    */
/* ------------------------------------------------------------------ */

interface GrokBuildScreenProps {
  onReady: (note: string) => void;
  onBack: () => void;
}

function cleanGrokLoginOutput(value: string): string[] {
  return value
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '')
    .replace(/\r/g, '')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .slice(-6);
}

const GrokBuildScreen: React.FC<GrokBuildScreenProps> = ({ onReady, onBack }) => {
  const [phase, setPhase] = useState<'checking' | 'signedOut' | 'waiting' | 'error'>('checking');
  const [loginOutput, setLoginOutput] = useState('');
  const [errorMessage, setErrorMessage] = useState('');
  const aliveRef = useRef(true);
  const loginAbortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    return () => {
      aliveRef.current = false;
      loginAbortRef.current?.abort();
    };
  }, []);

  const checkAccount = async () => {
    setPhase('checking');
    try {
      const status = await getGrokBuildStatus();
      if (!aliveRef.current) return;
      if (status.authenticated) {
        onReady('Using your Grok Build subscription');
        return;
      }
      setPhase('signedOut');
    } catch (error) {
      if (!aliveRef.current) return;
      setErrorMessage(error instanceof Error ? error.message : String(error));
      setPhase('error');
    }
  };

  useEffect(() => {
    void checkAccount();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const startLogin = async () => {
    setPhase('waiting');
    setLoginOutput('');
    setErrorMessage('');
    const controller = new AbortController();
    loginAbortRef.current = controller;
    try {
      await loginToGrokBuild((chunk) => {
        if (aliveRef.current) setLoginOutput((previous) => `${previous}${chunk}`.slice(-8_000));
      }, controller.signal);
      if (!aliveRef.current) return;
      onReady('Using your Grok Build subscription');
    } catch (error) {
      if (!aliveRef.current || controller.signal.aborted) return;
      setErrorMessage(error instanceof Error ? error.message : String(error));
      setPhase('error');
    } finally {
      if (loginAbortRef.current === controller) loginAbortRef.current = null;
    }
  };

  useInput((_input, key) => {
    if (key.escape) {
      loginAbortRef.current?.abort();
      onBack();
      return;
    }
    if (key.return) {
      if (phase === 'signedOut') void startLogin();
      if (phase === 'error') void checkAccount();
    }
  });

  const outputLines = cleanGrokLoginOutput(loginOutput);
  return (
    <Box flexDirection="column">
      <Text bold>Grok Build subscription</Text>
      <Text dimColor>Uses the SpaceXAI login managed by the Grok Build CLI.</Text>
      {phase === 'checking' && (
        <Box marginTop={1}>
          <Spinner color={POPUP_CONFIG.titleColor} />
          <Text> Checking your Grok Build login…</Text>
        </Box>
      )}
      {phase === 'signedOut' && (
        <Box marginTop={1} flexDirection="column">
          <Text>No Grok Build subscription login was found.</Text>
          <Text dimColor>Press Enter to sign in with SpaceXAI in your browser.</Text>
        </Box>
      )}
      {phase === 'waiting' && (
        <Box marginTop={1} flexDirection="column">
          <Box>
            <Spinner color={POPUP_CONFIG.titleColor} />
            <Text> Waiting for Grok Build sign-in…</Text>
          </Box>
          {outputLines.map((line, index) => (
            <Text key={`${index}-${line}`} dimColor wrap="wrap">{truncate(line, 160)}</Text>
          ))}
        </Box>
      )}
      {phase === 'error' && (
        <Box marginTop={1} flexDirection="column">
          <Text color={POPUP_CONFIG.errorColor} wrap="wrap">{truncate(errorMessage, 240)}</Text>
          <Text dimColor>Enter to check again • ESC to go back</Text>
        </Box>
      )}
    </Box>
  );
};

/* ------------------------------------------------------------------ */
/* Model picker                                                       */
/* ------------------------------------------------------------------ */

interface ModelsScreenProps {
  target: TargetLabel;
  draft: TargetDraft;
  onModelsLoaded: (models: InferenceModel[]) => void;
  onChoose: (modelId: string) => void;
  onBack: () => void;
}

const ModelsScreen: React.FC<ModelsScreenProps> = ({
  target,
  draft,
  onModelsLoaded,
  onChoose,
  onBack,
}) => {
  const [phase, setPhase] = useState<'loading' | 'ready' | 'error'>(
    draft.models ? 'ready' : 'loading'
  );
  const [errorMessage, setErrorMessage] = useState('');
  const [query, setQuery] = useState('');
  const [manualId, setManualId] = useState('');
  const [selectedIndex, setSelectedIndex] = useState(0);
  const aliveRef = useRef(true);

  const providerName = draft.provider?.name || draft.partialTarget?.providerName || 'provider';
  const models = draft.models || [];

  const loadModels = async () => {
    if (!draft.partialTarget) return;
    setPhase('loading');
    setErrorMessage('');
    try {
      const discovered = await discoverInferenceModels(draft.partialTarget);
      if (!aliveRef.current) return;
      if (discovered.length === 0) {
        setErrorMessage(`${providerName} returned an empty model catalog.`);
        setPhase('error');
        return;
      }
      onModelsLoaded(discovered);
      setPhase('ready');
    } catch (error) {
      if (!aliveRef.current) return;
      setErrorMessage(error instanceof Error ? error.message : String(error));
      setPhase('error');
    }
  };

  useEffect(() => {
    if (!draft.models) void loadModels();
    return () => {
      aliveRef.current = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const ranked = useMemo(() => rankInferenceModels(models, query), [models, query]);

  const prevQueryRef = useRef(query);
  if (prevQueryRef.current !== query) {
    prevQueryRef.current = query;
    if (selectedIndex !== 0) setSelectedIndex(0);
  }

  useInput((input, key) => {
    if (phase === 'ready') {
      if (key.escape) {
        if (query) setQuery('');
        else onBack();
        return;
      }
      if (key.downArrow) {
        setSelectedIndex((prev) => clampSelection(prev + 1, ranked.length));
        return;
      }
      if (key.upArrow) {
        setSelectedIndex((prev) => clampSelection(prev - 1, ranked.length));
      }
      return;
    }
    if (key.escape) {
      onBack();
      return;
    }
    if (phase === 'error' && key.ctrl && input === 'r') {
      void loadModels();
    }
  });

  const handleSubmit = () => {
    const model = ranked[clampSelection(selectedIndex, ranked.length)];
    if (model) {
      onChoose(model.id);
      return;
    }
    const fallback = sanitizeSearchQuery(query);
    if (fallback) onChoose(fallback);
  };

  const selected = ranked[clampSelection(selectedIndex, ranked.length)];

  return (
    <Box flexDirection="column">
      <Text bold>{targetTitle(target)} model · {providerName}</Text>
      {draft.credentialNote && (
        <Text dimColor>✓ {truncate(draft.credentialNote)}</Text>
      )}

      {phase === 'loading' && (
        <Box marginTop={1}>
          <Spinner color={POPUP_CONFIG.titleColor} />
          <Text> Loading models from {providerName}…</Text>
        </Box>
      )}

      {phase === 'ready' && (
        <>
          <Box marginTop={1}>
            <SearchField
              value={query}
              onChange={setQuery}
              onSubmit={handleSubmit}
              placeholder={`Search ${models.length} models…`}
            />
          </Box>
          <Box marginTop={1}>
            {ranked.length === 0 ? (
              <Box flexDirection="column">
                <Text color={POPUP_CONFIG.errorColor}>No models match “{truncate(query, 40)}”.</Text>
                <Text dimColor>Press Enter to use it as a custom model id, or ESC to clear.</Text>
              </Box>
            ) : (
              <>
                <Box width={LIST_COL_WIDTH} flexDirection="column">
                  <Text dimColor>
                    {query
                      ? `${ranked.length} of ${models.length} models`
                      : `${models.length} models`}
                  </Text>
                  <ScrollList
                    items={ranked}
                    selectedIndex={selectedIndex}
                    renderItem={(model, isSelected) => (
                      <Box key={model.id} width={LIST_COL_WIDTH} paddingRight={1}>
                        <Text color={isSelected ? POPUP_CONFIG.titleColor : undefined} bold={isSelected}>
                          {isSelected ? MARKER_SELECTED : MARKER_BLANK}
                          {truncate(model.name, LIST_COL_WIDTH - 2)}
                        </Text>
                      </Box>
                    )}
                  />
                </Box>
                <Box
                  width={DETAIL_COL_WIDTH}
                  flexDirection="column"
                  borderStyle="single"
                  borderColor="gray"
                  borderTop={false}
                  borderRight={false}
                  borderBottom={false}
                  paddingLeft={1}
                >
                  {selected && (
                    <>
                      <Text bold wrap="wrap">{truncate(selected.name, DETAIL_COL_WIDTH - 2)}</Text>
                      {selected.id !== selected.name && (
                        <Text dimColor wrap="wrap">{selected.id}</Text>
                      )}
                      {selected.description && (
                        <Box marginTop={1}>
                          <Text dimColor wrap="wrap">{truncate(selected.description, 200)}</Text>
                        </Box>
                      )}
                    </>
                  )}
                </Box>
              </>
            )}
          </Box>
        </>
      )}

      {phase === 'error' && (
        <Box marginTop={1} flexDirection="column">
          <Text color={POPUP_CONFIG.errorColor} wrap="wrap">
            Could not load the model catalog: {truncate(errorMessage, 200)}
          </Text>
          <Box marginTop={1} flexDirection="column">
            <Text>Enter a model id manually</Text>
            <CleanTextInput
              value={manualId}
              onChange={setManualId}
              onSubmit={() => {
                const id = manualId.trim();
                if (id) onChoose(id);
              }}
              placeholder="for example gpt-5-mini"
              maxWidth={ROW_MAX_WIDTH}
              disableUpDownArrows={true}
              disableEscape={true}
              ignoreFocus={true}
            />
            <Text dimColor>Ctrl+R to retry loading the catalog</Text>
          </Box>
        </Box>
      )}
    </Box>
  );
};

/* ------------------------------------------------------------------ */
/* Backup offer + summary                                             */
/* ------------------------------------------------------------------ */

interface BackupOfferScreenProps {
  onDecide: (wantBackup: boolean) => void;
  onBack: () => void;
}

const BACKUP_OPTIONS = [
  {
    label: 'Finish with just the primary',
    description: 'You can add a backup later from Settings → Inference providers.',
    wantBackup: false,
  },
  {
    label: 'Add a backup model',
    description: 'dmux fails over to it automatically when the primary errors out.',
    wantBackup: true,
  },
];

const BackupOfferScreen: React.FC<BackupOfferScreenProps> = ({ onDecide, onBack }) => {
  const [selectedIndex, setSelectedIndex] = useState(0);

  useInput((_input, key) => {
    if (key.escape) {
      onBack();
      return;
    }
    if (key.downArrow) {
      setSelectedIndex((prev) => clampSelection(prev + 1, BACKUP_OPTIONS.length));
      return;
    }
    if (key.upArrow) {
      setSelectedIndex((prev) => clampSelection(prev - 1, BACKUP_OPTIONS.length));
      return;
    }
    if (key.return) {
      onDecide(BACKUP_OPTIONS[selectedIndex].wantBackup);
    }
  });

  return (
    <Box flexDirection="column">
      <Text bold>Add a backup?</Text>
      <Text dimColor>A second provider/model keeps AI features working during outages.</Text>
      <Box marginTop={1} flexDirection="column">
        {BACKUP_OPTIONS.map((option, index) => {
          const isSelected = index === selectedIndex;
          return (
            <Box key={option.label} flexDirection="column">
              <Text color={isSelected ? POPUP_CONFIG.titleColor : undefined} bold={isSelected}>
                {isSelected ? MARKER_SELECTED : MARKER_BLANK}
                {option.label}
              </Text>
              {isSelected && <Text dimColor>{'  '}{option.description}</Text>}
            </Box>
          );
        })}
      </Box>
    </Box>
  );
};

interface SummaryScreenProps {
  drafts: { primary: TargetDraft; backup: TargetDraft };
  onSave: () => void;
  onBack: () => void;
}

const SummaryScreen: React.FC<SummaryScreenProps> = ({ drafts, onSave, onBack }) => {
  useInput((_input, key) => {
    if (key.escape) {
      onBack();
      return;
    }
    if (key.return) onSave();
  });

  const describe = (draft: TargetDraft): string | null => {
    if (!draft.partialTarget || !draft.modelId) return null;
    const name = draft.provider?.name || draft.partialTarget.providerName || draft.partialTarget.providerId;
    return `${name} / ${draft.modelId}`;
  };

  const backupLine = describe(drafts.backup);

  return (
    <Box flexDirection="column">
      <Text bold>Review configuration</Text>
      <Box marginTop={1} flexDirection="column">
        <Box>
          <Text dimColor>{'Primary  '}</Text>
          <Text color={POPUP_CONFIG.successColor}>{truncate(describe(drafts.primary) || '', 68)}</Text>
        </Box>
        <Box>
          <Text dimColor>{'Backup   '}</Text>
          {backupLine ? (
            <Text color={POPUP_CONFIG.successColor}>{truncate(backupLine, 68)}</Text>
          ) : (
            <Text dimColor>none</Text>
          )}
        </Box>
      </Box>
      <Box marginTop={1}>
        <Text dimColor>Saved globally for all dmux projects.</Text>
      </Box>
    </Box>
  );
};

/* ------------------------------------------------------------------ */
/* Root wizard                                                        */
/* ------------------------------------------------------------------ */

interface InferenceSetupProps {
  resultFile?: string;
  onComplete?: (result: { primary: InferenceTarget; backup: InferenceTarget | null } | null) => void;
}

export const InferenceSetupApp: React.FC<InferenceSetupProps> = ({ resultFile, onComplete }) => {
  const { exit } = useApp();
  const [steps, setSteps] = useState<Step[]>([{ kind: 'provider', target: 'primary' }]);
  const [drafts, setDrafts] = useState<{ primary: TargetDraft; backup: TargetDraft }>({
    primary: {},
    backup: {},
  });
  const [badges, setBadges] = useState<Map<string, ProviderCredentialBadge>>(new Map());

  const step = steps[steps.length - 1];

  useEffect(() => {
    return () => {
      // Provider badges and ChatGPT model discovery share one app-server
      // process. Ink's exit only unmounts the tree, so close it explicitly to
      // let the popup process terminate cleanly.
      resetCodexAppServerClient();
    };
  }, []);

  useEffect(() => {
    let alive = true;
    void detectProviderCredentials().then((detected) => {
      if (!alive) return;
      setBadges((prev) => new Map([...prev, ...detected]));
    });
    void detectChatGptAccount().then((account) => {
      if (!alive || !account) return;
      setBadges((prev) => {
        const next = new Map(prev);
        next.set('chatgpt', { kind: 'chatgpt', email: account.email });
        return next;
      });
    });
    void detectGrokBuildAccount().then((account) => {
      if (!alive || !account) return;
      setBadges((prev) => {
        const next = new Map(prev);
        next.set('grok-build', { kind: 'grok-build' });
        return next;
      });
    });
    return () => {
      alive = false;
    };
  }, []);

  const push = (next: Step) => setSteps((prev) => [...prev, next]);
  const replaceTop = (next: Step) => setSteps((prev) => [...prev.slice(0, -1), next]);
  const cancel = () => {
    if (resultFile) writeCancelAndExit(resultFile, exit);
    else {
      onComplete?.(null);
      exit();
    }
  };
  const back = () => {
    if (steps.length > 1) setSteps((prev) => prev.slice(0, -1));
    else cancel();
  };

  useInput((input, key) => {
    if (key.ctrl && input === 'c') cancel();
  });

  const updateDraft = (target: TargetLabel, patch: Partial<TargetDraft>) => {
    setDrafts((prev) => ({ ...prev, [target]: { ...prev[target], ...patch } }));
  };

  const handleProviderChosen = (target: TargetLabel, provider: InferenceProviderDefinition) => {
    updateDraft(target, {
      provider,
      partialTarget: { providerId: provider.id },
      credentialNote: undefined,
      models: undefined,
      modelId: undefined,
    });
    if (provider.custom) push({ kind: 'custom', target });
    else if (provider.protocol === 'chatgpt') push({ kind: 'chatgpt', target });
    else if (provider.protocol === 'grok-build') push({ kind: 'grokBuild', target });
    else push({ kind: 'credential', target });
  };

  const handleCustomComplete = (
    target: TargetLabel,
    fields: { name: string; baseUrl: string; envKey: string }
  ) => {
    const partialTarget = buildCustomPartialTarget(fields);
    const provider = resolveInferenceProvider({ ...partialTarget, modelId: '__setup__' });
    if (!provider) return;
    updateDraft(target, { provider, partialTarget, models: undefined, modelId: undefined });
    push({ kind: 'credential', target });
  };

  const handleCredentialReady = (target: TargetLabel, note: string) => {
    updateDraft(target, { credentialNote: note });
    // Replace instead of push so ESC from the model list returns to the
    // provider picker rather than re-triggering the credential check.
    replaceTop({ kind: 'models', target });
  };

  const handleModelChosen = (target: TargetLabel, modelId: string) => {
    updateDraft(target, { modelId });
    if (target === 'primary') push({ kind: 'backupOffer' });
    else push({ kind: 'summary' });
  };

  const handleBackupDecision = (wantBackup: boolean) => {
    if (wantBackup) {
      push({ kind: 'provider', target: 'backup' });
    } else {
      setDrafts((prev) => ({ ...prev, backup: {} }));
      push({ kind: 'summary' });
    }
  };

  const handleSave = () => {
    const { primary, backup } = drafts;
    if (!primary.partialTarget || !primary.modelId) return;
    const result = {
      primary: { ...primary.partialTarget, modelId: primary.modelId },
      backup:
        backup.partialTarget && backup.modelId
          ? { ...backup.partialTarget, modelId: backup.modelId }
          : null,
    };
    if (resultFile) writeSuccessAndExit(resultFile, result, exit);
    else {
      onComplete?.(result);
      exit();
    }
  };

  const footer = (() => {
    switch (step.kind) {
      case 'provider':
        return `↑↓ navigate • Enter select • ${steps.length > 1 ? 'ESC back' : POPUP_CONFIG.cancelHint}`;
      case 'custom':
        return 'Enter continue • ESC back';
      case 'credential':
        return 'Enter save key • ESC back';
      case 'chatgpt':
        return 'Enter continue • ESC back';
      case 'grokBuild':
        return 'Enter sign in • ESC back';
      case 'models':
        return '↑↓ navigate • Enter select • ESC back';
      case 'backupOffer':
        return '↑↓ navigate • Enter choose • ESC back';
      case 'summary':
        return 'Enter save • ESC back';
    }
  })();

  const screen = (() => {
    switch (step.kind) {
      case 'provider':
        return (
          <ProviderScreen
            key={`provider-${step.target}`}
            target={step.target}
            badges={badges}
            onChoose={(provider) => handleProviderChosen(step.target, provider)}
            onBack={back}
          />
        );
      case 'custom':
        return (
          <CustomScreen
            key={`custom-${step.target}`}
            onComplete={(fields) => handleCustomComplete(step.target, fields)}
            onBack={back}
          />
        );
      case 'credential': {
        const provider = drafts[step.target].provider;
        if (!provider) return null;
        return (
          <CredentialScreen
            key={`credential-${step.target}-${provider.id}`}
            provider={provider}
            onReady={(note) => handleCredentialReady(step.target, note)}
            onBack={back}
          />
        );
      }
      case 'chatgpt':
        return (
          <ChatGptScreen
            key={`chatgpt-${step.target}`}
            onReady={(note) => handleCredentialReady(step.target, note)}
            onBack={back}
          />
        );
      case 'grokBuild':
        return (
          <GrokBuildScreen
            key={`grok-build-${step.target}`}
            onReady={(note) => handleCredentialReady(step.target, note)}
            onBack={back}
          />
        );
      case 'models':
        return (
          <ModelsScreen
            key={`models-${step.target}-${drafts[step.target].provider?.id || 'custom'}`}
            target={step.target}
            draft={drafts[step.target]}
            onModelsLoaded={(models) => updateDraft(step.target, { models })}
            onChoose={(modelId) => handleModelChosen(step.target, modelId)}
            onBack={back}
          />
        );
      case 'backupOffer':
        return <BackupOfferScreen key="backup-offer" onDecide={handleBackupDecision} onBack={back} />;
      case 'summary':
        return <SummaryScreen key="summary" drafts={drafts} onSave={handleSave} onBack={back} />;
    }
  })();

  // Match the 90-column tmux popup's 88-column interior and keep first-run
  // inline onboarding from stretching across an ultra-wide terminal.
  const content = <PopupContainer footer={footer} width={88}>{screen}</PopupContainer>;
  return resultFile ? (
    <PopupWrapper resultFile={resultFile} allowEscapeToCancel={false}>
      {content}
    </PopupWrapper>
  ) : content;
};

/* ------------------------------------------------------------------ */
/* Entry point                                                        */
/* ------------------------------------------------------------------ */

function main() {
  const resultFile = process.argv[2];
  if (!resultFile) {
    console.error('Error: Result file path required');
    process.exit(1);
  }

  render(<InferenceSetupApp resultFile={resultFile} />);
}

const entryPointHref = process.argv[1] ? pathToFileURL(process.argv[1]).href : '';
if (import.meta.url === entryPointHref) {
  main();
}
