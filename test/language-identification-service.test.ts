import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import type { LangIdResult } from "transcribe-cpp";
import { Deferred } from "../src/deferred.js";
import { LANGUAGE_DETECTION_MODEL } from "../src/language-detection-model.js";
import type { TranscribeSettings } from "../src/settings.js";
import type { DictationStream, TranscriptionOptions } from "../src/transcription.js";
import { TranscriptionService } from "../src/transcription-service.js";
import { nextTurn, prediction, ramp } from "./helpers.js";
import { cacheCatalogModel, isolatedModelCache } from "./model-cache-helper.js";

function settings(overrides: Partial<TranscribeSettings> = {}): TranscribeSettings {
  return {
    version: 1,
    backend: { type: "transcribe-cpp" },
    shortcut: "ctrl+alt+z",
    preferredLanguages: ["en", "de"],
    transcriptionLanguage: "auto",
    chineseOutput: "simplified",
    microphone: { type: "system-default" },
    model: { source: "catalog", id: "canary-180m-flash", path: "/mock/canary.gguf" },
    ...overrides,
  };
}

type AsrBackend = {
  prepare(): Promise<void>;
  startStream?(options?: TranscriptionOptions): Promise<DictationStream | undefined>;
  transcribe(pcm: Float32Array, options?: TranscriptionOptions): Promise<string>;
};
type Detector = {
  prepare(): Promise<void>;
  identify(pcm: Float32Array, allowed: readonly string[], signal?: AbortSignal): Promise<LangIdResult>;
};

/** The detector is the same backend type, created for the cached detector path. */
function harness(t: TestContext, asr: Partial<AsrBackend> = {}, detector: Partial<Detector> = {}) {
  cacheCatalogModel(isolatedModelCache(t), LANGUAGE_DETECTION_MODEL);
  const events: string[] = [];
  const asrCalls: { pcm: Float32Array; options: TranscriptionOptions }[] = [];
  const detectorCalls: { pcm: Float32Array; allowed: readonly string[]; signal?: AbortSignal }[] = [];
  const streamOptions: TranscriptionOptions[] = [];
  let detectorLoads = 0;
  let detectorDisposals = 0;
  const service = new TranscriptionService((path) => {
    if (path.endsWith(LANGUAGE_DETECTION_MODEL.filename)) {
      detectorLoads++;
      return {
        async prepare() { events.push("detector:prepare"); await detector.prepare?.(); },
        async transcribe() { throw new Error("the detector never transcribes"); },
        async identifyLanguage(pcm, allowed, signal) {
          events.push("detector:run");
          detectorCalls.push({ pcm, allowed, signal });
          return detector.identify ? detector.identify(pcm, allowed, signal) : prediction();
        },
        async dispose() { detectorDisposals++; events.push("detector:dispose"); },
      };
    }
    return {
      async prepare() { events.push("asr:prepare"); await asr.prepare?.(); },
      ...(asr.startStream ? { async startStream(options: TranscriptionOptions = {}) {
        streamOptions.push(options);
        return asr.startStream!(options);
      } } : {}),
      async transcribe(pcm, options = {}) {
        events.push("asr:run");
        asrCalls.push({ pcm, options });
        options.signal?.throwIfAborted();
        return asr.transcribe ? asr.transcribe(pcm, options) : "transcript";
      },
      async dispose() { events.push("asr:dispose"); },
    };
  });
  t.after(() => service.shutdown());
  return {
    service, events, asrCalls, detectorCalls, streamOptions,
    get detectorLoads() { return detectorLoads; },
    get detectorDisposals() { return detectorDisposals; },
  };
}

test("dictation warms the detector while recording, then detects on the submitted clip before batch ASR", async (t) => {
  const h = harness(t, { async startStream() { throw new Error("external detection must use batch ASR"); } });
  const reservation = h.service.reserveDictation(settings());
  await reservation.ready;
  reservation.feed(new Float32Array(32000));
  await nextTurn();
  assert.ok(h.events.includes("detector:prepare"), "the detector loads during recording");
  assert.equal(h.detectorCalls.length, 0, "nothing is identified before stop");
  const pcm = ramp(160000);
  assert.deepEqual(await reservation.submit(pcm), { text: "transcript" });
  assert.equal(h.streamOptions.length, 0);
  assert.deepEqual(h.detectorCalls[0]!.allowed, ["en", "de"]);
  assert.equal(h.asrCalls[0]!.pcm, pcm, "ASR still receives the entire recording");
  assert.equal(h.asrCalls[0]!.options.language, "de");
  assert.ok(h.events.indexOf("detector:run") < h.events.indexOf("asr:run"));
});

test("a clip shorter than 500 ms skips detection and transcribes with the first preference", async (t) => {
  const h = harness(t);
  const { text, warning } = await h.service.transcribeFile(settings(), ramp(7999));
  assert.equal(text, "transcript");
  assert.ok(warning, "the unit-tested fallback warning reaches the result");
  assert.equal(h.detectorCalls.length, 0);
  assert.equal(h.asrCalls[0]!.options.language, "en");
});

