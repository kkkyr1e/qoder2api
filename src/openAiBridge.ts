/**
 * Core bridge module: converts both OpenAI and Anthropic Messages API requests
 * to Qoder SSE agent requests.
 * Supports streaming/non-streaming modes and account-aware Qoder model routing.
 * Claude Code connects via Anthropic Messages format (/v1/messages).
 */

import http from 'http';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { SignatureApiClient } from './signatureApiClient';
import * as bearerBuilder from './bearerBuilder';
import {
  BearerApiClient,
  QoderHttpError,
  getUpstreamConcurrencyStats,
} from './bearerApiClient';
import {
  CHARS_PER_TOKEN_ESTIMATE,
  INPUT_TOKEN_BUDGET,
  MAX_REQUEST_BODY_SIZE,
  RESPONSE_TOKEN_RESERVE,
  SSE_PING_INTERVAL_MS,
  SSE_REQUEST_TIMEOUT_MS,
} from './constants';
import type { SessionContext, AuthIdentity } from './bearerBuilder';
import {
  ModelCatalog,
  normalizeReasoningEffort,
  type QoderModelConfig,
  type ReasoningEffort,
} from './modelCatalog';
import {
  convertAnthropicToolsToOpenAi,
  convertAnthropicToolChoiceToOpenAi,
  ToolCallAggregator,
  anthropicIdToOpenAi,
  type AnthropicTool,
  type AnthropicToolChoice,
  type OpenAiToolCall,
} from './toolBridge';

const SSE_ENDPOINT = 'https://api3.qoder.sh/algo/api/v2/service/pro/sse/agent_chat_generation?FetchKeys=llm_model_result&AgentId=agent_common&Encode=1';

const MODEL_CATALOG_REFRESH_MS = 2 * 60 * 1000;
const SESSION_REFRESH_SKEW_MS = 60_000;
const EFFORT_BUDGETS: Record<ReasoningEffort, number> = {
  none: 0,
  low: 1_024,
  medium: 8_192,
  high: 24_576,
  xhigh: 49_152,
  max: 65_536,
};

class HttpError extends Error {
  constructor(public readonly status: number, message: string, public readonly type = 'invalid_request_error') {
    super(message);
    this.name = 'HttpError';
  }
}

export class OpenAiBridge {
  private session: SessionContext;
  private bearerClient: BearerApiClient;
  private readonly templateBase: any;
  private readonly catalog = new ModelCatalog();
  private readonly startedAt = Date.now();
  private sessionGeneration = 1;
  private sessionExpiresAt: number | null;
  private refreshSessionPromise: Promise<void> | null = null;

  private constructor(
    private readonly pat: string,
    private readonly machineId: string,
    private readonly machineToken: string,
    private readonly machineType: string,
    session: SessionContext,
    bearerClient: BearerApiClient,
    templateBase: any,
    sessionExpiresAt: number | null,
  ) {
    this.session = session;
    this.bearerClient = bearerClient;
    this.templateBase = templateBase;
    this.sessionExpiresAt = sessionExpiresAt;
  }

  static async create(pat: string): Promise<OpenAiBridge> {
    const machineId = crypto.randomUUID();
    const machineToken = Buffer.from(
      (crypto.randomUUID() + crypto.randomUUID()).substring(0, 50),
    ).toString('base64url');
    const machineType = crypto.randomUUID().replace(/-/g, '').substring(0, 18);

    const created = await createSession(pat, machineId, machineToken, machineType);
    console.log(`[bridge] authenticated account=${created.identity.aid}`);
    const session = bearerBuilder.newSession(created.identity, machineId, machineToken, machineType);
    const bearerClient = new BearerApiClient(session);

    const templatePath = path.resolve(__dirname, '..', 'baseprompt.json');
    let basePrompt = fs.readFileSync(templatePath, 'utf-8');
    basePrompt = basePrompt.replace('{UUID1}', crypto.randomUUID());
    basePrompt = basePrompt.replace('{UUID2}', crypto.randomUUID());
    basePrompt = basePrompt.replace('{UUID3}', crypto.randomUUID());
    basePrompt = basePrompt.replace('{UUID4}', crypto.randomUUID());
    basePrompt = basePrompt.replace('{UUID5}', crypto.randomUUID());
    basePrompt = basePrompt.replace('{TIME1}', String(Date.now()));
    const templateBase = JSON.parse(basePrompt);

    const bridge = new OpenAiBridge(
      pat, machineId, machineToken, machineType,
      session, bearerClient, templateBase, created.expiresAt,
    );
    await bridge.refreshCatalog(false);
    console.log(`[catalog] source=${bridge.catalog.source} models=${bridge.catalog.list().length}`);
    return bridge;
  }

  start(port: number): void {
    const server = http.createServer((req, res) => {
      this.handleRequest(req, res).catch((error) => {
        console.error(`[bridge] request failed: ${safeErrorMessage(error)}`);
        if (res.headersSent) {
          if (!res.writableEnded) res.end();
          return;
        }
        this.writeError(res, error, req.url?.startsWith('/v1/messages') ?? false);
      });
    });

    server.keepAliveTimeout = SSE_REQUEST_TIMEOUT_MS;
    server.headersTimeout = SSE_REQUEST_TIMEOUT_MS + 5000;
    server.requestTimeout = 0;
    server.timeout = 0;

    server.listen(port, '127.0.0.1', () => {
      console.log(`[bridge] listening http://127.0.0.1:${port}`);
      console.log(`[bridge]   OpenAI:    /v1/chat/completions`);
      console.log(`[bridge]   Anthropic: /v1/messages (for Claude Code)`);
      console.log(`[bridge]   Models:    /v1/models`);
      console.log(`[bridge]   Health:    /health`);
      console.log(`[bridge] models source=${this.catalog.source}: ${this.catalog.list().map((model) => model.key).join(', ')}`);
      if (!process.env.QODER_BRIDGE_API_KEY) {
        console.warn('[bridge] local API authentication disabled; listener is loopback-only');
      }
    });
  }

