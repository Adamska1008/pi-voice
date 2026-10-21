export type HandsFreePhase = "wake" | "dictation" | "command" | "recognizing" | "paused" | "off";
export type RecognitionTicket = { revision: number; kind: "dictation" | "command" };
export type HandsFreeEffect = { type: "draft"; text: string } | { type: "send"; text: string } | { type: "none" };
const NONE: HandsFreeEffect = { type: "none" };

/** No fuzzy commands and no automatic submission. Revisions reject late asynchronous results. */
export class HandsFreeState {
  phase: HandsFreePhase = "wake";
  draft = "";
  private revision = 0;
  private move(phase: HandsFreePhase) { this.phase = phase; this.revision++; }
  wake(): boolean {
    if (this.phase !== "wake") return false;
    this.move(this.draft ? "command" : "dictation");
    return true;
  }
  beginRecognition(): RecognitionTicket | undefined {
    if (this.phase !== "dictation" && this.phase !== "command") return;
    const kind = this.phase;
    this.move("recognizing");
    return { revision: this.revision, kind };
  }
  finish(ticket: RecognitionTicket, text: string): HandsFreeEffect {
    if (this.phase !== "recognizing" || ticket.revision !== this.revision) return NONE;
    if (ticket.kind === "dictation") {
      const addition = text.trim();
      const draft = [this.draft, addition].filter(Boolean).join("\n");
      if (draft.length > 8000) { this.move("wake"); throw new Error("Hands-free draft exceeds 8000 characters; use the editor."); }
      this.draft = draft;
      this.move(this.draft ? "command" : "wake");
      return { type: "draft", text: this.draft };
    }
    // Permit punctuation added by ASR, but never match a substring or a negated command.
    const command = text.trim().replace(/[\s。！？!?，,.]/g, "");
    if (command === "确认发送" && this.draft) {
      const draft = this.draft;
      this.draft = "";
      this.move("wake"); // Consume approval before the caller dispatches it.
      return { type: "send", text: draft };
    }
    if (command === "取消输入") {
      this.draft = "";
      this.move("wake");
      return { type: "draft", text: "" };
    }
    this.move(command === "继续" || command === "继续输入" ? "dictation" : "command");
    return NONE;
  }
  timeout(): void {
    if (this.phase === "dictation" || this.phase === "command") this.move("wake");
  }
  pause(): void { if (this.phase !== "off" && this.phase !== "paused") this.move("paused"); }
  resume(): void { if (this.phase === "paused") this.move("wake"); }
  stop(): void { this.move("off"); }
}

/** Fixed 16 kHz/512-sample VAD frames; bounded utterances, no recording of idle audio. */
export class HandsFreeSegmenter {
  private pieces: Float32Array[] = [];
  private leading: Float32Array[] = [];
  private voiced = 0;
  private silence = 0;
  reset(): void { this.pieces = []; this.leading = []; this.voiced = 0; this.silence = 0; }
  push(frame: Float32Array, probability: number, command: boolean): Float32Array | undefined {
    if (frame.length !== 512 || !Number.isFinite(probability)) throw new Error("Invalid hands-free VAD frame");
    const speech = probability >= 0.5;
    if (!this.pieces.length && !speech) {
      this.leading.push(frame.slice());
      if (this.leading.length > 8) this.leading.shift();
      return;
    }
    if (!this.pieces.length) { this.pieces.push(...this.leading); this.leading = []; }
    this.pieces.push(frame.slice());
    if (speech) { this.voiced++; this.silence = 0; } else this.silence++;
    const maxFrames = Math.ceil((command ? 8 : 60) * 16000 / 512);
    if (this.pieces.length >= maxFrames) {
      this.reset();
      throw new Error("Hands-free utterance too long; nothing was sent.");
    }
    if (this.silence < 32) return; // About one second of silence ends an utterance, never sends it.
    if (this.voiced < 8) { this.reset(); return; }
    const pcm = new Float32Array(this.pieces.length * 512);
    this.pieces.forEach((piece, index) => pcm.set(piece, index * 512));
    this.reset();
    return pcm;
  }
}
