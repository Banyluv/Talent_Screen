import OpenAI, { AzureOpenAI } from 'openai';
import { config } from '../../config';
import { RequirementCheck } from '../../common/types';
import { Chunk, retrieve } from './rag';
import { ModelVerdict } from './scorer';
import { Role } from './parser';

export type Provider = 'rules' | 'azure-openai' | 'openai';

export interface LlmOutcome {
  verdicts: Map<string, ModelVerdict>;
  roles: Role[];
  narrative?: string;
  discarded: { requirement: string; claimed: string }[];
  model: string;
}

export function providerReady(p: Provider): { ok: boolean; reason?: string } {
  if (p === 'rules') return { ok: true };
  if (p === 'azure-openai') {
    const a = config.ai.azure;
    return a.endpoint && a.apiKey && a.deployment ? { ok: true } : { ok: false, reason: 'Set AZURE_OPENAI_ENDPOINT, AZURE_OPENAI_API_KEY and AZURE_OPENAI_DEPLOYMENT' };
  }
  return config.ai.openai.apiKey ? { ok: true } : { ok: false, reason: 'Set OPENAI_API_KEY' };
}

function client(p: Provider): { c: OpenAI; model: string } {
  if (p === 'azure-openai') {
    const a = config.ai.azure;
    return { c: new AzureOpenAI({ endpoint: a.endpoint, apiKey: a.apiKey, deployment: a.deployment, apiVersion: a.apiVersion, timeout: config.ai.timeoutMs }), model: a.deployment };
  }
  const o = config.ai.openai;
  return { c: new OpenAI({ apiKey: o.apiKey, baseURL: o.baseUrl, timeout: config.ai.timeoutMs }), model: o.model };
}