  private async handleRequest(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const url = req.url?.split('?')[0];

    if ((url === '/health' || url === '/') && (req.method === 'GET' || req.method === 'HEAD')) {
      return this.handleHealth(res, req.method === 'HEAD');
    }
    if (!this.isAuthorized(req)) {
      throw new HttpError(401, 'Invalid bridge API key', 'authentication_error');
    }

    if (url === '/v1/models' && req.method === 'GET') {
      await this.refreshCatalogIfStale();
      return this.handleModels(res);
    }

    if (url === '/v1/models/refresh' && req.method === 'POST') {
      await this.ensureFreshSession();
      await this.refreshCatalog(true);
      return this.handleModels(res);
    }

    if (url === '/v1/session/refresh' && req.method === 'POST') {
      await this.refreshSession('manual');
      return this.handleHealth(res);
    }

    if (url === '/v1/messages' && req.method === 'POST') {
      await this.ensureFreshSession();
      return this.handleAnthropicMessages(req, res);
    }

    if (url === '/v1/messages/count_tokens' && req.method === 'POST') {
      return this.handleCountTokens(req, res);
    }

    if (url === '/v1/chat/completions' && req.method === 'POST') {
      await this.ensureFreshSession();
      return this.handleOpenAiChat(req, res);
    }

    throw new HttpError(404, `Not found: ${req.method ?? 'UNKNOWN'} ${url ?? '/'}`, 'not_found_error');
  }

  private isAuthorized(req: http.IncomingMessage): boolean {
    const expected = process.env.QODER_BRIDGE_API_KEY;
    if (!expected) return true;
    const apiKey = typeof req.headers['x-api-key'] === 'string' ? req.headers['x-api-key'] : '';
    const authorization = typeof req.headers.authorization === 'string' ? req.headers.authorization : '';
    const bearer = authorization.replace(/^Bearer\s+/i, '');
    return timingSafeEqual(expected, apiKey) || timingSafeEqual(expected, bearer);
  }

  private writeError(res: http.ServerResponse, error: unknown, anthropic: boolean): void {
    const status = error instanceof HttpError
      ? error.status
      : error instanceof QoderHttpError
        ? 502
        : /timeout/i.test(safeErrorMessage(error))
          ? 504
          : 500;
    const type = error instanceof HttpError ? error.type : status === 504 ? 'timeout_error' : 'api_error';
    const message = error instanceof HttpError
      ? error.message
      : status === 504
        ? 'Qoder upstream timed out before completing the response'
        : 'Qoder upstream request failed';
    res.writeHead(status, { 'Content-Type': 'application/json' });
    const body = anthropic
      ? { type: 'error', error: { type, message } }
      : { error: { type, message } };
    res.end(JSON.stringify(body));
  }

  private handleHealth(res: http.ServerResponse, headOnly = false): void {
    const concurrency = getUpstreamConcurrencyStats();
    const body = {
      status: 'ok',
      uptime_seconds: Math.floor((Date.now() - this.startedAt) / 1000),
      session_generation: this.sessionGeneration,
      session_expires_at: this.sessionExpiresAt ? new Date(this.sessionExpiresAt).toISOString() : null,
      catalog_source: this.catalog.source,
      catalog_models: this.catalog.list().length,
      catalog_refreshed_at: this.catalog.lastRefreshAt
        ? new Date(this.catalog.lastRefreshAt).toISOString()
        : null,
      upstream: concurrency,
    };
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(headOnly ? undefined : JSON.stringify(body));
  }

  private async ensureFreshSession(): Promise<void> {
    if (this.sessionExpiresAt && Date.now() + SESSION_REFRESH_SKEW_MS >= this.sessionExpiresAt) {
      await this.refreshSession('token-expiring');
    }
  }

  private async refreshSession(reason: string): Promise<void> {
    if (this.refreshSessionPromise) return this.refreshSessionPromise;
    this.refreshSessionPromise = (async () => {
      console.warn(`[auth] refreshing Qoder session reason=${reason}`);
      const created = await createSession(this.pat, this.machineId, this.machineToken, this.machineType);
      this.session = bearerBuilder.newSession(
        created.identity, this.machineId, this.machineToken, this.machineType,
      );
      this.bearerClient = new BearerApiClient(this.session);
      this.sessionExpiresAt = created.expiresAt;
      this.sessionGeneration++;
      try { await this.catalog.refresh(this.bearerClient); }
      catch (error) { console.warn(`[catalog] refresh after re-auth failed: ${safeErrorMessage(error)}`); }
      console.warn(`[auth] Qoder session refreshed generation=${this.sessionGeneration}`);
    })().finally(() => { this.refreshSessionPromise = null; });
    return this.refreshSessionPromise;
  }

  private async refreshCatalogIfStale(): Promise<void> {
    const lastRefresh = this.catalog.lastRefreshAt ?? 0;
    if (Date.now() - lastRefresh < MODEL_CATALOG_REFRESH_MS) return;
    await this.refreshCatalog(false);
  }

  private async refreshCatalog(strict: boolean): Promise<void> {
    try {
      await this.catalog.refresh(this.bearerClient);
    } catch (error) {
      if (isSessionRefreshCandidate(error)) {
        try {
          await this.refreshSession('model-catalog-auth-failure');
          await this.catalog.refresh(this.bearerClient);
          return;
        } catch (retryError) {
          if (strict) throw retryError;
          console.warn(`[catalog] refresh after re-auth failed; keeping source=${this.catalog.source}: ${safeErrorMessage(retryError)}`);
          return;
        }
      }
      if (strict) throw error;
      console.warn(`[catalog] refresh failed; keeping source=${this.catalog.source}: ${safeErrorMessage(error)}`);
    }
  }

  private async openUpstreamStream(
    body: unknown,
    extraHeaders: Record<string, string>,
    onLine: (line: string) => void,
    signal?: AbortSignal,
  ): Promise<void> {
    const generation = this.sessionGeneration;
    let receivedData = false;
    const wrappedOnLine = (line: string) => {
      if (line.startsWith('data:') && extractDelta(line.substring(5).trim())) receivedData = true;
      onLine(line);
    };
    try {
      await this.bearerClient.openStreamLines(SSE_ENDPOINT, body, extraHeaders, wrappedOnLine, signal);
    } catch (error) {
      if (signal?.aborted || receivedData || !isSessionRefreshCandidate(error)) throw error;
      if (generation === this.sessionGeneration) await this.refreshSession(safeErrorMessage(error));
      await this.bearerClient.openStreamLines(SSE_ENDPOINT, body, extraHeaders, onLine, signal);
    }
  }

