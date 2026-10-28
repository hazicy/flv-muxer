import FlvMuxer from "/muxer.js";

const audioConfig = {
  codec: "mp4a.40.2",
  sampleRate: 48_000,
  numberOfChannels: 1,
  bitrate: 96_000,
};
const videoConfig = {
  codec: "avc1.42001e",
  width: 320,
  height: 180,
  framerate: 25,
  bitrate: 250_000,
  latencyMode: "realtime",
  hardwareAcceleration: "prefer-software",
  avc: { format: "avc" },
};
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function support() {
  const audio = await AudioEncoder.isConfigSupported(audioConfig);
  const video = await VideoEncoder.isConfigSupported(videoConfig);
  return { audio: audio.supported, video: video.supported };
}

function session(options = {}, sink = {}, videoOverrides = {}) {
  const chunks = [];
  const writes = [];
  const errors = [];
  const canvas = new OffscreenCanvas(320, 180);
  const context = canvas.getContext("2d");
  let time = 0;
  let completed;
  let videoInputs = 0;
  let abortReason;

  const writable = new WritableStream({
    async write(chunk) {
      const saved = chunk.slice();
      await sink.write?.(chunk);
      chunks.push(saved);
      writes.push({
        at: performance.now(),
        type: saved[0],
        timestamp: readTimestamp(saved),
      });
    },
    abort(error) {
      abortReason = error.message;
    },
  });
  const muxer = new FlvMuxer(writable, {
    mode: "record",
    chunked: false,
    maxInterleaveDelayMs: 100,
    ...options,
  });
  muxer.configureAudio({ encoderConfig: audioConfig });
  muxer.configureVideo({
    encoderConfig: { ...videoConfig, ...videoOverrides },
    keyframeInterval: 25,
  });

  function start() {
    completed = muxer.start().then(
      () => null,
      (error) => {
        errors.push({ name: error.name, message: error.message });
        return error;
      }
    );
  }

  function video() {
    context.fillStyle = time < 400_000 ? "#d02020" : "#2040d0";
    context.fillRect(0, 0, 320, 180);
    context.fillStyle = "white";
    context.fillRect((time / 10_000) % 280, 100, 20, 20);
    muxer.addRawChunk(
      "video",
      new VideoFrame(canvas, { timestamp: time, duration: 40_000 })
    );
    videoInputs++;
  }

  function audio() {
    const samples = new Float32Array(960);
    for (let i = 0; i < samples.length; i++) {
      samples[i] =
        Math.sin(2 * Math.PI * 440 * (time / 1e6 + i / 48_000)) * 0.25;
    }
    muxer.addRawChunk(
      "audio",
      new AudioData({
        format: "f32-planar",
        sampleRate: 48_000,
        numberOfChannels: 1,
        numberOfFrames: samples.length,
        timestamp: time,
        data: samples,
      })
    );
  }

  async function feed(durationMs, withVideo = true) {
    const end = time + durationMs * 1000;
    const wallStart = performance.now();
    const mediaStart = time;

    while (time < end) {
      if (errors.length) throw new Error(errors[0].message);
      if (withVideo && time % 40_000 === 0) video();
      audio();
      time += 20_000;
      // Pace real encoder input and keep media timestamps separate from timer jitter.
      await delay(
        Math.max(
          0,
          (time - mediaStart) / 1000 - (performance.now() - wallStart)
        )
      );
    }
  }

  async function finish() {
    await muxer.stop();
    const error = await completed;
    if (error) throw error;
  }

  function bytes() {
    const data = new Uint8Array(
      chunks.reduce((sum, chunk) => sum + chunk.length, 0)
    );
    let offset = 0;
    for (const chunk of chunks) {
      data.set(chunk, offset);
      offset += chunk.length;
    }
    return Array.from(data);
  }

  return {
    muxer,
    writable,
    start,
    feed,
    finish,
    bytes,
    video,
    audio,
    errors,
    writes,
    result: () => ({
      bytes: bytes(),
      videoInputs,
      state: muxer.state,
      locked: writable.locked,
      errors,
      abortReason,
    }),
    completion: () => completed,
  };
}

function readTimestamp(chunk) {
  if (chunk[0] !== 8 && chunk[0] !== 9) return null;
  return chunk[4] * 65536 + chunk[5] * 256 + chunk[6] + chunk[7] * 16777216;
}

async function record(defaultHardware = false) {
  const run = defaultHardware
    ? session(
        { maxEncodeQueueSize: 128, maxInterleaveDelayMs: 5000 },
        {},
        { hardwareAcceleration: "no-preference" }
      )
    : session();
  run.start();
  await run.feed(1200);
  await run.finish();
  return run.result();
}

async function staticScreen() {
  const run = session();
  run.start();
  await run.feed(400);
  const start = performance.now();
  const before = run.writes.filter((write) => write.type === 8).length;

  await run.feed(30_000, false);
  const end = performance.now();
  const audioWrites = run.writes.filter(
    (write) => write.type === 8 && write.at >= start && write.at <= end
  );
  await run.feed(400);
  await run.finish();

  return {
    ...run.result(),
    elapsed: end - start,
    before,
    during: audioWrites.length,
    maxAudioGap: Math.max(
      ...audioWrites.slice(1).map((write, i) => write.at - audioWrites[i].at)
    ),
  };
}

