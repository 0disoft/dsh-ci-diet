/** Raised when one bounded operation runs longer than its overall budget. */
export class DeadlineExceededError extends Error {
  readonly code = "DEADLINE_EXCEEDED";
  readonly timeoutMs: number;

  constructor(operation: string, timeoutMs: number) {
    super(operation + " exceeded its " + String(timeoutMs) + "ms deadline");
    this.name = "DeadlineExceededError";
    this.timeoutMs = timeoutMs;
  }
}

export interface Deadline {
  readonly signal: AbortSignal;
  readonly timedOut: () => boolean;
  readonly dispose: () => void;
}

/**
 * Combine the caller's cancellation signal with one overall timeout. A caller
 * abort keeps its own reason; the timeout aborts with DeadlineExceededError so
 * the CLI can distinguish "user cancelled" from "the operation ran too long".
 */
export function withDeadline(parent: AbortSignal | undefined, timeoutMs: number, operation = "operation"): Deadline {
  const controller = new AbortController();
  let expired = false;
  const onParentAbort = (): void => {
    controller.abort(parent?.reason);
  };
  if (parent?.aborted === true) {
    onParentAbort();
  } else {
    parent?.addEventListener("abort", onParentAbort, { once: true });
  }
  const timer = setTimeout(() => {
    expired = true;
    controller.abort(new DeadlineExceededError(operation, timeoutMs));
  }, timeoutMs);
  if (typeof timer.unref === "function") timer.unref();
  let disposed = false;
  return {
    signal: controller.signal,
    timedOut: () => expired,
    dispose: () => {
      if (disposed) return;
      disposed = true;
      clearTimeout(timer);
      parent?.removeEventListener("abort", onParentAbort);
    },
  };
}