  private async handleOpenAiChat(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const openaiRequest = await readJsonRequest(req);
    const stream = openaiRequest.stream ?? false;
    const requestedModel = String(openaiRequest.model || 'auto');
    if (!Array.isArray(openaiRequest.messages)) throw new HttpError(400, '`messages` must be an array');
    await this.refreshCatalogIfStale();
    const modelConfig = this.catalog.resolve(requestedModel);
    const effortResolution = resolveEffortResolution(openaiRequest, modelConfig, 'openai');
    const effort = effortResolution.effective;
    const contextWindow = resolveContextWindow(openaiRequest, modelConfig, undefined, requestedModel);
    const messages = trimMessagesForQoder(
      openaiRequest.messages,
      Math.max(1, contextWindow - RESPONSE_TOKEN_RESERVE),
    );
    const body = this.buildQoderRequestBody(
      messages, modelConfig, effort, contextWindow,
      openaiRequest.max_tokens, openaiRequest.tools, openaiRequest.tool_choice,
    );

    const extraHeaders: Record<string, string> = {
      'x-model-key': modelConfig.key,
      'x-model-source': modelConfig.source,
    };

    const requestId = 'chatcmpl-' + crypto.randomUUID().replace(/-/g, '').substring(0, 24);
    const created = Math.floor(Date.now() / 1000);

    logRequest('openai', requestedModel, modelConfig.key, effort, contextWindow, stream, messages);
    res.setHeader('X-Qoder-Model', modelConfig.key);
    res.setHeader('X-Qoder-Effort', effort ?? 'default');
    res.setHeader('X-Qoder-Requested-Effort', effortResolution.requested ?? 'default');
    res.setHeader('X-Qoder-Effort-Adjusted', String(effortResolution.adjusted));
    res.setHeader('X-Qoder-Context-Window', String(contextWindow));
    const abortController = createClientAbortController(req, res);

    if (stream) {
      await this.handleStreamResponse(
        res, body, extraHeaders, requestId, created, modelConfig.key, abortController.signal,
      );
    } else {
      await this.handleNonStreamResponse(
        res, body, extraHeaders, requestId, created, modelConfig.key, abortController.signal,
      );
    }
  }

  /** Anthropic /v1/messages endpoint — Claude Code connects here */
  private async handleAnthropicMessages(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const anthropicReq = await readJsonRequest(req);
    const stream = anthropicReq.stream ?? false;
    const requestedModel = String(anthropicReq.model || 'auto');
    if (!Array.isArray(anthropicReq.messages)) throw new HttpError(400, '`messages` must be an array');
    await this.refreshCatalogIfStale();
    const modelConfig = this.catalog.resolve(process.env.QODER_ANTHROPIC_MODEL || requestedModel);
    const effortResolution = resolveEffortResolution(anthropicReq, modelConfig, 'anthropic');
    const effort = effortResolution.effective;
    const anthropicBeta = Array.isArray(req.headers['anthropic-beta'])
      ? req.headers['anthropic-beta'].join(',')
      : req.headers['anthropic-beta'];
    const contextWindow = resolveContextWindow(anthropicReq, modelConfig, anthropicBeta, requestedModel);
    const messages = trimMessagesForQoder(
      convertAnthropicMessages(anthropicReq),
      Math.max(1, contextWindow - RESPONSE_TOKEN_RESERVE),
    );
    const openAiTools = convertAnthropicToolsToOpenAi(anthropicReq.tools);
    const openAiToolChoice = convertAnthropicToolChoiceToOpenAi(anthropicReq.tool_choice);
    const body = this.buildQoderRequestBody(
      messages, modelConfig, effort, contextWindow,
      anthropicReq.max_tokens, openAiTools, openAiToolChoice,
    );
    const extraHeaders: Record<string, string> = {
      'x-model-key': modelConfig.key,
      'x-model-source': modelConfig.source,
    };
    const messageId = 'msg_' + crypto.randomUUID().replace(/-/g, '').substring(0, 24);
    const responseModel = `qoder-${modelConfig.key}`;

    logRequest('anthropic', requestedModel, modelConfig.key, effort, contextWindow, stream, messages);
    res.setHeader('X-Qoder-Model', modelConfig.key);
    res.setHeader('X-Qoder-Effort', effort ?? 'default');
    res.setHeader('X-Qoder-Requested-Effort', effortResolution.requested ?? 'default');
    res.setHeader('X-Qoder-Effort-Adjusted', String(effortResolution.adjusted));
    res.setHeader('X-Qoder-Context-Window', String(contextWindow));
    const abortController = createClientAbortController(req, res);

    if (stream) {
      await this.handleAnthropicStream(
        res, body, extraHeaders, messageId, responseModel, abortController.signal,
      );
    } else {
      await this.handleAnthropicNonStream(
        res, body, extraHeaders, messageId, responseModel, abortController.signal,
      );
    }
  }