async function lifecycle() {
  const run = session();
  const files = [];

  for (let recording = 0; recording < 2; recording++) {
    const offset = run.bytes().length;
    run.start();
    for (let i = 0; i < 3; i++) {
      await run.feed(240);
      await run.muxer.pause();
      // Frames submitted while paused must be consumed and discarded.
      const pausedCanvas = new OffscreenCanvas(320, 180);
      pausedCanvas.getContext("2d").fillRect(0, 0, 320, 180);
      const pausedFrame = new VideoFrame(pausedCanvas, { timestamp: 999_000 });
      run.muxer.addRawChunk("video", pausedFrame);
      if (pausedFrame.codedWidth !== 0)
        throw new Error("Paused frame was not closed");
      run.muxer.resume();
    }
    await run.muxer.pause();
    await run.finish();
    files.push(run.bytes().slice(offset));
  }

  return { ...run.result(), files };
}

async function slowOutput() {
  let release;
  let blocked = false;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const run = session(
    { mode: "live", maxOutputBytes: 6000 },
    {
      write: () => (blocked ? gate : undefined),
    }
  );
  run.start();
  await run.feed(240);
  blocked = true;
  await run.feed(800);
  const writesBeforeRelease = run.writes.length;
  release();
  blocked = false;
  await run.feed(240);
  await run.finish();

  return {
    ...run.result(),
    writesBeforeRelease,
    writesAfterRelease: run.writes.length,
  };
}

async function transferOutput() {
  const channel = new MessageChannel();
  let receivedBytes = 0;
  channel.port2.onmessage = (event) => {
    receivedBytes += event.data.byteLength;
  };
  const run = session(
    { maxOutputBytes: 2000 },
    {
      write(chunk) {
        channel.port1.postMessage(chunk.buffer, [chunk.buffer]);
      },
    }
  );

  try {
    run.start();
    await run.feed(1200);
    await run.finish();
    const result = run.result();
    while (receivedBytes < result.bytes.length) await delay(1);
    return { ...result, receivedBytes };
  } finally {
    channel.port1.close();
    channel.port2.close();
  }
}

async function writeFailure() {
  const expected = new Error("intentional browser sink failure");
  let fail = false;
  const run = session(
    {},
    {
      write() {
        if (fail) throw expected;
      },
    }
  );
  run.start();
  await run.feed(240);
  fail = true;
  try {
    await run.feed(400);
  } catch {
    /* The completion promise carries the original error. */
  }
  const error = await run.completion();
  let stopError;
  try {
    await run.muxer.stop();
  } catch (reason) {
    stopError = reason.message;
  }

  return { ...run.result(), completionError: error?.message, stopError };
}

async function decode({
  videoConfig: description,
  audioConfig: audioDescription,
  video,
  audio,
}) {
  const videoFrames = [];
  const audioFrames = [];
  const errors = [];
  let peak = 0;
  const canvas = new OffscreenCanvas(320, 180);
  const context = canvas.getContext("2d");
  const videoDecoder = new VideoDecoder({
    output(frame) {
      try {
        context.drawImage(frame, 0, 0);
        videoFrames.push({
          timestamp: frame.timestamp,
          pixel: Array.from(context.getImageData(5, 5, 1, 1).data),
        });
      } finally {
        frame.close();
      }
    },
    error: (error) => errors.push(error.message),
  });
  const audioDecoder = new AudioDecoder({
    output(data) {
      try {
        const samples = new Float32Array(data.numberOfFrames);
        data.copyTo(samples, { planeIndex: 0, format: "f32-planar" });
        for (const sample of samples) peak = Math.max(peak, Math.abs(sample));
        audioFrames.push({
          timestamp: data.timestamp,
          duration: data.duration,
        });
      } finally {
        data.close();
      }
    },
    error: (error) => errors.push(error.message),
  });

  try {
    const codec =
      "avc1." +
      description
        .slice(1, 4)
        .map((value) => value.toString(16).padStart(2, "0"))
        .join("");
    videoDecoder.configure({ codec, description: new Uint8Array(description) });
    audioDecoder.configure({
      ...audioConfig,
      description: new Uint8Array(audioDescription),
    });

    // Bound decoder input too, so a 30-second file does not flood the decoder queue.
    for (let i = 0; i < Math.max(video.length, audio.length); i++) {
      const v = video[i];
      if (v)
        videoDecoder.decode(
          new EncodedVideoChunk({
            type: v.key ? "key" : "delta",
            timestamp: v.timestamp * 1000,
            data: new Uint8Array(v.data),
          })
        );
      const a = audio[i];
      if (a)
        audioDecoder.decode(
          new EncodedAudioChunk({
            type: "key",
            timestamp: a.timestamp * 1000,
            data: new Uint8Array(a.data),
          })
        );
      while (
        videoDecoder.decodeQueueSize >= 16 ||
        audioDecoder.decodeQueueSize >= 16
      ) {
        if (errors.length) throw new Error(errors[0]);
        await delay(1);
      }
    }
    await Promise.all([videoDecoder.flush(), audioDecoder.flush()]);
    return { videoFrames, audioFrames, peak, errors };
  } finally {
    if (videoDecoder.state !== "closed") videoDecoder.close();
    if (audioDecoder.state !== "closed") audioDecoder.close();
  }
}

window.integration = {
  support,
  record,
  hardwareRecord: () => record(true),
  staticScreen,
  lifecycle,
  slowOutput,
  writeFailure,
  transferOutput,
  decode,
};
