import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { conversationProse } from "./conversation-context.js";
import type { VocabularyCache } from "./vocabulary-cache.js";

export const VOCABULARY_STATE_TYPE = "pi-voice-vocabulary";

/** Store source IDs instead of array positions so branch copying cannot change their meaning. */
export function vocabularyState(cache: VocabularyCache, branch: readonly SessionEntry[]) {
  return { version: 1, terms: cache.entries().flatMap(([text, position]) => {
    const entryId = branch[position]?.id;
    return entryId ? [{ text, entryId }] : [];
  }) };
}

export function restoreVocabulary(cache: VocabularyCache, branch: readonly SessionEntry[]): void {
  cache.clear();
  const checkpoint = [...branch].reverse().find(entry => entry.type === "custom" && entry.customType === VOCABULARY_STATE_TYPE);
  const data = checkpoint?.type === "custom" ? checkpoint.data : undefined;
  if (!data || typeof data !== "object" || !("version" in data) || data.version !== 1
    || !("terms" in data) || !Array.isArray(data.terms) || data.terms.length > 128) return;
  const byId = new Map(branch.map((entry, position) => [entry.id, { entry, position }]));
  for (const item of data.terms) {
    if (!item || typeof item !== "object" || typeof item.text !== "string" || typeof item.entryId !== "string"
      || item.text.length < 2 || item.text.length > 128 || item.text.trim() !== item.text || /[\r\n]/.test(item.text)) continue;
    const source = byId.get(item.entryId);
    if (!source || source.entry.type !== "message") continue;
    const message = source.entry.message;
    if (message.role !== "user" && !(message.role === "assistant" && ["stop", "toolUse"].includes(message.stopReason))) continue;
    cache.update([item.text], [{ position: source.position, text: conversationProse(message) }]);
  }
}
