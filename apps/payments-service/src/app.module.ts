import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { healthController, InternalTokenGuard } from '@turnos/common';
import { TOPICS } from '@turnos/contracts';
import { EventsModule } from '@turnos/kafka';
import { PaymentsController } from './payments.controller';
import { PaymentsService } from './payments.service';
import { PrismaModule, PrismaService } from './prisma.service';

@Module({
  imports: [PrismaModule, EventsModule.forRoot({ clientId: 'payments-service', produces: [TOPICS.payments], prisma: PrismaService })],
  controllers: [PaymentsController, healthController('payments-service')],
  providers: [PaymentsService, { provide: APP_GUARD, useClass: InternalTokenGuard }],
})
export class AppModule {}
