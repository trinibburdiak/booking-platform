import { Logger, OnApplicationBootstrap } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { OnGatewayConnection, WebSocketGateway, WebSocketServer } from '@nestjs/websockets';
import { internalGet, SERVICE_URLS } from '@turnos/common';
import { BookingEvent, InternalMembership, TOPICS } from '@turnos/contracts';
import { KafkaService } from '@turnos/kafka';
import { hostname } from 'os';
import { Server, Socket } from 'socket.io';

/**
 * WebSocket de la agenda (el gateway lo proxea en /socket.io). Al conectarse, el
 * cliente manda su access token y el negocio que quiere ver; entra a la sala
 * `business:{id}` solo si auth-service confirma la membresía.
 *
 * Consume Kafka con un grupo propio por instancia: cada instancia recibe todos
 * los eventos y avisa a los sockets conectados a ella.
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
    private readonly kafka: KafkaService,
  ) {}

  async onApplicationBootstrap() {
    await this.kafka.consume({
      groupId: `agenda-realtime-${hostname()}-${process.pid}`,
      topics: [TOPICS.booking],
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
      const memberships = await internalGet<InternalMembership[]>(SERVICE_URLS.auth(), `/internal/users/${sub}/memberships`);
      if (!memberships.some((m) => m.businessId === businessId)) throw new Error('sin membresía');
      await client.join(`business:${businessId}`);
      client.emit('ready', { businessId });
    } catch (e) {
      this.logger.debug(`Conexión rechazada: ${(e as Error).message}`);
      client.emit('unauthorized');
      client.disconnect(true);
    }
  }

  notify(event: BookingEvent) {
    if (!event.businessId) return;
    this.server?.to(`business:${event.businessId}`).emit('agenda', {
      type: event.eventType,
      bookingId: event.payload.bookingId,
      start: event.payload.start,
      professionalId: event.payload.professionalId,
    });
  }
}
