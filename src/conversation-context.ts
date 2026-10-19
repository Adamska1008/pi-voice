export type VoiceContextMessage = {
  role: string;
  content: string | readonly { type: string; text?: string }[];
  stopReason?: string;
};
type Turn = { user: string; assistant: string };
type TokenCounter = (text: string) => number;

/** Drop fenced blocks, including unfinished ones; keep inline identifiers. */
function prose(message: VoiceContextMessage): string {
  const text = typeof message.content === "string" ? message.content
    : message.content.filter(part => part.type === "text").map(part => part.text ?? "").join("\n");
  let fence = "";
  const lines: string[] = [];
  for (const line of text.split(/\r?\n/)) {
    const match = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
    if (!fence && match) { fence = match[1]!; continue; }
    if (fence) {
      if (match && match[1]![0] === fence[0] && match[1]!.length >= fence.length && !match[2]!.trim()) fence = "";
      continue;
    }
    lines.push(line);
  }
  return lines.join("\n").trim();
}

function render({ user, assistant }: Turn): string {
  return [user && `用户：${user}`, assistant && `助手：${assistant}`].filter(Boolean).join("\n\n");
}

/** Prefer sentence/paragraph edges, falling back to Unicode code-point edges. */
function shorten(text: string, fits: (candidate: string) => boolean): string {
  if (fits(text)) return text;
  const chars = Array.from(text);
  let low = 1, high = chars.length - 1, best = "";
  while (low <= high) {
    const kept = Math.floor((low + high) / 2);
    let head = chars.slice(0, Math.ceil(kept / 2)).join("");
    let tail = chars.slice(chars.length - Math.floor(kept / 2)).join("");
    head = head.match(/^[\s\S]*[。！？\n]|^[\s\S]*[.!?]\s/)?.[0] ?? head;
    tail = tail.replace(/^[\s\S]*?[。！？\n]|^[\s\S]*?[.!?]\s/, "") || tail;
    const candidate = `${head.trimEnd()}\n[中间省略]\n${tail.trimStart()}`;
    // Token counts need not be monotone: retain only candidates actually checked.
    if (fits(candidate)) { best = candidate; low = kept + 1; }
    else high = kept - 1;
  }
  return best;
}

/** Caller supplies completed messages from the current branch and the ASR tokenizer. */
export function buildRecentVoiceContext(
  messages: readonly VoiceContextMessage[],
  countTokens: TokenCounter,
  maxTokens = 1024,
): string {
  if (!Number.isFinite(maxTokens) || maxTokens < 1) return "";
  const budget = Math.floor(maxTokens);
  const turns: Turn[] = [];
  for (const message of messages) {
    if (message.role === "user") turns.push({ user: prose(message), assistant: "" });
    else if (message.role === "assistant" && ["stop", "toolUse"].includes(message.stopReason ?? "")) {
      const turn = turns.at(-1);
      const text = prose(message);
      if (turn && text) turn.assistant = [turn.assistant, text].filter(Boolean).join("\n\n");
    }
  }
  let result = "";
  for (let i = turns.length - 1; i >= 0; i--) {
    const turn = turns[i]!;
    const full = render(turn);
    if (!full) continue;
    const combined = [full, result].filter(Boolean).join("\n\n");
    if (countTokens(combined) <= budget) { result = combined; continue; }
    if (result) break; // Never skip an intervening turn to fit an older one.
    let user = shorten(turn.user, text => countTokens(text) <= Math.min(512, Math.floor(budget / 2)));
    const assistant = shorten(turn.assistant, text => countTokens(render({ user, assistant: text })) <= budget);
    user = shorten(turn.user, text => countTokens(render({ user: text, assistant })) <= budget);
    result = render({ user, assistant });
    break;
  }
  // Includes role labels and omission markers, not just message bodies.
  return countTokens(result) <= budget ? result : "";
}
