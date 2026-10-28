import {
  type MuxStrategy,
  AACRawStrategy,
  AACSEStrategy,
  AVCSEStrategy,
  AVCNALUStrategy,
} from "../strategies/mux-strategy";
import { AudioEncoderTrack, VideoEncoderTrack } from "./encoder-track";
import { EventBus } from "./event-bus";
import { FlvEncoder } from "./flv-encoder";
import { StreamProcessor, type TrackChunk } from "./stream-processor";
import { asError } from "./errors";
import { OutputWriter } from "./output-writer";

export type MuxerMode = "record" | "live";

interface VideoOptions {
  encoderConfig: VideoEncoderConfig;
  keyframeInterval: number;
}

interface AudioOptions {
  encoderConfig: AudioEncoderConfig;
}

interface MuxerOptions {
  mode: MuxerMode;
  chunked: boolean;
  maxInterleaveDelayMs?: number;
  maxPendingChunks?: number;
  maxEncodeQueueSize?: number;
  maxOutputBytes?: number;
  video?: VideoOptions;
  audio?: AudioOptions;
}

export class FlvMuxer {
  readonly #encoder: FlvEncoder;
  readonly #eventBus: EventBus;
  readonly #streamProcessor: StreamProcessor;
  readonly #outputStream: WritableStream | undefined;

  #completion?: Promise<void>;
  #resolveCompletion?: () => void;
  #rejectCompletion?: (error: Error) => void;
  #stopping?: Promise<void>;
  #pausing?: Promise<void>;
  #error?: Error;
  #output?: OutputWriter;
  #options: MuxerOptions;
  #strategies: { [key: string]: MuxStrategy } = {};

  #publish = (chunk: TrackChunk): void => {
    if (this.#error) return;

    try {
      const tag = this.#muxChunk(chunk);
      if (tag) this.#output?.enqueue(tag);
    } catch (reason) {
      this.#fail(asError(reason));
    }
  };

  get state() {
    return this.#streamProcessor.state;
  }

  constructor(
    writable: WritableStream,
    options: {
      mode: MuxerMode;
      chunked: boolean;
      maxInterleaveDelayMs?: number;
      maxPendingChunks?: number;
      maxEncodeQueueSize?: number;
      maxOutputBytes?: number;
    }
  ) {
    if (!(writable instanceof WritableStream)) {
      throw new Error(
        "The provided 'writable' is not an instance of WritableStream."
      );
    }

    const maxOutputBytes = options.maxOutputBytes ?? 8 * 1024 * 1024;

    if (!Number.isSafeInteger(maxOutputBytes) || maxOutputBytes < 1) {
      throw new Error("maxOutputBytes must be a positive safe integer");
    }

    this.#encoder = new FlvEncoder();
    this.#eventBus = new EventBus();
    this.#streamProcessor = new StreamProcessor(
      this.#eventBus,
      options.maxInterleaveDelayMs,
      options.maxPendingChunks,
      options.mode,
      options.maxEncodeQueueSize,
      () => this.#output?.pressured ?? false
    );
    this.#outputStream = writable;
    this.#options = { ...options, maxOutputBytes };
    this.#eventBus.on("ERROR", (error: Error) => this.#fail(error));

