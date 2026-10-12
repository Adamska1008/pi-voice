import assert from "node:assert/strict";
import test from "node:test";
import type { LangIdResult } from "transcribe-cpp";
import { getCatalogModel } from "../src/catalog.js";
import {
  autoLanguagePolicy,
  detectLanguage,
  settingsLanguagePolicy,
  type DetectPolicy,
} from "../src/language-detection-policy.js";
import { settingsForModel, type TranscribeSettings } from "../src/settings.js";
import { prediction, ramp } from "./helpers.js";

const canary = getCatalogModel("canary-180m-flash")!;
const policy = autoLanguagePolicy(canary, ["en", "de"]) as DetectPolicy;

function harness(result: () => Promise<LangIdResult> = async () => prediction()) {
  const calls: { pcm: Float32Array; allowed: readonly string[] }[] = [];
  const identify = async (pcm: Float32Array, allowed: readonly string[]) => {
    calls.push({ pcm, allowed });
    return result();
  };
  return { calls, identify };
}

test("detection scores the first seven seconds of the clip, restricted to preferred languages", async () => {
  const h = harness();
  const pcm = ramp(160000);
  assert.deepEqual(await detectLanguage(policy, pcm, h.identify), { language: "de" });
  assert.equal(h.calls.length, 1);
  assert.deepEqual(h.calls[0]!.pcm, pcm.slice(0, 112000));
  assert.deepEqual(h.calls[0]!.allowed, ["en", "de"]);
  assert.deepEqual(pcm, ramp(160000), "identification must not mutate the ASR clip");
});

test("clips under seven seconds are scored whole, without padding", async () => {
  const h = harness();
  const pcm = ramp(48000);
  assert.deepEqual(await detectLanguage(policy, pcm, h.identify), { language: "de" });
  assert.deepEqual(h.calls[0]!.pcm, pcm);
});

test("clips shorter than 500 ms skip inference and use the first compatible preference", async () => {
  const h = harness();
  const reordered = autoLanguagePolicy(canary, ["zz", "de", "en"]) as DetectPolicy;
  const decision = await detectLanguage(reordered, new Float32Array(7999), h.identify);
  assert.equal(h.calls.length, 0);
  assert.equal(decision.language, "de");
  assert.match(decision.warning!, /shorter than 500 ms/);
  assert.match(decision.warning!, /first compatible preferred language/);
});

test("a 500 ms clip consolidates reliability and fallback warnings", async () => {
  const h = harness(async () => prediction("de", 0.55));
  const decision = await detectLanguage(policy, ramp(8000), h.identify);
  assert.equal(decision.language, "en");
  assert.match(decision.warning!, /1 second or less/);
  assert.match(decision.warning!, /confidence was low/);
  assert.match(decision.warning!, /Used English \(en\)/);
});

test("a confident one-second winner retains only the short-audio reliability warning", async () => {
  const decision = await detectLanguage(policy, new Float32Array(16000), harness().identify);
  assert.equal(decision.language, "de");
  assert.match(decision.warning!, /1 second or less/);
  assert.doesNotMatch(decision.warning!, /Used |confidence was low/);
});

test("a detector label maps back to the catalog ASR language through aliases", async () => {
  const fun = autoLanguagePolicy(getCatalogModel("Fun-ASR-MLT-Nano-2512")!, ["en", "fil"]) as DetectPolicy;
  assert.deepEqual(fun.allowed, ["en", "tl"]);
  const h = harness(async () => prediction("tl"));
  assert.deepEqual(await detectLanguage(fun, new Float32Array(32000), h.identify), { language: fun.languages[1] });
});

const unreliable: [string, LangIdResult][] = [
  ["low allowed-set probability", prediction("de", 0.59)],
  ["low unrestricted allowed mass", prediction("de", 0.95, 0.49)],
  ["small winner margin", prediction("de", 0.65, 0.9, 0.51)],
  ["nonfinite probability", prediction("de", Number.NaN)],
  ["nonfinite allowed mass", prediction("de", 0.9, Number.NaN)],
  ["out-of-set winner", prediction("fr")],
  ["missing winner", { code: null, allowedMass: 0.9, candidates: [] }],
];
for (const [reason, result] of unreliable) {
  test(`${reason} falls back to the first compatible preference, never the detector guess`, async () => {
    const decision = await detectLanguage(policy, new Float32Array(32000), harness(async () => result).identify);
    assert.equal(decision.language, "en");
    assert.match(decision.warning!, /confidence was low/);
    assert.match(decision.warning!, /first compatible preferred language/);
  });
}

test("detector failure uses the first preference and says why", async () => {
  const decision = await detectLanguage(policy, new Float32Array(32000), harness(async () => {
    throw new Error("The language detector is missing.");
  }).identify);
  assert.equal(decision.language, "en");
  assert.match(decision.warning!, /detection failed: The language detector is missing/);
  assert.match(decision.warning!, /first compatible preferred language/);
});

function settings(overrides: Partial<TranscribeSettings>): TranscribeSettings {
  return {
    ...settingsForModel("canary-180m-flash", "/mock/canary.gguf", { preferredLanguages: ["en", "de"] }),
    ...overrides,
  };
}

test("a take's policy: explicit languages are fixed, Auto follows the model and preferences", () => {
  assert.equal(settings({}).transcriptionLanguage, "auto");
  assert.deepEqual(settingsLanguagePolicy(settings({})), policy);
  assert.deepEqual(settingsLanguagePolicy(settings({ transcriptionLanguage: "de" })), { kind: "fixed", language: "de" });
  assert.deepEqual(settingsLanguagePolicy(settings({ preferredLanguages: ["zz", "de"] })), { kind: "fixed", language: "de" });
  assert.deepEqual(settingsLanguagePolicy(settings({
    model: { source: "catalog", id: "whisper-small", path: "/mock/whisper.gguf" },
  })), { kind: "native" });
  assert.equal(settingsLanguagePolicy(settings({
    model: { source: "catalog", id: "Fun-ASR-MLT-Nano-2512", path: "/mock/fun.gguf" },
    preferredLanguages: ["yue", "en"],
  })).kind, "unsupported");
});
