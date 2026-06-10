/**
 * Signature-authenticated HTTP client for pre-session API calls.
 * Used for initial token exchange, user status queries, and heartbeat.
 */

import * as signature from './signature';
import * as qoderEncoding from './qoderEncoding';
import { COSY_VERSION } from './constants';

export interface JobTokenResponse {
  name: string;
  id: string;
  userType: string;
  securityOauthToken: string;
  refreshToken: string;
  [key: string]: unknown;
}

export class SignatureApiClient {
  constructor(
    private readonly machineId: string,
    private readonly machineToken: string,
    private readonly machineType: string,
  ) {}

  async exchangeJobToken(personalToken: string): Promise<JobTokenResponse> {
    const inner = {
      personalToken,
      securityOauthToken: '',
      refreshToken: '',
      needRefresh: false,
      authInfo: {},
    };
    const outer = {
      payload: JSON.stringify(inner),
      encodeVersion: '1',
    };
    return this.postEncoded(
      'https://center.qoder.sh/algo/api/v3/user/jobToken?Encode=1',
      outer,
    );
  }

  async userStatus(userId: string): Promise<unknown> {
    const inner = {
      userId,
      personalToken: '',
      securityOauthToken: '',
      refreshToken: '',
      needRefresh: false,
      authInfo: {},
    };
    const outer = {
      payload: JSON.stringify(inner),
      encodeVersion: '1',
    };
    return this.postEncoded(
      'https://center.qoder.sh/algo/api/v3/user/status?Encode=1',
      outer,
    );
  }

  async heartbeat(): Promise<unknown> {
    const heartbeatData = {
      event_time: Date.now(),
      event_type: 'cosy_heartbeat',
      mid: this.machineId,
      os_arch: process.arch === 'x64' ? 'windows_amd64' : process.arch,
      os_version: `${process.platform} ${process.version}`,
      ide_type: 'qodercli',
      ide_version: COSY_VERSION,
      extra_info: {},
    };
    return this.postEncoded(
      'https://center.qoder.sh/algo/api/v1/heartbeat?Encode=1',
      heartbeatData,
    );
  }

  private async postEncoded(url: string, payload: unknown): Promise<any> {
    const date = signature.currentDate();
    const sig = signature.sign(date);
    const plainBytes = Buffer.from(JSON.stringify(payload));
    const body = qoderEncoding.encode(plainBytes);

    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'cosy-machinetoken': this.machineToken,
        'cosy-machinetype': this.machineType,
        'login-version': 'v2',
        'appcode': signature.APPCODE,
        'accept': 'application/json',
        'accept-encoding': 'identity',
        'cosy-version': COSY_VERSION,
        'cosy-clienttype': '5',
        'date': date,
        'signature': sig,
        'content-type': 'application/json',
        'cosy-machineid': this.machineId,
        'user-agent': 'Go-http-client/2.0',
      },
      body,
    });

    if (!response.ok) {
      const errorBody = await response.text();
      throw new Error(`HTTP ${response.status} at ${url} body=${errorBody}`);
    }
    return response.json();
  }
}
