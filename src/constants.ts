/**
 * Shared constants used across multiple modules.
 */

export const COSY_VERSION = '0.1.43';

/** Maximum request body size in bytes (10 MB) */
export const MAX_REQUEST_BODY_SIZE = 10 * 1024 * 1024;

function positiveEnvInt(name: string, fallback: number, minimum: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed >= minimum ? parsed : fallback;
}

/**
 * Upstream silence timeout. It must be longer than Claude Code's normal long
 * reasoning pauses; timing out is reported as an error, never a clean finish.
 */
export const SSE_IDLE_TIMEOUT_MS = positiveEnvInt(
  'QODER_SSE_IDLE_TIMEOUT_MS',
  15 * 60 * 1000,
  60_000,
);

/** HTTP connect timeout in milliseconds */
export const HTTP_CONNECT_TIMEOUT_MS = 30_000;

/** Overall upstream request timeout (default one hour). */
export const SSE_REQUEST_TIMEOUT_MS = positiveEnvInt(
  'QODER_SSE_REQUEST_TIMEOUT_MS',
  60 * 60 * 1000,
  5 * 60 * 1000,
);

/** Interval for sending keepalive pings to downstream client during SSE streaming (30 seconds) */
export const SSE_PING_INTERVAL_MS = positiveEnvInt(
  'QODER_SSE_PING_INTERVAL_MS',
  15_000,
  5_000,
);

/**
 * Maximum input tokens for Qoder API.
 * Using 1M context window for ultimate model.
 */
export const MAX_CONTEXT_TOKENS = 1_000_000;

/** Reserve tokens for model response output */
export const RESPONSE_TOKEN_RESERVE = 32_768;

/** Effective budget for input messages = MAX_CONTEXT_TOKENS - RESPONSE_TOKEN_RESERVE */
export const INPUT_TOKEN_BUDGET = MAX_CONTEXT_TOKENS - RESPONSE_TOKEN_RESERVE;

/**
 * Average characters per token for English text.
 * Claude/GPT tokenizers average ~3.5-4 chars per token for English.
 * We use a conservative 3.5 to slightly overestimate token counts (safer).
 */
export const CHARS_PER_TOKEN_ESTIMATE = 3.5;
