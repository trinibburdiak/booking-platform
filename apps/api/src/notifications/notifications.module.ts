import { Module } from '@nestjs/common';
import { AgendaGateway } from './agenda.gateway';
import { MailService } from './mail.service';
import { NotificationsService } from './notifications.service';

@Module({
  providers: [AgendaGateway, MailService, NotificationsService],
  exports: [MailService, NotificationsService],
})
export class NotificationsModule {}
