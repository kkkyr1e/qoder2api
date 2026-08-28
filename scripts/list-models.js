const baseUrl = process.env.QODER_BRIDGE_URL || 'http://127.0.0.1:8963';
const apiKey = process.env.QODER_BRIDGE_API_KEY || 'local-bridge-key';

async function main() {
  const response = await fetch(`${baseUrl}/v1/models`, {
    headers: { 'x-api-key': apiKey },
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}: ${await response.text()}`);
  const payload = await response.json();
  console.log(`catalog source: ${payload.source}; models: ${payload.data.length}`);
  console.table(payload.data.map((model) => ({
    id: model.id,
    name: model.display_name,
    efforts: model.reasoning_efforts.join(', ') || 'server default',
    context: model.context_windows.join(', '),
    defaultContext: model.default_context_window,
    qoderDefault: model.qoder_default_context_window,
  })));
}

main().catch((error) => {
  console.error(`[models] ${error.message}`);
  process.exitCode = 1;
});
