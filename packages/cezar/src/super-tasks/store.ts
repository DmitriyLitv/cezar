import {
  superTaskAuditEventSchema,
  superTaskPlanSchema,
  superTaskRecordSchema,
  type SuperTaskArchive,
  type SuperTaskAuditEvent,
  type SuperTaskExecution,
  type SuperTaskPlan,
  type SuperTaskRecord,
  type SuperTaskStatus,
  type SuperTaskTarget,
  type SuperTaskWorkflowConfig,
} from '@open-mercato/cezar-contract';
import { randomUUID } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import lockfile from 'proper-lockfile';
import { z } from 'zod';
import { renameSyncWithRetry } from '../fs-rename.ts';

const INDEX = 'super-tasks.json';
const TRANSCRIPTS = 'super-tasks';

const salvageHeaderSchema = z.object({
  id: z.string().min(1),
  projectId: z.string().min(1),
  createdAt: z.string(),
}).passthrough();

export class SuperTaskNotFoundError extends Error {
  constructor(readonly superTaskId: string) {
    super(`super task not found: ${superTaskId}`);
    this.name = 'SuperTaskNotFoundError';
  }
}

export class SuperTaskRevisionConflictError extends Error {
  constructor(
    readonly superTaskId: string,
    readonly expectedRevision: number,
    readonly actualRevision: number,
  ) {
    super(`super task revision conflict: expected ${expectedRevision}, found ${actualRevision}`);
    this.name = 'SuperTaskRevisionConflictError';
  }
}

export class SuperTaskInvariantError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SuperTaskInvariantError';
  }
}

export interface CreateSuperTaskInput {
  id?: string;
  title: string;
  /** Original detailed prompt; it is deliberately not mutable through updateSuperTask. */
  prompt: string;
  target: Omit<SuperTaskTarget, 'projectId'> & { projectId?: string };
  workflowConfig: SuperTaskWorkflowConfig;
  status?: SuperTaskStatus;
}

export interface UpdateSuperTaskInput {
  title?: string;
  target?: SuperTaskTarget;
  workflowConfig?: SuperTaskWorkflowConfig;
  status?: SuperTaskStatus;
}

type AuditInput = Pick<SuperTaskAuditEvent, 'type'> &
  Partial<Pick<SuperTaskAuditEvent, 'actor' | 'details'>>;

/**
 * Project-owned durable planning store. The compact aggregate index stays independent from
 * legacy runs.json; the per-id NDJSON file is an append-only planning/lifecycle audit trail.
 * Every index mutation re-reads under a cross-process writer lock and compares the caller's
 * expected revision before atomically replacing the file.
 */
export class SuperTaskStore {
  private readonly records = new Map<string, SuperTaskRecord>();
  private readonly salvaged = new Map<string, unknown>();
  private indexReadable = true;

  private constructor(
    private readonly dataDir: string,
    readonly projectId: string,
  ) {}

