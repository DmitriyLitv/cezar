import { classifyAgentFailure, type AgentFailureClass } from './agent-failure-class.ts';
import { collectSecretValues, redactSecrets } from './secret-redaction.ts';
import { isUsageExhaustion, parseUsageLimit } from './usage-limit.ts';

/** Stable failure vocabulary consumed by future executor admission and failover policy. */
export type ExecutorFailureKind =
  | 'quota_exhausted'
  | 'rate_limited'
  | 'provider_temporarily_unavailable'
  | 'authentication_failure'
  | 'billing_failure'
  | 'configuration_failure'
  | 'executor_busy'
  | 'context_limit_exceeded'
  | 'interrupted'
  | 'unknown_failure';

export type ExecutorFailureConfidence = 'high' | 'medium' | 'low';

export interface ExecutorIdentity {
  provider?: string;
  /** Cezar's opaque account/profile id, never a credential or vendor token. */
  accountId?: string;
}

export interface ExecutorFailureEvidence {
  source: 'structured' | 'usage-limit-parser' | 'failure-classifier' | 'provider-auth' | 'message-pattern';
  /** A bounded, non-secret discriminator rather than the provider's raw payload. */
  detail: string;
}

/**
 * Additive normalized outcome for executor health and future scheduling decisions.
 * Existing AgentEvent errors and RunManager decisions remain authoritative in Phase 0.
 */
export interface ExecutorFailure {
  version: 1;
  executor?: ExecutorIdentity;
  kind: ExecutorFailureKind;
  /** Existing classifier result retained so current behavior can be audited during extraction. */
  legacyClassification?: AgentFailureClass;
  confidence: ExecutorFailureConfidence;
  evidence: ExecutorFailureEvidence[];
  /** A bounded parser- or provider-supplied instant. Never inferred from an ambiguous status code. */
  retryAt?: string;
  retryAtTrusted?: true;
  /** Whether policy may consider a later attempt; it is not an instruction to retry now. */
  retryable: boolean;
  /** Redacted provider diagnostic, bounded for persistence and UI use. */
  diagnostic?: string;
}

export interface StructuredExecutorFailureSignal {
  kind: ExecutorFailureKind;
  confidence?: ExecutorFailureConfidence;
  evidence?: string;
  retryAt?: Date | string | number;
  /** Only a source that owns the timestamp may mark it trusted. */
  retryAtTrusted?: boolean;
  retryable?: boolean;
}

export interface NormalizeExecutorFailureInput {
  provider?: string;
  accountId?: string;
  message?: string;
  structured?: StructuredExecutorFailureSignal;
  now?: number;
}

const RATE_LIMIT_RE = /\b(?:429|rate[\s_-]?limit(?:ed|_error)?|too many requests|requests? per minute|tokens? per minute)\b/i;
const INTERRUPTED_RE = /\b(?:interrupted|cancelled|canceled|terminated by signal|shutdown signal)\b/i;
const BUSY_RE = /\b(?:executor busy|concurrency (?:limit|capacity)|all (?:execution )?slots (?:are )?(?:busy|occupied))\b/i;
const CONFIGURATION_RE = /\b(?:ENOENT|not installed|unsupported model|model .* not found|invalid (?:model|configuration)|reasoning effort is only supported)\b/i;

const DEFAULT_RETRYABLE: Readonly<Record<ExecutorFailureKind, boolean>> = {
  quota_exhausted: true,
  rate_limited: true,
  provider_temporarily_unavailable: true,
  authentication_failure: false,
  billing_failure: false,
  configuration_failure: false,
  executor_busy: true,
  context_limit_exceeded: false,
  interrupted: true,
  unknown_failure: false,
};

