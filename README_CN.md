# FlvMuxer

[English](./README.md) | 中文

`flv-muxer.js` 是一个纯 TypeScript 编写的 `FLV` 复用器，可在 Web 平台实现原生 `FLV` 推流和录屏。

## 用例

- 通过 `WebTransport`、`WebSocket` 传输 `FLV` 流到流媒体服务器，实现 Web 直播
- 解决 `MediaRecorder` API 不支持 `FLV` 格式录制的问题

## 安装

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

`FlvMuxer` 是一个用于创建 `FLV` 复用器实例的类，提供流处理功能。

#### 构造函数

```ts
const muxer = new FlvMuxer(
  writable: WritableStream,
  options: {
    mode: "record" | "live";
    chunked: boolean; // 是否分块传输
    maxInterleaveDelayMs?: number;
    maxPendingChunks?: number;
    maxEncodeQueueSize?: number;
    maxOutputBytes?: number;
  }
)
```

| 可选参数 | 默认值 | 说明 |
| --- | --- | --- |
| `maxInterleaveDelayMs` | `200` | 交织最大等待毫秒数，有限非负数 |
| `maxPendingChunks` | `256` | 交织队列最大包数，正整数 |
| `maxEncodeQueueSize` | `32` | 每条轨道待编码请求上限，正整数 |
| `maxOutputBytes` | `8388608` | 输出缓存字节上限（含正在写入的数据），正安全整数 |

轨道停帧时，等待超时或队列超限会继续输出，不会自动补视频帧。迟到包的时间戳会向前调整，可能压缩播放间隔。`maxPendingChunks` 和 `maxInterleaveDelayMs` 仅限制交织队列。

`live` 模式在视频编码队列满或输出缓存达到一半时丢弃新输入的视频帧；`record` 模式过载会报 `BackpressureError`。音频编码队列满或输出缓存超限时，两种模式都会报错并停止。

编码、刷新或写入失败会清理队列、定时器和编码器，尝试中止输出，并使 `start()` 及进行中的 `pause()` / `stop()` 拒绝。失败后的实例不可复用。输入帧由 muxer 负责关闭，包括丢弃和报错时。

输出流的 `write()` 应返回实际写入完成的 Promise；若内部直接缓存并立即返回，muxer 无法感知其积压。

#### 方法

- **`configureAudio()`**: 配置音频编码器，必须在启动前调用。

  ```ts
  flvMuxer.configureAudio({
    encoderConfig: AudioEncoderConfig;
  });

  // 示例
  flvMuxer.configureAudio({
    encoderConfig: {
      codec: "mp4a.40.29",
      sampleRate: 44100,
      numberOfChannels: 2,
    },
  });
  ```

  音频编码器配置：[AudioEncoderConfig](https://developer.mozilla.org/en-US/docs/Web/API/AudioEncoder/configure#config)。

- **`configureVideo()`**: 配置视频编码器。必须在启动前调用，`keyframeInterval` 必须为正整数。

  ```ts
  muxer.configureVideo({
    encoderConfig: VideoEncoderConfig;
    keyframeInterval: number, // 关键帧间隔，单位为帧数
  });

  // 示例
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

  视频编码器配置: [VideoEncoderConfig](https://developer.mozilla.org/en-US/docs/Web/API/VideoEncoder/configure#config).

- **`addRawChunk`**: 添加原始帧数据。

  ```ts
  flvMuxer.addRawChunk("video" | "audio", chunk: VideoFrame | AudioData);

  // 示例
  flvMuxer.addRawChunk("video", chunk);
  ```

- **`start(): Promise<void>`**：开始处理，至少需配置一条轨道；重复启动会报错。Promise 在输出管线结束时完成。
- **`pause(): Promise<void>`**：暂停并排空待处理数据，完成后才能恢复。
- **`resume(): void`**：恢复处理。
- **`stop(): Promise<void>`**：停止并等待剩余数据写入，支持暂停后停止。输出流保持打开，可重新开始。

#### 调用示例

```ts
// 配置轨道后启动；此处不要 await。
const finished = muxer.start();
finished.catch(console.error); // 处理异步编码或输出错误
muxer.addRawChunk("video", frame); // 采集期间持续输入

await muxer.pause(); // 需要暂停时
muxer.resume();

await muxer.stop();
await finished;
```

#### 属性

- **`state`**: 返回复用器状态。值为 `"recording"`、`"paused"` 或 `"inactive"`。
