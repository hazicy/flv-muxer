import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { expect, it } from "vitest";

const source = readFileSync(new URL("../examples/worker.js", import.meta.url), "utf8");

function worker() {
  const messages: any[] = [];
  let sink: WritableStream;
  let complete!: () => void;
  let video: any;
  let audio: any;
  let write: Promise<void> = Promise.resolve();
  class Muxer {
    constructor(stream: WritableStream) { sink = stream; }
    configureVideo(config: unknown) { video = config; }
    configureAudio(config: unknown) { audio = config; }
    start() { return new Promise<void>((resolve) => { complete = resolve; }); }
    async stop() { await write; complete(); }
  }
  const self: any = { postMessage: (message: unknown) => messages.push(message) };
  runInNewContext(source, {
    self, importScripts() {}, FlvMuxer: Muxer, WritableStream,
    VideoEncoder: { isConfigSupported: async () => ({ supported: true }) },
    AudioEncoder: { isConfigSupported: async () => ({ supported: true }) },
  });
  return {
    messages,
    send: (data: unknown) => self.onmessage({ data }),
    get video() { return video; },
    get audio() { return audio; },
    output() {
      const writer = sink.getWriter();
      write = writer.write(new Uint8Array([1, 2, 3]));
      return write;
    },
  };
}

it("configures actual video dimensions and allows capture without audio", async () => {
  const w = worker();
  await w.send({ type: "START", id: 1, video: { width: 1920, height: 1080, framerate: 25 } });
  expect(w.video.encoderConfig).toMatchObject({ width: 1920, height: 1080, framerate: 25 });
  expect(w.audio).toBeUndefined();
  expect(w.messages).toEqual([{ type: "ACK", id: 1 }]);
});

it("waits for file write acknowledgement before confirming stop", async () => {
  const w = worker();
  await w.send({ type: "START", id: 1, video: { width: 640, height: 480 } });
  const output = w.output();
  await Promise.resolve();
  const stopping = w.send({ type: "STOP", id: 2 });
  expect(w.messages.some((message) => message.id === 2)).toBe(false);
  const chunk = w.messages.find((message) => message.type === "OUTPUT");
  expect(new Uint8Array(chunk.buffer)).toEqual(new Uint8Array([1, 2, 3]));
  await w.send({ type: "WRITE_ACK", id: chunk.id });
  await output;
  await stopping;
  expect(w.messages.at(-1)).toEqual({ type: "ACK", id: 2 });
});

it("reports rejected file writes to the page", async () => {
  const w = worker();
  await w.send({ type: "START", id: 1, video: { width: 640, height: 480 } });
  const output = w.output();
  const rejected = expect(output).rejects.toThrow("disk full");
  await Promise.resolve();
  const chunk = w.messages.find((message) => message.type === "OUTPUT");
  await w.send({ type: "WRITE_ACK", id: chunk.id, error: "disk full" });
  await rejected;
  await w.send({ type: "STOP", id: 2 });
  expect(w.messages.at(-1)).toEqual({ type: "ERROR", message: "disk full" });
});

it("closes the recording file only after the worker confirms stop", async () => {
  const { createContext, runInContext } = await import("node:vm");
  const { vi } = await import("vitest");
  const events: string[] = [];
  let acknowledge!: () => void;
  const elements = new Map();
  const context = createContext({
    document: { querySelector(selector: string) {
      if (!elements.has(selector)) elements.set(selector, { className: "", textContent: "", disabled: false });
      return elements.get(selector);
    } },
    performance, setInterval() {}, Date,
  });
  runInContext(readFileSync(new URL("../examples/example.js", import.meta.url), "utf8"), context);
  context.fake = {
    accepting: true,
    pending: new Map(),
    readers: [{ async cancel() { events.push("cancel input"); } }],
    pumps: [Promise.resolve()],
    stream: { getTracks: () => [{ stop() { events.push("stop track"); } }] },
    worker: {
      postMessage(data: any) {
        events.push(data.type);
        acknowledge = () => context.fake.pending.get(data.id).resolve();
      },
      terminate() { events.push("terminate"); },
    },
    file: { async close() { events.push("close file"); } },
  };
  runInContext('session = fake; setState("recording", "recording");', context);
  const stopping = runInContext("stopRecording()", context);
  await vi.waitFor(() => expect(events).toContain("STOP"));
  expect(events).not.toContain("close file");
  acknowledge();
  await stopping;
  expect(events.indexOf("close file")).toBeGreaterThan(events.indexOf("STOP"));
  expect(events.at(-1)).toBe("stop track");
  expect(runInContext("state", context)).toBe("inactive");
});
