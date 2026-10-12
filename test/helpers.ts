import type { LangIdResult } from "transcribe-cpp";
import { Deferred } from "../src/deferred.js";

export function deferred(): Deferred {
  return new Deferred();
}

/** A confident two-candidate detector prediction; tweak code/p/allowedMass/margin. */
export function prediction(code = "de", p = 0.9, allowedMass = 0.9, second = 0.1): LangIdResult {
  return {
    code, allowedMass,
    candidates: [
      { index: 0, code, name: code, p, logit: 2 },
      { index: 1, code: code === "en" ? "de" : "en", name: "runner-up", p: second, logit: 0 },
    ],
  };
}

export function ramp(length: number): Float32Array {
  return Float32Array.from({ length }, (_, index) => index);
}

export function nextTurn(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}
