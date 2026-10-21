import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { KWS_FILES, openWakeDetector } from "../src/wake-detector.js";
async function fixture(t: test.TestContext, source: string) {
  const directory = await mkdtemp(join(tmpdir(), "voice-kws-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  for (const file of [...Object.values(KWS_FILES), "tokens.txt"]) await writeFile(join(directory, file), "fixture");
  const worker = join(directory, "worker.mjs");
  await writeFile(worker, source);
  return { directory, worker };
}
test("IPC carries float samples, matches only configured phrase, resets and closes", async t => {
  const f = await fixture(t, `process.on('message', m => {
    if (m.type==='audio' && !(m.samples instanceof Float32Array)) process.exit(3);
    process.send({id:m.id, keyword:m.type==='audio' && m.samples[0]===1 ? '你好问问' : '小爱同学'});
  });`);
  const wake = await openWakeDetector(f.directory, new AbortController().signal, f.worker);
  const frame = new Float32Array(512);
  assert.equal(await wake.feed(frame), false);
  frame[0] = 1;
  assert.equal(await wake.feed(frame), true);
  await wake.reset();
  await wake.close(); await wake.close();
  await assert.rejects(wake.feed(frame), /closed|abort/i);
});
test("native crashes and cancellation reject pending work without hanging shutdown", async t => {
  const f = await fixture(t, `process.on('message', m => { if(m.type==='init') process.send({id:m.id}); else process.exit(2); });`);
  const wake = await openWakeDetector(f.directory, new AbortController().signal, f.worker);
  await assert.rejects(wake.feed(new Float32Array(512)), /exited/);
  await wake.close();
  const hung = await fixture(t, `process.on('message', m => { if(m.type==='init') process.send({id:m.id}); });`);
  const abort = new AbortController();
  const second = await openWakeDetector(hung.directory, abort.signal, hung.worker);
  const result = assert.rejects(second.feed(new Float32Array(512)), /closed/);
  abort.abort(); await result; await second.close();
});
test("worker recycling replays bounded context without losing a crossing keyword", async t => {
  const f = await fixture(t, `let previous=0; process.on('message', m => {
    let keyword=''; if(m.type==='audio'){if(previous===1 && m.samples[0]===2) keyword='你好问问';previous=m.samples[0];}
    process.send({id:m.id,keyword});
  });`);
  const wake = await openWakeDetector(f.directory, new AbortController().signal, f.worker, 2);
  const frame = new Float32Array(512);
  await wake.feed(frame); frame[0]=1; await wake.feed(frame); frame[0]=2;
  assert.equal(await wake.feed(frame), true);
  await wake.close();
});

test("missing files and pre-cancelled requests do not start native inference", async () => {
  await assert.rejects(openWakeDetector("missing-kws-model", new AbortController().signal), /wake:setup/);
  await assert.rejects(openWakeDetector("unused", AbortSignal.abort()));
});
