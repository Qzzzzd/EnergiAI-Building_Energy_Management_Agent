import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import { createHash, randomUUID } from 'node:crypto';

import {
  PUBLIC_API_VERSION,
  SSE_PROTOCOL_VERSION,
  type ArtifactRef,
  ExecutionPlanSchema,
  type ExecutionPlan,
  type ProblemDetails,
  type Question,
  type QuestionAnswer,
  type ReasoningLevel,
  type SessionResource,
  type SseEvent,
  type TurnResource,
} from '@building-energy/contracts';

import type { Clock, PersistableEvent } from './types.js';

const TERMINAL_TURNS = new Set(['completed', 'partial', 'failed', 'cancelled', 'interrupted']);
const ACTIVE_TURNS = new Set(['queued', 'running', 'cancelling']);

type Row = Record<string, unknown>;

export interface SessionRow {
  id: string;
  title: string;
  threadId: string | null;
  model: string;
  reasoning: ReasoningLevel;
  status: 'empty' | 'idle' | 'running' | 'needs_input' | 'deleting';
  workspace: string;
  modelLocked: boolean;
  archived: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface TurnRow {
  id: string;
  sessionId: string;
  idempotencyKey: string;
  requestHash: string;
  status: TurnResource['status'];
  startedAt: string | null;
  finishedAt: string | null;
  error: ProblemDetails | null;
  resultRefs: ArtifactRef[];
  executionPlan: ExecutionPlan | null;
  createdAt: string;
}

export interface UploadRow {
  id: string;
  sessionId: string;
  sourceRef: string;
  originalName: string;
  relativePath: string;
  size: number;
  sha256: string;
  mediaType: string;
  createdAt: string;
}

export interface ArtifactRow {
  id: string;
  sessionId: string;
  turnId: string;
  manifestPath: string;
  type: string;
  status: 'succeeded' | 'partial';
  sha256: string;
  manifestJson: string;
  integrityError: string | null;
  createdAt: string;
}

export interface SkillJobRow {
  id: string;
  sessionId: string;
  turnId: string;
  skillName: string;
  externalJobId: string;
  status: string;
  metadata: Record<string, unknown>;
}

export class RepositoryError extends Error {
  constructor(
    readonly code:
      | 'RESOURCE_NOT_FOUND'
      | 'RESOURCE_CONFLICT'
      | 'IDEMPOTENCY_CONFLICT'
      | 'SESSION_BUSY'
      | 'SESSION_STATE_INVALID'
      | 'MODEL_LOCKED'
      | 'SOURCE_REFERENCE_INVALID',
    message: string,
  ) {
    super(message);
  }
}

export class Repository {
  readonly db: DatabaseSync;

