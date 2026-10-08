import { BadRequestException, Controller, Get, Query, Res } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { Response } from 'express';
import ExcelJS from 'exceljs';
import PDFDocument from 'pdfkit';
import * as path from 'path';
import * as fs from 'fs';
import { Ctx, Me, Perms, hasPerm } from '../common/auth';
import { AuditContext, AuditService } from '../common/audit.service';
import { Db } from '../common/db.service';
import { jobScope } from '../common/access';
import { AuthUser } from '../common/types';

const GREEN = '316C4E'; const CRIMSON = 'B53043';
const REC_FILL: Record<string, string> = { Shortlist: 'E7F0EA', Consider: 'FBF0DC', Hold: 'E6EDF5', Reject: 'F8E6E9' };

@ApiTags('reports')
@Controller()
export class ReportsController {
  constructor(private db: Db, private audit: AuditService) {}

  @Get('dashboard')
  async dashboard(@Me() me: AuthUser) {
    const scope = jobScope(me);
    const k = await this.db.one(
      `SELECT count(*) FILTER (WHERE j.status='open')::int AS open_jobs,
              count(*) FILTER (WHERE j.status='requested')::int AS pending_requests
       FROM jobs j WHERE ${scope}`, [me.id]);
    const c = await this.db.one(
      `SELECT count(c.*)::int AS candidates,
              count(*) FILTER (WHERE COALESCE(o.to_rec, e.recommendation)='Shortlist')::int AS shortlisted,
              count(*) FILTER (WHERE e.status IN ('pending','running'))::int AS evaluating,
              count(*) FILTER (WHERE e.status='completed' AND c.status='screening')::int AS awaiting_review,
              count(*) FILTER (WHERE c.created_at > now() - interval '7 days')::int AS new_this_week
       FROM candidates c JOIN jobs j ON j.id=c.job_id LEFT JOIN evaluations e ON e.candidate_id=c.id AND e.is_current
       LEFT JOIN recommendation_overrides o ON o.candidate_id=c.id AND o.is_active
       WHERE c.erased_at IS NULL AND ${scope}`, [me.id]);
    const myInterviews = await this.db.one(
      `SELECT count(*)::int AS total, count(*) FILTER (WHERE s.id IS NULL AND i.status <> 'cancelled')::int AS to_score
       FROM interview_panelists ip JOIN interviews i ON i.id=ip.interview_id
       LEFT JOIN interview_scores s ON s.interview_id=i.id AND s.panelist_id=ip.user_id WHERE ip.user_id=$1`, [me.id]);
    const upcoming = await this.db.one(`SELECT count(*)::int n FROM interviews i JOIN jobs j ON j.id=i.job_id WHERE i.status='scheduled' AND i.scheduled_at > now() AND ${scope}`, [me.id]);
    const top = hasPerm(me, 'evaluations.view') || hasPerm(me, 'shortlist.review') ? await this.db.many(
      `SELECT * FROM (
         SELECT j.id AS job_id, j.title, c.id, c.full_name, e.overall_score, COALESCE(o.to_rec, e.recommendation) AS recommendation, e.relevant_years,
                row_number() OVER (PARTITION BY j.id ORDER BY e.overall_score DESC) AS rn
         FROM jobs j JOIN candidates c ON c.job_id=j.id AND c.erased_at IS NULL JOIN evaluations e ON e.candidate_id=c.id AND e.is_current AND e.status='completed'
         LEFT JOIN recommendation_overrides o ON o.candidate_id=c.id AND o.is_active
         WHERE j.status='open' AND ${scope}) t WHERE rn <= 3 ORDER BY title, rn`, [me.id]) : [];
    const activity = hasPerm(me, 'audit.view') ? await this.db.many(`SELECT at, actor_email, action, entity_type, details FROM audit_logs WHERE action NOT IN ('candidate.viewed','auth.login') ORDER BY id DESC LIMIT 8`) : [];
    return { ...k, ...c, interviewsUpcoming: upcoming.n, myInterviews, top, activity };
  }

