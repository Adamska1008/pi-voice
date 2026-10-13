import { CAPTURE_CHUNK_SAMPLES as FRAME, CAPTURE_SAMPLE_RATE as RATE } from "./audio-constants.js";
import { getCatalogModel } from "./catalog.js";
import { log } from "./log.js";
import type { DictationStream } from "./transcription.js";

// Long audio is decoded in chunks cut at pauses. Whisper windows audio itself
// and streaming models never see a whole clip, so neither is chunked.
const TARGET_SECONDS = 30;
const HARD_MAX = 40 * RATE;
const MIN_CHUNK = 5 * RATE;
// Live, a cut is only final once the audio a little past it is scored.
const LOOKAHEAD = RATE;

// Silero's segmentation, as VadSession.run applies it.
const THRESHOLD = 0.5;
const NEG_THRESHOLD = THRESHOLD - 0.15;
const MIN_SPEECH = (250 * RATE) / 1000;
const MIN_SILENCE = (100 * RATE) / 1000;
const SPEECH_PAD = (30 * RATE) / 1000;

export function chunksTranscription(modelId: string): boolean {
  const model = getCatalogModel(modelId);
  return model !== undefined && model.family !== "whisper" && !model.capabilities.streaming;
}

/** Audio this short is decoded in one piece. */
export function fitsOneChunk(samples: number): boolean {
  return samples <= HARD_MAX;
}

export type SpeechSegment = { start: number; end: number };

/**
 * Speech segments, in samples, from per-frame Silero probabilities: Silero
 * 6.2.3's get_speech_timestamps as transcribe.cpp ports it
 * (vad_probs_to_segments), without a maximum speech length.
 */
export function speechSegments(probs: ArrayLike<number>, samples: number): SpeechSegment[] {
  const segments: SpeechSegment[] = [];
  let triggered = false;
  let start = 0;
  let tempEnd = 0;
  for (let i = 0; i < probs.length; i++) {
    const prob = probs[i]!;
    const at = i * FRAME;
    if (prob >= THRESHOLD && tempEnd !== 0) tempEnd = 0;
    if (prob >= THRESHOLD && !triggered) {
      triggered = true;
      start = at;
      continue;
    }
    if (prob < NEG_THRESHOLD && triggered) {
      if (tempEnd === 0) tempEnd = at;
      if (at - tempEnd < MIN_SILENCE) continue;
      if (tempEnd - start > MIN_SPEECH) segments.push({ start, end: tempEnd });
      triggered = false;
      tempEnd = 0;
    }
  }
  if (triggered && samples - start > MIN_SPEECH) segments.push({ start, end: samples });

  for (let i = 0; i < segments.length; i++) {
    const segment = segments[i]!;
    if (i === 0) segment.start = Math.max(0, segment.start - SPEECH_PAD);
    const next = segments[i + 1];
    if (!next) {
      segment.end = Math.min(samples, segment.end + SPEECH_PAD);
      continue;
    }
    const silence = next.start - segment.end;
    const pad = silence < 2 * SPEECH_PAD ? Math.floor(silence / 2) : SPEECH_PAD;
    segment.end = Math.min(samples, segment.end + pad);
    next.start = Math.max(0, next.start - pad);
  }
  return segments;
}

export type CutCandidate = { cut: number; gapSeconds: number };

/** One candidate in the middle of each pause, lead-in and tail included. */
export function cutCandidates(segments: readonly SpeechSegment[], samples: number): CutCandidate[] {
  const candidates: CutCandidate[] = [];
  let silenceStart = 0;
  for (const { start, end } of [...segments, { start: samples, end: samples }]) {
    if (start > silenceStart) {
      candidates.push({ cut: Math.floor((silenceStart + start) / 2), gapSeconds: (start - silenceStart) / RATE });
    }
    silenceStart = Math.max(silenceStart, end);
  }
  return candidates;
}

/**
 * Greedy, left to right from `from`: each cut is the best-scoring pause
 * 5-40 s after the previous one, preferring long pauses near 30 s, or a hard
 * cut at 40 s when there is none. Audio of 40 s or less is never cut.
 */
export function planCuts(candidates: readonly CutCandidate[], samples: number, from = 0): number[] {
  const cuts: number[] = [];
  let start = from;
  while (samples - start > HARD_MAX) {
    let best: number | undefined;
    let bestScore = -Infinity;
    for (const { cut, gapSeconds } of candidates) {
      if (cut < start + MIN_CHUNK || cut > start + HARD_MAX) continue;
      const position = (cut - start) / RATE;
      const score = Math.min(gapSeconds, 1) - (position > TARGET_SECONDS
        ? 0.1 * (position - TARGET_SECONDS)
        : 0.05 * (TARGET_SECONDS - position));
      if (score > bestScore) {
        best = cut;
        bestScore = score;
      }
    }
    start = best ?? start + HARD_MAX;
    cuts.push(start);
  }
  return cuts;
}

// Scripts written without spaces between words, and CJK punctuation.
const UNSPACED = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Bopomofo}\p{Script=Thai}\p{Script=Lao}\p{Script=Khmer}\p{Script=Myanmar}\u3000-\u303f\uff00-\uffef]/u;

/** Chunk texts in order: a space between two chunks unless either side is unspaced script. */
export function joinTranscripts(texts: readonly string[]): string {
  let joined = "";
  for (const raw of texts) {
    const text = raw.trim();
    if (!text) continue;
    if (joined && !UNSPACED.test(joined.at(-1)!) && !UNSPACED.test(String.fromCodePoint(text.codePointAt(0)!))) {
      joined += " ";
    }
    joined += text;
  }
  return joined;
}

