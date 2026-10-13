import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { JwtModule } from '@nestjs/jwt';
import { healthController, InternalTokenGuard } from '@turnos/common';
import { TOPICS } from '@turnos/contracts';
import { EventsModule } from '@turnos/kafka';
import { AuthController, InternalUsersController } from './auth.controller';
import { AuthService } from './auth.service';
import { BusinessEventsConsumer } from './business-events.consumer';
import { PrismaModule, PrismaService } from './prisma.service';

@Module({
  imports: [
    PrismaModule,
    EventsModule.forRoot({ clientId: 'auth-service', produces: [TOPICS.auth], prisma: PrismaService }),
    JwtModule.registerAsync({
      useFactory: () => ({ secret: process.env.JWT_SECRET ?? 'dev-secret', signOptions: { expiresIn: '15m' } }),
    }),
  ],
  controllers: [AuthController, InternalUsersController, healthController('auth-service')],
  providers: [AuthService, BusinessEventsConsumer, { provide: APP_GUARD, useClass: InternalTokenGuard }],
})
export class AppModule {}
