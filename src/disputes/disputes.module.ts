// trac-backend/src/disputes/disputes.module.ts
// Day 18: Disputes module

import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { DisputesService } from './disputes.service';
import { DisputesController } from './disputes.controller';
import { Dispute } from './entities/dispute.entity';
import { Job } from '../jobs/entities/job.entity';
import { EventsModule } from '../events/events.module';
import { PushModule } from '../push/push.module';

@Module({
  imports: [
    TypeOrmModule.forFeature([Dispute, Job]),
    EventsModule,
    PushModule,
  ],
  controllers: [DisputesController],
  providers: [DisputesService],
  exports: [DisputesService],
})
export class DisputesModule {}