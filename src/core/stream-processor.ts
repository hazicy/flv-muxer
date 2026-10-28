import type { AudioEncoderTrack, VideoEncoderTrack } from "./encoder-track";
import { TrackState } from "./encoder-track";
import { EventBus } from "./event-bus";
import { asError, BackpressureError } from "./errors";
import type { MuxerMode } from "./flv-muxer";

export type ProcessorState = "recording" | "paused" | "inactive";

export interface TrackChunk {
  type: "AAC_RAW" | "AAC_SE" | "AVC_SE" | "AVC_NALU";
  data: Uint8Array;
  // Relative presentation timestamp in milliseconds.
  timestamp: number;
  isKey: boolean;
}

export class StreamProcessor {
  state: ProcessorState = "inactive";
  readonly trackState = new TrackState();

  #audioEncoderTrack?: AudioEncoderTrack;
  #videoEncoderTrack?: VideoEncoderTrack;

  #queue: { chunk: TrackChunk; arrival: number }[] = [];
  #audioTimestamp = -Infinity;
  #videoTimestamp = -Infinity;
  #lastPublishedTimestamp = 0;

  #timer?: ReturnType<typeof setTimeout>;
  #transition?: Promise<void>;
  #error?: Error;
  #failure: Promise<never>;
  #rejectFailure!: (error: Error) => void;

