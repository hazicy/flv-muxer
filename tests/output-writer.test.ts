import { expect, it, vi } from "vitest";
import { OutputWriter } from "../src/core/output-writer";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

it("serializes slow writes, counts in-flight bytes, and drains before releasing", async () => {
  const gate = deferred();
  const writes: number[] = [];
  const sink = new WritableStream<Uint8Array>({
    async write(data) {
      writes.push(data[0]);
      if (writes.length === 1) await gate.promise;
    },
  });
  const onError = vi.fn();
  const output = new OutputWriter(sink, 10, onError);

  output.enqueue(new Uint8Array([1, 1, 1]));
  output.enqueue(new Uint8Array([2, 2, 2]));
  expect(output.pressured).toBe(true);

  const drained = vi.fn();
  const waiting = output.drain().then(drained);
  await Promise.resolve();
  expect(writes).toEqual([1]);
  expect(drained).not.toHaveBeenCalled();

  gate.resolve();
  await waiting;
  expect(writes).toEqual([1, 2]);
  expect(output.pressured).toBe(false);

  output.release();
  await Promise.resolve();
  expect(sink.locked).toBe(false);
  expect(onError).not.toHaveBeenCalled();
});

it("rejects overflow and drains immediately even if a sink write is blocked", async () => {
  const gate = deferred();
  const sink = new WritableStream<Uint8Array>({ write: () => gate.promise });
  const onError = vi.fn();
  const output = new OutputWriter(sink, 4, onError);

  output.enqueue(new Uint8Array(4));
  const draining = output.drain();
  expect(() => output.enqueue(new Uint8Array(1))).toThrow(
    "Output byte limit exceeded"
  );
  await expect(draining).rejects.toHaveProperty("name", "BackpressureError");
  expect(onError).toHaveBeenCalledOnce();
  expect(sink.locked).toBe(false);

  gate.resolve();
});

it("reports a sink failure even without a pending write", async () => {
  let controller!: WritableStreamDefaultController;
  const sink = new WritableStream<Uint8Array>({
    start(value) {
      controller = value;
    },
  });
  const onError = vi.fn();
  const output = new OutputWriter(sink, 100, onError);
  const error = new Error("sink failed");

  controller.error(error);
  await vi.waitFor(() => expect(onError).toHaveBeenCalledWith(error));
  await expect(output.drain()).rejects.toBe(error);
  expect(sink.locked).toBe(false);
});