  private async handleAnthropicStream(
    res: http.ServerResponse,
    body: any,
    extraHeaders: Record<string, string>,
    messageId: string,
    model: string,
    signal: AbortSignal,
  ): Promise<void> {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    res.flushHeaders();
    const socket = res.socket;
    if (socket) {
      socket.setNoDelay(true);
      socket.setKeepAlive(true, 30000);
    }

    const writeSse = (event: string, data: unknown) => {
      if (!res.writable || res.socket?.destroyed) return;
      res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
      if (res.socket && !res.socket.destroyed) {
        res.socket.cork();
        res.socket.uncork();
      }
    };

    // message_start
    writeSse('message_start', {
      type: 'message_start',
      message: {
        id: messageId, type: 'message', role: 'assistant', model,
        content: [], stop_reason: null, stop_sequence: null,
        usage: { input_tokens: 0, output_tokens: 0 },
      },
    });

    writeSse('ping', { type: 'ping' });

    const pingTimer = setInterval(() => {
      if (!res.writable || res.socket?.destroyed) {
        clearInterval(pingTimer);
        return;
      }
      writeSse('ping', { type: 'ping' });
    }, SSE_PING_INTERVAL_MS);

    const aggregator = new ToolCallAggregator();
    let inputTokens = 0;
    let outputTokens = 0;
    let blockIndex = -1;
    let textBlockOpen = false;
    let stopReason: 'end_turn' | 'tool_use' = 'end_turn';
    let lastFinishReason: string | null = null;

    const closeTextBlock = () => {
      if (textBlockOpen && blockIndex >= 0) {
        writeSse('content_block_stop', { type: 'content_block_stop', index: blockIndex });
        textBlockOpen = false;
      }
    };

    const ensureTextBlock = () => {
      if (textBlockOpen) return;
      blockIndex++;
      textBlockOpen = true;
      writeSse('content_block_start', {
        type: 'content_block_start', index: blockIndex,
        content_block: { type: 'text', text: '' },
      });
    };

    try {
      await this.openUpstreamStream(body, extraHeaders, (line) => {
        if (!line.startsWith('data:')) return;
        const delta = extractDelta(line.substring(5).trim());
        if (!delta) return;
        if (delta.finish_reason) lastFinishReason = delta.finish_reason;
        if (delta.usage) {
          inputTokens = delta.usage.prompt_tokens ?? inputTokens;
          outputTokens = delta.usage.completion_tokens ?? outputTokens;
        }
        // Qoder does not provide an Anthropic-compatible thinking signature.
        // The effort still controls upstream reasoning, but private reasoning is
        // intentionally not emitted as an invalid unsigned thinking block.
        if (delta.content) {
          ensureTextBlock();
          writeSse('content_block_delta', {
            type: 'content_block_delta', index: blockIndex,
            delta: { type: 'text_delta', text: delta.content },
          });
        }
        aggregator.feedDelta({ tool_calls: delta.tool_calls });
      }, signal);
    } catch (error) {
      clearInterval(pingTimer);
      console.error(`[anthropic-stream] upstream error: ${safeErrorMessage(error)}`);
      if (!signal.aborted) {
        closeTextBlock();
        writeSse('error', {
          type: 'error',
          error: {
            type: /timeout/i.test(safeErrorMessage(error)) ? 'timeout_error' : 'api_error',
            message: 'Qoder upstream failed before the response completed',
          },
        });
      }
      res.end();
      return;
    }

    clearInterval(pingTimer);

    const final = aggregator.finalize(lastFinishReason);
    closeTextBlock();
    const collectedCalls = aggregator.collect();
    if (collectedCalls.length > 0) {
      console.log(`[anthropic-tools] count=${collectedCalls.length} names=${collectedCalls.map((call) => call.name).join(',')}`);
    }
    for (const call of collectedCalls) {
      blockIndex++;
      writeSse('content_block_start', {
        type: 'content_block_start', index: blockIndex,
        content_block: { type: 'tool_use', id: call.id, name: call.name, input: {} },
      });
      if (call.arguments.length > 0) {
        writeSse('content_block_delta', {
          type: 'content_block_delta', index: blockIndex,
          delta: { type: 'input_json_delta', partial_json: call.arguments },
        });
      }
      writeSse('content_block_stop', { type: 'content_block_stop', index: blockIndex });
    }
    if (final.stopReason === 'tool_use' || collectedCalls.length > 0) stopReason = 'tool_use';

    writeSse('message_delta', {
      type: 'message_delta',
      delta: { stop_reason: stopReason, stop_sequence: null },
      usage: { output_tokens: outputTokens },
    });

    // message_stop
    writeSse('message_stop', { type: 'message_stop' });
    res.end();
  }

