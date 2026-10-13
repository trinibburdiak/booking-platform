import { Body, Controller, Get, Headers, HttpCode, Param, ParseUUIDPipe, Patch, Post, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiHeader, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import {
  agendaQuerySchema,
  attendanceSchema,
  AvailabilityQuery,
  availabilityQuerySchema,
  AvailabilityResponse,
  CreateBookingInput,
  createBookingSchema,
  RescheduleBookingInput,
  rescheduleBookingSchema,
} from '@turnos/contracts';
import { z } from 'zod';
import { AuthUser, CurrentTenant, CurrentUser, JwtAuthGuard, Tenant, TenantGuard } from '../common/auth';
import { ZodPipe } from '../common/zod.pipe';
import { AvailabilityService } from './availability.service';
import { BookingService } from './booking.service';

const uuid = new ParseUUIDPipe({ version: '4' });

@ApiTags('public')
@Controller('public/businesses')
export class PublicAvailabilityController {
  constructor(private readonly availability: AvailabilityService) {}

  /** Slots libres del día; sin professionalId = "cualquiera". */
  @Get(':slug/availability')
  @Throttle({ default: { limit: 60, ttl: 60_000 } })
  async get(
    @Param('slug') slug: string,
    @Query(new ZodPipe(availabilityQuerySchema)) q: AvailabilityQuery,
  ): Promise<AvailabilityResponse> {
    const { business, service } = await this.availability.resolveBusinessAndService(slug, q.serviceId);
    const slots = await this.availability.slots({ business, service, date: q.date, professionalId: q.professionalId });
    return { date: q.date, timezone: business.timezone, slots };
  }
}

@ApiTags('bookings')
@Controller()
export class BookingController {
  constructor(private readonly bookings: BookingService) {}

  @Post('bookings')
  @ApiBearerAuth()
  @ApiHeader({ name: 'Idempotency-Key', required: true })
  @UseGuards(JwtAuthGuard)
  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  create(
    @CurrentUser() user: AuthUser,
    @Body(new ZodPipe(createBookingSchema)) body: CreateBookingInput,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
  ) {
    return this.bookings.create(user, body, idempotencyKey);
  }

  @Get('me/bookings')
  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard)
  mine(@CurrentUser() user: AuthUser) {
    return this.bookings.myBookings(user);
  }

  /** Va antes que `bookings/:id/cancel` para que "cancel" no se lea como id. */
  @Post('bookings/cancel')
  @HttpCode(200)
  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  cancelByToken(@Query('token') token: string) {
    return this.bookings.cancelByToken(token);
  }

  @Post('bookings/:id/cancel')
  @HttpCode(200)
  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard)
  cancel(@CurrentUser() user: AuthUser, @Param('id', uuid) id: string) {
    return this.bookings.cancel(user, id);
  }

  @Post('bookings/:id/reschedule')
  @HttpCode(200)
  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard)
  reschedule(
    @CurrentUser() user: AuthUser,
    @Param('id', uuid) id: string,
    @Body(new ZodPipe(rescheduleBookingSchema)) body: RescheduleBookingInput,
  ) {
    return this.bookings.reschedule(user, id, body);
  }
}

@ApiTags('business')
@ApiBearerAuth()
@ApiHeader({ name: 'X-Business-Id', required: true })
@Controller('business')
@UseGuards(JwtAuthGuard, TenantGuard)
export class AgendaController {
  constructor(private readonly bookings: BookingService) {}

  @Get('agenda')
  agenda(@CurrentTenant() t: Tenant, @Query(new ZodPipe(agendaQuerySchema)) q: z.infer<typeof agendaQuerySchema>) {
    return this.bookings.agenda(t, new Date(q.from), new Date(q.to), q.professionalId);
  }

  @Patch('bookings/:id/attendance')
  attendance(
    @CurrentTenant() t: Tenant,
    @Param('id', uuid) id: string,
    @Body(new ZodPipe(attendanceSchema)) body: z.infer<typeof attendanceSchema>,
  ) {
    return this.bookings.markAttendance(t, id, body.attended);
  }
}
