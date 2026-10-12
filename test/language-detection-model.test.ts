import assert from "node:assert/strict";
import { mkdirSync, truncateSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { getRepoFolderName } from "@huggingface/hub";
import { CATALOG_MODELS, getCatalogModel } from "../src/catalog.js";
import {
  LANGUAGE_DETECTION_MODEL,
  findCachedLanguageDetector,
  languageDetectorDownloadNote,
  modelDownloadAction,
  needsLanguageDetectorDownload,
  remainingModelDownloadBytes,
} from "../src/language-detection-model.js";
import { cacheCatalogModel, isolatedModelCache } from "./model-cache-helper.js";

const manual = getCatalogModel("canary-180m-flash")!;
const native = CATALOG_MODELS.find((model) => model.capabilities.languageDetection)!;

test("detector is a pinned companion, not an ASR catalog entry", () => {
  assert.equal(CATALOG_MODELS.some((model) => model.id === LANGUAGE_DETECTION_MODEL.id), false);
  assert.match(LANGUAGE_DETECTION_MODEL.revision, /^[a-f0-9]{40}$/);
  assert.match(LANGUAGE_DETECTION_MODEL.sha256, /^[a-f0-9]{64}$/);
  assert.equal(LANGUAGE_DETECTION_MODEL.size, 26693632);
  assert.equal(LANGUAGE_DETECTION_MODEL.quant, "Q8_0");
  assert.equal(LANGUAGE_DETECTION_MODEL.languages.length, 107);
  assert.ok(!LANGUAGE_DETECTION_MODEL.languages.includes("ga"));
  assert.ok(!LANGUAGE_DETECTION_MODEL.languages.includes("yue"));
});

test("bundle disclosure and combined remaining bytes vanish once companion is cached", (t) => {
  const cache = isolatedModelCache(t);
  assert.equal(needsLanguageDetectorDownload(manual), true);
  assert.equal(needsLanguageDetectorDownload(native), false);
  assert.match(languageDetectorDownloadNote(manual)!, /shared VoxLingua107/);
  assert.equal(languageDetectorDownloadNote(native), undefined);
  assert.equal(remainingModelDownloadBytes(manual), manual.size + LANGUAGE_DETECTION_MODEL.size);
  cacheCatalogModel(cache, manual);
  assert.equal(remainingModelDownloadBytes(manual), LANGUAGE_DETECTION_MODEL.size);
  assert.match(modelDownloadAction(manual, true), /^download /);
  cacheCatalogModel(cache, LANGUAGE_DETECTION_MODEL);
  assert.ok(findCachedLanguageDetector());
  assert.equal(needsLanguageDetectorDownload(manual), false);
  assert.equal(languageDetectorDownloadNote(manual), undefined);
  assert.equal(remainingModelDownloadBytes(manual), 0);
  assert.equal(modelDownloadAction(manual, true), "choose");
});

test("combined remaining size subtracts resumable prefixes of both files", (t) => {
  isolatedModelCache(t);
  const partial = (model: typeof manual, bytes: number) => {
    const blobs = join(process.env.HF_HUB_CACHE!, getRepoFolderName({ name: model.repository, type: "model" }), "blobs");
    mkdirSync(blobs, { recursive: true });
    const path = join(blobs, `${model.sha256}.incomplete`);
    writeFileSync(path, "x");
    truncateSync(path, bytes);
  };
  partial(manual, 10000);
  partial(LANGUAGE_DETECTION_MODEL, 20000);
  assert.equal(remainingModelDownloadBytes(manual, false), manual.size + LANGUAGE_DETECTION_MODEL.size - 30000);
  assert.match(modelDownloadAction(manual, false), /^resume /);
});
