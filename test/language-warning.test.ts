import assert from "node:assert/strict";
import test from "node:test";
import { DictationController } from "../src/dictation-controller.js";
import { settingsForModel } from "../src/settings.js";
import { fakeDictationService, FakeMicrophone } from "./dictation-helper.js";
import { nextTurn } from "./helpers.js";

const settings = settingsForModel("canary-180m-flash", "/tmp/asr", { preferredLanguages: ["en", "de"], transcriptionLanguage: "auto" });

test("language warnings are metadata, not pasted into the transcript", async () => {
  const mic = new FakeMicrophone();
  const service = fakeDictationService();
  const controller = new DictationController(service, { openCapture: mic.open });
  await controller.start(settings);
  service.reservations[0]!.prepared.resolve();
  const stop = controller.stop();
  await nextTurn();
  service.reservations[0]!.result.resolve({ text: "hello", warning: "Low confidence; used English." });
  const result = await stop;
  assert.equal(result?.text, "hello");
  assert.equal(result?.warning, "Low confidence; used English.");
  await controller.dispose();
});