for (const phase of ["prepare", "identify"] as const) {
  test(`detector ${phase} failure keeps ASR usable with the first preference and a warning`, async (t) => {
    const h = harness(t, {}, { async [phase]() { throw new Error("test detector failure"); } });
    const configured = settings({ preferredLanguages: ["zz", "de", "en"] });
    const { text, warning } = await h.service.transcribeFile(configured, new Float32Array(32000));
    assert.equal(text, "transcript");
    assert.ok(warning, "the unit-tested failure warning reaches the result");
    assert.equal(h.asrCalls[0]!.options.language, "de");
  });
}

for (const [name, configured, language] of [
  ["native Auto", settings({ model: { source: "catalog", id: "whisper-small", path: "/mock/whisper.gguf" }, preferredLanguages: ["ga", "yue"] }), undefined],
  ["explicit language", settings({ transcriptionLanguage: "de" }), "de"],
] as const) {
  test(`${name} bypasses external detection for both streaming dictation and files`, async (t) => {
    const h = harness(t, { async startStream() {
      return { async feed() {}, async finalize() { return "stream transcript"; }, reset() {} };
    } });
    const reservation = h.service.reserveDictation(configured);
    await reservation.ready;
    reservation.feed(new Float32Array(32000));
    assert.deepEqual(await reservation.submit(new Float32Array(32000)), { text: "stream transcript" });
    assert.equal(h.streamOptions[0]!.language, language);
    assert.deepEqual(await h.service.transcribeFile(configured, new Float32Array(32000)), { text: "transcript" });
    assert.equal(h.asrCalls[0]!.options.language, language);
    assert.equal(h.detectorLoads, 0);
  });
}

test("unsupported Auto is refused rather than transcribed without a language", async (t) => {
  const h = harness(t);
  const configured = settings({
    model: { source: "catalog", id: "Fun-ASR-MLT-Nano-2512", path: "/mock/fun.gguf" },
    preferredLanguages: ["yue", "en"],
  });
  await assert.rejects(h.service.transcribeFile(configured, new Float32Array(32000)), /does not support.*manually/);
  assert.equal(h.detectorLoads, 0);
  assert.equal(h.asrCalls.length, 0);
});

for (const mode of ["dictation", "file"] as const) {
  test(`aborting ${mode} during inference rejects without ASR`, async (t) => {
    const identified = new Deferred<LangIdResult>();
    const h = harness(t, {}, { async identify() { return identified.promise; } });
    t.after(() => identified.resolve(prediction()));
    const controller = new AbortController();
    const pcm = new Float32Array(32000);
    const result = mode === "file"
      ? h.service.transcribeFile(settings(), pcm, controller.signal)
      : h.service.reserveDictation(settings()).submit(pcm, controller.signal);
    const rejected = assert.rejects(result, /cancelled test job/);
    while (h.detectorCalls.length === 0) await nextTurn();
    controller.abort(new Error("cancelled test job"));
    assert.equal(h.detectorCalls[0]!.signal?.aborted, true);
    identified.resolve(prediction());
    await rejected;
    assert.equal(h.asrCalls.length, 0);
  });
}

test("shutdown during inference aborts the detector, rejects queued work and disposes the detector once", async (t) => {
  const identified = new Deferred<LangIdResult>();
  const h = harness(t, {}, { async identify() { return identified.promise; } });
  const active = assert.rejects(h.service.transcribeFile(settings(), new Float32Array(32000)), /shutting down/);
  while (h.detectorCalls.length === 0) await nextTurn();
  const queued = assert.rejects(h.service.transcribeFile(settings(), new Float32Array(32000)), /shutting down/);
  const shutdown = h.service.shutdown();
  assert.equal(h.detectorCalls[0]!.signal?.aborted, true);
  identified.resolve(prediction());
  await Promise.all([active, queued, shutdown]);
  assert.equal(h.asrCalls.length, 0);
  assert.equal(h.detectorDisposals, 1);
});

test("queued jobs share one detector and dispose it once when the queue becomes idle", async (t) => {
  const h = harness(t);
  const results = await Promise.all([
    h.service.transcribeFile(settings(), new Float32Array(32000)),
    h.service.transcribeFile(settings(), new Float32Array(48000)),
  ]);
  assert.deepEqual(results, [{ text: "transcript" }, { text: "transcript" }]);
  await nextTurn();
  assert.equal(h.detectorLoads, 1);
  assert.equal(h.detectorCalls.length, 2);
  assert.equal(h.detectorDisposals, 1);
  await h.service.shutdown();
  assert.equal(h.detectorDisposals, 1, "shutdown must not double-dispose the idle detector");
});

test("a missing detector falls back locally and never downloads during transcription", async (t) => {
  isolatedModelCache(t);
  const fetch = t.mock.method(globalThis, "fetch", async () => { throw new Error("unexpected model download"); });
  const paths: string[] = [];
  const service = new TranscriptionService((path) => {
    paths.push(path);
    return { async prepare() {}, async transcribe() { return "offline transcript"; }, async dispose() {} };
  });
  t.after(() => service.shutdown());
  const { text, warning } = await service.transcribeFile(settings(), new Float32Array(32000));
  assert.equal(text, "offline transcript");
  assert.deepEqual(paths, ["/mock/canary.gguf"]);
  assert.match(warning!, /language detector is missing.*voice-settings/);
  assert.equal(fetch.mock.callCount(), 0);
});
