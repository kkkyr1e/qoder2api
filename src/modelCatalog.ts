import type { BearerApiClient } from './bearerApiClient';

export type ReasoningEffort = 'none' | 'low' | 'medium' | 'high' | 'xhigh' | 'max';

export interface QoderModelConfig {
  key: string;
  displayName: string;
  isReasoning: boolean;
  supportsThinking: boolean;
  supportsDisabledThinking: boolean;
  efforts: ReasoningEffort[];
  defaultEffort?: ReasoningEffort;
  contextWindows: number[];
  defaultContextWindow?: number;
  maxInputTokens: number;
  maxOutputTokens?: number;
  source: string;
  format: string;
}

export type ModelCatalogSource = 'remote' | 'fallback';

export const MODEL_LIST_ENDPOINT =
  'https://center.qoder.sh/algo/api/v2/model/list?Encode=1';

const EFFORT_ORDER: ReasoningEffort[] = ['none', 'low', 'medium', 'high', 'xhigh', 'max'];
const VALID_EFFORTS = new Set<string>(EFFORT_ORDER);

/**
 * The fallback is deliberately conservative. The authenticated Qoder model
 * catalog is the source of truth and replaces this list as soon as it loads.
 */
const FALLBACK_MODELS: QoderModelConfig[] = [
  fallback('auto', 'Auto', false, [], 180_000),
  fallback('ultimate', 'Ultimate', true, ['low', 'medium', 'high', 'xhigh', 'max'], 1_000_000, 'high'),
  fallback('performance', 'Performance', false, ['low', 'medium', 'high', 'xhigh', 'max'], 1_000_000, 'medium'),
  fallback('efficient', 'Efficient', false, [], 180_000),
  fallback('lite', 'Lite', false, [], 180_000),
  fallback('qmodel_38max', 'Qwen3.8-Max', true, ['low', 'medium', 'xhigh'], 180_000, 'xhigh'),
  fallback('qfmodel', 'Qwen3.8-Flash', true, ['low', 'medium', 'xhigh'], 180_000, 'xhigh'),
  fallback('qmodel_latest', 'Qwen3.7-Max', false, [], 1_000_000),
  fallback('qmodel', 'Qwen3.7-Plus', false, [], 1_000_000),
  fallback('kmodel_latest', 'Kimi-K3', false, ['low', 'high', 'max'], 180_000, 'max', false),
  fallback('kmodel', 'Kimi-K2.7-Code', false, [], 256_000),
  fallback('gmodel', 'GLM-5.3', true, ['low', 'high', 'max'], 180_000, 'max', false),
  fallback('gfmodel', 'GLM-5.3-Flash', true, ['high', 'max'], 1_000_000, 'max', false),
  fallback('dmodel', 'DeepSeek-V4-Pro', true, ['high', 'max'], 1_000_000, 'max'),
  fallback('dfmodel', 'DeepSeek-V4-Flash', true, ['low', 'high', 'max'], 1_000_000, 'max'),
  fallback('mmodel', 'MiniMax-M3', false, [], 1_000_000),
];

function fallback(
  key: string,
  displayName: string,
  isReasoning: boolean,
  efforts: ReasoningEffort[],
  maxInputTokens: number,
  defaultEffort?: ReasoningEffort,
  supportsDisabledThinking = true,
): QoderModelConfig {
  return {
    key,
    displayName,
    isReasoning,
    supportsThinking: efforts.length > 0,
    supportsDisabledThinking: efforts.length > 0 && supportsDisabledThinking,
    efforts,
    defaultEffort,
    contextWindows: [maxInputTokens],
    defaultContextWindow: maxInputTokens,
    maxInputTokens,
    source: 'system',
    format: 'openai',
  };
}

export function normalizeReasoningEffort(value: unknown): ReasoningEffort | undefined {
  if (typeof value !== 'string') return undefined;
  const normalized = value.trim().toLowerCase();
  if (['disabled', 'disable', 'off'].includes(normalized)) return 'none';
  return VALID_EFFORTS.has(normalized) ? normalized as ReasoningEffort : undefined;
}

function parsePositiveInteger(value: unknown): number | undefined {
  const parsed = typeof value === 'number' ? value : Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : undefined;
}

