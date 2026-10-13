import { fileURLToPath } from "node:url";
import type { TranscribeModel } from "transcribe-cpp";
import { CAPTURE_SAMPLE_RATE } from "./audio-constants.js";
import { getCatalogModel } from "./catalog.js";
import type { SpeechFilter } from "./dictation-controller.js";
import { describeError, log } from "./log.js";
import type { TranscribeSettings } from "./settings.js";

/*
 * Voice activity detection while the microphone streams, after Handy
 * (cjpais/handy, src-tauri/src/audio_toolkit/vad): Silero scores each 32 ms
 * frame, and a smoothing gate keeps speech plus a pre-roll before it and a
 * hangover tail after it. Only kept frames reach transcription.
 */

/** Silero scores 32 ms frames of 16 kHz mono. */
export const VAD_FRAME_SAMPLES = 512;
/** A frame scoring above this is voiced (Handy's Silero threshold). */
export const VAD_THRESHOLD = 0.3;
/** Audio kept before speech starts, so onsets aren't clipped. */
export const VAD_PREFILL_MS = 450;
/** Voiced audio needed before speech starts, so clicks don't count. */
export const VAD_ONSET_MS = 60;
/** Audio kept after speech, for batch models. */
export const VAD_OFFLINE_HANGOVER_MS = 450;
/** A longer tail for streaming models, which need trailing context. */
export const VAD_STREAMING_HANGOVER_MS = 1650;

/** Whole frames covering `durationMs`, rounded up so no timing shortens. */
export function framesForDurationMs(durationMs: number, frameSamples = VAD_FRAME_SAMPLES): number {
  return Math.ceil((durationMs * CAPTURE_SAMPLE_RATE) / (frameSamples * 1000));
}

function concat(pieces: readonly Float32Array[]): Float32Array {
  if (pieces.length === 1) return pieces[0]!;
  const out = new Float32Array(pieces.reduce((sum, piece) => sum + piece.length, 0));
  let offset = 0;
  for (const piece of pieces) {
    out.set(piece, offset);
    offset += piece.length;
  }
  return out;
}

export type SpeechGateOptions = {
  prefillFrames: number;
  onsetFrames: number;
  hangoverFrames: number;
};

type BufferedFrame = { samples: Float32Array; emitted: boolean };

/**
 * Handy's SmoothedVad: turns per-frame voiced/unvoiced decisions into the
 * frames worth keeping. Speech starts after `onsetFrames` consecutive voiced
 * frames and then also releases up to `prefillFrames` of pre-roll; it ends
 * `hangoverFrames` after the last voiced frame.
 */
export class SpeechGate {
  private readonly buffer: BufferedFrame[] = [];
  private hangover = 0;
  private onset = 0;
  private speaking = false;

  constructor(private readonly options: SpeechGateOptions) {}

  get inSpeech(): boolean { return this.speaking; }

  /** The frames to keep now, in order (pre-roll first). */
  push(samples: Float32Array, voiced: boolean): Float32Array[] {
    const frame: BufferedFrame = { samples, emitted: false };
    this.buffer.push(frame);
    while (this.buffer.length > this.options.prefillFrames + 1) this.buffer.shift();

    if (!this.speaking) {
      if (!voiced) {
        this.onset = 0;
        return [];
      }
      if (++this.onset < this.options.onsetFrames) return [];
      this.speaking = true;
      this.onset = 0;
      this.hangover = this.options.hangoverFrames;
      return this.takeWithheld();
    }

    if (voiced) this.hangover = this.options.hangoverFrames;
    else if (this.hangover > 0) this.hangover--;
    else {
      this.speaking = false;
      return [];
    }
    frame.emitted = true;
    return [samples];
  }

  /** Buffered frames not yet kept, which are now kept. */
  takeWithheld(): Float32Array[] {
    const out: Float32Array[] = [];
    for (const frame of this.buffer) {
      if (frame.emitted) continue;
      frame.emitted = true;
      out.push(frame.samples);
    }
    return out;
  }

  /**
   * End of recording. A word started too close to the stop to confirm its
   * onset is still kept; Handy drops it (and reports it as a diagnostic).
   */
  finish(): Float32Array[] {
    return this.onset > 0 ? this.takeWithheld() : [];
  }
}

/** Scores one VAD frame at a time, in recording order. */
export type VadScorer = {
  score(frame: Float32Array): Promise<number>;
  dispose(): void;
};

