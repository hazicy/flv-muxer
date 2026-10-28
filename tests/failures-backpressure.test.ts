import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { FlvMuxer } from "../src/core/flv-muxer";

type Callbacks = {
  output: (chunk: unknown, metadata: unknown) => void;
  error: (error: Error) => void;
};

class Encoder {
  static instances: Encoder[] = [];
  state = "configured";
  encodeQueueSize = 0;
  pending: number[] = [];
  failure?: Error;
  flushFailure?: Error;
  configureFailure?: Error;
  blockedFlush?: Promise<void>;
  copyFailure?: Error;
  closed = 0;

  constructor(readonly callbacks: Callbacks) {
    Encoder.instances.push(this);
  }

  configure() {
    if (this.configureFailure) throw this.configureFailure;
    this.state = "configured";
  }

  encode(frame: { timestamp: number }) {
    if (this.failure) throw this.failure;
    this.pending.push(frame.timestamp);
    this.encodeQueueSize++;
  }

  reset() {
    this.pending = [];
    this.encodeQueueSize = 0;
  }

  close() {
    this.closed++;
    this.state = "closed";
    this.reset();
  }

  emit(timestamp = 0, byteLength = 1) {
    this.encodeQueueSize = Math.max(0, this.encodeQueueSize - 1);
    this.callbacks.output(
      {
        timestamp,
        byteLength,
        type: "key",
        copyTo: (data: Uint8Array) => {
          if (this.copyFailure) throw this.copyFailure;
          data.set([42]);
        },
      },
      { decoderConfig: { description: new Uint8Array([0x12, 0x10]).buffer } }
    );
  }

  async flush() {
    if (this.flushFailure) throw this.flushFailure;
    if (this.blockedFlush) await this.blockedFlush;
    for (const timestamp of this.pending.splice(0)) this.emit(timestamp);
  }
}

function frame(timestamp = 0) {
  return { timestamp, close: vi.fn() };
}

function create(
  options: Partial<ConstructorParameters<typeof FlvMuxer>[1]> = {},
  sink: UnderlyingSink<Uint8Array> = {},
  video = false
) {
  const writable = new WritableStream<Uint8Array>(sink);
  const muxer = new FlvMuxer(writable, {
    mode: "record",
    chunked: false,
    ...options,
  });

  muxer.configureAudio({
    encoderConfig: {
      codec: "mp4a.40.2",
      sampleRate: 44100,
      numberOfChannels: 2,
    },
  });
  if (video)
    muxer.configureVideo({
      encoderConfig: { codec: "avc1.42001f", width: 640, height: 360 },
      keyframeInterval: 30,
    });

  return { muxer, writable };
}

