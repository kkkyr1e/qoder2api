import { describe, it, expect } from 'vitest';
import { sign, currentDate, APPCODE } from '../signature';

describe('signature', () => {
  it('should return a 32-character hex MD5 hash', () => {
    const date = 'Mon, 01 Jan 2024 00:00:00 GMT';
    const result = sign(date);
    expect(result).toMatch(/^[0-9a-f]{32}$/);
  });

  it('should produce deterministic output for the same date', () => {
    const date = 'Tue, 15 Apr 2025 12:00:00 GMT';
    const result1 = sign(date);
    const result2 = sign(date);
    expect(result1).toBe(result2);
  });

  it('should produce different output for different dates', () => {
    const result1 = sign('Mon, 01 Jan 2024 00:00:00 GMT');
    const result2 = sign('Tue, 02 Jan 2024 00:00:00 GMT');
    expect(result1).not.toBe(result2);
  });

  it('should export APPCODE as "cosy"', () => {
    expect(APPCODE).toBe('cosy');
  });

  it('currentDate should return a valid RFC 1123 date string', () => {
    const date = currentDate();
    expect(date).toMatch(/^[A-Z][a-z]{2}, \d{2} [A-Z][a-z]{2} \d{4} \d{2}:\d{2}:\d{2} GMT$/);
  });
});
