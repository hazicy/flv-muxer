import { afterEach, describe, expect, it, vi } from "vitest";
import { StreamProcessor, type TrackChunk } from "../src/core/stream-processor";
import { EventBus } from "../src/core/event-bus";

function setup(limit = 256) {
  const bus = new EventBus();
  const processor = new StreamProcessor(bus, 200, limit);
  const output: TrackChunk[] = [];
  bus.on("CHUNK_PUBLISH", (chunk) => output.push(chunk));
  const track = () => ({
    close: vi.fn(),
    reset: vi.fn(),
    flush: vi.fn(async () => {}),
    addTrackChunk: vi.fn(),
  });
  const audio = track();
  const video = track();
  processor.addAudioTrack(audio as never);
  processor.addVideoTrack(video as never);
  processor.start();
  return { processor, output, bus, audio, video };
}
const chunk = (type: TrackChunk["type"], timestamp: number): TrackChunk => ({
  type,
  timestamp,
  data: new Uint8Array([1]),
  isKey: true,
});
afterEach(() => vi.useRealTimers());
describe("interleaving", () => {
  it("releases audio when video is static without another incoming packet", () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] });
    const { processor, output } = setup();
    processor.handleTrackChunk(chunk("AVC_NALU", 0));
    processor.handleTrackChunk(chunk("AAC_RAW", 0));
    processor.handleTrackChunk(chunk("AAC_RAW", 100));
    expect(output.map((c) => c.timestamp)).toEqual([0, 0]);
    vi.advanceTimersByTime(201);
    expect(output.map((c) => c.timestamp)).toEqual([0, 0, 100]);
    processor.handleTrackChunk(chunk("AVC_NALU", 50));
    expect(output.at(-1)?.timestamp).toBe(100);
    expect(output.at(-1)?.type).toBe("AVC_NALU");
  });
  it("bounds the queue even when the other track never starts", async () => {
    const { processor, output } = setup(2);
    for (let i = 0; i < 5; i++) processor.handleTrackChunk(chunk("AAC_RAW", i));
    expect(output).toHaveLength(3);
    await processor.stop();
    expect(output).toHaveLength(5);
  });
  it("keeps instances isolated", async () => {
    const first = setup();
    const second = setup();
    first.bus.emit("TRACK_CHUNK", chunk("AAC_RAW", 100));
    await first.processor.stop();
    expect(first.output).toHaveLength(1);
    expect(second.output).toHaveLength(0);
    expect(second.processor.state).toBe("recording");
    await second.processor.stop();
  });
  it("rejects input during flush and drains flush output before stopping", async () => {
    const { processor, audio, output } = setup();
    audio.flush.mockImplementation(async () => {
      processor.handleTrackChunk(chunk("AAC_RAW", 100));
    });
    const stopping = processor.stop();
    const frame = { timestamp: 0, close: vi.fn() };
    processor.addTrackChunk("audio", frame as never);
    expect(frame.close).toHaveBeenCalledOnce();
    await stopping;
    expect(output).toHaveLength(1);
    expect(processor.state).toBe("inactive");
  });
  it("stops from paused and clears timers", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] });
    const { processor } = setup();
    processor.handleTrackChunk(chunk("AAC_RAW", 10));
    await processor.pause();
    await processor.stop();
    expect(processor.state).toBe("inactive");
    expect(vi.getTimerCount()).toBe(0);
  });
  it("anchors zero timestamps without reinitializing the clock", async () => {
    const { processor } = setup();
    processor.addTrackChunk("audio", { timestamp: 0 } as never);
    processor.addTrackChunk("video", { timestamp: 1000 } as never);
    expect(processor.trackState.offsetTimestamp).toBe(0);
    await processor.stop();
  });
});
