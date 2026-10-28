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
  }
);
```

| Optional option | Default | Description |
| --- | --- | --- |
| `maxInterleaveDelayMs` | `200` | Maximum interleaving wait in milliseconds; finite and nonnegative |
| `maxPendingChunks` | `256` | Maximum interleaving queue size in packets; positive integer |

If a track stalls, output continues after the timeout or when the queue exceeds its limit. No video frames are synthesized. Late timestamps are moved forward, which can compress playback intervals. These limits apply only to the interleaving queue.

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
muxer.addRawChunk("video", frame); // Submit frames throughout capture.

await muxer.pause(); // When pausing.
muxer.resume();

await muxer.stop();
await finished;
```

#### Properties

- **`state`**: Returns the current state of the multiplexer. Possible values are `"recording"`, `"paused"`, or `"inactive"`.
