export type VocabularyRefreshRequest = Readonly<{
  input: string;
  userTurns: number;
  generation: number;
}>;
type RefreshDecision = { kind: "idle" } | { kind: "wait"; delayMs: number }
  | { kind: "start"; request: VocabularyRefreshRequest };

/** In-memory scheduling policy. Caller owns timers, extraction and result storage. */
export class VocabularyRefresh {
  private generation = 0;
  private userTurns = 0;
  private successfulTurn: number | undefined;
  private busy = true;
  private input = "";
  private attemptedInput: string | undefined;
  private lastStarted = -Infinity;
  private active: VocabularyRefreshRequest | undefined;

  /** Call once per accepted user message, not per tool/model turn. */
  userMessage(): void {
    this.userTurns++;
    this.agentStarted();
  }

  agentStarted(): void { this.busy = true; }

  /** Supply the latest filtered window only after agent_settled. */
  settled(input: string): void {
    this.busy = false;
    this.input = input;
  }

  /** Recheck after settling, completion, or a cooldown timer; use a monotonic clock. */
  take(now: number): RefreshDecision {
    if (this.busy || this.active || this.userTurns === 0 || !this.input.trim()
      || this.input === this.attemptedInput) return { kind: "idle" };
    if (this.successfulTurn !== undefined && this.userTurns - this.successfulTurn < 2) {
      return { kind: "idle" };
    }
    const delayMs = 30_000 - (now - this.lastStarted);
    if (delayMs > 0) return { kind: "wait", delayMs };
    const request = Object.freeze({ input: this.input, userTurns: this.userTurns, generation: this.generation });
    this.active = request;
    this.attemptedInput = this.input;
    this.lastStarted = now;
    return { kind: "start", request };
  }

  /** True permits publishing this result. Failed identical input is not auto-retried. */
  complete(request: VocabularyRefreshRequest, success: boolean): boolean {
    if (request !== this.active) return false;
    this.active = undefined;
    if (request.generation !== this.generation || !success) return false;
    this.successfulTurn = request.userTurns;
    return true;
  }

  /** Session/branch change: discard context, but retain the in-flight slot and cooldown. */
  reset(): void {
    this.generation++;
    this.userTurns = 0;
    this.successfulTurn = undefined;
    this.busy = true;
    this.input = "";
    this.attemptedInput = undefined;
  }
}
