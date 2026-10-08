/**
 * Deterministic CV parser. Produces a structured profile from plain CV text.
 * It is intentionally conservative: anything it cannot read with confidence is
 * left out rather than guessed. When an LLM provider is configured, the
 * evaluation service uses the model to fill gaps (e.g. role dates written in
 * unusual formats) — but every model claim is checked against this text.
 */
export interface Role { title: string; organisation: string; start: number; end: number; current: boolean; text: string }
export interface Education { line: string; level: number; year?: number }
export interface ParsedCV {
  name: string;
  email: string;
  phone: string;
  location: string;
  summary: string;
  roles: Role[];
  education: Education[];
  highestLevel: number;
  certifications: string[];
  skills: string[];
  languages: string[];
  memberships: string[];
  awards: string[];
  publications: string[];
  projects: string[];
  totalYears: number;
  sections: Record<string, string[]>;
  lines: string[];
  lower: string;
}

const MON: Record<string, number> = { jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5, jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11 };
const M = '(jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\\.?';
// "Jan 2019 – Present", "01/2019 - 12/2021", "2016 to 2019", "March 2019 to date"
export const RANGE = new RegExp(
  `(?:\\b${M}\\s+|\\b(\\d{1,2})[/.-])?((?:19|20)\\d{2})\\s*(?:-|–|—|to|until)\\s*(?:\\b${M}\\s+|\\b(\\d{1,2})[/.-])?((?:19|20)\\d{2}|present|current|date|now|ongoing)`, 'i');