/** Normalize runner/provider evidence without changing the legacy failure decision. */
export function normalizeExecutorFailure(input: NormalizeExecutorFailureInput): ExecutorFailure {
  const message = input.message?.trim();
  const now = input.now ?? Date.now();
  const legacyClassification = classifyAgentFailure(message);
  const parsedLimit = parseUsageLimit(message, now);
  const structured = input.structured;

  let kind: ExecutorFailureKind;
  let confidence: ExecutorFailureConfidence;
  let evidence: ExecutorFailureEvidence;

  if (structured) {
    kind = structured.kind;
    confidence = structured.confidence ?? 'high';
    evidence = { source: 'structured', detail: boundedDetail(structured.evidence ?? structured.kind) };
  } else if (isUsageExhaustion(message)) {
    kind = 'quota_exhausted';
    confidence = /claude(?:\s+ai)?\s+usage\s+limit\s+reached|insufficient[_\s]quota/i.test(message ?? '') ? 'high' : 'medium';
    evidence = { source: 'usage-limit-parser', detail: parsedLimit?.evidence ?? 'exhaustion-phrase' };
  } else if (RATE_LIMIT_RE.test(message ?? '')) {
    // HTTP 429 covers both throttling and spent quota. Without exhaustion evidence it is only a throttle.
    kind = 'rate_limited';
    confidence = parsedLimit ? 'high' : 'medium';
    evidence = { source: 'message-pattern', detail: 'rate-limit-without-exhaustion-evidence' };
  } else if (legacyClassification === 'transient') {
    kind = 'provider_temporarily_unavailable';
    confidence = 'high';
    evidence = { source: 'failure-classifier', detail: legacyClassification };
  } else if (legacyClassification === 'auth') {
    kind = 'authentication_failure';
    confidence = 'high';
    evidence = { source: 'failure-classifier', detail: legacyClassification };
  } else if (legacyClassification === 'billing') {
    kind = 'billing_failure';
    confidence = 'high';
    evidence = { source: 'failure-classifier', detail: legacyClassification };
  } else if (legacyClassification === 'context_too_large') {
    kind = 'context_limit_exceeded';
    confidence = 'high';
    evidence = { source: 'failure-classifier', detail: legacyClassification };
  } else if (BUSY_RE.test(message ?? '')) {
    kind = 'executor_busy';
    confidence = 'high';
    evidence = { source: 'message-pattern', detail: 'local-concurrency-saturated' };
  } else if (CONFIGURATION_RE.test(message ?? '') || legacyClassification === 'disk_full') {
    kind = 'configuration_failure';
    confidence = 'high';
    evidence = { source: 'message-pattern', detail: legacyClassification === 'disk_full' ? 'disk-full' : 'configuration' };
  } else if (INTERRUPTED_RE.test(message ?? '')) {
    kind = 'interrupted';
    confidence = 'medium';
    evidence = { source: 'message-pattern', detail: 'interruption' };
  } else {
    kind = 'unknown_failure';
    confidence = 'low';
    evidence = { source: 'failure-classifier', detail: legacyClassification };
  }

  const trustedRetryAt = structured?.retryAtTrusted
    ? trustedIso(structured.retryAt)
    : parsedLimit?.resetAt.toISOString();
  const executor = input.provider || input.accountId
    ? { ...(input.provider ? { provider: input.provider } : {}), ...(input.accountId ? { accountId: input.accountId } : {}) }
    : undefined;

  return {
    version: 1,
    ...(executor ? { executor } : {}),
    kind,
    legacyClassification,
    confidence,
    evidence: [evidence],
    ...(trustedRetryAt ? { retryAt: trustedRetryAt, retryAtTrusted: true as const } : {}),
    retryable: structured?.retryable ?? DEFAULT_RETRYABLE[kind],
    ...(message ? { diagnostic: redactDiagnostic(message) } : {}),
  };
}

/** Convert the existing provider-auth state without widening or replacing its latch behavior. */
export function normalizeProviderAvailabilityFailure(status: {
  provider: string;
  profileId?: string;
  status: 'connected' | 'disconnected' | 'not-installed' | 'unknown';
  hint?: string;
}): ExecutorFailure | null {
  if (status.status === 'connected') return null;
  const kind: ExecutorFailureKind = status.status === 'disconnected'
    ? 'authentication_failure'
    : status.status === 'not-installed'
      ? 'configuration_failure'
      : 'provider_temporarily_unavailable';
  return normalizeExecutorFailure({
    provider: status.provider,
    ...(status.profileId ? { accountId: status.profileId } : {}),
    ...(status.hint ? { message: status.hint } : {}),
    structured: {
      kind,
      confidence: status.status === 'unknown' ? 'low' : 'high',
      evidence: `provider-status:${status.status}`,
      retryable: status.status === 'unknown',
    },
  });
}

/** Runner callbacks are observability-only and can never fail the agent process. */
export function emitExecutorFailure(
  callback: ((failure: ExecutorFailure) => void) | undefined,
  input: NormalizeExecutorFailureInput,
): void {
  if (!callback) return;
  try {
    callback(normalizeExecutorFailure(input));
  } catch {
    // Observability callbacks follow onUsageWindows: a consumer defect never changes run behavior.
  }
}

function redactDiagnostic(message: string): string {
  return redactSecrets(message, collectSecretValues()).slice(0, 1_000);
}

function boundedDetail(detail: string): string {
  return redactDiagnostic(detail).slice(0, 120);
}

function trustedIso(value: Date | string | number | undefined): string | undefined {
  if (value === undefined) return undefined;
  const date = value instanceof Date ? value : typeof value === 'number' ? new Date(value) : new Date(value);
  return Number.isFinite(date.getTime()) ? date.toISOString() : undefined;
}
