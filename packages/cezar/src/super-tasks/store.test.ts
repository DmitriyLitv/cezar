import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runRecordSchema } from '../runs/store.ts';
import {
  SuperTaskInvariantError,
  SuperTaskRevisionConflictError,
  SuperTaskStore,
} from './store.ts';

describe('SuperTaskStore', () => {
  let dataDir: string;

  beforeEach(() => { dataDir = mkdtempSync(join(tmpdir(), 'cez-super-tasks-')); });
  afterEach(() => { rmSync(dataDir, { recursive: true, force: true }); });

  const open = () => SuperTaskStore.open(dataDir, 'project-a');
  const create = (store: SuperTaskStore, id = 'super-1') => store.createSuperTask({
    id,
    title: 'Ship durable planning',
    prompt: 'Implement the complete detailed request without rewriting legacy tasks.',
    target: {
      repositoryRootSnapshot: '/repos/project-a',
      remoteUrl: 'https://github.com/acme/project-a.git',
      baseBranch: 'main',
    },
    workflowConfig: {
      workflowId: 'super-task',
      roles: {
        planner: { runner: 'codex', model: 'planner-model', reasoningEffort: 'high' },
        developer: { runner: 'claude', profileId: 'work', skills: ['typescript'] },
        reviewer: { runner: 'codex', allowedTools: ['Read'] },
        tester: { runner: 'codex', maxRetries: 2 },
      },
    },
  });

  const plan = {
    rationale: 'Keep execution in one root run.',
    subtasks: [
      {
        id: 'domain',
        order: 0,
        title: 'Build domain',
        prompt: 'Create the persistent domain.',
        acceptanceCriteria: ['Records survive restart'],
        dependencies: [],
        role: 'developer' as const,
      },
      {
        id: 'review',
        order: 1,
        title: 'Review domain',
        prompt: 'Review the persistent domain.',
        acceptanceCriteria: ['No eager run migration'],
        dependencies: ['domain'],
        role: 'reviewer' as const,
      },
    ],
  };

  it('round-trips aggregate, plan, approval, one root-run link, archive, and audit transcript', () => {
    const store = open();
    const created = create(store);
    const planned = store.addPlanRevision(created.id, created.revision, plan, 'planner');
    const approved = store.approvePlanRevision(planned.id, planned.revision, 1, { actor: 'owner' });
    const linked = store.linkExecution(approved.id, approved.revision, {
      runId: 'root-run-1',
      startedPlanRevision: 1,
      branch: 'cez/root-run',
      baseBranch: 'main',
    });
    store.archiveSuperTask(linked.id, linked.revision, { archivedBy: 'owner', reason: 'delivered' });

    const reopened = open();
    expect(reopened.listSuperTasks()).toEqual([]);
    expect(reopened.listSuperTasks({ includeArchived: true })[0]).toMatchObject({
      id: 'super-1',
      projectId: 'project-a',
      prompt: 'Implement the complete detailed request without rewriting legacy tasks.',
      target: { baseBranch: 'main' },
      approvedPlanRevision: 1,
      execution: { runId: 'root-run-1', startedPlanRevision: 1 },
      archive: { archivedBy: 'owner', reason: 'delivered' },
    });
    expect(reopened.getSuperTask('super-1')?.planRevisions[0]?.plan.subtasks.map((item) => item.id))
      .toEqual(['domain', 'review']);
    expect(reopened.readAuditEvents('super-1').map((event) => event.type)).toEqual([
      'created', 'plan-revised', 'plan-approved', 'execution-linked', 'archived',
    ]);
  });

  it('merges separate writers instead of replacing a stale in-memory index', () => {
    const first = open();
    const second = open();
    create(first, 'first');
    create(second, 'second');

    expect(open().listSuperTasks().map((record) => record.id).sort()).toEqual(['first', 'second']);
  });

  it('serializes concurrent process writers without losing acknowledged records', async () => {
    const fixture = fileURLToPath(new URL('./fixtures/index-writer.mjs', import.meta.url));
    const ids = ['writer-a', 'writer-b', 'writer-c', 'writer-d'];
    await Promise.all(ids.map((id) => new Promise<void>((resolve, reject) => {
      const child = spawn(process.execPath, ['--import', 'tsx', fixture, dataDir, id], {
        stdio: ['ignore', 'ignore', 'pipe'],
      });
      let stderr = '';
      child.stderr!.on('data', (chunk) => { stderr += chunk; });
      child.on('error', reject);
      child.on('exit', (code) => code === 0 ? resolve() : reject(new Error(`${id} exited ${code}: ${stderr}`)));
    })));

    expect(open().listSuperTasks().map((record) => record.id).sort()).toEqual([...ids].sort());
  }, 20_000);

  it('compares expected revisions against fresh locked disk state', () => {
    const first = open();
    const created = create(first);
    const stale = open();
    first.updateSuperTask(created.id, 0, { title: 'new title' });

    expect(() => stale.updateSuperTask(created.id, 0, { status: 'planning' }))
      .toThrow(SuperTaskRevisionConflictError);
    expect(open().getSuperTask(created.id)).toMatchObject({ title: 'new title', status: 'draft', revision: 1 });
  });

  it('links an approved plan to at most one root execution run', () => {
    const store = open();
    const created = create(store);
    const planned = store.addPlanRevision(created.id, 0, plan);
    const approved = store.approvePlanRevision(created.id, planned.revision, 1);
    const linked = store.linkExecution(created.id, approved.revision, {
      runId: 'root-run-1', startedPlanRevision: 1,
    });

    expect(() => store.linkExecution(created.id, linked.revision, {
      runId: 'root-run-2', startedPlanRevision: 1,
    })).toThrow(/already has root run root-run-1/);
    expect(open().getSuperTask(created.id)?.execution?.runId).toBe('root-run-1');
  });

  it('preserves future and unreadable rows verbatim while saving readable records', () => {
    const seed = open();
    const compatible = create(seed, 'compatible');
    const path = join(dataDir, 'super-tasks.json');
    const future = { id: 'future', projectId: 'project-a', createdAt: '2030-01-01T00:00:00.000Z', futureShape: true };
    const rows = JSON.parse(readFileSync(path, 'utf8'));
    rows[0].futureField = { retained: true };
    writeFileSync(path, JSON.stringify([...rows, future]), 'utf8');

    const store = open();
    expect(store.getIndexReadHealth()).toEqual({ state: 'complete', omittedSuperTasks: 1 });
    store.updateSuperTask(compatible.id, compatible.revision, { status: 'planning' });

    const saved = JSON.parse(readFileSync(path, 'utf8')) as Array<Record<string, unknown>>;
    expect(saved.find((row) => row.id === 'future')).toEqual(future);
    expect(saved.find((row) => row.id === 'compatible')?.futureField).toEqual({ retained: true });
  });

  it('recovers valid audit events around a torn tail and ignores abandoned atomic temp files', () => {
    const store = open();
    const created = create(store);
    const transcript = join(dataDir, 'super-tasks', `${created.id}.ndjson`);
    writeFileSync(transcript, `${readFileSync(transcript, 'utf8')}{"torn":`, 'utf8');
    writeFileSync(join(dataDir, 'super-tasks', '.index-abandoned.tmp'), '[', 'utf8');

    const reopened = open();
    expect(reopened.getSuperTask(created.id)?.id).toBe(created.id);
    expect(reopened.readAuditEvents(created.id).map((event) => event.type)).toEqual(['created']);
  });

  it('refuses to overwrite a corrupt authoritative index', () => {
    const store = open();
    create(store);
    writeFileSync(join(dataDir, 'super-tasks.json'), '{broken', 'utf8');

    expect(() => store.updateSuperTask('super-1', 0, { title: 'lost update' }))
      .toThrow(SuperTaskInvariantError);
    expect(readFileSync(join(dataDir, 'super-tasks.json'), 'utf8')).toBe('{broken');
  });

  it('rejects dependency graphs whose stored order is not topological', () => {
    const store = open();
    const created = create(store);
    expect(() => store.addPlanRevision(created.id, 0, {
      subtasks: [{
        ...plan.subtasks[0],
        dependencies: ['later'],
      }, {
        ...plan.subtasks[1],
        id: 'later',
        dependencies: [],
      }],
    })).toThrow(/stored order must place dependencies before their dependants/);
  });

  it('keeps Super Task run provenance optional for legacy standalone records', () => {
    const legacy = runRecordSchema.parse({
      id: 'legacy', title: 'legacy', workflow: 'quick-task', task: 'legacy', status: 'done',
      createdAt: '2026-01-01T00:00:00.000Z', tokensUsed: 0, archived: false, steps: [],
    });
    expect(legacy.superTaskId).toBeUndefined();
    expect(runRecordSchema.parse({
      ...legacy, superTaskId: 'super-1', planRevision: 2,
    })).toMatchObject({ superTaskId: 'super-1', planRevision: 2 });
  });
});
