import { expect, test, type Page, type TestInfo } from "@playwright/test";
import { readFlv } from "./flv";
import { writeFile } from "node:fs/promises";

type Result = {
  bytes: number[];
  videoInputs: number;
  state: string;
  locked: boolean;
  errors: { name: string; message: string }[];
  abortReason?: string;
};
type Decoded = {
  videoFrames: { timestamp: number; pixel: number[] }[];
  audioFrames: { timestamp: number; duration: number }[];
  peak: number;
  errors: string[];
};

declare global {
  interface Window {
    integration: {
      support(): Promise<{ audio: boolean; video: boolean }>;
      record(): Promise<Result>;
      hardwareRecord(): Promise<Result>;
      staticScreen(): Promise<
        Result & {
          elapsed: number;
          before: number;
          during: number;
          maxAudioGap: number;
        }
      >;
      lifecycle(): Promise<Result & { files: number[][] }>;
      slowOutput(): Promise<
        Result & { writesBeforeRelease: number; writesAfterRelease: number }
      >;
      transferOutput(): Promise<Result & { receivedBytes: number }>;
      writeFailure(): Promise<
        Result & { completionError: string; stopError: string }
      >;
      decode(file: ReturnType<typeof readFlv>): Promise<Decoded>;
    };
  }
}

const pageErrors = new WeakMap<Page, string[]>();

test.beforeEach(async ({ page }) => {
  const errors: string[] = [];
  pageErrors.set(page, errors);
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto("/");
  await page.waitForFunction(() => !!window.integration);
  const supported = await page.evaluate(() => window.integration.support());
  expect(
    supported,
    "Chrome must support native H.264 and AAC encoding; unsupported codecs are not silently skipped"
  ).toEqual({ audio: true, video: true });
});

test.afterEach(async ({ page }) => {
  expect(pageErrors.get(page), "Unexpected browser errors").toEqual([]);
});

async function inspect(
  page: Page,
  info: TestInfo,
  bytes: number[],
  name: string
) {
  const path = info.outputPath(name + ".flv");
  await writeFile(path, Buffer.from(bytes));
  await info.attach(name + ".flv", { path, contentType: "video/x-flv" });
  const file = readFlv(bytes);
  expect(file.metadata).toBe(1);
  expect(file.video.length).toBeGreaterThan(0);
  expect(file.audio.length).toBeGreaterThan(0);
  expect(file.video[0].key).toBe(true);
  expect(file.timestamps).toEqual([...file.timestamps].sort((a, b) => a - b));

  const decoded = await page.evaluate(
    (file) => window.integration.decode(file),
    file
  );
  expect(decoded.errors).toEqual([]);
  expect(decoded.videoFrames).toHaveLength(file.video.length);
  expect(decoded.audioFrames).toHaveLength(file.audio.length);
  expect(decoded.peak).toBeGreaterThan(0.1);
  expect(decoded.peak).toBeLessThan(0.5);
  return { file, decoded };
}

function expectFinished(result: Result) {
  expect(result.errors).toEqual([]);
  expect(result.state).toBe("inactive");
  expect(result.locked).toBe(false);
}

test("records FLV with complete AVC/AAC payloads and synchronized decoded timestamps", async ({
  page,
}, info) => {
  const result = await page.evaluate(() => window.integration.record());
  expectFinished(result);
  const { file, decoded } = await inspect(
    page,
    info,
    result.bytes,
    "recording"
  );
  expect(file.video).toHaveLength(result.videoInputs);
  expect(result.videoInputs).toBe(30);

  const videoEnd = decoded.videoFrames.at(-1)!.timestamp + 40_000;
  const audioEnd =
    decoded.audioFrames.at(-1)!.timestamp +
    decoded.audioFrames.at(-1)!.duration;
  expect(Math.abs(videoEnd - audioEnd)).toBeLessThan(150_000);
  expect(decoded.videoFrames[0].pixel[0]).toBeGreaterThan(150);
  expect(decoded.videoFrames.at(-1)!.pixel[2]).toBeGreaterThan(150);
});

