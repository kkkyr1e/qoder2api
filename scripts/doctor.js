const baseUrl = process.env.QODER_BRIDGE_URL || 'http://127.0.0.1:8963';

async function main() {
  const response = await fetch(`${baseUrl}/health`);
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const health = await response.json();
  console.table({
    status: health.status,
    catalogSource: health.catalog_source,
    catalogModels: health.catalog_models,
    sessionGeneration: health.session_generation,
    sessionExpiresAt: health.session_expires_at,
    upstreamActive: health.upstream?.active,
    upstreamPending: health.upstream?.pending,
  });
}

main().catch((error) => {
  console.error(`[doctor] bridge unavailable at ${baseUrl}: ${error.message}`);
  process.exitCode = 1;
});
