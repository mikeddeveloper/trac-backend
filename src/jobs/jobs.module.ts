// trac-backend/src/jobs/jobs.module.ts
// Day 27: Added PushModule

import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { JobsService } from './jobs.service';
import { JobsController } from './jobs.controller';
import { Job } from './entities/job.entity';
import { User } from '../users/entities/user.entity';
import { EventsModule } from '../events/events.module';
import { PushModule } from '../push/push.module';
import { EmailModule } from '../email/email.module';

@Module({
  imports: [TypeOrmModule.forFeature([Job, User]), EventsModule, PushModule, EmailModule],
  controllers: [JobsController],
  providers: [JobsService],
  exports: [JobsService],
})
export class JobsModule {}