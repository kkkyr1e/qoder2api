import { describe, expect, it } from 'vitest';
import {
  ModelCatalog,
  normalizeReasoningEffort,
  parseModelCatalogResponse,
  type QoderModelConfig,
} from '../modelCatalog';
import {
  getClaudeGatewayDisplayName,
  getClaudeGatewayModelId,
  resolveContextWindow,
  resolveEffortResolution,
  resolveRequestedEffort,
} from '../openAiBridge';

describe('Qoder model catalog', () => {
  it('parses server thinking effort and context metadata', () => {
    const models = parseModelCatalogResponse({
      chat: [{
        key: 'qmodel_38max',
        display_name: 'Qwen3.8-Max',
        enable: true,
        is_reasoning: true,
        thinking_config: {
          disabled: {},
          enabled: {
            is_default: true,
            efforts: { low: {}, medium: {}, xhigh: { is_default: true } },
          },
        },
        context_config: {
          '200K': { token_count: 200_000, is_default: true },
          '1M': { token_count: 1_000_000 },
        },
        max_input_tokens: 1_000_000,
        source: 'system',
      }],
    });

    expect(models).toHaveLength(1);
    expect(models[0]).toMatchObject({
      key: 'qmodel_38max',
      supportsThinking: true,
      supportsDisabledThinking: true,
      efforts: ['low', 'medium', 'xhigh'],
      defaultEffort: 'xhigh',
      contextWindows: [200_000, 1_000_000],
      defaultContextWindow: 200_000,
    });
  });

  it('resolves bridge prefixes and Claude families', () => {
    const catalog = new ModelCatalog();
    expect(catalog.resolve('qoder-qmodel_38max').key).toBe('qmodel_38max');
    expect(catalog.resolve('claude-qoder-performance').key).toBe('performance');
    expect(catalog.resolve('claude-qoder-ultimate[1m]').key).toBe('ultimate');
    expect(catalog.resolve('claude-opus-5').key).toBe('ultimate');
    expect(catalog.resolve('claude-sonnet-5').key).toBe('performance');
  });
});

describe('reasoning effort passthrough', () => {
  const model: QoderModelConfig = {
    key: 'test-model',
    displayName: 'Test',
    isReasoning: true,
    supportsThinking: true,
    supportsDisabledThinking: true,
    efforts: ['low', 'high', 'max'],
    defaultEffort: 'high',
    contextWindows: [200_000],
    defaultContextWindow: 200_000,
    maxInputTokens: 200_000,
    source: 'system',
    format: 'openai',
  };

  it('normalizes disabled aliases', () => {
    expect(normalizeReasoningEffort('off')).toBe('none');
    expect(normalizeReasoningEffort('xhigh')).toBe('xhigh');
  });

  it('reads Anthropic output_config effort', () => {
    expect(resolveRequestedEffort({ output_config: { effort: 'low' } }, model, 'anthropic')).toBe('low');
  });

  it('maps Anthropic thinking budgets', () => {
    expect(resolveRequestedEffort({ thinking: { type: 'enabled', budget_tokens: 24_000 } }, model, 'anthropic')).toBe('high');
  });

  it('maps unsupported Claude effort to the nearest stronger advertised level', () => {
    expect(resolveEffortResolution({ reasoning_effort: 'medium' }, model, 'openai')).toEqual({
      requested: 'medium', effective: 'high', adjusted: true,
    });
    const qwen: QoderModelConfig = { ...model, efforts: ['low', 'medium', 'xhigh'] };
    expect(resolveEffortResolution({ reasoning_effort: 'max' }, qwen, 'openai')).toMatchObject({
      requested: 'max', effective: 'xhigh', adjusted: true,
    });
  });

  it('maps Claude Code 1M beta to a real Qoder context window', () => {
    const oneMillionModel = { ...model, contextWindows: [200_000, 400_000, 1_000_000], maxInputTokens: 1_000_000 };
    expect(resolveContextWindow({}, oneMillionModel, 'context-1m-2025-08-07')).toBe(1_000_000);
    expect(getClaudeGatewayModelId(oneMillionModel)).toBe('claude-qoder-test-model[1m]');
    expect(getClaudeGatewayDisplayName(oneMillionModel)).toContain('1M');
  });
});
