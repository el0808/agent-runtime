export const LOG_LEVELS = ["debug", "info", "warn", "error"] as const;

export type LogLevel = (typeof LOG_LEVELS)[number];
export type LogContext = Readonly<Record<string, unknown>>;

export interface LogRecord {
  timestamp: string;
  level: LogLevel;
  event: string;
  message: string;
  context?: LogContext;
}

export interface CreateLogRecordInput {
  level: LogLevel;
  event: string;
  message: string;
  context?: LogContext;
}

export function createLogRecord(input: CreateLogRecordInput, now = new Date()): LogRecord {
  const record: LogRecord = {
    timestamp: now.toISOString(),
    level: input.level,
    event: input.event,
    message: input.message
  };
  if (input.context !== undefined) {
    record.context = input.context;
  }
  return record;
}

export function serializeLogRecord(record: LogRecord): string {
  return JSON.stringify(record);
}
