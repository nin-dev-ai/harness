/** Stable error codes. Callers branch on `code`, never on message text. */
export type ErrorCode =
  | "ILLEGAL_TRANSITION"
  | "VALIDATION"
  | "CONFIG"
  | "NOT_FOUND"
  | "CONFLICT"
  | "POLICY_DENIED"
  | "DAEMON_UNREACHABLE"
  | "INTERNAL";

/** Base error for everything harness throws on purpose. */
export class HarnessError extends Error {
  constructor(
    readonly code: ErrorCode,
    message: string,
    readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "HarnessError";
  }
}

/** Thrown by the state machines when a transition is not in the table. */
export class IllegalTransitionError extends HarnessError {
  constructor(machine: string, from: string, to: string) {
    super("ILLEGAL_TRANSITION", `${machine}: illegal transition ${from} -> ${to}`, { machine, from, to });
    this.name = "IllegalTransitionError";
  }
}

/** A single validation problem, with a location when one is known (file, line). */
export interface ValidationIssue {
  path: string;
  message: string;
  file?: string;
  line?: number;
}

/** Thrown when external input fails its schema. */
export class ValidationError extends HarnessError {
  constructor(
    message: string,
    readonly issues: ValidationIssue[],
  ) {
    super("VALIDATION", message, { issues });
    this.name = "ValidationError";
  }
}

export function isHarnessError(e: unknown): e is HarnessError {
  return e instanceof HarnessError;
}
