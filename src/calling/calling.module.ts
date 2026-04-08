// trac-backend/src/calling/calling.module.ts
// Day 26: Calling module

import { Module } from '@nestjs/common';
import { CallingService } from './calling.service';
import { CallingController } from './calling.controller';
import { EventsModule } from '../events/events.module';

@Module({
  imports: [EventsModule],
  controllers: [CallingController],
  providers: [CallingService],
  exports: [CallingService],
})
export class CallingModule {}