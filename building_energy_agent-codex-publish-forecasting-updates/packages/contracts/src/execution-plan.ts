import { z } from 'zod';

import { OpaqueIdSchema } from './base.js';
import { SkillNameSchema } from './skill.js';

export const BE_EXECUTION_PLAN_PREFIX = 'BE_EXECUTION_PLAN ' as const;

export const ExecutionPlanNodeSchema = z
  .object({
    id: OpaqueIdSchema,
    title: z.string().min(1).max(2_000),
    skill_name: SkillNameSchema,
    depends_on: z.array(OpaqueIdSchema).max(128),
    parallel_group: OpaqueIdSchema.optional(),
  })
  .strict();

export const ExecutionPlanSchema = z
  .object({
    plan_id: OpaqueIdSchema,
    title: z.string().min(1).max(200).optional(),
    nodes: z.array(ExecutionPlanNodeSchema).min(1).max(128),
  })
  .strict()
  .superRefine((plan, context) => {
    const nodeIds = new Set<string>();
    for (const [index, node] of plan.nodes.entries()) {
      if (nodeIds.has(node.id)) {
        context.addIssue({
          code: 'custom',
          path: ['nodes', index, 'id'],
          message: 'execution plan node ids must be unique',
        });
      }
      nodeIds.add(node.id);
      if (new Set(node.depends_on).size !== node.depends_on.length) {
        context.addIssue({
          code: 'custom',
          path: ['nodes', index, 'depends_on'],
          message: 'execution plan dependencies must be unique',
        });
      }
      if (node.depends_on.includes(node.id)) {
        context.addIssue({
          code: 'custom',
          path: ['nodes', index, 'depends_on'],
          message: 'execution plan nodes cannot depend on themselves',
        });
      }
    }
    for (const [index, node] of plan.nodes.entries()) {
      for (const dependency of node.depends_on) {
        if (!nodeIds.has(dependency)) {
          context.addIssue({
            code: 'custom',
            path: ['nodes', index, 'depends_on'],
            message: `execution plan dependency does not reference a declared node: ${dependency}`,
          });
        }
      }
    }
    const nodesById = new Map(plan.nodes.map((node) => [node.id, node]));
    const visiting = new Set<string>();
    const visited = new Set<string>();
    const hasCycle = (nodeId: string): boolean => {
      if (visiting.has(nodeId)) return true;
      if (visited.has(nodeId)) return false;
      const node = nodesById.get(nodeId);
      if (!node) return false;
      visiting.add(nodeId);
      const cycle = node.depends_on.some((dependency) => hasCycle(dependency));
      visiting.delete(nodeId);
      visited.add(nodeId);
      return cycle;
    };
    if (plan.nodes.some((node) => hasCycle(node.id))) {
      context.addIssue({
        code: 'custom',
        path: ['nodes'],
        message: 'execution plan dependencies must be acyclic',
      });
    }
  });

export type ExecutionPlan = z.infer<typeof ExecutionPlanSchema>;
export type ExecutionPlanNode = z.infer<typeof ExecutionPlanNodeSchema>;
