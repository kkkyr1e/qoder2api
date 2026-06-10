import fs from 'fs';
import path from 'path';
import { describe, expect, it } from 'vitest';
import { SSE_IDLE_TIMEOUT_MS, SSE_REQUEST_TIMEOUT_MS } from '../constants';

describe('BearerApiClient stream timeout configuration', () => {
  it('uses shared SSE timeout constants instead of short hard-coded values', () => {
    const sourcePath = path.resolve(__dirname, '..', 'bearerApiClient.ts');
    const source = fs.readFileSync(sourcePath, 'utf-8');

    expect(SSE_IDLE_TIMEOUT_MS).toBeGreaterThanOrEqual(60_000);
    expect(SSE_REQUEST_TIMEOUT_MS).toBeGreaterThanOrEqual(300_000);
    expect(source).toContain('SSE_IDLE_TIMEOUT_MS');
    expect(source).toContain('SSE_REQUEST_TIMEOUT_MS');
    expect(source).not.toContain('}, 3000);');
  });
});
