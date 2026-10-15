import { createHash } from 'node:crypto';
import path from 'node:path';

import {
  BE_EXECUTION_PLAN_PREFIX,
  SkillEventSchema,
  SSE_PROTOCOL_VERSION,
  BE_SKILL_EVENT_PREFIX,
  ExecutionPlanSchema,
  type ExecutionPlan,
  type SkillEvent,
} from '@building-energy/contracts';
import type { ThreadEvent, ThreadItem } from '@openai/codex-sdk';

import { redactText } from './redaction.js';
import type { PersistableEvent, ProjectedSdkEvent } from './types.js';

interface CommandCursor {
  byteOffset: number;
  remainder: Buffer;
}

export class CodexEventProjector {
  private readonly commandCursors = new Map<string, CommandCursor>();
  private readonly rawEventFingerprints = new Set<string>();
  private readonly skillEventIds = new Set<string>();
  private executionPlanSeen: boolean;
  private skillStartedSeen = false;

  constructor(
    private readonly sessionId: string,
    private readonly turnId: string,
    hasPersistedExecutionPlan = false,
  ) {
    this.executionPlanSeen = hasPersistedExecutionPlan;
  }

  project(event: ThreadEvent): ProjectedSdkEvent {
    const result: ProjectedSdkEvent = { events: [], executionPlans: [], skillEvents: [] };
    if (
      event.type === 'thread.started' ||
      event.type === 'turn.started' ||
      event.type === 'turn.completed'
    ) {
      return result;
    }
    if (event.type === 'turn.failed' || event.type === 'error') return result;
    const fingerprint = fingerprintEvent(event);
    if (this.rawEventFingerprints.has(fingerprint)) return result;
    this.rawEventFingerprints.add(fingerprint);
    const item = event.item;
    if (item.type === 'agent_message') {
      result.finalMessage = item.text;
      return result;
    }
    if (item.type === 'todo_list') return result;
    if (item.type === 'reasoning') {
      result.events.push(this.activity(item, 'reasoning_summary', item.text, 'completed'));
      return result;
    }
    if (item.type === 'web_search') {
      result.events.push(this.activity(item, 'web_search', `公开检索：${item.query}`, 'completed'));
      return result;
    }
    if (item.type === 'command_execution') {
      const extracted = this.extractProtocolEvents(item.id, item.aggregated_output);
      result.executionPlans.push(...extracted.executionPlans);
      result.skillEvents.push(...extracted.skillEvents);
      result.events.push(
        this.activity(
          item,
          'command',
          redactText(item.command, 1_000, 5),
          item.status === 'in_progress' ? 'in_progress' : item.status,
          sanitizeCommandOutput(item.aggregated_output),
        ),
      );
      return result;
    }
    if (item.type === 'file_change') {
      const files = item.changes
        .slice(0, 30)
        .map((change) => `${change.kind}: ${path.basename(change.path)}`)
        .join('\n');
      result.events.push(this.activity(item, 'file', '会话文件发生变化', item.status, files));
      return result;
    }
    if (item.type === 'mcp_tool_call') {
      result.events.push(
        this.activity(
          item,
          'tool',
          `${redactText(item.server, 128, 1)} / ${redactText(item.tool, 128, 1)}`,
          item.status,
          item.error?.message,
        ),
      );
      return result;
    }
    if (item.type === 'error') {
      result.events.push(this.activity(item, 'warning', item.message, 'failed'));
    }
    return result;
  }

  projectSkillEvent(event: SkillEvent): PersistableEvent[] {
    switch (event.kind) {
      case 'started':
        return [
          this.event('skill.started', {
            skill_name: event.skill_name,
            job_id: event.job_id,
            stage: redactText(event.stage, 256, 2),
          }),
        ];
      case 'progress':
        return [
          this.event('skill.progress', {
            skill_name: event.skill_name,
            job_id: event.job_id,
            stage: redactText(event.stage, 256, 2),
            progress: event.progress,
            warnings: event.warnings.map((warning) => redactText(warning, 2_000, 10)),
          }),
        ];
      case 'completed':
        return [
          this.event('skill.completed', {
            skill_name: event.skill_name,
            job_id: event.job_id,
            status: event.outcome,
            result_refs: event.result_refs,
            warnings: event.warnings.map((warning) => redactText(warning, 2_000, 10)),
          }),
        ];
      case 'needs_input':
        return [
          this.event('agent.activity', {
            activity_id: `skill:${event.job_id}:needs-input`,
            kind: 'info',
            status: 'completed',
            summary: `${event.skill_name} 等待结构化输入`,
          }),
        ];
      case 'artifact':
        return [];
      case 'failed':
        return [
          this.event('agent.activity', {
            activity_id: `skill:${event.job_id}:failed`,
            kind: 'warning',
            status: 'failed',
            summary: `${event.skill_name} 执行失败`,
            detail: redactText(event.error.detail, 2_000, 20),
          }),
        ];
      case 'cancelled':
        return [
          this.event('agent.activity', {
            activity_id: `skill:${event.job_id}`,
            kind: 'info',
            status: 'completed',
            summary: `${event.skill_name} 已停止`,
          }),
        ];
    }
  }