  @Get('reports/summary') @Perms('reports.view')
  async summary(@Me() me: AuthUser, @Query('jobId') jobId?: string) {
    const scope = jobScope(me);
    const p = [me.id, jobId || null];
    const base = `FROM candidates c JOIN jobs j ON j.id=c.job_id JOIN evaluations e ON e.candidate_id=c.id AND e.is_current AND e.status='completed'
                  LEFT JOIN recommendation_overrides o ON o.candidate_id=c.id AND o.is_active
                  WHERE ${scope} AND ($2::uuid IS NULL OR j.id=$2)`;
    const totals = await this.db.one(`SELECT count(*)::int AS evaluated, round(avg(e.overall_score))::int AS avg_score,
        count(*) FILTER (WHERE o.id IS NOT NULL)::int AS overrides,
        count(*) FILTER (WHERE e.engine <> 'rules')::int AS ai_assisted ${base}`, p);
    const byRec = await this.db.many(`SELECT COALESCE(o.to_rec, e.recommendation) AS recommendation, count(*)::int AS n ${base} GROUP BY 1`, p);
    const histogram = await this.db.many(`SELECT LEAST(width_bucket(e.overall_score, 0, 100, 10), 10) AS bucket, count(*)::int AS n ${base} GROUP BY 1 ORDER BY 1`, p);
    const pipeline = await this.db.many(`SELECT c.status, count(*)::int AS n FROM candidates c JOIN jobs j ON j.id=c.job_id
        WHERE c.erased_at IS NULL AND ${scope} AND ($2::uuid IS NULL OR j.id=$2) GROUP BY 1`, p);
    const gaps = await this.db.many(`SELECT regexp_replace(g->>'text', '[0-9]+(\\.[0-9]+)?( years|-year)', '#\\2', 'g') AS gap, count(*)::int AS n
        ${base.replace('WHERE', ', jsonb_array_elements(e.gaps) g WHERE')} GROUP BY 1 ORDER BY 2 DESC LIMIT 8`, p);
    const byJob = await this.db.many(`SELECT j.id, j.title, j.status, count(c.*)::int AS applicants, round(avg(e.overall_score))::int AS avg_score,
        count(*) FILTER (WHERE COALESCE(o.to_rec, e.recommendation)='Shortlist')::int AS shortlisted,
        count(*) FILTER (WHERE c.status='hired')::int AS hired
        FROM jobs j LEFT JOIN candidates c ON c.job_id=j.id AND c.erased_at IS NULL LEFT JOIN evaluations e ON e.candidate_id=c.id AND e.is_current
        LEFT JOIN recommendation_overrides o ON o.candidate_id=c.id AND o.is_active
        WHERE ${scope} AND j.status <> 'requested' AND ($2::uuid IS NULL OR j.id=$2) GROUP BY j.id ORDER BY j.created_at DESC`, p);
    return { totals, byRec, histogram, pipeline, gaps, byJob };
  }

