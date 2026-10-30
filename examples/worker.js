importScripts("../dist/flv-muxer.iife.js");

let muxer;
let finished;
let nextOutputId = 0;
const writes = new Map();
let failed = false;

function fail(error) {
  if (failed) return;
  failed = true;
  for (const { reject } of writes.values()) reject(error);
  writes.clear();
  self.postMessage({ type: "ERROR", message: error.message ?? String(error) });
}

self.onmessage = async ({ data }) => {
  if (data.type === "WRITE_ACK") {
    const pending = writes.get(data.id);
    writes.delete(data.id);
    if (data.error) pending?.reject(new Error(data.error));
    else pending?.resolve();
    return;
  }

  try {
    if (failed) {
      data.chunk?.close();
      return;
    }
    if (data.type === "START") {
      const writable = new WritableStream({
        write(chunk) {
          const id = nextOutputId++;
          return new Promise((resolve, reject) => {
            writes.set(id, { resolve, reject });
            self.postMessage({ type: "OUTPUT", id, buffer: chunk.buffer }, [chunk.buffer]);
          });
        },
      });
      muxer = new FlvMuxer(writable, {
        mode: "record",
        chunked: false,
        maxEncodeQueueSize: 128,
        maxInterleaveDelayMs: 5000,
      });
      const video = {
        codec: "avc1.420033",
        ...data.video,
        bitrate: 8_000_000,
        latencyMode: "realtime",
        avc: { format: "avc" },
      };
      if (!(await VideoEncoder.isConfigSupported(video)).supported) {
        throw new Error("此浏览器不支持当前屏幕尺寸的 H.264 编码");
      }
      muxer.configureVideo({ encoderConfig: video, keyframeInterval: 90 });
      if (data.audio) {
        const audio = { codec: "mp4a.40.2", ...data.audio, bitrate: 128_000 };
        if (!(await AudioEncoder.isConfigSupported(audio)).supported) {
          throw new Error("此浏览器不支持当前音轨的 AAC 编码");
        }
        muxer.configureAudio({ encoderConfig: audio });
      }
      finished = muxer.start();
      finished.catch(fail);
    } else if (data.type === "FRAME") {
      muxer.addRawChunk(data.track, data.chunk);
    } else if (data.type === "PAUSE") {
      await muxer.pause();
    } else if (data.type === "RESUME") {
      muxer.resume();
    } else if (data.type === "STOP") {
      await muxer.stop();
      await finished;
    }
    if (!failed) self.postMessage({ type: "ACK", id: data.id });
  } catch (error) {
    fail(error);
  }
};
