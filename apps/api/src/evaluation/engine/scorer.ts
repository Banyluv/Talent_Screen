import { JobRequirements, LEVELS, Recommendation, RequirementCheck, ScoringRules, Thresholds, Weights, WEIGHT_KEYS } from '../../common/types';
import { findEvidence, termRegex } from './aliases';
import { mergedYears, ParsedCV, Role, seniority } from './parser';

export interface ModelVerdict { met: boolean; evidence?: string }
export interface ScoreInput {
  cv: ParsedCV;
  jobTitle: string;
  req: JobRequirements;
  weights: Weights;
  thresholds: Thresholds;
  rules: ScoringRules;
  /** Optional verdicts from the LLM, keyed by `${category}::${requirement}`. Already evidence-validated. */
  model?: Map<string, ModelVerdict>;
  /** Optional roles recovered by the LLM when the rules parser found none. */
  modelRoles?: Role[];
}
export interface Item { text: string; why?: string; evidence?: string }
export interface ScoreResult {
  overall: number;
  recommendation: Recommendation;
  components: Record<keyof Weights, number>;
  totalYears: number;
  relevantYears: number;
  qualificationMatch: number;
  skillsMatch: number;
  checks: RequirementCheck[];
  strengths: Item[];
  gaps: Item[];
  hardRuleFailures: string[];
  justification: string;
  roles: Role[];
}

const STOP = new Set(['senior', 'junior', 'officer', 'administrator', 'assistant', 'manager', 'with', 'and', 'the', 'for', 'lead', 'head', 'associate', 'specialist']);
const pct = (a: { met: boolean }[]) => (a.length ? Math.round((100 * a.filter((x) => x.met).length) / a.length) : 100);
const clamp = (n: number) => Math.max(0, Math.min(100, Math.round(n)));

