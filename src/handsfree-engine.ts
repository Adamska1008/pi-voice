import { HandsFreeSegmenter, HandsFreeState, type HandsFreePhase, type RecognitionTicket } from "./handsfree-state.js";
import type { WakeDetector } from "./wake-detector.js";
import type { VadScorer } from "./vad.js";

export type HandsFreeOptions = {
  wake: WakeDetector;
  scorer: VadScorer;
  transcribe(pcm: Float32Array, command: boolean, signal: AbortSignal): Promise<string>;
  readEditor(): string;
  writeEditor(text: string): void;
  send(text: string): void;
  blocked(): boolean;
  status(phase: HandsFreePhase, ready?: boolean): void;
  cue(): void;
  failure(error: unknown): void;
  now?: () => number;
};

/** Serial audio processing and a separate cancellable ASR job; never infer submission from silence. */
export class HandsFreeEngine {
  readonly state = new HandsFreeState();
  private readonly segmenter = new HandsFreeSegmenter();
  private queue: Float32Array[] = [];
  private processing?: Promise<void>;
  private recognition?: { controller: AbortController; task: Promise<void> };
  private epoch = 0;
  private resetNeeded = false;
  private readyAt = 0;
  private cuePending = false;
  private deadline = Infinity;
  private closing?: Promise<void>;
  private readonly now: () => number;
  constructor(private readonly options: HandsFreeOptions) {
    this.now = options.now ?? (() => performance.now());
    if (options.readEditor()) throw new Error("Clear or send the editor before enabling hands-free mode.");
    this.publish();
  }
  private publish() { this.options.status(this.state.phase, !this.cuePending); }
  private checkEditor(): void {
    if (this.options.readEditor() !== this.state.draft) throw new Error("Editor changed outside hands-free mode; listening stopped without modifying your text.");
  }
  private invalidate(): void {
    this.epoch++;
    this.queue = [];
    this.cuePending = false;
    this.segmenter.reset();
    this.resetNeeded = true;
    this.recognition?.controller.abort();
  }
  pause(): void {
    if (this.state.phase === "off" || this.state.phase === "paused") return;
    this.invalidate(); this.state.pause(); this.publish();
  }
  /** Called by a bounded heartbeat as well as audio arrival, so idle timeouts do not depend on sound. */
  tick(): void {
    if (this.state.phase === "off") return;
    try {
      this.checkEditor();
      if (this.options.blocked()) { this.pause(); return; }
      if (this.state.phase === "paused") {
        this.state.resume(); this.readyAt = this.now() + 700; this.resetNeeded = true; this.publish();
      }
      if ((this.state.phase === "dictation" || this.state.phase === "command") && this.now() >= this.deadline) {
        this.invalidate(); this.state.timeout(); this.publish();
      }
      if (this.cuePending && this.now() >= this.readyAt) {
        this.cuePending = false;
        this.options.cue(); this.publish();
      }
    } catch (error) { this.fail(error); }
  }
  feed(frame: Float32Array): void {
    this.tick();
    if (["off", "paused", "recognizing"].includes(this.state.phase) || this.now() < this.readyAt) return;
    if (frame.length !== 512 || this.queue.length >= 64) { this.fail(new Error("Hands-free audio overflow or invalid frame; nothing sent.")); return; }
    this.queue.push(frame.slice());
    this.pump();
  }
  private pump(): void {
    if (this.processing || this.state.phase === "off") return;
    this.processing = (async () => {
      while (this.queue.length && this.state.phase !== "off") {
        const epoch = this.epoch;
        if (this.resetNeeded) { this.resetNeeded = false; await this.options.wake.reset(); }
        if (epoch !== this.epoch) continue;
        const frame = this.queue.shift();
        if (!frame) continue;
        if (this.state.phase === "wake") {
          const detected = await this.options.wake.feed(frame);
          if (epoch !== this.epoch || this.options.blocked()) { this.tick(); continue; }
          if (detected && this.state.wake()) this.arm();
        } else if (this.state.phase === "dictation" || this.state.phase === "command") {
          const command = this.state.phase === "command";
          const probability = await this.options.scorer.score(frame);
          if (epoch !== this.epoch || this.options.blocked()) { this.tick(); continue; }
          if (probability >= 0.5) this.deadline = this.now() + (command ? 10_000 : 15_000);
          const pcm = this.segmenter.push(frame, probability, command);
          if (pcm) this.recognize(pcm);
        }
      }
    })().catch(error => this.fail(error)).finally(() => { this.processing = undefined; if (this.queue.length) this.pump(); });
  }
  private arm(): void {
    this.invalidate();
    this.readyAt = this.now() + 700; // Discard the previous utterance tail BEFORE issuing the ready cue.
    this.deadline = this.readyAt + 20_000;
    this.cuePending = this.state.phase === "dictation" || this.state.phase === "command";
    this.publish();
  }
  private recognize(pcm: Float32Array): void {
    const ticket = this.state.beginRecognition();
    if (!ticket) return;
    this.queue = []; this.publish();
    const controller = new AbortController();
    const epoch = this.epoch;
    const timeout = setTimeout(() => controller.abort(new Error("Hands-free transcription timed out.")), 30_000);
    timeout.unref();
    let abort!: () => void;
    const cancelled = new Promise<never>((_resolve, reject) => {
      abort = () => reject(controller.signal.reason);
      controller.signal.addEventListener("abort", abort, { once: true });
    });
    const work = Promise.resolve().then(() => {
      controller.signal.throwIfAborted();
      return this.options.transcribe(pcm, ticket.kind === "command", controller.signal);
    });
    const task = Promise.race([work, cancelled])
      .then(text => { if (epoch === this.epoch) this.apply(ticket, text); })
      .catch(error => { if (!controller.signal.aborted || this.state.phase === "recognizing") this.fail(error); })
      .finally(() => { clearTimeout(timeout); controller.signal.removeEventListener("abort", abort); if (this.recognition?.controller === controller) this.recognition = undefined; });
    this.recognition = { controller, task };
  }
  private apply(ticket: RecognitionTicket, text: string): void {
    this.tick();
    if (this.state.phase !== "recognizing") return;
    this.checkEditor();
    const effect = this.state.finish(ticket, text);
    if (effect.type === "send") {
      // Revalidate at the side-effect boundary; never queue hands-free sends into an active run.
      if (this.options.blocked() || this.options.readEditor() !== effect.text) throw new Error("Cannot safely submit this draft now.");
      this.options.send(effect.text);
      // A synchronous send handler may already have started an agent run; do not restore old text.
      if (this.options.readEditor() === effect.text) this.options.writeEditor("");
    } else if (effect.type === "draft") this.options.writeEditor(effect.text);
    this.arm();
  }
  private fail(error: unknown): void {
    if (this.state.phase === "off") return;
    this.invalidate(); this.state.stop();
    try { this.options.failure(error); } catch { /* Cleanup is still required if UI is gone. */ }
    void this.stop();
  }
  stop(): Promise<void> {
    if (this.closing) return this.closing;
    this.invalidate(); this.state.stop();
    this.closing = (async () => {
      await this.options.wake.close();
      await this.processing;
      await this.recognition?.task;
      this.options.scorer.dispose();
    })();
    return this.closing;
  }
}
