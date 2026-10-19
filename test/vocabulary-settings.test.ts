import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { DEFAULT_VOCABULARY_SETTINGS, parseVocabularySettings } from "../src/vocabulary-settings.js";
import { readSettings, settingsForModel, settingsWithPreferredLanguages, writeSettings } from "../src/settings.js";

const custom = { cacheCapacity: 256, recordingLimit: 96, extractionLimit: 48 };

test("vocabulary defaults are independent and partial overrides preserve other defaults", () => {
  const first = parseVocabularySettings(undefined);
  assert.deepEqual(first.settings, DEFAULT_VOCABULARY_SETTINGS);
  assert.equal(first.warning, undefined);
  first.settings.cacheCapacity = 1;
  assert.equal(parseVocabularySettings({}).settings.cacheCapacity, 128);
  assert.deepEqual(parseVocabularySettings({ recordingLimit: 32 }).settings,
    { ...DEFAULT_VOCABULARY_SETTINGS, recordingLimit: 32 });
  assert.deepEqual(parseVocabularySettings(custom).settings, custom);
  assert.equal(parseVocabularySettings({ cacheCapacity: 1024, recordingLimit: 128, extractionLimit: 128 }).warning, undefined);
});

test("invalid vocabulary groups fall back with a warning, including typos and inconsistent limits", () => {
  for (const value of [null, [], "64", { cacheCapacity: 0 }, { cacheCapacity: 1025 },
    { recordingLimit: 129 }, { extractionLimit: -1 }, { recordingLimit: 1.5 },
    { extractionLimit: "64" }, { recordingLimit: NaN }, { extractionLimit: Infinity },
    { cacheCapacity: 32 }, { recordinglimit: 32 }, { toString: 1 }]) {
    const result = parseVocabularySettings(value);
    assert.deepEqual(result.settings, DEFAULT_VOCABULARY_SETTINGS);
    assert.match(result.warning!, /Invalid vocabulary settings/);
  }
});

test("settings round trips retain vocabulary and old/invalid files keep usable audio settings", async t => {
  const previous = process.env.PI_CODING_AGENT_DIR;
  const directory = await mkdtemp(join(tmpdir(), "pi-voice-vocabulary-settings-"));
  process.env.PI_CODING_AGENT_DIR = directory;
  t.after(async () => {
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previous;
    await rm(directory, { recursive: true, force: true });
  });
  const current = settingsForModel("parakeet-unified-en-0.6b", "/tmp/model", { vocabulary: custom });
  await writeSettings(current);
  assert.deepEqual((await readSettings()).settings, current);
  assert.deepEqual(settingsWithPreferredLanguages(current, ["en", "zh"]).vocabulary, custom);
  const path = join(directory, "pi-voice.json");
  const old = JSON.parse(await readFile(path, "utf8"));
  delete old.vocabulary;
  await writeFile(path, JSON.stringify(old));
  assert.deepEqual((await readSettings()).settings?.vocabulary, DEFAULT_VOCABULARY_SETTINGS);
  old.vocabulary = { cacheCapacity: "invalid" };
  const original = JSON.stringify(old);
  await writeFile(path, original);
  const result = await readSettings();
  assert.equal(result.settings?.model.id, current.model.id);
  assert.deepEqual(result.settings?.vocabulary, DEFAULT_VOCABULARY_SETTINGS);
  assert.match(result.warning!, /Invalid vocabulary settings/);
  assert.equal(await readFile(path, "utf8"), original); // Reading never repairs the user's file silently.
});
