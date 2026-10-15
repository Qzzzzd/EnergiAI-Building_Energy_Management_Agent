// Generated from Zod via OpenAPI. Do not edit by hand.
export interface paths {
  '/api/v1/health': {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    get: operations['getHealth'];
    put?: never;
    post?: never;
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  '/api/v1/doctor': {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    get: operations['getDoctor'];
    put?: never;
    post?: never;
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  '/api/v1/models': {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    get: operations['listModels'];
    put?: never;
    post?: never;
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  '/api/v1/sessions': {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    get: operations['listSessions'];
    put?: never;
    post: operations['createSession'];
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  '/api/v1/sessions/{sessionId}': {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    get: operations['getSession'];
    put?: never;
    post?: never;
    delete: operations['deleteSession'];
    options?: never;
    head?: never;
    patch: operations['updateSession'];
    trace?: never;
  };
  '/api/v1/sessions/{sessionId}/question-sets/{questionSetId}/draft': {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    get?: never;
    put: operations['updateQuestionDraft'];
    post?: never;
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  '/api/v1/sessions/{sessionId}/uploads': {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    get?: never;
    put?: never;
    post: operations['uploadSources'];
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  '/api/v1/sessions/{sessionId}/messages': {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    get?: never;
    put?: never;
    post: operations['submitMessage'];
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  '/api/v1/sessions/{sessionId}/cancel': {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    get?: never;
    put?: never;
    post: operations['cancelTurn'];
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  '/api/v1/sessions/{sessionId}/events': {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    get: operations['streamSessionEvents'];
    put?: never;
    post?: never;
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  '/api/v1/sessions/{sessionId}/turns/{turnId}': {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    get: operations['getTurnResult'];
    put?: never;
    post?: never;
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  '/api/v1/sessions/{sessionId}/artifacts': {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    get: operations['listArtifacts'];
    put?: never;
    post?: never;
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  '/api/v1/artifacts/{artifactId}/content': {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    get: operations['downloadArtifactContent'];
    put?: never;
    post?: never;
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
}
export type webhooks = Record<string, never>;
export interface components {
  schemas: {
    ProblemDetails: {
      /** Format: uri */
      type: string;
      title: string;
      status: number;
      detail: string;
      instance?: string;
      /** @enum {string} */
      code:
        | 'VALIDATION_ERROR'
        | 'UNSUPPORTED_PROTOCOL_VERSION'
        | 'INCOMPATIBLE_PROTOCOL_VERSION'
        | 'RESOURCE_NOT_FOUND'
        | 'RESOURCE_CONFLICT'
        | 'IDEMPOTENCY_CONFLICT'
        | 'SESSION_BUSY'
        | 'SESSION_STATE_INVALID'
        | 'MODEL_NOT_ALLOWED'
        | 'MODEL_UNAVAILABLE'
        | 'MODEL_LOCKED'
        | 'UPLOAD_LIMIT_EXCEEDED'
        | 'UNSUPPORTED_MEDIA_TYPE'
        | 'SOURCE_REFERENCE_INVALID'
        | 'ARTIFACT_REFERENCE_INVALID'
        | 'ARTIFACT_INTEGRITY_FAILED'
        | 'SKILL_PROTOCOL_ERROR'
        | 'SKILL_ENV_NOT_READY'
        | 'DEPENDENCY_MISSING'
        | 'UNAUTHENTICATED'
        | 'CANCEL_FAILED'
        | 'TURN_FAILED'
        | 'TURN_INTERRUPTED'
        | 'INTERNAL_ERROR';
      correlation_id: string;
      invalid_params?: {
        name: string;
        reason: string;
      }[];
      recovery_actions?: {
        code: string;
        label: string;
        href?: string;
      }[];
    };
    Question: {
      id: string;
      question: string;
      options: string[];
      allow_free_text: boolean;
      required: boolean;
    };
    AgentTurnEnvelope:
      | {
          /** @enum {string} */
          status: 'completed';
          message: string;
          result_refs: {
            artifact_id: string;
            artifact_type: string;
            /** @enum {string} */
            status: 'succeeded' | 'partial';
            manifest_url: string;
          }[];
        }
      | {
          /** @enum {string} */
          status: 'partial';
          message: string;
          result_refs: {
            artifact_id: string;
            artifact_type: string;
            /** @enum {string} */
            status: 'succeeded' | 'partial';
            manifest_url: string;
          }[];
        }
      | {
          /** @enum {string} */
          status: 'needs_input';
          message?: string;
          questions: {
            id: string;
            question: string;
            options: string[];
            allow_free_text: boolean;
            required: boolean;
          }[];
        };
    ArtifactRef: {
      artifact_id: string;
      artifact_type: string;
      /** @enum {string} */
      status: 'succeeded' | 'partial';
      manifest_url: string;
    };
    ArtifactManifest: {
      /** @enum {string} */
      schema_version: '1.0';
      artifact_id: string;
      artifact_type: string;
      producer: {
        skill_name: string;
        job_id: string;
      };
      source_ids: string[];
      /** @enum {string} */
      status: 'succeeded' | 'partial';
      files: {
        relative_path: string;
        media_type: string;
        size_bytes: number;
        sha256: string;
        role: string;
      }[];
      summary: {
        [key: string]: unknown;
      };
      warnings: string[];
    };
    ArtifactResource: {
      /** @enum {string} */
      schema_version: '1.0';
      artifact_id: string;
      artifact_type: string;
      producer: {
        skill_name: string;
        job_id: string;
      };
      source_ids: string[];
      /** @enum {string} */
      status: 'succeeded' | 'partial';
      files: {
        name: string;
        media_type: string;
        size_bytes: number;
        sha256: string;
        role: string;
        content_url: string;
      }[];
      summary: {
        [key: string]: unknown;
      };
      warnings: string[];
    };
    SseEvent:
      | {
          /** @enum {string} */
          protocol_version: '1.0';
          event_id: string;
          session_id: string;
          turn_id: string;
          /** Format: date-time */
          occurred_at: string;
          /** @enum {string} */
          type: 'turn.started';
          data: {
            model: string;
            /** @enum {string} */
            reasoning_level: 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max' | 'ultra';
          };
        }
      | {
          /** @enum {string} */
          protocol_version: '1.0';
          event_id: string;
          session_id: string;
          turn_id: string;
          /** Format: date-time */
          occurred_at: string;
          /** @enum {string} */
          type: 'execution.plan';
          data: {
            plan: {
              plan_id: string;
              title?: string;
              nodes: {
                id: string;
                title: string;
                skill_name: string;
                depends_on: string[];
                parallel_group?: string;
              }[];
            };
          };
        }
      | {
          /** @enum {string} */
          protocol_version: '1.0';
          event_id: string;
          session_id: string;
          turn_id: string;
          /** Format: date-time */
          occurred_at: string;
          /** @enum {string} */
          type: 'plan.updated';
          data: {
            items: {
              id: string;
              step: string;
              /** @enum {string} */
              status: 'pending' | 'in_progress' | 'completed';
            }[];
          };
        }
      | {
          /** @enum {string} */
          protocol_version: '1.0';
          event_id: string;
          session_id: string;
          turn_id: string;
          /** Format: date-time */
          occurred_at: string;
          /** @enum {string} */
          type: 'agent.activity';
          data: {
            activity_id: string;
            /** @enum {string} */
            kind:
              | 'reasoning_summary'
              | 'command'
              | 'file'
              | 'tool'
              | 'web_search'
              | 'retry'
              | 'warning'
              | 'info';
            /** @enum {string} */
            status: 'pending' | 'in_progress' | 'completed' | 'failed';
            summary: string;
            detail?: string;
            duration_ms?: number;
          };
        }
      | {
          /** @enum {string} */
          protocol_version: '1.0';
          event_id: string;
          session_id: string;
          turn_id: string;
          /** Format: date-time */
          occurred_at: string;
          /** @enum {string} */
          type: 'skill.started';
          data: {
            skill_name: string;
            job_id: string;
            stage: string;
          };
        }
      | {
          /** @enum {string} */
          protocol_version: '1.0';
          event_id: string;
          session_id: string;
          turn_id: string;
          /** Format: date-time */
          occurred_at: string;
          /** @enum {string} */
          type: 'skill.progress';
          data: {
            skill_name: string;
            job_id: string;
            stage: string;
            progress: {
              completed: number;
              total: number;
              unit: string;
            };
            warnings: string[];
          };
        }
      | {
          /** @enum {string} */
          protocol_version: '1.0';
          event_id: string;
          session_id: string;
          turn_id: string;
          /** Format: date-time */
          occurred_at: string;
          /** @enum {string} */
          type: 'skill.completed';
          data: {
            skill_name: string;
            job_id: string;
            /** @enum {string} */
            status: 'succeeded' | 'partial';
            result_refs: {
              artifact_id: string;
              artifact_type: string;
              /** @enum {string} */
              status: 'succeeded' | 'partial';
              manifest_url: string;
            }[];
            warnings: string[];
          };
        }
      | {
          /** @enum {string} */
          protocol_version: '1.0';
          event_id: string;
          session_id: string;
          turn_id: string;
          /** Format: date-time */
          occurred_at: string;
          /** @enum {string} */
          type: 'input.required';
          data: {
            question_set_id: string;
            questions: {
              id: string;
              question: string;
              options: string[];
              allow_free_text: boolean;
              required: boolean;
            }[];
          };
        }
      | {
          /** @enum {string} */
          protocol_version: '1.0';
          event_id: string;
          session_id: string;
          turn_id: string;
          /** Format: date-time */
          occurred_at: string;
          /** @enum {string} */
          type: 'artifact.created';
          data: {
            artifact: {
              artifact_id: string;
              artifact_type: string;
              /** @enum {string} */
              status: 'succeeded' | 'partial';
              manifest_url: string;
            };
          };
        }
      | {
          /** @enum {string} */
          protocol_version: '1.0';
          event_id: string;
          session_id: string;
          turn_id: string;
          /** Format: date-time */
          occurred_at: string;
          /** @enum {string} */
          type: 'assistant.message';
          data: {
            message_id: string;
            content: string;
            result_refs: {
              artifact_id: string;
              artifact_type: string;
              /** @enum {string} */
              status: 'succeeded' | 'partial';
              manifest_url: string;
            }[];
          };
        }
      | {
          /** @enum {string} */
          protocol_version: '1.0';
          event_id: string;
          session_id: string;
          turn_id: string;
          /** Format: date-time */
          occurred_at: string;
          /** @enum {string} */
          type: 'turn.completed';
          data: {
            message: string;
            result_refs: {
              artifact_id: string;
              artifact_type: string;
              /** @enum {string} */
              status: 'succeeded' | 'partial';
              manifest_url: string;
            }[];
            duration_ms: number;
            usage?: {
              input_tokens: number;
              cached_input_tokens: number;
              output_tokens: number;
            };
          };
        }
      | {
          /** @enum {string} */
          protocol_version: '1.0';
          event_id: string;
          session_id: string;
          turn_id: string;
          /** Format: date-time */
          occurred_at: string;
          /** @enum {string} */
          type: 'turn.partial';
          data: {
            message: string;
            result_refs: {
              artifact_id: string;
              artifact_type: string;
              /** @enum {string} */
              status: 'succeeded' | 'partial';
              manifest_url: string;
            }[];
            duration_ms: number;
            usage?: {
              input_tokens: number;
              cached_input_tokens: number;
              output_tokens: number;
            };
          };
        }
      | {
          /** @enum {string} */
          protocol_version: '1.0';
          event_id: string;
          session_id: string;
          turn_id: string;
          /** Format: date-time */
          occurred_at: string;
          /** @enum {string} */
          type: 'turn.failed';
          data: {
            problem: {
              /** Format: uri */
              type: string;
              title: string;
              status: number;
              detail: string;
              instance?: string;
              /** @enum {string} */
              code:
                | 'VALIDATION_ERROR'
                | 'UNSUPPORTED_PROTOCOL_VERSION'
                | 'INCOMPATIBLE_PROTOCOL_VERSION'
                | 'RESOURCE_NOT_FOUND'
                | 'RESOURCE_CONFLICT'
                | 'IDEMPOTENCY_CONFLICT'
                | 'SESSION_BUSY'
                | 'SESSION_STATE_INVALID'
                | 'MODEL_NOT_ALLOWED'
                | 'MODEL_UNAVAILABLE'
                | 'MODEL_LOCKED'
                | 'UPLOAD_LIMIT_EXCEEDED'
                | 'UNSUPPORTED_MEDIA_TYPE'
                | 'SOURCE_REFERENCE_INVALID'
                | 'ARTIFACT_REFERENCE_INVALID'
                | 'ARTIFACT_INTEGRITY_FAILED'
                | 'SKILL_PROTOCOL_ERROR'
                | 'SKILL_ENV_NOT_READY'
                | 'DEPENDENCY_MISSING'
                | 'UNAUTHENTICATED'
                | 'CANCEL_FAILED'
                | 'TURN_FAILED'
                | 'TURN_INTERRUPTED'
                | 'INTERNAL_ERROR';
              correlation_id: string;
              invalid_params?: {
                name: string;
                reason: string;
              }[];
              recovery_actions?: {
                code: string;
                label: string;
                href?: string;
              }[];
            };
          };
        }
      | {
          /** @enum {string} */
          protocol_version: '1.0';
          event_id: string;
          session_id: string;
          turn_id: string;
          /** Format: date-time */
          occurred_at: string;
          /** @enum {string} */
          type: 'turn.cancelled';
          data: {
            reason?: string;
          };
        }
      | {
          /** @enum {string} */
          protocol_version: '1.0';
          event_id: string;
          session_id: string;
          turn_id: string;
          /** Format: date-time */
          occurred_at: string;
          /** @enum {string} */
          type: 'turn.interrupted';
          data: {
            problem: {
              /** Format: uri */
              type: string;
              title: string;
              status: number;
              detail: string;
              instance?: string;
              /** @enum {string} */
              code:
                | 'VALIDATION_ERROR'
                | 'UNSUPPORTED_PROTOCOL_VERSION'
                | 'INCOMPATIBLE_PROTOCOL_VERSION'
                | 'RESOURCE_NOT_FOUND'
                | 'RESOURCE_CONFLICT'
                | 'IDEMPOTENCY_CONFLICT'
                | 'SESSION_BUSY'
                | 'SESSION_STATE_INVALID'
                | 'MODEL_NOT_ALLOWED'
                | 'MODEL_UNAVAILABLE'
                | 'MODEL_LOCKED'
                | 'UPLOAD_LIMIT_EXCEEDED'
                | 'UNSUPPORTED_MEDIA_TYPE'
                | 'SOURCE_REFERENCE_INVALID'
                | 'ARTIFACT_REFERENCE_INVALID'
                | 'ARTIFACT_INTEGRITY_FAILED'
                | 'SKILL_PROTOCOL_ERROR'
                | 'SKILL_ENV_NOT_READY'
                | 'DEPENDENCY_MISSING'
                | 'UNAUTHENTICATED'
                | 'CANCEL_FAILED'
                | 'TURN_FAILED'
                | 'TURN_INTERRUPTED'
                | 'INTERNAL_ERROR';
              correlation_id: string;
              invalid_params?: {
                name: string;
                reason: string;
              }[];
              recovery_actions?: {
                code: string;
                label: string;
                href?: string;
              }[];
            };
          };
        };
    ExecutionPlan: {
      plan_id: string;
      title?: string;
      nodes: {
        id: string;
        title: string;
        skill_name: string;
        depends_on: string[];
        parallel_group?: string;
      }[];
    };
    SkillLifecycleCommand:
      | {
          /** @enum {string} */
          protocol_version: '1.0';
          request_id: string;
          /** Format: date-time */
          requested_at: string;
          /** @enum {string} */
          operation: 'start';
          session_id: string;
          turn_id: string;
          request: {
            [key: string]: unknown;
          };
        }
      | {
          /** @enum {string} */
          protocol_version: '1.0';
          request_id: string;
          /** Format: date-time */
          requested_at: string;
          /** @enum {string} */
          operation: 'status';
          job_id: string;
        }
      | {
          /** @enum {string} */
          protocol_version: '1.0';
          request_id: string;
          /** Format: date-time */
          requested_at: string;
          /** @enum {string} */
          operation: 'result';
          job_id: string;
        }
      | {
          /** @enum {string} */
          protocol_version: '1.0';
          request_id: string;
          /** Format: date-time */
          requested_at: string;
          /** @enum {string} */
          operation: 'resume';
          job_id: string;
          answers: {
            question_id: string;
            answer: string;
          }[];
        }
      | {
          /** @enum {string} */
          protocol_version: '1.0';
          request_id: string;
          /** Format: date-time */
          requested_at: string;
          /** @enum {string} */
          operation: 'cancel';
          job_id: string;
          reason?: string;
        };
    SkillEvent:
      | {
          /** @enum {string} */
          protocol_version: '1.0';
          event_id: string;
          skill_name: string;
          job_id: string;
          stage: string;
          /** Format: date-time */
          timestamp: string;
          warnings: string[];
          /** @enum {string} */
          kind: 'started';
          progress?: {
            completed: number;
            total: number;
            unit: string;
          };
          payload: {
            [key: string]: unknown;
          };
        }
      | {
          /** @enum {string} */
          protocol_version: '1.0';
          event_id: string;
          skill_name: string;
          job_id: string;
          stage: string;
          /** Format: date-time */
          timestamp: string;
          warnings: string[];
          /** @enum {string} */
          kind: 'progress';
          progress: {
            completed: number;
            total: number;
            unit: string;
          };
          payload: {
            [key: string]: unknown;
          };
        }
      | {
          /** @enum {string} */
          protocol_version: '1.0';
          event_id: string;
          skill_name: string;
          job_id: string;
          stage: string;
          /** Format: date-time */
          timestamp: string;
          warnings: string[];
          /** @enum {string} */
          kind: 'needs_input';
          questions: {
            id: string;
            question: string;
            options: string[];
            allow_free_text: boolean;
            required: boolean;
          }[];
          payload: {
            [key: string]: unknown;
          };
        }
      | {
          /** @enum {string} */
          protocol_version: '1.0';
          event_id: string;
          skill_name: string;
          job_id: string;
          stage: string;
          /** Format: date-time */
          timestamp: string;
          warnings: string[];
          /** @enum {string} */
          kind: 'artifact';
          artifact_id: string;
          manifest_relative_path: string;
          payload: {
            [key: string]: unknown;
          };
        }
      | {
          /** @enum {string} */
          protocol_version: '1.0';
          event_id: string;
          skill_name: string;
          job_id: string;
          stage: string;
          /** Format: date-time */
          timestamp: string;
          warnings: string[];
          /** @enum {string} */
          kind: 'completed';
          /** @enum {string} */
          outcome: 'succeeded' | 'partial';
          result_refs: {
            artifact_id: string;
            artifact_type: string;
            /** @enum {string} */
            status: 'succeeded' | 'partial';
            manifest_url: string;
          }[];
          payload: {
            [key: string]: unknown;
          };
        }
      | {
          /** @enum {string} */
          protocol_version: '1.0';
          event_id: string;
          skill_name: string;
          job_id: string;
          stage: string;
          /** Format: date-time */
          timestamp: string;
          warnings: string[];
          /** @enum {string} */
          kind: 'failed';
          error: {
            /** Format: uri */
            type: string;
            title: string;
            status: number;
            detail: string;
            instance?: string;
            /** @enum {string} */
            code:
              | 'VALIDATION_ERROR'
              | 'UNSUPPORTED_PROTOCOL_VERSION'
              | 'INCOMPATIBLE_PROTOCOL_VERSION'
              | 'RESOURCE_NOT_FOUND'
              | 'RESOURCE_CONFLICT'
              | 'IDEMPOTENCY_CONFLICT'
              | 'SESSION_BUSY'
              | 'SESSION_STATE_INVALID'
              | 'MODEL_NOT_ALLOWED'
              | 'MODEL_UNAVAILABLE'
              | 'MODEL_LOCKED'
              | 'UPLOAD_LIMIT_EXCEEDED'
              | 'UNSUPPORTED_MEDIA_TYPE'
              | 'SOURCE_REFERENCE_INVALID'
              | 'ARTIFACT_REFERENCE_INVALID'
              | 'ARTIFACT_INTEGRITY_FAILED'
              | 'SKILL_PROTOCOL_ERROR'
              | 'SKILL_ENV_NOT_READY'
              | 'DEPENDENCY_MISSING'
              | 'UNAUTHENTICATED'
              | 'CANCEL_FAILED'
              | 'TURN_FAILED'
              | 'TURN_INTERRUPTED'
              | 'INTERNAL_ERROR';
            correlation_id: string;
            invalid_params?: {
              name: string;
              reason: string;
            }[];
            recovery_actions?: {
              code: string;
              label: string;
              href?: string;
            }[];
          };
          payload: {
            [key: string]: unknown;
          };
        }
      | {
          /** @enum {string} */
          protocol_version: '1.0';
          event_id: string;
          skill_name: string;
          job_id: string;
          stage: string;
          /** Format: date-time */
          timestamp: string;
          warnings: string[];
          /** @enum {string} */
          kind: 'cancelled';
          reason?: string;
          payload: {
            [key: string]: unknown;
          };
        };
    PersistedSkillJobState: {
      /** @enum {string} */
      protocol_version: '1.0';
      skill_name: string;
      job_id: string;
      session_id: string;
      turn_id: string;
      /** @enum {string} */
      status:
        | 'queued'
        | 'running'
        | 'needs_input'
        | 'succeeded'
        | 'partial'
        | 'failed'
        | 'cancelling'
        | 'cancelled'
        | 'interrupted';
      stage: string;
      progress?: {
        completed: number;
        total: number;
        unit: string;
      };
      warnings: string[];
      questions?: {
        id: string;
        question: string;
        options: string[];
        allow_free_text: boolean;
        required: boolean;
      }[];
      result_refs: {
        artifact_id: string;
        artifact_type: string;
        /** @enum {string} */
        status: 'succeeded' | 'partial';
        manifest_url: string;
      }[];
      error?: {
        /** Format: uri */
        type: string;
        title: string;
        status: number;
        detail: string;
        instance?: string;
        /** @enum {string} */
        code:
          | 'VALIDATION_ERROR'
          | 'UNSUPPORTED_PROTOCOL_VERSION'
          | 'INCOMPATIBLE_PROTOCOL_VERSION'
          | 'RESOURCE_NOT_FOUND'
          | 'RESOURCE_CONFLICT'
          | 'IDEMPOTENCY_CONFLICT'
          | 'SESSION_BUSY'
          | 'SESSION_STATE_INVALID'
          | 'MODEL_NOT_ALLOWED'
          | 'MODEL_UNAVAILABLE'
          | 'MODEL_LOCKED'
          | 'UPLOAD_LIMIT_EXCEEDED'
          | 'UNSUPPORTED_MEDIA_TYPE'
          | 'SOURCE_REFERENCE_INVALID'
          | 'ARTIFACT_REFERENCE_INVALID'
          | 'ARTIFACT_INTEGRITY_FAILED'
          | 'SKILL_PROTOCOL_ERROR'
          | 'SKILL_ENV_NOT_READY'
          | 'DEPENDENCY_MISSING'
          | 'UNAUTHENTICATED'
          | 'CANCEL_FAILED'
          | 'TURN_FAILED'
          | 'TURN_INTERRUPTED'
          | 'INTERNAL_ERROR';
        correlation_id: string;
        invalid_params?: {
          name: string;
          reason: string;
        }[];
        recovery_actions?: {
          code: string;
          label: string;
          href?: string;
        }[];
      };
      /** Format: date-time */
      created_at: string;
      /** Format: date-time */
      updated_at: string;
    };
    ModelsResponse: {
      /** @enum {string} */
      api_version: '1.0';
      models: {
        id: string;
        display_name: string;
        reasoning_levels: ('minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max' | 'ultra')[];
        /** @enum {string} */
        default_reasoning_level: 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max' | 'ultra';
        /** @enum {string} */
        availability: 'available' | 'unavailable' | 'probing';
        unavailable_reason?: string;
      }[];
      default_model: string;
    };
    CreateSessionRequest: {
      /** @enum {string} */
      api_version: '1.0';
      title?: string;
      model: string;
      /** @enum {string} */
      reasoning_level: 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max' | 'ultra';
    };
    CreateSessionResponse: {
      /** @enum {string} */
      api_version: '1.0';
      session: {
        session_id: string;
        title: string;
        /** @enum {string} */
        status: 'empty' | 'idle' | 'running' | 'needs_input' | 'deleting';
        model: string;
        /** @enum {string} */
        reasoning_level: 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max' | 'ultra';
        model_locked: boolean;
        archived: boolean;
        active_turn_id?: string;
        /** Format: date-time */
        created_at: string;
        /** Format: date-time */
        updated_at: string;
      };
    };
    ListSessionsResponse: {
      /** @enum {string} */
      api_version: '1.0';
      sessions: {
        session_id: string;
        title: string;
        /** @enum {string} */
        status: 'empty' | 'idle' | 'running' | 'needs_input' | 'deleting';
        model: string;
        /** @enum {string} */
        reasoning_level: 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max' | 'ultra';
        model_locked: boolean;
        archived: boolean;
        active_turn_id?: string;
        /** Format: date-time */
        created_at: string;
        /** Format: date-time */
        updated_at: string;
      }[];
      next_cursor?: string;
    };
    SessionDetailResponse: {
      /** @enum {string} */
      api_version: '1.0';
      session: {
        session_id: string;
        title: string;
        /** @enum {string} */
        status: 'empty' | 'idle' | 'running' | 'needs_input' | 'deleting';
        model: string;
        /** @enum {string} */
        reasoning_level: 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max' | 'ultra';
        model_locked: boolean;
        archived: boolean;
        active_turn_id?: string;
        /** Format: date-time */
        created_at: string;
        /** Format: date-time */
        updated_at: string;
      };
      messages: {
        message_id: string;
        turn_id: string;
        /** @enum {string} */
        role: 'user' | 'assistant';
        content: string;
        source_refs: string[];
        result_refs: {
          artifact_id: string;
          artifact_type: string;
          /** @enum {string} */
          status: 'succeeded' | 'partial';
          manifest_url: string;
        }[];
        /** Format: date-time */
        created_at: string;
      }[];
      turns: {
        turn_id: string;
        /** @enum {string} */
        status:
          | 'queued'
          | 'running'
          | 'needs_input'
          | 'completed'
          | 'partial'
          | 'failed'
          | 'cancelling'
          | 'cancelled'
          | 'interrupted';
        /** Format: date-time */
        started_at?: string;
        /** Format: date-time */
        finished_at?: string;
        result_refs: {
          artifact_id: string;
          artifact_type: string;
          /** @enum {string} */
          status: 'succeeded' | 'partial';
          manifest_url: string;
        }[];
        execution_plan?: {
          plan_id: string;
          title?: string;
          nodes: {
            id: string;
            title: string;
            skill_name: string;
            depends_on: string[];
            parallel_group?: string;
          }[];
        };
        problem?: {
          /** Format: uri */
          type: string;
          title: string;
          status: number;
          detail: string;
          instance?: string;
          /** @enum {string} */
          code:
            | 'VALIDATION_ERROR'
            | 'UNSUPPORTED_PROTOCOL_VERSION'
            | 'INCOMPATIBLE_PROTOCOL_VERSION'
            | 'RESOURCE_NOT_FOUND'
            | 'RESOURCE_CONFLICT'
            | 'IDEMPOTENCY_CONFLICT'
            | 'SESSION_BUSY'
            | 'SESSION_STATE_INVALID'
            | 'MODEL_NOT_ALLOWED'
            | 'MODEL_UNAVAILABLE'
            | 'MODEL_LOCKED'
            | 'UPLOAD_LIMIT_EXCEEDED'
            | 'UNSUPPORTED_MEDIA_TYPE'
            | 'SOURCE_REFERENCE_INVALID'
            | 'ARTIFACT_REFERENCE_INVALID'
            | 'ARTIFACT_INTEGRITY_FAILED'
            | 'SKILL_PROTOCOL_ERROR'
            | 'SKILL_ENV_NOT_READY'
            | 'DEPENDENCY_MISSING'
            | 'UNAUTHENTICATED'
            | 'CANCEL_FAILED'
            | 'TURN_FAILED'
            | 'TURN_INTERRUPTED'
            | 'INTERNAL_ERROR';
          correlation_id: string;
          invalid_params?: {
            name: string;
            reason: string;
          }[];
          recovery_actions?: {
            code: string;
            label: string;
            href?: string;
          }[];
        };
      }[];
      sources: {
        source_ref: string;
        original_name: string;
        /** @enum {string} */
        media_type:
          | 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
          | 'application/vnd.ms-excel.sheet.macroEnabled.12'
          | 'text/csv';
        size_bytes: number;
        sha256: string;
        /** Format: date-time */
        created_at: string;
      }[];
      artifacts: {
        /** @enum {string} */
        schema_version: '1.0';
        artifact_id: string;
        artifact_type: string;
        producer: {
          skill_name: string;
          job_id: string;
        };
        source_ids: string[];
        /** @enum {string} */
        status: 'succeeded' | 'partial';
        files: {
          name: string;
          media_type: string;
          size_bytes: number;
          sha256: string;
          role: string;
          content_url: string;
        }[];
        summary: {
          [key: string]: unknown;
        };
        warnings: string[];
      }[];
      skill_jobs: {
        turn_id: string;
        skill_name: string;
        job_id: string;
        /** @enum {string} */
        status:
          | 'queued'
          | 'running'
          | 'needs_input'
          | 'succeeded'
          | 'partial'
          | 'failed'
          | 'cancelling'
          | 'cancelled'
          | 'interrupted';
        stage?: string;
        progress?: {
          completed: number;
          total: number;
          unit: string;
        };
        warnings?: string[];
        result_refs?: {
          artifact_id: string;
          artifact_type: string;
          /** @enum {string} */
          status: 'succeeded' | 'partial';
          manifest_url: string;
        }[];
      }[];
      pending_question_set?: {
        question_set_id: string;
        turn_id: string;
        /** @enum {string} */
        status: 'pending' | 'answered';
        questions: {
          id: string;
          question: string;
          options: string[];
          allow_free_text: boolean;
          required: boolean;
        }[];
        draft_answers: {
          question_id: string;
          answer: string;
        }[];
        /** Format: date-time */
        created_at: string;
      };
      last_event_id?: string;
    };
    UpdateSessionRequest: {
      /** @enum {string} */
      api_version: '1.0';
      title?: string;
      archived?: boolean;
      model?: string;
      /** @enum {string} */
      reasoning_level?: 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max' | 'ultra';
    };
    UpdateSessionResponse: {
      /** @enum {string} */
      api_version: '1.0';
      session: {
        session_id: string;
        title: string;
        /** @enum {string} */
        status: 'empty' | 'idle' | 'running' | 'needs_input' | 'deleting';
        model: string;
        /** @enum {string} */
        reasoning_level: 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max' | 'ultra';
        model_locked: boolean;
        archived: boolean;
        active_turn_id?: string;
        /** Format: date-time */
        created_at: string;
        /** Format: date-time */
        updated_at: string;
      };
    };
    UpdateQuestionDraftRequest: {
      /** @enum {string} */
      api_version: '1.0';
      draft_answers: {
        question_id: string;
        answer: string;
      }[];
    };
    UpdateQuestionDraftResponse: {
      /** @enum {string} */
      api_version: '1.0';
      question_set: {
        question_set_id: string;
        turn_id: string;
        /** @enum {string} */
        status: 'pending' | 'answered';
        questions: {
          id: string;
          question: string;
          options: string[];
          allow_free_text: boolean;
          required: boolean;
        }[];
        draft_answers: {
          question_id: string;
          answer: string;
        }[];
        /** Format: date-time */
        created_at: string;
      };
    };
    DeleteSessionRequest: {
      /** @enum {string} */
      api_version: '1.0';
      confirm_session_id: string;
    };
    DeleteSessionResponse: {
      /** @enum {string} */
      api_version: '1.0';
      deleted_session_id: string;
    };
    SubmitMessageRequest:
      | {
          /** @enum {string} */
          api_version: '1.0';
          /** @enum {string} */
          kind: 'message';
          content: string;
          source_refs: string[];
        }
      | {
          /** @enum {string} */
          api_version: '1.0';
          /** @enum {string} */
          kind: 'question_answers';
          question_set_id: string;
          answers: {
            question_id: string;
            answer: string;
          }[];
        };
    SubmitMessageResponse: {
      /** @enum {string} */
      api_version: '1.0';
      turn: {
        turn_id: string;
        /** @enum {string} */
        status:
          | 'queued'
          | 'running'
          | 'needs_input'
          | 'completed'
          | 'partial'
          | 'failed'
          | 'cancelling'
          | 'cancelled'
          | 'interrupted';
        /** Format: date-time */
        started_at?: string;
        /** Format: date-time */
        finished_at?: string;
        result_refs: {
          artifact_id: string;
          artifact_type: string;
          /** @enum {string} */
          status: 'succeeded' | 'partial';
          manifest_url: string;
        }[];
        execution_plan?: {
          plan_id: string;
          title?: string;
          nodes: {
            id: string;
            title: string;
            skill_name: string;
            depends_on: string[];
            parallel_group?: string;
          }[];
        };
        problem?: {
          /** Format: uri */
          type: string;
          title: string;
          status: number;
          detail: string;
          instance?: string;
          /** @enum {string} */
          code:
            | 'VALIDATION_ERROR'
            | 'UNSUPPORTED_PROTOCOL_VERSION'
            | 'INCOMPATIBLE_PROTOCOL_VERSION'
            | 'RESOURCE_NOT_FOUND'
            | 'RESOURCE_CONFLICT'
            | 'IDEMPOTENCY_CONFLICT'
            | 'SESSION_BUSY'
            | 'SESSION_STATE_INVALID'
            | 'MODEL_NOT_ALLOWED'
            | 'MODEL_UNAVAILABLE'
            | 'MODEL_LOCKED'
            | 'UPLOAD_LIMIT_EXCEEDED'
            | 'UNSUPPORTED_MEDIA_TYPE'
            | 'SOURCE_REFERENCE_INVALID'
            | 'ARTIFACT_REFERENCE_INVALID'
            | 'ARTIFACT_INTEGRITY_FAILED'
            | 'SKILL_PROTOCOL_ERROR'
            | 'SKILL_ENV_NOT_READY'
            | 'DEPENDENCY_MISSING'
            | 'UNAUTHENTICATED'
            | 'CANCEL_FAILED'
            | 'TURN_FAILED'
            | 'TURN_INTERRUPTED'
            | 'INTERNAL_ERROR';
          correlation_id: string;
          invalid_params?: {
            name: string;
            reason: string;
          }[];
          recovery_actions?: {
            code: string;
            label: string;
            href?: string;
          }[];
        };
      };
      replayed: boolean;
    };
    CancelTurnRequest: {
      /** @enum {string} */
      api_version: '1.0';
      reason?: string;
    };
    CancelTurnResponse: {
      /** @enum {string} */
      api_version: '1.0';
      turn: {
        turn_id: string;
        /** @enum {string} */
        status:
          | 'queued'
          | 'running'
          | 'needs_input'
          | 'completed'
          | 'partial'
          | 'failed'
          | 'cancelling'
          | 'cancelled'
          | 'interrupted';
        /** Format: date-time */
        started_at?: string;
        /** Format: date-time */
        finished_at?: string;
        result_refs: {
          artifact_id: string;
          artifact_type: string;
          /** @enum {string} */
          status: 'succeeded' | 'partial';
          manifest_url: string;
        }[];
        execution_plan?: {
          plan_id: string;
          title?: string;
          nodes: {
            id: string;
            title: string;
            skill_name: string;
            depends_on: string[];
            parallel_group?: string;
          }[];
        };
        problem?: {
          /** Format: uri */
          type: string;
          title: string;
          status: number;
          detail: string;
          instance?: string;
          /** @enum {string} */
          code:
            | 'VALIDATION_ERROR'
            | 'UNSUPPORTED_PROTOCOL_VERSION'
            | 'INCOMPATIBLE_PROTOCOL_VERSION'
            | 'RESOURCE_NOT_FOUND'
            | 'RESOURCE_CONFLICT'
            | 'IDEMPOTENCY_CONFLICT'
            | 'SESSION_BUSY'
            | 'SESSION_STATE_INVALID'
            | 'MODEL_NOT_ALLOWED'
            | 'MODEL_UNAVAILABLE'
            | 'MODEL_LOCKED'
            | 'UPLOAD_LIMIT_EXCEEDED'
            | 'UNSUPPORTED_MEDIA_TYPE'
            | 'SOURCE_REFERENCE_INVALID'
            | 'ARTIFACT_REFERENCE_INVALID'
            | 'ARTIFACT_INTEGRITY_FAILED'
            | 'SKILL_PROTOCOL_ERROR'
            | 'SKILL_ENV_NOT_READY'
            | 'DEPENDENCY_MISSING'
            | 'UNAUTHENTICATED'
            | 'CANCEL_FAILED'
            | 'TURN_FAILED'
            | 'TURN_INTERRUPTED'
            | 'INTERNAL_ERROR';
          correlation_id: string;
          invalid_params?: {
            name: string;
            reason: string;
          }[];
          recovery_actions?: {
            code: string;
            label: string;
            href?: string;
          }[];
        };
      };
      replayed: boolean;
    };
    UploadBatchRequest: {
      /** @enum {string} */
      api_version: '1.0';
      files: string[];
    };
    UploadBatchResponse: {
      /** @enum {string} */
      api_version: '1.0';
      sources: {
        source_ref: string;
        original_name: string;
        /** @enum {string} */
        media_type:
          | 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
          | 'application/vnd.ms-excel.sheet.macroEnabled.12'
          | 'text/csv';
        size_bytes: number;
        sha256: string;
        /** Format: date-time */
        created_at: string;
      }[];
    };
    ArtifactsResponse: {
      /** @enum {string} */
      api_version: '1.0';
      artifacts: {
        /** @enum {string} */
        schema_version: '1.0';
        artifact_id: string;
        artifact_type: string;
        producer: {
          skill_name: string;
          job_id: string;
        };
        source_ids: string[];
        /** @enum {string} */
        status: 'succeeded' | 'partial';
        files: {
          name: string;
          media_type: string;
          size_bytes: number;
          sha256: string;
          role: string;
          content_url: string;
        }[];
        summary: {
          [key: string]: unknown;
        };
        warnings: string[];
      }[];
    };
    TurnResponse: {
      /** @enum {string} */
      api_version: '1.0';
      turn: {
        turn_id: string;
        /** @enum {string} */
        status:
          | 'queued'
          | 'running'
          | 'needs_input'
          | 'completed'
          | 'partial'
          | 'failed'
          | 'cancelling'
          | 'cancelled'
          | 'interrupted';
        /** Format: date-time */
        started_at?: string;
        /** Format: date-time */
        finished_at?: string;
        result_refs: {
          artifact_id: string;
          artifact_type: string;
          /** @enum {string} */
          status: 'succeeded' | 'partial';
          manifest_url: string;
        }[];
        execution_plan?: {
          plan_id: string;
          title?: string;
          nodes: {
            id: string;
            title: string;
            skill_name: string;
            depends_on: string[];
            parallel_group?: string;
          }[];
        };
        problem?: {
          /** Format: uri */
          type: string;
          title: string;
          status: number;
          detail: string;
          instance?: string;
          /** @enum {string} */
          code:
            | 'VALIDATION_ERROR'
            | 'UNSUPPORTED_PROTOCOL_VERSION'
            | 'INCOMPATIBLE_PROTOCOL_VERSION'
            | 'RESOURCE_NOT_FOUND'
            | 'RESOURCE_CONFLICT'
            | 'IDEMPOTENCY_CONFLICT'
            | 'SESSION_BUSY'
            | 'SESSION_STATE_INVALID'
            | 'MODEL_NOT_ALLOWED'
            | 'MODEL_UNAVAILABLE'
            | 'MODEL_LOCKED'
            | 'UPLOAD_LIMIT_EXCEEDED'
            | 'UNSUPPORTED_MEDIA_TYPE'
            | 'SOURCE_REFERENCE_INVALID'
            | 'ARTIFACT_REFERENCE_INVALID'
            | 'ARTIFACT_INTEGRITY_FAILED'
            | 'SKILL_PROTOCOL_ERROR'
            | 'SKILL_ENV_NOT_READY'
            | 'DEPENDENCY_MISSING'
            | 'UNAUTHENTICATED'
            | 'CANCEL_FAILED'
            | 'TURN_FAILED'
            | 'TURN_INTERRUPTED'
            | 'INTERNAL_ERROR';
          correlation_id: string;
          invalid_params?: {
            name: string;
            reason: string;
          }[];
          recovery_actions?: {
            code: string;
            label: string;
            href?: string;
          }[];
        };
      };
    };
    HealthResponse: {
      /** @enum {string} */
      api_version: '1.0';
      /** @enum {string} */
      status: 'ready' | 'degraded' | 'unavailable';
      service_version: string;
      checks: {
        name: string;
        /** @enum {string} */
        status: 'ready' | 'degraded' | 'unavailable' | 'unknown';
        version?: string;
        capability_summary?: string;
        recovery_command?: string;
      }[];
    };
    DoctorResponse: {
      /** @enum {string} */
      api_version: '1.0';
      /** @enum {string} */
      status: 'ready' | 'degraded' | 'unavailable';
      /** Format: date-time */
      generated_at: string;
      checks: {
        name: string;
        /** @enum {string} */
        status: 'ready' | 'degraded' | 'unavailable' | 'unknown';
        version?: string;
        capability_summary?: string;
        recovery_command?: string;
      }[];
    };
  };
  responses: never;
  parameters: never;
  requestBodies: never;
  headers: never;
  pathItems: never;
}
export type $defs = Record<string, never>;
export interface operations {
  getHealth: {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    requestBody?: never;
    responses: {
      /** @description 轻量健康状态 */
      200: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': {
            /** @enum {string} */
            api_version: '1.0';
            /** @enum {string} */
            status: 'ready' | 'degraded' | 'unavailable';
            service_version: string;
            checks: {
              name: string;
              /** @enum {string} */
              status: 'ready' | 'degraded' | 'unavailable' | 'unknown';
              version?: string;
              capability_summary?: string;
              recovery_command?: string;
            }[];
          };
        };
      };
      /** @description 服务内部错误 */
      500: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': {
            /** Format: uri */
            type: string;
            title: string;
            status: number;
            detail: string;
            instance?: string;
            /** @enum {string} */
            code:
              | 'VALIDATION_ERROR'
              | 'UNSUPPORTED_PROTOCOL_VERSION'
              | 'INCOMPATIBLE_PROTOCOL_VERSION'
              | 'RESOURCE_NOT_FOUND'
              | 'RESOURCE_CONFLICT'
              | 'IDEMPOTENCY_CONFLICT'
              | 'SESSION_BUSY'
              | 'SESSION_STATE_INVALID'
              | 'MODEL_NOT_ALLOWED'
              | 'MODEL_UNAVAILABLE'
              | 'MODEL_LOCKED'
              | 'UPLOAD_LIMIT_EXCEEDED'
              | 'UNSUPPORTED_MEDIA_TYPE'
              | 'SOURCE_REFERENCE_INVALID'
              | 'ARTIFACT_REFERENCE_INVALID'
              | 'ARTIFACT_INTEGRITY_FAILED'
              | 'SKILL_PROTOCOL_ERROR'
              | 'SKILL_ENV_NOT_READY'
              | 'DEPENDENCY_MISSING'
              | 'UNAUTHENTICATED'
              | 'CANCEL_FAILED'
              | 'TURN_FAILED'
              | 'TURN_INTERRUPTED'
              | 'INTERNAL_ERROR';
            correlation_id: string;
            invalid_params?: {
              name: string;
              reason: string;
            }[];
            recovery_actions?: {
              code: string;
              label: string;
              href?: string;
            }[];
          };
        };
      };
    };
  };
  getDoctor: {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    requestBody?: never;
    responses: {
      /** @description 详细依赖诊断 */
      200: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': {
            /** @enum {string} */
            api_version: '1.0';
            /** @enum {string} */
            status: 'ready' | 'degraded' | 'unavailable';
            /** Format: date-time */
            generated_at: string;
            checks: {
              name: string;
              /** @enum {string} */
              status: 'ready' | 'degraded' | 'unavailable' | 'unknown';
              version?: string;
              capability_summary?: string;
              recovery_command?: string;
            }[];
          };
        };
      };
      /** @description 服务内部错误 */
      500: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': {
            /** Format: uri */
            type: string;
            title: string;
            status: number;
            detail: string;
            instance?: string;
            /** @enum {string} */
            code:
              | 'VALIDATION_ERROR'
              | 'UNSUPPORTED_PROTOCOL_VERSION'
              | 'INCOMPATIBLE_PROTOCOL_VERSION'
              | 'RESOURCE_NOT_FOUND'
              | 'RESOURCE_CONFLICT'
              | 'IDEMPOTENCY_CONFLICT'
              | 'SESSION_BUSY'
              | 'SESSION_STATE_INVALID'
              | 'MODEL_NOT_ALLOWED'
              | 'MODEL_UNAVAILABLE'
              | 'MODEL_LOCKED'
              | 'UPLOAD_LIMIT_EXCEEDED'
              | 'UNSUPPORTED_MEDIA_TYPE'
              | 'SOURCE_REFERENCE_INVALID'
              | 'ARTIFACT_REFERENCE_INVALID'
              | 'ARTIFACT_INTEGRITY_FAILED'
              | 'SKILL_PROTOCOL_ERROR'
              | 'SKILL_ENV_NOT_READY'
              | 'DEPENDENCY_MISSING'
              | 'UNAUTHENTICATED'
              | 'CANCEL_FAILED'
              | 'TURN_FAILED'
              | 'TURN_INTERRUPTED'
              | 'INTERNAL_ERROR';
            correlation_id: string;
            invalid_params?: {
              name: string;
              reason: string;
            }[];
            recovery_actions?: {
              code: string;
              label: string;
              href?: string;
            }[];
          };
        };
      };
    };
  };
  listModels: {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    requestBody?: never;
    responses: {
      /** @description 已验证的模型候选 */
      200: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': {
            /** @enum {string} */
            api_version: '1.0';
            models: {
              id: string;
              display_name: string;
              reasoning_levels: (
                'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max' | 'ultra'
              )[];
              /** @enum {string} */
              default_reasoning_level:
                'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max' | 'ultra';
              /** @enum {string} */
              availability: 'available' | 'unavailable' | 'probing';
              unavailable_reason?: string;
            }[];
            default_model: string;
          };
        };
      };
      /** @description 服务内部错误 */
      500: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': {
            /** Format: uri */
            type: string;
            title: string;
            status: number;
            detail: string;
            instance?: string;
            /** @enum {string} */
            code:
              | 'VALIDATION_ERROR'
              | 'UNSUPPORTED_PROTOCOL_VERSION'
              | 'INCOMPATIBLE_PROTOCOL_VERSION'
              | 'RESOURCE_NOT_FOUND'
              | 'RESOURCE_CONFLICT'
              | 'IDEMPOTENCY_CONFLICT'
              | 'SESSION_BUSY'
              | 'SESSION_STATE_INVALID'
              | 'MODEL_NOT_ALLOWED'
              | 'MODEL_UNAVAILABLE'
              | 'MODEL_LOCKED'
              | 'UPLOAD_LIMIT_EXCEEDED'
              | 'UNSUPPORTED_MEDIA_TYPE'
              | 'SOURCE_REFERENCE_INVALID'
              | 'ARTIFACT_REFERENCE_INVALID'
              | 'ARTIFACT_INTEGRITY_FAILED'
              | 'SKILL_PROTOCOL_ERROR'
              | 'SKILL_ENV_NOT_READY'
              | 'DEPENDENCY_MISSING'
              | 'UNAUTHENTICATED'
              | 'CANCEL_FAILED'
              | 'TURN_FAILED'
              | 'TURN_INTERRUPTED'
              | 'INTERNAL_ERROR';
            correlation_id: string;
            invalid_params?: {
              name: string;
              reason: string;
            }[];
            recovery_actions?: {
              code: string;
              label: string;
              href?: string;
            }[];
          };
        };
      };
    };
  };
  listSessions: {
    parameters: {
      query?: {
        search?: string;
        archived?: 'true' | 'false';
        cursor?: string;
        limit?: number;
      };
      header?: never;
      path?: never;
      cookie?: never;
    };
    requestBody?: never;
    responses: {
      /** @description 会话列表 */
      200: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': {
            /** @enum {string} */
            api_version: '1.0';
            sessions: {
              session_id: string;
              title: string;
              /** @enum {string} */
              status: 'empty' | 'idle' | 'running' | 'needs_input' | 'deleting';
              model: string;
              /** @enum {string} */
              reasoning_level: 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max' | 'ultra';
              model_locked: boolean;
              archived: boolean;
              active_turn_id?: string;
              /** Format: date-time */
              created_at: string;
              /** Format: date-time */
              updated_at: string;
            }[];
            next_cursor?: string;
          };
        };
      };
      /** @description 请求不符合公共契约 */
      400: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': {
            /** Format: uri */
            type: string;
            title: string;
            status: number;
            detail: string;
            instance?: string;
            /** @enum {string} */
            code:
              | 'VALIDATION_ERROR'
              | 'UNSUPPORTED_PROTOCOL_VERSION'
              | 'INCOMPATIBLE_PROTOCOL_VERSION'
              | 'RESOURCE_NOT_FOUND'
              | 'RESOURCE_CONFLICT'
              | 'IDEMPOTENCY_CONFLICT'
              | 'SESSION_BUSY'
              | 'SESSION_STATE_INVALID'
              | 'MODEL_NOT_ALLOWED'
              | 'MODEL_UNAVAILABLE'
              | 'MODEL_LOCKED'
              | 'UPLOAD_LIMIT_EXCEEDED'
              | 'UNSUPPORTED_MEDIA_TYPE'
              | 'SOURCE_REFERENCE_INVALID'
              | 'ARTIFACT_REFERENCE_INVALID'
              | 'ARTIFACT_INTEGRITY_FAILED'
              | 'SKILL_PROTOCOL_ERROR'
              | 'SKILL_ENV_NOT_READY'
              | 'DEPENDENCY_MISSING'
              | 'UNAUTHENTICATED'
              | 'CANCEL_FAILED'
              | 'TURN_FAILED'
              | 'TURN_INTERRUPTED'
              | 'INTERNAL_ERROR';
            correlation_id: string;
            invalid_params?: {
              name: string;
              reason: string;
            }[];
            recovery_actions?: {
              code: string;
              label: string;
              href?: string;
            }[];
          };
        };
      };
    };
  };
  createSession: {
    parameters: {
      query?: never;
      header: {
        'idempotency-key': string;
      };
      path?: never;
      cookie?: never;
    };
    requestBody?: {
      content: {
        'application/json': {
          /** @enum {string} */
          api_version: '1.0';
          title?: string;
          model: string;
          /** @enum {string} */
          reasoning_level: 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max' | 'ultra';
        };
      };
    };
    responses: {
      /** @description 新建会话 */
      201: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': {
            /** @enum {string} */
            api_version: '1.0';
            session: {
              session_id: string;
              title: string;
              /** @enum {string} */
              status: 'empty' | 'idle' | 'running' | 'needs_input' | 'deleting';
              model: string;
              /** @enum {string} */
              reasoning_level: 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max' | 'ultra';
              model_locked: boolean;
              archived: boolean;
              active_turn_id?: string;
              /** Format: date-time */
              created_at: string;
              /** Format: date-time */
              updated_at: string;
            };
          };
        };
      };
      /** @description 请求不符合公共契约 */
      400: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': {
            /** Format: uri */
            type: string;
            title: string;
            status: number;
            detail: string;
            instance?: string;
            /** @enum {string} */
            code:
              | 'VALIDATION_ERROR'
              | 'UNSUPPORTED_PROTOCOL_VERSION'
              | 'INCOMPATIBLE_PROTOCOL_VERSION'
              | 'RESOURCE_NOT_FOUND'
              | 'RESOURCE_CONFLICT'
              | 'IDEMPOTENCY_CONFLICT'
              | 'SESSION_BUSY'
              | 'SESSION_STATE_INVALID'
              | 'MODEL_NOT_ALLOWED'
              | 'MODEL_UNAVAILABLE'
              | 'MODEL_LOCKED'
              | 'UPLOAD_LIMIT_EXCEEDED'
              | 'UNSUPPORTED_MEDIA_TYPE'
              | 'SOURCE_REFERENCE_INVALID'
              | 'ARTIFACT_REFERENCE_INVALID'
              | 'ARTIFACT_INTEGRITY_FAILED'
              | 'SKILL_PROTOCOL_ERROR'
              | 'SKILL_ENV_NOT_READY'
              | 'DEPENDENCY_MISSING'
              | 'UNAUTHENTICATED'
              | 'CANCEL_FAILED'
              | 'TURN_FAILED'
              | 'TURN_INTERRUPTED'
              | 'INTERNAL_ERROR';
            correlation_id: string;
            invalid_params?: {
              name: string;
              reason: string;
            }[];
            recovery_actions?: {
              code: string;
              label: string;
              href?: string;
            }[];
          };
        };
      };
      /** @description 资源状态或幂等键冲突 */
      409: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': {
            /** Format: uri */
            type: string;
            title: string;
            status: number;
            detail: string;
            instance?: string;
            /** @enum {string} */
            code:
              | 'VALIDATION_ERROR'
              | 'UNSUPPORTED_PROTOCOL_VERSION'
              | 'INCOMPATIBLE_PROTOCOL_VERSION'
              | 'RESOURCE_NOT_FOUND'
              | 'RESOURCE_CONFLICT'
              | 'IDEMPOTENCY_CONFLICT'
              | 'SESSION_BUSY'
              | 'SESSION_STATE_INVALID'
              | 'MODEL_NOT_ALLOWED'
              | 'MODEL_UNAVAILABLE'
              | 'MODEL_LOCKED'
              | 'UPLOAD_LIMIT_EXCEEDED'
              | 'UNSUPPORTED_MEDIA_TYPE'
              | 'SOURCE_REFERENCE_INVALID'
              | 'ARTIFACT_REFERENCE_INVALID'
              | 'ARTIFACT_INTEGRITY_FAILED'
              | 'SKILL_PROTOCOL_ERROR'
              | 'SKILL_ENV_NOT_READY'
              | 'DEPENDENCY_MISSING'
              | 'UNAUTHENTICATED'
              | 'CANCEL_FAILED'
              | 'TURN_FAILED'
              | 'TURN_INTERRUPTED'
              | 'INTERNAL_ERROR';
            correlation_id: string;
            invalid_params?: {
              name: string;
              reason: string;
            }[];
            recovery_actions?: {
              code: string;
              label: string;
              href?: string;
            }[];
          };
        };
      };
    };
  };
  getSession: {
    parameters: {
      query?: never;
      header?: never;
      path: {
        sessionId: string;
      };
      cookie?: never;
    };
    requestBody?: never;
    responses: {
      /** @description 会话、消息、turn 与待回答问题 */
      200: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': {
            /** @enum {string} */
            api_version: '1.0';
            session: {
              session_id: string;
              title: string;
              /** @enum {string} */
              status: 'empty' | 'idle' | 'running' | 'needs_input' | 'deleting';
              model: string;
              /** @enum {string} */
              reasoning_level: 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max' | 'ultra';
              model_locked: boolean;
              archived: boolean;
              active_turn_id?: string;
              /** Format: date-time */
              created_at: string;
              /** Format: date-time */
              updated_at: string;
            };
            messages: {
              message_id: string;
              turn_id: string;
              /** @enum {string} */
              role: 'user' | 'assistant';
              content: string;
              source_refs: string[];
              result_refs: {
                artifact_id: string;
                artifact_type: string;
                /** @enum {string} */
                status: 'succeeded' | 'partial';
                manifest_url: string;
              }[];
              /** Format: date-time */
              created_at: string;
            }[];
            turns: {
              turn_id: string;
              /** @enum {string} */
              status:
                | 'queued'
                | 'running'
                | 'needs_input'
                | 'completed'
                | 'partial'
                | 'failed'
                | 'cancelling'
                | 'cancelled'
                | 'interrupted';
              /** Format: date-time */
              started_at?: string;
              /** Format: date-time */
              finished_at?: string;
              result_refs: {
                artifact_id: string;
                artifact_type: string;
                /** @enum {string} */
                status: 'succeeded' | 'partial';
                manifest_url: string;
              }[];
              execution_plan?: {
                plan_id: string;
                title?: string;
                nodes: {
                  id: string;
                  title: string;
                  skill_name: string;
                  depends_on: string[];
                  parallel_group?: string;
                }[];
              };
              problem?: {
                /** Format: uri */
                type: string;
                title: string;
                status: number;
                detail: string;
                instance?: string;
                /** @enum {string} */
                code:
                  | 'VALIDATION_ERROR'
                  | 'UNSUPPORTED_PROTOCOL_VERSION'
                  | 'INCOMPATIBLE_PROTOCOL_VERSION'
                  | 'RESOURCE_NOT_FOUND'
                  | 'RESOURCE_CONFLICT'
                  | 'IDEMPOTENCY_CONFLICT'
                  | 'SESSION_BUSY'
                  | 'SESSION_STATE_INVALID'
                  | 'MODEL_NOT_ALLOWED'
                  | 'MODEL_UNAVAILABLE'
                  | 'MODEL_LOCKED'
                  | 'UPLOAD_LIMIT_EXCEEDED'
                  | 'UNSUPPORTED_MEDIA_TYPE'
                  | 'SOURCE_REFERENCE_INVALID'
                  | 'ARTIFACT_REFERENCE_INVALID'
                  | 'ARTIFACT_INTEGRITY_FAILED'
                  | 'SKILL_PROTOCOL_ERROR'
                  | 'SKILL_ENV_NOT_READY'
                  | 'DEPENDENCY_MISSING'
                  | 'UNAUTHENTICATED'
                  | 'CANCEL_FAILED'
                  | 'TURN_FAILED'
                  | 'TURN_INTERRUPTED'
                  | 'INTERNAL_ERROR';
                correlation_id: string;
                invalid_params?: {
                  name: string;
                  reason: string;
                }[];
                recovery_actions?: {
                  code: string;
                  label: string;
                  href?: string;
                }[];
              };
            }[];
            sources: {
              source_ref: string;
              original_name: string;
              /** @enum {string} */
              media_type:
                | 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
                | 'application/vnd.ms-excel.sheet.macroEnabled.12'
                | 'text/csv';
              size_bytes: number;
              sha256: string;
              /** Format: date-time */
              created_at: string;
            }[];
            artifacts: {
              /** @enum {string} */
              schema_version: '1.0';
              artifact_id: string;
              artifact_type: string;
              producer: {
                skill_name: string;
                job_id: string;
              };
              source_ids: string[];
              /** @enum {string} */
              status: 'succeeded' | 'partial';
              files: {
                name: string;
                media_type: string;
                size_bytes: number;
                sha256: string;
                role: string;
                content_url: string;
              }[];
              summary: {
                [key: string]: unknown;
              };
              warnings: string[];
            }[];
            skill_jobs: {
              turn_id: string;
              skill_name: string;
              job_id: string;
              /** @enum {string} */
              status:
                | 'queued'
                | 'running'
                | 'needs_input'
                | 'succeeded'
                | 'partial'
                | 'failed'
                | 'cancelling'
                | 'cancelled'
                | 'interrupted';
              stage?: string;
              progress?: {
                completed: number;
                total: number;
                unit: string;
              };
              warnings?: string[];
              result_refs?: {
                artifact_id: string;
                artifact_type: string;
                /** @enum {string} */
                status: 'succeeded' | 'partial';
                manifest_url: string;
              }[];
            }[];
            pending_question_set?: {
              question_set_id: string;
              turn_id: string;
              /** @enum {string} */
              status: 'pending' | 'answered';
              questions: {
                id: string;
                question: string;
                options: string[];
                allow_free_text: boolean;
                required: boolean;
              }[];
              draft_answers: {
                question_id: string;
                answer: string;
              }[];
              /** Format: date-time */
              created_at: string;
            };
            last_event_id?: string;
          };
        };
      };
      /** @description 资源不存在或不属于当前会话 */
      404: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': {
            /** Format: uri */
            type: string;
            title: string;
            status: number;
            detail: string;
            instance?: string;
            /** @enum {string} */
            code:
              | 'VALIDATION_ERROR'
              | 'UNSUPPORTED_PROTOCOL_VERSION'
              | 'INCOMPATIBLE_PROTOCOL_VERSION'
              | 'RESOURCE_NOT_FOUND'
              | 'RESOURCE_CONFLICT'
              | 'IDEMPOTENCY_CONFLICT'
              | 'SESSION_BUSY'
              | 'SESSION_STATE_INVALID'
              | 'MODEL_NOT_ALLOWED'
              | 'MODEL_UNAVAILABLE'
              | 'MODEL_LOCKED'
              | 'UPLOAD_LIMIT_EXCEEDED'
              | 'UNSUPPORTED_MEDIA_TYPE'
              | 'SOURCE_REFERENCE_INVALID'
              | 'ARTIFACT_REFERENCE_INVALID'
              | 'ARTIFACT_INTEGRITY_FAILED'
              | 'SKILL_PROTOCOL_ERROR'
              | 'SKILL_ENV_NOT_READY'
              | 'DEPENDENCY_MISSING'
              | 'UNAUTHENTICATED'
              | 'CANCEL_FAILED'
              | 'TURN_FAILED'
              | 'TURN_INTERRUPTED'
              | 'INTERNAL_ERROR';
            correlation_id: string;
            invalid_params?: {
              name: string;
              reason: string;
            }[];
            recovery_actions?: {
              code: string;
              label: string;
              href?: string;
            }[];
          };
        };
      };
    };
  };
  deleteSession: {
    parameters: {
      query?: never;
      header: {
        'idempotency-key': string;
      };
      path: {
        sessionId: string;
      };
      cookie?: never;
    };
    requestBody?: {
      content: {
        'application/json': {
          /** @enum {string} */
          api_version: '1.0';
          confirm_session_id: string;
        };
      };
    };
    responses: {
      /** @description 已删除会话 */
      200: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': {
            /** @enum {string} */
            api_version: '1.0';
            deleted_session_id: string;
          };
        };
      };
      /** @description 请求不符合公共契约 */
      400: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': {
            /** Format: uri */
            type: string;
            title: string;
            status: number;
            detail: string;
            instance?: string;
            /** @enum {string} */
            code:
              | 'VALIDATION_ERROR'
              | 'UNSUPPORTED_PROTOCOL_VERSION'
              | 'INCOMPATIBLE_PROTOCOL_VERSION'
              | 'RESOURCE_NOT_FOUND'
              | 'RESOURCE_CONFLICT'
              | 'IDEMPOTENCY_CONFLICT'
              | 'SESSION_BUSY'
              | 'SESSION_STATE_INVALID'
              | 'MODEL_NOT_ALLOWED'
              | 'MODEL_UNAVAILABLE'
              | 'MODEL_LOCKED'
              | 'UPLOAD_LIMIT_EXCEEDED'
              | 'UNSUPPORTED_MEDIA_TYPE'
              | 'SOURCE_REFERENCE_INVALID'
              | 'ARTIFACT_REFERENCE_INVALID'
              | 'ARTIFACT_INTEGRITY_FAILED'
              | 'SKILL_PROTOCOL_ERROR'
              | 'SKILL_ENV_NOT_READY'
              | 'DEPENDENCY_MISSING'
              | 'UNAUTHENTICATED'
              | 'CANCEL_FAILED'
              | 'TURN_FAILED'
              | 'TURN_INTERRUPTED'
              | 'INTERNAL_ERROR';
            correlation_id: string;
            invalid_params?: {
              name: string;
              reason: string;
            }[];
            recovery_actions?: {
              code: string;
              label: string;
              href?: string;
            }[];
          };
        };
      };
      /** @description 资源不存在或不属于当前会话 */
      404: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': {
            /** Format: uri */
            type: string;
            title: string;
            status: number;
            detail: string;
            instance?: string;
            /** @enum {string} */
            code:
              | 'VALIDATION_ERROR'
              | 'UNSUPPORTED_PROTOCOL_VERSION'
              | 'INCOMPATIBLE_PROTOCOL_VERSION'
              | 'RESOURCE_NOT_FOUND'
              | 'RESOURCE_CONFLICT'
              | 'IDEMPOTENCY_CONFLICT'
              | 'SESSION_BUSY'
              | 'SESSION_STATE_INVALID'
              | 'MODEL_NOT_ALLOWED'
              | 'MODEL_UNAVAILABLE'
              | 'MODEL_LOCKED'
              | 'UPLOAD_LIMIT_EXCEEDED'
              | 'UNSUPPORTED_MEDIA_TYPE'
              | 'SOURCE_REFERENCE_INVALID'
              | 'ARTIFACT_REFERENCE_INVALID'
              | 'ARTIFACT_INTEGRITY_FAILED'
              | 'SKILL_PROTOCOL_ERROR'
              | 'SKILL_ENV_NOT_READY'
              | 'DEPENDENCY_MISSING'
              | 'UNAUTHENTICATED'
              | 'CANCEL_FAILED'
              | 'TURN_FAILED'
              | 'TURN_INTERRUPTED'
              | 'INTERNAL_ERROR';
            correlation_id: string;
            invalid_params?: {
              name: string;
              reason: string;
            }[];
            recovery_actions?: {
              code: string;
              label: string;
              href?: string;
            }[];
          };
        };
      };
      /** @description 资源状态或幂等键冲突 */
      409: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': {
            /** Format: uri */
            type: string;
            title: string;
            status: number;
            detail: string;
            instance?: string;
            /** @enum {string} */
            code:
              | 'VALIDATION_ERROR'
              | 'UNSUPPORTED_PROTOCOL_VERSION'
              | 'INCOMPATIBLE_PROTOCOL_VERSION'
              | 'RESOURCE_NOT_FOUND'
              | 'RESOURCE_CONFLICT'
              | 'IDEMPOTENCY_CONFLICT'
              | 'SESSION_BUSY'
              | 'SESSION_STATE_INVALID'
              | 'MODEL_NOT_ALLOWED'
              | 'MODEL_UNAVAILABLE'
              | 'MODEL_LOCKED'
              | 'UPLOAD_LIMIT_EXCEEDED'
              | 'UNSUPPORTED_MEDIA_TYPE'
              | 'SOURCE_REFERENCE_INVALID'
              | 'ARTIFACT_REFERENCE_INVALID'
              | 'ARTIFACT_INTEGRITY_FAILED'
              | 'SKILL_PROTOCOL_ERROR'
              | 'SKILL_ENV_NOT_READY'
              | 'DEPENDENCY_MISSING'
              | 'UNAUTHENTICATED'
              | 'CANCEL_FAILED'
              | 'TURN_FAILED'
              | 'TURN_INTERRUPTED'
              | 'INTERNAL_ERROR';
            correlation_id: string;
            invalid_params?: {
              name: string;
              reason: string;
            }[];
            recovery_actions?: {
              code: string;
              label: string;
              href?: string;
            }[];
          };
        };
      };
    };
  };
  updateSession: {
    parameters: {
      query?: never;
      header?: never;
      path: {
        sessionId: string;
      };
      cookie?: never;
    };
    requestBody?: {
      content: {
        'application/json': {
          /** @enum {string} */
          api_version: '1.0';
          title?: string;
          archived?: boolean;
          model?: string;
          /** @enum {string} */
          reasoning_level?: 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max' | 'ultra';
        };
      };
    };
    responses: {
      /** @description 已更新会话 */
      200: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': {
            /** @enum {string} */
            api_version: '1.0';
            session: {
              session_id: string;
              title: string;
              /** @enum {string} */
              status: 'empty' | 'idle' | 'running' | 'needs_input' | 'deleting';
              model: string;
              /** @enum {string} */
              reasoning_level: 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max' | 'ultra';
              model_locked: boolean;
              archived: boolean;
              active_turn_id?: string;
              /** Format: date-time */
              created_at: string;
              /** Format: date-time */
              updated_at: string;
            };
          };
        };
      };
      /** @description 请求不符合公共契约 */
      400: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': {
            /** Format: uri */
            type: string;
            title: string;
            status: number;
            detail: string;
            instance?: string;
            /** @enum {string} */
            code:
              | 'VALIDATION_ERROR'
              | 'UNSUPPORTED_PROTOCOL_VERSION'
              | 'INCOMPATIBLE_PROTOCOL_VERSION'
              | 'RESOURCE_NOT_FOUND'
              | 'RESOURCE_CONFLICT'
              | 'IDEMPOTENCY_CONFLICT'
              | 'SESSION_BUSY'
              | 'SESSION_STATE_INVALID'
              | 'MODEL_NOT_ALLOWED'
              | 'MODEL_UNAVAILABLE'
              | 'MODEL_LOCKED'
              | 'UPLOAD_LIMIT_EXCEEDED'
              | 'UNSUPPORTED_MEDIA_TYPE'
              | 'SOURCE_REFERENCE_INVALID'
              | 'ARTIFACT_REFERENCE_INVALID'
              | 'ARTIFACT_INTEGRITY_FAILED'
              | 'SKILL_PROTOCOL_ERROR'
              | 'SKILL_ENV_NOT_READY'
              | 'DEPENDENCY_MISSING'
              | 'UNAUTHENTICATED'
              | 'CANCEL_FAILED'
              | 'TURN_FAILED'
              | 'TURN_INTERRUPTED'
              | 'INTERNAL_ERROR';
            correlation_id: string;
            invalid_params?: {
              name: string;
              reason: string;
            }[];
            recovery_actions?: {
              code: string;
              label: string;
              href?: string;
            }[];
          };
        };
      };
      /** @description 资源不存在或不属于当前会话 */
      404: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': {
            /** Format: uri */
            type: string;
            title: string;
            status: number;
            detail: string;
            instance?: string;
            /** @enum {string} */
            code:
              | 'VALIDATION_ERROR'
              | 'UNSUPPORTED_PROTOCOL_VERSION'
              | 'INCOMPATIBLE_PROTOCOL_VERSION'
              | 'RESOURCE_NOT_FOUND'
              | 'RESOURCE_CONFLICT'
              | 'IDEMPOTENCY_CONFLICT'
              | 'SESSION_BUSY'
              | 'SESSION_STATE_INVALID'
              | 'MODEL_NOT_ALLOWED'
              | 'MODEL_UNAVAILABLE'
              | 'MODEL_LOCKED'
              | 'UPLOAD_LIMIT_EXCEEDED'
              | 'UNSUPPORTED_MEDIA_TYPE'
              | 'SOURCE_REFERENCE_INVALID'
              | 'ARTIFACT_REFERENCE_INVALID'
              | 'ARTIFACT_INTEGRITY_FAILED'
              | 'SKILL_PROTOCOL_ERROR'
              | 'SKILL_ENV_NOT_READY'
              | 'DEPENDENCY_MISSING'
              | 'UNAUTHENTICATED'
              | 'CANCEL_FAILED'
              | 'TURN_FAILED'
              | 'TURN_INTERRUPTED'
              | 'INTERNAL_ERROR';
            correlation_id: string;
            invalid_params?: {
              name: string;
              reason: string;
            }[];
            recovery_actions?: {
              code: string;
              label: string;
              href?: string;
            }[];
          };
        };
      };
      /** @description 资源状态或幂等键冲突 */
      409: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': {
            /** Format: uri */
            type: string;
            title: string;
            status: number;
            detail: string;
            instance?: string;
            /** @enum {string} */
            code:
              | 'VALIDATION_ERROR'
              | 'UNSUPPORTED_PROTOCOL_VERSION'
              | 'INCOMPATIBLE_PROTOCOL_VERSION'
              | 'RESOURCE_NOT_FOUND'
              | 'RESOURCE_CONFLICT'
              | 'IDEMPOTENCY_CONFLICT'
              | 'SESSION_BUSY'
              | 'SESSION_STATE_INVALID'
              | 'MODEL_NOT_ALLOWED'
              | 'MODEL_UNAVAILABLE'
              | 'MODEL_LOCKED'
              | 'UPLOAD_LIMIT_EXCEEDED'
              | 'UNSUPPORTED_MEDIA_TYPE'
              | 'SOURCE_REFERENCE_INVALID'
              | 'ARTIFACT_REFERENCE_INVALID'
              | 'ARTIFACT_INTEGRITY_FAILED'
              | 'SKILL_PROTOCOL_ERROR'
              | 'SKILL_ENV_NOT_READY'
              | 'DEPENDENCY_MISSING'
              | 'UNAUTHENTICATED'
              | 'CANCEL_FAILED'
              | 'TURN_FAILED'
              | 'TURN_INTERRUPTED'
              | 'INTERNAL_ERROR';
            correlation_id: string;
            invalid_params?: {
              name: string;
              reason: string;
            }[];
            recovery_actions?: {
              code: string;
              label: string;
              href?: string;
            }[];
          };
        };
      };
    };
  };
  updateQuestionDraft: {
    parameters: {
      query?: never;
      header?: never;
      path: {
        sessionId: string;
        questionSetId: string;
      };
      cookie?: never;
    };
    requestBody?: {
      content: {
        'application/json': {
          /** @enum {string} */
          api_version: '1.0';
          draft_answers: {
            question_id: string;
            answer: string;
          }[];
        };
      };
    };
    responses: {
      /** @description 持久化问题组草稿 */
      200: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': {
            /** @enum {string} */
            api_version: '1.0';
            question_set: {
              question_set_id: string;
              turn_id: string;
              /** @enum {string} */
              status: 'pending' | 'answered';
              questions: {
                id: string;
                question: string;
                options: string[];
                allow_free_text: boolean;
                required: boolean;
              }[];
              draft_answers: {
                question_id: string;
                answer: string;
              }[];
              /** Format: date-time */
              created_at: string;
            };
          };
        };
      };
      /** @description 请求不符合公共契约 */
      400: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': {
            /** Format: uri */
            type: string;
            title: string;
            status: number;
            detail: string;
            instance?: string;
            /** @enum {string} */
            code:
              | 'VALIDATION_ERROR'
              | 'UNSUPPORTED_PROTOCOL_VERSION'
              | 'INCOMPATIBLE_PROTOCOL_VERSION'
              | 'RESOURCE_NOT_FOUND'
              | 'RESOURCE_CONFLICT'
              | 'IDEMPOTENCY_CONFLICT'
              | 'SESSION_BUSY'
              | 'SESSION_STATE_INVALID'
              | 'MODEL_NOT_ALLOWED'
              | 'MODEL_UNAVAILABLE'
              | 'MODEL_LOCKED'
              | 'UPLOAD_LIMIT_EXCEEDED'
              | 'UNSUPPORTED_MEDIA_TYPE'
              | 'SOURCE_REFERENCE_INVALID'
              | 'ARTIFACT_REFERENCE_INVALID'
              | 'ARTIFACT_INTEGRITY_FAILED'
              | 'SKILL_PROTOCOL_ERROR'
              | 'SKILL_ENV_NOT_READY'
              | 'DEPENDENCY_MISSING'
              | 'UNAUTHENTICATED'
              | 'CANCEL_FAILED'
              | 'TURN_FAILED'
              | 'TURN_INTERRUPTED'
              | 'INTERNAL_ERROR';
            correlation_id: string;
            invalid_params?: {
              name: string;
              reason: string;
            }[];
            recovery_actions?: {
              code: string;
              label: string;
              href?: string;
            }[];
          };
        };
      };
      /** @description 资源不存在或不属于当前会话 */
      404: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': {
            /** Format: uri */
            type: string;
            title: string;
            status: number;
            detail: string;
            instance?: string;
            /** @enum {string} */
            code:
              | 'VALIDATION_ERROR'
              | 'UNSUPPORTED_PROTOCOL_VERSION'
              | 'INCOMPATIBLE_PROTOCOL_VERSION'
              | 'RESOURCE_NOT_FOUND'
              | 'RESOURCE_CONFLICT'
              | 'IDEMPOTENCY_CONFLICT'
              | 'SESSION_BUSY'
              | 'SESSION_STATE_INVALID'
              | 'MODEL_NOT_ALLOWED'
              | 'MODEL_UNAVAILABLE'
              | 'MODEL_LOCKED'
              | 'UPLOAD_LIMIT_EXCEEDED'
              | 'UNSUPPORTED_MEDIA_TYPE'
              | 'SOURCE_REFERENCE_INVALID'
              | 'ARTIFACT_REFERENCE_INVALID'
              | 'ARTIFACT_INTEGRITY_FAILED'
              | 'SKILL_PROTOCOL_ERROR'
              | 'SKILL_ENV_NOT_READY'
              | 'DEPENDENCY_MISSING'
              | 'UNAUTHENTICATED'
              | 'CANCEL_FAILED'
              | 'TURN_FAILED'
              | 'TURN_INTERRUPTED'
              | 'INTERNAL_ERROR';
            correlation_id: string;
            invalid_params?: {
              name: string;
              reason: string;
            }[];
            recovery_actions?: {
              code: string;
              label: string;
              href?: string;
            }[];
          };
        };
      };
      /** @description 资源状态或幂等键冲突 */
      409: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': {
            /** Format: uri */
            type: string;
            title: string;
            status: number;
            detail: string;
            instance?: string;
            /** @enum {string} */
            code:
              | 'VALIDATION_ERROR'
              | 'UNSUPPORTED_PROTOCOL_VERSION'
              | 'INCOMPATIBLE_PROTOCOL_VERSION'
              | 'RESOURCE_NOT_FOUND'
              | 'RESOURCE_CONFLICT'
              | 'IDEMPOTENCY_CONFLICT'
              | 'SESSION_BUSY'
              | 'SESSION_STATE_INVALID'
              | 'MODEL_NOT_ALLOWED'
              | 'MODEL_UNAVAILABLE'
              | 'MODEL_LOCKED'
              | 'UPLOAD_LIMIT_EXCEEDED'
              | 'UNSUPPORTED_MEDIA_TYPE'
              | 'SOURCE_REFERENCE_INVALID'
              | 'ARTIFACT_REFERENCE_INVALID'
              | 'ARTIFACT_INTEGRITY_FAILED'
              | 'SKILL_PROTOCOL_ERROR'
              | 'SKILL_ENV_NOT_READY'
              | 'DEPENDENCY_MISSING'
              | 'UNAUTHENTICATED'
              | 'CANCEL_FAILED'
              | 'TURN_FAILED'
              | 'TURN_INTERRUPTED'
              | 'INTERNAL_ERROR';
            correlation_id: string;
            invalid_params?: {
              name: string;
              reason: string;
            }[];
            recovery_actions?: {
              code: string;
              label: string;
              href?: string;
            }[];
          };
        };
      };
    };
  };
  uploadSources: {
    parameters: {
      query?: never;
      header: {
        'idempotency-key': string;
      };
      path: {
        sessionId: string;
      };
      cookie?: never;
    };
    requestBody?: {
      content: {
        'multipart/form-data': {
          /** @enum {string} */
          api_version: '1.0';
          files: string[];
        };
      };
    };
    responses: {
      /** @description 不可变上传快照 */
      201: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': {
            /** @enum {string} */
            api_version: '1.0';
            sources: {
              source_ref: string;
              original_name: string;
              /** @enum {string} */
              media_type:
                | 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
                | 'application/vnd.ms-excel.sheet.macroEnabled.12'
                | 'text/csv';
              size_bytes: number;
              sha256: string;
              /** Format: date-time */
              created_at: string;
            }[];
          };
        };
      };
      /** @description 请求不符合公共契约 */
      400: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': {
            /** Format: uri */
            type: string;
            title: string;
            status: number;
            detail: string;
            instance?: string;
            /** @enum {string} */
            code:
              | 'VALIDATION_ERROR'
              | 'UNSUPPORTED_PROTOCOL_VERSION'
              | 'INCOMPATIBLE_PROTOCOL_VERSION'
              | 'RESOURCE_NOT_FOUND'
              | 'RESOURCE_CONFLICT'
              | 'IDEMPOTENCY_CONFLICT'
              | 'SESSION_BUSY'
              | 'SESSION_STATE_INVALID'
              | 'MODEL_NOT_ALLOWED'
              | 'MODEL_UNAVAILABLE'
              | 'MODEL_LOCKED'
              | 'UPLOAD_LIMIT_EXCEEDED'
              | 'UNSUPPORTED_MEDIA_TYPE'
              | 'SOURCE_REFERENCE_INVALID'
              | 'ARTIFACT_REFERENCE_INVALID'
              | 'ARTIFACT_INTEGRITY_FAILED'
              | 'SKILL_PROTOCOL_ERROR'
              | 'SKILL_ENV_NOT_READY'
              | 'DEPENDENCY_MISSING'
              | 'UNAUTHENTICATED'
              | 'CANCEL_FAILED'
              | 'TURN_FAILED'
              | 'TURN_INTERRUPTED'
              | 'INTERNAL_ERROR';
            correlation_id: string;
            invalid_params?: {
              name: string;
              reason: string;
            }[];
            recovery_actions?: {
              code: string;
              label: string;
              href?: string;
            }[];
          };
        };
      };
      /** @description 资源不存在或不属于当前会话 */
      404: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': {
            /** Format: uri */
            type: string;
            title: string;
            status: number;
            detail: string;
            instance?: string;
            /** @enum {string} */
            code:
              | 'VALIDATION_ERROR'
              | 'UNSUPPORTED_PROTOCOL_VERSION'
              | 'INCOMPATIBLE_PROTOCOL_VERSION'
              | 'RESOURCE_NOT_FOUND'
              | 'RESOURCE_CONFLICT'
              | 'IDEMPOTENCY_CONFLICT'
              | 'SESSION_BUSY'
              | 'SESSION_STATE_INVALID'
              | 'MODEL_NOT_ALLOWED'
              | 'MODEL_UNAVAILABLE'
              | 'MODEL_LOCKED'
              | 'UPLOAD_LIMIT_EXCEEDED'
              | 'UNSUPPORTED_MEDIA_TYPE'
              | 'SOURCE_REFERENCE_INVALID'
              | 'ARTIFACT_REFERENCE_INVALID'
              | 'ARTIFACT_INTEGRITY_FAILED'
              | 'SKILL_PROTOCOL_ERROR'
              | 'SKILL_ENV_NOT_READY'
              | 'DEPENDENCY_MISSING'
              | 'UNAUTHENTICATED'
              | 'CANCEL_FAILED'
              | 'TURN_FAILED'
              | 'TURN_INTERRUPTED'
              | 'INTERNAL_ERROR';
            correlation_id: string;
            invalid_params?: {
              name: string;
              reason: string;
            }[];
            recovery_actions?: {
              code: string;
              label: string;
              href?: string;
            }[];
          };
        };
      };
      /** @description 资源状态或幂等键冲突 */
      409: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': {
            /** Format: uri */
            type: string;
            title: string;
            status: number;
            detail: string;
            instance?: string;
            /** @enum {string} */
            code:
              | 'VALIDATION_ERROR'
              | 'UNSUPPORTED_PROTOCOL_VERSION'
              | 'INCOMPATIBLE_PROTOCOL_VERSION'
              | 'RESOURCE_NOT_FOUND'
              | 'RESOURCE_CONFLICT'
              | 'IDEMPOTENCY_CONFLICT'
              | 'SESSION_BUSY'
              | 'SESSION_STATE_INVALID'
              | 'MODEL_NOT_ALLOWED'
              | 'MODEL_UNAVAILABLE'
              | 'MODEL_LOCKED'
              | 'UPLOAD_LIMIT_EXCEEDED'
              | 'UNSUPPORTED_MEDIA_TYPE'
              | 'SOURCE_REFERENCE_INVALID'
              | 'ARTIFACT_REFERENCE_INVALID'
              | 'ARTIFACT_INTEGRITY_FAILED'
              | 'SKILL_PROTOCOL_ERROR'
              | 'SKILL_ENV_NOT_READY'
              | 'DEPENDENCY_MISSING'
              | 'UNAUTHENTICATED'
              | 'CANCEL_FAILED'
              | 'TURN_FAILED'
              | 'TURN_INTERRUPTED'
              | 'INTERNAL_ERROR';
            correlation_id: string;
            invalid_params?: {
              name: string;
              reason: string;
            }[];
            recovery_actions?: {
              code: string;
              label: string;
              href?: string;
            }[];
          };
        };
      };
    };
  };
  submitMessage: {
    parameters: {
      query?: never;
      header: {
        'idempotency-key': string;
      };
      path: {
        sessionId: string;
      };
      cookie?: never;
    };
    requestBody?: {
      content: {
        'application/json':
          | {
              /** @enum {string} */
              api_version: '1.0';
              /** @enum {string} */
              kind: 'message';
              content: string;
              source_refs: string[];
            }
          | {
              /** @enum {string} */
              api_version: '1.0';
              /** @enum {string} */
              kind: 'question_answers';
              question_set_id: string;
              answers: {
                question_id: string;
                answer: string;
              }[];
            };
      };
    };
    responses: {
      /** @description 已接受或幂等重放的 turn */
      202: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': {
            /** @enum {string} */
            api_version: '1.0';
            turn: {
              turn_id: string;
              /** @enum {string} */
              status:
                | 'queued'
                | 'running'
                | 'needs_input'
                | 'completed'
                | 'partial'
                | 'failed'
                | 'cancelling'
                | 'cancelled'
                | 'interrupted';
              /** Format: date-time */
              started_at?: string;
              /** Format: date-time */
              finished_at?: string;
              result_refs: {
                artifact_id: string;
                artifact_type: string;
                /** @enum {string} */
                status: 'succeeded' | 'partial';
                manifest_url: string;
              }[];
              execution_plan?: {
                plan_id: string;
                title?: string;
                nodes: {
                  id: string;
                  title: string;
                  skill_name: string;
                  depends_on: string[];
                  parallel_group?: string;
                }[];
              };
              problem?: {
                /** Format: uri */
                type: string;
                title: string;
                status: number;
                detail: string;
                instance?: string;
                /** @enum {string} */
                code:
                  | 'VALIDATION_ERROR'
                  | 'UNSUPPORTED_PROTOCOL_VERSION'
                  | 'INCOMPATIBLE_PROTOCOL_VERSION'
                  | 'RESOURCE_NOT_FOUND'
                  | 'RESOURCE_CONFLICT'
                  | 'IDEMPOTENCY_CONFLICT'
                  | 'SESSION_BUSY'
                  | 'SESSION_STATE_INVALID'
                  | 'MODEL_NOT_ALLOWED'
                  | 'MODEL_UNAVAILABLE'
                  | 'MODEL_LOCKED'
                  | 'UPLOAD_LIMIT_EXCEEDED'
                  | 'UNSUPPORTED_MEDIA_TYPE'
                  | 'SOURCE_REFERENCE_INVALID'
                  | 'ARTIFACT_REFERENCE_INVALID'
                  | 'ARTIFACT_INTEGRITY_FAILED'
                  | 'SKILL_PROTOCOL_ERROR'
                  | 'SKILL_ENV_NOT_READY'
                  | 'DEPENDENCY_MISSING'
                  | 'UNAUTHENTICATED'
                  | 'CANCEL_FAILED'
                  | 'TURN_FAILED'
                  | 'TURN_INTERRUPTED'
                  | 'INTERNAL_ERROR';
                correlation_id: string;
                invalid_params?: {
                  name: string;
                  reason: string;
                }[];
                recovery_actions?: {
                  code: string;
                  label: string;
                  href?: string;
                }[];
              };
            };
            replayed: boolean;
          };
        };
      };
      /** @description 请求不符合公共契约 */
      400: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': {
            /** Format: uri */
            type: string;
            title: string;
            status: number;
            detail: string;
            instance?: string;
            /** @enum {string} */
            code:
              | 'VALIDATION_ERROR'
              | 'UNSUPPORTED_PROTOCOL_VERSION'
              | 'INCOMPATIBLE_PROTOCOL_VERSION'
              | 'RESOURCE_NOT_FOUND'
              | 'RESOURCE_CONFLICT'
              | 'IDEMPOTENCY_CONFLICT'
              | 'SESSION_BUSY'
              | 'SESSION_STATE_INVALID'
              | 'MODEL_NOT_ALLOWED'
              | 'MODEL_UNAVAILABLE'
              | 'MODEL_LOCKED'
              | 'UPLOAD_LIMIT_EXCEEDED'
              | 'UNSUPPORTED_MEDIA_TYPE'
              | 'SOURCE_REFERENCE_INVALID'
              | 'ARTIFACT_REFERENCE_INVALID'
              | 'ARTIFACT_INTEGRITY_FAILED'
              | 'SKILL_PROTOCOL_ERROR'
              | 'SKILL_ENV_NOT_READY'
              | 'DEPENDENCY_MISSING'
              | 'UNAUTHENTICATED'
              | 'CANCEL_FAILED'
              | 'TURN_FAILED'
              | 'TURN_INTERRUPTED'
              | 'INTERNAL_ERROR';
            correlation_id: string;
            invalid_params?: {
              name: string;
              reason: string;
            }[];
            recovery_actions?: {
              code: string;
              label: string;
              href?: string;
            }[];
          };
        };
      };
      /** @description 资源不存在或不属于当前会话 */
      404: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': {
            /** Format: uri */
            type: string;
            title: string;
            status: number;
            detail: string;
            instance?: string;
            /** @enum {string} */
            code:
              | 'VALIDATION_ERROR'
              | 'UNSUPPORTED_PROTOCOL_VERSION'
              | 'INCOMPATIBLE_PROTOCOL_VERSION'
              | 'RESOURCE_NOT_FOUND'
              | 'RESOURCE_CONFLICT'
              | 'IDEMPOTENCY_CONFLICT'
              | 'SESSION_BUSY'
              | 'SESSION_STATE_INVALID'
              | 'MODEL_NOT_ALLOWED'
              | 'MODEL_UNAVAILABLE'
              | 'MODEL_LOCKED'
              | 'UPLOAD_LIMIT_EXCEEDED'
              | 'UNSUPPORTED_MEDIA_TYPE'
              | 'SOURCE_REFERENCE_INVALID'
              | 'ARTIFACT_REFERENCE_INVALID'
              | 'ARTIFACT_INTEGRITY_FAILED'
              | 'SKILL_PROTOCOL_ERROR'
              | 'SKILL_ENV_NOT_READY'
              | 'DEPENDENCY_MISSING'
              | 'UNAUTHENTICATED'
              | 'CANCEL_FAILED'
              | 'TURN_FAILED'
              | 'TURN_INTERRUPTED'
              | 'INTERNAL_ERROR';
            correlation_id: string;
            invalid_params?: {
              name: string;
              reason: string;
            }[];
            recovery_actions?: {
              code: string;
              label: string;
              href?: string;
            }[];
          };
        };
      };
      /** @description 资源状态或幂等键冲突 */
      409: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': {
            /** Format: uri */
            type: string;
            title: string;
            status: number;
            detail: string;
            instance?: string;
            /** @enum {string} */
            code:
              | 'VALIDATION_ERROR'
              | 'UNSUPPORTED_PROTOCOL_VERSION'
              | 'INCOMPATIBLE_PROTOCOL_VERSION'
              | 'RESOURCE_NOT_FOUND'
              | 'RESOURCE_CONFLICT'
              | 'IDEMPOTENCY_CONFLICT'
              | 'SESSION_BUSY'
              | 'SESSION_STATE_INVALID'
              | 'MODEL_NOT_ALLOWED'
              | 'MODEL_UNAVAILABLE'
              | 'MODEL_LOCKED'
              | 'UPLOAD_LIMIT_EXCEEDED'
              | 'UNSUPPORTED_MEDIA_TYPE'
              | 'SOURCE_REFERENCE_INVALID'
              | 'ARTIFACT_REFERENCE_INVALID'
              | 'ARTIFACT_INTEGRITY_FAILED'
              | 'SKILL_PROTOCOL_ERROR'
              | 'SKILL_ENV_NOT_READY'
              | 'DEPENDENCY_MISSING'
              | 'UNAUTHENTICATED'
              | 'CANCEL_FAILED'
              | 'TURN_FAILED'
              | 'TURN_INTERRUPTED'
              | 'INTERNAL_ERROR';
            correlation_id: string;
            invalid_params?: {
              name: string;
              reason: string;
            }[];
            recovery_actions?: {
              code: string;
              label: string;
              href?: string;
            }[];
          };
        };
      };
    };
  };
  cancelTurn: {
    parameters: {
      query?: never;
      header: {
        'idempotency-key': string;
      };
      path: {
        sessionId: string;
      };
      cookie?: never;
    };
    requestBody?: {
      content: {
        'application/json': {
          /** @enum {string} */
          api_version: '1.0';
          reason?: string;
        };
      };
    };
    responses: {
      /** @description 已确认实际执行停止 */
      200: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': {
            /** @enum {string} */
            api_version: '1.0';
            turn: {
              turn_id: string;
              /** @enum {string} */
              status:
                | 'queued'
                | 'running'
                | 'needs_input'
                | 'completed'
                | 'partial'
                | 'failed'
                | 'cancelling'
                | 'cancelled'
                | 'interrupted';
              /** Format: date-time */
              started_at?: string;
              /** Format: date-time */
              finished_at?: string;
              result_refs: {
                artifact_id: string;
                artifact_type: string;
                /** @enum {string} */
                status: 'succeeded' | 'partial';
                manifest_url: string;
              }[];
              execution_plan?: {
                plan_id: string;
                title?: string;
                nodes: {
                  id: string;
                  title: string;
                  skill_name: string;
                  depends_on: string[];
                  parallel_group?: string;
                }[];
              };
              problem?: {
                /** Format: uri */
                type: string;
                title: string;
                status: number;
                detail: string;
                instance?: string;
                /** @enum {string} */
                code:
                  | 'VALIDATION_ERROR'
                  | 'UNSUPPORTED_PROTOCOL_VERSION'
                  | 'INCOMPATIBLE_PROTOCOL_VERSION'
                  | 'RESOURCE_NOT_FOUND'
                  | 'RESOURCE_CONFLICT'
                  | 'IDEMPOTENCY_CONFLICT'
                  | 'SESSION_BUSY'
                  | 'SESSION_STATE_INVALID'
                  | 'MODEL_NOT_ALLOWED'
                  | 'MODEL_UNAVAILABLE'
                  | 'MODEL_LOCKED'
                  | 'UPLOAD_LIMIT_EXCEEDED'
                  | 'UNSUPPORTED_MEDIA_TYPE'
                  | 'SOURCE_REFERENCE_INVALID'
                  | 'ARTIFACT_REFERENCE_INVALID'
                  | 'ARTIFACT_INTEGRITY_FAILED'
                  | 'SKILL_PROTOCOL_ERROR'
                  | 'SKILL_ENV_NOT_READY'
                  | 'DEPENDENCY_MISSING'
                  | 'UNAUTHENTICATED'
                  | 'CANCEL_FAILED'
                  | 'TURN_FAILED'
                  | 'TURN_INTERRUPTED'
                  | 'INTERNAL_ERROR';
                correlation_id: string;
                invalid_params?: {
                  name: string;
                  reason: string;
                }[];
                recovery_actions?: {
                  code: string;
                  label: string;
                  href?: string;
                }[];
              };
            };
            replayed: boolean;
          };
        };
      };
      /** @description 请求不符合公共契约 */
      400: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': {
            /** Format: uri */
            type: string;
            title: string;
            status: number;
            detail: string;
            instance?: string;
            /** @enum {string} */
            code:
              | 'VALIDATION_ERROR'
              | 'UNSUPPORTED_PROTOCOL_VERSION'
              | 'INCOMPATIBLE_PROTOCOL_VERSION'
              | 'RESOURCE_NOT_FOUND'
              | 'RESOURCE_CONFLICT'
              | 'IDEMPOTENCY_CONFLICT'
              | 'SESSION_BUSY'
              | 'SESSION_STATE_INVALID'
              | 'MODEL_NOT_ALLOWED'
              | 'MODEL_UNAVAILABLE'
              | 'MODEL_LOCKED'
              | 'UPLOAD_LIMIT_EXCEEDED'
              | 'UNSUPPORTED_MEDIA_TYPE'
              | 'SOURCE_REFERENCE_INVALID'
              | 'ARTIFACT_REFERENCE_INVALID'
              | 'ARTIFACT_INTEGRITY_FAILED'
              | 'SKILL_PROTOCOL_ERROR'
              | 'SKILL_ENV_NOT_READY'
              | 'DEPENDENCY_MISSING'
              | 'UNAUTHENTICATED'
              | 'CANCEL_FAILED'
              | 'TURN_FAILED'
              | 'TURN_INTERRUPTED'
              | 'INTERNAL_ERROR';
            correlation_id: string;
            invalid_params?: {
              name: string;
              reason: string;
            }[];
            recovery_actions?: {
              code: string;
              label: string;
              href?: string;
            }[];
          };
        };
      };
      /** @description 资源不存在或不属于当前会话 */
      404: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': {
            /** Format: uri */
            type: string;
            title: string;
            status: number;
            detail: string;
            instance?: string;
            /** @enum {string} */
            code:
              | 'VALIDATION_ERROR'
              | 'UNSUPPORTED_PROTOCOL_VERSION'
              | 'INCOMPATIBLE_PROTOCOL_VERSION'
              | 'RESOURCE_NOT_FOUND'
              | 'RESOURCE_CONFLICT'
              | 'IDEMPOTENCY_CONFLICT'
              | 'SESSION_BUSY'
              | 'SESSION_STATE_INVALID'
              | 'MODEL_NOT_ALLOWED'
              | 'MODEL_UNAVAILABLE'
              | 'MODEL_LOCKED'
              | 'UPLOAD_LIMIT_EXCEEDED'
              | 'UNSUPPORTED_MEDIA_TYPE'
              | 'SOURCE_REFERENCE_INVALID'
              | 'ARTIFACT_REFERENCE_INVALID'
              | 'ARTIFACT_INTEGRITY_FAILED'
              | 'SKILL_PROTOCOL_ERROR'
              | 'SKILL_ENV_NOT_READY'
              | 'DEPENDENCY_MISSING'
              | 'UNAUTHENTICATED'
              | 'CANCEL_FAILED'
              | 'TURN_FAILED'
              | 'TURN_INTERRUPTED'
              | 'INTERNAL_ERROR';
            correlation_id: string;
            invalid_params?: {
              name: string;
              reason: string;
            }[];
            recovery_actions?: {
              code: string;
              label: string;
              href?: string;
            }[];
          };
        };
      };
      /** @description 资源状态或幂等键冲突 */
      409: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': {
            /** Format: uri */
            type: string;
            title: string;
            status: number;
            detail: string;
            instance?: string;
            /** @enum {string} */
            code:
              | 'VALIDATION_ERROR'
              | 'UNSUPPORTED_PROTOCOL_VERSION'
              | 'INCOMPATIBLE_PROTOCOL_VERSION'
              | 'RESOURCE_NOT_FOUND'
              | 'RESOURCE_CONFLICT'
              | 'IDEMPOTENCY_CONFLICT'
              | 'SESSION_BUSY'
              | 'SESSION_STATE_INVALID'
              | 'MODEL_NOT_ALLOWED'
              | 'MODEL_UNAVAILABLE'
              | 'MODEL_LOCKED'
              | 'UPLOAD_LIMIT_EXCEEDED'
              | 'UNSUPPORTED_MEDIA_TYPE'
              | 'SOURCE_REFERENCE_INVALID'
              | 'ARTIFACT_REFERENCE_INVALID'
              | 'ARTIFACT_INTEGRITY_FAILED'
              | 'SKILL_PROTOCOL_ERROR'
              | 'SKILL_ENV_NOT_READY'
              | 'DEPENDENCY_MISSING'
              | 'UNAUTHENTICATED'
              | 'CANCEL_FAILED'
              | 'TURN_FAILED'
              | 'TURN_INTERRUPTED'
              | 'INTERNAL_ERROR';
            correlation_id: string;
            invalid_params?: {
              name: string;
              reason: string;
            }[];
            recovery_actions?: {
              code: string;
              label: string;
              href?: string;
            }[];
          };
        };
      };
    };
  };
  streamSessionEvents: {
    parameters: {
      query?: {
        after_event_id?: string;
      };
      header?: {
        'last-event-id'?: string;
      };
      path: {
        sessionId: string;
      };
      cookie?: never;
    };
    requestBody?: never;
    responses: {
      /** @description 按 event_id 有序且可续传的 SSE；data 为 SseEvent */
      200: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'text/event-stream': string;
        };
      };
      /** @description 请求不符合公共契约 */
      400: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': {
            /** Format: uri */
            type: string;
            title: string;
            status: number;
            detail: string;
            instance?: string;
            /** @enum {string} */
            code:
              | 'VALIDATION_ERROR'
              | 'UNSUPPORTED_PROTOCOL_VERSION'
              | 'INCOMPATIBLE_PROTOCOL_VERSION'
              | 'RESOURCE_NOT_FOUND'
              | 'RESOURCE_CONFLICT'
              | 'IDEMPOTENCY_CONFLICT'
              | 'SESSION_BUSY'
              | 'SESSION_STATE_INVALID'
              | 'MODEL_NOT_ALLOWED'
              | 'MODEL_UNAVAILABLE'
              | 'MODEL_LOCKED'
              | 'UPLOAD_LIMIT_EXCEEDED'
              | 'UNSUPPORTED_MEDIA_TYPE'
              | 'SOURCE_REFERENCE_INVALID'
              | 'ARTIFACT_REFERENCE_INVALID'
              | 'ARTIFACT_INTEGRITY_FAILED'
              | 'SKILL_PROTOCOL_ERROR'
              | 'SKILL_ENV_NOT_READY'
              | 'DEPENDENCY_MISSING'
              | 'UNAUTHENTICATED'
              | 'CANCEL_FAILED'
              | 'TURN_FAILED'
              | 'TURN_INTERRUPTED'
              | 'INTERNAL_ERROR';
            correlation_id: string;
            invalid_params?: {
              name: string;
              reason: string;
            }[];
            recovery_actions?: {
              code: string;
              label: string;
              href?: string;
            }[];
          };
        };
      };
      /** @description 资源不存在或不属于当前会话 */
      404: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': {
            /** Format: uri */
            type: string;
            title: string;
            status: number;
            detail: string;
            instance?: string;
            /** @enum {string} */
            code:
              | 'VALIDATION_ERROR'
              | 'UNSUPPORTED_PROTOCOL_VERSION'
              | 'INCOMPATIBLE_PROTOCOL_VERSION'
              | 'RESOURCE_NOT_FOUND'
              | 'RESOURCE_CONFLICT'
              | 'IDEMPOTENCY_CONFLICT'
              | 'SESSION_BUSY'
              | 'SESSION_STATE_INVALID'
              | 'MODEL_NOT_ALLOWED'
              | 'MODEL_UNAVAILABLE'
              | 'MODEL_LOCKED'
              | 'UPLOAD_LIMIT_EXCEEDED'
              | 'UNSUPPORTED_MEDIA_TYPE'
              | 'SOURCE_REFERENCE_INVALID'
              | 'ARTIFACT_REFERENCE_INVALID'
              | 'ARTIFACT_INTEGRITY_FAILED'
              | 'SKILL_PROTOCOL_ERROR'
              | 'SKILL_ENV_NOT_READY'
              | 'DEPENDENCY_MISSING'
              | 'UNAUTHENTICATED'
              | 'CANCEL_FAILED'
              | 'TURN_FAILED'
              | 'TURN_INTERRUPTED'
              | 'INTERNAL_ERROR';
            correlation_id: string;
            invalid_params?: {
              name: string;
              reason: string;
            }[];
            recovery_actions?: {
              code: string;
              label: string;
              href?: string;
            }[];
          };
        };
      };
    };
  };
  getTurnResult: {
    parameters: {
      query?: never;
      header?: never;
      path: {
        sessionId: string;
        turnId: string;
      };
      cookie?: never;
    };
    requestBody?: never;
    responses: {
      /** @description 持久化 turn 状态与结果引用 */
      200: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': {
            /** @enum {string} */
            api_version: '1.0';
            turn: {
              turn_id: string;
              /** @enum {string} */
              status:
                | 'queued'
                | 'running'
                | 'needs_input'
                | 'completed'
                | 'partial'
                | 'failed'
                | 'cancelling'
                | 'cancelled'
                | 'interrupted';
              /** Format: date-time */
              started_at?: string;
              /** Format: date-time */
              finished_at?: string;
              result_refs: {
                artifact_id: string;
                artifact_type: string;
                /** @enum {string} */
                status: 'succeeded' | 'partial';
                manifest_url: string;
              }[];
              execution_plan?: {
                plan_id: string;
                title?: string;
                nodes: {
                  id: string;
                  title: string;
                  skill_name: string;
                  depends_on: string[];
                  parallel_group?: string;
                }[];
              };
              problem?: {
                /** Format: uri */
                type: string;
                title: string;
                status: number;
                detail: string;
                instance?: string;
                /** @enum {string} */
                code:
                  | 'VALIDATION_ERROR'
                  | 'UNSUPPORTED_PROTOCOL_VERSION'
                  | 'INCOMPATIBLE_PROTOCOL_VERSION'
                  | 'RESOURCE_NOT_FOUND'
                  | 'RESOURCE_CONFLICT'
                  | 'IDEMPOTENCY_CONFLICT'
                  | 'SESSION_BUSY'
                  | 'SESSION_STATE_INVALID'
                  | 'MODEL_NOT_ALLOWED'
                  | 'MODEL_UNAVAILABLE'
                  | 'MODEL_LOCKED'
                  | 'UPLOAD_LIMIT_EXCEEDED'
                  | 'UNSUPPORTED_MEDIA_TYPE'
                  | 'SOURCE_REFERENCE_INVALID'
                  | 'ARTIFACT_REFERENCE_INVALID'
                  | 'ARTIFACT_INTEGRITY_FAILED'
                  | 'SKILL_PROTOCOL_ERROR'
                  | 'SKILL_ENV_NOT_READY'
                  | 'DEPENDENCY_MISSING'
                  | 'UNAUTHENTICATED'
                  | 'CANCEL_FAILED'
                  | 'TURN_FAILED'
                  | 'TURN_INTERRUPTED'
                  | 'INTERNAL_ERROR';
                correlation_id: string;
                invalid_params?: {
                  name: string;
                  reason: string;
                }[];
                recovery_actions?: {
                  code: string;
                  label: string;
                  href?: string;
                }[];
              };
            };
          };
        };
      };
      /** @description 资源不存在或不属于当前会话 */
      404: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': {
            /** Format: uri */
            type: string;
            title: string;
            status: number;
            detail: string;
            instance?: string;
            /** @enum {string} */
            code:
              | 'VALIDATION_ERROR'
              | 'UNSUPPORTED_PROTOCOL_VERSION'
              | 'INCOMPATIBLE_PROTOCOL_VERSION'
              | 'RESOURCE_NOT_FOUND'
              | 'RESOURCE_CONFLICT'
              | 'IDEMPOTENCY_CONFLICT'
              | 'SESSION_BUSY'
              | 'SESSION_STATE_INVALID'
              | 'MODEL_NOT_ALLOWED'
              | 'MODEL_UNAVAILABLE'
              | 'MODEL_LOCKED'
              | 'UPLOAD_LIMIT_EXCEEDED'
              | 'UNSUPPORTED_MEDIA_TYPE'
              | 'SOURCE_REFERENCE_INVALID'
              | 'ARTIFACT_REFERENCE_INVALID'
              | 'ARTIFACT_INTEGRITY_FAILED'
              | 'SKILL_PROTOCOL_ERROR'
              | 'SKILL_ENV_NOT_READY'
              | 'DEPENDENCY_MISSING'
              | 'UNAUTHENTICATED'
              | 'CANCEL_FAILED'
              | 'TURN_FAILED'
              | 'TURN_INTERRUPTED'
              | 'INTERNAL_ERROR';
            correlation_id: string;
            invalid_params?: {
              name: string;
              reason: string;
            }[];
            recovery_actions?: {
              code: string;
              label: string;
              href?: string;
            }[];
          };
        };
      };
    };
  };
  listArtifacts: {
    parameters: {
      query?: {
        turn_id?: string;
      };
      header?: never;
      path: {
        sessionId: string;
      };
      cookie?: never;
    };
    requestBody?: never;
    responses: {
      /** @description 当前会话的受控 artifact 元数据 */
      200: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': {
            /** @enum {string} */
            api_version: '1.0';
            artifacts: {
              /** @enum {string} */
              schema_version: '1.0';
              artifact_id: string;
              artifact_type: string;
              producer: {
                skill_name: string;
                job_id: string;
              };
              source_ids: string[];
              /** @enum {string} */
              status: 'succeeded' | 'partial';
              files: {
                name: string;
                media_type: string;
                size_bytes: number;
                sha256: string;
                role: string;
                content_url: string;
              }[];
              summary: {
                [key: string]: unknown;
              };
              warnings: string[];
            }[];
          };
        };
      };
      /** @description 资源不存在或不属于当前会话 */
      404: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': {
            /** Format: uri */
            type: string;
            title: string;
            status: number;
            detail: string;
            instance?: string;
            /** @enum {string} */
            code:
              | 'VALIDATION_ERROR'
              | 'UNSUPPORTED_PROTOCOL_VERSION'
              | 'INCOMPATIBLE_PROTOCOL_VERSION'
              | 'RESOURCE_NOT_FOUND'
              | 'RESOURCE_CONFLICT'
              | 'IDEMPOTENCY_CONFLICT'
              | 'SESSION_BUSY'
              | 'SESSION_STATE_INVALID'
              | 'MODEL_NOT_ALLOWED'
              | 'MODEL_UNAVAILABLE'
              | 'MODEL_LOCKED'
              | 'UPLOAD_LIMIT_EXCEEDED'
              | 'UNSUPPORTED_MEDIA_TYPE'
              | 'SOURCE_REFERENCE_INVALID'
              | 'ARTIFACT_REFERENCE_INVALID'
              | 'ARTIFACT_INTEGRITY_FAILED'
              | 'SKILL_PROTOCOL_ERROR'
              | 'SKILL_ENV_NOT_READY'
              | 'DEPENDENCY_MISSING'
              | 'UNAUTHENTICATED'
              | 'CANCEL_FAILED'
              | 'TURN_FAILED'
              | 'TURN_INTERRUPTED'
              | 'INTERNAL_ERROR';
            correlation_id: string;
            invalid_params?: {
              name: string;
              reason: string;
            }[];
            recovery_actions?: {
              code: string;
              label: string;
              href?: string;
            }[];
          };
        };
      };
    };
  };
  downloadArtifactContent: {
    parameters: {
      query?: never;
      header?: never;
      path: {
        artifactId: string;
      };
      cookie?: never;
    };
    requestBody?: never;
    responses: {
      /** @description 经归属、大小、哈希和媒体类型校验的 artifact 内容 */
      200: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/octet-stream': string;
        };
      };
      /** @description 资源不存在或不属于当前会话 */
      404: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': {
            /** Format: uri */
            type: string;
            title: string;
            status: number;
            detail: string;
            instance?: string;
            /** @enum {string} */
            code:
              | 'VALIDATION_ERROR'
              | 'UNSUPPORTED_PROTOCOL_VERSION'
              | 'INCOMPATIBLE_PROTOCOL_VERSION'
              | 'RESOURCE_NOT_FOUND'
              | 'RESOURCE_CONFLICT'
              | 'IDEMPOTENCY_CONFLICT'
              | 'SESSION_BUSY'
              | 'SESSION_STATE_INVALID'
              | 'MODEL_NOT_ALLOWED'
              | 'MODEL_UNAVAILABLE'
              | 'MODEL_LOCKED'
              | 'UPLOAD_LIMIT_EXCEEDED'
              | 'UNSUPPORTED_MEDIA_TYPE'
              | 'SOURCE_REFERENCE_INVALID'
              | 'ARTIFACT_REFERENCE_INVALID'
              | 'ARTIFACT_INTEGRITY_FAILED'
              | 'SKILL_PROTOCOL_ERROR'
              | 'SKILL_ENV_NOT_READY'
              | 'DEPENDENCY_MISSING'
              | 'UNAUTHENTICATED'
              | 'CANCEL_FAILED'
              | 'TURN_FAILED'
              | 'TURN_INTERRUPTED'
              | 'INTERNAL_ERROR';
            correlation_id: string;
            invalid_params?: {
              name: string;
              reason: string;
            }[];
            recovery_actions?: {
              code: string;
              label: string;
              href?: string;
            }[];
          };
        };
      };
      /** @description 资源状态或幂等键冲突 */
      409: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/problem+json': {
            /** Format: uri */
            type: string;
            title: string;
            status: number;
            detail: string;
            instance?: string;
            /** @enum {string} */
            code:
              | 'VALIDATION_ERROR'
              | 'UNSUPPORTED_PROTOCOL_VERSION'
              | 'INCOMPATIBLE_PROTOCOL_VERSION'
              | 'RESOURCE_NOT_FOUND'
              | 'RESOURCE_CONFLICT'
              | 'IDEMPOTENCY_CONFLICT'
              | 'SESSION_BUSY'
              | 'SESSION_STATE_INVALID'
              | 'MODEL_NOT_ALLOWED'
              | 'MODEL_UNAVAILABLE'
              | 'MODEL_LOCKED'
              | 'UPLOAD_LIMIT_EXCEEDED'
              | 'UNSUPPORTED_MEDIA_TYPE'
              | 'SOURCE_REFERENCE_INVALID'
              | 'ARTIFACT_REFERENCE_INVALID'
              | 'ARTIFACT_INTEGRITY_FAILED'
              | 'SKILL_PROTOCOL_ERROR'
              | 'SKILL_ENV_NOT_READY'
              | 'DEPENDENCY_MISSING'
              | 'UNAUTHENTICATED'
              | 'CANCEL_FAILED'
              | 'TURN_FAILED'
              | 'TURN_INTERRUPTED'
              | 'INTERNAL_ERROR';
            correlation_id: string;
            invalid_params?: {
              name: string;
              reason: string;
            }[];
            recovery_actions?: {
              code: string;
              label: string;
              href?: string;
            }[];
          };
        };
      };
    };
  };
}