  constructor(
    databasePath: string,
    private readonly clock: Clock = () => new Date(),
  ) {
    mkdirSync(path.dirname(databasePath), { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(databasePath);
    this.db.exec('PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;');
  }

  migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version INTEGER PRIMARY KEY,
        applied_at TEXT NOT NULL
      );
    `);
    const current = Number(
      (
        this.db
          .prepare('SELECT COALESCE(MAX(version), 0) AS version FROM schema_migrations')
          .get() as Row
      ).version,
    );
    if (current < 1) this.transaction(() => this.migration1());
    if (current < 2) this.transaction(() => this.migration2());
    if (current < 3) this.transaction(() => this.migration3());
  }

  close(): void {
    this.db.close();
  }

  pragmas(): { journalMode: string; foreignKeys: boolean } {
    const journal = this.db.prepare('PRAGMA journal_mode').get() as Row;
    const foreignKeys = this.db.prepare('PRAGMA foreign_keys').get() as Row;
    return {
      journalMode: String(journal.journal_mode),
      foreignKeys: Number(foreignKeys.foreign_keys) === 1,
    };
  }

  transaction<T>(operation: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const result = operation();
      this.db.exec('COMMIT');
      return result;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  createSession(input: {
    id?: string;
    title: string;
    model: string;
    reasoning: ReasoningLevel;
    workspace: string;
  }): SessionRow {
    const id = input.id ?? randomUUID();
    const now = this.now();
    this.db
      .prepare(
        `INSERT INTO sessions
         (id, title, model, reasoning, status, workspace, model_locked, created_at, updated_at)
         VALUES (?, ?, ?, ?, 'empty', ?, 0, ?, ?)`,
      )
      .run(id, input.title, input.model, input.reasoning, input.workspace, now, now);
    return this.requireSession(id);
  }

  requireSession(id: string): SessionRow {
    const row = this.db.prepare('SELECT * FROM sessions WHERE id = ?').get(id) as Row | undefined;
    if (!row) throw new RepositoryError('RESOURCE_NOT_FOUND', '会话不存在。');
    return this.mapSession(row);
  }

  assertSessionWritable(id: string): SessionRow {
    const session = this.requireSession(id);
    if (session.status === 'deleting') {
      throw new RepositoryError('SESSION_STATE_INVALID', '会话正在删除。');
    }
    if (session.archived) {
      throw new RepositoryError('SESSION_STATE_INVALID', '已归档会话需要先恢复后才能继续操作。');
    }
    return session;
  }

  listSessions(search?: string, limit = 50, cursor?: string, archived?: boolean): SessionRow[] {
    const filters: string[] = [];
    const values: SQLInputValue[] = [];
    if (search) {
      filters.push("title LIKE ? ESCAPE '\\'");
      values.push(`%${search.replace(/[\\%_]/g, '\\$&')}%`);
    }
    if (archived !== undefined) {
      filters.push('archived = ?');
      values.push(archived ? 1 : 0);
    }
    if (cursor) {
      filters.push('id < ?');
      values.push(cursor);
    }
    const where = filters.length ? `WHERE ${filters.join(' AND ')}` : '';
    const rows = this.db
      .prepare(`SELECT * FROM sessions ${where} ORDER BY updated_at DESC, id DESC LIMIT ?`)
      .all(...values, limit) as Row[];
    return rows.map((row) => this.mapSession(row));
  }

  updateSession(
    sessionId: string,
    input: {
      title?: string;
      archived?: boolean;
      model?: string;
      reasoning?: ReasoningLevel;
    },
  ): SessionRow {
    return this.transaction(() => {
      const session = this.requireSession(sessionId);
      if (session.status === 'deleting') {
        throw new RepositoryError('SESSION_STATE_INVALID', '会话正在删除。');
      }
      if (input.model !== undefined || input.reasoning !== undefined) {
        if (session.archived) {
          throw new RepositoryError(
            'SESSION_STATE_INVALID',
            '已归档会话需要先恢复后才能调整模型。',
          );
        }
        if (session.modelLocked) {
          throw new RepositoryError('MODEL_LOCKED', '首轮发送后不能更换模型或推理强度。');
        }
        if (input.model === undefined || input.reasoning === undefined) {
          throw new RepositoryError('SESSION_STATE_INVALID', '模型和推理强度必须同时提供。');
        }
      }
      if (input.archived === true && this.findActiveTurn(sessionId)) {
        throw new RepositoryError('SESSION_BUSY', '执行中的会话不能归档，请等待或取消当前任务。');
      }
      const updates: string[] = [];
      const values: SQLInputValue[] = [];
      if (input.title !== undefined) {
        updates.push('title = ?');
        values.push(input.title);
      }
      if (input.archived !== undefined) {
        updates.push('archived = ?');
        values.push(input.archived ? 1 : 0);
      }
      if (input.model !== undefined && input.reasoning !== undefined) {
        updates.push('model = ?', 'reasoning = ?');
        values.push(input.model, input.reasoning);
      }
      updates.push('updated_at = ?');
      values.push(this.now(), sessionId);
      const result = this.db
        .prepare(`UPDATE sessions SET ${updates.join(', ')} WHERE id = ?`)
        .run(...values);
      if (result.changes !== 1) throw new RepositoryError('RESOURCE_NOT_FOUND', '会话不存在。');
      return this.requireSession(sessionId);
    });
  }

  createTurn(input: {
    sessionId: string;
    idempotencyKey: string;
    content: string;
    sourceRefs: string[];
  }): { turn: TurnRow; replayed: boolean } {
    const requestHash = hashJson({
      content: input.content,
      source_refs: input.sourceRefs,
    });
    return this.transaction(() => {
      const session = this.assertSessionWritable(input.sessionId);
      const existing = this.db
        .prepare('SELECT * FROM turns WHERE session_id = ? AND idempotency_key = ?')
        .get(input.sessionId, input.idempotencyKey) as Row | undefined;
      if (existing) {
        const turn = this.mapTurn(existing);
        if (turn.requestHash !== requestHash) {
          throw new RepositoryError('IDEMPOTENCY_CONFLICT', '幂等键已用于不同请求。');
        }
        return { turn, replayed: true };
      }
      const active = this.findActiveTurn(input.sessionId);
      if (active) throw new RepositoryError('SESSION_BUSY', '该会话已有正在执行的 Turn。');
      this.assertSourcesOwned(input.sessionId, input.sourceRefs);
      if (this.pendingQuestionSet(input.sessionId)) {
        throw new RepositoryError('SESSION_STATE_INVALID', '请先回答当前待确认问题。');
      }
      const turnId = randomUUID();
      const messageId = randomUUID();
      const now = this.now();
      this.db
        .prepare(
          `INSERT INTO turns
           (id, session_id, idempotency_key, request_hash, status, result_refs_json, created_at)
           VALUES (?, ?, ?, ?, 'queued', '[]', ?)`,
        )
        .run(turnId, input.sessionId, input.idempotencyKey, requestHash, now);
      this.db
        .prepare(
          `INSERT INTO messages
           (id, session_id, turn_id, role, content, source_refs_json, result_refs_json, created_at)
           VALUES (?, ?, ?, 'user', ?, ?, '[]', ?)`,
        )
        .run(
          messageId,
          input.sessionId,
          turnId,
          input.content,
          JSON.stringify(input.sourceRefs),
          now,
        );
      this.db
        .prepare(
          "UPDATE sessions SET status = 'running', model_locked = 1, updated_at = ? WHERE id = ?",
        )
        .run(now, input.sessionId);
      return { turn: this.requireTurn(turnId), replayed: false };
    });
  }

  resumeQuestionSet(input: {
    sessionId: string;
    idempotencyKey: string;
    questionSetId: string;
    answers: QuestionAnswer[];
    content: string;
  }): { turn: TurnRow; replayed: boolean } {
    const requestHash = hashJson({
      question_set_id: input.questionSetId,
      answers: input.answers,
    });
    const scope = `question-answer:${input.sessionId}`;
    return this.transaction(() => {
      this.assertSessionWritable(input.sessionId);
      const replay = this.getIdempotency<{ turn_id: string }>(
        scope,
        input.idempotencyKey,
        requestHash,
      );
      if (replay) {
        return {
          turn: this.requireSessionTurn(input.sessionId, replay.turn_id),
          replayed: true,
        };
      }
      const active = this.findActiveTurn(input.sessionId);
      if (active) throw new RepositoryError('SESSION_BUSY', '该会话已有正在执行的 Turn。');
      const turnId = this.consumeQuestionSet(input.sessionId, input.questionSetId, input.answers);
      const turn = this.requireSessionTurn(input.sessionId, turnId);
      if (turn.status !== 'needs_input') {
        throw new RepositoryError('SESSION_STATE_INVALID', '待确认问题不属于可恢复的 Turn。');
      }
      const now = this.now();
      this.db
        .prepare(
          `INSERT INTO messages
           (id, session_id, turn_id, role, content, source_refs_json, result_refs_json, created_at)
           VALUES (?, ?, ?, 'user', ?, '[]', '[]', ?)`,
        )
        .run(randomUUID(), input.sessionId, turn.id, input.content, now);
      this.db
        .prepare("UPDATE turns SET status = 'queued', finished_at = NULL WHERE id = ?")
        .run(turn.id);
      this.db
        .prepare(
          `UPDATE skill_jobs
           SET status = 'queued',
               metadata_json = json_patch(metadata_json, ?)
           WHERE turn_id = ? AND status = 'needs_input'`,
        )
        .run(
          JSON.stringify({
            stage: 'queued',
            progress: { completed: 0, total: 1, unit: 'stage' },
          }),
          turn.id,
        );
      this.db
        .prepare("UPDATE sessions SET status = 'running', updated_at = ? WHERE id = ?")
        .run(now, input.sessionId);
      this.db
        .prepare(
          'INSERT INTO idempotency_records(scope,key,request_hash,response_json,created_at) VALUES (?,?,?,?,?)',
        )
        .run(scope, input.idempotencyKey, requestHash, JSON.stringify({ turn_id: turn.id }), now);
      return { turn: this.requireTurn(turn.id), replayed: false };
    });
  }

  startTurn(turnId: string): { turn: TurnRow; event: SseEvent } {
    return this.transaction(() => {
      const turn = this.requireTurn(turnId);
      if (turn.status !== 'queued') {
        throw new RepositoryError('SESSION_STATE_INVALID', 'Turn 不处于排队状态。');
      }
      const session = this.requireSession(turn.sessionId);
      const now = this.now();
      this.db
        .prepare(
          "UPDATE turns SET status = 'running', started_at = COALESCE(started_at, ?), finished_at = NULL WHERE id = ?",
        )
        .run(now, turnId);
      const event = this.insertEvent({
        protocol_version: SSE_PROTOCOL_VERSION,
        session_id: turn.sessionId,
        turn_id: turnId,
        type: 'turn.started',
        data: { model: session.model, reasoning_level: session.reasoning },
      });
      return { turn: this.requireTurn(turnId), event };
    });
  }

  persistThreadId(sessionId: string, threadId: string): void {
    this.transaction(() => {
      const session = this.requireSession(sessionId);
      if (session.threadId && session.threadId !== threadId) {
        throw new RepositoryError('RESOURCE_CONFLICT', '会话已绑定另一个 Codex thread。');
      }
      this.db
        .prepare('UPDATE sessions SET thread_id = ?, updated_at = ? WHERE id = ?')
        .run(threadId, this.now(), sessionId);
    });
  }

  appendEvent(event: PersistableEvent): SseEvent {
    return this.transaction(() => this.insertEvent(event));
  }

  persistExecutionPlan(turnId: string, plan: ExecutionPlan): SseEvent | null {
    const validated = ExecutionPlanSchema.parse(plan);
    return this.transaction(() => {
      const turn = this.requireTurn(turnId);
      if (turn.executionPlan) {
        if (JSON.stringify(turn.executionPlan) !== JSON.stringify(validated)) {
          throw new RepositoryError('RESOURCE_CONFLICT', '同一 Turn 收到了不同的 execution.plan。');
        }
        return null;
      }
      if (turn.status !== 'running') {
        throw new RepositoryError(
          'SESSION_STATE_INVALID',
          'execution.plan 只能在运行中的 Turn 中声明。',
        );
      }
      this.db
        .prepare('UPDATE turns SET execution_plan_json = ? WHERE id = ?')
        .run(JSON.stringify(validated), turn.id);
      return this.insertEvent({
        protocol_version: SSE_PROTOCOL_VERSION,
        session_id: turn.sessionId,
        turn_id: turn.id,
        type: 'execution.plan',
        data: { plan: validated },
      });
    });
  }

  finishTurn(input: {
    turnId: string;
    status: 'completed' | 'partial';
    message: string;
    resultRefs: ArtifactRef[];
    durationMs: number;
    usage?: { input_tokens: number; cached_input_tokens: number; output_tokens: number };
  }): SseEvent[] {
    return this.transaction(() => {
      const turn = this.requireTurn(input.turnId);
      if (turn.status !== 'running') {
        if (TERMINAL_TURNS.has(turn.status)) return [];
        throw new RepositoryError('SESSION_STATE_INVALID', 'Turn 无法完成。');
      }
      this.assertArtifactsOwned(turn.sessionId, input.resultRefs);
      const now = this.now();
      const messageId = randomUUID();
      this.db
        .prepare(
          `INSERT INTO messages
           (id, session_id, turn_id, role, content, source_refs_json, result_refs_json, created_at)
           VALUES (?, ?, ?, 'assistant', ?, '[]', ?, ?)`,
        )
        .run(
          messageId,
          turn.sessionId,
          turn.id,
          input.message,
          JSON.stringify(input.resultRefs),
          now,
        );
      this.db
        .prepare('UPDATE turns SET status = ?, finished_at = ?, result_refs_json = ? WHERE id = ?')
        .run(input.status, now, JSON.stringify(input.resultRefs), turn.id);
      this.db
        .prepare("UPDATE sessions SET status = 'idle', updated_at = ? WHERE id = ?")
        .run(now, turn.sessionId);
      const reconciled = this.reconcileOpenActivities(turn, 'completed');
      const assistant = this.insertEvent({
        protocol_version: SSE_PROTOCOL_VERSION,
        session_id: turn.sessionId,
        turn_id: turn.id,
        type: 'assistant.message',
        data: { message_id: messageId, content: input.message, result_refs: input.resultRefs },
      });
      const terminal = this.insertEvent({
        protocol_version: SSE_PROTOCOL_VERSION,
        session_id: turn.sessionId,
        turn_id: turn.id,
        type: input.status === 'completed' ? 'turn.completed' : 'turn.partial',
        data: {
          message: input.message,
          result_refs: input.resultRefs,
          duration_ms: input.durationMs,
          ...(input.usage ? { usage: input.usage } : {}),
        },
      } as PersistableEvent);
      return [...reconciled, assistant, terminal];
    });
  }

  requireInput(input: { turnId: string; message?: string; questions: Question[] }): SseEvent[] {
    return this.transaction(() => {
      const turn = this.requireTurn(input.turnId);
      if (turn.status !== 'running') {
        throw new RepositoryError('SESSION_STATE_INVALID', 'Turn 无法进入待确认状态。');
      }
      const now = this.now();
      const questionSetId = randomUUID();
      this.db
        .prepare(
          `INSERT INTO question_sets
           (id, session_id, turn_id, schema_json, draft_json, status, created_at)
           VALUES (?, ?, ?, ?, NULL, 'pending', ?)`,
        )
        .run(questionSetId, turn.sessionId, turn.id, JSON.stringify(input.questions), now);
      this.db
        .prepare("UPDATE turns SET status = 'needs_input', finished_at = ? WHERE id = ?")
        .run(now, turn.id);
      this.db
        .prepare("UPDATE sessions SET status = 'needs_input', updated_at = ? WHERE id = ?")
        .run(now, turn.sessionId);
      const events: SseEvent[] = this.reconcileOpenActivities(turn, 'completed');
      if (input.message) {
        const messageId = randomUUID();
        this.db
          .prepare(
            `INSERT INTO messages
             (id, session_id, turn_id, role, content, source_refs_json, result_refs_json, created_at)
             VALUES (?, ?, ?, 'assistant', ?, '[]', '[]', ?)`,
          )
          .run(messageId, turn.sessionId, turn.id, input.message, now);
        events.push(
          this.insertEvent({
            protocol_version: SSE_PROTOCOL_VERSION,
            session_id: turn.sessionId,
            turn_id: turn.id,
            type: 'assistant.message',
            data: { message_id: messageId, content: input.message, result_refs: [] },
          }),
        );
      }
      events.push(
        this.insertEvent({
          protocol_version: SSE_PROTOCOL_VERSION,
          session_id: turn.sessionId,
          turn_id: turn.id,
          type: 'input.required',
          data: { question_set_id: questionSetId, questions: input.questions },
        }),
      );
      return events;
    });
  }

  markCancelling(turnId: string): TurnRow {
    return this.transaction(() => {
      const turn = this.requireTurn(turnId);
      if (turn.status === 'cancelled') return turn;
      if (!ACTIVE_TURNS.has(turn.status)) {
        throw new RepositoryError('SESSION_STATE_INVALID', '当前 Turn 不可取消。');
      }
      this.db.prepare("UPDATE turns SET status = 'cancelling' WHERE id = ?").run(turn.id);
      return this.requireTurn(turn.id);
    });
  }

  markCancelled(turnId: string, reason?: string): SseEvent[] {
    return this.transaction(() => {
      const turn = this.requireTurn(turnId);
      if (turn.status === 'cancelled') return [];
      if (turn.status !== 'cancelling' && turn.status !== 'running' && turn.status !== 'queued') {
        throw new RepositoryError('SESSION_STATE_INVALID', 'Turn 不可标记为已取消。');
      }
      const now = this.now();
      this.db
        .prepare("UPDATE turns SET status = 'cancelled', finished_at = ? WHERE id = ?")
        .run(now, turn.id);
      this.db
        .prepare(
          "UPDATE skill_jobs SET status = 'cancelled' WHERE turn_id = ? AND status IN ('queued','running','cancelling')",
        )
        .run(turn.id);
      this.db
        .prepare("UPDATE sessions SET status = 'idle', updated_at = ? WHERE id = ?")
        .run(now, turn.sessionId);
      return [
        ...this.reconcileOpenActivities(turn, 'failed'),
        ...this.reconcileTerminalSkillActivities(turn, 'cancelled', 'completed', '已停止'),
        this.insertEvent({
          protocol_version: SSE_PROTOCOL_VERSION,
          session_id: turn.sessionId,
          turn_id: turn.id,
          type: 'turn.cancelled',
          data: { ...(reason ? { reason } : {}) },
        }),
      ];
    });
  }

  failTurn(turnId: string, problem: ProblemDetails): SseEvent[] {
    return this.endUnsuccessful(turnId, 'failed', problem);
  }

  interruptTurn(turnId: string, problem: ProblemDetails): SseEvent[] {
    return this.endUnsuccessful(turnId, 'interrupted', problem);
  }

  activeTurns(): TurnRow[] {
    return (
      this.db
        .prepare(
          "SELECT * FROM turns WHERE status IN ('queued','running','cancelling') ORDER BY created_at",
        )
        .all() as Row[]
    ).map((row) => this.mapTurn(row));
  }

  findActiveTurn(sessionId: string): TurnRow | null {
    const row = this.db
      .prepare(
        "SELECT * FROM turns WHERE session_id = ? AND status IN ('queued','running','cancelling') ORDER BY created_at DESC LIMIT 1",
      )
      .get(sessionId) as Row | undefined;
    return row ? this.mapTurn(row) : null;
  }

  requireTurn(turnId: string): TurnRow {
    const row = this.db.prepare('SELECT * FROM turns WHERE id = ?').get(turnId) as Row | undefined;
    if (!row) throw new RepositoryError('RESOURCE_NOT_FOUND', 'Turn 不存在。');
    return this.mapTurn(row);
  }

  requireSessionTurn(sessionId: string, turnId: string): TurnRow {
    const row = this.db
      .prepare('SELECT * FROM turns WHERE id = ? AND session_id = ?')
      .get(turnId, sessionId) as Row | undefined;
    if (!row) throw new RepositoryError('RESOURCE_NOT_FOUND', 'Turn 不存在。');
    return this.mapTurn(row);
  }

  messages(sessionId: string): Array<Record<string, unknown>> {
    return (
      this.db
        .prepare('SELECT * FROM messages WHERE session_id = ? ORDER BY created_at, rowid')
        .all(sessionId) as Row[]
    ).map((row) => ({
      message_id: String(row.id),
      turn_id: String(row.turn_id),
      role: String(row.role),
      content: String(row.content),
      source_refs: parseJson<string[]>(row.source_refs_json, []),
      result_refs: parseJson<ArtifactRef[]>(row.result_refs_json, []),
      created_at: String(row.created_at),
    }));
  }

  sourceRefsForTurn(sessionId: string, turnId: string): string[] {
    this.requireSessionTurn(sessionId, turnId);
    const rows = this.db
      .prepare(
        "SELECT source_refs_json FROM messages WHERE session_id = ? AND turn_id = ? AND role = 'user' ORDER BY created_at, rowid",
      )
      .all(sessionId, turnId) as Row[];
    for (const row of rows) {
      const sourceRefs = parseJson<string[]>(row.source_refs_json, []);
      if (sourceRefs.length > 0) return sourceRefs;
    }
    return [];
  }

  turns(sessionId: string): TurnRow[] {
    return (
      this.db
        .prepare('SELECT * FROM turns WHERE session_id = ? ORDER BY created_at, rowid')
        .all(sessionId) as Row[]
    ).map((row) => this.mapTurn(row));
  }

  pendingQuestionSet(sessionId: string): Record<string, unknown> | null {
    const row = this.db
      .prepare(
        "SELECT * FROM question_sets WHERE session_id = ? AND status = 'pending' ORDER BY created_at DESC LIMIT 1",
      )
      .get(sessionId) as Row | undefined;
    if (!row) return null;
    return {
      question_set_id: String(row.id),
      turn_id: String(row.turn_id),
      status: 'pending',
      questions: parseJson<Question[]>(row.schema_json, []),
      draft_answers: parseJson<QuestionAnswer[]>(row.draft_json, []),
      created_at: String(row.created_at),
    };
  }

  updateQuestionDraft(
    sessionId: string,
    questionSetId: string,
    answers: Array<{ question_id: string; answer: string }>,
  ): Record<string, unknown> {
    return this.transaction(() => {
      this.assertSessionWritable(sessionId);
      const row = this.db
        .prepare(
          "SELECT * FROM question_sets WHERE id = ? AND session_id = ? AND status = 'pending'",
        )
        .get(questionSetId, sessionId) as Row | undefined;
      if (!row) throw new RepositoryError('SESSION_STATE_INVALID', '待确认问题不存在或已回答。');
      const questions = parseJson<Question[]>(row.schema_json, []);
      if (
        answers.some((answer) => !questions.some((question) => question.id === answer.question_id))
      ) {
        throw new RepositoryError('SESSION_STATE_INVALID', '草稿包含未知问题。');
      }
      this.db
        .prepare('UPDATE question_sets SET draft_json = ? WHERE id = ?')
        .run(JSON.stringify(answers), questionSetId);
      return {
        question_set_id: questionSetId,
        turn_id: String(row.turn_id),
        status: 'pending',
        questions,
        draft_answers: answers,
        created_at: String(row.created_at),
      };
    });
  }

  eventsAfter(sessionId: string, afterEventId = 0, limit = 1_000): SseEvent[] {
    return (
      this.db
        .prepare(
          'SELECT * FROM events WHERE session_id = ? AND event_id > ? ORDER BY event_id LIMIT ?',
        )
        .all(sessionId, afterEventId, limit) as Row[]
    ).map((row) => this.mapEvent(row));
  }

  lastEventId(sessionId: string): string | null {
    const row = this.db
      .prepare('SELECT MAX(event_id) AS event_id FROM events WHERE session_id = ?')
      .get(sessionId) as Row;
    return row.event_id === null ? null : String(row.event_id);
  }

  registerUploads(
    rows: UploadRow[],
    idempotency?: { scope: string; key: string; requestHash: string },
  ): { rows: UploadRow[]; replayed: boolean } {
    return this.transaction(() => {
      if (idempotency) {
        const replay = this.getIdempotency<UploadRow[]>(
          idempotency.scope,
          idempotency.key,
          idempotency.requestHash,
        );
        if (replay) return { rows: replay, replayed: true };
      }
      const insert = this.db.prepare(
        `INSERT INTO uploads
         (id, session_id, source_ref, original_name, relative_path, size, sha256, media_type, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      );
      for (const row of rows) {
        this.assertSessionWritable(row.sessionId);
        insert.run(
          row.id,
          row.sessionId,
          row.sourceRef,
          row.originalName,
          row.relativePath,
          row.size,
          row.sha256,
          row.mediaType,
          row.createdAt,
        );
      }
      if (idempotency) {
        this.db
          .prepare(
            'INSERT INTO idempotency_records(scope,key,request_hash,response_json,created_at) VALUES (?,?,?,?,?)',
          )
          .run(
            idempotency.scope,
            idempotency.key,
            idempotency.requestHash,
            JSON.stringify(rows),
            this.now(),
          );
      }
      return { rows, replayed: false };
    });
  }

  uploadsByRefs(sessionId: string, refs: string[]): UploadRow[] {
    if (refs.length === 0) return [];
    this.assertSourcesOwned(sessionId, refs);
    const placeholders = refs.map(() => '?').join(',');
    const rows = this.db
      .prepare(`SELECT * FROM uploads WHERE session_id = ? AND source_ref IN (${placeholders})`)
      .all(sessionId, ...refs) as Row[];
    const mapped = rows.map((row) => this.mapUpload(row));
    return refs.map((ref) => mapped.find((row) => row.sourceRef === ref)!);
  }

  uploads(sessionId: string): UploadRow[] {
    return (
      this.db
        .prepare('SELECT * FROM uploads WHERE session_id = ? ORDER BY created_at, rowid')
        .all(sessionId) as Row[]
    ).map((row) => this.mapUpload(row));
  }

  registerArtifact(row: ArtifactRow): void {
    this.transaction(() => {
      this.requireTurn(row.turnId);
      const existing = this.db.prepare('SELECT * FROM artifacts WHERE id = ?').get(row.id) as
        Row | undefined;
      if (existing) {
        if (
          String(existing.sha256) !== row.sha256 ||
          String(existing.session_id) !== row.sessionId
        ) {
          throw new RepositoryError('RESOURCE_CONFLICT', 'Artifact ID 已对应不同内容。');
        }
        return;
      }
      this.db
        .prepare(
          `INSERT INTO artifacts
           (id, session_id, turn_id, manifest_path, type, status, sha256, manifest_json, integrity_error, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          row.id,
          row.sessionId,
          row.turnId,
          row.manifestPath,
          row.type,
          row.status,
          row.sha256,
          row.manifestJson,
          row.integrityError,
          row.createdAt,
        );
    });
  }

  /**
   * Persist a real Artifact reference as soon as its manifest has passed
   * verification.  The final assistant envelope may arrive later, but the
   * turn and session APIs can already expose this authoritative result.
   */
  attachResultRef(turnId: string, ref: ArtifactRef): void {
    this.transaction(() => {
      const turn = this.requireTurn(turnId);
      this.assertArtifactsOwned(turn.sessionId, [ref]);
      const refs = turn.resultRefs.some(
        (existing) =>
          existing.artifact_id === ref.artifact_id &&
          existing.artifact_type === ref.artifact_type &&
          existing.status === ref.status &&
          existing.manifest_url === ref.manifest_url,
      )
        ? turn.resultRefs
        : [...turn.resultRefs, ref];
      this.db.prepare('UPDATE turns SET result_refs_json = ? WHERE id = ?').run(
        JSON.stringify(refs),
        turn.id,
      );
    });
  }

  /**
   * A deterministic, metadata-only signal used by the runtime watchdog.
   * Skill payloads are retained only as their already-redacted metadata and
   * no file contents are read here.
   */
  progressFingerprint(turnId: string): string {
    const turn = this.requireTurn(turnId);
    const jobs = this.skillJobsForTurn(turnId)
      .sort((left, right) => left.externalJobId.localeCompare(right.externalJobId))
      .map((job) => ({
        skill_name: job.skillName,
        job_id: job.externalJobId,
        status: job.status,
        metadata: job.metadata,
      }));
    const artifacts = this.artifacts(turn.sessionId, turnId)
      .sort((left, right) => left.id.localeCompare(right.id))
      .map((artifact) => ({
        artifact_id: artifact.id,
        status: artifact.status,
        sha256: artifact.sha256,
        integrity_error: artifact.integrityError,
      }));
    return hashJson({
      execution_plan: turn.executionPlan,
      result_refs: turn.resultRefs,
      jobs,
      artifacts,
    });
  }

  artifact(id: string): ArtifactRow {
    const row = this.db.prepare('SELECT * FROM artifacts WHERE id = ?').get(id) as Row | undefined;
    if (!row) throw new RepositoryError('RESOURCE_NOT_FOUND', 'Artifact 不存在。');
    return this.mapArtifact(row);
  }

  artifacts(sessionId: string, turnId?: string): ArtifactRow[] {
    const rows = turnId
      ? (this.db
          .prepare(
            'SELECT * FROM artifacts WHERE session_id = ? AND turn_id = ? ORDER BY created_at',
          )
          .all(sessionId, turnId) as Row[])
      : (this.db
          .prepare('SELECT * FROM artifacts WHERE session_id = ? ORDER BY created_at')
          .all(sessionId) as Row[]);
    return rows.map((row) => this.mapArtifact(row));
  }

  markArtifactIntegrityError(id: string, error: string): void {
    this.db.prepare('UPDATE artifacts SET integrity_error = ? WHERE id = ?').run(error, id);
  }

  upsertSkillJob(input: SkillJobRow): void {
    this.db
      .prepare(
        `INSERT INTO skill_jobs
         (id, session_id, turn_id, skill_name, external_job_id, status, metadata_json)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(session_id, skill_name, external_job_id) DO UPDATE SET
           status = CASE
             WHEN skill_jobs.status IN ('succeeded','partial','failed','cancelled','interrupted')
               THEN skill_jobs.status
             ELSE excluded.status
           END,
           metadata_json = json_patch(skill_jobs.metadata_json, excluded.metadata_json)`,
      )
      .run(
        input.id,
        input.sessionId,
        input.turnId,
        input.skillName,
        input.externalJobId,
        input.status,
        JSON.stringify(input.metadata),
      );
  }

  skillJobsForTurn(turnId: string): SkillJobRow[] {
    return (this.db.prepare('SELECT * FROM skill_jobs WHERE turn_id = ?').all(turnId) as Row[]).map(
      (row) => ({
        id: String(row.id),
        sessionId: String(row.session_id),
        turnId: String(row.turn_id),
        skillName: String(row.skill_name),
        externalJobId: String(row.external_job_id),
        status: String(row.status),
        metadata: parseJson<Record<string, unknown>>(row.metadata_json, {}),
      }),
    );
  }

  skillJobsForSession(sessionId: string): SkillJobRow[] {
    return (
      this.db.prepare('SELECT * FROM skill_jobs WHERE session_id = ?').all(sessionId) as Row[]
    ).map((row) => ({
      id: String(row.id),
      sessionId: String(row.session_id),
      turnId: String(row.turn_id),
      skillName: String(row.skill_name),
      externalJobId: String(row.external_job_id),
      status: String(row.status),
      metadata: parseJson<Record<string, unknown>>(row.metadata_json, {}),
    }));
  }

  markSessionDeleting(sessionId: string): void {
    this.transaction(() => {
      this.requireSession(sessionId);
      this.db
        .prepare("UPDATE sessions SET status = 'deleting', updated_at = ? WHERE id = ?")
        .run(this.now(), sessionId);
    });
  }

  deleteSession(sessionId: string): void {
    this.transaction(() => {
      const result = this.db.prepare('DELETE FROM sessions WHERE id = ?').run(sessionId);
      if (result.changes !== 1) throw new RepositoryError('RESOURCE_NOT_FOUND', '会话不存在。');
    });
  }

  rollbackSessionCreate(sessionId: string, idempotencyKey?: string): void {
    this.transaction(() => {
      if (idempotencyKey) {
        this.db
          .prepare("DELETE FROM idempotency_records WHERE scope = 'create-session' AND key = ?")
          .run(idempotencyKey);
      }
      this.db.prepare('DELETE FROM sessions WHERE id = ?').run(sessionId);
    });
  }

  getIdempotency<T>(scope: string, key: string, requestHash: string): T | null {
    const row = this.db
      .prepare(
        'SELECT request_hash, response_json FROM idempotency_records WHERE scope = ? AND key = ?',
      )
      .get(scope, key) as Row | undefined;
    if (!row) return null;
    if (String(row.request_hash) !== requestHash) {
      throw new RepositoryError('IDEMPOTENCY_CONFLICT', '幂等键已用于不同请求。');
    }
    return parseJson<T>(row.response_json, null as T);
  }

  recordIdempotency<T>(scope: string, key: string, requestHash: string, response: T): void {
    this.transaction(() => {
      const existing = this.getIdempotency<T>(scope, key, requestHash);
      if (existing !== null) return;
      this.db
        .prepare(
          'INSERT INTO idempotency_records(scope,key,request_hash,response_json,created_at) VALUES (?,?,?,?,?)',
        )
        .run(scope, key, requestHash, JSON.stringify(response), this.now());
    });
  }

  sessionResource(session: SessionRow): SessionResource {
    const active = this.findActiveTurn(session.id);
    return {
      session_id: session.id,
      title: session.title,
      status: session.status,
      model: session.model,
      reasoning_level: session.reasoning,
      model_locked: session.modelLocked,
      archived: session.archived,
      ...(active ? { active_turn_id: active.id } : {}),
      created_at: session.createdAt,
      updated_at: session.updatedAt,
    };
  }

  turnResource(turn: TurnRow): TurnResource {
    return {
      turn_id: turn.id,
      status: turn.status,
      ...(turn.startedAt ? { started_at: turn.startedAt } : {}),
      ...(turn.finishedAt ? { finished_at: turn.finishedAt } : {}),
      result_refs: turn.resultRefs,
      ...(turn.executionPlan ? { execution_plan: turn.executionPlan } : {}),
      ...(turn.error ? { problem: turn.error } : {}),
    };
  }

  private migration1(): void {
    this.db.exec(`
      CREATE TABLE sessions (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        thread_id TEXT UNIQUE,
        model TEXT NOT NULL,
        reasoning TEXT NOT NULL,
        status TEXT NOT NULL CHECK(status IN ('empty','idle','running','needs_input','deleting')),
        workspace TEXT NOT NULL UNIQUE,
        model_locked INTEGER NOT NULL DEFAULT 0 CHECK(model_locked IN (0,1)),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE turns (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
        idempotency_key TEXT NOT NULL,
        request_hash TEXT NOT NULL,
        status TEXT NOT NULL CHECK(status IN ('queued','running','needs_input','completed','partial','failed','cancelling','cancelled','interrupted')),
        started_at TEXT,
        finished_at TEXT,
        error_json TEXT,
        result_refs_json TEXT NOT NULL DEFAULT '[]',
        created_at TEXT NOT NULL,
        UNIQUE(session_id, idempotency_key)
      );
      CREATE UNIQUE INDEX one_active_turn_per_session
        ON turns(session_id) WHERE status IN ('queued','running','cancelling');
      CREATE TABLE messages (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
        turn_id TEXT NOT NULL REFERENCES turns(id) ON DELETE CASCADE,
        role TEXT NOT NULL CHECK(role IN ('user','assistant')),
        content TEXT NOT NULL,
        source_refs_json TEXT NOT NULL DEFAULT '[]',
        result_refs_json TEXT NOT NULL DEFAULT '[]',
        created_at TEXT NOT NULL
      );
      CREATE TABLE question_sets (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
        turn_id TEXT NOT NULL REFERENCES turns(id) ON DELETE CASCADE,
        schema_json TEXT NOT NULL,
        draft_json TEXT,
        status TEXT NOT NULL CHECK(status IN ('pending','answered')),
        created_at TEXT NOT NULL,
        answered_at TEXT
      );
      CREATE UNIQUE INDEX one_pending_question_set_per_session
        ON question_sets(session_id) WHERE status = 'pending';
      CREATE TABLE events (
        session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
        event_id INTEGER NOT NULL,
        turn_id TEXT NOT NULL REFERENCES turns(id) ON DELETE CASCADE,
        type TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        PRIMARY KEY(session_id, event_id)
      );
      CREATE TABLE uploads (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
        source_ref TEXT NOT NULL UNIQUE,
        original_name TEXT NOT NULL,
        relative_path TEXT NOT NULL,
        size INTEGER NOT NULL CHECK(size >= 0),
        sha256 TEXT NOT NULL,
        media_type TEXT NOT NULL,
        created_at TEXT NOT NULL,
        UNIQUE(session_id, relative_path)
      );
      CREATE TABLE skill_jobs (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
        turn_id TEXT NOT NULL REFERENCES turns(id) ON DELETE CASCADE,
        skill_name TEXT NOT NULL,
        external_job_id TEXT NOT NULL,
        status TEXT NOT NULL,
        metadata_json TEXT NOT NULL DEFAULT '{}',
        UNIQUE(session_id, skill_name, external_job_id)
      );
      CREATE TABLE artifacts (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
        turn_id TEXT NOT NULL REFERENCES turns(id) ON DELETE CASCADE,
        manifest_path TEXT NOT NULL,
        type TEXT NOT NULL,
        status TEXT NOT NULL CHECK(status IN ('succeeded','partial')),
        sha256 TEXT NOT NULL,
        manifest_json TEXT NOT NULL,
        integrity_error TEXT,
        created_at TEXT NOT NULL,
        UNIQUE(session_id, manifest_path)
      );
      CREATE TABLE idempotency_records (
        scope TEXT NOT NULL,
        key TEXT NOT NULL,
        request_hash TEXT NOT NULL,
        response_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        PRIMARY KEY(scope, key)
      );
      CREATE TRIGGER terminal_turn_status_is_irreversible
        BEFORE UPDATE OF status ON turns
        WHEN OLD.status IN ('completed','partial','failed','cancelled','interrupted') AND NEW.status <> OLD.status
        BEGIN SELECT RAISE(ABORT, 'terminal turn status is irreversible'); END;
      CREATE TRIGGER terminal_skill_job_status_is_irreversible
        BEFORE UPDATE OF status ON skill_jobs
        WHEN OLD.status IN ('succeeded','partial','failed','cancelled','interrupted') AND NEW.status <> OLD.status
        BEGIN SELECT RAISE(ABORT, 'terminal skill job status is irreversible'); END;
      INSERT INTO schema_migrations(version, applied_at) VALUES (1, '${this.now()}');
    `);
  }

  private migration2(): void {
    this.db.exec(`
      ALTER TABLE sessions ADD COLUMN archived INTEGER NOT NULL DEFAULT 0 CHECK(archived IN (0,1));
      CREATE INDEX sessions_by_archived_updated_at ON sessions(archived, updated_at DESC, id DESC);
      INSERT INTO schema_migrations(version, applied_at) VALUES (2, '${this.now()}');
    `);
  }

  private migration3(): void {
    const turnsTable = this.db
      .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'turns'")
      .get();
    if (!turnsTable) return;
    this.db.exec(`
      ALTER TABLE turns ADD COLUMN execution_plan_json TEXT;
      INSERT INTO schema_migrations(version, applied_at) VALUES (3, '${this.now()}');
    `);
  }

  private consumeQuestionSet(
    sessionId: string,
    questionSetId: string,
    answers: QuestionAnswer[],
  ): string {
    const row = this.db
      .prepare("SELECT * FROM question_sets WHERE id = ? AND session_id = ? AND status = 'pending'")
      .get(questionSetId, sessionId) as Row | undefined;
    if (!row) throw new RepositoryError('SESSION_STATE_INVALID', '待确认问题不存在或已回答。');
    const questions = parseJson<Question[]>(row.schema_json, []);
    const answerMap = new Map(answers.map((answer) => [answer.question_id, answer.answer]));
    if (questions.some((question) => question.required && !answerMap.has(question.id))) {
      throw new RepositoryError('SESSION_STATE_INVALID', '请回答全部必答问题。');
    }
    for (const answer of answers) {
      const question = questions.find((candidate) => candidate.id === answer.question_id);
      if (!question) throw new RepositoryError('SESSION_STATE_INVALID', '回答包含未知问题。');
      if (!question.allow_free_text && !question.options.includes(answer.answer)) {
        throw new RepositoryError('SESSION_STATE_INVALID', '回答不属于允许选项。');
      }
    }
    this.db
      .prepare(
        "UPDATE question_sets SET status = 'answered', draft_json = ?, answered_at = ? WHERE id = ?",
      )
      .run(JSON.stringify(answers), this.now(), questionSetId);
    return String(row.turn_id);
  }

  private assertSourcesOwned(sessionId: string, refs: string[]): void {
    if (new Set(refs).size !== refs.length) {
      throw new RepositoryError('SOURCE_REFERENCE_INVALID', '上传引用不可重复。');
    }
    if (refs.length === 0) return;
    const placeholders = refs.map(() => '?').join(',');
    const row = this.db
      .prepare(
        `SELECT COUNT(*) AS count FROM uploads WHERE session_id = ? AND source_ref IN (${placeholders})`,
      )
      .get(sessionId, ...refs) as Row;
    if (Number(row.count) !== refs.length) {
      throw new RepositoryError('SOURCE_REFERENCE_INVALID', '上传引用不存在或不属于当前会话。');
    }
  }

  private assertArtifactsOwned(sessionId: string, refs: ArtifactRef[]): void {
    for (const ref of refs) {
      const row = this.db
        .prepare('SELECT * FROM artifacts WHERE id = ? AND session_id = ?')
        .get(ref.artifact_id, sessionId) as Row | undefined;
      const expectedUrl = `/api/v1/sessions/${encodeURIComponent(sessionId)}/artifacts?turn_id=${encodeURIComponent(String(row?.turn_id ?? ''))}`;
      if (
        !row ||
        row.integrity_error ||
        String(row.type) !== ref.artifact_type ||
        String(row.status) !== ref.status ||
        ref.manifest_url !== expectedUrl
      ) {
        throw new RepositoryError('RESOURCE_CONFLICT', '结果引用未登记或完整性校验失败。');
      }
    }
  }

  private insertEvent(event: PersistableEvent): SseEvent {
    const row = this.db
      .prepare('SELECT COALESCE(MAX(event_id), 0) + 1 AS next_id FROM events WHERE session_id = ?')
      .get(event.session_id) as Row;
    const eventId = Number(row.next_id);
    const occurredAt = this.now();
    this.db
      .prepare(
        'INSERT INTO events(session_id,event_id,turn_id,type,payload_json,created_at) VALUES (?,?,?,?,?,?)',
      )
      .run(
        event.session_id,
        eventId,
        event.turn_id,
        event.type,
        JSON.stringify(event.data),
        occurredAt,
      );
    return {
      ...event,
      event_id: String(eventId),
      occurred_at: occurredAt,
    } as SseEvent;
  }

  private endUnsuccessful(
    turnId: string,
    status: 'failed' | 'interrupted',
    problem: ProblemDetails,
  ): SseEvent[] {
    return this.transaction(() => {
      const turn = this.requireTurn(turnId);
      if (TERMINAL_TURNS.has(turn.status)) return [];
      const now = this.now();
      this.db
        .prepare('UPDATE turns SET status = ?, finished_at = ?, error_json = ? WHERE id = ?')
        .run(status, now, JSON.stringify(problem), turn.id);
      this.db
        .prepare("UPDATE sessions SET status = 'idle', updated_at = ? WHERE id = ?")
        .run(now, turn.sessionId);
      this.db
        .prepare(
          "UPDATE skill_jobs SET status = 'interrupted' WHERE turn_id = ? AND status IN ('queued','running','cancelling')",
        )
        .run(turn.id);
      return [
        ...this.reconcileOpenActivities(turn, 'failed'),
        ...this.reconcileTerminalSkillActivities(turn, 'interrupted', 'failed', '已中断'),
        this.insertEvent({
          protocol_version: SSE_PROTOCOL_VERSION,
          session_id: turn.sessionId,
          turn_id: turn.id,
          type: status === 'failed' ? 'turn.failed' : 'turn.interrupted',
          data: { problem },
        } as PersistableEvent),
      ];
    });
  }

  private reconcileOpenActivities(
    turn: TurnRow,
    terminalStatus: 'completed' | 'failed',
  ): SseEvent[] {
    const rows = this.db
      .prepare(
        "SELECT payload_json FROM events WHERE session_id = ? AND turn_id = ? AND type = 'agent.activity' ORDER BY event_id",
      )
      .all(turn.sessionId, turn.id) as Row[];
    const latest = new Map<string, Record<string, unknown>>();
    for (const row of rows) {
      const payload = parseJson<Record<string, unknown>>(row.payload_json, {});
      if (typeof payload.activity_id === 'string') latest.set(payload.activity_id, payload);
    }
    const events: SseEvent[] = [];
    for (const payload of latest.values()) {
      if (payload.status !== 'pending' && payload.status !== 'in_progress') continue;
      events.push(
        this.insertEvent({
          protocol_version: SSE_PROTOCOL_VERSION,
          session_id: turn.sessionId,
          turn_id: turn.id,
          type: 'agent.activity',
          data: { ...payload, status: terminalStatus },
        } as PersistableEvent),
      );
    }
    return events;
  }

  private reconcileTerminalSkillActivities(
    turn: TurnRow,
    jobStatus: 'cancelled' | 'interrupted',
    activityStatus: 'completed' | 'failed',
    summary: string,
  ): SseEvent[] {
    const rows = this.db
      .prepare(
        'SELECT external_job_id, skill_name FROM skill_jobs WHERE turn_id = ? AND status = ?',
      )
      .all(turn.id, jobStatus) as Row[];
    return rows.map((row) =>
      this.insertEvent({
        protocol_version: SSE_PROTOCOL_VERSION,
        session_id: turn.sessionId,
        turn_id: turn.id,
        type: 'agent.activity',
        data: {
          activity_id: `skill:${String(row.external_job_id)}`,
          kind: activityStatus === 'failed' ? 'warning' : 'info',
          status: activityStatus,
          summary: `${String(row.skill_name)} ${summary}`,
        },
      } as PersistableEvent),
    );
  }

  private mapSession(row: Row): SessionRow {
    return {
      id: String(row.id),
      title: String(row.title),
      threadId: row.thread_id === null ? null : String(row.thread_id),
      model: String(row.model),
      reasoning: String(row.reasoning) as ReasoningLevel,
      status: String(row.status) as SessionRow['status'],
      workspace: String(row.workspace),
      modelLocked: Number(row.model_locked) === 1,
      archived: Number(row.archived) === 1,
      createdAt: String(row.created_at),
      updatedAt: String(row.updated_at),
    };
  }

  private mapTurn(row: Row): TurnRow {
    return {
      id: String(row.id),
      sessionId: String(row.session_id),
      idempotencyKey: String(row.idempotency_key),
      requestHash: String(row.request_hash),
      status: String(row.status) as TurnResource['status'],
      startedAt: row.started_at === null ? null : String(row.started_at),
      finishedAt: row.finished_at === null ? null : String(row.finished_at),
      error: row.error_json ? parseJson<ProblemDetails | null>(row.error_json, null) : null,
      resultRefs: parseJson<ArtifactRef[]>(row.result_refs_json, []),
      executionPlan: row.execution_plan_json
        ? ExecutionPlanSchema.parse(parseJson<unknown>(row.execution_plan_json, null))
        : null,
      createdAt: String(row.created_at),
    };
  }

  private mapUpload(row: Row): UploadRow {
    return {
      id: String(row.id),
      sessionId: String(row.session_id),
      sourceRef: String(row.source_ref),
      originalName: String(row.original_name),
      relativePath: String(row.relative_path),
      size: Number(row.size),
      sha256: String(row.sha256),
      mediaType: String(row.media_type),
      createdAt: String(row.created_at),
    };
  }

  private mapArtifact(row: Row): ArtifactRow {
    return {
      id: String(row.id),
      sessionId: String(row.session_id),
      turnId: String(row.turn_id),
      manifestPath: String(row.manifest_path),
      type: String(row.type),
      status: String(row.status) as ArtifactRow['status'],
      sha256: String(row.sha256),
      manifestJson: String(row.manifest_json),
      integrityError: row.integrity_error === null ? null : String(row.integrity_error),
      createdAt: String(row.created_at),
    };
  }

  private mapEvent(row: Row): SseEvent {
    return {
      protocol_version: SSE_PROTOCOL_VERSION,
      event_id: String(row.event_id),
      session_id: String(row.session_id),
      turn_id: String(row.turn_id),
      occurred_at: String(row.created_at),
      type: String(row.type),
      data: parseJson<unknown>(row.payload_json, {}),
    } as SseEvent;
  }

  private now(): string {
    return this.clock().toISOString();
  }
}

export function hashJson(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

export function problem(
  code: ProblemDetails['code'],
  status: number,
  title: string,
  detail: string,
  correlationId: string,
  instance?: string,
): ProblemDetails {
  return {
    type: `https://building-energy.local/problems/${code.toLowerCase().replaceAll('_', '-')}`,
    title,
    status,
    detail,
    ...(instance ? { instance } : {}),
    code,
    correlation_id: correlationId,
  };
}

export const API_VERSION = PUBLIC_API_VERSION;

function parseJson<T>(value: unknown, fallback: T): T {
  if (typeof value !== 'string') return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}
