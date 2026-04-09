// trac-backend/src/bids/bids.module.ts
// Day 27: Added PushModule

import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { BidsService } from './bids.service';
import { BidsController } from './bids.controller';
import { Bid } from './entities/bid.entity';
import { JobsModule } from '../jobs/jobs.module';
import { PushModule } from '../push/push.module';
import { EventsModule } from '../events/events.module';

@Module({
  imports: [TypeOrmModule.forFeature([Bid]), JobsModule, PushModule, EventsModule],
  controllers: [BidsController],
  providers: [BidsService],
  exports: [BidsService],
})
export class BidsModule {}