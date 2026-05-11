/**
 * Signature header generator for pre-authentication requests.
 * Uses MD5("cosy" + "&" + secret + "&" + date) scheme.
 */

import crypto from 'crypto';

const APPCODE = 'cosy';
const SECRET = 'd2FyLCB3YXIgbmV2ZXIgY2hhbmdlcw==';
const SEPARATOR = '&';

export { APPCODE };

export function currentDate(): string {
  return new Date().toUTCString();
}

export function sign(date: string): string {
  const input = APPCODE + SEPARATOR + SECRET + SEPARATOR + date;
  return md5Hex(input);
}

function md5Hex(input: string): string {
  return crypto.createHash('md5').update(input).digest('hex');
}
