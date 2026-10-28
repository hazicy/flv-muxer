# FlvMuxer

English | [中文](./README_CN.md)

`flv-muxer.js` is a pure TypeScript `FLV` multiplexer that enables native `FLV` streaming and recording on the Web platform.

## Use Cases

- Transmit `FLV` streams to a media server via `WebTransport` or `WebSocket` for web-based live streaming
- Overcome the limitation of the `MediaRecorder` API, which does not support `FLV` format recording

## Installation

### NPM

```sh
npm install flv-muxer
```

### CDN

```html
<script src="https://cdn.jsdelivr.net/npm/flv-muxer@latest/dist/flv-muxer.iife.js"></script>
```

## API

### `FlvMuxer`

`FlvMuxer` is a class for creating an `FLV` multiplexer instance, providing stream processing capabilities.

#### Constructor

```ts
const muxer = new FlvMuxer(
  writable: WritableStream,
  options: {
    mode: "record" | "live";
    chunked: boolean; // Whether to transmit in chunks
    maxInterleaveDelayMs?: number;
    maxPendingChunks?: number;
    maxEncodeQueueSize?: number;
    maxOutputBytes?: number;
  }
);
```

| Optional option | Default | Description |
| --- | --- | --- |
| `maxInterleaveDelayMs` | `200` | Maximum interleaving wait in milliseconds; finite and nonnegative |
| `maxPendingChunks` | `256` | Maximum interleaving queue size in packets; positive integer |
| `maxEncodeQueueSize` | `32` | Pending encode request limit per track; positive integer |
| `maxOutputBytes` | `8388608` | Output byte limit, including the in-flight write; positive safe integer |

If a track stalls, output continues after the timeout or when the queue exceeds its limit. No video frames are synthesized. Late timestamps are moved forward, which can compress playback intervals. `maxPendingChunks` and `maxInterleaveDelayMs` apply only to the interleaving queue.

In `live` mode, new video frames are dropped when the video encoder queue is full or output reaches half its byte limit. In `record` mode, overload raises `BackpressureError`. A full audio encoder queue or exceeded output byte limit stops either mode with an error.

Encoding, flushing, or writing failures clear queues and timers, close encoders, attempt to abort output, and reject `start()` and pending `pause()` / `stop()` calls. Failed instances cannot restart. The muxer closes submitted frames, including on drops and errors.

The sink's `write()` should return a promise that resolves when the write completes. Buffering inside a sink that returns immediately cannot be tracked by the muxer.

#### Methods

- **`configureAudio()`**: Configures the audio encoder. Call before starting.

  ```ts
  flvMuxer.configureAudio({
    encoderConfig: AudioEncoderConfig;
  });

  // Example
  flvMuxer.configureAudio({
    encoderConfig: {
      codec: "mp4a.40.29",
      sampleRate: 44100,
      numberOfChannels: 2,
    },
  });
  ```

  Audio encoder configuration: [AudioEncoderConfig](https://developer.mozilla.org/en-US/docs/Web/API/AudioEncoder/configure#config).

- **`configureVideo()`**: Configures the video encoder. Call before starting; `keyframeInterval` must be a positive integer.

  ```ts
  muxer.configureVideo({
    encoderConfig: VideoEncoderConfig;
    keyframeInterval: number, // Keyframe interval in frames
  });

  // Example
  flvMuxer.configureVideo({
    encoderConfig: {
      codec: "avc1.640034",
      width: 2560,
      height: 1440,
      framerate: 30,
    },
    keyframeInterval: 90,
  });
  ```

  video encoder configuration: [VideoEncoderConfig](https://developer.mozilla.org/en-US/docs/Web/API/VideoEncoder/configure#config).

- **`addRawChunk`**: Add raw frame data.

  ```ts
  flvMuxer.addRawChunk("video" | "audio", chunk: VideoFrame | AudioData);

  // Example
  flvMuxer.addRawChunk("video", chunk);
  ```

- **`start(): Promise<void>`**: Starts processing; requires a configured track and throws if already active. Resolves when the output pipeline finishes.
- **`pause(): Promise<void>`**: Pauses and drains pending data. Await before resuming.
- **`resume(): void`**: Resumes processing.
- **`stop(): Promise<void>`**: Stops and waits for remaining output, including when paused. Leaves the writable open and allows restarting.

#### Usage example

```ts
// Configure tracks first; do not await start() here.
const finished = muxer.start();
finished.catch(console.error); // Handle asynchronous encoding or output errors.
muxer.addRawChunk("video", frame); // Submit frames throughout capture.

await muxer.pause(); // When pausing.
muxer.resume();

await muxer.stop();
await finished;
```

#### Properties

- **`state`**: Returns the current state of the multiplexer. Possible values are `"recording"`, `"paused"`, or `"inactive"`.