  private async handleAnthropicNonStream(
    res: http.ServerResponse,
    body: any,
    extraHeaders: Record<string, string>,
    messageId: string,
    model: string,
    signal: AbortSignal,
  ): Promise<void> {
    const aggregator = new ToolCallAggregator();
    let lastFinishReason: string | null = null;
    let inputTokens = 0;
    let outputTokens = 0;
    let textBuf = '';

    await this.openUpstreamStream(body, extraHeaders, (line) => {
      if (!line.startsWith('data:')) return;
      const delta = extractDelta(line.substring(5).trim());
      if (!delta) return;
      if (delta.finish_reason) lastFinishReason = delta.finish_reason;
      if (delta.usage) {
        inputTokens = delta.usage.prompt_tokens ?? inputTokens;
        outputTokens = delta.usage.completion_tokens ?? outputTokens;
      }
      if (delta.content) textBuf += delta.content;
      aggregator.feedDelta({ tool_calls: delta.tool_calls });
    }, signal);

    const final = aggregator.finalize(lastFinishReason);
    const collectedCalls = aggregator.collect();

    type Block =
      | { type: 'text'; text: string }
      | { type: 'tool_use'; id: string; name: string; input: unknown };
    const blocks: Block[] = [];
    if (textBuf.length > 0) blocks.push({ type: 'text', text: textBuf });
    for (const c of collectedCalls) {
      let input: unknown = {};
      try { input = c.arguments ? JSON.parse(c.arguments) : {}; }
      catch { input = { _raw: c.arguments }; }
      blocks.push({ type: 'tool_use', id: c.id || ('toolu_' + crypto.randomBytes(12).toString('hex')), name: c.name, input });
    }
    if (blocks.length === 0) blocks.push({ type: 'text', text: '' });

    const response = {
      id: messageId, type: 'message', role: 'assistant', model,
      content: blocks,
      stop_reason: final.stopReason, stop_sequence: null,
      usage: {
        input_tokens: inputTokens,
        output_tokens: outputTokens,
      },
    };
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(response));
  }

  private async handleCountTokens(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const body = await readJsonRequest(req);
    const inputTokens = estimateAnthropicRequestTokens(body);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ input_tokens: inputTokens }));
  }

  private handleModels(res: http.ServerResponse): void {
    const models = this.catalog.list().map((config) => {
      const clientContext = getClientDefaultContext(config);
      return {
      id: getClaudeGatewayModelId(config),
      display_name: getClaudeGatewayDisplayName(config, clientContext),
      type: 'model',
      object: 'model',
      created: 1700000000,
      created_at: '2023-11-14T22:13:20Z',
      owned_by: 'qoder',
      qoder_model_key: config.key,
      reasoning_efforts: config.efforts,
      default_reasoning_effort: config.defaultEffort ?? null,
      context_windows: config.contextWindows,
      default_context_window: clientContext,
      qoder_default_context_window: config.defaultContextWindow ?? null,
      max_input_tokens: config.maxInputTokens,
    }; });
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      object: 'list',
      source: this.catalog.source,
      data: models,
      has_more: false,
      first_id: models[0]?.id ?? null,
      last_id: models.at(-1)?.id ?? null,
    }));
  }

  private buildQoderRequestBody(
    messages: Array<any>,
    modelConfig: QoderModelConfig,
    effort: ReasoningEffort | undefined,
    contextWindow: number,
    maxTokens?: number,
    tools?: any[],
    toolChoice?: any,
  ): any {
    const body = JSON.parse(JSON.stringify(this.templateBase));

    const newRequestId = crypto.randomUUID();
    body.request_id = newRequestId;
    body.chat_record_id = newRequestId;
    body.request_set_id = crypto.randomUUID();
    body.session_id = crypto.randomUUID();
    body.stream = true;
    body.aliyun_user_type = this.session.identity.userType;
    const isReasoning = effort === 'none'
      ? false
      : effort !== undefined
        ? modelConfig.isReasoning || modelConfig.supportsThinking
        : modelConfig.isReasoning;

    if (body.model_config) {
      body.model_config.key = modelConfig.key;
      body.model_config.display_name = modelConfig.displayName;
      body.model_config.format = modelConfig.format;
      body.model_config.source = modelConfig.source;
      body.model_config.max_input_tokens = modelConfig.maxInputTokens;
      body.model_config.is_reasoning = isReasoning;
      delete body.model_config.reasoning_effort;
    }

    if (body.chat_context?.extra?.modelConfig) {
      body.chat_context.extra.modelConfig.key = modelConfig.key;
      body.chat_context.extra.modelConfig.is_reasoning = isReasoning;
      delete body.chat_context.extra.modelConfig.reasoning_effort;
    }

    body.parameters ??= {};
    if (typeof maxTokens === 'number' && Number.isFinite(maxTokens) && maxTokens > 0) {
      body.parameters.max_tokens = Math.floor(maxTokens);
    }
    body.parameters.context_length = contextWindow;
    if (effort) {
      body.parameters.reasoning_effort = effort;
      body.parameters.enable_thinking = effort !== 'none';
      if (effort === 'none') delete body.parameters.reasoning_budget_tokens;
      else body.parameters.reasoning_budget_tokens = EFFORT_BUDGETS[effort];
    }

    // Extract last user message text for prompt field
    let prompt = '';
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i].role === 'user') {
        const content = messages[i].content;
        prompt = typeof content === 'string' ? content : JSON.stringify(content);
        break;
      }
    }

    if (body.chat_context) {
      if (body.chat_context.text) {
        body.chat_context.text.text = prompt;
      }
      if (body.chat_context.extra?.originalContent) {
        body.chat_context.extra.originalContent.text = prompt;
      }
    }

    if (body.business) {
      body.business.id = crypto.randomUUID();
      body.business.begin_at = Date.now();
      body.business.name = prompt.length > 30 ? prompt.substring(0, 30) : prompt;
    }

    body.messages = messages;

    // Inject tools if provided
    if (tools && tools.length > 0) {
      body.tools = tools;
    }
    if (toolChoice !== undefined) {
      body.tool_choice = toolChoice;
    }

    return body;
  }

  private async handleStreamResponse(
    res: http.ServerResponse,
    body: any,
    extraHeaders: Record<string, string>,
    requestId: string,
    created: number,
    model: string,
    signal: AbortSignal,
  ): Promise<void> {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
    });
    const pingTimer = setInterval(() => {
      if (!res.writable || res.socket?.destroyed) return clearInterval(pingTimer);
      res.write(': ping\n\n');
    }, SSE_PING_INTERVAL_MS);
    let sentRole = false;
    let finishReason: string | null = null;
    try {
      await this.openUpstreamStream(body, extraHeaders, (line) => {
        if (!line.startsWith('data:')) return;
        const delta = extractDelta(line.substring(5).trim());
        if (!delta) return;
        if (delta.finish_reason) finishReason = delta.finish_reason;
        if (!delta.content && !delta.tool_calls) return;
        const chunk = makeChunk(requestId, created, model);
        chunk.choices[0].delta = {
          ...!sentRole ? { role: 'assistant' } : {},
          ...delta.content ? { content: delta.content } : {},
          ...delta.tool_calls ? { tool_calls: delta.tool_calls } : {},
        };
        sentRole = true;
        res.write(`data: ${JSON.stringify(chunk)}\n\n`);
      }, signal);
    } catch (error) {
      clearInterval(pingTimer);
      if (!signal.aborted) {
        res.write(`data: ${JSON.stringify({ error: { type: 'api_error', message: 'Qoder upstream failed before completion' } })}\n\n`);
        res.write('data: [DONE]\n\n');
      }
      res.end();
      return;
    }
    clearInterval(pingTimer);

    const doneChunk = makeChunk(requestId, created, model);
    doneChunk.choices[0].finish_reason = finishReason === 'tool_calls' ? 'tool_calls' : 'stop';
    doneChunk.choices[0].delta = {};
    res.write(`data: ${JSON.stringify(doneChunk)}\n\n`);
    res.write('data: [DONE]\n\n');
    res.end();
  }

  private async handleNonStreamResponse(
    res: http.ServerResponse,
    body: any,
    extraHeaders: Record<string, string>,
    requestId: string,
    created: number,
    model: string,
    signal: AbortSignal,
  ): Promise<void> {
    let fullContent = '';
    let finishReason: string | null = null;
    let promptTokens = 0;
    let completionTokens = 0;
    const aggregator = new ToolCallAggregator();

    await this.openUpstreamStream(body, extraHeaders, (line) => {
      if (!line.startsWith('data:')) return;
      const delta = extractDelta(line.substring(5).trim());
      if (!delta) return;
      if (delta.content) fullContent += delta.content;
      if (delta.finish_reason) finishReason = delta.finish_reason;
      if (delta.usage) {
        promptTokens = delta.usage.prompt_tokens ?? promptTokens;
        completionTokens = delta.usage.completion_tokens ?? completionTokens;
      }
      aggregator.feedDelta({ tool_calls: delta.tool_calls });
    }, signal);
    aggregator.finalize(finishReason);
    const toolCalls = aggregator.collect().map((call) => ({
      id: call.id,
      type: 'function',
      function: { name: call.name, arguments: call.arguments },
    }));
    const message: any = { role: 'assistant', content: fullContent };
    if (toolCalls.length > 0) message.tool_calls = toolCalls;

    const response = {
      id: requestId,
      object: 'chat.completion',
      created,
      model,
      choices: [{
        index: 0,
        message,
        finish_reason: toolCalls.length > 0 ? 'tool_calls' : 'stop',
      }],
      usage: {
        prompt_tokens: promptTokens,
        completion_tokens: completionTokens,
        total_tokens: promptTokens + completionTokens,
      },
    };

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(response));
  }
}

interface UpstreamDelta {
  content?: string;
  reasoning_content?: string;
  tool_calls?: Array<{ index: number; id?: string; type?: string; function?: { name?: string; arguments?: string } }>;
  finish_reason?: string | null;
  usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
}

