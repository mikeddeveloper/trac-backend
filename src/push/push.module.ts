// trac-backend/src/push/push.module.ts
// Day 24: Push notification module

import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { PushService } from './push.service';
import { PushController } from './push.controller';
import { PushSubscription } from './entities/push-subscription.entity';
import { NotificationRecord } from './entities/notification-record.entity';

@Module({
  imports: [TypeOrmModule.forFeature([PushSubscription,NotificationRecord])],
  controllers: [PushController],
  providers: [PushService],
  exports: [PushService],
})
export class PushModule {}
