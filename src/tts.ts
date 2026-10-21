/** Backend-neutral complete-audio contract; playback and credentials belong elsewhere. */
export type SpeechRequest = { text: string; voice?: string; signal: AbortSignal };
export type SpeechAudio = { format: "wav"; data: Uint8Array };
export interface SpeechBackend {
  synthesize(request: SpeechRequest): Promise<SpeechAudio>;
}