function extractDelta(dataLine: string): UpstreamDelta | null {
  try {
    const wrapper = JSON.parse(dataLine);
    const innerBody = wrapper?.body;
    if (!innerBody || typeof innerBody !== 'string') return null;
    if (innerBody === '[DONE]') return null;
    const innerJson = JSON.parse(innerBody);

    const choices = innerJson?.choices;
    if (!Array.isArray(choices) || choices.length === 0) return null;
    const choice = choices[0];
    const delta = choice?.delta;
    const usage = innerJson?.usage as UpstreamDelta['usage'] | undefined;

    if (!delta || typeof delta !== 'object') {
      if (choice.finish_reason || usage) {
        return {
          finish_reason: choice.finish_reason ?? null,
          usage,
        };
      }
      return null;
    }

    return {
      content: typeof delta.content === 'string' ? delta.content : undefined,
      reasoning_content: typeof delta.reasoning_content === 'string' ? delta.reasoning_content : undefined,
      tool_calls: Array.isArray(delta.tool_calls) ? delta.tool_calls : undefined,
      finish_reason: choice.finish_reason ?? null,
      usage,
    };
  } catch {
    if (dataLine.length > 0 && dataLine !== '[DONE]') {
      const preview = dataLine.length > 120 ? dataLine.substring(0, 120) + '...' : dataLine;
      console.warn('[extractDelta] failed to parse SSE data:', preview);
    }
    return null;
  }
}

function makeChunk(id: string, created: number, model: string): any {
  return {
    id,
    object: 'chat.completion.chunk',
    created,
    model,
    choices: [{
      index: 0,
      delta: {},
      finish_reason: null as string | null,
    }],
  };
}

export function getClientDefaultContext(model: QoderModelConfig): number {
  return model.contextWindows.includes(1_000_000)
    ? 1_000_000
    : model.defaultContextWindow ?? model.maxInputTokens;
}

export function getClaudeGatewayModelId(model: QoderModelConfig): string {
  const suffix = getClientDefaultContext(model) === 1_000_000 ? '[1m]' : '';
  return `claude-qoder-${model.key}${suffix}`;
}

function formatContextWindow(tokens: number): string {
  if (tokens === 1_000_000) return '1M';
  if (tokens % 1_000 === 0) return `${tokens / 1_000}K`;
  return String(tokens);
}

export function getClaudeGatewayDisplayName(
  model: QoderModelConfig,
  contextWindow = getClientDefaultContext(model),
): string {
  const effortLabel = model.efforts.length > 0
    ? model.efforts.join('/')
    : 'server effort';
  return `Qoder ${model.displayName} · ${formatContextWindow(contextWindow)} · ${effortLabel}`;
}

function readRequestBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const declaredLength = Number.parseInt(String(req.headers['content-length'] ?? '0'), 10);
    if (Number.isFinite(declaredLength) && declaredLength > MAX_REQUEST_BODY_SIZE) {
      req.resume();
      reject(new HttpError(413, `Request body exceeds ${MAX_REQUEST_BODY_SIZE} bytes`, 'request_too_large'));
      return;
    }
    const chunks: Buffer[] = [];
    let bytes = 0;
    let finished = false;
    req.on('data', (chunk: Buffer) => {
      if (finished) return;
      bytes += chunk.length;
      if (bytes > MAX_REQUEST_BODY_SIZE) {
        finished = true;
        req.resume();
        reject(new HttpError(413, `Request body exceeds ${MAX_REQUEST_BODY_SIZE} bytes`, 'request_too_large'));
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (!finished) resolve(Buffer.concat(chunks).toString('utf8'));
    });
    req.on('error', reject);
  });
}

async function readJsonRequest(req: http.IncomingMessage): Promise<any> {
  const raw = await readRequestBody(req);
  try { return JSON.parse(raw); }
  catch { throw new HttpError(400, 'Request body must be valid JSON'); }
}

function getPromptPreview(messages: Array<any>): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === 'user') {
      const content = typeof messages[i].content === 'string'
        ? messages[i].content as string
        : JSON.stringify(messages[i].content);
      return content.length > 80 ? content.substring(0, 80) + '...' : content;
    }
  }
  return '<no user message>';
}

function logRequest(
  protocol: string,
  requestedModel: string,
  effectiveModel: string,
  effort: ReasoningEffort | undefined,
  contextWindow: number,
  stream: boolean,
  messages: Array<any>,
): void {
  const chars = JSON.stringify(messages).length;
  const preview = process.env.QODER_LOG_PROMPTS === '1'
    ? ` preview=${JSON.stringify(getPromptPreview(messages))}`
    : '';
  console.log(
    `[${protocol}] requested_model=${requestedModel} effective_model=${effectiveModel}`
    + ` effort=${effort ?? 'default'} context=${contextWindow} stream=${stream}`
    + ` message_count=${messages.length} chars=${chars}${preview}`,
  );
}

function timingSafeEqual(expected: string, actual: string): boolean {
  if (!actual) return false;
  const left = Buffer.from(expected);
  const right = Buffer.from(actual);
  return left.length === right.length && crypto.timingSafeEqual(left, right);
}

function createClientAbortController(
  req: http.IncomingMessage,
  res: http.ServerResponse,
): AbortController {
  const controller = new AbortController();
  req.once('aborted', () => controller.abort());
  res.once('close', () => {
    if (!res.writableEnded) controller.abort();
  });
  return controller;
}

function effortFromThinkingBudget(value: unknown): ReasoningEffort | undefined {
  const budget = Number(value);
  if (!Number.isFinite(budget) || budget < 0) return undefined;
  if (budget === 0) return 'none';
  if (budget <= EFFORT_BUDGETS.low) return 'low';
  if (budget <= EFFORT_BUDGETS.medium) return 'medium';
  if (budget <= EFFORT_BUDGETS.high) return 'high';
  if (budget <= EFFORT_BUDGETS.xhigh) return 'xhigh';
  return 'max';
}

const EFFORT_LEVELS: ReasoningEffort[] = ['none', 'low', 'medium', 'high', 'xhigh', 'max'];

export interface EffortResolution {
  requested?: ReasoningEffort;
  effective?: ReasoningEffort;
  adjusted: boolean;
}

function closestSupportedEffort(
  requested: ReasoningEffort,
  supported: ReasoningEffort[],
): ReasoningEffort {
  const requestedIndex = EFFORT_LEVELS.indexOf(requested);
  return [...supported].sort((left, right) => {
    const leftIndex = EFFORT_LEVELS.indexOf(left);
    const rightIndex = EFFORT_LEVELS.indexOf(right);
    const distance = Math.abs(leftIndex - requestedIndex) - Math.abs(rightIndex - requestedIndex);
    return distance !== 0 ? distance : rightIndex - leftIndex;
  })[0];
}

