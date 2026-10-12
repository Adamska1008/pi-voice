import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { getCatalogModel } from "../src/catalog.js";
import { LANGUAGE_DETECTION_MODEL } from "../src/language-detection-model.js";
import { createModelActivation, type ActivationProgress } from "../src/model-activation.js";
import { findCachedCatalogModel } from "../src/models.js";
import { readSettings, settingsForModel, type TranscribeSettings } from "../src/settings.js";
import { cacheCatalogModel, isolatedModelCache } from "./model-cache-helper.js";

const manual = getCatalogModel("canary-180m-flash")!;

function settingsDirectory(t: TestContext) {
  const previous = process.env.PI_CODING_AGENT_DIR;
  const directory = mkdtempSync(join(tmpdir(), "pi-voice-activation-test-"));
  process.env.PI_CODING_AGENT_DIR = directory;
  // settingsPath normally creates the directory; creating this root is enough.
  mkdirSync(directory, { recursive: true });
  t.after(() => {
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previous;
    rmSync(directory, { recursive: true, force: true });
  });
}

function pipeline(preferredLanguages = ["en", "de"]) {
  let committed: TranscribeSettings | undefined;
  const warnings: string[] = [];
  const activation = createModelActivation({
    buildSettings: (model, path) => settingsForModel(model.id, path, { preferredLanguages, transcriptionLanguage: "auto" }),
    onCommitted: (settings) => { committed = settings; },
    onWarning: (message) => warnings.push(message),
  });
  return { ...activation, warnings, committed: () => committed };
}

test("cached companion preserves Auto and requires no network or progress", async (t) => {
  settingsDirectory(t);
  const cache = isolatedModelCache(t);
  cacheCatalogModel(cache, manual);
  cacheCatalogModel(cache, LANGUAGE_DETECTION_MODEL);
  const h = pipeline();
  const result = await h.activate(manual, {
    cached: findCachedCatalogModel(manual), signal: new AbortController().signal,
    onProgress: () => assert.fail("cached activation must not download"),
  });
  assert.equal(result.warning, undefined);
  assert.equal(h.committed()!.transcriptionLanguage, "auto");
  assert.equal((await readSettings()).settings!.transcriptionLanguage, "auto");
});

test("companion failure keeps cached ASR, commits fixed language, and offers retry", async (t) => {
  settingsDirectory(t);
  const cache = isolatedModelCache(t);
  cacheCatalogModel(cache, manual);
  t.mock.method(globalThis, "fetch", async () => { throw new Error("offline"); });
  const h = pipeline(["de", "en"]);
  const progress: ActivationProgress[] = [];
  const result = await h.activate(manual, {
    cached: findCachedCatalogModel(manual), signal: new AbortController().signal,
    onProgress: (report) => progress.push(report),
  });
  assert.ok(findCachedCatalogModel(manual));
  assert.equal(h.committed()!.transcriptionLanguage, "de");
  assert.match(result.warning!, /offline.*cached.*retry the download, then enable Auto in settings/);
  assert.deepEqual(h.warnings, [result.warning]);
  assert.ok(progress.every((report) => report.total === LANGUAGE_DETECTION_MODEL.size));
  assert.ok(progress.some((report) => report.message?.includes("shared language detector")));
  assert.equal((await readSettings()).settings!.transcriptionLanguage, "de");

  // A successful download retry must preserve the explicit language saved
  // after failure. Restoring Auto is a separate settings action.
  cacheCatalogModel(cache, LANGUAGE_DETECTION_MODEL);
  const retry = createModelActivation({
    buildSettings: (model, path) => settingsForModel(model.id, path, h.committed()!),
    onCommitted: (settings) => assert.equal(settings.transcriptionLanguage, "de"),
  });
  const retried = await retry.activate(manual, {
    cached: findCachedCatalogModel(manual), signal: new AbortController().signal,
    onProgress: () => assert.fail("cached retry must not download"),
  });
  assert.equal(retried.warning, undefined);
  assert.equal((await readSettings()).settings!.transcriptionLanguage, "de");
});

test("cancelling companion download retains ASR but never commits settings", async (t) => {
  settingsDirectory(t);
  const cache = isolatedModelCache(t);
  cacheCatalogModel(cache, manual);
  const controller = new AbortController();
  t.mock.method(globalThis, "fetch", async () => {
    controller.abort();
    throw new Error("cancelled");
  });
  const h = pipeline();
  await assert.rejects(h.activate(manual, {
    cached: findCachedCatalogModel(manual), signal: controller.signal, onProgress() {},
  }), { name: "AbortError" });
  assert.ok(findCachedCatalogModel(manual));
  assert.equal(h.committed(), undefined);
  assert.equal((await readSettings()).settings, undefined);
  assert.deepEqual(h.warnings, []);
});

test("one bundled activation reports combined bytes and retains newly downloaded ASR on companion failure", async (t) => {
  settingsDirectory(t);
  isolatedModelCache(t);
  const data = Buffer.alloc(1024, 42);
  const model = { ...manual, size: data.length, sha256: createHash("sha256").update(data).digest("hex") };
  const requests: string[] = [];
  t.mock.method(globalThis, "fetch", async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    const url = String(input);
    requests.push(url);
    if (url.includes(LANGUAGE_DETECTION_MODEL.repository)) throw new Error("detector offline");
    const range = new Headers(init?.headers).get("range");
    return new Response(new Uint8Array(range === "bytes=0-0" ? data.subarray(0, 1) : data), {
      status: range === "bytes=0-0" ? 206 : 200,
      headers: {
        etag: `"${model.sha256}"`,
        ...(range === "bytes=0-0" ? { "content-range": `bytes 0-0/${model.size}` } : {}),
      },
    });
  });
  const h = pipeline();
  const progress: ActivationProgress[] = [];
  const result = await h.activate(model, {
    cached: undefined, signal: new AbortController().signal,
    onProgress: (report) => progress.push(report),
  });
  assert.ok(findCachedCatalogModel(model));
  assert.equal(h.committed()!.transcriptionLanguage, "en");
  assert.match(result.warning!, /detector offline/);
  assert.ok(progress.every((report) => report.total === model.size + LANGUAGE_DETECTION_MODEL.size));
  assert.ok(progress.some((report) => report.downloaded === model.size && report.message?.includes("shared language detector")));
  assert.equal(requests.length, 3, "ASR metadata, ASR payload, then companion metadata");
});
