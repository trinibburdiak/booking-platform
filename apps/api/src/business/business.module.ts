import { Module } from '@nestjs/common';
import { BusinessesController, BusinessManagementController, PublicBusinessController } from './business.controller';
import { BusinessService } from './business.service';

@Module({
  controllers: [PublicBusinessController, BusinessesController, BusinessManagementController],
  providers: [BusinessService],
  exports: [BusinessService],
})
export class BusinessModule {}
