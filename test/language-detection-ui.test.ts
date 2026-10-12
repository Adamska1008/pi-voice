import assert from "node:assert/strict";
import { test } from "node:test";
import { initTheme } from "@earendil-works/pi-coding-agent";
import { getCatalogModel, type CatalogModel } from "../src/catalog.js";
import { Deferred } from "../src/deferred.js";
import { LANGUAGE_DETECTION_MODEL } from "../src/language-detection-model.js";
import { CatalogModelPicker, createTranscriptionLanguagePicker } from "../src/model-picker.js";
import { RecommendedModelPicker } from "../src/recommendation-picker.js";
import { ModelSelectionController } from "../src/model-selection-controller.js";
import type { ActivationResult } from "../src/model-activation.js";
import { cacheCatalogModel, isolatedModelCache } from "./model-cache-helper.js";
import { keybindings, testTheme, testTui } from "./ui-helpers.js";
import { nextTurn } from "./helpers.js";

initTheme("dark");
const manual = getCatalogModel("canary-180m-flash")!;
const pending = () => new Promise<ActivationResult>(() => {});

function transcriptionPicker(model: CatalogModel, preferred: string[]) {
  return createTranscriptionLanguagePicker(testTui(40), testTheme(), keybindings(), model, "auto", preferred, () => {});
}

test("manual multilingual offers Auto for fixed and detector policies, but not unsupported combinations", (t) => {
  isolatedModelCache(t);
  let text = transcriptionPicker(manual, ["en", "de"]).render(100).join("\n");
  assert.match(text, /Detects among your preferred languages/);
  text = transcriptionPicker(manual, ["de"]).render(100).join("\n");
  assert.match(text, /Auto detect/);
  assert.match(text, /Uses German/);
  assert.doesNotMatch(text, /shared VoxLingua107/);
  for (const code of ["ga", "yue"]) {
    text = transcriptionPicker({ ...manual, languages: ["en", code] }, ["en", code]).render(100).join("\n");
    assert.match(text, /Auto unavailable/);
    assert.doesNotMatch(text, /Auto detect/);
    assert.match(text, code === "ga" ? /Irish/ : /Cantonese/);
  }
  text = transcriptionPicker({ ...manual, languages: ["en"] }, ["en"]).render(100).join("\n");
  assert.doesNotMatch(text, /Auto detect/);
});

test("detector models list auto language detection among their features", (t) => {
  isolatedModelCache(t);
  const pane = new CatalogModelPicker(testTui(40), testTheme(), keybindings(), ["en", "de"], manual.id, () => {}, pending);
  assert.match(pane.render(120).join("\n"), /auto language detection/);
  pane.dispose();
});

test("both model pickers disclose companion before download even for cached ASR", (t) => {
  const cache = isolatedModelCache(t);
  cacheCatalogModel(cache, manual);
  const makeFull = () => new CatalogModelPicker(testTui(40), testTheme(), keybindings(), ["en", "de"], manual.id, () => {}, pending);
  const makeRecommended = () => new RecommendedModelPicker(testTui(40), testTheme(), keybindings(), ["en", "de"], [{ model: manual, roles: ["best"], status: "eligible" }], pending, () => {});
  for (const factory of [makeFull, makeRecommended]) {
    const pane = factory();
    const text = pane.render(120).join("\n");
    assert.match(text, /shared VoxLingua107/);
    assert.match(text, /download 25 MiB/);
    pane.dispose();
  }
  cacheCatalogModel(cache, LANGUAGE_DETECTION_MODEL);
  for (const factory of [makeFull, makeRecommended]) {
    const pane = factory();
    assert.doesNotMatch(pane.render(120).join("\n"), /shared VoxLingua107|download 25 MiB/);
    pane.dispose();
  }
});

test("cached current ASR with missing companion takes a cancellable retry path", async (t) => {
  const cache = isolatedModelCache(t);
  cacheCatalogModel(cache, manual);
  const calls: { signal: AbortSignal; result: Deferred<ActivationResult> }[] = [];
  const controller = new ModelSelectionController((_model, options) => {
    const result = new Deferred<ActivationResult>();
    calls.push({ signal: options.signal, result });
    options.onProgress({ downloaded: 0, total: LANGUAGE_DETECTION_MODEL.size, message: "Downloading shared language detector…" });
    return result.promise;
  }, {
    models: [manual], currentModelId: manual.id, advance: false, completion: "complete",
    onChange() {}, onExit() { assert.fail("should stay in picker"); },
  });
  controller.select(manual);
  assert.equal(calls.length, 1);
  assert.match(controller.download!.message, /shared language detector/);
  controller.cancelDownload();
  assert.equal(calls[0]!.signal.aborted, true);
  calls[0]!.result.reject(new Error("cancelled"));
  await nextTurn();
  assert.ok(controller.cachedById.has(manual.id));
  assert.match(controller.feedback!.text, /Download stopped/);
  controller.select(manual);
  assert.equal(calls.length, 2);
  calls[1]!.result.resolve({ path: "/tmp/asr", warning: "Detector failed; choose manual or retry" });
  await nextTurn();
  assert.match(controller.feedback!.text, /manual or retry/);
  controller.dispose();
});

test("both model pickers explain unsupported Auto combinations", (t) => {
  const cache = isolatedModelCache(t);
  cacheCatalogModel(cache, LANGUAGE_DETECTION_MODEL);
  const model = getCatalogModel("Fun-ASR-MLT-Nano-2512")!;
  const languages = ["en", "yue"];
  const panes = [
    new CatalogModelPicker(testTui(40), testTheme(), keybindings(), languages, model.id, () => {}, pending),
    new RecommendedModelPicker(testTui(40), testTheme(), keybindings(), languages, [{ model, roles: ["best"], status: "eligible" }], pending, () => {}),
  ];
  for (const pane of panes) {
    const text = pane.render(120).join("\n");
    assert.match(text, /Auto unavailable/);
    assert.match(text, /Cantonese/); // copy comes from the unit-tested policy reason
    pane.dispose();
  }
});
