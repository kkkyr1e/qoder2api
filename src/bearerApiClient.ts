/** Bearer-authenticated HTTP client for Qoder API calls. */

import http from 'http';
import https from 'https';
import * as qoderEncoding from './qoderEncoding';
import * as bearerBuilder from './bearerBuilder';
import type { SessionContext } from './bearerBuilder';
import {
  HTTP_CONNECT_TIMEOUT_MS,
  SSE_IDLE_TIMEOUT_MS,
  SSE_REQUEST_TIMEOUT_MS,
} from './constants';

const COSY_VERSION = '0.1.43';
const MAX_UPSTREAM_CONCURRENCY = 2;
const MAX_RETRIES = 3;
const RETRY_BASE_DELAY_MS = 5_000;
const RETRYABLE_STATUS = new Set([429, 502, 503, 504]);
const MAX_ERROR_BODY_CHARS = 8_192;

export class QoderHttpError extends Error {
  constructor(
    public readonly status: number,
    public readonly responseBody: string,
  ) {
    super(`HTTP ${status} body=${responseBody.substring(0, MAX_ERROR_BODY_CHARS)}`);
    this.name = 'QoderHttpError';
  }
}

interface SemaphoreWaiter {
  resolve: () => void;
  reject: (error: Error) => void;
  signal?: AbortSignal;
  abortListener?: () => void;
}

class Semaphore {
  private current = 0;
  private queue: SemaphoreWaiter[] = [];

  constructor(private readonly maxConcurrency: number) {}

  async acquire(signal?: AbortSignal): Promise<void> {
    if (signal?.aborted) throw abortError();
    if (this.current < this.maxConcurrency) {
      this.current++;
      return;
    }
    return new Promise<void>((resolve, reject) => {
      const waiter: SemaphoreWaiter = { resolve, reject, signal };
      if (signal) {
        waiter.abortListener = () => {
          const index = this.queue.indexOf(waiter);
          if (index >= 0) this.queue.splice(index, 1);
          reject(abortError());
        };
        signal.addEventListener('abort', waiter.abortListener, { once: true });
      }
      this.queue.push(waiter);
    });
  }

  release(): void {
    this.current = Math.max(0, this.current - 1);
    while (this.queue.length > 0) {
      const next = this.queue.shift()!;
      if (next.signal?.aborted) continue;
      if (next.abortListener) next.signal?.removeEventListener('abort', next.abortListener);
      this.current++;
      next.resolve();
      break;
    }
  }

  get pending(): number { return this.queue.length; }
  get active(): number { return this.current; }
}

const upstreamSemaphore = new Semaphore(MAX_UPSTREAM_CONCURRENCY);

export function getUpstreamConcurrencyStats(): { active: number; pending: number; limit: number } {
  return { active: upstreamSemaphore.active, pending: upstreamSemaphore.pending, limit: MAX_UPSTREAM_CONCURRENCY };
}

function abortError(): Error {
  const error = new Error('Request aborted');
  error.name = 'AbortError';
  return error;
}

function buildHeaders(
  session: SessionContext,
  bearer: string,
  date: string,
  accept: string,
  extraHeaders?: Record<string, string>,
): Record<string, string> {
  const headers: Record<string, string> = {
    'cosy-data-policy': 'AGREE',
    'content-type': 'application/json',
    'cosy-machinetype': session.machineType,
    'cosy-clienttype': '5',
    'cosy-date': date,
    'cosy-user': session.identity.uid,
    'cosy-key': session.cosyKey,
    accept,
    'cosy-clientip': '169.254.198.161',
    authorization: bearer,
    'accept-encoding': 'identity',
    'cosy-version': COSY_VERSION,
    'cosy-machineid': session.machineId,
    'cosy-machinetoken': session.machineToken,
    'login-version': 'v2',
    'user-agent': 'Go-http-client/2.0',
  };
  if (extraHeaders) Object.assign(headers, extraHeaders);
  return headers;
}