  static open(dataDir: string, projectId: string): SuperTaskStore {
    const store = new SuperTaskStore(dataDir, projectId);
    try {
      mkdirSync(join(dataDir, TRANSCRIPTS), { recursive: true });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`[cez] cannot create ${join(dataDir, TRANSCRIPTS)} (${message}); super tasks cannot be persisted`);
    }
    store.reload();
    return store;
  }

  getDataDir(): string { return this.dataDir; }

  getIndexReadHealth(): { state: 'complete' | 'unavailable'; omittedSuperTasks: number } {
    return {
      state: this.indexReadable ? 'complete' : 'unavailable',
      omittedSuperTasks: this.salvaged.size,
    };
  }

  refresh(): void { this.reload(); }

  listSuperTasks(options: { includeArchived?: boolean } = {}): SuperTaskRecord[] {
    return [...this.records.values()]
      .filter((record) => options.includeArchived || !record.archive)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt) || a.id.localeCompare(b.id));
  }

  getSuperTask(id: string): SuperTaskRecord | undefined { return this.records.get(id); }

  createSuperTask(input: CreateSuperTaskInput, actor?: string): SuperTaskRecord {
    if (input.target.projectId !== undefined && input.target.projectId !== this.projectId) {
      throw new SuperTaskInvariantError('target project must match the store project');
    }
    const now = new Date().toISOString();
    const record = superTaskRecordSchema.parse({
      id: input.id ?? randomUUID(),
      projectId: this.projectId,
      title: input.title,
      prompt: input.prompt,
      target: { ...input.target, projectId: this.projectId },
      workflowConfig: input.workflowConfig,
      status: input.status ?? 'draft',
      revision: 0,
      planRevisions: [],
      createdAt: now,
      updatedAt: now,
    });
    return this.commit(record.id, undefined, () => record, { type: 'created', actor });
  }

  updateSuperTask(
    id: string,
    expectedRevision: number,
    update: UpdateSuperTaskInput,
    actor?: string,
  ): SuperTaskRecord {
    return this.commit(id, expectedRevision, (current) => ({
      ...current,
      ...(update.title !== undefined ? { title: update.title } : {}),
      ...(update.target !== undefined ? { target: update.target } : {}),
      ...(update.workflowConfig !== undefined ? { workflowConfig: update.workflowConfig } : {}),
      ...(update.status !== undefined ? { status: update.status } : {}),
      revision: current.revision + 1,
      updatedAt: new Date().toISOString(),
    }), { type: 'updated', actor });
  }

  addPlanRevision(
    id: string,
    expectedRevision: number,
    plan: SuperTaskPlan,
    actor?: string,
  ): SuperTaskRecord {
    const parsedPlan = superTaskPlanSchema.parse(plan);
    return this.commit(id, expectedRevision, (current) => {
      const now = new Date().toISOString();
      const planRevision = Math.max(0, ...current.planRevisions.map((item) => item.revision)) + 1;
      return {
        ...current,
        status: 'plan_review',
        revision: current.revision + 1,
        planRevisions: [...current.planRevisions, {
          revision: planRevision,
          plan: parsedPlan,
          approval: { state: 'pending' },
          createdAt: now,
          updatedAt: now,
        }],
        updatedAt: now,
      };
    }, { type: 'plan-revised', actor });
  }

  approvePlanRevision(
    id: string,
    expectedRevision: number,
    planRevision: number,
    approval: { actor?: string; note?: string } = {},
  ): SuperTaskRecord {
    return this.commit(id, expectedRevision, (current) => {
      if (current.execution) throw new SuperTaskInvariantError('an executing super task cannot approve a different plan');
      const selected = current.planRevisions.find((item) => item.revision === planRevision);
      if (!selected) throw new SuperTaskInvariantError(`plan revision not found: ${planRevision}`);
      const now = new Date().toISOString();
      return {
        ...current,
        status: 'ready',
        revision: current.revision + 1,
        approvedPlanRevision: planRevision,
        planRevisions: current.planRevisions.map((item) => item.revision === planRevision ? {
          ...item,
          approval: {
            state: 'approved' as const,
            decidedAt: now,
            decidedBy: approval.actor,
            note: approval.note,
          },
          updatedAt: now,
        } : item),
        updatedAt: now,
      };
    }, {
      type: 'plan-approved',
      actor: approval.actor,
      details: { planRevision },
    });
  }

  linkExecution(
    id: string,
    expectedRevision: number,
    execution: Omit<SuperTaskExecution, 'startedAt'> & { startedAt?: string },
    actor?: string,
  ): SuperTaskRecord {
    return this.commit(id, expectedRevision, (current) => {
      if (current.execution) {
        throw new SuperTaskInvariantError(`super task already has root run ${current.execution.runId}`);
      }
      if (current.approvedPlanRevision !== execution.startedPlanRevision) {
        throw new SuperTaskInvariantError('execution must link the currently approved plan revision');
      }
      const now = new Date().toISOString();
      return {
        ...current,
        status: 'queued',
        revision: current.revision + 1,
        execution: { ...execution, startedAt: execution.startedAt ?? now },
        updatedAt: now,
      };
    }, {
      type: 'execution-linked',
      actor,
      details: { runId: execution.runId, planRevision: execution.startedPlanRevision },
    });
  }

  archiveSuperTask(
    id: string,
    expectedRevision: number,
    archive: Omit<SuperTaskArchive, 'archivedAt'> & { archivedAt?: string } = {},
  ): SuperTaskRecord {
    return this.commit(id, expectedRevision, (current) => {
      const now = new Date().toISOString();
      return {
        ...current,
        revision: current.revision + 1,
        archive: { ...archive, archivedAt: archive.archivedAt ?? now },
        updatedAt: now,
      };
    }, { type: 'archived', actor: archive.archivedBy, details: archive.reason ? { reason: archive.reason } : undefined });
  }

  readAuditEvents(id: string): SuperTaskAuditEvent[] {
    try {
      return readFileSync(this.transcriptPath(id), 'utf8')
        .split('\n')
        .filter(Boolean)
        .flatMap((line) => {
          try {
            const parsed = superTaskAuditEventSchema.safeParse(JSON.parse(line));
            return parsed.success ? [parsed.data] : [];
          } catch { return []; }
        });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw error;
    }
  }

  private commit(
    id: string,
    expectedRevision: number | undefined,
    mutate: (current: SuperTaskRecord) => SuperTaskRecord,
    audit: AuditInput,
  ): SuperTaskRecord {
    const directory = join(this.dataDir, TRANSCRIPTS);
    mkdirSync(directory, { recursive: true });
    const release = lockfile.lockSync(directory, {
      realpath: false,
      lockfilePath: join(directory, '.index-writer.lock'),
      stale: 15_000,
      update: 5_000,
      retries: { retries: 40, factor: 1.2, minTimeout: 10, maxTimeout: 50 },
    });
    let next: SuperTaskRecord;
    let rows: unknown[];
    try {
      rows = this.readRowsForWrite();
      const index = rows.findIndex((row) => (row as { id?: unknown } | null)?.id === id);
      if (expectedRevision === undefined) {
        if (index !== -1) throw new SuperTaskInvariantError(`super task already exists: ${id}`);
        next = superTaskRecordSchema.parse(mutate(undefined as never));
        rows.push(next);
      } else {
        if (index === -1) throw new SuperTaskNotFoundError(id);
        const parsed = superTaskRecordSchema.safeParse(rows[index]);
        if (!parsed.success || parsed.data.projectId !== this.projectId) {
          throw new SuperTaskInvariantError(`super task cannot be safely mutated: ${id}`);
        }
        if (parsed.data.revision !== expectedRevision) {
          throw new SuperTaskRevisionConflictError(id, expectedRevision, parsed.data.revision);
        }
        next = superTaskRecordSchema.parse(mutate(parsed.data));
        if (next.id !== id || next.projectId !== this.projectId) {
          throw new SuperTaskInvariantError('a mutation cannot change super task identity');
        }
        rows[index] = next;
      }
      this.writeRows(rows);
      const event = superTaskAuditEventSchema.parse({
        id: randomUUID(),
        superTaskId: id,
        projectId: this.projectId,
        revision: next.revision,
        type: audit.type,
        at: next.updatedAt,
        actor: audit.actor,
        details: audit.details,
      });
      appendFileSync(this.transcriptPath(id), `${JSON.stringify(event)}\n`, 'utf8');
      this.loadRows(rows);
      return next;
    } finally {
      release();
    }
  }

  private reload(): void {
    const path = join(this.dataDir, INDEX);
    if (!existsSync(path)) {
      this.loadRows([]);
      return;
    }
    try {
      const rows = JSON.parse(readFileSync(path, 'utf8'));
      if (!Array.isArray(rows)) throw new Error('index is not an array');
      this.indexReadable = true;
      this.loadRows(rows);
    } catch {
      this.records.clear();
      this.salvaged.clear();
      this.indexReadable = false;
      console.warn('[cez] super-tasks.json could not be loaded; the file was left untouched');
    }
  }

  private loadRows(rows: unknown[]): void {
    this.records.clear();
    this.salvaged.clear();
    for (const row of rows) {
      const parsed = superTaskRecordSchema.safeParse(row);
      if (parsed.success && parsed.data.projectId === this.projectId) {
        this.records.set(parsed.data.id, parsed.data);
        continue;
      }
      const header = salvageHeaderSchema.safeParse(row);
      if (header.success) this.salvaged.set(header.data.id, row);
    }
    this.indexReadable = true;
  }

  private readRowsForWrite(): unknown[] {
    const path = join(this.dataDir, INDEX);
    if (!existsSync(path)) return [];
    let value: unknown;
    try { value = JSON.parse(readFileSync(path, 'utf8')); }
    catch { throw new SuperTaskInvariantError('super task index is unreadable; refusing to overwrite recovery evidence'); }
    if (!Array.isArray(value)) {
      throw new SuperTaskInvariantError('super task index is invalid; refusing to overwrite recovery evidence');
    }
    return value;
  }

  private writeRows(rows: unknown[]): void {
    const sorted = [...rows].sort((a, b) => {
      const left = salvageHeaderSchema.safeParse(a);
      const right = salvageHeaderSchema.safeParse(b);
      if (!left.success) return 1;
      if (!right.success) return -1;
      return right.data.createdAt.localeCompare(left.data.createdAt) || left.data.id.localeCompare(right.data.id);
    });
    const temporary = join(this.dataDir, TRANSCRIPTS, `.index-${process.pid}-${randomUUID()}.tmp`);
    try {
      writeFileSync(temporary, JSON.stringify(sorted), 'utf8');
      renameSyncWithRetry(temporary, join(this.dataDir, INDEX));
    } finally {
      try { rmSync(temporary, { force: true }); } catch { /* best effort after atomic replace */ }
    }
  }

  private transcriptPath(id: string): string { return join(this.dataDir, TRANSCRIPTS, `${id}.ndjson`); }
}