export function score(input: ScoreInput): ScoreResult {
  const { cv, req, weights: w, thresholds: T, rules } = input;
  const roles = cv.roles.length ? cv.roles : input.modelRoles ?? [];
  const totalYears = cv.roles.length ? cv.totalYears : (roles.length ? mergedYears(roles) : cv.totalYears);

  // Quote the most specific line: experience and certification lines before the summary.
  const evLines = [...(cv.sections.experience ?? []), ...(cv.sections.certifications ?? []), ...(cv.sections.skills ?? []), ...cv.lines];
  const check = (category: RequirementCheck['category'], requirement: string): RequirementCheck => {
    const r = findEvidence(cv.lower, evLines, requirement);
    if (r.hit) return { category, requirement, met: true, evidence: r.line, source: 'rules' };
    const m = input.model?.get(`${category}::${requirement}`);
    if (m?.met && m.evidence) return { category, requirement, met: true, evidence: m.evidence, source: 'llm' };
    return { category, requirement, met: false, source: m ? 'llm' : 'rules' };
  };

  const tech = req.technicalSkills.map((s) => check('technical', s));
  const certs = req.requiredCertifications.map((s) => check('certification', s));
  const soft = req.softSkills.map((s) => check('soft', s));
  const prefSkills = req.preferredSkills.map((s) => check('preferred', s));
  const industry = req.industryExperience.map((s) => check('industry', s));
  const mandatory = req.mandatory.map((s) => check('mandatory', s));
  const nice = req.niceToHave.map((s) => check('niceToHave', s));

  // ---- relevant experience: roles that mention ≥2 of the job's skills or share a title keyword
  const skillSet = [...req.technicalSkills, ...req.preferredSkills];
  const titleWords = input.jobTitle.toLowerCase().split(/[^a-z0-9&]+/).filter((x) => x.length > 2 && !STOP.has(x));
  const relevant = roles.filter((role) => {
    const t = (role.title + '\n' + role.text).toLowerCase();
    const n = skillSet.filter((s) => findEvidence(t, [t], s).hit).length;
    return n >= 2 || titleWords.some((x) => termRegex(x).test(role.title));
  });
  const relevantYears = roles.length ? mergedYears(relevant) : totalYears;
  const expYears = rules.experienceBasis === 'total' ? totalYears : relevantYears;

  // ---- qualifications
  const eduText = (cv.sections.education ?? cv.lines).join('\n').toLowerCase();
  const fieldHit = !req.fieldsOfStudy.length || req.fieldsOfStudy.some((f) => termRegex(f).test(eduText));
  const level = cv.highestLevel;
  let qual: number;
  if (level >= req.minQualificationLevel) qual = 70 + (fieldHit ? 30 : 0);
  else qual = (level ? (50 * level) / req.minQualificationLevel : 0) + (fieldHit && level ? 15 : 0);
  const prefQual = req.preferredQualifications.map((q) => check('qualification', q));
  if (prefQual.some((q) => q.met)) qual += 10;
  qual = clamp(qual);

  // ---- experience
  const min = req.minYears; const pref = Math.max(req.preferredYears, min);
  const exp = clamp(expYears >= pref ? 100 : expYears >= min ? 70 + (30 * (expYears - min)) / (pref - min || 1) : (70 * expYears) / (min || 1));

  // ---- career progression & stability
  const sorted = [...roles].sort((a, b) => a.start - b.start);
  const avgTenure = sorted.length ? totalYears / sorted.length : 0;
  let prog = 60;
  if (sorted.length >= 2) {
    const first = seniority(sorted[0].title); const last = seniority(sorted[sorted.length - 1].title);
    prog = 50 + (last > first ? 30 : last === first ? 15 : 0) + (avgTenure >= 1.5 ? 20 : avgTenure >= 1 ? 10 : 0);
  }
  prog = clamp(prog);

  const components: Record<keyof Weights, number> = {
    qualifications: qual,
    technical: pct(tech),
    experience: exp,
    certifications: pct(certs),
    preferred: pct([...soft, ...prefSkills, ...industry, ...nice]),
    progression: prog,
  };
  const wsum = WEIGHT_KEYS.reduce((s, k) => s + (w[k] || 0), 0) || 100;
  const overall = Math.round(WEIGHT_KEYS.reduce((s, k) => s + components[k] * (w[k] || 0), 0) / wsum);

  // ---- hard rules, then thresholds
  const hard: string[] = [];
  const missingMandatory = mandatory.filter((m) => !m.met);
  if (rules.enforceMandatory && missingMandatory.length) hard.push(`Mandatory requirement not evidenced: ${missingMandatory.map((m) => m.requirement).join(', ')}`);
  if (rules.enforceMinExperience && expYears < min) hard.push(`${rules.experienceBasis === 'total' ? 'Total' : 'Relevant'} experience of ${expYears} years is below the ${min}-year minimum`);
  const recommendation: Recommendation = hard.length ? 'Reject'
    : overall >= T.shortlist ? 'Shortlist' : overall >= T.consider ? 'Consider' : overall >= T.hold ? 'Hold' : 'Reject';

  // ---- strengths and gaps (each strength carries CV evidence)
  const strengths: Item[] = []; const gaps: Item[] = [];
  const lvlName = (n: number) => LEVELS[n] ?? 'Unrecognised';
  if (level >= req.minQualificationLevel) {
    const best = cv.education.find((e) => e.level === level);
    strengths.push({ text: `${lvlName(level)}${fieldHit && req.fieldsOfStudy.length ? ' in a relevant field' : ''} (minimum: ${lvlName(req.minQualificationLevel)})`, evidence: best?.line });
    if (!fieldHit) gaps.push({ text: `Field of study does not match: ${req.fieldsOfStudy.join(', ')}` });
  } else {
    gaps.push({ text: level ? `Highest qualification (${lvlName(level)}) is below the required ${lvlName(req.minQualificationLevel)}` : 'No recognisable academic qualification found' });
  }
  if (expYears >= min) strengths.push({ text: `${expYears} years ${rules.experienceBasis} experience (minimum ${min}, preferred ${pref})` });
  else gaps.push({ text: `${expYears} years ${rules.experienceBasis} experience against a ${min}-year minimum` });
  tech.filter((c) => c.met).forEach((c) => strengths.push({ text: `Evidence of ${c.requirement}`, evidence: c.evidence }));
  certs.filter((c) => c.met).forEach((c) => strengths.push({ text: `Holds ${c.requirement}`, evidence: c.evidence }));
  industry.filter((c) => c.met).slice(0, 2).forEach((c) => strengths.push({ text: `Sector experience: ${c.requirement}`, evidence: c.evidence }));
  if (sorted.length >= 2 && seniority(sorted[sorted.length - 1].title) > seniority(sorted[0].title)) {
    strengths.push({ text: 'Clear upward career progression', evidence: `${sorted[0].title} → ${sorted[sorted.length - 1].title}` });
  }
  mandatory.filter((c) => !c.met).forEach((c) => gaps.push({ text: `Mandatory: no evidence of ${c.requirement}` }));
  tech.filter((c) => !c.met && !req.mandatory.includes(c.requirement)).forEach((c) => gaps.push({ text: `No evidence of ${c.requirement}` }));
  certs.filter((c) => !c.met).forEach((c) => gaps.push({ text: `Certification not listed: ${c.requirement}` }));
  if (sorted.length >= 3 && avgTenure < 1.2) gaps.push({ text: `Short average tenure (${avgTenure.toFixed(1)} years per role)` });
  if (!roles.length) gaps.push({ text: 'Employment dates could not be read; experience was estimated' });

  const aiMatched = [...mandatory, ...tech, ...certs].filter((c) => c.met && c.source === 'llm');
  if (aiMatched.length) {
    gaps.push({ text: `Confirm AI-matched evidence for: ${aiMatched.map((c) => c.requirement).join(', ')}`, why: 'Matched by the language model, not by an exact keyword. The quoted line is real but its relevance needs a human check.' });
  }
  const just = hard.length
    ? `${hard.join('. ')}. Weighted score was ${overall}/100 before the rule was applied.`
    : `${overall}/100 weighted score: ${components.technical}% of required technical skills evidenced, ${expYears} years ${rules.experienceBasis} experience against a ${min}-year minimum, ${components.certifications}% of required certifications. `
      + ({ Shortlist: 'Strong fit; recommend for interview.', Consider: 'Partial fit; review the gaps before deciding.', Hold: 'Below target; keep on file if the pool is thin.', Reject: 'Below the hold threshold.' } as const)[recommendation];

  return {
    overall, recommendation, components, totalYears, relevantYears: Math.round(relevantYears * 10) / 10,
    qualificationMatch: qual, skillsMatch: components.technical,
    checks: [...mandatory, ...tech, ...certs, ...soft, ...prefSkills, ...industry, ...nice, ...prefQual],
    strengths, gaps, hardRuleFailures: hard, justification: just, roles: sorted,
  };
}
