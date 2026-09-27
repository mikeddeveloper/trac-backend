// trac-backend/src/chat/chat.module.ts

import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ChatService } from './chat.service';
import { ChatController } from './chat.controller';
import { Job } from '../jobs/entities/job.entity';
import { EventsModule } from '../events/events.module';
import { PushModule } from '../push/push.module';
import { JobsModule } from '../jobs/jobs.module';

@Module({
  imports: [TypeOrmModule.forFeature([Job]), EventsModule, PushModule, JobsModule],
  controllers: [ChatController],
  providers: [ChatService],
  exports: [ChatService],
})
export class ChatModule {}