beforeEach(() => {
  Encoder.instances = [];
  vi.stubGlobal("AudioEncoder", Encoder);
  vi.stubGlobal("VideoEncoder", Encoder);
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

it("propagates encode exceptions and closes both encoders", async () => {
  const { muxer, writable } = create({}, {}, true);
  const completed = muxer.start();
  const error = new Error("encode failed");
  Encoder.instances[0].failure = error;
  const input = frame();

  expect(() => muxer.addRawChunk("audio", input as never)).toThrow(error);
  expect(input.close).toHaveBeenCalledOnce();
  await expect(completed).rejects.toBe(error);
  await expect(muxer.stop()).rejects.toBe(error);
  expect(Encoder.instances.map((encoder) => encoder.closed)).toEqual([1, 1]);
  expect(muxer.state).toBe("inactive");
  expect(writable.locked).toBe(false);

  const late = frame();
  expect(() => muxer.addRawChunk("video", late as never)).toThrow(error);
  expect(late.close).toHaveBeenCalledOnce();
  await expect(muxer.start()).rejects.toBe(error);
});

it("rejects pending pause and start on asynchronous encoder failure, without waiting for flush", async () => {
  const { muxer } = create();
  const completed = muxer.start();
  let unblock!: () => void;
  Encoder.instances[0].blockedFlush = new Promise((resolve) => {
    unblock = resolve;
  });
  const paused = muxer.pause();
  await Promise.resolve();
  const error = new Error("encoder callback failed");

  expect(() => Encoder.instances[0].callbacks.error(error)).not.toThrow();
  await expect(paused).rejects.toBe(error);
  await expect(completed).rejects.toBe(error);
  expect(Encoder.instances[0].closed).toBe(1);
  unblock();
});

it("rejects stop on flush failure and preserves the original failure", async () => {
  const { muxer } = create();
  const completed = muxer.start();
  const error = new Error("flush failed");
  Encoder.instances[0].flushFailure = error;

  await expect(muxer.stop()).rejects.toBe(error);
  await expect(completed).rejects.toBe(error);
  await expect(muxer.pause()).rejects.toBe(error);
  expect(() => muxer.resume()).toThrow(error);
  expect(Encoder.instances[0].closed).toBe(1);
});

it("propagates chunk-copy failures instead of only logging them", async () => {
  const { muxer } = create();
  const completed = muxer.start();
  const error = new Error("copy failed");
  Encoder.instances[0].copyFailure = error;

  Encoder.instances[0].emit();
  await expect(completed).rejects.toBe(error);
  expect(Encoder.instances[0].closed).toBe(1);
});

it("clears interleave timers and aborts output on failure", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] });
  const abort = vi.fn();
  const { muxer } = create({}, { abort }, true);
  const completed = muxer.start();
  Encoder.instances[0].emit();
  expect(vi.getTimerCount()).toBe(1);
  const error = new Error("video failed");

  Encoder.instances[1].callbacks.error(error);
  await expect(completed).rejects.toBe(error);
  expect(vi.getTimerCount()).toBe(0);
  await Promise.resolve();
  await Promise.resolve();
  expect(abort).toHaveBeenCalledWith(error);
});

it("handles sink write rejection while stopping", async () => {
  let rejectWrite!: (error: Error) => void;
  const blocked = new Promise<void>((_, reject) => {
    rejectWrite = reject;
  });
  const { muxer, writable } = create({}, { write: () => blocked });
  const completed = muxer.start();
  const stopped = muxer.stop();
  const error = new Error("write failed");
  await Promise.resolve();
  rejectWrite(error);

  await expect(stopped).rejects.toBe(error);
  await expect(completed).rejects.toBe(error);
  expect(writable.locked).toBe(false);
  expect(Encoder.instances[0].closed).toBe(1);
});

it("drops only unencoded live video when the encoder queue is full", async () => {
  const { muxer } = create({ mode: "live", maxEncodeQueueSize: 1 }, {}, true);
  const completed = muxer.start();
  const first = frame();
  const dropped = frame(1000);

  muxer.addRawChunk("video", first as never);
  muxer.addRawChunk("video", dropped as never);
  expect(Encoder.instances[1].pending).toEqual([0]);
  expect(dropped.close).toHaveBeenCalledOnce();
  expect(muxer.state).toBe("recording");

  await muxer.stop();
  await completed;
});

it.each(["record", "live"] as const)(
  "fails explicitly on audio encoder overload in %s mode",
  async (mode) => {
    const { muxer } = create({ mode, maxEncodeQueueSize: 1 });
    const completed = muxer.start();
    muxer.addRawChunk("audio", frame() as never);
    const overflow = frame(1000);

    expect(() => muxer.addRawChunk("audio", overflow as never)).toThrow(
      "queue is full"
    );
    expect(overflow.close).toHaveBeenCalledOnce();
    await expect(completed).rejects.toHaveProperty("name", "BackpressureError");
    expect(Encoder.instances[0].closed).toBe(1);
  }
);

it("fails on recording video overload instead of silently dropping frames", async () => {
  const { muxer } = create({ maxEncodeQueueSize: 1 }, {}, true);
  const completed = muxer.start();
  muxer.addRawChunk("video", frame() as never);
  expect(() => muxer.addRawChunk("video", frame(1000) as never)).toThrow(
    "queue is full"
  );
  await expect(completed).rejects.toHaveProperty("name", "BackpressureError");
});