/** Decodes one chunk; `clip` is all audio so far, for choosing a language. */
export type ChunkDecoder = (chunk: Float32Array, clip: Float32Array) => Promise<string>;

/**
 * Buffers audio and its Silero probabilities and decodes it in chunks, in
 * order, one at a time. Pushed live, each chunk is decoded as soon as its cut
 * is certain; `finish` cuts and decodes the rest. Pushed all at once, the
 * cuts are exactly the offline plan's.
 */
export class ChunkedTranscriber {
  private audio: Float32Array = new Float32Array(0);
  private length = 0;
  private readonly probs: number[] = [];
  /** False once audio arrives without probabilities: no more cuts. */
  private scored = true;
  private start = 0;
  private readonly texts: string[] = [];
  private decoding: Promise<void> = Promise.resolve();
  private failure: { error: unknown } | undefined;

  constructor(private readonly decode: ChunkDecoder) {}

  get samples(): number { return this.length; }

  /** `probs` scores each whole 512-sample frame of `pcm`, in order. */
  push(pcm: Float32Array, probs?: readonly number[]): void {
    if (pcm.length === 0) return;
    this.trackScores(pcm.length, probs);
    this.append(pcm);
    while (this.scored && this.length - this.start > HARD_MAX + LOOKAHEAD) {
      this.commit(planCuts(this.candidates(), this.length, this.start)[0]!);
    }
  }

  /** The joined transcript, once every chunk is decoded. */
  async finish(): Promise<string> {
    const samples = this.length;
    if (!this.scored && samples - this.start > HARD_MAX) {
      log.info(`no voice activity for the last ${seconds(samples - this.start)} s; decoding it in one piece`);
    }
    const cuts = this.scored ? planCuts(this.candidates(), samples, this.start) : [];
    for (const cut of cuts) this.commit(cut);
    // An empty clip still reaches the decoder, which rejects it.
    if (samples > this.start || this.texts.length === 0) this.commit(samples);
    await this.decoding;
    if (this.failure) throw this.failure.error;
    if (this.texts.length > 1) log.info(`decoded ${seconds(samples)} s in ${this.texts.length} chunks`);
    return joinTranscripts(this.texts);
  }

  /** Settles once no chunk is decoding; never rejects. */
  idle(): Promise<void> {
    return this.decoding;
  }

  private trackScores(samples: number, probs: readonly number[] | undefined): void {
    if (!this.scored) return;
    const aligned = this.length % FRAME === 0 && probs !== undefined &&
      (probs.length === Math.floor(samples / FRAME) || probs.length === Math.ceil(samples / FRAME));
    if (aligned) {
      for (const prob of probs) this.probs.push(prob);
      return;
    }
    this.scored = false;
    log.debug(`voice activity missing after ${seconds(this.length)} s; no more chunk cuts`);
  }

  private candidates(): CutCandidate[] {
    return cutCandidates(speechSegments(this.probs, this.length), this.length);
  }

  private append(pcm: Float32Array): void {
    if (this.length === 0 && this.audio.length === 0) {
      this.audio = pcm; // One push of a whole clip is never copied.
      this.length = pcm.length;
      return;
    }
    if (this.length + pcm.length > this.audio.length) {
      const grown = new Float32Array(Math.max(this.length + pcm.length, this.audio.length * 2, RATE * 60));
      grown.set(this.audio.subarray(0, this.length));
      this.audio = grown;
    }
    this.audio.set(pcm, this.length);
    this.length += pcm.length;
  }

  private commit(end: number): void {
    const index = this.texts.length;
    const chunk = this.audio.subarray(this.start, end);
    const clip = this.audio.subarray(0, this.length);
    log.debug(`chunk ${index + 1}: ${seconds(this.start)}-${seconds(end)} s`);
    this.start = end;
    this.texts.push("");
    this.decoding = this.decoding.then(async () => {
      if (this.failure) return;
      try {
        this.texts[index] = await this.decode(chunk, clip);
      } catch (error) {
        this.failure = { error };
      }
    });
  }
}

/** Dictation through a ChunkedTranscriber: chunks decode while the user speaks. */
export class ChunkedDictationStream implements DictationStream {
  private readonly transcriber: ChunkedTranscriber;
  private closed = false;

  constructor(decode: ChunkDecoder, private readonly abort: () => void) {
    this.transcriber = new ChunkedTranscriber(decode);
  }

  async feed(chunk: Float32Array, probs?: readonly number[]): Promise<void> {
    if (this.closed) throw new Error("Dictation stream is closed");
    this.transcriber.push(chunk, probs);
  }

  async finalize(audio?: Float32Array): Promise<string> {
    if (this.closed) throw new Error("Dictation stream is closed");
    this.closed = true;
    // A feed that failed upstream: the batch path has the whole take.
    if (audio && audio.length !== this.transcriber.samples) {
      throw new Error(`the stream got ${this.transcriber.samples} of ${audio.length} samples`);
    }
    return this.transcriber.finish();
  }

  reset(): void {
    this.closed = true;
    this.abort();
  }

  /** Settles once no chunk is decoding, so the model is free. */
  idle(): Promise<void> {
    return this.transcriber.idle();
  }
}

function seconds(samples: number): string {
  return (samples / RATE).toFixed(1);
}
