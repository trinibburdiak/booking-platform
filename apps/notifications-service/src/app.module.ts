import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { JwtModule } from '@nestjs/jwt';
import { healthController, InternalTokenGuard } from '@turnos/common';
import { EventsModule } from '@turnos/kafka';
import { AgendaGateway } from './agenda.gateway';
import { MailService } from './mail.service';
import { NotificationsService } from './notifications.service';
import { PrismaModule, PrismaService } from './prisma.service';

@Module({
  imports: [
    PrismaModule,
    // No publica eventos todavía: el outbox queda listo para cuando haga falta (ej. notification.sent)
    EventsModule.forRoot({ clientId: 'notifications-service', produces: [], prisma: PrismaService }),
    JwtModule.registerAsync({ useFactory: () => ({ secret: process.env.JWT_SECRET ?? 'dev-secret' }) }),
  ],
  controllers: [healthController('notifications-service')],
  providers: [MailService, NotificationsService, AgendaGateway, { provide: APP_GUARD, useClass: InternalTokenGuard }],
})
export class AppModule {}