function prepareRequest(
  session: SessionContext,
  fullUrl: string,
  jsonBody: unknown | null,
): { body: string; date: string; bearer: string } {
  const urlObj = new URL(fullUrl);
  const rawPath = urlObj.pathname;
  const pathSig = rawPath.startsWith('/algo') ? rawPath.substring('/algo'.length) : rawPath;
  const body = jsonBody === null ? '' : qoderEncoding.encode(Buffer.from(JSON.stringify(jsonBody)));
  const payloadB64 = bearerBuilder.buildPayloadB64(session.info);
  const date = String(Math.floor(Date.now() / 1000));
  const sig = bearerBuilder.signRequest(payloadB64, session.cosyKey, date, body, pathSig);
  return { body, date, bearer: bearerBuilder.composeBearer(payloadB64, sig) };
}

async function readErrorResponse(response: Response): Promise<string> {
  return (await response.text()).substring(0, MAX_ERROR_BODY_CHARS);
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.reject(abortError());
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
    signal?.addEventListener('abort', () => {
      clearTimeout(timer);
      reject(abortError());
    }, { once: true });
  });
}

export class BearerApiClient {
  constructor(private readonly session: SessionContext) {}

  async callPost(fullUrl: string, jsonBody: unknown, signal?: AbortSignal): Promise<unknown> {
    const { body, date, bearer } = prepareRequest(this.session, fullUrl, jsonBody);
    const headers = buildHeaders(this.session, bearer, date, 'application/json');
    const response = await fetch(fullUrl, {
      method: 'POST', headers, body,
      signal: signal ?? AbortSignal.timeout(HTTP_CONNECT_TIMEOUT_MS),
    });
    if (!response.ok) throw new QoderHttpError(response.status, await readErrorResponse(response));
    return response.json();
  }

  async callGet(fullUrl: string, signal?: AbortSignal): Promise<unknown> {
    const { date, bearer } = prepareRequest(this.session, fullUrl, null);
    const headers = buildHeaders(this.session, bearer, date, 'application/json');
    const response = await fetch(fullUrl, {
      method: 'GET', headers,
      signal: signal ?? AbortSignal.timeout(HTTP_CONNECT_TIMEOUT_MS),
    });
    if (!response.ok) throw new QoderHttpError(response.status, await readErrorResponse(response));
    return response.json();
  }

