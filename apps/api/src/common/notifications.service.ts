import { Injectable, Logger } from '@nestjs/common';
import nodemailer from 'nodemailer';
import { config } from '../config';
import { Db, Queryable } from './db.service';

/** In-app notifications, with optional email when SMTP is configured. */
@Injectable()
export class NotificationsService {
  private log = new Logger('Notify');
  private mailer = config.mail.host
    ? nodemailer.createTransport({ host: config.mail.host, port: config.mail.port, secure: config.mail.secure,
        auth: config.mail.user ? { user: config.mail.user, pass: config.mail.pass } : undefined })
    : null;

  constructor(private db: Db) {}

  async toUsers(userIds: string[], type: string, title: string, body = '', link?: string, c?: Queryable) {
    const ids = [...new Set(userIds.filter(Boolean))];
    if (!ids.length) return;
    await this.db.exec(
      `INSERT INTO notifications (user_id, type, title, body, link)
       SELECT u, $2, $3, $4, $5 FROM unnest($1::uuid[]) u`, [ids, type, title, body, link ?? null], c);
    if (this.mailer) {
      const users = await this.db.many<{ email: string }>('SELECT email FROM users WHERE id = ANY($1) AND is_active', [ids]);
      for (const u of users) {
        this.mailer.sendMail({ from: config.mail.from, to: u.email, subject: `[TalentScreen] ${title}`,
          text: `${body}\n\n${link ? config.publicUrl + link : config.publicUrl}` })
          .catch((e) => this.log.warn(`Email to ${u.email} failed: ${e.message}`));
      }
    }
  }

  /** Notify every active user holding any of the given permissions. */
  async toPermission(perms: string[], type: string, title: string, body = '', link?: string, exceptUserId?: string) {
    const rows = await this.db.many<{ id: string }>(
      `SELECT DISTINCT u.id FROM users u JOIN role_permissions rp ON rp.role_id = u.role_id
       WHERE u.is_active AND rp.permission_key = ANY($1)`, [perms]);
    await this.toUsers(rows.map((r) => r.id).filter((id) => id !== exceptUserId), type, title, body, link);
  }
}
