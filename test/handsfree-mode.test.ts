import assert from "node:assert/strict";
import test from "node:test";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { CaptureSinks } from "../src/dictation-controller.js";
import { createHandsFreeMode } from "../src/handsfree-mode.js";
const flush = () => new Promise(resolve => setImmediate(resolve));
function fixture() {
  let editor = "", opens = 0, stopped = 0, wakeClosed = 0, disposed = 0;
  let collect: boolean | undefined;
  let sinks!: CaptureSinks;
  let confirm = async () => true;
  let wakeOpen = async () => ({ feed: async () => false, reset: async () => {}, close: async () => { wakeClosed++; } });
  const notices: string[] = [], sent: string[] = [];
  const ctx = { mode: "tui", hasUI: true, isIdle: () => true, cwd: "unused", ui: {
    getEditorText: () => editor, setEditorText: (text: string) => { editor = text; },
    setStatus: () => {}, notify: (text: string) => notices.push(text), confirm: () => confirm(),
  } } as unknown as ExtensionContext;
  const mode = createHandsFreeMode({ sendUserMessage: (text: string) => sent.push(text) } as unknown as ExtensionAPI, {
    settings: async () => ({ microphone: { type: "default" } } as any),
    service: {} as any,
    vad: { openScorer: async () => ({ score: async () => 0, dispose: () => { disposed++; } }) } as any,
    automaticVocabulary: () => [], blocked: () => false,
    openWake: () => wakeOpen(),
    openMicrophone: async (_mic, callbacks, keep) => {
      opens++; sinks = callbacks; collect = keep;
      return { stop: async () => { stopped++; return { pcm: new Float32Array() }; } };
    },
  });
  return { mode, ctx, notices, sent, counts: () => ({ opens, stopped, wakeClosed, disposed, collect }),
    consent: (fn: typeof confirm) => { confirm = fn; },
    wake: (fn: typeof wakeOpen) => { wakeOpen = fn; },
    edit: (text: string) => { editor = text; },
    failCapture: () => sinks.onFailure(new Error("device lost")),
  };
}
test("explicit consent is required; continuous recorder never collects full audio", async () => {
  const f = fixture();
  f.consent(async () => false);
  await f.mode.command("on", f.ctx); assert.equal(f.mode.enabled, false); assert.equal(f.counts().opens, 0);
  f.consent(async () => true);
  await f.mode.command("on", f.ctx); assert.equal(f.mode.enabled, true); assert.equal(f.counts().collect, false);
  await f.mode.command("on", f.ctx); assert.equal(f.counts().opens, 1);
  await f.mode.command("off", f.ctx); await f.mode.stop();
  assert.deepEqual(f.counts(), { opens: 1, stopped: 1, wakeClosed: 1, disposed: 1, collect: false });
  assert.deepEqual(f.sent, []);
});
test("stopping during pending consent returns promptly and late approval cannot open a mic", async () => {
  const f = fixture(); let approve!: (value: boolean) => void;
  f.consent(() => new Promise(resolve => { approve = resolve; }));
  const startup = f.mode.command("on", f.ctx); await flush();
  await f.mode.stop(); await startup;
  approve(true); await flush(); assert.equal(f.counts().opens, 0); assert.equal(f.mode.enabled, false);
});
test("model failures and capture failures clean up; edited drafts are preserved", async () => {
  const f = fixture(); f.wake(async () => { throw new Error("bad model"); });
  await f.mode.command("on", f.ctx); assert.equal(f.mode.enabled, false); assert.equal(f.counts().opens, 0);
  const g = fixture(); await g.mode.command("on", g.ctx); g.failCapture(); await flush(); await g.mode.stop();
  assert.equal(g.counts().stopped, 1); assert.equal(g.counts().disposed, 1); assert.equal(g.mode.enabled, false);
  const h = fixture(); h.edit("Do not overwrite"); await h.mode.command("on", h.ctx);
  assert.equal(h.counts().opens, 0); assert.equal(h.ctx.ui.getEditorText(), "Do not overwrite");
});
test("noninteractive and busy modes never acquire the microphone", async () => {
  const f = fixture();
  await f.mode.command("on", { ...f.ctx, hasUI: false });
  await f.mode.command("on", { ...f.ctx, isIdle: () => false });
  assert.equal(f.counts().opens, 0);
});