  async openStreamLines(
    fullUrl: string,
    jsonBody: unknown,
    extraHeaders: Record<string, string> | undefined,
    onLine: (line: string) => void,
    signal?: AbortSignal,
  ): Promise<void> {
    let lastError: Error | null = null;
    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      if (attempt > 0) {
        const delay = RETRY_BASE_DELAY_MS * Math.pow(2, attempt - 1);
        console.warn(`[stream] retry=${attempt}/${MAX_RETRIES} delay_ms=${delay}`);
        await sleep(delay, signal);
      }
      await upstreamSemaphore.acquire(signal);
      try {
        await this.doStreamRequest(fullUrl, jsonBody, extraHeaders, onLine, signal);
        return;
      } catch (error) {
        const normalized = error instanceof Error ? error : new Error(String(error));
        lastError = normalized;
        const status = normalized instanceof QoderHttpError ? normalized.status : null;
        if (status && RETRYABLE_STATUS.has(status) && attempt < MAX_RETRIES) continue;
        throw normalized;
      } finally {
        upstreamSemaphore.release();
      }
    }
    throw lastError ?? new Error('All retries exhausted');
  }

  private doStreamRequest(
    fullUrl: string,
    jsonBody: unknown,
    extraHeaders: Record<string, string> | undefined,
    onLine: (line: string) => void,
    signal?: AbortSignal,
  ): Promise<void> {
    const maxRedirects = 5;
    const session = this.session;

    return new Promise((resolve, reject) => {
      let settled = false;
      let activeRequest: http.ClientRequest | null = null;
      let activeResponse: http.IncomingMessage | null = null;
      let idleTimer: ReturnType<typeof setTimeout> | null = null;
      let totalTimer: ReturnType<typeof setTimeout> | null = null;

      const cleanup = () => {
        if (idleTimer) clearTimeout(idleTimer);
        if (totalTimer) clearTimeout(totalTimer);
        signal?.removeEventListener('abort', onAbort);
      };
      const succeed = () => {
        if (settled) return;
        settled = true;
        cleanup();
        resolve();
      };
      const fail = (error: unknown) => {
        if (settled) return;
        settled = true;
        cleanup();
        reject(error instanceof Error ? error : new Error(String(error)));
      };
      const onAbort = () => {
        const error = abortError();
        activeResponse?.destroy(error);
        activeRequest?.destroy(error);
        fail(error);
      };
      const resetIdleTimer = () => {
        if (idleTimer) clearTimeout(idleTimer);
        idleTimer = setTimeout(() => {
          const error = new Error(`Upstream SSE idle timeout after ${SSE_IDLE_TIMEOUT_MS}ms`);
          activeResponse?.destroy(error);
          activeRequest?.destroy(error);
          fail(error);
        }, SSE_IDLE_TIMEOUT_MS);
      };

      if (signal?.aborted) return fail(abortError());
      signal?.addEventListener('abort', onAbort, { once: true });
      totalTimer = setTimeout(() => {
        const error = new Error(`Upstream SSE request timeout after ${SSE_REQUEST_TIMEOUT_MS}ms`);
        activeResponse?.destroy(error);
        activeRequest?.destroy(error);
        fail(error);
      }, SSE_REQUEST_TIMEOUT_MS);

      const doRequest = (targetUrl: string, redirectsLeft: number): void => {
        if (settled) return;
        const { body, date, bearer } = prepareRequest(session, targetUrl, jsonBody);
        const headers = buildHeaders(session, bearer, date, 'text/event-stream', extraHeaders);
        headers['cache-control'] = 'no-cache';
        const urlObj = new URL(targetUrl);
        const transport = urlObj.protocol === 'https:' ? https : http;

        const request = transport.request({
          hostname: urlObj.hostname,
          port: urlObj.port || (urlObj.protocol === 'https:' ? 443 : 80),
          path: urlObj.pathname + urlObj.search,
          method: 'POST',
          headers,
        }, (response) => {
          activeResponse = response;
          const status = response.statusCode ?? 0;
          if ([301, 302, 307, 308].includes(status)) {
            const location = response.headers.location;
            response.resume();
            if (!location) return fail(new Error(`HTTP ${status} redirect without Location header`));
            if (redirectsLeft <= 0) return fail(new Error(`Too many redirects (last status ${status})`));
            let nextUrl: string;
            try { nextUrl = new URL(location, targetUrl).toString(); }
            catch { return fail(new Error('Invalid redirect Location')); }
            doRequest(nextUrl, redirectsLeft - 1);
            return;
          }
          if (status !== 200) {
            let errorBody = '';
            response.on('data', (chunk: Buffer) => {
              if (errorBody.length < MAX_ERROR_BODY_CHARS) errorBody += chunk.toString();
            });
            response.on('end', () => fail(new QoderHttpError(status, errorBody)));
            response.on('error', fail);
            return;
          }

          let lineBuffer = '';
          resetIdleTimer();
          response.on('data', (chunk: Buffer) => {
            resetIdleTimer();
            lineBuffer += chunk.toString('utf-8');
            let newlineIndex: number;
            while ((newlineIndex = lineBuffer.indexOf('\n')) !== -1) {
              let line = lineBuffer.substring(0, newlineIndex);
              lineBuffer = lineBuffer.substring(newlineIndex + 1);
              if (line.endsWith('\r')) line = line.substring(0, line.length - 1);
              if (line.length > 0) onLine(line);
            }
          });
          response.on('end', () => {
            if (lineBuffer.length > 0) onLine(lineBuffer);
            succeed();
          });
          response.on('aborted', () => fail(new Error('Upstream response aborted')));
          response.on('error', fail);
        });

        activeRequest = request;
        request.on('error', fail);
        request.write(body);
        request.end();
      };

      doRequest(fullUrl, maxRedirects);
    });
  }
}