export type VoiceActivityFilterOptions = {
  /** Opened on the first audio; a rejection keeps every frame. */
  openScorer: () => Promise<VadScorer>;
  /** Receives kept audio, in order, as soon as it is decided. */
  onSpeech: (chunk: Float32Array) => void;
  hangoverMs: number;
  threshold?: number;
};

/**
 * One recording's VAD. Scoring is asynchronous, so frames queue and are
 * decided in order; `finish` waits for the backlog. It never loses speech to
 * its own failure: if the detector can't load or errors, everything not yet
 * dropped as silence is kept and the rest of the recording passes through.
 */
export class VoiceActivityFilter implements SpeechFilter {
  private readonly gate: SpeechGate;
  private readonly threshold: number;
  private readonly pending: Float32Array[] = [];
  private partial = new Float32Array(VAD_FRAME_SAMPLES);
  private partialLength = 0;
  private readonly kept: Float32Array[] = [];
  private keptSamples = 0;
  private scorer: VadScorer | undefined;
  private running: Promise<void> | undefined;
  private failed = false;
  private finishing = false;
  private discarded = false;
  private released = false;
  private frames = 0;
  private voicedFrames = 0;

  constructor(private readonly options: VoiceActivityFilterOptions) {
    this.threshold = options.threshold ?? VAD_THRESHOLD;
    this.gate = new SpeechGate({
      prefillFrames: framesForDurationMs(VAD_PREFILL_MS),
      onsetFrames: framesForDurationMs(VAD_ONSET_MS),
      hangoverFrames: framesForDurationMs(options.hangoverMs),
    });
  }

  push(chunk: Float32Array): void {
    if (this.finishing || this.discarded) return;
    let offset = 0;
    while (offset < chunk.length) {
      const take = Math.min(VAD_FRAME_SAMPLES - this.partialLength, chunk.length - offset);
      if (this.partialLength === 0 && take === VAD_FRAME_SAMPLES) {
        // The recorder delivers exactly one frame per chunk; skip the copy.
        this.pending.push(chunk.subarray(offset, offset + take));
      } else {
        this.partial.set(chunk.subarray(offset, offset + take), this.partialLength);
        this.partialLength += take;
        if (this.partialLength === VAD_FRAME_SAMPLES) {
          this.pending.push(this.partial);
          this.partial = new Float32Array(VAD_FRAME_SAMPLES);
          this.partialLength = 0;
        }
      }
      offset += take;
    }
    this.kick();
  }

  /** Waits for every pushed frame to be decided; returns all kept audio. */
  async finish(): Promise<Float32Array> {
    if (this.discarded) return new Float32Array();
    this.finishing = true;
    while (this.running) await this.running;
    if (this.discarded) return new Float32Array();
    // The trailing partial frame (under 32 ms) follows the current decision.
    if (this.partialLength > 0 && (this.failed || this.gate.inSpeech)) {
      this.keep([this.partial.subarray(0, this.partialLength)]);
    }
    this.partialLength = 0;
    if (!this.failed) this.keep(this.gate.finish());
    this.release();
    const recorded = this.frames * VAD_FRAME_SAMPLES;
    log.info(this.failed
      ? "voice activity detection unavailable; kept the whole recording"
      : `voice activity: kept ${(this.keptSamples / CAPTURE_SAMPLE_RATE).toFixed(1)} s of ${(recorded / CAPTURE_SAMPLE_RATE).toFixed(1)} s (${this.voicedFrames}/${this.frames} frames voiced)`);
    return concat(this.kept);
  }

  discard(): void {
    if (this.discarded) return;
    this.discarded = true;
    this.pending.length = 0;
    // A score may be in flight; free the session once the loop has stopped.
    if (this.running) void this.running.then(() => this.release());
    else this.release();
  }

  private kick(): void {
    if (this.running || this.discarded || this.pending.length === 0) return;
    const running = this.drain().catch((error: unknown) => this.fail(error)).finally(() => {
      if (this.running === running) this.running = undefined;
      this.kick();
    });
    this.running = running;
  }

  private async drain(): Promise<void> {
    if (!this.scorer && !this.failed) {
      try {
        this.scorer = await this.options.openScorer();
      } catch (error) {
        this.fail(error);
      }
      if (this.discarded) return;
    }
    while (this.pending.length > 0 && !this.discarded) {
      const frame = this.pending.shift()!;
      this.frames++;
      if (this.failed) {
        this.keep([frame]);
        continue;
      }
      let probability: number;
      try {
        probability = await this.scorer!.score(frame);
      } catch (error) {
        this.fail(error);
        this.keep([frame]);
        continue;
      }
      if (this.discarded) return;
      const voiced = probability > this.threshold;
      if (voiced) this.voicedFrames++;
      this.keep(this.gate.push(frame, voiced));
    }
  }

