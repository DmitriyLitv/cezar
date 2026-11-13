import { describe, expect, it, vi } from 'vitest';
import {
  emitExecutorFailure,
  normalizeExecutorFailure,
  normalizeProviderAvailabilityFailure,
  type ExecutorFailureKind,
} from './executor-failure.ts';

const NOW = Date.parse('2026-11-13T12:00:00.000Z');

describe('normalizeExecutorFailure', () => {
  it.each([
    ['Claude AI usage limit reached|1794574800', 'quota_exhausted'],
    ['HTTP 429 rate_limit_error: too many requests', 'rate_limited'],
    ['API Error: 529 Overloaded', 'provider_temporarily_unavailable'],
    ['Failed to authenticate: OAuth token expired', 'authentication_failure'],
    ['Credit balance is too low', 'billing_failure'],
    ['codex executable ENOENT: not installed', 'configuration_failure'],
    ['executor busy: all execution slots are occupied', 'executor_busy'],
    ['Your input exceeds the context window', 'context_limit_exceeded'],
    ['execution interrupted by shutdown signal', 'interrupted'],
    ['agent exited with code 17', 'unknown_failure'],
  ] as const)('%s -> %s', (message, kind: ExecutorFailureKind) => {
    expect(normalizeExecutorFailure({ provider: 'codex', message, now: NOW }).kind).toBe(kind);
  });

  it('never treats an ambiguous HTTP 429 as proven quota exhaustion', () => {
    const failure = normalizeExecutorFailure({
      provider: 'codex',
      accountId: 'work',
      message: 'HTTP 429: request rejected',
      now: NOW,
    });
    expect(failure).toMatchObject({
      version: 1,
      executor: { provider: 'codex', accountId: 'work' },
      kind: 'rate_limited',
      retryable: true,
    });
    expect(failure.retryAt).toBeUndefined();
    expect(failure.evidence).toEqual([
      { source: 'message-pattern', detail: 'rate-limit-without-exhaustion-evidence' },
    ]);
  });

  it('carries only a bounded, trusted reset parsed by the existing quota parser', () => {
    const failure = normalizeExecutorFailure({
      provider: 'claude',
      message: 'usage limit reached; try again at 2026-11-13T13:00:00Z',
      now: NOW,
    });
    expect(failure).toMatchObject({
      kind: 'quota_exhausted',
      retryAt: '2026-11-13T13:00:00.000Z',
      retryAtTrusted: true,
      retryable: true,
    });
  });

  it('prefers a structured runner signal while retaining the legacy classification', () => {
    const failure = normalizeExecutorFailure({
      provider: 'kimi',
      message: 'gateway refused the request',
      structured: {
        kind: 'provider_temporarily_unavailable',
        confidence: 'high',
        evidence: 'acp:error:-32001',
        retryAt: '2026-11-13T12:01:00Z',
        retryAtTrusted: true,
      },
      now: NOW,
    });
    expect(failure).toMatchObject({
      kind: 'provider_temporarily_unavailable',
      legacyClassification: 'other',
      retryAt: '2026-11-13T12:01:00.000Z',
      retryAtTrusted: true,
    });
  });

  it('redacts credentials from the optional diagnostic', () => {
    const failure = normalizeExecutorFailure({
      message: 'request failed with sk-abcdefghijklmnopqrstuvwxyz012345',
      now: NOW,
    });
    expect(failure.diagnostic).toBe('request failed with [REDACTED]');
  });
});

describe('provider availability adapter', () => {
  it('keeps the existing provider-auth states distinct', () => {
    expect(normalizeProviderAvailabilityFailure({ provider: 'claude', status: 'connected' })).toBeNull();
    expect(normalizeProviderAvailabilityFailure({ provider: 'claude', status: 'disconnected' })?.kind)
      .toBe('authentication_failure');
    expect(normalizeProviderAvailabilityFailure({ provider: 'codex', status: 'not-installed' })?.kind)
      .toBe('configuration_failure');
    expect(normalizeProviderAvailabilityFailure({ provider: 'kimi', status: 'unknown' })?.kind)
      .toBe('provider_temporarily_unavailable');
  });
});

describe('emitExecutorFailure', () => {
  it('is additive and cannot let an observer failure change runner behavior', () => {
    const observer = vi.fn(() => { throw new Error('observer failed'); });
    expect(() => emitExecutorFailure(observer, { provider: 'codex', message: 'HTTP 429' })).not.toThrow();
    expect(observer).toHaveBeenCalledOnce();
  });
});