    // 初始化策略
    this.#initStrategies();
  }

  #initStrategies(): void {
    this.#strategies["AAC_SE"] = new AACSEStrategy();
    this.#strategies["AVC_SE"] = new AVCSEStrategy();
    this.#strategies["AAC_RAW"] = new AACRawStrategy();
    this.#strategies["AVC_NALU"] = new AVCNALUStrategy();
  }

  addRawChunk(type: "audio" | "video", chunk: VideoFrame | AudioData): void {
    this.#streamProcessor.addTrackChunk(type, chunk);
  }

  configureAudio(options: AudioOptions): void {
    if (this.#error) throw this.#error;

    if (this.state !== "inactive" || this.#stopping)
      throw new Error("Configure tracks before starting");

    if (!options.encoderConfig) {
      throw new Error("Audio encoder configuration cannot be empty");
    }

    this.#streamProcessor.addAudioTrack(
      new AudioEncoderTrack(
        options.encoderConfig,
        this.#eventBus,
        this.#streamProcessor.trackState
      )
    );

    this.#options.audio = options;
  }

  configureVideo(options: VideoOptions): void {
    if (this.#error) throw this.#error;

    if (this.state !== "inactive" || this.#stopping)
      throw new Error("Configure tracks before starting");

    if (!options.encoderConfig) {
      throw new Error("Video encoder configuration cannot be empty");
    }

    if (
      !Number.isInteger(options.keyframeInterval) ||
      options.keyframeInterval < 1
    ) {
      throw new Error("keyframeInterval must be a positive integer");
    }

    this.#streamProcessor.addVideoTrack(
      new VideoEncoderTrack(
        options.encoderConfig,
        options.keyframeInterval,
        this.#eventBus,
        this.#streamProcessor.trackState
      )
    );

    this.#options.video = options;
  }

  start(): Promise<void> {
    if (this.#error) return Promise.reject(this.#error);

    if (this.state !== "inactive" || this.#stopping) {
      return Promise.reject(new Error("Muxer is already active"));
    }

    if (!this.#options.audio && !this.#options.video) {
      return Promise.reject(
        new Error("Configure at least one track before starting")
      );
    }

    this.#completion = new Promise<void>((resolve, reject) => {
      this.#resolveCompletion = resolve;
      this.#rejectCompletion = reject;
    });
    // The returned promise still rejects; observing it here avoids background rejections.
    void this.#completion.catch(() => {});

    try {
      this.#output = new OutputWriter(
        this.#outputStream!,
        this.#options.maxOutputBytes!,
        (error) => this.#fail(error)
      );
      this.#eventBus.on("CHUNK_PUBLISH", this.#publish);
      this.#streamProcessor.start();

      this.#output.enqueue(
        this.#encoder.encodeFlvHeader(
          !!this.#options.video,
          !!this.#options.audio
        )
      );
      this.#output.enqueue(this.#encodeMetadata());
    } catch (reason) {
      this.#fail(asError(reason));
    }

    return this.#completion;
  }

  pause(): Promise<void> {
    if (this.#error) return Promise.reject(this.#error);
    if (this.#pausing) return this.#pausing;
    if (this.#stopping) return this.#stopping;
    if (this.state !== "recording") return Promise.resolve();

    this.#pausing = (async () => {
      try {
        await this.#streamProcessor.pause();
        await this.#output?.drain();
        if (this.#error) throw this.#error;
      } catch (reason) {
        this.#fail(asError(reason));
        throw this.#error;
      } finally {
        this.#pausing = undefined;
      }
    })();

    return this.#pausing;
  }

  resume(): void {
    if (this.#error) throw this.#error;
    if (this.#pausing || this.#stopping) {
      throw new Error("Wait for the pending lifecycle operation to finish");
    }

    this.#streamProcessor.resume();
  }

  stop(): Promise<void> {
    if (this.#error) return Promise.reject(this.#error);
    if (this.#stopping) return this.#stopping;
    if (this.state === "inactive") return Promise.resolve();

    this.#stopping = (async () => {
      try {
        if (this.#pausing) await this.#pausing;
        await this.#streamProcessor.stop();
        await this.#output?.drain();

        if (this.#error) throw this.#error;
        this.#output?.release();
        this.#output = undefined;
        this.#resolveCompletion?.();
      } catch (reason) {
        this.#fail(asError(reason));
        throw this.#error;
      } finally {
        this.#eventBus.off("CHUNK_PUBLISH", this.#publish);
        this.#stopping = undefined;
      }
    })();

    return this.#stopping;
  }

  #fail(error: Error): void {
    if (this.#error) return;

    this.#error = error;

    this.#streamProcessor.fail(error);
    this.#eventBus.off("CHUNK_PUBLISH", this.#publish);
    this.#output?.fail(error);
    this.#output = undefined;
    this.#rejectCompletion?.(error);
  }

  #encodeMetadata(): Uint8Array {
    const metadata: Record<string, unknown> = {
      duration: 0,
      encoder: "flv-muxer.js",
    };

    if (this.#options.video) {
      const { encoderConfig } = this.#options.video;

      Object.assign(metadata, {
        videocodecid: 7,
        width: encoderConfig.width,
        height: encoderConfig.height,
        framerate: encoderConfig.framerate,
      });
    }

    if (this.#options.audio) {
      const { encoderConfig } = this.#options.audio;

      Object.assign(metadata, {
        audiocodecid: 10,
        audiodatarate: (encoderConfig.bitrate ?? 0) / 1000,
        stereo: encoderConfig.numberOfChannels === 2,
        audiosamplerate: encoderConfig.sampleRate,
      });
    }

    const scriptData = this.#encoder.encodeScriptDataTag(metadata);

    return scriptData;
  }

  #muxChunk(chunk: TrackChunk): Uint8Array | undefined {
    if (!chunk) return;

    const strategy = this.#strategies[chunk.type];
    if (strategy) {
      return strategy.process(chunk, this.#encoder);
    }
  }
}
