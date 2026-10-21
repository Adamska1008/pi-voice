import { fork, type ChildProcess } from "node:child_process";
import { stat } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

export const WAKE_PHRASE = "你好问问";
export const KWS_FILES = {
  encoder: "encoder-epoch-99-avg-1-chunk-16-left-64.int8.onnx",
  decoder: "decoder-epoch-99-avg-1-chunk-16-left-64.onnx",
  joiner: "joiner-epoch-99-avg-1-chunk-16-left-64.int8.onnx",
};
export interface WakeDetector {
  feed(frame: Float32Array): Promise<boolean>;
  reset(): Promise<void>;
  close(): Promise<void>;
}

export async function openWakeDetector(directory: string, signal: AbortSignal, workerPath = fileURLToPath(new URL("./wake-worker.mjs", import.meta.url))): Promise<WakeDetector> {
  signal.throwIfAborted();
  const models = Object.fromEntries(Object.entries(KWS_FILES).map(([name, file]) => [name, join(directory, file)]));
  const tokens = join(directory, "tokens.txt");
  const keywords = fileURLToPath(new URL("../models/wake-keywords.txt", import.meta.url));
  for (const path of [...Object.values(models), tokens, keywords]) {
    if (!(await stat(path).catch(() => undefined))?.isFile()) throw new Error("Wake model missing. Run npm run wake:setup first.");
  }
  signal.throwIfAborted();
  const child: ChildProcess = fork(workerPath, [], { serialization: "advanced", stdio: ["ignore", "ignore", "ignore", "ipc"], execArgv: [] });
  let closed = false;
  let nextId = 0;
  const pending = new Map<number, { resolve: (keyword: string) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }>();
  const exited = new Promise<void>(resolve => child.once("close", () => resolve()));
  function rejectAll(error: Error) {
    for (const request of pending.values()) { clearTimeout(request.timer); request.reject(error); }
    pending.clear();
  }
  let closing: Promise<void> | undefined;
  function close(): Promise<void> {
    if (closing) return closing;
    closed = true;
    rejectAll(new Error("Wake detector closed."));
    child.kill();
    const force = setTimeout(() => child.kill("SIGKILL"), 1000);
    force.unref();
    closing = exited.finally(() => { clearTimeout(force); signal.removeEventListener("abort", abort); });
    return closing;
  }
  const abort = () => { void close(); };
  signal.addEventListener("abort", abort, { once: true });
  child.on("error", () => { rejectAll(new Error("Could not start local wake detector.")); void close(); });
  child.on("close", () => { closed = true; rejectAll(new Error("Local wake detector exited.")); signal.removeEventListener("abort", abort); });
  child.on("message", (message: any) => {
    const request = pending.get(message?.id);
    if (!request) return;
    pending.delete(message.id); clearTimeout(request.timer);
    if (message.error) request.reject(new Error("Local wake detector failed; check model compatibility."));
    else request.resolve(typeof message.keyword === "string" ? message.keyword : "");
  });
  function invoke(type: string, payload: object = {}): Promise<string> {
    if (closed || signal.aborted) return Promise.reject(new Error("Wake detector is closed."));
    if (pending.size >= 4) return Promise.reject(new Error("Wake detector overloaded."));
    return new Promise((resolve, reject) => {
      const id = nextId++;
      const timer = setTimeout(() => { rejectAll(new Error("Wake detector timed out.")); void close(); }, 15_000);
      timer.unref();
      pending.set(id, { resolve, reject, timer });
      child.send({ id, type, ...payload }, error => { if (error) { rejectAll(new Error("Wake detector IPC failed.")); void close(); } });
    });
  }
  try {
    if (signal.aborted) await close();
    await invoke("init", { models, tokens, keywords });
  } catch (error) { await close(); throw error; }
  return {
    async feed(frame) {
      if (frame.length !== 512) throw new Error("Wake detector requires 512-sample frames.");
      return (await invoke("audio", { samples: frame })) === WAKE_PHRASE;
    },
    async reset() { await invoke("reset"); },
    close,
  };
}
