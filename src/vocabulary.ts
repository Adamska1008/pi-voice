import { readFile } from "node:fs/promises";
import { join } from "node:path";

export const MAX_VOCABULARY_TERMS = 64;
export const MAX_VOCABULARY_CHARACTERS = 4096;

export type VocabularySnapshot = {
  terms: readonly string[];
  warning?: string;
};

/** Read only this project's file; each call returns a fresh snapshot. */
export async function readProjectVocabulary(projectDirectory: string): Promise<VocabularySnapshot> {
  const path = join(projectDirectory, ".pi", "voice-vocabulary.json");
  const invalid = (reason: string): VocabularySnapshot => ({
    terms: [],
    warning: `Ignoring vocabulary in ${path}: ${reason}`,
  });

  let source: string;
  try {
    source = await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { terms: [] };
    return invalid("could not read the file.");
  }

  let value: unknown;
  try {
    // PowerShell and Windows editors may save UTF-8 with a BOM.
    value = JSON.parse(source.replace(/^\uFEFF/, ""));
  } catch {
    return invalid("expected valid JSON.");
  }
  if (typeof value !== "object" || value === null || Array.isArray(value) ||
      !("terms" in value) || !Array.isArray(value.terms) ||
      !value.terms.every((term: unknown) => typeof term === "string")) {
    return invalid('expected an object with a "terms" array of strings.');
  }

  // Preserve order, spelling and case; do not invent aliases or split identifiers.
  const terms = [...new Set<string>(value.terms.map((term: string) => term.trim()).filter(Boolean))];
  if (terms.length > MAX_VOCABULARY_TERMS) {
    return invalid(`at most ${MAX_VOCABULARY_TERMS} distinct terms are allowed.`);
  }
  if (terms.reduce((length, term) => length + term.length, 0) > MAX_VOCABULARY_CHARACTERS) {
    return invalid(`terms may contain at most ${MAX_VOCABULARY_CHARACTERS} UTF-16 code units in total.`);
  }
  return { terms };
}