it("stops accepting live video while output is pressured and resumes when writes catch up", async () => {
  let unblock!: () => void;
  let writes = 0;
  const blocked = new Promise<void>((resolve) => {
    unblock = resolve;
  });
  const { muxer } = create(
    { mode: "live", maxOutputBytes: 1000, maxInterleaveDelayMs: 0 },
    {
      write() {
        writes++;
        return blocked;
      },
    },
    true
  );
  const completed = muxer.start();
  // Keep encoded audio queued behind the blocked header write.
  Encoder.instances[0].emit(0, 450);
  const input = frame();
  muxer.addRawChunk("video", input as never);
  expect(Encoder.instances[1].pending).toHaveLength(0);
  expect(input.close).toHaveBeenCalledOnce();

  unblock();
  await vi.waitFor(() => expect(writes).toBe(4));
  muxer.addRawChunk("video", frame(1000) as never);
  expect(Encoder.instances[1].pending).toHaveLength(1);
  await muxer.stop();
  await completed;
});

it("rejects output overflow without waiting for a blocked writer", async () => {
  let unblock!: () => void;
  const blocked = new Promise<void>((resolve) => {
    unblock = resolve;
  });
  const { muxer, writable } = create(
    { maxOutputBytes: 1024 },
    { write: () => blocked }
  );
  const completed = muxer.start();
  Encoder.instances[0].emit(0, 2048);
  await expect(completed).rejects.toHaveProperty("name", "BackpressureError");
  expect(writable.locked).toBe(false);
  expect(Encoder.instances[0].closed).toBe(1);
  unblock();
});

it("does not resume until pause finishes draining output", async () => {
  let unblock!: () => void;
  const blocked = new Promise<void>((resolve) => {
    unblock = resolve;
  });
  const { muxer } = create({}, { write: () => blocked });
  const completed = muxer.start();
  const paused = muxer.pause();
  // Let encoder flushing finish while output remains blocked.
  for (let i = 0; i < 10; i++) await Promise.resolve();
  expect(() => muxer.resume()).toThrow("pending lifecycle operation");

  unblock();
  await paused;
  muxer.resume();
  await muxer.stop();
  await completed;
});

it("does not mark a failed configuration as a configured track", async () => {
  const muxer = new FlvMuxer(new WritableStream(), {
    mode: "record",
    chunked: false,
  });
  vi.stubGlobal(
    "AudioEncoder",
    class extends Encoder {
      configure() {
        throw new Error("invalid config");
      }
    }
  );
  expect(() =>
    muxer.configureAudio({
      encoderConfig: { codec: "invalid", sampleRate: 1, numberOfChannels: 1 },
    })
  ).toThrow("invalid config");
  expect(Encoder.instances[0].closed).toBe(1);
  await expect(muxer.start()).rejects.toThrow("Configure at least one track");
});

it("fails recording input when output is pressured instead of silently dropping it", async () => {
  let unblock!: () => void;
  const blocked = new Promise<void>((resolve) => {
    unblock = resolve;
  });
  const { muxer } = create({ maxOutputBytes: 1000 }, { write: () => blocked });
  const completed = muxer.start();
  Encoder.instances[0].emit(0, 450);
  const input = frame(1000);

  expect(() => muxer.addRawChunk("audio", input as never)).toThrow(
    "queue is full"
  );
  expect(input.close).toHaveBeenCalledOnce();
  await expect(completed).rejects.toHaveProperty("name", "BackpressureError");
  unblock();
});

it("cleans up after reset fails during stop", async () => {
  const { muxer, writable } = create();
  const completed = muxer.start();
  const error = new Error("reconfigure failed");
  Encoder.instances[0].configureFailure = error;

  await expect(muxer.stop()).rejects.toBe(error);
  await expect(completed).rejects.toBe(error);
  expect(Encoder.instances[0].closed).toBe(1);
  expect(writable.locked).toBe(false);
});

it.each([0, -1, Infinity, 1.5])(
  "validates backpressure limits: %s",
  (value) => {
    expect(() => create({ maxEncodeQueueSize: value })).toThrow(
      "Invalid queue limits"
    );
    expect(() => create({ maxOutputBytes: value })).toThrow(
      "positive safe integer"
    );
  }
);
