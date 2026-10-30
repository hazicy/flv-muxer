let session;
let outputHandle;
let state = "inactive";
let nextId = 0;
let elapsed = 0;
let recordingSince = 0;
const statusText = document.querySelector(".status-text");
const preview = document.querySelector("video");

function setState(value, message) {
  if (state === "recording") elapsed += performance.now() - recordingSince;
  state = value;
  if (value === "recording") recordingSince = performance.now();
  document.querySelector(".status").className = "status " + value;
  statusText.textContent = message;
  for (const [action, enabled] of Object.entries({
    select: value === "inactive",
    start: value === "inactive" && !!outputHandle,
    stop: value === "recording" || value === "paused",
    pause: value === "recording",
    resume: value === "paused",
  })) document.querySelector(`.${action}-button`).disabled = !enabled;
}

setInterval(() => {
  const ms = elapsed + (state === "recording" ? performance.now() - recordingSince : 0);
  document.querySelector(".timer").textContent = new Date(ms).toISOString().slice(11, 19);
}, 250);
setState("inactive", "准备就绪（需要 Chrome 桌面版和 HTTPS 或 localhost）");

function request(s, type, payload = {}, transfer = []) {
  return new Promise((resolve, reject) => {
    const id = nextId++;
    s.pending.set(id, { resolve, reject });
    try {
      s.worker.postMessage({ type, id, ...payload }, transfer);
    } catch (error) {
      s.pending.delete(id);
      reject(error);
    }
  });
}

async function cleanup(s, error) {
  if (s.cleaning) return s.cleaning;
  s.cleaning = (async () => {
    s.accepting = false;
    s.worker?.terminate();
    for (const { reject } of s.pending.values()) reject(error ?? new Error("录制已结束"));
    s.pending.clear();
    await Promise.allSettled(s.readers.map((reader) => reader.cancel()));
    s.stream?.getTracks().forEach((track) => track.stop());
    if (error) await s.file?.abort().catch(() => {});
    preview.srcObject = null;
    if (session === s) {
      session = undefined;
      setState("inactive", error ? `录制失败：${error.message}` : "文件已保存");
    }
  })();
  return s.cleaning;
}

async function chooseFile() {
  if (state !== "inactive") return;
  setState("selecting", "请选择保存位置…");
  try {
    if (!window.showSaveFilePicker || !window.MediaStreamTrackProcessor) {
      throw new Error("请使用支持文件写入和媒体轨道处理的 Chrome 桌面版");
    }
    outputHandle = await window.showSaveFilePicker({
      suggestedName: "recording.flv",
      types: [{ description: "FLV Video", accept: { "video/x-flv": [".flv"] } }],
    });
    setState("inactive", "保存位置已选择，请点击开始并选择共享屏幕");
  } catch (error) {
    setState("inactive", error.name === "AbortError" ? "已取消选择文件" : error.message);
  }
}

async function startRecording() {
  if (state !== "inactive" || !outputHandle) return;
  setState("starting", "请选择保存位置和共享屏幕…");
  elapsed = 0;
  const s = { pending: new Map(), readers: [], pumps: [], accepting: true };
  session = s;
  try {
    const handle = outputHandle;
    outputHandle = undefined;
    // Screen capture has its own click gesture, separate from the file picker.
    s.stream = await navigator.mediaDevices.getDisplayMedia({ video: { frameRate: 30 }, audio: true });
    s.file = await handle.createWritable();
    s.worker = new Worker("./worker.js");
    s.worker.onerror = (event) => {
      event.preventDefault();
      void cleanup(s, new Error(event.message));
    };
    s.worker.onmessage = async ({ data }) => {
      if (data.type === "OUTPUT") {
        try {
          await s.file.write(new Uint8Array(data.buffer));
          s.worker.postMessage({ type: "WRITE_ACK", id: data.id });
        } catch (error) {
          await cleanup(s, error);
        }
      } else if (data.type === "ERROR") {
        await cleanup(s, new Error(data.message));
      } else if (data.type === "ACK") {
        s.pending.get(data.id)?.resolve();
        s.pending.delete(data.id);
      }
    };
    const videoTrack = s.stream.getVideoTracks()[0];
    const audioTrack = s.stream.getAudioTracks()[0];
    const video = videoTrack.getSettings();
    const audio = audioTrack?.getSettings();
    await request(s, "START", {
      video: { width: video.width, height: video.height, framerate: video.frameRate ?? 30 },
      audio: audio && { sampleRate: audio.sampleRate ?? 48000, numberOfChannels: audio.channelCount ?? 2 },
    });
    preview.srcObject = s.stream;
    void preview.play().catch(() => {});
    setState("recording", audioTrack ? "录制中" : "录制中（无音频）");
    for (const track of s.stream.getTracks()) {
      const reader = new MediaStreamTrackProcessor({ track }).readable.getReader();
      s.readers.push(reader);
      s.pumps.push((async () => {
        try {
          while (s.accepting) {
            const { value, done } = await reader.read();
            if (done) break;
            if (!s.accepting || state !== "recording") {
              value.close();
              continue;
            }
            try {
              await request(s, "FRAME", { track: track.kind, chunk: value }, [value]);
            } catch (error) {
              value.close();
              throw error;
            }
          }
        } catch (error) {
          if (s.accepting) void cleanup(s, error);
        }
      })());
    }
    videoTrack.onended = () => {
      s.ended = true;
      if (session === s) void stopRecording();
    };
    if (videoTrack.readyState === "ended") videoTrack.onended();
  } catch (error) {
    await cleanup(s, error);
  }
}

async function pauseRecording() {
  if (state !== "recording") return;
  const s = session;
  setState("pausing", "正在暂停…");
  try {
    await request(s, "PAUSE");
    setState("paused", "已暂停");
    if (s.ended) void stopRecording();
  } catch (error) { await cleanup(s, error); }
}

async function resumeRecording() {
  if (state !== "paused") return;
  const s = session;
  setState("resuming", "正在恢复…");
  try {
    await request(s, "RESUME");
    setState("recording", "录制中");
    if (s.ended) void stopRecording();
  } catch (error) { await cleanup(s, error); }
}

async function stopRecording() {
  if (!["recording", "paused"].includes(state)) return;
  const s = session;
  setState("stopping", "正在排空编码和文件写入…");
  s.accepting = false;
  try {
    await Promise.all(s.readers.map((reader) => reader.cancel()));
    await Promise.all(s.pumps);
    s.stream.getTracks().forEach((track) => track.stop());
    await request(s, "STOP");
    await s.file.close();
    await cleanup(s);
  } catch (error) { await cleanup(s, error); }
}