  constructor(
    private readonly eventBus: EventBus,
    private readonly maxInterleaveDelayMs = 200,
    private readonly maxPendingChunks = 256,
    private readonly mode: MuxerMode = "record",
    private readonly maxEncodeQueueSize = 32,
    private readonly outputPressured: () => boolean = () => false
  ) {
    if (
      !Number.isFinite(maxInterleaveDelayMs) ||
      maxInterleaveDelayMs < 0 ||
      !Number.isInteger(maxPendingChunks) ||
      maxPendingChunks < 1 ||
      !Number.isInteger(maxEncodeQueueSize) ||
      maxEncodeQueueSize < 1
    ) {
      throw new Error("Invalid queue limits");
    }

    this.#failure = new Promise<never>((_, reject) => {
      this.#rejectFailure = reject;
    });
    void this.#failure.catch(() => {});

    eventBus.on("ERROR", (error: Error) => this.fail(error));
    eventBus.on("TRACK_CHUNK", (chunk: TrackChunk) => {
      try {
        this.handleTrackChunk(chunk);
      } catch (reason) {
        eventBus.emit("ERROR", asError(reason));
      }
    });
  }

  addTrackChunk(type: "audio" | "video", chunk: VideoFrame | AudioData): void {
    if (this.#error) {
      chunk.close();
      throw this.#error;
    }

    const track =
      type === "audio" ? this.#audioEncoderTrack : this.#videoEncoderTrack;

    if (this.state !== "recording" || !track) {
      chunk.close();
      return;
    }

    const encoderFull = (track.encodeQueueSize ?? 0) >= this.maxEncodeQueueSize;

    if (encoderFull || this.outputPressured()) {
      if (this.mode === "live" && type === "video") {
        chunk.close();
        return;
      }

      // Audio may continue while live video is shedding frames, until a hard limit.
      if (encoderFull || this.mode === "record") {
        chunk.close();
        const error = new BackpressureError("Encoder or output queue is full");
        this.eventBus.emit("ERROR", error);
        throw error;
      }
    }

    // Anchor to input order, independently of encoder callback scheduling.
    this.trackState.offsetTimestamp ??= chunk.timestamp;

    try {
      track.addTrackChunk(chunk);
    } catch (reason) {
      const error = asError(reason);
      this.eventBus.emit("ERROR", error);
      throw error;
    }

    if (this.#error) throw this.#error;
  }

  addAudioTrack(track: AudioEncoderTrack): void {
    this.#audioEncoderTrack?.close();
    this.#audioEncoderTrack = track;
  }

  addVideoTrack(track: VideoEncoderTrack): void {
    this.#videoEncoderTrack?.close();
    this.#videoEncoderTrack = track;
  }

  handleTrackChunk(chunk: TrackChunk): void {
    if (this.#error) return;

    if (chunk.type === "AAC_SE" || chunk.type === "AVC_SE") {
      this.eventBus.emit("CHUNK_PUBLISH", chunk);
      return;
    }

    if (chunk.type === "AAC_RAW")
      this.#audioTimestamp = Math.max(this.#audioTimestamp, chunk.timestamp);
    else this.#videoTimestamp = Math.max(this.#videoTimestamp, chunk.timestamp);

    this.#queue.push({ chunk, arrival: performance.now() });
    this.#queue.sort((a, b) => a.chunk.timestamp - b.chunk.timestamp);

    this.#drain();
  }

  #drain(force = false): void {
    clearTimeout(this.#timer);

    const watermark =
      !this.#audioEncoderTrack || !this.#videoEncoderTrack
        ? Infinity
        : Math.min(this.#audioTimestamp, this.#videoTimestamp);

    // Release sorted predecessors too if an older arrival is behind them.
    const now = performance.now();
    const expiredTimestamp = this.#queue.reduce(
      (latest, entry) =>
        now - entry.arrival >= this.maxInterleaveDelayMs
          ? Math.max(latest, entry.chunk.timestamp)
          : latest,
      -Infinity
    );

    while (this.#queue.length) {
      const head = this.#queue[0];

      if (
        !force &&
        head.chunk.timestamp > watermark &&
        head.chunk.timestamp > expiredTimestamp &&
        this.#queue.length <= this.maxPendingChunks
      )
        break;

      this.#queue.shift();

      // Keep reference frames: late packets are retimestamped rather than dropped.
      const timestamp = Math.max(
        this.#lastPublishedTimestamp,
        head.chunk.timestamp
      );

      this.#lastPublishedTimestamp = timestamp;
      this.eventBus.emit("CHUNK_PUBLISH", { ...head.chunk, timestamp });
    }

    if (this.#queue.length) {
      const oldestArrival = Math.min(
        ...this.#queue.map((entry) => entry.arrival)
      );

      this.#timer = setTimeout(
        () => {
          try {
            this.#drain();
          } catch (reason) {
            this.eventBus.emit("ERROR", asError(reason));
          }
        },
        Math.max(
          1,
          this.maxInterleaveDelayMs - (performance.now() - oldestArrival)
        )
      );
    }
  }

  start(): void {
    if (this.#error) throw this.#error;

    if (this.state !== "inactive" || this.#transition)
      throw new Error("Processor is already active");

    this.state = "recording";
  }

  pause(): Promise<void> {
    if (this.#error) return Promise.reject(this.#error);

    if (this.#transition) return this.#transition;
    if (this.state !== "recording") return Promise.resolve();

    this.state = "paused";

    return this.#flush();
  }

  resume(): void {
    if (this.#error) throw this.#error;

    if (this.#transition)
      throw new Error("Wait for pause() to finish before resuming");

    if (this.state === "paused") this.state = "recording";
  }

  async stop(): Promise<void> {
    if (this.#error) throw this.#error;

    if (this.state === "inactive") return;

    this.state = "paused";

    if (this.#transition) await this.#transition;
    await this.#flush();

    try {
      this.reset();
    } catch (reason) {
      const error = asError(reason);
      this.eventBus.emit("ERROR", error);
      throw error;
    }

    this.state = "inactive";
  }

  reset(): void {
    clearTimeout(this.#timer);

    this.#queue = [];
    this.#audioTimestamp = this.#videoTimestamp = -Infinity;
    this.#lastPublishedTimestamp = 0;

    this.#videoEncoderTrack?.reset();
    this.#audioEncoderTrack?.reset();
    this.trackState.offsetTimestamp = undefined;
  }

  fail(error: Error): void {
    if (this.#error) return;

    this.#error = error;
    this.state = "inactive";

    clearTimeout(this.#timer);
    this.#queue = [];
    this.trackState.offsetTimestamp = undefined;

    for (const track of [this.#audioEncoderTrack, this.#videoEncoderTrack]) {
      try {
        track?.close();
      } catch {
        /* Preserve the original failure. */
      }
    }

    this.#rejectFailure(error);
  }

  #flush(): Promise<void> {
    this.#transition = Promise.race([
      this.#failure,
      Promise.resolve().then(() =>
        Promise.all([
          this.#audioEncoderTrack?.flush(),
          this.#videoEncoderTrack?.flush(),
        ])
      ),
    ])
      .then(() => {
        if (this.#error) throw this.#error;
        this.#drain(true);
        if (this.#error) throw this.#error;
      })
      .catch((reason) => {
        const error = this.#error ?? asError(reason);
        this.eventBus.emit("ERROR", error);
        throw error;
      })
      .finally(() => {
        clearTimeout(this.#timer);
        this.#transition = undefined;
      });

    return this.#transition;
  }
}
