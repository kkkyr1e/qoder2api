/**
 * Core bridge module: converts both OpenAI and Anthropic Messages API requests
 * to Qoder SSE agent requests.
 * Supports streaming and non-streaming modes, and model switching (lite/plus/max/ultimate).
 * Claude Code connects via Anthropic Messages format (/v1/messages).
 */

import http from 'http';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { SignatureApiClient } from './signatureApiClient';
import * as bearerBuilder from './bearerBuilder';
import { BearerApiClient } from './bearerApiClient';
import { CHARS_PER_TOKEN_ESTIMATE, INPUT_TOKEN_BUDGET, SSE_PING_INTERVAL_MS, SSE_REQUEST_TIMEOUT_MS } from './constants';
import type { SessionContext, AuthIdentity } from './bearerBuilder';
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

interface ModelConfig {
  key: string;
  displayName: string;
  isReasoning: boolean;
}

const MODEL_CONFIGS: Record<string, ModelConfig> = {
  lite:     { key: 'lite',     displayName: 'Lite',     isReasoning: false },
  plus:     { key: 'plus',     displayName: 'Plus',     isReasoning: false },
  max:      { key: 'max',      displayName: 'Max',      isReasoning: true },
  ultimate: { key: 'ultimate', displayName: 'Ultimate', isReasoning: true },
};

export class OpenAiBridge {
  private readonly session: SessionContext;
  private readonly bearerClient: BearerApiClient;
  private readonly templateBase: any;

  private constructor(session: SessionContext, bearerClient: BearerApiClient, templateBase: any) {
    this.session = session;
    this.bearerClient = bearerClient;
    this.templateBase = templateBase;
  }

  static async create(pat: string): Promise<OpenAiBridge> {
    const machineId = crypto.randomUUID();
    const machineToken = Buffer.from(
      (crypto.randomUUID() + crypto.randomUUID()).substring(0, 50),
    ).toString('base64url');
    const machineType = crypto.randomUUID().replace(/-/g, '').substring(0, 18);

    const sigClient = new SignatureApiClient(machineId, machineToken, machineType);
    const jobToken = await sigClient.exchangeJobToken(pat);
    console.log(`[bridge] session for ${jobToken.name} (${jobToken.id})`);

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

    const session = bearerBuilder.newSession(identity, machineId, machineToken, machineType);
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

    return new OpenAiBridge(session, bearerClient, templateBase);
  }

