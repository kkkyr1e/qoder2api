import { describe, it, expect } from 'vitest';
import { resolveModelKey, convertAnthropicMessages, trimMessagesForQoder } from '../openAiBridge';

describe('resolveModelKey', () => {
  it('should return exact match for known model keys', () => {
    expect(resolveModelKey('lite')).toBe('lite');
    expect(resolveModelKey('plus')).toBe('plus');
    expect(resolveModelKey('max')).toBe('max');
    expect(resolveModelKey('ultimate')).toBe('ultimate');
  });

  it('should be case-insensitive', () => {
    expect(resolveModelKey('LITE')).toBe('lite');
    expect(resolveModelKey('Plus')).toBe('plus');
    expect(resolveModelKey('MAX')).toBe('max');
  });

  it('should match when model name contains a known key', () => {
    expect(resolveModelKey('qoder-lite-v2')).toBe('lite');
    expect(resolveModelKey('some-plus-model')).toBe('plus');
  });

  it('should map Claude model names via explicit mapping', () => {
    expect(resolveModelKey('claude-sonnet-4-5')).toBe('max');
    expect(resolveModelKey('claude-opus-4-7')).toBe('ultimate');
    expect(resolveModelKey('claude-3-haiku')).toBe('lite');
    expect(resolveModelKey('claude-3-opus')).toBe('ultimate');
  });

  it('should fallback by substring pattern for unknown claude models', () => {
    expect(resolveModelKey('some-haiku-variant')).toBe('lite');
    expect(resolveModelKey('new-sonnet-model')).toBe('max');
    expect(resolveModelKey('future-opus-version')).toBe('ultimate');
  });

  it('should default to "ultimate" for completely unknown models', () => {
    expect(resolveModelKey('unknown-model')).toBe('ultimate');
    expect(resolveModelKey('')).toBe('ultimate');
  });
});

describe('trimMessagesForQoder', () => {
  it('returns all messages when the estimated token count is within budget', () => {
    const messages = [
      { role: 'system', content: 'rules' },
      { role: 'user', content: 'hello' },
      { role: 'assistant', content: 'hi' },
    ];

    expect(trimMessagesForQoder(messages, 1_000)).toEqual(messages);
  });

  it('trims the oldest non-system messages and keeps the latest user request', () => {
    const messages = [
      { role: 'system', content: 'system prompt' },
      { role: 'user', content: 'old '.repeat(200) },
      { role: 'assistant', content: 'old answer '.repeat(200) },
      { role: 'user', content: 'latest requirement' },
    ];

    const trimmed = trimMessagesForQoder(messages, 40);

    expect(trimmed).toEqual([
      { role: 'system', content: 'system prompt' },
      { role: 'user', content: 'latest requirement' },
    ]);
  });

  it('does not keep orphan tool results when the matching tool call is trimmed', () => {
    const messages = [
      { role: 'system', content: 'system prompt' },
      {
        role: 'assistant',
        content: '',
        tool_calls: [{
          id: 'toolu_1',
          type: 'function' as const,
          function: { name: 'ReadFile', arguments: '{"path":"/tmp/config.xlsx"}' },
        }],
      },
      { role: 'tool', tool_call_id: 'toolu_1', content: 'ok' },
      { role: 'user', content: 'latest requirement' },
    ];

    const trimmed = trimMessagesForQoder(messages, 50);

    expect(trimmed).toEqual([
      { role: 'system', content: 'system prompt' },
      { role: 'user', content: 'latest requirement' },
    ]);
  });
});

describe('convertAnthropicMessages', () => {
  it('should pass through system prompt without modification', () => {
    const result = convertAnthropicMessages({
      system: 'You are helpful.',
      messages: [{ role: 'user', content: 'Hello' }],
    });
    expect(result).toEqual([
      { role: 'system', content: 'You are helpful.' },
      { role: 'user', content: 'Hello' },
    ]);
  });

  it('should handle array system prompt with text blocks', () => {
    const result = convertAnthropicMessages({
      system: [{ text: 'Part 1' }, { text: 'Part 2' }],
      messages: [],
    });
    expect(result).toEqual([
      { role: 'system', content: 'Part 1\nPart 2' },
    ]);
  });

  it('should handle string message content without injecting system', () => {
    const result = convertAnthropicMessages({
      messages: [
        { role: 'user', content: 'Hello' },
        { role: 'assistant', content: 'Hi there' },
      ],
    });
    expect(result).toEqual([
      { role: 'user', content: 'Hello' },
      { role: 'assistant', content: 'Hi there' },
    ]);
  });

  it('should handle structured content blocks (text only)', () => {
    const result = convertAnthropicMessages({
      messages: [{
        role: 'user',
        content: [
          { type: 'text', text: 'First part' },
          { type: 'text', text: 'Second part' },
        ],
      }],
    });
    expect(result).toEqual([
      { role: 'user', content: 'First part\nSecond part' },
    ]);
  });

  it('should convert tool_use blocks to OpenAI tool_calls format', () => {
    const result = convertAnthropicMessages({
      messages: [{
        role: 'assistant',
        content: [
          { type: 'text', text: 'Hello' },
          { type: 'tool_use', id: 'toolu_1', name: 'X', input: { a: 1 } },
        ],
      }],
    });
    expect(result).toHaveLength(1);
    expect(result[0]).toEqual({
      role: 'assistant',
      content: 'Hello',
      tool_calls: [{ id: 'toolu_1', type: 'function', function: { name: 'X', arguments: '{"a":1}' } }],
    });
  });

  it('should convert tool_result blocks to role:tool messages', () => {
    const result = convertAnthropicMessages({
      messages: [{
        role: 'user',
        content: [
          { type: 'tool_result', tool_use_id: 'toolu_1', content: 'ok' },
        ],
      }],
    });
    expect(result).toContainEqual({
      role: 'tool',
      tool_call_id: 'toolu_1',
      content: 'ok',
    });
  });

  it('does not inject tools or extra content into system prompt', () => {
    const out = convertAnthropicMessages({
      system: 'You are helpful',
      messages: [{ role: 'user', content: 'hi' }],
    });
    const sys = out.find((m) => m.role === 'system');
    expect(sys?.content).toBe('You are helpful');
    expect(JSON.stringify(out)).not.toContain('Available Tools');
    expect(JSON.stringify(out)).not.toContain('function_calls');
  });

  it('should return empty array when no system and no messages', () => {
    const result = convertAnthropicMessages({ messages: [] });
    expect(result).toEqual([]);
  });

  it('should not inject system message when no system prompt', () => {
    const result = convertAnthropicMessages({
      messages: [{ role: 'user', content: 'Hi' }],
    });
    expect(result).toEqual([
      { role: 'user', content: 'Hi' },
    ]);
  });
});
