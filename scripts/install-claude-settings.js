const fs = require('fs');
const path = require('path');

const preset = process.argv[2] === 'ultimate' ? 'ultimate' : 'standard';
const projectRoot = path.resolve(__dirname, '..');
const templatePath = path.join(
  projectRoot,
  preset === 'ultimate'
    ? 'claude-settings.ultimate-max-1m.json'
    : 'claude-settings.example.json',
);
const claudeDir = path.join(process.env.USERPROFILE || process.env.HOME, '.claude');
const settingsPath = path.join(claudeDir, 'settings.json');

function main() {
  const template = JSON.parse(fs.readFileSync(templatePath, 'utf8'));
  let existing = {};
  if (fs.existsSync(settingsPath)) {
    existing = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const backupPath = `${settingsPath}.qoder-backup-${timestamp}`;
    fs.copyFileSync(settingsPath, backupPath);
    console.log(`[claude-settings] backup: ${backupPath}`);
  }

  const existingEnv = { ...(existing.env || {}) };
  for (const key of [
    'ANTHROPIC_MODEL',
    'ANTHROPIC_AUTH_TOKEN',
    'ANTHROPIC_CUSTOM_MODEL_OPTION',
    'ANTHROPIC_CUSTOM_MODEL_OPTION_NAME',
    'ANTHROPIC_CUSTOM_MODEL_OPTION_DESCRIPTION',
    'ANTHROPIC_CUSTOM_MODEL_OPTION_SUPPORTED_CAPABILITIES',
  ]) delete existingEnv[key];

  const { availableModels: previousAvailableModels, ...existingWithoutModelAllowlist } = existing;
  const merged = {
    ...existingWithoutModelAllowlist,
    $schema: existing.$schema || template.$schema,
    model: template.model,
    env: { ...existingEnv, ...template.env },
  };
  fs.mkdirSync(claudeDir, { recursive: true });
  fs.writeFileSync(settingsPath, `${JSON.stringify(merged, null, 2)}\n`, 'utf8');

  console.log(`[claude-settings] installed preset=${preset}: ${settingsPath}`);
  console.log('[claude-settings] restart Claude Code; use /model and /effort in the new session');
  if (Array.isArray(previousAvailableModels)) {
    console.log(`[claude-settings] removed restrictive availableModels (${previousAvailableModels.length} entries)`);
  }
}

try { main(); }
catch (error) {
  console.error(`[claude-settings] ${error.message}`);
  process.exitCode = 1;
}
