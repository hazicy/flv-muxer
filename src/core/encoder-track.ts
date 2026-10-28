import { asError } from "./errors";
import { EventBus } from "./event-bus";

type EncodedMediaChunk = EncodedAudioChunk | EncodedVideoChunk;
type MediaDecoderConfig = AudioDecoderConfig | VideoDecoderConfig;

export class TrackState {
  offsetTimestamp: number | undefined;
}

export abstract class BaseEncoderTrack {
  readonly eventBus: EventBus;
  readonly config: VideoEncoderConfig | AudioEncoderConfig;

  encoder: VideoEncoder | AudioEncoder | undefined;
  trackState: TrackState;

  private _decoderConfig: AudioDecoderConfig | VideoDecoderConfig | undefined;

  get decoderConfig(): VideoDecoderConfig | undefined {
    return this._decoderConfig;
  }

  set decoderConfig(config: MediaDecoderConfig) {
    if (this._decoderConfig) return;
    this._decoderConfig = config;

    if (this instanceof AudioEncoderTrack) {
      this.eventBus.emit("TRACK_CHUNK", {
        type: "AAC_SE",
        data: new Uint8Array(config.description as ArrayBuffer),
        timestamp: 0,
        isKey: true,
      });
    } else {
      this.eventBus.emit("TRACK_CHUNK", {
        type: "AVC_SE",
        data: new Uint8Array(config.description as ArrayBuffer),
        timestamp: 0,
        isKey: true,
      });
    }
  }

  constructor(
    config: VideoEncoderConfig | AudioEncoderConfig,
    eventBus: EventBus,
    trackState: TrackState
  ) {
    this.eventBus = eventBus;
    this.trackState = trackState;
    this.config = config;

    try {
      this.initEncoder(config);
    } catch (reason) {
      try {
        this.close();
      } catch {
        /* Preserve configuration errors. */
      }
      throw reason;
    }
  }

  abstract addTrackChunk(chunk: VideoFrame | AudioData): void;

  protected abstract handleOutput(
    chunk: EncodedMediaChunk,
    metadata?: EncodedAudioChunkMetadata | EncodedVideoChunkMetadata
  ): void;

  protected abstract initEncoder(
    config: VideoEncoderConfig | AudioEncoderConfig
  ): void;

  get encodeQueueSize(): number {
    return this.encoder?.encodeQueueSize ?? 0;
  }

  close(): void {
    if (this.encoder && this.encoder.state !== "closed") this.encoder.close();
  }

  protected reportError(reason: unknown): void {
    this.eventBus.emit("ERROR", asError(reason));
  }

  reset(): void {
    this._decoderConfig = undefined;
    this.encoder?.reset();
    this.encoder?.configure(
      this.config as VideoEncoderConfig & AudioEncoderConfig
    );
  }

  async flush(): Promise<void> {
    if (!this.encoder) {
      throw new Error("Encoder is not initialized.");
    }

    return this.encoder.flush();
  }

  protected calculateTimestamp(timestamp: number) {
    if (this.trackState.offsetTimestamp === undefined) {
      this.trackState.offsetTimestamp = timestamp;
    }

    return Math.max(0, (timestamp - this.trackState.offsetTimestamp) / 1000);
  }
}

export class VideoEncoderTrack extends BaseEncoderTrack {
  #frameCount: number = 0;
  #keyframeInterval: number = 90;

  constructor(
    config: VideoEncoderConfig,
    keyframeInterval: number,
    eventBus: EventBus,
    trackState: TrackState
  ) {
    super(config, eventBus, trackState);

    this.#keyframeInterval = keyframeInterval;
  }

  protected initEncoder(config: VideoEncoderConfig): void {
    this.encoder = new VideoEncoder({
      output: this.handleOutput.bind(this),
      error: (error) => this.reportError(error),
    });

    this.encoder.configure(config);
  }

  addTrackChunk(frame: VideoFrame | AudioData): void {
    if (!this.encoder) {
      throw new Error("Encoder is not initialized.");
    }

    try {
      this.encoder.encode(frame as VideoFrame & AudioData, {
        keyFrame: this.#frameCount % this.#keyframeInterval === 0,
      });
      this.#frameCount++;
    } finally {
      frame.close();
    }
  }

  protected handleOutput(
    chunk: EncodedVideoChunk,
    metadata?: EncodedVideoChunkMetadata
  ) {
    try {
      // 添加视频元数据到缓冲区
      if (metadata?.decoderConfig?.description) {
        this.decoderConfig = metadata.decoderConfig;
      }

      // 将 EncodedVideoChunk 转为 Uint8Array
      const data = new Uint8Array(chunk.byteLength);
      chunk.copyTo(data);

      // 添加视频数据到缓冲区
      const timestamp = this.calculateTimestamp(chunk.timestamp);
      this.eventBus.emit("TRACK_CHUNK", {
        type: "AVC_NALU",
        data,
        timestamp,
        isKey: chunk.type === "key",
      });
    } catch (error) {
      this.reportError(error);
    }
  }

  async flush(): Promise<void> {
    await super.flush();
    this.#frameCount = 0;
  }

  reset(): void {
    super.reset();
    this.#frameCount = 0;
  }
}

export class AudioEncoderTrack extends BaseEncoderTrack {
  protected initEncoder(config: AudioEncoderConfig): void {
    this.encoder = new AudioEncoder({
      output: this.handleOutput.bind(this),
      error: (error) => this.reportError(error),
    });

    this.encoder.configure(config);
  }

  addTrackChunk(chunk: VideoFrame | AudioData): void {
    if (!this.encoder) {
      throw new Error("Encoder is not initialized.");
    }

    try {
      this.encoder.encode(chunk as VideoFrame & AudioData);
    } finally {
      chunk.close();
    }
  }

  protected handleOutput(
    chunk: EncodedMediaChunk,
    metadata?: EncodedAudioChunkMetadata
  ) {
    try {
      // 如果是关键帧，则添加音频解码器配置
      if (metadata?.decoderConfig?.description) {
        this.decoderConfig = metadata.decoderConfig;
      }

      // 将 EncodedAudioChunk 转为 Uint8Array
      const data = new Uint8Array(chunk.byteLength);
      chunk.copyTo(data);

      // 添加音频数据到缓冲区
      const timestamp = super.calculateTimestamp(chunk.timestamp); // 转换成相对时间
      this.eventBus.emit("TRACK_CHUNK", {
        type: "AAC_RAW",
        data,
        timestamp,
        isKey: chunk.type === "key",
      });
    } catch (error) {
      this.reportError(error);
    }
  }
}
