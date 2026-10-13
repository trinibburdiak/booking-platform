import { Module } from '@nestjs/common';
import { AvailabilityService } from './availability.service';
import { BookingJobsService } from './booking-jobs.service';
import { AgendaController, BookingController, PublicAvailabilityController } from './booking.controller';
import { BookingService } from './booking.service';

@Module({
  controllers: [PublicAvailabilityController, BookingController, AgendaController],
  providers: [AvailabilityService, BookingService, BookingJobsService],
})
export class BookingModule {}
