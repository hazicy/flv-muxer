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

## 测试

```sh
pnpm test --run                 # 单元测试
pnpm exec tsc --noEmit          # 类型检查
pnpm test:browser              # 真实 Chrome 集成测试，约 45 秒
```

浏览器测试需要 Node.js 20+ 和已安装的 Google Chrome。使用原生 WebCodecs 编解码合成音视频，覆盖 FLV 完整性、时间戳同步、30 秒视频停帧、暂停重启、慢速输出丢帧、缓冲区转移及写入失败。静止用例会采样 GC 后的 JS 堆（不含原生编码器内存）；FLV 和采样结果保存在 `test-results/browser/`。

实时用例显式使用 `prefer-software`；默认编码路径用例将编码队列上限设为 `128`、交织等待设为 `5000ms`，以容纳冷启动。本机默认路径启动约 2 秒，默认预算可能过载或前移迟到帧时间戳；这些测试不代表所有硬件的默认配置都适用，也不覆盖屏幕采集权限和第三方播放器。

## 屏幕录制示例

先执行 `pnpm build`，然后在项目根目录执行 `python3 -m http.server 8080`，用 Chrome 桌面版打开 `http://localhost:8080/examples/`。

先点击“选择保存位置”，再点击开始并选择共享屏幕。示例根据实际轨道配置 H.264/AAC 编码；没有共享音频时只录视频。输出逐块写入文件，不在内存中累积整段录像。暂停和停止会等待 Worker 完成编码与文件写入，停止完成后才关闭文件；浏览器的“停止共享”也会结束并保存录像。可重新选择保存位置并开始新录像。

需要安全上下文（HTTPS 或 localhost），以及 WebCodecs、MediaStreamTrackProcessor 和 File System Access API。取消授权或发生编码、磁盘写入错误时会清理采集和 Worker，并中止本次文件写入。示例使用较宽松的编码冷启动预算，实际设备仍可能过载；页面会显示失败原因。

保存后可用 `ffprobe recording.flv` 检查轨道和时间戳，并用 VLC 等支持 FLV 的播放器检查画面、声音和末尾完整性。真实屏幕授权、系统音频可用性和第三方播放器兼容性需要手动验证。