export function resolveEffortResolution(
  request: any,
  model: QoderModelConfig,
  protocol: 'anthropic' | 'openai',
): EffortResolution {
  const raw = process.env.QODER_REASONING_EFFORT
    ?? request?.reasoning_effort
    ?? request?.reasoning?.effort
    ?? request?.output_config?.effort
    ?? request?.outputConfig?.effort;
  let effort = normalizeReasoningEffort(raw);
  const explicitlyInvalid = raw !== undefined && effort === undefined;
  if (explicitlyInvalid) {
    throw new HttpError(400, `Unsupported reasoning effort: ${String(raw)}`);
  }

  if (protocol === 'anthropic') {
    if (request?.thinking?.type === 'disabled') effort = 'none';
    else if (!effort && request?.thinking?.budget_tokens !== undefined) {
      effort = effortFromThinkingBudget(request.thinking.budget_tokens);
    }
  }
  const requested = effort;
  effort ??= model.defaultEffort;
  if (!effort) return { requested, effective: undefined, adjusted: false };

  if (effort === 'none') {
    if (model.supportsThinking && !model.supportsDisabledThinking) {
      throw new HttpError(400, `Model ${model.key} does not support disabling thinking`);
    }
    return { requested: requested ?? effort, effective: effort, adjusted: false };
  }
  // Claude Code applies the session effort to auxiliary/fast-model calls too.
  // Models without a thinking control simply keep their server default.
  if (!model.supportsThinking) {
    return { requested: requested ?? effort, effective: undefined, adjusted: requested !== undefined };
  }
  // Toggle-only models accept thinking on/off but do not accept named effort.
  if (model.efforts.length === 0) {
    return { requested: requested ?? effort, effective: undefined, adjusted: requested !== undefined };
  }
  if (!model.efforts.includes(effort)) {
    if (process.env.QODER_STRICT_EFFORT === '1') {
      throw new HttpError(
        400,
        `Model ${model.key} does not support effort ${effort}; supported: ${model.efforts.join(', ')}`,
      );
    }
    const effective = closestSupportedEffort(effort, model.efforts);
    console.warn(
      `[effort] adjusted model=${model.key} requested=${effort} effective=${effective}`
      + ` supported=${model.efforts.join(',')}`,
    );
    return { requested: requested ?? effort, effective, adjusted: true };
  }
  return { requested: requested ?? effort, effective: effort, adjusted: false };
}

export function resolveRequestedEffort(
  request: any,
  model: QoderModelConfig,
  protocol: 'anthropic' | 'openai',
): ReasoningEffort | undefined {
  return resolveEffortResolution(request, model, protocol).effective;
}

export function resolveContextWindow(
  request: any,
  model: QoderModelConfig,
  anthropicBeta?: string,
  requestedModel?: string,
): number {
  const raw = process.env.QODER_CONTEXT_WINDOW
    ?? request?.context_window
    ?? request?.contextWindow
    ?? (/context-1m/i.test(anthropicBeta ?? '') || /\[1m\]$/i.test(requestedModel ?? '')
      ? 1_000_000
      : undefined);
  if (raw === undefined) return model.defaultContextWindow ?? model.maxInputTokens;
  const requested = Number.parseInt(String(raw), 10);
  if (!Number.isFinite(requested) || requested <= 0) {
    throw new HttpError(400, `Invalid context window for ${model.key}: ${String(raw)}`);
  }
  if (model.contextWindows.length > 0 && !model.contextWindows.includes(requested)) {
    throw new HttpError(
      400,
      `Model ${model.key} supports context windows: ${model.contextWindows.join(', ')}`,
    );
  }
  if (model.contextWindows.length === 0 && requested > model.maxInputTokens) {
    throw new HttpError(400, `Context window exceeds ${model.key} maximum: ${model.maxInputTokens}`);
  }
  return requested;
}

function estimateAnthropicRequestTokens(request: any): number {
  const relevant = {
    system: request?.system ?? '',
    messages: request?.messages ?? [],
    tools: request?.tools ?? [],
    tool_choice: request?.tool_choice,
  };
  return Math.max(1, Math.ceil(JSON.stringify(relevant).length / CHARS_PER_TOKEN_ESTIMATE));
}

function safeErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message.replace(/(pt-[A-Za-z0-9_-]+)/g, '[REDACTED]');
  return String(error).replace(/(pt-[A-Za-z0-9_-]+)/g, '[REDACTED]');
}

export function isSessionRefreshCandidate(error: unknown): boolean {
  if (error instanceof QoderHttpError && [401, 403].includes(error.status)) return true;
  return /(login expired|"code"\s*:\s*"?(103|105)"?|response aborted|\baborted\b|ECONNRESET|socket hang up)/i
    .test(safeErrorMessage(error));
}

function parseExpiry(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value > 10_000_000_000 ? value : value * 1000;
  }
  if (typeof value === 'string' && value.trim()) {
    const numeric = Number(value);
    if (Number.isFinite(numeric)) return numeric > 10_000_000_000 ? numeric : numeric * 1000;
    const parsed = Date.parse(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

async function createSession(
  pat: string,
  machineId: string,
  machineToken: string,
  machineType: string,
): Promise<{ identity: AuthIdentity; expiresAt: number | null }> {
  const sigClient = new SignatureApiClient(machineId, machineToken, machineType);
  let jobToken: Awaited<ReturnType<SignatureApiClient['exchangeJobToken']>> | null = null;
  let lastError: unknown;
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      jobToken = await sigClient.exchangeJobToken(pat);
      break;
    } catch (error) {
      lastError = error;
      if (attempt === 3) break;
      const delayMs = 2_000 * Math.pow(2, attempt);
      console.warn(`[auth] token exchange failed; retry=${attempt + 1}/3 delay_ms=${delayMs}: ${safeErrorMessage(error)}`);
      await new Promise<void>((resolve) => {
        setTimeout(resolve, delayMs);
      });
    }
  }
  if (!jobToken) throw lastError instanceof Error ? lastError : new Error(String(lastError));
  const identity: AuthIdentity = {
    name: jobToken.name || '',
    aid: jobToken.id || '',
    uid: jobToken.id || '',
    yxUid: '',
    organizationId: '',
    organizationName: '',
    userType: jobToken.userType || 'personal_standard',
    securityOauthToken: jobToken.securityOauthToken || '',
    refreshToken: jobToken.refreshToken || '',
  };
  return { identity, expiresAt: parseExpiry(jobToken.expireTime) };
}

