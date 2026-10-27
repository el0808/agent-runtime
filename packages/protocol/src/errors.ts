export const ERROR_CODES = {
  INVALID_INPUT: "INVALID_INPUT",
  NOT_FOUND: "NOT_FOUND",
  PERMISSION_DENIED: "PERMISSION_DENIED",
  CONFLICT: "CONFLICT",
  DEPENDENCY_UNAVAILABLE: "DEPENDENCY_UNAVAILABLE",
  INTERNAL: "INTERNAL"
} as const;

export type ErrorCode = (typeof ERROR_CODES)[keyof typeof ERROR_CODES];

export interface RuntimeErrorInit {
  code: ErrorCode;
  message: string;
  details?: Readonly<Record<string, unknown>>;
  cause?: unknown;
}

export interface RuntimeErrorRecord {
  code: ErrorCode;
  message: string;
  details?: Readonly<Record<string, unknown>>;
}

export class RuntimeError extends Error {
  readonly code: ErrorCode;
  readonly details?: Readonly<Record<string, unknown>>;

  constructor(init: RuntimeErrorInit) {
    super(init.message, init.cause === undefined ? undefined : { cause: init.cause });
    this.name = "RuntimeError";
    this.code = init.code;
    if (init.details !== undefined) {
      this.details = init.details;
    }
  }

  toJSON(): RuntimeErrorRecord {
    const record: RuntimeErrorRecord = {
      code: this.code,
      message: this.message
    };
    if (this.details !== undefined) {
      record.details = this.details;
    }
    return record;
  }
}
