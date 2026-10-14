import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { healthController, InternalTokenGuard } from '@turnos/common';
import { TOPICS } from '@turnos/contracts';
import { EventsModule } from '@turnos/kafka';
import { AvailabilityService } from './availability.service';
import { BookingJobsService } from './booking-jobs.service';
import { AgendaController, BookingController, InternalBookingsController, PublicAvailabilityController } from './booking.controller';
import { BookingService } from './booking.service';
import { ExpirationQueue } from './expiration.queue';
import { MetricsService } from './metrics.service';
import { PaymentsConsumer } from './payments.consumer';
import { PrismaModule, PrismaService } from './prisma.service';
import { RedisModule } from './redis.module';
import { ReplicaConsumer } from './replica.consumer';

@Module({
  imports: [
    PrismaModule,
    RedisModule,
    EventsModule.forRoot({ clientId: 'booking-service', produces: [TOPICS.booking], prisma: PrismaService }),
  ],
  controllers: [
    PublicAvailabilityController,
    BookingController,
    AgendaController,
    InternalBookingsController,
    healthController('booking-service'),
  ],
  providers: [
    AvailabilityService,
    BookingService,
    BookingJobsService,
    ExpirationQueue,
    MetricsService,
    ReplicaConsumer,
    PaymentsConsumer,
    { provide: APP_GUARD, useClass: InternalTokenGuard },
  ],
})
export class AppModule {}
