export function asError(reason: unknown): Error {
  return reason instanceof Error ? reason : new Error(String(reason));
}

export class BackpressureError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BackpressureError";
  }
}
