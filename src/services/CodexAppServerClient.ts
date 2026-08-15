import { spawn, type ChildProcessWithoutNullStreams } from 'child_process';
import os from 'os';
import readline from 'readline';
import type { InferenceModel } from '../utils/inferenceProviders.js';

interface JsonRpcResponse {
  id?: number;
  method?: string;
  result?: any;
  error?: { code?: number; message?: string; data?: unknown };
  params?: any;
}

interface PendingRequest {
  resolve: (value: any) => void;
  reject: (error: Error) => void;
}

type NotificationListener = (message: JsonRpcResponse) => void;

export interface CodexAccountInfo {
  type: string;
  email?: string;
  planType?: string;
}

export interface ChatGptLoginStart {
  loginId: string;
  authUrl?: string;
  verificationUrl?: string;
  userCode?: string;
}

/**
 * Minimal client for Codex's documented app-server protocol. It deliberately
 * leaves token persistence and refresh to Codex itself.
 */
export class CodexAppServerClient {
  private child?: ChildProcessWithoutNullStreams;
  private nextId = 1;
  private pending = new Map<number, PendingRequest>();
  private listeners = new Set<NotificationListener>();
  private starting?: Promise<void>;
  private stderr = '';

  async start(): Promise<void> {
    if (this.starting) return this.starting;
    if (this.child && !this.child.killed) return;

    this.starting = this.startProcess();
    try {
      await this.starting;
    } finally {
      this.starting = undefined;
    }
  }

  private async startProcess(): Promise<void> {
    const child = spawn('codex', ['app-server', '--stdio'], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: process.env,
    });
    this.child = child;
    this.stderr = '';

    // A missing/crashed Codex executable can close the pipe before the spawn
    // error reaches the child process. Avoid an unhandled EPIPE in that case.
    child.stdin.on('error', () => {});

    child.stderr.setEncoding('utf-8');
    child.stderr.on('data', (chunk: string) => {
      this.stderr = `${this.stderr}${chunk}`.slice(-4000);
    });

    const lines = readline.createInterface({ input: child.stdout });
    lines.on('line', (line) => {
      let message: JsonRpcResponse;
      try {
        message = JSON.parse(line) as JsonRpcResponse;
      } catch {
        return;
      }

      if (typeof message.id === 'number') {
        const request = this.pending.get(message.id);
        if (!request) return;
        this.pending.delete(message.id);
        if (message.error) {
          request.reject(new Error(message.error.message || 'Codex app-server request failed'));
        } else {
          request.resolve(message.result);
        }
        return;
      }

      for (const listener of this.listeners) listener(message);
    });

    child.once('error', (error) => this.handleExit(error));
    child.once('exit', (code) => {
      const detail = this.stderr.trim();
      this.handleExit(
        new Error(
          detail
            ? `Codex app-server exited (${code ?? 'unknown'}): ${detail}`
            : `Codex app-server exited (${code ?? 'unknown'})`
        )
      );
    });

