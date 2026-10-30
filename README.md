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

## Tests

```sh
pnpm test --run                 # Unit tests
pnpm exec tsc --noEmit          # Type checking
pnpm test:browser              # Native Chrome integration tests, about 45 seconds
```

Browser tests require Node.js 20+ and an installed Google Chrome. Native WebCodecs encode and decode synthetic audio/video to check FLV integrity, timestamp synchronization, a 30-second video stall, pause/restart, slow-output frame dropping, buffer transfer, and write failures. The static case samples retained JS heap after GC (not native codec memory); FLV files and heap samples are saved under `test-results/browser/`.

Realtime cases explicitly use `prefer-software`. The default encoder path uses an encode queue limit of `128` and a `5000ms` interleaving wait to accommodate cold starts. Its startup took about two seconds locally; default budgets can overload or move late video timestamps forward. These tests do not establish suitable defaults for all hardware or cover screen-capture permissions and third-party players.

## Screen recording example

Run `pnpm build`, then serve the repository with `python3 -m http.server 8080` and open `http://localhost:8080/examples/` in desktop Chrome.

Click “选择保存位置” to choose an output file, then click Start Recording to select a screen. The example configures H.264/AAC from the captured tracks and supports video without audio. It writes chunks directly to disk rather than retaining the entire recording in memory. Pause and stop wait for encoding and file writes; the file closes only after the worker confirms completion. Ending screen sharing also saves the recording. Choose another output file and start again to create another recording.

Requires HTTPS or localhost, WebCodecs, MediaStreamTrackProcessor, and the File System Access API. Cancellation and encoding or disk errors release capture resources and the worker and abort the file write. The example allows extra encoder cold-start headroom; overloaded devices can still fail, with the error shown on the page.

Inspect the saved file with `ffprobe recording.flv` and a player such as VLC to check audio, video, and the end of the recording. Screen permissions, system audio availability, and third-party player compatibility require manual verification.
