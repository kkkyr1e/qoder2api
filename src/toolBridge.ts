/**
 * Bridge between Anthropic tool_use protocol and OpenAI Chat Completions
 * tool_calls protocol that Qoder upstream actually speaks (verified by
 * inspecting qodercli.exe go struct tags).
 */

import crypto from 'crypto';

// ---------- Anthropic-side types ----------

export interface AnthropicTool {
  name: string;
  description?: string;
  input_schema?: unknown;
}

export type AnthropicToolChoice =
  | { type: 'auto' }
  | { type: 'any' }
  | { type: 'tool'; name: string }
  | undefined
  | null;

export interface AnthropicToolUseBlock {
  type: 'tool_use';
  id: string;
  name: string;
  input: unknown;
}

export interface AnthropicToolResultBlock {
  type: 'tool_result';
  tool_use_id: string;
  content: unknown;
  is_error?: boolean;
}

// ---------- OpenAI-side types (for Qoder upstream body) ----------

export interface OpenAiToolDef {
  type: 'function';
  function: {
    name: string;
    description?: string;
    parameters?: unknown;
  };
}

export type OpenAiToolChoice =
  | 'auto'
  | 'none'
  | 'required'
  | { type: 'function'; function: { name: string } };

export interface OpenAiToolCall {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
}

// ---------- Tool list conversion ----------

export function convertAnthropicToolsToOpenAi(
  tools: AnthropicTool[] | undefined,
): OpenAiToolDef[] {
  if (!Array.isArray(tools) || tools.length === 0) return [];
  return tools.map((t) => ({
    type: 'function',
    function: {
      name: t.name,
      description: t.description,
      parameters: (t.input_schema as object | undefined) ?? { type: 'object', properties: {} },
    },
  }));
}

export function convertAnthropicToolChoiceToOpenAi(
  choice: AnthropicToolChoice,
): OpenAiToolChoice | undefined {
  if (!choice || typeof choice !== 'object') return undefined;
  if (choice.type === 'auto') return 'auto';
  if (choice.type === 'any') return 'required';
  if (choice.type === 'tool' && choice.name) {
    return { type: 'function', function: { name: choice.name } };
  }
  return undefined;
}

// ---------- Stable id mapping ----------

/**
 * Anthropic tool_use ids look like "toolu_xxx"; OpenAI tool_call ids look
 * like "call_xxx". They must match between the assistant message that
 * announces a tool call and the subsequent role:"tool" result. We pass
 * the original Anthropic id through so CC can correlate when we echo it
 * back.
 */
export function anthropicIdToOpenAi(id: string): string {
  return id; // pass through; both sides accept arbitrary string ids
}
export function openAiIdToAnthropic(id: string): string {
  return id;
}
export function generateToolUseId(): string {
  return 'toolu_' + crypto.randomBytes(12).toString('hex');
}

// ---------- Streaming tool_calls aggregation ----------

/**
 * Upstream emits delta.tool_calls[] across many chunks. Each item has an
 * `index` (the position in the assistant's tool_calls array). Successive
 * chunks for the same index merge: id/name appear once, `arguments` is a
 * string built up incrementally.
 *
 * We translate that into Anthropic-style events:
 *   { type: 'tool_use_start', id, name }
 *   { type: 'tool_use_input_delta', partial_json }   (per chunk)
 *   { type: 'tool_use_stop' }
 */

export interface ToolCallChunkItem {
  index: number;
  id?: string;
  type?: string;
  function?: { name?: string; arguments?: string };
}

export type AggregatorEvent =
  | { type: 'text'; delta: string }
  | { type: 'tool_use_start'; id: string; name: string; index: number }
  | { type: 'tool_use_input_delta'; index: number; partial_json: string }
  | { type: 'tool_use_stop'; index: number };

export class ToolCallAggregator {
  private active: Map<number, { id: string; name: string; argsBuf: string }> = new Map();
  private currentIndex: number | null = null;
  private finished = false;

  /** Feed a parsed delta from one upstream SSE chunk. */
  feedDelta(delta: { content?: string; tool_calls?: ToolCallChunkItem[] }): AggregatorEvent[] {
    const events: AggregatorEvent[] = [];
    if (typeof delta.content === 'string' && delta.content.length > 0) {
      events.push({ type: 'text', delta: delta.content });
    }
    if (Array.isArray(delta.tool_calls)) {
      for (const item of delta.tool_calls) {
        if (typeof item.index !== 'number') continue;
        const idx = item.index;
        let entry = this.active.get(idx);
        if (!entry) {
          entry = { id: item.id || '', name: item.function?.name || '', argsBuf: '' };
          this.active.set(idx, entry);
        }
        // Late-arriving id / name fragments
        if (item.id && !entry.id) entry.id = item.id;
        if (item.function?.name && !entry.name) entry.name = item.function.name;

        // Emit start once we have a usable id+name
        if (!(entry as any)._started && entry.name) {
          (entry as any)._started = true;
          if (!entry.id) entry.id = generateToolUseId();
          events.push({ type: 'tool_use_start', id: entry.id, name: entry.name, index: idx });
        }

        const argsChunk = item.function?.arguments ?? '';
        if (argsChunk.length > 0) {
          entry.argsBuf += argsChunk;
          if ((entry as any)._started) {
            events.push({ type: 'tool_use_input_delta', index: idx, partial_json: argsChunk });
          }
        }
        this.currentIndex = idx;
      }
    }
    return events;
  }

  /**
   * Called once when upstream signals end (finish_reason or stream end).
   * Emits tool_use_stop for every active index in ascending order.
   */
  finalize(finishReason: string | null): { events: AggregatorEvent[]; stopReason: 'tool_use' | 'end_turn' } {
    if (this.finished) return { events: [], stopReason: this.active.size > 0 ? 'tool_use' : 'end_turn' };
    this.finished = true;
    const events: AggregatorEvent[] = [];
    const indices = Array.from(this.active.keys()).sort((a, b) => a - b);
    for (const idx of indices) {
      const entry = this.active.get(idx)!;
      if ((entry as any)._started) {
        events.push({ type: 'tool_use_stop', index: idx });
      }
    }
    const hasTools = indices.length > 0;
    const stopReason = hasTools || finishReason === 'tool_calls' ? 'tool_use' : 'end_turn';
    return { events, stopReason };
  }

  /** Returns final aggregated tool calls — useful for non-stream path. */
  collect(): Array<{ id: string; name: string; arguments: string; index: number }> {
    const out: Array<{ id: string; name: string; arguments: string; index: number }> = [];
    const indices = Array.from(this.active.keys()).sort((a, b) => a - b);
    for (const idx of indices) {
      const e = this.active.get(idx)!;
      out.push({ id: e.id, name: e.name, arguments: e.argsBuf, index: idx });
    }
    return out;
  }
}
