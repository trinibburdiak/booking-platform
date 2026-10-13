import { Global, Module } from '@nestjs/common';
import { KafkaService } from './kafka.service';
import { OutboxRelay } from './outbox.relay';

@Global()
@Module({ providers: [KafkaService, OutboxRelay], exports: [KafkaService, OutboxRelay] })
export class KafkaModule {}
