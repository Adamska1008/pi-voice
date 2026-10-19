export type VocabularyObservation = Readonly<{ position: number; text: string }>;

/** Match exact spelling without treating Pi in Pipeline as a mention; allow Chinese adjacency. */
function mentions(text: string, term: string): boolean {
  for (let at = text.indexOf(term); at >= 0; at = text.indexOf(term, at + 1)) {
    const before = text[at - 1] ?? "", after = text[at + term.length] ?? "";
    if (/[A-Za-z0-9_$]/.test(term[0]!) && /[A-Za-z0-9_$]/.test(before)) continue;
    if (/[A-Za-z0-9_$]/.test(term.at(-1)!) && /[A-Za-z0-9_$]/.test(after)) continue;
    return true;
  }
  return false;
}

/** Conversation tier of the vocabulary cache. Positions are stable current-branch entry indices. */
export class VocabularyCache {
  private seen = new Map<string, number>();
  constructor(private readonly capacity = 128) {
    if (!Number.isInteger(capacity) || capacity < 1) throw new Error("Invalid vocabulary capacity");
  }

  update(candidates: readonly string[], observations: readonly VocabularyObservation[]): void {
    for (const term of new Set([...this.seen.keys(), ...candidates])) {
      if (!term || term.length > 128) continue;
      let latest = this.seen.get(term) ?? -1;
      for (const observation of observations) {
        if (observation.position > latest && mentions(observation.text, term)) latest = observation.position;
      }
      if (latest >= 0) this.seen.set(term, latest);
    }
    for (const [term] of this.ordered().slice(this.capacity)) this.seen.delete(term);
  }

  snapshot(): readonly string[] { return Object.freeze(this.ordered().slice(0, 64).map(([term]) => term)); }
  entries(): [string, number][] { return this.ordered(); }
  clear(): void { this.seen.clear(); }
  private ordered(): [string, number][] {
    return [...this.seen].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  }
}
