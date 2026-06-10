/**
 * Bearer-authenticated HTTP client for Qoder API calls.
 * Handles both regular JSON requests and SSE streaming requests.
 */

import * as qoderEncoding from './qoderEncoding';
import * as bearerBuilder from './bearerBuilder';
import type { SessionContext } from './bearerBuilder';
import { SSE_IDLE_TIMEOUT_MS, SSE_REQUEST_TIMEOUT_MS } from './constants';
import http from 'http';
import https from 'https';

const COSY_VERSION = '0.1.43';

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
    'accept': accept,
    'cosy-clientip': '169.254.198.161',
    'authorization': bearer,
    'accept-encoding': 'identity',
    'cosy-version': COSY_VERSION,
    'cosy-machineid': session.machineId,
    'cosy-machinetoken': session.machineToken,
    'login-version': 'v2',
    'user-agent': 'Go-http-client/2.0',
  };
  if (extraHeaders) {
    Object.assign(headers, extraHeaders);
  }
  return headers;
}

function prepareRequest(
  session: SessionContext,
  fullUrl: string,
  jsonBody: unknown | null,
): { body: string; payloadB64: string; date: string; sig: string; bearer: string } {
  const urlObj = new URL(fullUrl);
  const rawPath = urlObj.pathname;
  const pathSig = rawPath.startsWith('/algo') ? rawPath.substring('/algo'.length) : rawPath;
  const body = jsonBody === null
    ? ''
    : qoderEncoding.encode(Buffer.from(JSON.stringify(jsonBody)));
  const payloadB64 = bearerBuilder.buildPayloadB64(session.info);
  const date = String(Math.floor(Date.now() / 1000));
  const sig = bearerBuilder.signRequest(payloadB64, session.cosyKey, date, body, pathSig);
  const bearer = bearerBuilder.composeBearer(payloadB64, sig);
  return { body, payloadB64, date, sig, bearer };
}

export class BearerApiClient {
  constructor(private readonly session: SessionContext) {}

  async callPost(fullUrl: string, jsonBody: unknown): Promise<unknown> {
    const { body, date, bearer } = prepareRequest(this.session, fullUrl, jsonBody);
    const headers = buildHeaders(this.session, bearer, date, 'application/json');
    const response = await fetch(fullUrl, { method: 'POST', headers, body });
    if (!response.ok) {
      const errorBody = await response.text();
      throw new Error(`HTTP ${response.status} body=${errorBody}`);
    }
    return response.json();
  }

  async callGet(fullUrl: string): Promise<unknown> {
    const { date, bearer } = prepareRequest(this.session, fullUrl, null);
    const headers = buildHeaders(this.session, bearer, date, 'application/json');
    const response = await fetch(fullUrl, { method: 'GET', headers });
    if (!response.ok) {
      const errorBody = await response.text();
      throw new Error(`HTTP ${response.status} body=${errorBody}`);
    }
    return response.json();
  }

  /**
   * Opens an SSE stream using Node.js native https module.
   * Uses a low-level approach with chunked reading and idle timeout.
   *
   * Follows 301/302/307/308 redirects up to MAX_REDIRECTS times. Because the
   * bearer signature is bound to the request path, every redirect hop must be
   * freshly re-signed against the new URL.
   */
  openStreamLines(
    fullUrl: string,
    jsonBody: unknown,
    extraHeaders: Record<string, string> | undefined,
    onLine: (line: string) => void,
  ): Promise<void> {
    const MAX_REDIRECTS = 5;
    const session = this.session;

    return new Promise((resolve, reject) => {
      const doRequest = (targetUrl: string, redirectsLeft: number): void => {
        const { body, date, bearer } = prepareRequest(session, targetUrl, jsonBody);
        const headers = buildHeaders(session, bearer, date, 'text/event-stream', extraHeaders);
        headers['cache-control'] = 'no-cache';

        const urlObj = new URL(targetUrl);
        const isHttps = urlObj.protocol === 'https:';
        const transport = isHttps ? https : http;

        const requestOptions = {
          hostname: urlObj.hostname,
          port: urlObj.port || (isHttps ? 443 : 80),
          path: urlObj.pathname + urlObj.search,
          method: 'POST',
          headers,
          timeout: SSE_REQUEST_TIMEOUT_MS,
        };

        const request = transport.request(requestOptions, (response) => {
          const status = response.statusCode ?? 0;

          // Handle redirects (preserve POST + body, re-sign for new path).
          if (status === 301 || status === 302 || status === 307 || status === 308) {
            const location = response.headers.location;
            // Drain to free the socket.
            response.resume();
            if (!location) {
              reject(new Error(`HTTP ${status} redirect without Location header`));
              return;
            }
            if (redirectsLeft <= 0) {
              reject(new Error(`Too many redirects (last: ${status} -> ${location})`));
              return;
            }
            let nextUrl: string;
            try {
              nextUrl = new URL(location, targetUrl).toString();
            } catch (e) {
              reject(new Error(`Invalid redirect Location: ${location}`));
              return;
            }
            console.log(`[stream] following ${status} redirect -> ${nextUrl}`);
            doRequest(nextUrl, redirectsLeft - 1);
            return;
          }

          if (status !== 200) {
            let errorBody = '';
            response.on('data', (chunk: Buffer) => { errorBody += chunk.toString(); });
            response.on('end', () => {
              reject(new Error(`HTTP ${status} body=${errorBody}`));
            });
            return;
          }

          let lineBuf = '';
          let idleTimer: ReturnType<typeof setTimeout> | null = null;

          const resetIdleTimer = () => {
            if (idleTimer) clearTimeout(idleTimer);
            idleTimer = setTimeout(() => {
              console.log('[stream] idle timeout, closing');
              response.destroy();
              resolve();
            }, SSE_IDLE_TIMEOUT_MS);
          };

          resetIdleTimer();

          response.on('data', (chunk: Buffer) => {
            resetIdleTimer();
            lineBuf += chunk.toString('utf-8');

            let newlineIndex: number;
            while ((newlineIndex = lineBuf.indexOf('\n')) !== -1) {
              let line = lineBuf.substring(0, newlineIndex);
              lineBuf = lineBuf.substring(newlineIndex + 1);
              if (line.endsWith('\r')) {
                line = line.substring(0, line.length - 1);
              }
              if (line.length > 0) {
                onLine(line);
              }
            }
          });

          response.on('end', () => {
            if (idleTimer) clearTimeout(idleTimer);
            if (lineBuf.length > 0) {
              onLine(lineBuf);
            }
            console.log('[stream] read complete');
            resolve();
          });

          response.on('error', (error: Error) => {
            if (idleTimer) clearTimeout(idleTimer);
            reject(error);
          });
        });

        request.on('error', reject);
        request.on('timeout', () => {
          request.destroy();
          reject(new Error('Request timeout'));
        });

        request.write(body);
        request.end();
      };

      doRequest(fullUrl, MAX_REDIRECTS);
    });
  }
}