function parseModel(raw: any): QoderModelConfig | null {
  const key = String(raw?.key ?? raw?.model_key ?? '').trim();
  if (!key || raw?.enable === false || raw?.enable === 0) return null;

  const enabledThinking = raw?.thinking_config?.enabled ?? raw?.thinkingConfig?.enabled;
  const disabledThinking = raw?.thinking_config?.disabled ?? raw?.thinkingConfig?.disabled;
  const effortObject = enabledThinking?.efforts ?? enabledThinking?.reasoning_efforts;
  const efforts = effortObject && typeof effortObject === 'object'
    ? EFFORT_ORDER.filter((effort) => effort !== 'none' && Object.hasOwn(effortObject, effort))
    : [];
  let defaultEffort = efforts.find((effort) => effortObject?.[effort]?.is_default === true);
  defaultEffort ??= normalizeReasoningEffort(raw?.default_effort ?? raw?.defaultEffort);

  const contextConfig = raw?.context_config ?? raw?.contextConfig;
  const contextEntries = contextConfig && typeof contextConfig === 'object'
    ? Object.values(contextConfig) as any[]
    : [];
  const contextWindows = contextEntries
    .map((entry) => parsePositiveInteger(entry?.token_count ?? entry?.tokenCount))
    .filter((value): value is number => value !== undefined)
    .sort((a, b) => a - b);
  const defaultContextWindow = contextEntries
    .map((entry) => entry?.is_default === true
      ? parsePositiveInteger(entry?.token_count ?? entry?.tokenCount)
      : undefined)
    .find((value): value is number => value !== undefined);
  const maxInputTokens = parsePositiveInteger(raw?.max_input_tokens ?? raw?.maxInputTokens)
    ?? contextWindows.at(-1)
    ?? 200_000;

  return {
    key,
    displayName: String(raw?.display_name ?? raw?.displayName ?? raw?.name ?? key),
    isReasoning: raw?.is_reasoning === true || raw?.isReasoning === true,
    supportsThinking: Boolean(enabledThinking),
    supportsDisabledThinking: Boolean(disabledThinking),
    efforts,
    defaultEffort,
    contextWindows,
    defaultContextWindow: defaultContextWindow ?? contextWindows[0] ?? maxInputTokens,
    maxInputTokens,
    maxOutputTokens: parsePositiveInteger(raw?.max_output_tokens ?? raw?.maxOutputTokens),
    source: String(raw?.source ?? 'system'),
    format: String(raw?.format ?? 'openai'),
  };
}

export function parseModelCatalogResponse(payload: unknown, scene = 'chat'): QoderModelConfig[] {
  if (!payload || typeof payload !== 'object') return [];
  const entries = (payload as Record<string, unknown>)[scene];
  if (!Array.isArray(entries)) return [];
  return entries.map(parseModel).filter((model): model is QoderModelConfig => model !== null);
}

const DISPLAY_NAME_ALIASES: Record<string, string> = {
  'qwen3.8-max': 'qmodel_38max',
  'qwen3.8-flash': 'qfmodel',
  'qwen3.7-max': 'qmodel_latest',
  'qwen3.7-plus': 'qmodel',
  'qwen3.6-plus': 'qmodel',
  'kimi-k3': 'kmodel_latest',
  'kimi-k2.7-code': 'kmodel',
  'glm-5.3': 'gmodel',
  'glm-5.3-flash': 'gfmodel',
  'deepseek-v4-pro': 'dmodel',
  'deepseek-v4-flash': 'dfmodel',
  'minimax-m3': 'mmodel',
  'max': 'performance',
  'plus': 'efficient',
};

export class ModelCatalog {
  private models = new Map(FALLBACK_MODELS.map((model) => [model.key, { ...model }]));
  private refreshPromise: Promise<boolean> | null = null;
  private _source: ModelCatalogSource = 'fallback';
  private _lastRefreshAt: number | null = null;

  get source(): ModelCatalogSource { return this._source; }
  get lastRefreshAt(): number | null { return this._lastRefreshAt; }

  list(): QoderModelConfig[] {
    return Array.from(this.models.values()).map((model) => ({ ...model }));
  }

  get(key: string): QoderModelConfig | undefined {
    return this.models.get(key);
  }

  getDefault(): QoderModelConfig {
    return this.list().find((model) => model.key === 'auto')
      ?? this.list()[0]
      ?? FALLBACK_MODELS[0];
  }

  resolve(requestedModel: string): QoderModelConfig {
    let requested = requestedModel.trim().toLowerCase().replace(/\[1m\]$/, '');
    for (const prefix of ['claude-qoder-', 'qoder-', 'claude-']) {
      if (requested.startsWith(prefix)) {
        const candidate = requested.substring(prefix.length);
        if (this.findCaseInsensitive(candidate)) return this.findCaseInsensitive(candidate)!;
      }
    }

    const exact = this.findCaseInsensitive(requested);
    if (exact) return exact;

    const alias = DISPLAY_NAME_ALIASES[requested];
    if (alias && this.models.has(alias)) return this.models.get(alias)!;
    const byDisplayName = this.list().find((model) => model.displayName.toLowerCase() === requested);
    if (byDisplayName) return byDisplayName;

    if (requested.includes('opus')) return this.models.get('ultimate') ?? this.getDefault();
    if (requested.includes('sonnet')) return this.models.get('performance') ?? this.getDefault();
    if (requested.includes('haiku')) {
      return this.models.get('efficient') ?? this.models.get('lite') ?? this.getDefault();
    }
    return this.getDefault();
  }

  async refresh(client: BearerApiClient): Promise<boolean> {
    if (this.refreshPromise) return this.refreshPromise;
    this.refreshPromise = (async () => {
      const response = await client.callGet(MODEL_LIST_ENDPOINT);
      const parsed = parseModelCatalogResponse(response);
      if (parsed.length === 0) throw new Error('Qoder returned an empty chat model catalog');
      this.models = new Map(parsed.map((model) => [model.key, model]));
      this._source = 'remote';
      this._lastRefreshAt = Date.now();
      return true;
    })().finally(() => { this.refreshPromise = null; });
    return this.refreshPromise;
  }

  private findCaseInsensitive(key: string): QoderModelConfig | undefined {
    for (const [candidate, model] of this.models) {
      if (candidate.toLowerCase() === key.toLowerCase()) return model;
    }
    return undefined;
  }
}

export function getFallbackModelCatalog(): QoderModelConfig[] {
  return FALLBACK_MODELS.map((model) => ({ ...model }));
}
