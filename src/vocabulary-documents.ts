import { open, realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";

export const DOCUMENT_LIMITS = { linkedFiles: 8, fileBytes: 16 * 1024, totalBytes: 48 * 1024 };
export type VocabularyDocument = { path: string; text: string; truncated: boolean };
export type DocumentCollection = {
  documents: VocabularyDocument[];
  skipped: { path: string; reason: string }[];
};

const labelKey = (label: string) => label.trim().replace(/\s+/g, " ").toLowerCase();
/** Common inline/reference Markdown links; code, images and HTML are not sources. */
function markdownLinks(text: string): string[] {
  const prose = text.replace(/<!--[^]*?-->/g, "").replace(/^\s*(`{3,}|~{3,})[^\n]*\n[^]*?^\s*\1\s*$/gm, "")
    .replace(/`[^`\n]*`/g, "").replace(/!\[[^\]\n]*\](?:\([^\n]*?\)|\[[^\]\n]*\])?/g, "");
  const definitions = new Map<string, string>();
  const body = prose.replace(/^ {0,3}\[([^\]\n]+)\]:\s*(?:<([^>\n]+)>|(\S+))[^\n]*$/gm, (_all, label, angle, bare) => {
    definitions.set(labelKey(label), angle ?? bare);
    return "";
  });
  const links: string[] = [];
  const pattern = /\[([^\]\n]+)\](?:\(\s*(?:<([^>\n]+)>|([^\s)]+))(?:\s+["'][^\n]*?["'])?\s*\)|\[([^\]\n]*)\])?/g;
  for (const match of body.matchAll(pattern)) {
    const target = match[2] ?? match[3] ?? definitions.get(labelKey(match[4] || match[1]!));
    if (target) links.push(target);
  }
  return links;
}

/** UTF-8 prefix bounded in bytes, without splitting a character. */
function prefix(buffer: Buffer, limit: number): string {
  let end = Math.min(buffer.length, limit);
  while (end > 0 && end < buffer.length && (buffer[end]! & 0xc0) === 0x80) end--;
  return new TextDecoder("utf-8", { fatal: true }).decode(buffer.subarray(0, end));
}

/** README.md and its direct local Markdown links only. No network, writes or model calls. */
export async function collectVocabularyDocuments(projectDirectory: string): Promise<DocumentCollection> {
  const result: DocumentCollection = { documents: [], skipped: [] };
  const skip = (path: string, reason: string) => { result.skipped.push({ path, reason }); };
  let root: string;
  try { root = await realpath(projectDirectory); }
  catch { skip("README.md", "unreadable-project"); return result; }
  const seen = new Set<string>();
  let remaining = DOCUMENT_LIMITS.totalBytes;
  async function readDocument(path: string): Promise<VocabularyDocument | undefined> {
    let canonical: string;
    try { canonical = await realpath(resolve(root, path)); }
    catch { skip(path, "unreadable"); return; }
    const local = relative(root, canonical);
    if (local === ".." || local.startsWith(`..${sep}`) || isAbsolute(local)) {
      skip(path, "outside-project"); return;
    }
    if (seen.has(canonical)) return;
    seen.add(canonical);
    if (remaining <= 0) { skip(path, "total-limit"); return; }
    if (result.documents.length >= DOCUMENT_LIMITS.linkedFiles + 1) { skip(path, "file-count-limit"); return; }
    try {
      const file = await open(canonical, "r");
      let buffer: Buffer;
      try {
        if (!(await file.stat()).isFile()) { skip(path, "not-file"); return; }
        buffer = Buffer.alloc(Math.min(DOCUMENT_LIMITS.fileBytes, remaining) + 1);
        const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
        buffer = buffer.subarray(0, bytesRead);
      } finally { await file.close(); }
      if (buffer.includes(0)) { skip(path, "not-text"); return; }
      const limit = Math.min(DOCUMENT_LIMITS.fileBytes, remaining);
      const text = prefix(buffer, limit);
      const document = { path: path.split(sep).join("/"), text, truncated: buffer.length > limit };
      remaining -= Buffer.byteLength(text);
      result.documents.push(document);
      return document;
    } catch { skip(path, "unreadable-or-invalid-utf8"); return; }
  }
  const readme = await readDocument("README.md");
  if (!readme) return result;
  for (const target of markdownLinks(readme.text)) {
    if (target.startsWith("#")) continue;
    if (/^(?:[a-z][a-z\d+.-]*:|[\\/])/i.test(target)) { skip(target, "non-local-link"); continue; }
    let path: string;
    try { path = decodeURIComponent(target.split(/[?#]/, 1)[0]!); }
    catch { skip(target, "invalid-link"); continue; }
    if (isAbsolute(path) || /^[a-z][a-z\d+.-]*:/i.test(path)) { skip(target, "non-local-link"); continue; }
    if (!/\.md(?:own)?$/i.test(path) && !/\.markdown$/i.test(path)) { skip(target, "not-markdown"); continue; }
    await readDocument(path);
  }
  return result;
}