    await this.requestWithoutStart('initialize', {
      clientInfo: {
        name: 'dmux',
        title: 'dmux',
        version: '1',
      },
    });
    this.notify('initialized', {});
  }

  private handleExit(error: Error): void {
    this.child = undefined;
    for (const request of this.pending.values()) request.reject(error);
    this.pending.clear();
  }

  private requestWithoutStart(method: string, params?: unknown): Promise<any> {
    const child = this.child;
    if (!child || child.killed) {
      return Promise.reject(new Error('Codex app-server is not running'));
    }

    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      child.stdin.write(`${JSON.stringify({ method, id, ...(params === undefined ? {} : { params }) })}\n`);
    });
  }

  private notify(method: string, params?: unknown): void {
    const child = this.child;
    if (!child || child.killed) return;
    child.stdin.write(`${JSON.stringify({ method, ...(params === undefined ? {} : { params }) })}\n`);
  }

  async request(method: string, params?: unknown): Promise<any> {
    await this.start();
    return this.requestWithoutStart(method, params);
  }

  onNotification(listener: NotificationListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async getAccount(): Promise<CodexAccountInfo | null> {
    const result = await this.request('account/read', { refreshToken: false });
    return result?.account || null;
  }

  async startChatGptLogin(deviceCode = false): Promise<ChatGptLoginStart> {
    const result = await this.request(
      'account/login/start',
      deviceCode
        ? { type: 'chatgptDeviceCode' }
        : { type: 'chatgpt', useHostedLoginSuccessPage: true, appBrand: 'chatgpt' }
    );
    return result as ChatGptLoginStart;
  }

  async waitForLogin(loginId: string, timeoutMs = 5 * 60_000): Promise<void> {
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        unsubscribe();
        reject(new Error('ChatGPT login timed out'));
      }, timeoutMs);

      const unsubscribe = this.onNotification((message) => {
        if (
          message.method !== 'account/login/completed'
          || message.params?.loginId !== loginId
        ) {
          return;
        }
        clearTimeout(timeout);
        unsubscribe();
        if (message.params?.success) resolve();
        else reject(new Error(message.params?.error || 'ChatGPT login failed'));
      });
    });
  }

  async listModels(): Promise<InferenceModel[]> {
    const models: InferenceModel[] = [];
    let cursor: string | null = null;
    do {
      const result = await this.request('model/list', {
        cursor,
        limit: 100,
        includeHidden: false,
      });
      for (const model of result?.data || []) {
        if (typeof model?.model !== 'string') continue;
        models.push({
          id: model.model,
          name: typeof model.displayName === 'string' ? model.displayName : model.model,
          description: typeof model.description === 'string' ? model.description : undefined,
        });
      }
      cursor = typeof result?.nextCursor === 'string' ? result.nextCursor : null;
    } while (cursor);
    return models;
  }

  async generateText(
    model: string,
    prompt: string,
    options: {
      system?: string;
      timeoutMs?: number;
      signal?: AbortSignal;
      outputSchema?: Record<string, unknown>;
    } = {}
  ): Promise<string> {
    await this.start();

    const threadResult = await this.requestWithoutStart('thread/start', {
      model,
      cwd: os.tmpdir(),
      approvalPolicy: 'never',
      sandbox: 'read-only',
      serviceName: 'dmux_inference',
      ephemeral: true,
      baseInstructions: 'You are a text inference service. Never use tools. Return only the requested answer.',
      developerInstructions: options.system || null,
    });
    const threadId = threadResult?.thread?.id;
    if (typeof threadId !== 'string') {
      throw new Error('Codex app-server did not create an inference thread');
    }

    let turnId: string | undefined;
    let finalText = '';
    const timeoutMs = options.timeoutMs ?? 20_000;

    return new Promise<string>((resolve, reject) => {
      let settled = false;
      const finish = (error?: Error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        unsubscribe();
        options.signal?.removeEventListener('abort', abort);
        if (error) reject(error);
        else if (finalText.trim()) resolve(finalText.trim());
        else reject(new Error('ChatGPT returned an empty response'));
      };

      const abort = () => {
        if (turnId) void this.request('turn/interrupt', { threadId, turnId }).catch(() => {});
        finish(new Error('Inference request aborted'));
      };

      const unsubscribe = this.onNotification((message) => {
        if (message.params?.threadId !== threadId) return;
        if (message.method === 'item/completed' && message.params?.item?.type === 'agentMessage') {
          finalText = message.params.item.text || finalText;
          return;
        }
        if (message.method !== 'turn/completed') return;
        const turn = message.params?.turn;
        if (turn?.status === 'failed') {
          finish(new Error(turn?.error?.message || 'ChatGPT inference failed'));
        } else if (turn?.status === 'interrupted') {
          finish(new Error('ChatGPT inference was interrupted'));
        } else {
          const completedMessage = [...(turn?.items || [])]
            .reverse()
            .find((item: any) => item?.type === 'agentMessage' && typeof item.text === 'string');
          if (completedMessage) finalText = completedMessage.text;
          finish();
        }
      });

      const timeout = setTimeout(abort, timeoutMs);
      if (options.signal?.aborted) {
        abort();
        return;
      }
      options.signal?.addEventListener('abort', abort, { once: true });

      void this.requestWithoutStart('turn/start', {
        threadId,
        input: [{ type: 'text', text: prompt }],
        ...(options.outputSchema ? { outputSchema: options.outputSchema } : {}),
      }).then((result) => {
        if (typeof result?.turn?.id === 'string') turnId = result.turn.id;
      }).catch((error) => finish(error instanceof Error ? error : new Error(String(error))));
    });
  }

  close(): void {
    const child = this.child;
    this.child = undefined;
    if (child && !child.killed) child.kill('SIGTERM');
  }
}

let sharedClient: CodexAppServerClient | undefined;

export function getCodexAppServerClient(): CodexAppServerClient {
  sharedClient ??= new CodexAppServerClient();
  return sharedClient;
}

export function resetCodexAppServerClient(): void {
  sharedClient?.close();
  sharedClient = undefined;
}
