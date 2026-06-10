/**
 * Authentication session builder & request signer.
 * Handles RSA/AES encryption for session creation and MD5 signing for each request.
 */

import crypto from 'crypto';
import { COSY_VERSION } from './constants';

const SERVER_PUBKEY_PEM =
  '-----BEGIN PUBLIC KEY-----\n' +
  'MIGfMA0GCSqGSIb3DQEBAQUAA4GNADCBiQKBgQDA8iMH5c02LilrsERw9t6Pv5Nc\n' +
  '4k6Pz1EaDicBMpdpxKduSZu5OANqUq8er4GM95omAGIOPOh+Nx0spthYA2BqGz+l\n' +
  '6HRkPJ7S236FZz73In/KVuLnwI8JJ2CbuJap8kvheCCZpmAWpb/cPx/3Vr/J6I17\n' +
  'XcW+ML9FoCI6AOvOzwIDAQAB\n' +
  '-----END PUBLIC KEY-----';

export interface AuthIdentity {
  name: string;
  aid: string;
  uid: string;
  yxUid: string;
  organizationId: string;
  organizationName: string;
  userType: string;
  securityOauthToken: string;
  refreshToken: string;
}

export interface SessionContext {
  tempKey: Buffer;
  cosyKey: string;
  info: string;
  identity: AuthIdentity;
  machineId: string;
  machineToken: string;
  machineType: string;
}

export function newSession(
  identity: AuthIdentity,
  machineId: string,
  machineToken: string,
  machineType: string,
): SessionContext {
  const tempKey = Buffer.from(
    crypto.randomUUID().replace(/-/g, '').substring(0, 16),
    'ascii',
  );
  const cosyKey = rsaEncrypt(tempKey).toString('base64');
  const authPayload = buildAuthPayloadJson(identity);
  const info = aesEncrypt(authPayload, tempKey).toString('base64');
  return { tempKey, cosyKey, info, identity, machineId, machineToken, machineType };
}

export function signRequest(
  payloadB64: string,
  cosyKey: string,
  cosyDate: string,
  body: string,
  pathWithoutAlgo: string,
): string {
  const input = payloadB64 + '\n' + cosyKey + '\n' + cosyDate + '\n' + body + '\n' + pathWithoutAlgo;
  return md5Hex(input);
}

export function buildPayloadB64(info: string): string {
  const payload: Record<string, string> = {
    cosyVersion: COSY_VERSION,
    ideVersion: '',
    info,
    requestId: crypto.randomUUID(),
    version: 'v1',
  };
  const sorted = Object.fromEntries(
    Object.entries(payload).sort(([keyA], [keyB]) => keyA.localeCompare(keyB)),
  );
  return Buffer.from(JSON.stringify(sorted)).toString('base64');
}

export function composeBearer(payloadB64: string, signature: string): string {
  return 'Bearer COSY.' + payloadB64 + '.' + signature;
}

function buildAuthPayloadJson(identity: AuthIdentity): Buffer {
  const payload = {
    name: identity.name,
    aid: identity.aid,
    uid: identity.uid,
    yx_uid: identity.yxUid,
    organization_id: identity.organizationId,
    organization_name: identity.organizationName,
    user_type: identity.userType,
    security_oauth_token: identity.securityOauthToken,
    refresh_token: identity.refreshToken,
  };
  return Buffer.from(JSON.stringify(payload));
}

function rsaEncrypt(data: Buffer): Buffer {
  return crypto.publicEncrypt(
    { key: SERVER_PUBKEY_PEM, padding: crypto.constants.RSA_PKCS1_PADDING },
    data,
  );
}

function aesEncrypt(plaintext: Buffer, key: Buffer): Buffer {
  const cipher = crypto.createCipheriv('aes-128-cbc', key, key);
  return Buffer.concat([cipher.update(plaintext), cipher.final()]);
}

function md5Hex(input: string): string {
  return crypto.createHash('md5').update(input, 'utf8').digest('hex');
}
