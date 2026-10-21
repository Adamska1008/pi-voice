import { spawn } from "node:child_process";
import type { SpeechAudio, SpeechBackend, SpeechRequest } from "./tts.js";

/** One disposable process per request. Models must already exist locally; no implicit downloads. */
export class QwenSpeechBackend implements SpeechBackend {
  constructor(private readonly options: {
    executable: string; talkerPath: string; codecPath: string; device?: string; timeoutMs?: number;
  }, private readonly launch: typeof spawn = spawn) {}
  async synthesize({ text, voice = "Vivian", signal }: SpeechRequest): Promise<SpeechAudio> {
    signal.throwIfAborted();
    if (!text.trim() || Array.from(text).length > 600) throw new Error("TTS requires 1–600 characters.");
    const args = ["--model", this.options.talkerPath, "--codec", this.options.codecPath,
      "--device", this.options.device ?? "Vulkan0", "--speaker", voice.toLowerCase(),
      "--lang", "Chinese", "--max-new", "600", "--format", "wav16", "-o", "-"];
    return new Promise((resolve, reject) => {
      const child = this.launch(this.options.executable, args, {
        shell: false, windowsHide: true, stdio: ["pipe", "pipe", "ignore"],
      });
      const chunks: Buffer[] = [];
      let bytes = 0;
      let failure: unknown;
      const stop = (error: unknown) => { failure ??= error; child.kill(); };
      const abort = () => stop(signal.reason ?? new Error("TTS cancelled."));
      const timer = setTimeout(() => stop(new Error("TTS timed out.")), this.options.timeoutMs ?? 120_000);
      timer.unref();
      signal.addEventListener("abort", abort, { once: true });
      if (signal.aborted) abort();
      child.on("error", error => { failure ??= error; });
      child.stdin.on("error", error => stop(error));
      child.stdout.on("data", (chunk: Buffer) => {
        bytes += chunk.length;
        if (bytes > 32 * 1024 * 1024) { stop(new Error("TTS audio exceeded 32 MiB.")); return; }
        if (!failure) chunks.push(chunk);
      });
      child.on("close", code => {
        clearTimeout(timer);
        signal.removeEventListener("abort", abort);
        if (failure) { reject(failure); return; }
        if (code !== 0) { reject(new Error(`Qwen TTS worker failed (exit ${code}); check model paths, device and runtime libraries.`)); return; }
        const data = Buffer.concat(chunks);
        if (data.length < 44 || data.toString("ascii", 0, 4) !== "RIFF" || data.toString("ascii", 8, 12) !== "WAVE") {
          reject(new Error("TTS worker did not return WAV audio.")); return;
        }
        resolve({ format: "wav", data });
      });
      child.stdin.end(text, "utf8");
    });
  }
}
