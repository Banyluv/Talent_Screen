import { describe, expect, it } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import { parseCV, mergedYears } from '../src/evaluation/engine/parser';
import { score } from '../src/evaluation/engine/scorer';
import { aliasesOf, findEvidence } from '../src/evaluation/engine/aliases';
import { chunkCv, retrieve } from '../src/evaluation/engine/rag';
import { redact } from '../src/evaluation/engine/llm';

const NOW = new Date('2026-10-01T00:00:00Z');
const jobs = JSON.parse(readFileSync(join(__dirname, '..', 'seed', 'demo-jobs.json'), 'utf8'));
const cv = (f: string) => parseCV(readFileSync(join(__dirname, '..', 'seed', 'demo-cvs', f), 'utf8'), NOW);
const W = { qualifications: 20, technical: 30, experience: 30, certifications: 10, preferred: 5, progression: 5 };
const T = { shortlist: 85, consider: 65, hold: 50 };
const R = { enforceMinExperience: true, enforceMandatory: true, experienceBasis: 'relevant' as const };
const run = (file: string, job = jobs[0]) => score({ cv: cv(file), jobTitle: job.title, req: job.requirements, weights: W, thresholds: T, rules: R });

describe('parser', () => {
  it('reads name, contacts, roles and education', () => {
    const p = cv('chidinma-okafor.txt');
    expect(p.name).toBe('Chidinma Okafor');
    expect(p.email).toBe('chidinma.okafor@example.com');
    expect(p.roles).toHaveLength(3);
    expect(p.roles[2].current).toBe(true);
    expect(p.highestLevel).toBe(4);
  });
  it('merges overlapping employment periods', () => {
    expect(mergedYears([{ start: 2018, end: 2020 }, { start: 2019, end: 2021 }, { start: 2022, end: 2023 }])).toBe(4);
  });
  it('understands numeric month ranges', () => {
    const p = parseCV('Jane Doe\nEXPERIENCE\nAnalyst — Org | 03/2019 - 08/2021\nEDUCATION\nBSc Statistics 2018', NOW);
    expect(p.roles[0].start).toBeCloseTo(2019 + 2 / 12);
    expect(p.totalYears).toBeCloseTo(2.5, 1);
  });
});

describe('aliases', () => {
  it('expands certification codes and alternatives', () => {
    expect(aliasesOf('Azure Administrator (AZ-104)')).toEqual(expect.arrayContaining(['az-104', 'azure administrator']));
    expect(aliasesOf('Stata / SPSS')).toEqual(expect.arrayContaining(['stata', 'spss']));
  });
  it('does not match short terms inside words', () => {
    expect(findEvidence('language skills', ['language skills'], 'LAN').hit).toBe(false);
    expect(findEvidence('configured vlan trunks', ['configured vlan trunks'], 'Networking').hit).toBe(true);
  });
});

describe('scorer', () => {
  it('shortlists a strong, evidenced candidate', () => {
    const r = run('chidinma-okafor.txt');
    expect(r.recommendation).toBe('Shortlist');
    expect(r.overall).toBeGreaterThanOrEqual(85);
    expect(r.strengths.filter((s) => s.text.startsWith('Evidence of')).every((s) => s.evidence)).toBe(true);
  });
  it('rejects when a mandatory requirement is missing, and says why', () => {
    const r = run('grace-udoh.txt');
    expect(r.recommendation).toBe('Reject');
    expect(r.hardRuleFailures[0]).toMatch(/Mandatory requirement not evidenced: Azure/);
  });
  it('rejects below minimum relevant experience', () => {
    const r = run('blessing-akpan.txt', jobs[1]);
    expect(r.recommendation).toBe('Reject');
    expect(r.hardRuleFailures.some((h) => /below the 3-year minimum/.test(h))).toBe(true);
  });
  it('can be configured not to auto-reject', () => {
    const r = score({ cv: cv('grace-udoh.txt'), jobTitle: jobs[0].title, req: jobs[0].requirements, weights: W, thresholds: T,
      rules: { ...R, enforceMandatory: false } });
    expect(r.recommendation).not.toBe('Reject');
  });
  it('ignores protected attributes', () => {
    const base = readFileSync(join(__dirname, '..', 'seed', 'demo-cvs', 'amaka-eze.txt'), 'utf8');
    const a = score({ cv: parseCV(base, NOW), jobTitle: jobs[1].title, req: jobs[1].requirements, weights: W, thresholds: T, rules: R });
    const b = score({ cv: parseCV(base.replace('Amaka Eze', 'John Smith') + '\nPERSONAL DETAILS\nGender: Male\nReligion: Christian\nState of origin: Kano\nMarital status: Married', NOW),
      jobTitle: jobs[1].title, req: jobs[1].requirements, weights: W, thresholds: T, rules: R });
    expect(b.overall).toBe(a.overall);
  });
  it('accepts model verdicts only with evidence', () => {
    const job = jobs[0];
    const model = new Map([['technical::Intune', { met: true, evidence: 'Deployed Intune to 300 devices' }], ['technical::Microsoft Defender', { met: true }]]);
    const r = score({ cv: cv('grace-udoh.txt'), jobTitle: job.title, req: job.requirements, weights: W, thresholds: T, rules: R, model });
    expect(r.checks.find((c) => c.requirement === 'Intune')).toMatchObject({ met: true, source: 'llm' });
    expect(r.checks.find((c) => c.requirement === 'Microsoft Defender')!.met).toBe(false);
  });
});

describe('RAG and redaction', () => {
  it('retrieves the passage that mentions the requirement', () => {
    const p = cv('amaka-eze.txt');
    const hits = retrieve(chunkCv(p), 'Data quality assessment', 2);
    expect(hits[0].text.toLowerCase()).toContain('data quality');
  });
  it('removes contact details and name before text leaves the system', () => {
    const t = redact('Amaka Eze | amaka.eze@example.com | 0813 555 0129 | Amaka led DQAs', 'Amaka Eze');
    expect(t).not.toMatch(/amaka|example\.com|0813/i);
  });
});
