import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { healthController, InternalTokenGuard } from '@turnos/common';
import { TOPICS } from '@turnos/contracts';
import { EventsModule } from '@turnos/kafka';
import { BusinessesController, BusinessManagementController, PublicBusinessController } from './business.controller';
import { BusinessService } from './business.service';
import { PrismaModule, PrismaService } from './prisma.service';

@Module({
  imports: [PrismaModule, EventsModule.forRoot({ clientId: 'business-service', produces: [TOPICS.business], prisma: PrismaService })],
  controllers: [PublicBusinessController, BusinessesController, BusinessManagementController, healthController('business-service')],
  providers: [BusinessService, { provide: APP_GUARD, useClass: InternalTokenGuard }],
})
export class AppModule {}