export const DEGREES: [number, RegExp][] = [
  [5, /\b(ph\.?\s?d|doctorate|dphil|d\.phil)\b/i],
  [4, /\b(m\.?\s?sc|m\.?\s?a\b|mba|mph|m\.?\s?eng|m\.?\s?tech|master'?s?|llm)\b/i],
  [3.5, /\b(pgd|pgde|post\s?graduate diploma)\b/i],
  [3, /\b(b\.?\s?sc|b\.?\s?eng|b\.?\s?tech|b\.?\s?a\b|b\.?\s?ed|llb|mbbs|bachelor'?s?|hnd|higher national diploma)\b/i],
  [2, /\b(ond|national diploma|\bnd\b|diploma)\b/i],
  [1, /\b(ssce|waec|neco|o'?\s?level|secondary school)\b/i],
];

const HEADINGS: [string, RegExp][] = [
  ['experience', /^(professional |work |employment |career |relevant )?(experience|employment history|work history|career history|employment)\b/i],
  ['education', /^(education|academic (background|qualifications)|qualifications|education (and|&) training)\b/i],
  ['certifications', /^(certifications?|professional certifications?|licen[cs]es|certificates)\b/i],
  ['skills', /^(skills|technical skills|core (skills|competenc\w*)|key skills|competenc\w*|technical competenc\w*)\b/i],
  ['summary', /^(profile|summary|professional summary|career objective|objective|about me|personal statement)\b/i],
  ['projects', /^(projects|key projects|selected projects)\b/i],
  ['awards', /^(awards|honou?rs|achievements)\b/i],
  ['publications', /^(publications|research)\b/i],
  ['memberships', /^(professional )?(memberships|affiliations|associations)\b/i],
  ['languages', /^languages\b/i],
  ['referees', /^(referees|references)\b/i],
  ['personal', /^(personal (details|information|data))\b/i],
];

export function seniority(title: string): number {
  const t = title.toLowerCase();
  if (/\b(head|director|chief|vp|vice president)\b/.test(t)) return 5;
  if (/\b(manager|lead|principal|coordinator)\b/.test(t)) return 4;
  if (/\b(senior|sr\.?)\b/.test(t)) return 3;
  if (/\b(intern|trainee|industrial|nysc|volunteer)\b/.test(t)) return 0;
  if (/\b(assistant|associate|support|technician|help ?desk|clerk)\b/.test(t)) return 1;
  return 2;
}

export function mergedYears(ranges: { start: number; end: number }[]): number {
  const iv = ranges.filter((r) => r.end > r.start).map((r) => [r.start, r.end]).sort((a, b) => a[0] - b[0]);
  let sum = 0; let cs: number | null = null; let ce = 0;
  for (const [a, b] of iv) {
    if (cs === null) { cs = a; ce = b; } else if (a <= ce) ce = Math.max(ce, b); else { sum += ce - cs; cs = a; ce = b; }
  }
  if (cs !== null) sum += ce - cs;
  return Math.round(sum * 10) / 10;
}

function parseRange(line: string, now: Date) {
  const m = line.match(RANGE);
  if (!m) return null;
  const sy = +m[3];
  const sm = m[1] ? MON[m[1].toLowerCase().slice(0, 3)] : m[2] ? Math.max(0, Math.min(11, +m[2] - 1)) : 0;
  const endTok = m[6].toLowerCase();
  let ey: number; let em: number; let current = false;
  if (/present|current|date|now|ongoing/.test(endTok)) { ey = now.getFullYear(); em = now.getMonth(); current = true; }
  else { ey = +m[6]; em = m[4] ? MON[m[4].toLowerCase().slice(0, 3)] : m[5] ? Math.max(0, Math.min(11, +m[5] - 1)) : 11; }
  return { start: sy + sm / 12, end: ey + (em + 1) / 12, current, match: m[0] };
}

function splitTitleOrg(s: string) {
  const parts = s.split(/\s+(?:—|–|-|\||@|,| at )\s+/).map((x) => x.trim()).filter(Boolean);
  return { title: parts[0] ?? s, organisation: parts.slice(1).join(', ') };
}

export function parseCV(raw: string, now = new Date()): ParsedCV {
  const text = raw.replace(/\r/g, '');
  const lines = text.split('\n').map((l) => l.replace(/^[•\-*·▪●]\s*/, '').trim()).filter(Boolean);
  const email = (text.match(/[\w.+-]+@[\w-]+\.[\w.-]+/) || [''])[0];
  const head = lines.slice(0, 8).join('\n');
  const phone = (head.match(/(\+?\d{1,3}[\s-]?)?\(?\d{3,4}\)?[\s-]?\d{3}[\s-]?\d{3,4}/) || [''])[0].trim();
  const name = lines.slice(0, 6).find((l) => /^[A-Za-z][A-Za-z.'-]+(\s+[A-Za-z][A-Za-z.'-]+){1,4}$/.test(l)
    && !/curriculum|resume|vitae|profile|summary|contact/i.test(l)) ?? 'Unnamed candidate';
  const location = (lines.slice(0, 6).find((l) => l.includes('|') || /nigeria|lagos|abuja/i.test(l)) ?? '').split('|')[0].trim();

  const sections: Record<string, string[]> = { header: [] };
  let cur = 'header';
  for (const l of lines) {
    const h = l.length < 50 ? HEADINGS.find(([, re]) => re.test(l.replace(/[:\s]+$/, ''))) : undefined;
    if (h) { cur = h[0]; sections[cur] = sections[cur] ?? []; continue; }
    sections[cur].push(l);
  }

  // Employment history
  const expLines = sections.experience?.length
    ? sections.experience
    : lines.filter((l) => !DEGREES.some(([, re]) => re.test(l)));
  const roles: Role[] = [];
  let prevLine = '';
  for (const l of expLines) {
    const r = parseRange(l, now);
    if (r) {
      let head = l.replace(r.match, '').replace(/[|,–—(\-\s]+$/, '').replace(/^[|,–—)\-\s]+/, '').trim();
      // Date on its own line → the title is usually the line above
      if (head.length < 3 && prevLine) { head = prevLine; }
      const { title, organisation } = splitTitleOrg(head);
      roles.push({ title, organisation, start: r.start, end: r.end, current: r.current, text: l });
    } else if (roles.length) roles[roles.length - 1].text += '\n' + l;
    prevLine = l;
  }

  let totalYears = mergedYears(roles);
  if (!roles.length) {
    const m = text.match(/(\d{1,2})\+?\s*(?:years|yrs)(?:'|’)?\s*(?:of\s+)?(?:professional\s+|work\s+)?experience/i);
    if (m) totalYears = +m[1];
  }

  // Education
  const eduLines = sections.education?.length ? sections.education : lines;
  const education: Education[] = [];
  for (const l of eduLines) {
    const d = DEGREES.find(([, re]) => re.test(l));
    if (d) education.push({ line: l, level: d[0], year: +(l.match(/(19|20)\d{2}/)?.[0] ?? 0) || undefined });
  }
  const highestLevel = education.reduce((m, e) => Math.max(m, e.level), 0);

  const listOf = (k: string) => (sections[k] ?? []).flatMap((l) => (k === 'skills' ? l.split(/[,;|]/) : [l])).map((s) => s.replace(/^[^:]{0,25}:\s*/, (x) => (k === 'skills' ? '' : x)).trim()).filter((s) => s.length > 1);

  return {
    name, email, phone, location,
    summary: (sections.summary ?? []).join(' ').slice(0, 600) || (lines.find((l) => l.length > 90) ?? '').slice(0, 400),
    roles: roles.sort((a, b) => a.start - b.start),
    education, highestLevel,
    certifications: listOf('certifications'),
    skills: listOf('skills'),
    languages: listOf('languages'),
    memberships: listOf('memberships'),
    awards: listOf('awards'),
    publications: listOf('publications'),
    projects: listOf('projects'),
    totalYears, sections, lines, lower: text.toLowerCase(),
  };
}

/** Non-contact profile persisted on the candidate row (no email/phone). */
export function publicProfile(p: ParsedCV) {
  return {
    summary: p.summary, location: p.location, totalYears: p.totalYears, highestLevel: p.highestLevel,
    roles: p.roles.map(({ text, ...r }) => r), education: p.education, certifications: p.certifications,
    skills: p.skills, languages: p.languages, memberships: p.memberships, awards: p.awards,
    publications: p.publications, projects: p.projects,
  };
}
