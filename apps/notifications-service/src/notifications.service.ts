import { Injectable, Logger, OnApplicationBootstrap, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { internalGet, SERVICE_URLS } from '@turnos/common';
import { BookingEvent, InternalBookingDetail, TOPICS } from '@turnos/contracts';
import { KafkaService, processOnce } from '@turnos/kafka';
import { Job, Queue, Worker } from 'bullmq';
import { NotificationType } from '../generated/prisma';
import { MailService } from './mail.service';
import { PrismaService } from './prisma.service';
import { redisOptions } from './redis';
import { BookingEmailData, cancelledEmail, confirmedEmail, reminderEmail, rescheduledEmail } from './templates';

export const REMINDERS_QUEUE = 'reminders';
export const NOTIFICATIONS_CONSUMER = 'notifications-service';
const REMINDER_HOURS = 24;

interface ReminderJob {
  bookingId: string;
  start: string;
}

/**
 * Consume booking.events: manda los emails y programa el recordatorio. Los datos
 * del email (servicio, profesional, cliente, link de cancelación) se piden a
 * booking-service por su API interna, así el evento no lleva datos sensibles.
 * El recordatorio es un job diferido de BullMQ con `jobId = bookingId`.
 */
@Injectable()
export class NotificationsService implements OnModuleInit, OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger(NotificationsService.name);
  readonly reminders = new Queue<ReminderJob>(REMINDERS_QUEUE, {
    connection: redisOptions(),
    defaultJobOptions: { removeOnComplete: true, removeOnFail: 100, attempts: 3, backoff: { type: 'exponential', delay: 30_000 } },
  });
  private worker?: Worker<ReminderJob>;

  constructor(
    private readonly prisma: PrismaService,
    private readonly mail: MailService,
    private readonly kafka: KafkaService,
  ) {}

  onModuleInit() {
    this.worker = new Worker<ReminderJob>(REMINDERS_QUEUE, (job) => this.sendReminder(job), { connection: redisOptions() });
    this.worker.on('failed', (job, err) => this.logger.error(`Recordatorio ${job?.id} falló: ${err.message}`));
  }

  async onApplicationBootstrap() {
    await this.kafka.consume({
      groupId: NOTIFICATIONS_CONSUMER,
      topics: [TOPICS.booking],
      fromBeginning: true,
      handler: async ({ message }) => {
        if (message.value) await this.handle(JSON.parse(message.value.toString()) as BookingEvent);
      },
    });
  }

  async onModuleDestroy() {
    await this.worker?.close();
    await this.reminders.close();
  }

  async handle(event: BookingEvent) {
    await processOnce(this.prisma, NOTIFICATIONS_CONSUMER, event.eventId, async () => {
      const { bookingId, start, cancelledBy } = event.payload;
      switch (event.eventType) {
        case 'booking.confirmed':
          await this.email(bookingId, 'BOOKING_CONFIRMED');
          await this.scheduleReminder(bookingId, new Date(start));
          break;
        case 'booking.rescheduled':
          await this.email(bookingId, 'BOOKING_RESCHEDULED');
          await this.scheduleReminder(bookingId, new Date(start));
          break;
        case 'booking.cancelled':
          await this.reminders.remove(bookingId);
          await this.email(bookingId, 'BOOKING_CANCELLED', cancelledBy === 'BUSINESS');
          break;
      }
    });
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
    const booking = await this.detail(job.data.bookingId);
    if (booking.status !== 'CONFIRMED' || booking.start !== job.data.start) return 'skipped';
    await this.sendTo(booking, 'BOOKING_REMINDER');
    return 'sent';
  }

  private detail(bookingId: string) {
    return internalGet<InternalBookingDetail>(SERVICE_URLS.booking(), `/internal/bookings/${bookingId}`);
  }

  /** Un email que falla no rompe nada: queda registrado como FAILED. */
  private async email(bookingId: string, type: NotificationType, byBusiness = false) {
    try {
      await this.sendTo(await this.detail(bookingId), type, byBusiness);
    } catch (e) {
      this.logger.error(`No se pudo enviar ${type} de ${bookingId}: ${(e as Error).message}`);
    }
  }

  private async sendTo(b: InternalBookingDetail, type: NotificationType, byBusiness = false) {
    const web = process.env.PUBLIC_WEB_URL ?? 'http://localhost:5180';
    const data: BookingEmailData = {
      clientName: b.client.fullName.split(' ')[0],
      businessName: b.business.name,
      businessAddress: b.business.address,
      serviceName: b.service.name,
      professionalName: b.professional.displayName,
      start: new Date(b.start),
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
      await this.mail.send({ to: b.client.email, ...content });
      await this.prisma.notification.create({ data: { userId: b.client.id, bookingId: b.id, type, status: 'SENT' } });
    } catch (e) {
      await this.prisma.notification.create({
        data: { userId: b.client.id, bookingId: b.id, type, status: 'FAILED', error: (e as Error).message.slice(0, 500) },
      });
      throw e;
    }
  }
}
