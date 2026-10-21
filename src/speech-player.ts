import { spawn } from "node:child_process";
import type { SpeechAudio } from "./tts.js";

/** Complete-audio playback only. No summary generation, TTS or transcript access. */
export class SpeechPlayer {
  private active?: { controller: AbortController; settled: Promise<void> };
  constructor(private readonly options: { executable?: string; timeoutMs?: number } = {},
    private readonly launch: typeof spawn = spawn) {}

  async play(audio: SpeechAudio, signal: AbortSignal): Promise<void> {
    signal.throwIfAborted();
    if (this.active) throw new Error("Speech playback is already active.");
    if (audio.format !== "wav" || audio.data.length < 44 || audio.data.length > 32 * 1024 * 1024) {
      throw new Error("Speech playback requires bounded WAV audio.");
    }
    const data = Buffer.from(audio.data); // Do not observe caller edits during playback.
    if (data.toString("ascii", 0, 4) !== "RIFF" || data.toString("ascii", 8, 12) !== "WAVE") {
      throw new Error("Speech playback requires WAV audio.");
    }
    const controller = new AbortController();
    const combined = AbortSignal.any([signal, controller.signal]);
    const settled = new Promise<void>((resolve, reject) => {
      const child = this.launch(this.options.executable ?? "ffplay",
        ["-nodisp", "-autoexit", "-loglevel", "error", "-f", "wav", "-i", "pipe:0"],
        { shell: false, windowsHide: true, stdio: ["pipe", "ignore", "ignore"] });
      let failure: unknown;
      let forceKill: ReturnType<typeof setTimeout> | undefined;
      const terminate = (error: unknown) => {
        failure ??= error;
        child.kill();
        forceKill ??= setTimeout(() => child.kill("SIGKILL"), 500);
        forceKill.unref();
      };
      const abort = () => terminate(combined.reason ?? new Error("Speech playback stopped."));
      const timeout = setTimeout(() => terminate(new Error("Speech playback timed out.")), this.options.timeoutMs ?? 120_000);
      timeout.unref();
      combined.addEventListener("abort", abort, { once: true });
      if (combined.aborted) abort();
      child.on("error", error => { failure ??= error; });
      child.stdin.on("error", error => terminate(error));
      child.on("close", code => {
        clearTimeout(timeout);
        clearTimeout(forceKill);
        combined.removeEventListener("abort", abort);
        if (failure) reject(failure);
        else if (code !== 0) reject(new Error(`Speech player exited with code ${code}.`));
        else resolve();
      });
      child.stdin.end(data);
    });
    const active = { controller, settled };
    this.active = active;
    try { await settled; }
    finally { if (this.active === active) this.active = undefined; }
  }

  /** Resolves only after the playback process closes; repeated stops are safe. */
  async stop(): Promise<void> {
    const active = this.active;
    if (!active) return;
    active.controller.abort();
    await active.settled.catch(() => undefined);
  }
}
