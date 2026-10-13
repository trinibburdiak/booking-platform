import { Injectable, Logger } from '@nestjs/common';
import { createTransport, Transporter } from 'nodemailer';

export interface MailMessage {
  to: string;
  subject: string;
  html: string;
}

/**
 * Envío de emails. En local va a Mailpit (SMTP_HOST=localhost, SMTP_PORT=1026) y se ven en
 * http://localhost:8026. Sin SMTP_HOST (tests) usa un transporte en memoria y guarda lo enviado.
 */
@Injectable()
export class MailService {
  private readonly logger = new Logger(MailService.name);
  private readonly transport: Transporter;
  readonly from = process.env.MAIL_FROM ?? 'Turnos <no-reply@turnos.dev>';
  /** Solo con el transporte en memoria: lo enviado, para inspeccionarlo en tests. */
  readonly outbox: MailMessage[] = [];

  constructor() {
    this.transport = process.env.SMTP_HOST
      ? createTransport({
          host: process.env.SMTP_HOST,
          port: Number(process.env.SMTP_PORT ?? 587),
          secure: process.env.SMTP_SECURE === 'true',
          auth: process.env.SMTP_USER ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS } : undefined,
        })
      : createTransport({ jsonTransport: true });
  }

  async send(message: MailMessage) {
    await this.transport.sendMail({ from: this.from, ...message });
    if (!process.env.SMTP_HOST) this.outbox.push(message);
    this.logger.log(`Email "${message.subject}" → ${message.to}`);
  }
}
