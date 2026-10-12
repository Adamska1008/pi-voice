import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { createPiVoiceRuntime } from "../src/runtime.js";
import { settingsForModel, writeSettings, type TranscribeSettings } from "../src/settings.js";

/** Isolated settings dir with saved settings; the runtime shuts down with the test. */
async function runtimeWithSavedSettings(
  t: TestContext,
  preferredLanguages: string[],
  saved: Partial<TranscribeSettings>,
) {
  const directory = await mkdtemp(join(tmpdir(), "pi-voice-runtime-language-"));
  const previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = directory;
  t.after(async () => {
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previous;
    await rm(directory, { recursive: true, force: true });
  });
  const modelPath = join(directory, "asr.gguf");
  await writeFile(modelPath, "mock");
  const configured = settingsForModel("Fun-ASR-MLT-Nano-2512", modelPath, { preferredLanguages });
  const written = { ...configured, ...saved };
  await writeSettings(written);
  const runtime = createPiVoiceRuntime({} as ExtensionAPI, configured.shortcut);
  t.after(() => runtime.shutdown({ hasUI: false } as ExtensionContext));
  return { runtime, written };
}

test("unsupported saved Auto loads as the first compatible preference", async (t) => {
  const { runtime } = await runtimeWithSavedSettings(t, ["en", "ga"], { transcriptionLanguage: "auto" });
  assert.equal((await runtime.requireConfiguredSettingsForTool()).transcriptionLanguage, "en");
});

test("headless tool preserves explicit selection even with an unsupported preferred detector language", async (t) => {
  const { runtime, written } = await runtimeWithSavedSettings(t, ["en", "yue"], { transcriptionLanguage: "yue" });
  assert.deepEqual(await runtime.requireConfiguredSettingsForTool(), written);
});