/** Redact contact details and the candidate's name before text leaves the system. */
export function redact(text: string, name: string): string {
  let t = text
    .replace(/[\w.+-]+@[\w-]+\.[\w.-]+/g, '[EMAIL]')
    .replace(/(\+?\d{1,3}[\s-]?)?\(?\d{3,4}\)?[\s-]?\d{3}[\s-]?\d{3,4}/g, '[PHONE]')
    .replace(/linkedin\.com\/[^\s]+/gi, '[URL]');
  for (const part of name.split(/\s+/).filter((p) => p.length > 2)) {
    t = t.replace(new RegExp(`\\b${part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'gi'), '[CANDIDATE]');
  }
  return t;
}

const norm = (s: string) => s.toLowerCase().replace(/\[candidate\]|\[email\]|\[phone\]|\[url\]/g, '').replace(/[^a-z0-9]+/g, ' ').trim();

const SYSTEM = `You are an evidence checker in a recruitment decision-support system for a Nigerian health and education NGO.
You verify whether CV passages show evidence for specific job requirements. You never make hiring decisions.
Rules:
- Use ONLY the passages provided. Do not assume, infer from job titles alone, or use outside knowledge.
- For every requirement return met=true only if a passage states it, and copy the supporting sentence VERBATIM (max 200 characters) into "evidence".
- Equivalent wording counts (e.g. "Entra ID" for "Azure AD", "led a team of 6" for "leadership").
- If unsure, met=false.
- Ignore names, gender, age, religion, ethnicity, marital status and state of origin. They are irrelevant.
Respond with JSON only.`;

/**
 * Asks the model to verify only the requirements the rules engine could NOT
 * evidence, plus role dates if none were parsed. Every claimed evidence string
 * must appear in the CV text; claims that don't are discarded and recorded.
 */
export async function runLlm(opts: {
  provider: Provider; temperature: number; cvText: string; candidateName: string; chunks: Chunk[];
  unresolved: Pick<RequirementCheck, 'category' | 'requirement'>[]; needRoles: boolean; jobTitle: string; redactPii: boolean;
}): Promise<LlmOutcome> {
  const { c, model } = client(opts.provider);
  const red = (s: string) => (opts.redactPii ? redact(s, opts.candidateName) : s);
  const used = new Map<string, Chunk>();
  const reqs = opts.unresolved.map((r, i) => {
    const hits = retrieve(opts.chunks, r.requirement, 3);
    hits.forEach((h) => used.set(h.id, h));
    return { id: `R${i + 1}`, category: r.category, requirement: r.requirement, passages: hits.map((h) => h.id) };
  });
  if (opts.needRoles) opts.chunks.filter((c) => c.section === 'experience' || c.section === 'header').forEach((c) => used.set(c.id, c));

  const passages = [...used.values()].map((p) => `[${p.id}] (${p.section})\n${red(p.text)}`).join('\n\n');
  const user = {
    job_title: opts.jobTitle,
    requirements: reqs.map(({ id, category, requirement, passages }) => ({ id, category, requirement, check_passages: passages })),
    extract_roles: opts.needRoles,
    output_schema: {
      requirements: [{ id: 'R1', met: 'boolean', evidence: 'verbatim sentence or empty' }],
      roles: opts.needRoles ? [{ title: 'string', organisation: 'string', start: 'YYYY-MM', end: 'YYYY-MM or present' }] : [],
    },
  };

  const res = await c.chat.completions.create({
    model, temperature: opts.temperature, response_format: { type: 'json_object' },
    messages: [{ role: 'system', content: SYSTEM }, { role: 'user', content: `PASSAGES\n${passages}\n\nTASK\n${JSON.stringify(user)}` }],
  });
  const parsed = JSON.parse(res.choices[0]?.message?.content || '{}');

  const cvNorm = norm(opts.cvText);
  const verdicts = new Map<string, ModelVerdict>();
  const discarded: LlmOutcome['discarded'] = [];
  for (const r of parsed.requirements ?? []) {
    const def = reqs.find((x) => x.id === r.id);
    if (!def) continue;
    const ev = String(r.evidence ?? '').trim();
    // The quote must exist verbatim in a passage retrieved FOR THIS requirement, not just anywhere in the CV.
    const own = def.passages.map((id) => norm(used.get(id)?.text ?? '')).join(' ');
    const grounded = ev.length >= 8 && cvNorm.includes(norm(ev)) && own.includes(norm(ev));
    if (r.met && !grounded) discarded.push({ requirement: def.requirement, claimed: ev.slice(0, 200) });
    verdicts.set(`${def.category}::${def.requirement}`, { met: !!r.met && grounded, evidence: grounded ? ev.slice(0, 200) : undefined });
  }

  const now = new Date();
  const ym = (s: string, end = false) => {
    if (!s) return NaN;
    if (/present|current|now/i.test(s)) return now.getFullYear() + (now.getMonth() + (end ? 1 : 0)) / 12;
    const m = s.match(/((?:19|20)\d{2})(?:-(\d{1,2}))?/);
    return m ? +m[1] + ((m[2] ? +m[2] - 1 : end ? 11 : 0) + (end ? 1 : 0)) / 12 : NaN;
  };
  const roles: Role[] = (parsed.roles ?? []).map((r: any) => ({
    title: String(r.title ?? ''), organisation: String(r.organisation ?? ''), start: ym(r.start), end: ym(r.end, true),
    current: /present|current|now/i.test(String(r.end)), text: `${r.title} — ${r.organisation}`,
  })).filter((r: Role) => Number.isFinite(r.start) && Number.isFinite(r.end) && r.end > r.start
    && cvNorm.includes(norm(r.title).split(' ').slice(0, 2).join(' '))); // title must appear in the CV

  return { verdicts, roles, discarded, model };
}

/** A short narrative summary written strictly from the computed facts. */
export async function runNarrative(provider: Provider, temperature: number, facts: Record<string, unknown>): Promise<string> {
  const { c, model } = client(provider);
  const res = await c.chat.completions.create({
    model, temperature,
    messages: [
      { role: 'system', content: 'Write a 3-sentence, neutral assessment for a recruiter using ONLY the JSON facts given. No new facts, no superlatives, no hiring decision. Plain British English.' },
      { role: 'user', content: JSON.stringify(facts) },
    ],
  });
  return (res.choices[0]?.message?.content ?? '').trim().slice(0, 1200);
}
