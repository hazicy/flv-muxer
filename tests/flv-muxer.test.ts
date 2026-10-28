import { afterEach, expect, it, vi } from "vitest";
import { FlvMuxer } from "../src/core/flv-muxer";

class MockAudioEncoder {
  pending: number[] = [];
  constructor(
    private callbacks: { output: (chunk: unknown, metadata: unknown) => void }
  ) {}
  configure() {}
  reset() {
    this.pending = [];
  }
  close() {}
  encode(frame: { timestamp: number }) {
    this.pending.push(frame.timestamp);
  }
  async flush() {
    for (const timestamp of this.pending.splice(0)) {
      this.callbacks.output(
        {
          timestamp,
          byteLength: 1,
          type: "key",
          copyTo: (data: Uint8Array) => data.set([42]),
        },
        { decoderConfig: { description: new Uint8Array([0x12, 0x10]).buffer } }
      );
    }
  }
}
afterEach(() => vi.unstubAllGlobals());
it("delivers flush output before stop resolves, supports restart and isolates muxers", async () => {
  vi.stubGlobal("AudioEncoder", MockAudioEncoder);
  const create = () => {
    const output: Uint8Array[] = [];
    const muxer = new FlvMuxer(
      new WritableStream({
        write(chunk) {
          output.push(chunk);
        },
      }),
      { mode: "live", chunked: false }
    );
    muxer.configureAudio({
      encoderConfig: {
        codec: "mp4a.40.2",
        sampleRate: 44100,
        numberOfChannels: 2,
      },
    });
    return { muxer, output };
  };
  const a = create();
  const b = create();
  const aRun = a.muxer.start();
  const bRun = b.muxer.start();
  const close = vi.fn();
  a.muxer.addRawChunk("audio", { timestamp: 0, close } as never);
  await a.muxer.stop();
  await aRun;
  expect(a.output).toHaveLength(4); // FLV header, metadata, AAC config, AAC frame
  expect(b.output).toHaveLength(2);
  expect(close).toHaveBeenCalledOnce();
  const restart = a.muxer.start();
  a.muxer.addRawChunk("audio", { timestamp: 5000, close } as never);
  await a.muxer.pause();
  await a.muxer.stop();
  await restart;
  expect(a.output).toHaveLength(8);
  await b.muxer.stop();
  await bRun;
});
