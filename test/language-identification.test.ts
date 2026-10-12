import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { LangIdResult } from "transcribe-cpp";
import { getCatalogModel } from "../src/catalog.js";
import { closeLog, initLog } from "../src/log.js";
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

test("detection logs the pick, every allowed p, length, and allowed mass", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-voice-lang-"));
  const path = join(dir, "pi-voice.log");
  initLog({ path, level: "info" });
  try {
    const decision = await detectLanguage(policy, new Float32Array(32000), harness().identify);
    assert.equal(decision.language, "de");
    const line = readFileSync(path, "utf8").split("\n").find((entry) => entry.includes("language detection"))!;
    assert.match(line, /info .*language detection: de \(de 90\.0%, en 10\.0%; 2\.0 s, allowed mass 90\.0%\)$/);
  } finally {
    closeLog();
    rmSync(dir, { recursive: true, force: true });
  }
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
  assert.equal(decision.warning, "Too short to tell the language. Used German.");
});

test("a confident one-second pick has no warning", async () => {
  assert.deepEqual(await detectLanguage(policy, new Float32Array(16000), harness().identify), { language: "de" });
});

test("a detector label maps back to the catalog ASR language through aliases", async () => {
  const fun = autoLanguagePolicy(getCatalogModel("Fun-ASR-MLT-Nano-2512")!, ["en", "fil"]) as DetectPolicy;
  assert.deepEqual(fun.allowed, ["en", "tl"]);
  const h = harness(async () => prediction("tl"));
  assert.deepEqual(await detectLanguage(fun, new Float32Array(32000), h.identify), { language: fun.languages[1] });
});

test("the top pick always wins, regardless of p or unrestricted mass", async () => {
  // Observed on real mic audio: correct zh picks at p ~99% with 0.1% mass.
  for (const [code, p] of [["de", 0.99], ["de", 0.61], ["en", 0.87]] as const) {
    const decision = await detectLanguage(policy, new Float32Array(32000),
      harness(async () => prediction(code, p, 0.001, 1 - p)).identify);
    assert.deepEqual(decision, { language: code });
  }
});

test("warn only when the pick is under 1.5x the runner-up, and still use it", async () => {
  const unsure = await detectLanguage(policy, new Float32Array(32000),
    harness(async () => prediction("de", 0.55, 0.5, 0.45)).identify);
  assert.deepEqual(unsure, {
    language: "de",
    warning: "Not sure which language this was. Guessed German (55% sure).",
  });
  // Three languages: 0.4 vs 0.3 is a 1.33x lead, so it warns despite p < 0.6
  // being normal with more candidates; 0.5 vs 0.3 is 1.67x, so it does not.
  const three = autoLanguagePolicy(canary, ["en", "de", "fr"]) as DetectPolicy;
  const ranked = (top: number, next: number): LangIdResult => ({
    code: "fr", allowedMass: 0.5,
    candidates: [
      { index: 0, code: "fr", name: "fr", p: top, logit: 0 },
      { index: 1, code: "de", name: "de", p: next, logit: 0 },
      { index: 2, code: "en", name: "en", p: 1 - top - next, logit: 0 },
    ],
  });
  const close = await detectLanguage(three, new Float32Array(32000), harness(async () => ranked(0.4, 0.3)).identify);
  assert.equal(close.language, "fr");
  assert.match(close.warning!, /Guessed French \(40% sure\)/);
  assert.deepEqual(
    await detectLanguage(three, new Float32Array(32000), harness(async () => ranked(0.5, 0.3)).identify),
    { language: "fr" },
  );
});

const unreliable: [string, LangIdResult][] = [
  ["nonfinite probability", prediction("de", Number.NaN)],
  ["out-of-set winner", prediction("fr")],
  ["missing winner", { code: null, allowedMass: 0.9, candidates: [] }],
];
for (const [reason, result] of unreliable) {
  test(`${reason} falls back to the first compatible preference`, async () => {
    const decision = await detectLanguage(policy, new Float32Array(32000), harness(async () => result).identify);
    assert.deepEqual(decision, { language: "en", warning: "Couldn't tell the language. Used English." });
  });
}

test("detector failure uses the first preference and keeps the reason", async () => {
  const decision = await detectLanguage(policy, new Float32Array(32000), harness(async () => {
    throw new Error("The language detector is missing.");
  }).identify);
  assert.deepEqual(decision, {
    language: "en",
    warning: "Couldn't tell the language. Used English. The language detector is missing.",
  });
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
