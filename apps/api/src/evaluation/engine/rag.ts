import { aliasesOf } from './aliases';
import { ParsedCV } from './parser';

/**
 * Retrieval for the LLM step. The CV is split into section-aware chunks; for
 * each requirement we retrieve the top-k chunks by BM25 over the requirement's
 * expanded vocabulary. Only retrieved chunks are sent to the model, which keeps
 * prompts small and forces answers to be grounded in specific passages.
 */
export interface Chunk { id: string; section: string; text: string }

export function chunkCv(cv: ParsedCV, maxChars = 700): Chunk[] {
  const out: Chunk[] = [];
  let n = 0;
  for (const [section, lines] of Object.entries(cv.sections)) {
    let buf = '';
    for (const l of lines) {
      if (buf && buf.length + l.length > maxChars) { out.push({ id: `C${++n}`, section, text: buf.trim() }); buf = ''; }
      buf += l + '\n';
    }
    if (buf.trim()) out.push({ id: `C${++n}`, section, text: buf.trim() });
  }
  return out;
}

const tok = (s: string) => s.toLowerCase().split(/[^a-z0-9+#.]+/).filter((t) => t.length > 1);

export function retrieve(chunks: Chunk[], requirement: string, k = 3): Chunk[] {
  const q = new Set(aliasesOf(requirement).flatMap(tok));
  const docs = chunks.map((c) => tok(c.text));
  const avg = docs.reduce((s, d) => s + d.length, 0) / (docs.length || 1);
  const df = new Map<string, number>();
  docs.forEach((d) => new Set(d).forEach((t) => df.set(t, (df.get(t) ?? 0) + 1)));
  const k1 = 1.4; const b = 0.75; const N = docs.length;
  const scored = chunks.map((c, i) => {
    const d = docs[i]; let s = 0;
    for (const t of q) {
      const f = d.filter((x) => x === t || x.startsWith(t)).length;
      if (!f) continue;
      const idf = Math.log(1 + (N - (df.get(t) ?? 0) + 0.5) / ((df.get(t) ?? 0) + 0.5));
      s += idf * ((f * (k1 + 1)) / (f + k1 * (1 - b + (b * d.length) / avg)));
    }
    // experience and skills sections are where evidence normally lives
    if (s > 0 && /experience|skills|certifications/.test(c.section)) s *= 1.15;
    return { c, s };
  });
  const hits = scored.filter((x) => x.s > 0).sort((a, b) => b.s - a.s).slice(0, k).map((x) => x.c);
  // Nothing lexical? give the model the experience and skills sections to reason over.
  return hits.length ? hits : chunks.filter((c) => /experience|skills|summary/.test(c.section)).slice(0, k);
}
