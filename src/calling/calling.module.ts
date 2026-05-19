// trac-backend/src/calling/calling.module.ts
// Day 26: Calling module

import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { CallingService } from './calling.service';
import { CallingController } from './calling.controller';
import { EventsModule } from '../events/events.module';
import { JobsModule } from '../jobs/jobs.module';

@Module({
  imports: [ConfigModule, EventsModule, JobsModule],
  controllers: [CallingController],
  providers: [CallingService],
  exports: [CallingService],
})
export class CallingModule {}