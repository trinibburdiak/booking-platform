import { Logger, OnApplicationBootstrap } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { OnGatewayConnection, WebSocketGateway, WebSocketServer } from '@nestjs/websockets';
import { hostname } from 'os';
import { Server, Socket } from 'socket.io';
import { BOOKING_EVENTS_TOPIC, BookingEvent } from '../events/booking-events';
import { KafkaService } from '../kafka/kafka.service';
import { PrismaService } from '../prisma/prisma.service';

/**
 * WebSocket de la agenda. Al conectarse, el cliente manda su access token y el
 * negocio que quiere ver; solo entra a la sala `business:{id}` si tiene membresía.
 * Cuando cambia un turno, el panel recibe `agenda` y vuelve a pedir la agenda.
 *
 * Consume Kafka con un grupo propio por instancia: cada instancia de la API recibe
 * todos los eventos y avisa a los sockets conectados a ella.
 */
@WebSocketGateway({
  path: '/socket.io',
  cors: { origin: process.env.WEB_ORIGIN ?? 'http://localhost:5180', credentials: true },
})
export class AgendaGateway implements OnGatewayConnection, OnApplicationBootstrap {
  private readonly logger = new Logger(AgendaGateway.name);
  @WebSocketServer() server!: Server;

  constructor(
    private readonly jwt: JwtService,
    private readonly prisma: PrismaService,
    private readonly kafka: KafkaService,
  ) {}

  async onApplicationBootstrap() {
    await this.kafka.consume({
      groupId: `agenda-realtime-${hostname()}-${process.pid}`,
      topic: BOOKING_EVENTS_TOPIC,
      fromBeginning: false,
      handler: async ({ message }) => {
        if (message.value) this.notify(JSON.parse(message.value.toString()) as BookingEvent);
      },
    });
  }

  async handleConnection(client: Socket) {
    try {
      const { token, businessId } = client.handshake.auth as { token?: string; businessId?: string };
      if (!token || !businessId) throw new Error('faltan credenciales');
      const { sub } = await this.jwt.verifyAsync<{ sub: string }>(token);
      const membership = await this.prisma.membership.findUnique({
        where: { userId_businessId: { userId: sub, businessId } },
      });
      if (!membership) throw new Error('sin membresía');
      await client.join(`business:${businessId}`);
      client.emit('ready', { businessId });
    } catch (e) {
      this.logger.debug(`Conexión rechazada: ${(e as Error).message}`);
      client.emit('unauthorized');
      client.disconnect(true);
    }
  }

  notify(event: BookingEvent) {
    this.server?.to(`business:${event.businessId}`).emit('agenda', {
      type: event.eventType,
      bookingId: event.payload.bookingId,
      start: event.payload.start,
      professionalId: event.payload.professionalId,
    });
  }
}
