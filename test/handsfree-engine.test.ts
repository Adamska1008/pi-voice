import assert from "node:assert/strict";
import test from "node:test";
import { HandsFreeEngine } from "../src/handsfree-engine.js";
const flush = () => new Promise(resolve => setImmediate(resolve));
function fixture() {
  let editor = "", blocked = false, now = 0, detected = false;
  let transcribe: (signal: AbortSignal) => Promise<string> = async () => "草稿";
  const sent: string[] = [], failures: unknown[] = [], modes: boolean[] = [];
  let closed = 0, disposed = 0, cues = 0;
  const engine = new HandsFreeEngine({
    wake: { feed: async () => { const value = detected; detected = false; return value; }, reset: async () => {}, close: async () => { closed++; } },
    scorer: { score: async frame => frame[0]!, dispose: () => { disposed++; } },
    transcribe: (_pcm, command, signal) => { modes.push(command); return transcribe(signal); },
    readEditor: () => editor, writeEditor: text => { editor = text; }, send: text => { sent.push(text); },
    blocked: () => blocked, status: () => {}, cue: () => { cues++; }, failure: error => failures.push(error), now: () => now,
  });
  const frame = (speech: boolean) => { const samples = new Float32Array(512); samples[0] = speech ? 1 : 0; engine.feed(samples); };
  return { engine, sent, failures, modes, editor: () => editor,
    counts: () => ({ closed, disposed }), cueCount: () => cues,
    edit: (text: string) => { editor = text; }, busy: (value: boolean) => { blocked = value; engine.tick(); },
    response: (fn: typeof transcribe) => { transcribe = fn; },
    advance: (ms = 1000) => { now += ms; engine.tick(); },
    async wake() { now += 1000; detected = true; frame(false); await flush(); now += 1000; },
    async say() { for (let i = 0; i < 10; i++) { frame(true); await flush(); } for (let i = 0; i < 32; i++) { frame(false); await flush(); } },
  };
}
test("wake → dictation → draft → exact confirmation sends once; no silence submission", async () => {
  const f = fixture();
  await f.wake(); assert.equal(f.engine.state.phase, "dictation");
  await f.say(); assert.equal(f.editor(), "草稿"); assert.deepEqual(f.sent, []);
  f.advance(); f.response(async () => "请确认发送"); await f.say(); assert.deepEqual(f.sent, []);
  f.advance(); f.response(async () => "确认发送。"); await f.say();
  assert.deepEqual(f.sent, ["草稿"]); assert.equal(f.editor(), "");
  assert.deepEqual(f.modes, [false, true, true]);
  await f.engine.stop(); assert.deepEqual(f.counts(), { closed: 1, disposed: 1 });
});
test("ready cue occurs after the guard, never before a period that discards the user's first words", async () => {
  const f = fixture(); await f.wake();
  assert.equal(f.cueCount(), 0);
  f.engine.tick(); assert.equal(f.cueCount(), 1);
  f.engine.tick(); assert.equal(f.cueCount(), 1);
  await f.say(); assert.equal(f.editor(), "草稿");
  await f.engine.stop();
});

test("typed editor changes stop rather than overwrite or send", async () => {
  const f = fixture(); await f.wake(); await f.say();
  f.edit("user text"); f.engine.tick();
  await f.engine.stop();
  assert.equal(f.engine.state.phase, "off"); assert.equal(f.editor(), "user text");
  assert.deepEqual(f.sent, []); assert.equal(f.failures.length, 1);
});
test("busy state aborts recognition, ignores late results and requires a fresh wake", async () => {
  const f = fixture(); let complete!: (text: string) => void; let signal!: AbortSignal;
  f.response(abort => { signal = abort; return new Promise(resolve => { complete = resolve; }); });
  await f.wake(); await f.say(); assert.equal(f.engine.state.phase, "recognizing");
  f.busy(true); assert.equal(signal.aborted, true);
  complete("must not appear"); await flush();
  f.busy(false); assert.equal(f.engine.state.phase, "wake");
  assert.equal(f.editor(), ""); assert.deepEqual(f.sent, []); assert.deepEqual(f.failures, []);
  await f.engine.stop();
});
test("shutdown does not wait for noncooperative ASR and stale approval cannot send", async () => {
  const f = fixture(); await f.wake(); await f.say(); f.advance();
  let complete!: (text: string) => void;
  f.response(() => new Promise(resolve => { complete = resolve; }));
  await f.say(); await f.engine.stop();
  complete("确认发送"); await flush();
  assert.deepEqual(f.sent, []); assert.equal(f.editor(), "草稿");
});
test("timeout preserves draft and returns to wake; errors close without sending", async () => {
  const f = fixture(); await f.wake(); await f.say();
  f.advance(25_000); assert.equal(f.engine.state.phase, "wake"); assert.equal(f.editor(), "草稿");
  await f.wake(); f.response(() => { throw new Error("ASR failed"); });
  await f.say(); await flush(); await f.engine.stop();
  assert.equal(f.failures.length, 1); assert.deepEqual(f.sent, []); assert.equal(f.editor(), "草稿");
});