test("keeps audio flowing during 30 seconds without video and decodes resumed motion", async ({
  page,
}, info) => {
  const cdp = await page.context().newCDPSession(page);
  const sampleHeap = async () => {
    await cdp.send("HeapProfiler.collectGarbage");
    return (await cdp.send("Runtime.getHeapUsage")).usedSize;
  };
  const baseline = await sampleHeap();
  const heapSamples: number[] = [];
  const recording = page
    .evaluate(() => window.integration.staticScreen())
    .then(
      (result) => ({ result }),
      (error) => ({ error })
    );

  // Sample retained JS heap during the real-time stall, including captured FLV data.
  for (let i = 0; i < 6; i++) {
    await new Promise((resolve) => setTimeout(resolve, 5000));
    heapSamples.push(await sampleHeap());
  }

  const outcome = await recording;
  await cdp.detach();
  if ("error" in outcome) throw outcome.error;
  const result = outcome.result;
  const heapPath = info.outputPath("heap.json");
  await writeFile(heapPath, JSON.stringify({ baseline, heapSamples }, null, 2));
  await info.attach("retained-js-heap", {
    path: heapPath,
    contentType: "application/json",
  });
  expect(Math.max(...heapSamples) - baseline).toBeLessThan(16 * 1024 * 1024);
  expectFinished(result);
  expect(result.elapsed).toBeGreaterThanOrEqual(29_900);
  expect(result.before).toBeGreaterThan(0);
  expect(result.during).toBeGreaterThan(1000);
  // Generous wall-clock allowance for loaded CI machines; media gaps are checked separately.
  expect(result.maxAudioGap).toBeLessThan(2000);
  const { file, decoded } = await inspect(
    page,
    info,
    result.bytes,
    "static-30-seconds"
  );
  expect(file.video).toHaveLength(result.videoInputs);
  expect(
    file.video.filter(
      (sample) => sample.timestamp >= 400 && sample.timestamp < 30_400
    )
  ).toHaveLength(0);
  expect(file.audio.at(-1)!.timestamp).toBeGreaterThan(30_000);
  expect(
    Math.max(
      ...file.audio
        .slice(1)
        .map((sample, i) => sample.timestamp - file.audio[i].timestamp)
    )
  ).toBeLessThan(100);
  expect(decoded.videoFrames.at(-1)!.pixel[2]).toBeGreaterThan(150);
});

test("survives repeated pauses and restarts with fresh keyframes and timestamp origins", async ({
  page,
}, info) => {
  const result = await page.evaluate(() => window.integration.lifecycle());
  expectFinished(result);
  expect(result.files).toHaveLength(2);

  for (const [index, bytes] of result.files.entries()) {
    const { file } = await inspect(page, info, bytes, "session-" + index);
    expect(file.video).toHaveLength(18);
    expect(file.video[0].timestamp).toBe(0);
    for (const [index, boundary] of [0, 240, 480].entries()) {
      const resumed = file.video[index * 6];
      expect(resumed.key).toBe(true);
      // AAC flush padding can move a resumed video timestamp forward.
      expect(resumed.timestamp).toBeGreaterThanOrEqual(boundary);
      expect(resumed.timestamp).toBeLessThan(boundary + 100);
    }
  }
});

test("drains a blocked live sink and resumes without corrupting encoded references", async ({
  page,
}, info) => {
  const result = await page.evaluate(() => window.integration.slowOutput());
  expectFinished(result);
  expect(result.writesAfterRelease).toBeGreaterThan(result.writesBeforeRelease);
  const { file } = await inspect(page, info, result.bytes, "slow-output");
  expect(file.video.length).toBeLessThan(result.videoInputs);
  expect(file.video.at(-1)!.timestamp).toBeGreaterThanOrEqual(800);
});

test("propagates a real WritableStream write failure and releases its lock", async ({
  page,
}) => {
  const result = await page.evaluate(() => window.integration.writeFailure());
  expect(result.state).toBe("inactive");
  expect(result.locked).toBe(false);
  expect(result.errors).toEqual([
    { name: "Error", message: "intentional browser sink failure" },
  ]);
  expect(result.completionError).toBe("intentional browser sink failure");
  expect(result.stopError).toBe(result.completionError);
});

test("handles the default encoder path with an explicit cold-start budget", async ({
  page,
}, info) => {
  const result = await page.evaluate(() => window.integration.hardwareRecord());
  expectFinished(result);
  const { file, decoded } = await inspect(
    page,
    info,
    result.bytes,
    "default-encoder-path"
  );
  expect(file.video).toHaveLength(result.videoInputs);
  expect(file.video[0].timestamp).toBe(0);
  const videoEnd = decoded.videoFrames.at(-1)!.timestamp + 40_000;
  const lastAudio = decoded.audioFrames.at(-1)!;
  expect(
    Math.abs(videoEnd - lastAudio.timestamp - lastAudio.duration)
  ).toBeLessThan(150_000);
});

test("supports transferring output buffers to a worker without phantom backpressure", async ({
  page,
}, info) => {
  const result = await page.evaluate(() => window.integration.transferOutput());
  expectFinished(result);
  expect(result.receivedBytes).toBe(result.bytes.length);
  expect(result.receivedBytes).toBeGreaterThan(2000);
  const { file } = await inspect(
    page,
    info,
    result.bytes,
    "transferred-output"
  );
  expect(file.video).toHaveLength(result.videoInputs);
});
