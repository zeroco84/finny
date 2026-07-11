import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { config } from '../src/config.js';
import { closeDb, openDb } from '../src/db/db.js';
import {
  anthropicKeyInfo,
  extractionProviderActive,
  getAnthropicKey,
  getExtractionModel,
  getSettings,
  seedDefaults,
  setAnthropicKey,
  updateSettings,
} from '../src/services/settings.js';

const saved = {
  key: config.anthropicKey,
  model: config.extractionModel,
  provEnv: config.extractionProviderEnv,
};

beforeEach(() => {
  closeDb();
  openDb(':memory:');
  seedDefaults();
  config.anthropicKey = '';
  config.extractionModel = 'claude-opus-4-8';
  config.extractionProviderEnv = '';
});

afterEach(() => {
  config.anthropicKey = saved.key;
  config.extractionModel = saved.model;
  config.extractionProviderEnv = saved.provEnv;
});

describe('AI key + model settings', () => {
  it('never leaks the stored API key through getSettings', () => {
    setAnthropicKey('sk-ant-secret');
    expect((getSettings() as unknown as Record<string, unknown>).anthropic_api_key).toBeUndefined();
    expect(getAnthropicKey()).toBe('sk-ant-secret'); // internal access still works
  });

  it('the stored key wins over env; clearing falls back to env', () => {
    config.anthropicKey = 'env-key';
    expect(getAnthropicKey()).toBe('env-key');
    expect(anthropicKeyInfo()).toEqual({ set: true, source: 'env' });

    setAnthropicKey('settings-key');
    expect(getAnthropicKey()).toBe('settings-key');
    expect(anthropicKeyInfo()).toEqual({ set: true, source: 'settings' });

    setAnthropicKey(''); // clear -> back to env
    expect(getAnthropicKey()).toBe('env-key');
    expect(anthropicKeyInfo()).toEqual({ set: true, source: 'env' });
  });

  it('reports "none" when no key is set anywhere', () => {
    expect(anthropicKeyInfo()).toEqual({ set: false, source: 'none' });
    expect(getAnthropicKey()).toBe('');
  });

  it('extraction model: the Settings choice wins over the env default', () => {
    expect(getExtractionModel()).toBe('claude-opus-4-8');
    updateSettings({ extraction_model: 'claude-haiku-4-5-20251001' });
    expect(getExtractionModel()).toBe('claude-haiku-4-5-20251001');
  });

  it('provider is anthropic only when a key exists, unless env forces mock', () => {
    expect(extractionProviderActive()).toBe('mock'); // no key anywhere
    setAnthropicKey('k');
    expect(extractionProviderActive()).toBe('anthropic');
    config.extractionProviderEnv = 'mock'; // explicit override
    expect(extractionProviderActive()).toBe('mock');
  });
});
