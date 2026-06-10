import { describe, it, expect } from 'vitest';
import { encode, decode } from '../qoderEncoding';

describe('qoderEncoding', () => {
  it('should roundtrip encode/decode for simple text', () => {
    const original = Buffer.from('hello world');
    const encoded = encode(original);
    const decoded = decode(encoded);
    expect(decoded.toString()).toBe('hello world');
  });

  it('should roundtrip encode/decode for empty buffer', () => {
    const original = Buffer.from('');
    const encoded = encode(original);
    const decoded = decode(encoded);
    expect(decoded.toString()).toBe('');
  });

  it('should roundtrip encode/decode for JSON payload', () => {
    const json = JSON.stringify({ key: 'value', nested: { arr: [1, 2, 3] } });
    const original = Buffer.from(json);
    const encoded = encode(original);
    const decoded = decode(encoded);
    expect(decoded.toString()).toBe(json);
  });

  it('should roundtrip encode/decode for binary-like content', () => {
    const original = Buffer.from([0, 1, 127, 128, 255]);
    const encoded = encode(original);
    const decoded = decode(encoded);
    expect(Buffer.compare(decoded, original)).toBe(0);
  });

  it('should roundtrip encode/decode for long text', () => {
    const longText = 'a'.repeat(10000);
    const original = Buffer.from(longText);
    const encoded = encode(original);
    const decoded = decode(encoded);
    expect(decoded.toString()).toBe(longText);
  });

  it('should produce different output than standard base64', () => {
    const original = Buffer.from('test data');
    const encoded = encode(original);
    const stdBase64 = original.toString('base64');
    expect(encoded).not.toBe(stdBase64);
  });

  it('should throw on invalid custom alphabet character in decode', () => {
    expect(() => decode('~invalid~')).toThrow('Character out of custom alphabet');
  });
});
