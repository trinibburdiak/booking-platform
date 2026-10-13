import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { NotificationType } from '@prisma/client';
import { Job, Queue, Worker } from 'bullmq';
import { BookingEvent } from '../events/booking-events';
import { PrismaService } from '../prisma/prisma.service';
import { redisOptions } from '../redis/redis.module';
import { AgendaGateway } from './agenda.gateway';
import { MailService } from './mail.service';
import { BookingEmailData, cancelledEmail, confirmedEmail, reminderEmail, rescheduledEmail } from './templates';

export const REMINDERS_QUEUE = 'reminders';
const REMINDER_HOURS = 24;

interface ReminderJob {
  bookingId: string;
  start: string;
}

/**
 * Reacciona a los eventos de turnos: avisa a la agenda por WebSocket, manda los emails
 * y programa el recordatorio. El recordatorio es un job diferido de BullMQ con
 * `jobId = bookingId`: reprogramar es borrar el job y crear otro, sin duplicados.
 */
@Injectable()
export class NotificationsService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(NotificationsService.name);
  readonly reminders = new Queue<ReminderJob>(REMINDERS_QUEUE, {
    connection: redisOptions(),
    defaultJobOptions: { removeOnComplete: true, removeOnFail: 100, attempts: 3, backoff: { type: 'exponential', delay: 30_000 } },
  });
  private worker?: Worker<ReminderJob>;

  constructor(
    private readonly prisma: PrismaService,
    private readonly mail: MailService,
    private readonly gateway: AgendaGateway,
  ) {}

  onModuleInit() {
    this.worker = new Worker<ReminderJob>(REMINDERS_QUEUE, (job) => this.sendReminder(job), {
      connection: redisOptions(),
    });
    this.worker.on('failed', (job, err) => this.logger.error(`Recordatorio ${job?.id} falló: ${err.message}`));
  }

  async onModuleDestroy() {
    await this.worker?.close();
    await this.reminders.close();
  }

  @OnEvent('booking.confirmed', { async: true })
  async onConfirmed(event: BookingEvent) {
    this.gateway.notify(event);
    await this.email(event, 'BOOKING_CONFIRMED');
    await this.scheduleReminder(event.payload.bookingId, new Date(event.payload.start));
  }

  @OnEvent('booking.rescheduled', { async: true })
  async onRescheduled(event: BookingEvent) {
    this.gateway.notify(event);
    await this.email(event, 'BOOKING_RESCHEDULED');
    await this.scheduleReminder(event.payload.bookingId, new Date(event.payload.start));
  }

  @OnEvent('booking.cancelled', { async: true })
  async onCancelled(event: BookingEvent) {
    this.gateway.notify(event);
    await this.reminders.remove(event.payload.bookingId);
    await this.email(event, 'BOOKING_CANCELLED');
  }

  @OnEvent('booking.attendance', { async: true })
  @OnEvent('booking.no_show', { async: true })
  onAgendaChange(event: BookingEvent) {
    this.gateway.notify(event);
  }

  /** Si faltan menos de 24 h, no hay recordatorio: ya llegó el email de confirmación. */
  async scheduleReminder(bookingId: string, start: Date) {
    await this.reminders.remove(bookingId);
    const delay = start.getTime() - REMINDER_HOURS * 3_600_000 - Date.now();
    if (delay <= 0) return;
    await this.reminders.add('send-reminder', { bookingId, start: start.toISOString() }, { jobId: bookingId, delay });
  }

  /** Si el turno se canceló o se movió después de programar el job, no hace nada. */
  private async sendReminder(job: Job<ReminderJob>) {
    const booking = await this.prisma.booking.findUnique({ where: { id: job.data.bookingId } });
    if (!booking || booking.status !== 'CONFIRMED' || booking.startsAt.toISOString() !== job.data.start) return 'skipped';
    await this.sendTo(booking.id, 'BOOKING_REMINDER');
    return 'sent';
  }

  private async email(event: BookingEvent, type: NotificationType) {
    try {
      await this.sendTo(event.payload.bookingId, type, event.payload.cancelledBy === 'BUSINESS');
    } catch (e) {
      // Un email que falla no debe romper la reserva: queda registrado como FAILED.
      this.logger.error(`No se pudo enviar ${type} de ${event.payload.bookingId}: ${(e as Error).message}`);
    }
  }

  private async sendTo(bookingId: string, type: NotificationType, byBusiness = false) {
    const b = await this.prisma.booking.findUniqueOrThrow({
      where: { id: bookingId },
      include: { business: true, service: true, professional: true },
    });
    const client = await this.prisma.user.findUniqueOrThrow({ where: { id: b.clientId } });
    const web = process.env.PUBLIC_WEB_URL ?? 'http://localhost:5180';
    const data: BookingEmailData = {
      clientName: client.fullName.split(' ')[0],
      businessName: b.business.name,
      businessAddress: b.business.address,
      serviceName: b.service.name,
      professionalName: b.professional.displayName,
      start: b.startsAt,
      timezone: b.business.timezone,
      cancellationHours: b.business.cancellationHours,
      cancelUrl: `${web}/cancelar?token=${encodeURIComponent(b.cancelToken)}`,
      businessUrl: `${web}/b/${b.business.slug}`,
    };
    const content = {
      BOOKING_CONFIRMED: () => confirmedEmail(data),
      BOOKING_RESCHEDULED: () => rescheduledEmail(data),
      BOOKING_CANCELLED: () => cancelledEmail(data, byBusiness),
      BOOKING_REMINDER: () => reminderEmail(data),
    }[type]();

    try {
      await this.mail.send({ to: client.email, ...content });
      await this.prisma.notification.create({ data: { userId: client.id, bookingId, type, status: 'SENT' } });
    } catch (e) {
      await this.prisma.notification.create({
        data: { userId: client.id, bookingId, type, status: 'FAILED', error: (e as Error).message.slice(0, 500) },
      });
      throw e;
    }
  }
}