  private fail(error: unknown): void {
    if (this.failed) return;
    this.failed = true;
    log.warn(`voice activity detection unavailable, keeping all audio: ${describeError(error)}`);
    this.keep(this.gate.takeWithheld());
    this.release();
  }

  private keep(frames: Float32Array[]): void {
    if (frames.length === 0 || this.discarded) return;
    const chunk = concat(frames);
    this.kept.push(chunk);
    this.keptSamples += chunk.length;
    // The kept audio still reaches the final transcript if streaming fails.
    try { this.options.onSpeech(chunk); } catch { /* Kept regardless. */ }
  }

  private release(): void {
    if (this.released || !this.scorer) return;
    this.released = true;
    try { this.scorer.dispose(); } catch { /* Nothing left to free. */ }
  }
}

/** A loaded Silero model; each recording scores on its own stream session. */
export class SileroVad {
  private model: TranscribeModel | undefined;
  private loading: Promise<TranscribeModel> | undefined;
  private disposed = false;

  constructor(private readonly modelPath: string) {}

  async open(): Promise<VadScorer> {
    const model = await this.load();
    const session = model.createVadSession({ nThreads: 1 });
    return {
      async score(frame) {
        const { probs } = await session.streamFeed(frame);
        // A whole frame in must score exactly one frame; anything else means
        // the stream is out of step with the framing.
        if (probs.length !== 1) throw new Error(`Silero VAD returned ${probs.length} probabilities for one frame`);
        return probs[0]!;
      },
      dispose: () => session.dispose(),
    };
  }

  private load(): Promise<TranscribeModel> {
    if (this.model) return Promise.resolve(this.model);
    if (this.disposed) return Promise.reject(new Error("The voice activity detector has been disposed"));
    this.loading ??= (async () => {
      // Route native logs into Pi Voice's log before the first native call.
      const { routeTranscribeLog } = await import("./transcription.js");
      const { TranscribeModel, setLogHandler } = await import("transcribe-cpp");
      routeTranscribeLog(setLogHandler);
      const model = await TranscribeModel.load(this.modelPath);
      const info = model.vadInfo;
      if (info.sampleRate !== CAPTURE_SAMPLE_RATE || info.frameSamples !== VAD_FRAME_SAMPLES) {
        model.dispose();
        throw new Error(`Unsupported VAD model: ${info.sampleRate} Hz, ${info.frameSamples} samples per frame`);
      }
      if (this.disposed) {
        model.dispose();
        throw new Error("The voice activity detector was disposed while loading");
      }
      this.model = model;
      return model;
    })().finally(() => { this.loading = undefined; });
    return this.loading;
  }

  async dispose(): Promise<void> {
    this.disposed = true;
    await this.loading?.catch(() => undefined);
    this.model?.dispose();
    this.model = undefined;
  }
}

/** Ships with Pi Voice (see models/README.md); the gate is tuned for it. */
export const BUNDLED_VAD_MODEL_PATH = fileURLToPath(new URL("../models/silero-vad-v6.2-F32.gguf", import.meta.url));

/**
 * Pi Voice's VAD for its lifetime: loads the bundled Silero model on the
 * first recording that needs it and keeps it loaded across recordings.
 */
export class VoiceActivityDetection {
  private engine: SileroVad | undefined;
  private disposed = false;

  constructor(private readonly modelPath = BUNDLED_VAD_MODEL_PATH) {}

  /** A filter for one recording, or undefined when the setting is off. */
  createFilter(settings: TranscribeSettings, onSpeech: (chunk: Float32Array) => void): SpeechFilter | undefined {
    if (!settings.voiceActivityDetection || this.disposed) return undefined;
    const streaming = getCatalogModel(settings.model.id)?.capabilities.streaming ?? false;
    return new VoiceActivityFilter({
      openScorer: () => {
        if (this.disposed) return Promise.reject(new Error("Pi Voice is shutting down"));
        return (this.engine ??= new SileroVad(this.modelPath)).open();
      },
      onSpeech,
      hangoverMs: streaming ? VAD_STREAMING_HANGOVER_MS : VAD_OFFLINE_HANGOVER_MS,
    });
  }

  /** Call after every filter is finished or discarded. */
  async dispose(): Promise<void> {
    this.disposed = true;
    const engine = this.engine;
    this.engine = undefined;
    await engine?.dispose();
  }
}