  @Get('reports/export') @Perms('reports.export')
  async export(@Me() me: AuthUser, @Ctx() ctx: AuditContext, @Res() res: Response, @Query('jobId') jobId?: string, @Query('format') format = 'xlsx') {
    if (!['csv', 'xlsx', 'pdf'].includes(format)) throw new BadRequestException('format must be csv, xlsx or pdf');
    const rows = await this.db.many(
      `SELECT j.ref_code, j.title AS vacancy, c.full_name, c.status, e.overall_score, e.total_years, e.relevant_years, e.qualification_match, e.skills_match,
              e.recommendation AS ai_recommendation, COALESCE(o.to_rec, e.recommendation) AS final_recommendation, o.reason AS override_reason,
              e.strengths, e.gaps, e.justification, e.engine, e.completed_at
       FROM candidates c JOIN jobs j ON j.id=c.job_id JOIN evaluations e ON e.candidate_id=c.id AND e.is_current AND e.status='completed'
       LEFT JOIN recommendation_overrides o ON o.candidate_id=c.id AND o.is_active
       WHERE c.erased_at IS NULL AND ${jobScope(me)} AND ($2::uuid IS NULL OR j.id=$2)
       ORDER BY j.title, e.overall_score DESC`, [me.id, jobId || null]);
    // rank within vacancy
    const rankBy: Record<string, number> = {};
    const data = rows.map((r) => ({
      rank: (rankBy[r.vacancy] = (rankBy[r.vacancy] ?? 0) + 1), ...r,
      key_strengths: (r.strengths ?? []).slice(0, 3).map((s: any) => s.text).join('; '),
      key_gaps: (r.gaps ?? []).slice(0, 3).map((g: any) => g.text).join('; '),
    }));
    await this.audit.record(ctx, 'report.exported', 'job', jobId ?? null, { format, rows: data.length });
    const stamp = new Date().toISOString().slice(0, 10);
    const cols: [string, string, number][] = [
      ['rank', 'Rank', 7], ['vacancy', 'Vacancy', 30], ['full_name', 'Candidate', 24], ['overall_score', 'Score', 8], ['total_years', 'Total yrs', 9],
      ['relevant_years', 'Relevant yrs', 11], ['qualification_match', 'Qual. match %', 12], ['skills_match', 'Skills match %', 12],
      ['ai_recommendation', 'AI recommendation', 16], ['final_recommendation', 'Final recommendation', 18], ['override_reason', 'Override reason', 30],
      ['status', 'Status', 12], ['key_strengths', 'Key strengths', 50], ['key_gaps', 'Key gaps', 50], ['justification', 'Justification', 60],
    ];

    if (format === 'csv') {
      const q = (v: unknown) => { const s = v === null || v === undefined ? '' : String(v); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
      const csv = [cols.map((c) => c[1]).join(','), ...data.map((r: any) => cols.map((c) => q(r[c[0]])).join(','))].join('\n');
      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      res.setHeader('Content-Disposition', `attachment; filename="talentscreen-ranking-${stamp}.csv"`);
      return res.send('﻿' + csv);
    }

    if (format === 'xlsx') {
      const wb = new ExcelJS.Workbook();
      wb.creator = 'ECEWS TalentScreen'; wb.created = new Date();
      const ws = wb.addWorksheet('Ranking', { views: [{ state: 'frozen', ySplit: 1 }] });
      ws.columns = cols.map(([key, header, width]) => ({ key, header, width }));
      data.forEach((r) => ws.addRow(r));
      ws.getRow(1).eachCell((c) => { c.font = { bold: true, color: { argb: 'FFFFFFFF' } }; c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF' + GREEN } }; });
      ws.autoFilter = { from: 'A1', to: { row: 1, column: cols.length } };
      ws.eachRow((row, i) => {
        if (i === 1) return;
        row.alignment = { vertical: 'top', wrapText: true };
        const rec = row.getCell('final_recommendation').value as string;
        if (REC_FILL[rec]) row.getCell('final_recommendation').fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF' + REC_FILL[rec] } };
      });
      const about = wb.addWorksheet('About');
      about.addRows([['ECEWS TalentScreen export'], ['Generated', new Date().toISOString()], ['Generated by', me.email], ['Rows', data.length],
        [], ['Recommendations are AI-assisted decision support. Final hiring decisions are made by authorised ECEWS staff.']]);
      res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
      res.setHeader('Content-Disposition', `attachment; filename="talentscreen-ranking-${stamp}.xlsx"`);
      await wb.xlsx.write(res);
      return res.end();
    }

    // PDF
    const doc = new PDFDocument({ size: 'A4', layout: 'landscape', margin: 36, info: { Title: 'TalentScreen ranking', Author: 'ECEWS' } });
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="talentscreen-ranking-${stamp}.pdf"`);
    doc.pipe(res);
    const logo = path.join(__dirname, '..', '..', 'assets', 'ecews-logo.png');
    if (fs.existsSync(logo)) doc.image(logo, 36, 28, { height: 44 });
    doc.fillColor('#' + GREEN).font('Helvetica-Bold').fontSize(16).text('Candidate ranking', 90, 34);
    doc.fillColor('#555').font('Helvetica').fontSize(9).text(`Generated ${new Date().toLocaleString('en-GB', { timeZone: 'Africa/Lagos' })} WAT by ${me.email}`, 90, 54);
    let y = 90;
    let current = '';
    const pcols: [string, string, number][] = [['rank', '#', 22], ['full_name', 'Candidate', 120], ['overall_score', 'Score', 36], ['relevant_years', 'Rel. yrs', 40],
      ['skills_match', 'Skills %', 42], ['final_recommendation', 'Recommendation', 80], ['key_strengths', 'Key strengths', 215], ['key_gaps', 'Key gaps', 215]];
    const header = () => {
      let x = 36; doc.font('Helvetica-Bold').fontSize(8).fillColor('#fff');
      doc.rect(36, y, 770, 16).fill('#' + GREEN); doc.fillColor('#fff');
      for (const [, h, w] of pcols) { doc.text(h, x + 3, y + 4, { width: w - 6 }); x += w; }
      y += 18;
    };
    for (const r of data as any[]) {
      if (r.vacancy !== current) {
        current = r.vacancy;
        if (y > 480) { doc.addPage(); y = 36; }
        doc.font('Helvetica-Bold').fontSize(11).fillColor('#' + CRIMSON).text(`${r.vacancy}  (${r.ref_code})`, 36, y); y += 18; header();
      }
      doc.font('Helvetica').fontSize(7.5);
      const h = Math.max(...pcols.map(([k, , w]) => doc.heightOfString(String(r[k] ?? ''), { width: w - 6 }))) + 6;
      if (y + h > 560) { doc.addPage(); y = 36; header(); }
      if (REC_FILL[r.final_recommendation]) doc.rect(36 + 22 + 120 + 36 + 40 + 42, y - 1, 80, h).fill('#' + REC_FILL[r.final_recommendation]);
      let x = 36; doc.fillColor('#222');
      for (const [k, , w] of pcols) { doc.text(String(r[k] ?? ''), x + 3, y + 2, { width: w - 6 }); x += w; }
      y += h; doc.moveTo(36, y).lineTo(806, y).strokeColor('#ddd').lineWidth(0.5).stroke();
    }
    if (!data.length) doc.font('Helvetica').fontSize(11).fillColor('#555').text('No completed evaluations for this selection.', 36, y);
    doc.font('Helvetica-Oblique').fontSize(7.5).fillColor('#777')
      .text('AI-assisted decision support. Final hiring decisions are made by authorised ECEWS staff.', 36, 570, { width: 770, align: 'center' });
    doc.end();
  }

  @Get('audit/export') @Perms('audit.view')
  async auditExport(@Res() res: Response, @Ctx() ctx: AuditContext) {
    const rows = await this.db.many('SELECT id, at, actor_email, actor_role, action, entity_type, entity_id, details, ip, hash FROM audit_logs ORDER BY id');
    await this.audit.record(ctx, 'audit.exported', null, null, { rows: rows.length });
    const q = (v: unknown) => { const s = v === null || v === undefined ? '' : typeof v === 'object' ? JSON.stringify(v) : String(v); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
    const cols = ['id', 'at', 'actor_email', 'actor_role', 'action', 'entity_type', 'entity_id', 'details', 'ip', 'hash'];
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="talentscreen-audit-${new Date().toISOString().slice(0, 10)}.csv"`);
    res.send('﻿' + [cols.join(','), ...rows.map((r) => cols.map((c) => q(c === 'at' ? new Date(r.at).toISOString() : r[c])).join(','))].join('\n'));
  }
}
