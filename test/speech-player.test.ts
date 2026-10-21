import assert from "node:assert/strict";
import test from "node:test";
import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SpeechPlayer } from "../src/speech-player.js";

function audio() {
  const data = Buffer.alloc(46);
  data.write("RIFF"); data.write("WAVE", 8);
  return { format: "wav" as const, data };
}
async function fixture(t: test.TestContext, source: string, timeoutMs = 5000) {
  const directory = await mkdtemp(join(tmpdir(), "speech-player-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const worker = join(directory, "player.mjs");
  await writeFile(worker, source);
  const children: ReturnType<typeof spawn>[] = [];
  const launch = ((command: string, args: string[], options: any) => {
    assert.equal(command, "ffplay"); assert.equal(options.shell, false);
    assert.deepEqual(args, ["-nodisp", "-autoexit", "-loglevel", "error", "-f", "wav", "-i", "pipe:0"]);
    const child = spawn(process.execPath, [worker], options);
    children.push(child); return child;
  }) as typeof spawn;
  return { player: new SpeechPlayer({ timeoutMs }, launch), children };
}

test("streams an immutable audio snapshot and allows replay after completion", async t => {
  const f = await fixture(t, `
    let bytes = Buffer.alloc(0); for await (const part of process.stdin) bytes = Buffer.concat([bytes, part]);
    if (bytes.length !== 46 || bytes.toString('ascii',0,4) !== 'RIFF') process.exit(2);
  `);
  const input = audio();
  const task = f.player.play(input, new AbortController().signal);
  input.data.fill(0);
  await task;
  await f.player.play(audio(), new AbortController().signal);
  assert.equal(f.children.length, 2);
});

test("stop is idempotent, drains the child, rejects overlap and permits replay", async t => {
  const f = await fixture(t, "process.stdin.resume(); setInterval(() => {}, 1000)");
  const task = f.player.play(audio(), new AbortController().signal);
  const rejected = assert.rejects(task);
  await assert.rejects(f.player.play(audio(), new AbortController().signal), /already active/);
  await Promise.all([f.player.stop(), f.player.stop()]);
  await rejected;
  assert.ok(f.children[0]!.exitCode !== null || f.children[0]!.signalCode !== null);
  const replay = assert.rejects(f.player.play(audio(), new AbortController().signal));
  await f.player.stop(); await replay;
  await f.player.stop();
});

test("invalid input and pre-cancellation never launch; timeout and external abort stop playback", async t => {
  const f = await fixture(t, "setInterval(() => {}, 1000)", 30);
  await assert.rejects(f.player.play({ format: "wav", data: new Uint8Array(1) }, new AbortController().signal), /WAV/);
  await assert.rejects(f.player.play(audio(), AbortSignal.abort()));
  assert.equal(f.children.length, 0);
  await assert.rejects(f.player.play(audio(), new AbortController().signal), /timed out/);
  const controller = new AbortController();
  const task = f.player.play(audio(), controller.signal);
  controller.abort(); await assert.rejects(task);
});

test("missing player and playback failures reject instead of silently succeeding", async t => {
  const missing = new SpeechPlayer({ executable: join(tmpdir(), "pi-voice-no-such-player") });
  await assert.rejects(missing.play(audio(), new AbortController().signal), /ENOENT/);
  const f = await fixture(t, "process.stdin.resume(); process.stdin.on('end', () => process.exit(3))");
  await assert.rejects(f.player.play(audio(), new AbortController().signal), /code 3/);
});
