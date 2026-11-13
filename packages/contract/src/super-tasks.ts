import { z } from 'zod';
import { reasoningEffortSchema } from './agent.ts';
import { runnerSchema } from './health.ts';

/** Durable planning aggregate status. Runtime statuses are projections of the linked run. */
export const superTaskStatusSchema = z.enum([
  'draft',
  'planning',
  'plan_review',
  'ready',
  'queued',
  'running',
  'blocked',
  'review',
  'done',
  'failed',
  'cancelled',
]);
export type SuperTaskStatus = z.infer<typeof superTaskStatusSchema>;

export const superTaskRoleSchema = z.enum(['planner', 'developer', 'reviewer', 'tester']);
export type SuperTaskRole = z.infer<typeof superTaskRoleSchema>;

/** A role binding is a snapshot-friendly selection of existing Cezar agent settings. */
export const superTaskRoleConfigSchema = z.object({
  runner: runnerSchema.optional(),
  model: z.string().trim().min(1).optional(),
  reasoningEffort: reasoningEffortSchema.optional(),
  profileId: z.string().trim().min(1).optional(),
  skills: z.array(z.string().trim().min(1)).optional(),
  allowedTools: z.array(z.string().trim().min(1)).optional(),
  maxRetries: z.number().int().nonnegative().optional(),
  executorPolicyId: z.string().trim().min(1).optional(),
  schedulingMode: z.enum(['fixed', 'failover']).optional(),
}).passthrough();
export type SuperTaskRoleConfig = z.infer<typeof superTaskRoleConfigSchema>;

export const superTaskWorkflowConfigSchema = z.object({
  workflowId: z.string().trim().min(1).optional(),
  roles: z.object({
    planner: superTaskRoleConfigSchema.optional(),
    developer: superTaskRoleConfigSchema.optional(),
    reviewer: superTaskRoleConfigSchema.optional(),
    tester: superTaskRoleConfigSchema.optional(),
  }).passthrough(),
}).passthrough();
export type SuperTaskWorkflowConfig = z.infer<typeof superTaskWorkflowConfigSchema>;

export const superTaskTargetSchema = z.object({
  projectId: z.string().trim().min(1),
  repositoryRootSnapshot: z.string().trim().min(1),
  remoteUrl: z.string().trim().min(1).optional(),
  baseBranch: z.string().trim().min(1),
}).passthrough();
export type SuperTaskTarget = z.infer<typeof superTaskTargetSchema>;

export const superTaskSubtaskSchema = z.object({
  /** Stable logical identity across revisions; never a child-run id. */
  id: z.string().trim().min(1),
  order: z.number().int().nonnegative(),
  title: z.string().trim().min(1),
  prompt: z.string().trim().min(1),
  acceptanceCriteria: z.array(z.string().trim().min(1)),
  dependencies: z.array(z.string().trim().min(1)),
  role: z.enum(['developer', 'reviewer', 'tester']),
  /** Filled by the deterministic compiler in a later phase. */
  workflowNodeIds: z.array(z.string().trim().min(1)).optional(),
}).passthrough();
export type SuperTaskSubtask = z.infer<typeof superTaskSubtaskSchema>;

export const superTaskPlanSchema = z.object({
  rationale: z.string().optional(),
  subtasks: z.array(superTaskSubtaskSchema),
}).passthrough().superRefine((plan, ctx) => {
  const byId = new Map<string, SuperTaskSubtask>();
  const orders = new Set<number>();
  for (const [index, subtask] of plan.subtasks.entries()) {
    if (byId.has(subtask.id)) {
      ctx.addIssue({ code: 'custom', path: ['subtasks', index, 'id'], message: 'subtask ids must be unique' });
    } else {
      byId.set(subtask.id, subtask);
    }
    if (orders.has(subtask.order)) {
      ctx.addIssue({ code: 'custom', path: ['subtasks', index, 'order'], message: 'subtask order values must be unique' });
    }
    orders.add(subtask.order);
  }
  for (const [index, subtask] of plan.subtasks.entries()) {
    const dependencies = new Set<string>();
    for (const [dependencyIndex, dependencyId] of subtask.dependencies.entries()) {
      const path = ['subtasks', index, 'dependencies', dependencyIndex] as const;
      if (dependencies.has(dependencyId)) {
        ctx.addIssue({ code: 'custom', path: [...path], message: 'dependencies must be unique' });
        continue;
      }
      dependencies.add(dependencyId);
      const dependency = byId.get(dependencyId);
      if (!dependency) ctx.addIssue({ code: 'custom', path: [...path], message: 'dependency must reference this plan' });
      else if (dependency.order >= subtask.order) {
        ctx.addIssue({ code: 'custom', path: [...path], message: 'stored order must place dependencies before their dependants' });
      }
    }
  }
});
export type SuperTaskPlan = z.infer<typeof superTaskPlanSchema>;

