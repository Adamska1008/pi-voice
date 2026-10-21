import assert from "node:assert/strict";
import test from "node:test";
import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { QwenSpeechBackend } from "../src/qwen-tts.js";

async function fixture(t: test.TestContext, source: string, timeoutMs = 5000) {
  const directory = await mkdtemp(join(tmpdir(), "qwen-worker-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const workerPath = join(directory, "worker.mjs");
  await writeFile(workerPath, source);
  const launch = ((_command: string, args: string[], options: any) => {
    assert.equal(options.shell, false);
    assert.equal(_command, "qwen-tts");
    return spawn(process.execPath, [workerPath, ...args], options);
  }) as typeof spawn;
  return new QwenSpeechBackend({ executable: "qwen-tts", talkerPath: "models/talker with spaces.gguf",
    codecPath: "models/codec.gguf", timeoutMs }, launch);
}

test("CLI protocol carries raw UTF-8 input and separate Vulkan/model/voice arguments", async t => {
  const backend = await fixture(t, `
    let input = ''; for await (const chunk of process.stdin) input += chunk;
    const args = process.argv.slice(2);
    const value = flag => args[args.indexOf(flag) + 1];
    if (input !== '中文 "hello"' || value('--speaker') !== 'vivian' || value('--device') !== 'Vulkan0'
      || value('--model') !== 'models/talker with spaces.gguf' || value('--codec') !== 'models/codec.gguf'
      || value('--lang') !== 'Chinese' || value('--max-new') !== '600' || value('-o') !== '-') process.exit(2);
    const wav = Buffer.alloc(46); wav.write('RIFF'); wav.writeUInt32LE(38, 4); wav.write('WAVEfmt ', 8);
    wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22);
    wav.writeUInt32LE(24000, 24); wav.writeUInt32LE(48000, 28); wav.writeUInt16LE(2, 32);
    wav.writeUInt16LE(16, 34); wav.write('data', 36); wav.writeUInt32LE(2, 40); process.stdout.write(wav);
  `);
  const audio = await backend.synthesize({ text: '中文 "hello"', signal: new AbortController().signal });
  assert.equal(audio.format, "wav");
  assert.equal(audio.data.length, 46);
});

test("rejects invalid requests, worker errors and non-audio output", async t => {
  const backend = await fixture(t, "process.exit(3)");
  for (const text of [" ", "中".repeat(601)]) {
    await assert.rejects(backend.synthesize({ text, signal: new AbortController().signal }), /1–600/);
  }
  await assert.rejects(backend.synthesize({ text: "测试", signal: AbortSignal.abort() }));
  await assert.rejects(backend.synthesize({ text: "测试", signal: new AbortController().signal }), /exit 3/);
  const invalid = await fixture(t, "process.stdout.write('not audio')");
  await assert.rejects(invalid.synthesize({ text: "测试", signal: new AbortController().signal }), /WAV/);
});

test("missing executable and excessive output fail without returning audio", async t => {
  const missing = new QwenSpeechBackend({ executable: join(tmpdir(), "pi-voice-no-such-executable"),
    talkerPath: "unused", codecPath: "unused" });
  await assert.rejects(missing.synthesize({ text: "测试", signal: new AbortController().signal }), /ENOENT/);
  const excessive = await fixture(t, `
    process.stdout.write(Buffer.alloc(33 * 1024 * 1024));
    setInterval(() => {}, 1000);
  `);
  await assert.rejects(excessive.synthesize({ text: "测试", signal: new AbortController().signal }), /32 MiB/);
});

test("cancellation and timeout terminate worker before settling", async t => {
  const backend = await fixture(t, "setInterval(() => {}, 1000)");
  const abort = new AbortController();
  const result = backend.synthesize({ text: "测试", signal: abort.signal });
  abort.abort();
  await assert.rejects(result);
  const timed = await fixture(t, "setInterval(() => {}, 1000)", 20);
  await assert.rejects(timed.synthesize({ text: "测试", signal: new AbortController().signal }), /timed out/);
});
