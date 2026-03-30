import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// config.ts reads process.env at module load time, so each test must:
// 1. Stub the env var before import
// 2. Use vi.resetModules() to force re-evaluation of the module-level const
// 3. Dynamically import the module to pick up the new env value

describe('MAX_CONCURRENT_CONTAINERS', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  it('defaults to 5 when env var is not set', async () => {
    vi.stubEnv('MAX_CONCURRENT_CONTAINERS', '');
    const { MAX_CONCURRENT_CONTAINERS } = await import('./config.js');
    expect(MAX_CONCURRENT_CONTAINERS).toBe(5);
  });

  it('reads the value from process.env when set', async () => {
    vi.stubEnv('MAX_CONCURRENT_CONTAINERS', '3');
    const { MAX_CONCURRENT_CONTAINERS } = await import('./config.js');
    expect(MAX_CONCURRENT_CONTAINERS).toBe(3);
  });

  it('floors at 1 when env var is "0"', async () => {
    vi.stubEnv('MAX_CONCURRENT_CONTAINERS', '0');
    const { MAX_CONCURRENT_CONTAINERS } = await import('./config.js');
    expect(MAX_CONCURRENT_CONTAINERS).toBe(1);
  });

  it('floors at 1 when env var is a negative number', async () => {
    vi.stubEnv('MAX_CONCURRENT_CONTAINERS', '-5');
    const { MAX_CONCURRENT_CONTAINERS } = await import('./config.js');
    expect(MAX_CONCURRENT_CONTAINERS).toBe(1);
  });
});