export const superTaskPlanApprovalSchema = z.object({
  state: z.enum(['pending', 'approved', 'rejected']),
  decidedAt: z.string().datetime().optional(),
  decidedBy: z.string().trim().min(1).optional(),
  note: z.string().optional(),
}).passthrough();
export type SuperTaskPlanApproval = z.infer<typeof superTaskPlanApprovalSchema>;

export const superTaskPlanRevisionSchema = z.object({
  revision: z.number().int().positive(),
  plan: superTaskPlanSchema,
  approval: superTaskPlanApprovalSchema,
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
}).passthrough();
export type SuperTaskPlanRevision = z.infer<typeof superTaskPlanRevisionSchema>;

export const superTaskExecutionSchema = z.object({
  /** The one root run for this Super Task; subtasks remain logical graph units. */
  runId: z.string().trim().min(1),
  startedPlanRevision: z.number().int().positive(),
  branch: z.string().optional(),
  baseBranch: z.string().optional(),
  pullRequestUrl: z.string().url().optional(),
  startedAt: z.string().datetime(),
  finishedAt: z.string().datetime().optional(),
}).passthrough();
export type SuperTaskExecution = z.infer<typeof superTaskExecutionSchema>;

export const superTaskArchiveSchema = z.object({
  archivedAt: z.string().datetime(),
  archivedBy: z.string().trim().min(1).optional(),
  reason: z.string().optional(),
}).passthrough();
export type SuperTaskArchive = z.infer<typeof superTaskArchiveSchema>;

export const superTaskRecordSchema = z.object({
  id: z.string().trim().min(1),
  projectId: z.string().trim().min(1),
  title: z.string().trim().min(1),
  /** The original detailed user request. Plan edits never rewrite it. */
  prompt: z.string().min(1),
  target: superTaskTargetSchema,
  workflowConfig: superTaskWorkflowConfigSchema,
  status: superTaskStatusSchema,
  /** Aggregate compare-and-set revision, independent of plan revision numbers. */
  revision: z.number().int().nonnegative(),
  planRevisions: z.array(superTaskPlanRevisionSchema),
  approvedPlanRevision: z.number().int().positive().optional(),
  execution: superTaskExecutionSchema.optional(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
  archive: superTaskArchiveSchema.optional(),
}).passthrough().superRefine((record, ctx) => {
  if (record.target.projectId !== record.projectId) {
    ctx.addIssue({ code: 'custom', path: ['target', 'projectId'], message: 'target project must match the owning project' });
  }
  const revisions = new Set<number>();
  for (const [index, planRevision] of record.planRevisions.entries()) {
    if (revisions.has(planRevision.revision)) {
      ctx.addIssue({ code: 'custom', path: ['planRevisions', index, 'revision'], message: 'plan revision numbers must be unique' });
    }
    revisions.add(planRevision.revision);
  }
  if (record.approvedPlanRevision !== undefined) {
    const approved = record.planRevisions.find((item) => item.revision === record.approvedPlanRevision);
    if (!approved || approved.approval.state !== 'approved') {
      ctx.addIssue({ code: 'custom', path: ['approvedPlanRevision'], message: 'approved revision must exist and be approved' });
    }
  }
  if (record.execution) {
    if (record.execution.startedPlanRevision !== record.approvedPlanRevision) {
      ctx.addIssue({ code: 'custom', path: ['execution', 'startedPlanRevision'], message: 'execution must use the approved plan revision' });
    }
  }
});
export type SuperTaskRecord = z.infer<typeof superTaskRecordSchema>;

export const superTaskAuditEventSchema = z.object({
  id: z.string().trim().min(1),
  superTaskId: z.string().trim().min(1),
  projectId: z.string().trim().min(1),
  revision: z.number().int().nonnegative(),
  type: z.enum([
    'created',
    'updated',
    'plan-revised',
    'plan-approved',
    'execution-linked',
    'archived',
  ]),
  at: z.string().datetime(),
  actor: z.string().trim().min(1).optional(),
  details: z.record(z.string(), z.unknown()).optional(),
}).passthrough();
export type SuperTaskAuditEvent = z.infer<typeof superTaskAuditEventSchema>;
