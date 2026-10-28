import type { AudioEncoderTrack, VideoEncoderTrack } from "./encoder-track";
import { TrackState } from "./encoder-track";
import { EventBus } from "./event-bus";

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

  constructor(
    private readonly eventBus: EventBus,
    private readonly maxInterleaveDelayMs = 200,
    private readonly maxPendingChunks = 256
  ) {
    if (
      !Number.isFinite(maxInterleaveDelayMs) ||
      maxInterleaveDelayMs < 0 ||
      !Number.isInteger(maxPendingChunks) ||
      maxPendingChunks < 1
    ) {
      throw new Error("Invalid interleave queue limits");
    }

    eventBus.on("TRACK_CHUNK", (chunk: TrackChunk) =>
      this.handleTrackChunk(chunk)
    );
  }

  addTrackChunk(type: "audio" | "video", chunk: VideoFrame | AudioData): void {
    const track =
      type === "audio" ? this.#audioEncoderTrack : this.#videoEncoderTrack;

    if (this.state !== "recording" || !track) {
      chunk.close();
      return;
    }

    // Anchor to input order, independently of encoder callback scheduling.
    this.trackState.offsetTimestamp ??= chunk.timestamp;
    track.addTrackChunk(chunk);
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
        () => this.#drain(),
        Math.max(
          1,
          this.maxInterleaveDelayMs - (performance.now() - oldestArrival)
        )
      );
    }
  }

  start(): void {
    if (this.state !== "inactive" || this.#transition)
      throw new Error("Processor is already active");

    this.state = "recording";
  }

  pause(): Promise<void> {
    if (this.#transition) return this.#transition;
    if (this.state !== "recording") return Promise.resolve();

    this.state = "paused";

    return this.#flush();
  }

  resume(): void {
    if (this.#transition)
      throw new Error("Wait for pause() to finish before resuming");

    if (this.state === "paused") this.state = "recording";
  }

  async stop(): Promise<void> {
    if (this.state === "inactive") return;

    this.state = "paused";

    if (this.#transition) await this.#transition;
    await this.#flush();

    this.reset();
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

  #flush(): Promise<void> {
    this.#transition = Promise.all([
      this.#audioEncoderTrack?.flush(),
      this.#videoEncoderTrack?.flush(),
    ])
      .then(() => {
        this.#drain(true);
      })
      .finally(() => {
        clearTimeout(this.#timer);
        this.#transition = undefined;
      });

    return this.#transition;
  }
}
