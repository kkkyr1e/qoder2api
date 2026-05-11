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
import type { SessionContext, AuthIdentity } from './bearerBuilder';

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

    const templatePath = path.resolve(__dirname, '..', 'qoder2api', 'baseprompt.json');
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
    const model = openaiRequest.model || 'lite';
    const messages: Array<{ role: string; content: string | object }> = openaiRequest.messages || [];

    const modelConfig = MODEL_CONFIGS[model] || MODEL_CONFIGS['lite'];
    const effectiveModelKey = modelConfig.key;

    const body = this.buildQoderRequestBody(messages, effectiveModelKey, modelConfig);

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

    const qoderModelKey = resolveModelKey(requestedModel);
    const modelConfig = MODEL_CONFIGS[qoderModelKey] || MODEL_CONFIGS['ultimate'];

    const messages = convertAnthropicMessages(anthropicReq);
    const body = this.buildQoderRequestBody(messages, modelConfig.key, modelConfig);
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
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
    });

    // message_start
    const messageStartEvent = {
      type: 'message_start',
      message: {
        id: messageId, type: 'message', role: 'assistant', model,
        content: [], stop_reason: null, stop_sequence: null,
        usage: { input_tokens: 0, output_tokens: 0 },
      },
    };
    res.write(`event: message_start\ndata: ${JSON.stringify(messageStartEvent)}\n\n`);

    // content_block_start
    res.write(`event: content_block_start\ndata: ${JSON.stringify({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } })}\n\n`);

    // ping
    res.write(`event: ping\ndata: ${JSON.stringify({ type: 'ping' })}\n\n`);

    let outputTokenEstimate = 0;

    await this.bearerClient.openStreamLines(SSE_ENDPOINT, body, extraHeaders, (line) => {
      if (!line.startsWith('data:')) return;
      const content = extractContent(line.substring(5).trim());
      if (!content) return;
      outputTokenEstimate += Math.ceil(content.length / 4);
      const delta = { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: content } };
      res.write(`event: content_block_delta\ndata: ${JSON.stringify(delta)}\n\n`);
    });

    // content_block_stop
    res.write(`event: content_block_stop\ndata: ${JSON.stringify({ type: 'content_block_stop', index: 0 })}\n\n`);

    // message_delta
    const messageDelta = {
      type: 'message_delta',
      delta: { stop_reason: 'end_turn', stop_sequence: null },
      usage: { output_tokens: outputTokenEstimate },
    };
    res.write(`event: message_delta\ndata: ${JSON.stringify(messageDelta)}\n\n`);

    // message_stop
    res.write(`event: message_stop\ndata: ${JSON.stringify({ type: 'message_stop' })}\n\n`);
    res.end();
  }

  private async handleAnthropicNonStream(
    res: http.ServerResponse,
    body: any,
    extraHeaders: Record<string, string>,
    messageId: string,
    model: string,
  ): Promise<void> {
    let fullContent = '';
    await this.bearerClient.openStreamLines(SSE_ENDPOINT, body, extraHeaders, (line) => {
      if (!line.startsWith('data:')) return;
      const content = extractContent(line.substring(5).trim());
      if (content) fullContent += content;
    });

    const response = {
      id: messageId, type: 'message', role: 'assistant', model,
      content: [{ type: 'text', text: fullContent }],
      stop_reason: 'end_turn', stop_sequence: null,
      usage: { input_tokens: 0, output_tokens: Math.ceil(fullContent.length / 4) },
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
    messages: Array<{ role: string; content: string | object }>,
    modelKey: string,
    modelConfig: ModelConfig,
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
    }

    if (body.chat_context?.extra?.modelConfig) {
      body.chat_context.extra.modelConfig.key = modelKey;
      body.chat_context.extra.modelConfig.is_reasoning = modelConfig.isReasoning;
    }

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

    const existingMessages: any[] = body.messages || [];
    const rebuilt: any[] = [];
    for (const msg of existingMessages) {
      if (msg.role !== 'user') {
        rebuilt.push(msg);
      }
    }

    const userMsg: any = {
      role: 'user',
      content: '',
      contents: [{ type: 'text', text: prompt }],
      response_meta: {
        id: '',
        usage: {
          prompt_tokens: 0,
          completion_tokens: 0,
          total_tokens: 0,
          completion_tokens_details: { reasoning_tokens: 0 },
          prompt_tokens_details: { cached_tokens: 0 },
        },
      },
      reasoning_content_signature: '',
    };
    rebuilt.push(userMsg);
    body.messages = rebuilt;

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

function extractContent(dataLine: string): string | null {
  try {
    const wrapper = JSON.parse(dataLine);
    const innerBody = wrapper?.body;
    if (!innerBody || typeof innerBody !== 'string') return null;
    const innerJson = JSON.parse(innerBody);
    const choices = innerJson?.choices;
    if (!Array.isArray(choices)) return null;
    for (const choice of choices) {
      const content = choice?.delta?.content;
      if (content && typeof content === 'string') return content;
    }
  } catch {
    // ignore parse errors in SSE data
  }
  return null;
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

function getPromptPreview(messages: Array<{ role: string; content: string | object }>): string {
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
function resolveModelKey(requestedModel: string): string {
  const lower = requestedModel.toLowerCase();
  for (const key of Object.keys(MODEL_CONFIGS)) {
    if (lower === key || lower.includes(key)) return key;
  }
  return 'ultimate';
}

/**
 * Converts Anthropic Messages API format to simplified messages array.
 * Handles both string and structured content blocks, plus system prompts.
 */
function convertAnthropicMessages(
  anthropicReq: any,
): Array<{ role: string; content: string }> {
  const result: Array<{ role: string; content: string }> = [];

  if (anthropicReq.system) {
    const systemText = typeof anthropicReq.system === 'string'
      ? anthropicReq.system
      : Array.isArray(anthropicReq.system)
        ? anthropicReq.system.map((block: any) => block.text || '').join('\n')
        : '';
    if (systemText) {
      result.push({ role: 'system', content: systemText });
    }
  }

  for (const msg of anthropicReq.messages || []) {
    let textContent: string;
    if (typeof msg.content === 'string') {
      textContent = msg.content;
    } else if (Array.isArray(msg.content)) {
      textContent = msg.content
        .filter((block: any) => block.type === 'text')
        .map((block: any) => block.text || '')
        .join('\n');
    } else {
      textContent = String(msg.content || '');
    }
    result.push({ role: msg.role, content: textContent });
  }

  return result;
}
