import assert from "node:assert/strict";
import test from "node:test";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { createSpeechReply } from "../src/speech-reply.js";
const flush = () => new Promise(resolve => setImmediate(resolve));
function context() {
  const notices: string[] = [];
  const statuses: unknown[] = [];
  const ctx = { hasUI: true, isIdle: () => true, ui: {
    notify: (text: string) => notices.push(text), setStatus: (_key: string, value: unknown) => statuses.push(value),
  } } as unknown as ExtensionContext;
  return { ctx, notices, statuses };
}

test("repeat cancels instead of overlapping; stop drains before allowing replay", async () => {
  const f = context();
  let calls = 0;
  let signal!: AbortSignal;
  let finish!: () => void;
  const reply = createSpeechReply(async (_ctx, abort) => {
    calls++; signal = abort;
    await new Promise<void>(resolve => { finish = resolve; });
  });
  reply.toggle(f.ctx); await flush();
  reply.toggle(f.ctx);
  assert.equal(signal.aborted, true);
  let stopped = false;
  const stopping = reply.stop().then(() => { stopped = true; });
  await flush(); assert.equal(stopped, false);
  finish(); await stopping;
  assert.equal(calls, 1);
  reply.toggle(f.ctx); await flush(); assert.equal(calls, 2);
  finish(); await reply.stop();
  assert.deepEqual(f.notices, []);
  assert.equal(f.statuses.at(-1), undefined);
});

test("busy replies do not start; errors notify; shutdown suppresses late results", async () => {
  const f = context();
  const failed = createSpeechReply(async () => { throw new Error("expected failure"); });
  failed.toggle({ ...f.ctx, isIdle: () => false }); await flush();
  assert.match(f.notices[0]!, /finish/);
  failed.toggle(f.ctx); await flush();
  assert.match(f.notices[1]!, /expected failure/);
  let finish!: () => void;
  let calls = 0;
  const reply = createSpeechReply(async () => { calls++; await new Promise<void>(resolve => { finish = resolve; }); throw new Error("late"); });
  reply.toggle(f.ctx); await flush();
  const closing = reply.shutdown(); finish(); await closing;
  reply.toggle(f.ctx); await flush();
  assert.equal(calls, 1);
  assert.equal(f.notices.length, 2);
});
