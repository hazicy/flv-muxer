import { asError, BackpressureError } from "./errors";

/** Serializes writes and counts queued bytes, including the in-flight write. */
export class OutputWriter {
  #writer: WritableStreamDefaultWriter<Uint8Array>;
  #queue: Uint8Array[] = [];
  #pendingBytes = 0;
  #writing = false;
  #released = false;
  #error?: Error;
  #drained?: {
    resolve: () => void;
    reject: (error: Error) => void;
    promise: Promise<void>;
  };

  constructor(
    writable: WritableStream<Uint8Array>,
    private readonly maxBytes: number,
    private readonly onError: (error: Error) => void
  ) {
    this.#writer = writable.getWriter();

    // Observe sink errors even when no write is currently pending.
    void this.#writer.closed.catch((reason) => this.fail(asError(reason)));
  }

  get pressured(): boolean {
    return this.#pendingBytes >= this.maxBytes / 2;
  }

  enqueue(data: Uint8Array): void {
    if (this.#error) throw this.#error;

    if (this.#pendingBytes + data.byteLength > this.maxBytes) {
      const error = new BackpressureError("Output byte limit exceeded");
      this.fail(error);
      throw error;
    }

    this.#pendingBytes += data.byteLength;
    this.#queue.push(data);
    void this.#pump();
  }

  async #pump(): Promise<void> {
    if (this.#writing || this.#error) return;

    this.#writing = true;

    try {
      while (this.#queue.length && !this.#error) {
        const data = this.#queue.shift()!;
        await this.#writer.write(data);

        if (!this.#error) this.#pendingBytes -= data.byteLength;
      }
    } catch (reason) {
      this.fail(asError(reason));
    } finally {
      this.#writing = false;

      if (!this.#error) {
        this.#drained?.resolve();
        this.#drained = undefined;
      }
    }
  }

  drain(): Promise<void> {
    if (this.#error) return Promise.reject(this.#error);
    if (!this.#writing && !this.#queue.length) return Promise.resolve();

    if (!this.#drained) {
      let resolve!: () => void;
      let reject!: (error: Error) => void;
      const promise = new Promise<void>((res, rej) => {
        resolve = res;
        reject = rej;
      });
      this.#drained = { resolve, reject, promise };
    }

    return this.#drained.promise;
  }

  release(): void {
    // Releasing a healthy writer also rejects its closed promise.
    this.#released = true;
    this.#writer.releaseLock();
  }

  fail(error: Error): void {
    if (this.#error || this.#released) return;

    this.#error = error;
    this.#queue = [];
    this.#pendingBytes = 0;
    this.#drained?.reject(error);
    this.#drained = undefined;

    // Do not wait for a sink whose in-flight write may never complete.
    void this.#writer.abort(error).catch(() => {});
    this.release();
    this.onError(error);
  }
}
