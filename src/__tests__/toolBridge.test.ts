import { describe, it, expect } from 'vitest';
import {
  convertAnthropicToolsToOpenAi,
  convertAnthropicToolChoiceToOpenAi,
  ToolCallAggregator,
} from '../toolBridge';

describe('convertAnthropicToolsToOpenAi', () => {
  it('returns [] for undefined / empty', () => {
    expect(convertAnthropicToolsToOpenAi(undefined)).toEqual([]);
    expect(convertAnthropicToolsToOpenAi([])).toEqual([]);
  });
  it('maps anthropic tool to openai function shape', () => {
    const out = convertAnthropicToolsToOpenAi([
      { name: 'Write', description: 'write a file', input_schema: { type: 'object', properties: { path: { type: 'string' } } } },
    ]);
    expect(out).toEqual([{
      type: 'function',
      function: {
        name: 'Write',
        description: 'write a file',
        parameters: { type: 'object', properties: { path: { type: 'string' } } },
      },
    }]);
  });
  it('falls back to empty schema when input_schema missing', () => {
    const out = convertAnthropicToolsToOpenAi([{ name: 'X' }]);
    expect(out[0].function.parameters).toEqual({ type: 'object', properties: {} });
  });
});

describe('convertAnthropicToolChoiceToOpenAi', () => {
  it('handles auto / any / specific tool', () => {
    expect(convertAnthropicToolChoiceToOpenAi({ type: 'auto' })).toBe('auto');
    expect(convertAnthropicToolChoiceToOpenAi({ type: 'any' })).toBe('required');
    expect(convertAnthropicToolChoiceToOpenAi({ type: 'tool', name: 'X' })).toEqual({ type: 'function', function: { name: 'X' } });
  });
  it('returns undefined for unsupported / null', () => {
    expect(convertAnthropicToolChoiceToOpenAi(null)).toBeUndefined();
    expect(convertAnthropicToolChoiceToOpenAi(undefined)).toBeUndefined();
  });
});

describe('ToolCallAggregator', () => {
  it('aggregates a single tool call across many chunks', () => {
    const a = new ToolCallAggregator();
    const e1 = a.feedDelta({ tool_calls: [{ index: 0, id: 'call_1', type: 'function', function: { name: 'Write', arguments: '' } }] });
    const e2 = a.feedDelta({ tool_calls: [{ index: 0, function: { arguments: '{"path":' } }] });
    const e3 = a.feedDelta({ tool_calls: [{ index: 0, function: { arguments: '"/tmp/x"}' } }] });
    const final = a.finalize('tool_calls');

    expect(e1.find((x) => x.type === 'tool_use_start')).toMatchObject({ id: 'call_1', name: 'Write', index: 0 });
    expect(e2.filter((x) => x.type === 'tool_use_input_delta').map((x: any) => x.partial_json).join('')).toBe('{"path":');
    expect(e3.filter((x) => x.type === 'tool_use_input_delta').map((x: any) => x.partial_json).join('')).toBe('"/tmp/x"}');
    expect(final.events).toEqual([{ type: 'tool_use_stop', index: 0 }]);
    expect(final.stopReason).toBe('tool_use');
    expect(a.collect()).toEqual([{ id: 'call_1', name: 'Write', arguments: '{"path":"/tmp/x"}', index: 0 }]);
  });

  it('handles parallel tool calls (two indices interleaved)', () => {
    const a = new ToolCallAggregator();
    a.feedDelta({ tool_calls: [{ index: 0, id: 'call_a', function: { name: 'A', arguments: '{"x":1' } }] });
    a.feedDelta({ tool_calls: [{ index: 1, id: 'call_b', function: { name: 'B', arguments: '{"y":' } }] });
    a.feedDelta({ tool_calls: [{ index: 0, function: { arguments: '}' } }] });
    a.feedDelta({ tool_calls: [{ index: 1, function: { arguments: '2}' } }] });
    const collected = a.collect();
    expect(collected).toHaveLength(2);
    expect(collected[0]).toMatchObject({ id: 'call_a', name: 'A', arguments: '{"x":1}', index: 0 });
    expect(collected[1]).toMatchObject({ id: 'call_b', name: 'B', arguments: '{"y":2}', index: 1 });
    const final = a.finalize('tool_calls');
    expect(final.events.map((e: any) => e.index)).toEqual([0, 1]);
    expect(final.stopReason).toBe('tool_use');
  });

  it('emits text events alongside tool calls', () => {
    const a = new ToolCallAggregator();
    const ev = a.feedDelta({ content: 'hello ', tool_calls: [{ index: 0, id: 'c', function: { name: 'T', arguments: '{}' } }] });
    expect(ev[0]).toEqual({ type: 'text', delta: 'hello ' });
    expect(ev.find((x) => x.type === 'tool_use_start')).toMatchObject({ id: 'c', name: 'T', index: 0 });
  });

  it('reports end_turn when no tool calls were seen', () => {
    const a = new ToolCallAggregator();
    a.feedDelta({ content: 'just text' });
    const final = a.finalize('stop');
    expect(final.stopReason).toBe('end_turn');
    expect(final.events).toEqual([]);
  });

  it('defers tool_use_start until name is available', () => {
    const a = new ToolCallAggregator();
    const ev1 = a.feedDelta({ tool_calls: [{ index: 0, id: 'call_x' }] }); // no name yet
    expect(ev1.filter((x) => x.type === 'tool_use_start')).toHaveLength(0);
    const ev2 = a.feedDelta({ tool_calls: [{ index: 0, function: { name: 'Late', arguments: '{}' } }] });
    expect(ev2.find((x) => x.type === 'tool_use_start')).toMatchObject({ id: 'call_x', name: 'Late' });
  });

  it('generates a tool id when upstream omits one', () => {
    const a = new ToolCallAggregator();
    const ev = a.feedDelta({ tool_calls: [{ index: 0, function: { name: 'NoId', arguments: '{}' } }] });
    const start: any = ev.find((x) => x.type === 'tool_use_start');
    expect(start.id).toMatch(/^toolu_[0-9a-f]+$/);
  });
});
