import assert from "node:assert/strict";
import test from "node:test";
import type { BackendInfo, ModelOptions, TranscribeModel, TranscribeOptions } from "transcribe-cpp";
import { TranscribeCppBackend } from "../src/transcription.js";

type RuntimeLoader = NonNullable<ConstructorParameters<typeof TranscribeCppBackend>[1]>;
type TestRuntime = Awaited<ReturnType<RuntimeLoader>>;

test("vocabulary reaches native batch and stream calls only when supported and nonempty", async (t) => {
  for (const supported of [true, false]) {
    const calls: TranscribeOptions[] = [];
    const model = {
      capabilities: { languages: ["en"], supportsStreaming: true },
      supports: (feature: string) => feature === "vocabulary" && supported,
      async transcribe(_pcm: Float32Array, options: TranscribeOptions) {
        calls.push(options);
        return { text: "Dolt", language: "en" };
      },
      createSession: () => ({
        async stream(options: TranscribeOptions) {
          calls.push(options);
          return { reset() {} };
        },
        dispose() {},
      }),
      dispose() {},
    } as unknown as TranscribeModel;
    const backend = new TranscribeCppBackend("test", async () => runtime({ load: async () => model }));
    t.after(() => backend.dispose());
    for (const vocabulary of [["Dolt"], [], undefined]) {
      const options = { vocabulary, language: "en" };
      await backend.transcribe(Float32Array.of(1), options);
      (await backend.startStream(options))!.reset();
      for (const call of calls.splice(0)) {
        assert.deepEqual(call.vocabulary, supported && vocabulary?.length ? vocabulary : undefined);
        assert.equal(call.language, "en");
        assert.equal(call.timestamps, "none");
      }
    }
  }
});

class TestOutOfMemory extends Error {}

test("reference prompt uses the model tokenizer once per snapshot and reaches stream and batch", async t => {
  for (const supported of [true, false]) {
    const calls: TranscribeOptions[] = [];
    let tokenizations = 0;
    const model = {
      capabilities: { languages: ["en"], supportsStreaming: true },
      supports: (feature: string) => feature === "vocabulary" || (feature === "context_prompt" && supported),
      tokenize: (text: string) => { tokenizations++; return new Int32Array(Array.from(text).length * 3); },
      async transcribe(_pcm: Float32Array, options: TranscribeOptions) {
        calls.push(options); return { text: "Dolt", language: "en" };
      },
      createSession: () => ({
        async stream(options: TranscribeOptions) { calls.push(options); return { reset() {} }; }, dispose() {},
      }), dispose() {},
    } as unknown as TranscribeModel;
    const backend = new TranscribeCppBackend("test", async () => runtime({ load: async () => model }));
    t.after(() => backend.dispose());
    const options = { vocabulary: ["Dolt"], context: [{ role: "user", content: "Dolt。" + "中间内容。".repeat(500) + "不要修改。" }] };
    await backend.transcribe(Float32Array.of(1), options);
    const counted = tokenizations;
    (await backend.startStream(options))!.reset();
    assert.equal(tokenizations, counted, "stream reuses the exact same prepared prompt");
    assert.equal(calls[0]!.prompt, calls[1]!.prompt);
    assert.deepEqual(calls[0]!.vocabulary, ["Dolt"]);
    if (supported) {
      assert.ok(Array.from(calls[0]!.prompt!).length * 3 <= 1024);
      assert.match(calls[0]!.prompt!, /Dolt/);
      assert.match(calls[0]!.prompt!, /不要修改/);
    } else {
      assert.equal(counted, 0);
      assert.equal(calls[0]!.prompt, undefined);
    }
    await backend.transcribe(Float32Array.of(1));
    assert.equal(calls[2]!.prompt, undefined, "unrelated transcription does not inherit context");
  }
});

const accelerator: BackendInfo = {
  name: "Vulkan0",
  description: "Test GPU",
  kind: "vulkan",
  deviceType: "gpu",
  deviceId: "0000:01:00.0",
  memoryTotal: 12_000_000_000,
  memoryFree: 1_000_000_000,
  index: 0,
};

const cpu: BackendInfo = {
  name: "CPU",
  description: "Test CPU",
  kind: "cpu",
  deviceType: "cpu",
  deviceId: null,
  memoryTotal: 16_000_000_000,
  memoryFree: 8_000_000_000,
  index: 1,
};

function fakeModel(dispose: () => void = () => {}): TranscribeModel {
  return { dispose } as unknown as TranscribeModel;
}

function runtime(options: {
  load: (path: string, modelOptions?: ModelOptions) => Promise<TranscribeModel>;
  devices?: BackendInfo[];
}): TestRuntime {
  return {
    TranscribeModel: { load: options.load },
    OutOfMemory: TestOutOfMemory,
    getAvailableBackends: () => options.devices ?? [accelerator, cpu],
    setLogHandler: () => {},
  } as unknown as TestRuntime;
}

test("an accelerator out-of-memory load retries on the exact CPU device", async () => {
  const calls: Array<{ path: string; options?: ModelOptions }> = [];
  const model = fakeModel();
  const backend = new TranscribeCppBackend("model.gguf", async () => runtime({
    async load(path, options) {
      calls.push({ path, options });
      if (!options) throw new TestOutOfMemory("GPU allocation failed");
      return model;
    },
  }));

  await backend.prepare();

  assert.deepEqual(calls, [
    { path: "model.gguf", options: undefined },
    { path: "model.gguf", options: { device: cpu } },
  ]);
  await backend.dispose();
});

test("a non-memory model-load failure is not retried", async () => {
  const failure = new Error("invalid model");
  let loads = 0;
  const backend = new TranscribeCppBackend("model.gguf", async () => runtime({
    async load() {
      loads += 1;
      throw failure;
    },
  }));

  await assert.rejects(backend.prepare(), (error) => error === failure);
  assert.equal(loads, 1);
  await backend.dispose();
});

test("an out-of-memory failure is preserved when no CPU device is available", async () => {
  const failure = new TestOutOfMemory("GPU allocation failed");
  let loads = 0;
  const backend = new TranscribeCppBackend("model.gguf", async () => runtime({
    devices: [accelerator],
    async load() {
      loads += 1;
      throw failure;
    },
  }));

  await assert.rejects(backend.prepare(), (error) => error === failure);
  assert.equal(loads, 1);
  await backend.dispose();
});

test("a CPU-only out-of-memory failure is not retried", async () => {
  const failure = new TestOutOfMemory("CPU allocation failed");
  let loads = 0;
  const backend = new TranscribeCppBackend("model.gguf", async () => runtime({
    devices: [cpu],
    async load() {
      loads += 1;
      throw failure;
    },
  }));

  await assert.rejects(backend.prepare(), (error) => error === failure);
  assert.equal(loads, 1);
  await backend.dispose();
});