/**
 * Maps Anthropic/Claude model names to Qoder model keys.
 * Claude Code sends model names like "claude-sonnet-4-5", "claude-opus-4-7", etc.
 * We map all of them to the configured Qoder model (default: ultimate).
 */
type QoderMessage = {
  role: string;
  content: string | object;
  tool_calls?: OpenAiToolCall[];
  tool_call_id?: string;
  name?: string;
};

type MessageUnit = {
  messages: QoderMessage[];
  estimatedTokens: number;
};

function estimateMessageTokens(message: QoderMessage): number {
  return Math.ceil(JSON.stringify(message).length / CHARS_PER_TOKEN_ESTIMATE);
}

function estimateMessageUnitTokens(messages: QoderMessage[]): number {
  return messages.reduce(
    (totalTokens, message) => totalTokens + estimateMessageTokens(message),
    0,
  );
}

function buildTrimUnits(messages: QoderMessage[]): MessageUnit[] {
  const units: MessageUnit[] = [];

  for (let messageIndex = 0; messageIndex < messages.length; messageIndex++) {
    const message = messages[messageIndex];
    if (message.role === 'system') continue;

    if (message.role === 'tool') {
      continue;
    }

    if (message.role === 'assistant' && Array.isArray(message.tool_calls) && message.tool_calls.length > 0) {
      const toolCallIds = new Set(message.tool_calls.map((toolCall) => toolCall.id));
      const unitMessages = [message];
      let nextMessageIndex = messageIndex + 1;

      while (nextMessageIndex < messages.length) {
        const nextMessage = messages[nextMessageIndex];
        if (nextMessage.role !== 'tool' || !nextMessage.tool_call_id || !toolCallIds.has(nextMessage.tool_call_id)) {
          break;
        }

        unitMessages.push(nextMessage);
        nextMessageIndex++;
      }

      units.push({
        messages: unitMessages,
        estimatedTokens: estimateMessageUnitTokens(unitMessages),
      });
      messageIndex = nextMessageIndex - 1;
      continue;
    }

    units.push({
      messages: [message],
      estimatedTokens: estimateMessageTokens(message),
    });
  }

  return units;
}

export function trimMessagesForQoder(
  messages: QoderMessage[],
  tokenBudget: number = INPUT_TOKEN_BUDGET,
): QoderMessage[] {
  const systemMessages = messages.filter((message) => message.role === 'system');
  const selectedUnits: MessageUnit[] = [];
  const trimUnits = buildTrimUnits(messages);
  let remainingBudget = tokenBudget - estimateMessageUnitTokens(systemMessages);

  for (let unitIndex = trimUnits.length - 1; unitIndex >= 0; unitIndex--) {
    const unit = trimUnits[unitIndex];
    if (unit.estimatedTokens > remainingBudget && selectedUnits.length > 0) {
      continue;
    }

    selectedUnits.unshift(unit);
    remainingBudget -= unit.estimatedTokens;
  }

  return [...systemMessages, ...selectedUnits.flatMap((unit) => unit.messages)];
}

export function resolveModelKey(requestedModel: string): string {
  const catalog = new ModelCatalog();
  return catalog.resolve(requestedModel).key;
}

/**
 * Converts Anthropic Messages API format to OpenAI-compatible messages array.
 * Handles string and structured content blocks, tool_use, tool_result, and system prompts.
 */
export function convertAnthropicMessages(
  anthropicReq: any,
  _tools?: AnthropicTool[],
  _toolChoice?: AnthropicToolChoice,
): Array<{ role: string; content: string | object; tool_calls?: OpenAiToolCall[]; tool_call_id?: string; name?: string }> {
  const result: Array<{ role: string; content: string | object; tool_calls?: OpenAiToolCall[]; tool_call_id?: string }> = [];

  if (anthropicReq.system) {
    const systemText = typeof anthropicReq.system === 'string'
      ? anthropicReq.system
      : Array.isArray(anthropicReq.system)
        ? anthropicReq.system.map((b: any) => b.text || '').join('\n')
        : '';
    if (systemText) result.push({ role: 'system', content: systemText });
  }

  for (const msg of anthropicReq.messages || []) {
    if (typeof msg.content === 'string') {
      result.push({ role: msg.role, content: msg.content });
      continue;
    }
    if (!Array.isArray(msg.content)) {
      result.push({ role: msg.role, content: String(msg.content || '') });
      continue;
    }

    if (msg.role === 'user') {
      const textParts: string[] = [];
      const toolResultMsgs: Array<{ role: 'tool'; tool_call_id: string; content: string }> = [];
      for (const block of msg.content) {
        if (block.type === 'text') {
          textParts.push(block.text || '');
        } else if (block.type === 'tool_result') {
          let text: string;
          if (typeof block.content === 'string') text = block.content;
          else if (Array.isArray(block.content)) {
            text = block.content
              .map((b: any) => (b && typeof b === 'object' && typeof b.text === 'string' ? b.text : JSON.stringify(b)))
              .join('\n');
          } else if (block.content == null) text = '';
          else text = JSON.stringify(block.content);
          toolResultMsgs.push({
            role: 'tool',
            tool_call_id: anthropicIdToOpenAi(block.tool_use_id),
            content: text,
          });
        } else {
          textParts.push(`[${block.type}: ${JSON.stringify(block)}]`);
        }
      }
      for (const t of toolResultMsgs) result.push(t);
      const userText = textParts.join('\n').trim();
      if (userText) result.push({ role: 'user', content: userText });
      continue;
    }

    if (msg.role === 'assistant') {
      const textParts: string[] = [];
      const toolCalls: OpenAiToolCall[] = [];
      for (const block of msg.content) {
        if (block.type === 'text') {
          textParts.push(block.text || '');
        } else if (block.type === 'tool_use') {
          toolCalls.push({
            id: anthropicIdToOpenAi(block.id),
            type: 'function',
            function: {
              name: block.name,
              arguments: JSON.stringify(block.input ?? {}),
            },
          });
        } else {
          textParts.push(`[${block.type}: ${JSON.stringify(block)}]`);
        }
      }
      const assistantMsg: any = { role: 'assistant', content: textParts.join('\n') };
      if (toolCalls.length > 0) assistantMsg.tool_calls = toolCalls;
      result.push(assistantMsg);
      continue;
    }

    // Fallback: stringify
    result.push({ role: msg.role, content: JSON.stringify(msg.content) });
  }

  return result;
}
