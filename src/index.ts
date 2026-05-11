/**
 * Qoder2API - TypeScript implementation
 * Bridges Qoder AI to OpenAI-compatible API.
 */

import { OpenAiBridge } from './openAiBridge';

const DEFAULT_PORT = 8963;

async function main(): Promise<void> {
  const pat = process.env.QODER_PAT || process.argv[2];
  const port = parseInt(process.env.QODER_PORT || process.argv[3] || String(DEFAULT_PORT), 10);

  if (!pat) {
    console.error('Usage: qoder2api <PERSONAL_ACCESS_TOKEN> [port]');
    console.error('  or set QODER_PAT environment variable');
    process.exit(1);
  }

  console.log('[qoder2api] initializing...');
  const bridge = await OpenAiBridge.create(pat);
  bridge.start(port);
}

main().catch((error) => {
  console.error('[qoder2api] fatal:', error);
  process.exit(1);
});
