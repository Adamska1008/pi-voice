import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { initTheme, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { Component } from "@earendil-works/pi-tui";
import { Deferred } from "../src/deferred.js";
import { readSettings, settingsForModel, writeSettings } from "../src/settings.js";
import { showSettingsMenu } from "../src/settings-menu.js";
import { isolatedModelCache } from "./model-cache-helper.js";
import { keybindings, testTheme, testTui } from "./ui-helpers.js";

initTheme("dark");

type Step = (pane: Component, done: (value: unknown) => void) => void;
function context(steps: Step[], confirm: (message: string) => boolean = () => true, beforePane: (index: number) => void = () => {}) {
  let index = 0;
  const notifications: string[] = [];
  const ctx = {
    mode: "tui",
    ui: {
      custom: async (factory: Parameters<ExtensionContext["ui"]["custom"]>[0]) => {
        const result = new Deferred<unknown>();
        beforePane(index);
        const pane = await factory(testTui(40), testTheme(), keybindings() as Parameters<typeof factory>[2], (value) => result.resolve(value));
        try {
          const step = steps[index++];
          assert.ok(step, `Unexpected pane: ${pane.constructor.name}`);
          step(pane, (value) => result.resolve(value));
          return await result.promise;
        } finally { pane.dispose?.(); }
      },
      confirm: (_title: string, message: string) => confirm(message),
      notify: (message: string) => notifications.push(message),
    },
  } as unknown as ExtensionContext;
  return { ctx, notifications, finished: () => assert.equal(index, steps.length) };
}
function isolate(t: TestContext) {
  const previous = process.env.PI_CODING_AGENT_DIR;
  const directory = mkdtempSync(join(tmpdir(), "pi-voice-menu-test-"));
  process.env.PI_CODING_AGENT_DIR = directory;
  t.after(() => {
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previous;
    rmSync(directory, { recursive: true, force: true });
  });
  return isolatedModelCache(t);
}
const pi = {} as ExtensionAPI;

test("enabling Auto with a missing detector saves it without downloading and flags the row", async (t) => {
  isolate(t);
  const configured = settingsForModel("canary-180m-flash", "/tmp/asr", {
    preferredLanguages: ["en", "de"], transcriptionLanguage: "en",
  });
  await writeSettings(configured);
  const fetch = t.mock.method(globalThis, "fetch", async () => { throw new Error("offline"); });
  const h = context([
    (_pane, done) => done("transcription-language"),
    (pane, done) => {
      pane.handleInput?.("\x1b[A"); // Move from English to Auto.
      done("auto");
    },
    (pane, done) => {
      pane.handleInput?.("\x1b[B");
      pane.handleInput?.("\x1b[B");
      assert.match(pane.render(100).join("\n"), /language detector, which is missing/);
      done(undefined);
    },
  ]);
  await showSettingsMenu(pi, h.ctx, configured, configured.shortcut);
  h.finished();
  assert.equal(configured.transcriptionLanguage, "auto");
  assert.equal((await readSettings()).settings!.transcriptionLanguage, "auto");
  assert.equal(fetch.mock.callCount(), 0);
});

test("preferred-language edits warn and save explicit manual mode for unsupported Auto", async (t) => {
  isolate(t);
  const configured = settingsForModel("Fun-ASR-MLT-Nano-2512", "/tmp/fun", {
    preferredLanguages: ["en", "ja"], transcriptionLanguage: "auto",
  });
  await writeSettings(configured);
  const h = context([
    (_pane, done) => done("preferred-languages"),
    (_pane, done) => done({ languages: ["en", "ga", "yue"], confirmed: true }),
    (pane, done) => {
      pane.handleInput?.("\x1b[B");
      pane.handleInput?.("\x1b[B");
      const text = pane.render(100).join("\n");
      assert.match(text, /Auto unavailable/);
      assert.match(text, /Irish/);
      assert.match(text, /Cantonese/);
      done(undefined);
    },
  ], () => { assert.fail("unsupported Auto must not download"); });
  await showSettingsMenu(pi, h.ctx, configured, configured.shortcut);
  h.finished();
  assert.deepEqual(configured.preferredLanguages, ["en", "ga", "yue"]);
  assert.equal(configured.transcriptionLanguage, "en");
  assert.match(h.notifications.join("\n"), /Irish, Cantonese.*now English/);
  assert.deepEqual((await readSettings()).settings, configured);
});