  private extractProtocolEvents(
    itemId: string,
    aggregatedOutput: string,
  ): { executionPlans: ExecutionPlan[]; skillEvents: SkillEvent[] } {
    const bytes = Buffer.from(aggregatedOutput, 'utf8');
    let cursor = this.commandCursors.get(itemId) ?? { byteOffset: 0, remainder: Buffer.alloc(0) };
    if (bytes.length < cursor.byteOffset) cursor = { byteOffset: 0, remainder: Buffer.alloc(0) };
    const appended = bytes.subarray(cursor.byteOffset);
    const combined = Buffer.concat([cursor.remainder, appended]);
    const lines = combined.toString('utf8').split('\n');
    const remainderText = lines.pop() ?? '';
    this.commandCursors.set(itemId, {
      byteOffset: bytes.length,
      remainder: Buffer.from(remainderText, 'utf8'),
    });
    const executionPlans: ExecutionPlan[] = [];
    const events: SkillEvent[] = [];
    for (const line of lines) {
      if (line.startsWith(BE_EXECUTION_PLAN_PREFIX)) {
        if (this.executionPlanSeen) {
          throw new SkillProtocolProjectionError('同一 Turn 只能声明一次 execution.plan。');
        }
        if (this.skillStartedSeen) {
          throw new SkillProtocolProjectionError('execution.plan 必须先于首个 skill.started。');
        }
        try {
          const plan = ExecutionPlanSchema.parse(
            JSON.parse(line.slice(BE_EXECUTION_PLAN_PREFIX.length)) as unknown,
          );
          this.executionPlanSeen = true;
          executionPlans.push(plan);
        } catch (error) {
          const detail = error instanceof Error ? redactText(error.message, 1_000, 10) : '';
          throw new SkillProtocolProjectionError(
            detail
              ? `Agent 输出了无法验证的 execution.plan：${detail}`
              : 'Agent 输出了无法验证的 execution.plan。',
          );
        }
        continue;
      }
      if (!line.startsWith(BE_SKILL_EVENT_PREFIX)) continue;
      try {
        const event = SkillEventSchema.parse(JSON.parse(line.slice(BE_SKILL_EVENT_PREFIX.length)));
        if (event.kind === 'started') {
          if (!this.executionPlanSeen) {
            throw new SkillProtocolProjectionError('首个 skill.started 前缺少 execution.plan。');
          }
          this.skillStartedSeen = true;
        }
        const key = `${event.skill_name}:${event.job_id}:${event.event_id}`;
        if (!this.skillEventIds.has(key)) {
          this.skillEventIds.add(key);
          events.push(event);
        }
      } catch (error) {
        if (error instanceof SkillProtocolProjectionError) throw error;
        throw new SkillProtocolProjectionError('Skill 输出了无法验证的生命周期事件。');
      }
    }
    return { executionPlans, skillEvents: events };
  }

  private activity(
    item: ThreadItem,
    kind: 'reasoning_summary' | 'command' | 'file' | 'tool' | 'web_search' | 'warning',
    summary: string,
    status: 'in_progress' | 'completed' | 'failed',
    detail?: string,
  ): PersistableEvent {
    return this.event('agent.activity', {
      activity_id: item.id,
      kind,
      status,
      summary: redactText(summary, 4_000, 30) || '活动已更新',
      ...(detail ? { detail: redactText(detail, 8_000, 80) || '[REDACTED]' } : {}),
    });
  }

  private event(type: PersistableEvent['type'], data: unknown): PersistableEvent {
    return {
      protocol_version: SSE_PROTOCOL_VERSION,
      session_id: this.sessionId,
      turn_id: this.turnId,
      type,
      data,
    } as PersistableEvent;
  }
}

export class SkillProtocolProjectionError extends Error {}

function fingerprintEvent(event: ThreadEvent): string {
  return createHash('sha256').update(JSON.stringify(event)).digest('hex');
}

function sanitizeCommandOutput(output: string): string {
  return output
    .split(/\r?\n/)
    .filter(
      (line) =>
        !line.startsWith(BE_SKILL_EVENT_PREFIX) && !line.startsWith(BE_EXECUTION_PLAN_PREFIX),
    )
    .join('\n');
}