  start(port: number): void {
    const server = http.createServer((req, res) => {
      this.handleRequest(req, res).catch((error) => {
        console.error('[bridge] unhandled error:', error);
        if (!res.headersSent) {
          res.writeHead(500, { 'Content-Type': 'application/json' });
        }
        res.end(JSON.stringify({ error: { message: String(error), type: 'qoder_error' } }));
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
      console.log(`[bridge] supported models: ${Object.keys(MODEL_CONFIGS).join(', ')}`);
    });
  }

  private async handleRequest(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const url = req.url?.split('?')[0];

    if (url === '/v1/models' && req.method === 'GET') {
      return this.handleModels(res);
    }

    if (url === '/v1/messages' && req.method === 'POST') {
      return this.handleAnthropicMessages(req, res);
    }

    if (url === '/v1/messages/count_tokens' && req.method === 'POST') {
      return this.handleCountTokens(res);
    }

    if (url === '/v1/chat/completions' && req.method === 'POST') {
      return this.handleOpenAiChat(req, res);
    }

    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: { message: 'Not found', type: 'invalid_request' } }));
  }

  private async handleOpenAiChat(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {

    const rawBody = await readRequestBody(req);
    const openaiRequest = JSON.parse(rawBody);
    const stream = openaiRequest.stream ?? false;
    const model = openaiRequest.model || 'max';
    const messages: Array<any> = openaiRequest.messages || [];

    // Force all requests to use 'ultimate' model (1M context, effort=max)
    const modelConfig = MODEL_CONFIGS['ultimate'];
    const effectiveModelKey = modelConfig.key;

    const body = this.buildQoderRequestBody(messages, effectiveModelKey, modelConfig, openaiRequest.tools, openaiRequest.tool_choice);

    const extraHeaders: Record<string, string> = {
      'x-model-key': effectiveModelKey,
      'x-model-source': 'system',
    };

    const requestId = 'chatcmpl-' + crypto.randomUUID().replace(/-/g, '').substring(0, 24);
    const created = Math.floor(Date.now() / 1000);

    console.log(`[bridge] model=${effectiveModelKey} stream=${stream} prompt=${getPromptPreview(messages)}`);

    if (stream) {
      await this.handleStreamResponse(res, body, extraHeaders, requestId, created, effectiveModelKey);
    } else {
      await this.handleNonStreamResponse(res, body, extraHeaders, requestId, created, effectiveModelKey);
    }
  }

  /** Anthropic /v1/messages endpoint — Claude Code connects here */
  private async handleAnthropicMessages(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const rawBody = await readRequestBody(req);
    const anthropicReq = JSON.parse(rawBody);
    const stream = anthropicReq.stream ?? false;
    const requestedModel = anthropicReq.model || '';

    // Force all requests to use 'ultimate' model (1M context, effort=max)
    const modelConfig = MODEL_CONFIGS['ultimate'];

    const messages = convertAnthropicMessages(anthropicReq);
    const openAiTools = convertAnthropicToolsToOpenAi(anthropicReq.tools);
    const openAiToolChoice = convertAnthropicToolChoiceToOpenAi(anthropicReq.tool_choice);
    const body = this.buildQoderRequestBody(messages, modelConfig.key, modelConfig, openAiTools, openAiToolChoice);
    const extraHeaders: Record<string, string> = {
      'x-model-key': modelConfig.key,
      'x-model-source': 'system',
    };
    const messageId = 'msg_' + crypto.randomUUID().replace(/-/g, '').substring(0, 24);

    console.log(`[anthropic] model=${requestedModel}->${modelConfig.key} stream=${stream} prompt=${getPromptPreview(messages)}`);

    if (stream) {
      await this.handleAnthropicStream(res, body, extraHeaders, messageId, requestedModel);
    } else {
      await this.handleAnthropicNonStream(res, body, extraHeaders, messageId, requestedModel);
    }
  }

  private async handleAnthropicStream(
    res: http.ServerResponse,
    body: any,
    extraHeaders: Record<string, string>,
    messageId: string,
    model: string,
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
    let currentBlockType: 'thinking' | 'text' | 'tool_use' | null = null;
    let currentToolIndex: number | null = null;
    let stopReason: 'end_turn' | 'tool_use' = 'end_turn';
    let lastFinishReason: string | null = null;

    const closeCurrentBlock = () => {
      if (currentBlockType !== null && blockIndex >= 0) {
        writeSse('content_block_stop', { type: 'content_block_stop', index: blockIndex });
        currentBlockType = null;
        currentToolIndex = null;
      }
    };

    const ensureThinkingBlock = () => {
      if (currentBlockType === 'thinking') return;
      closeCurrentBlock();
      blockIndex++;
      currentBlockType = 'thinking';
      writeSse('content_block_start', {
        type: 'content_block_start', index: blockIndex,
        content_block: { type: 'thinking', thinking: '' },
      });
    };

    const ensureTextBlock = () => {
      if (currentBlockType === 'text') return;
      closeCurrentBlock();
      blockIndex++;
      currentBlockType = 'text';
      writeSse('content_block_start', {
        type: 'content_block_start', index: blockIndex,
        content_block: { type: 'text', text: '' },
      });
    };

    const dispatchEvents = (events: ReturnType<ToolCallAggregator['feedDelta']>) => {
      for (const ev of events) {
        if (ev.type === 'text') {
          if (ev.delta.length === 0) continue;
          ensureTextBlock();
          writeSse('content_block_delta', {
            type: 'content_block_delta', index: blockIndex,
            delta: { type: 'text_delta', text: ev.delta },
          });
        } else if (ev.type === 'tool_use_start') {
          closeCurrentBlock();
          blockIndex++;
          currentBlockType = 'tool_use';
          currentToolIndex = ev.index;
          stopReason = 'tool_use';
          writeSse('content_block_start', {
            type: 'content_block_start', index: blockIndex,
            content_block: { type: 'tool_use', id: ev.id, name: ev.name, input: {} },
          });
          writeSse('content_block_delta', {
            type: 'content_block_delta', index: blockIndex,
            delta: { type: 'input_json_delta', partial_json: '' },
          });
        } else if (ev.type === 'tool_use_input_delta') {
          if (currentBlockType === 'tool_use' && currentToolIndex === ev.index) {
            writeSse('content_block_delta', {
              type: 'content_block_delta', index: blockIndex,
              delta: { type: 'input_json_delta', partial_json: ev.partial_json },
            });
          }
        } else if (ev.type === 'tool_use_stop') {
          if (currentBlockType === 'tool_use' && currentToolIndex === ev.index) {
            closeCurrentBlock();
          }
        }
      }
    };

    try {
      await this.bearerClient.openStreamLines(SSE_ENDPOINT, body, extraHeaders, (line) => {
        if (!line.startsWith('data:')) return;
        const delta = extractDelta(line.substring(5).trim());
        if (!delta) return;
        if (delta.finish_reason) lastFinishReason = delta.finish_reason;
        if (delta.usage) {
          inputTokens = delta.usage.prompt_tokens ?? inputTokens;
          outputTokens = delta.usage.completion_tokens ?? outputTokens;
        }
        if (delta.reasoning_content) {
          ensureThinkingBlock();
          writeSse('content_block_delta', {
            type: 'content_block_delta', index: blockIndex,
            delta: { type: 'thinking_delta', thinking: delta.reasoning_content },
          });
        }
        const events = aggregator.feedDelta({ content: delta.content, tool_calls: delta.tool_calls });
        dispatchEvents(events);
      });
    } catch (error) {
      console.error('[anthropic-stream] upstream error:', error);
      ensureTextBlock();
      writeSse('content_block_delta', {
        type: 'content_block_delta', index: blockIndex,
        delta: { type: 'text_delta', text: `\n\n[Upstream error: ${error instanceof Error ? error.message : String(error)}]` },
      });
    }

    clearInterval(pingTimer);

    const final = aggregator.finalize(lastFinishReason);
    dispatchEvents(final.events);
    if (final.stopReason === 'tool_use') stopReason = 'tool_use';
    closeCurrentBlock();

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
  ): Promise<void> {
    const aggregator = new ToolCallAggregator();
    let lastFinishReason: string | null = null;
    let inputTokens = 0;
    let outputTokens = 0;
    let thinkingBuf = '';
    let textBuf = '';

    await this.bearerClient.openStreamLines(SSE_ENDPOINT, body, extraHeaders, (line) => {
      if (!line.startsWith('data:')) return;
      const delta = extractDelta(line.substring(5).trim());
      if (!delta) return;
      if (delta.finish_reason) lastFinishReason = delta.finish_reason;
      if (delta.usage) {
        inputTokens = delta.usage.prompt_tokens ?? inputTokens;
        outputTokens = delta.usage.completion_tokens ?? outputTokens;
      }
      if (delta.reasoning_content) thinkingBuf += delta.reasoning_content;
      if (delta.content) textBuf += delta.content;
      aggregator.feedDelta({ tool_calls: delta.tool_calls });
    });

    const final = aggregator.finalize(lastFinishReason);
    const collectedCalls = aggregator.collect();

    type Block =
      | { type: 'thinking'; thinking: string }
      | { type: 'text'; text: string }
      | { type: 'tool_use'; id: string; name: string; input: unknown };
    const blocks: Block[] = [];
    if (thinkingBuf.length > 0) blocks.push({ type: 'thinking', thinking: thinkingBuf });
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

  private handleCountTokens(res: http.ServerResponse): void {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ input_tokens: 0 }));
  }

  private handleModels(res: http.ServerResponse): void {
    const models = Object.entries(MODEL_CONFIGS).map(([key, config]) => ({
      id: `claude-${key}`,
      display_name: `Qoder ${config.displayName}`,
      object: 'model',
      created: 1700000000,
      owned_by: 'qoder',
    }));
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ object: 'list', data: models }));
  }

  private buildQoderRequestBody(
    messages: Array<any>,
    modelKey: string,
    modelConfig: ModelConfig,
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

    if (body.model_config) {
      body.model_config.key = modelKey;
      body.model_config.display_name = modelConfig.displayName;
      body.model_config.is_reasoning = modelConfig.isReasoning;
      body.model_config.reasoning_effort = 'max';
    }

    if (body.chat_context?.extra?.modelConfig) {
      body.chat_context.extra.modelConfig.key = modelKey;
      body.chat_context.extra.modelConfig.is_reasoning = modelConfig.isReasoning;
      body.chat_context.extra.modelConfig.reasoning_effort = 'max';
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
  ): Promise<void> {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
    });

    await this.bearerClient.openStreamLines(SSE_ENDPOINT, body, extraHeaders, (line) => {
      if (!line.startsWith('data:')) return;
      const content = extractContent(line.substring(5).trim());
      if (!content) return;
      const chunk = makeChunk(requestId, created, model);
      chunk.choices[0].delta = { role: 'assistant', content };
      res.write(`data: ${JSON.stringify(chunk)}\n\n`);
    });

    const doneChunk = makeChunk(requestId, created, model);
    doneChunk.choices[0].finish_reason = 'stop';
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
  ): Promise<void> {
    let fullContent = '';

    await this.bearerClient.openStreamLines(SSE_ENDPOINT, body, extraHeaders, (line) => {
      if (!line.startsWith('data:')) return;
      const content = extractContent(line.substring(5).trim());
      if (content) fullContent += content;
    });

    const response = {
      id: requestId,
      object: 'chat.completion',
      created,
      model,
      choices: [{
        index: 0,
        message: { role: 'assistant', content: fullContent },
        finish_reason: 'stop',
      }],
      usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
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

// Keep a thin compat wrapper for the OpenAI bridge path that only needs text.
function extractContent(dataLine: string): string | null {
  const d = extractDelta(dataLine);
  return d?.content ?? null;
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

function readRequestBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', (chunk: Buffer) => { body += chunk.toString(); });
    req.on('end', () => resolve(body));
    req.on('error', reject);
  });
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
  const lower = requestedModel.toLowerCase();

  // Exact match against known config keys first
  for (const key of Object.keys(MODEL_CONFIGS)) {
    if (lower === key || lower.includes(key)) return key;
  }

  // Explicit Claude model family mappings
  const CLAUDE_MAP: Record<string, string> = {
    'claude-3-haiku': 'lite',
    'claude-3-sonnet': 'plus',
    'claude-3-opus': 'ultimate',
    'claude-sonnet-4-5': 'max',
    'claude-opus-4-7': 'ultimate',
  };
  for (const [pattern, key] of Object.entries(CLAUDE_MAP)) {
    if (lower === pattern || lower.includes(pattern)) return key;
  }

  // Substring fallback for model families
  if (lower.includes('haiku')) return 'lite';
  if (lower.includes('sonnet')) return 'max';
  if (lower.includes('opus')) return 'ultimate';

  return 'ultimate';
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
