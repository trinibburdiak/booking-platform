import { Module } from '@nestjs/common';
import { AvailabilityService } from './availability.service';
import { AgendaController, BookingController, PublicAvailabilityController } from './booking.controller';
import { BookingService } from './booking.service';

@Module({
  controllers: [PublicAvailabilityController, BookingController, AgendaController],
  providers: [AvailabilityService, BookingService],
})
export class BookingModule {}
