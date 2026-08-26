// trac-backend/src/jobs/jobs.module.ts
// Day 27: Added PushModule

import { Module, forwardRef } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { JobsService } from './jobs.service';
import { JobsController } from './jobs.controller';
import { Job } from './entities/job.entity';
import { User } from '../users/entities/user.entity';
import { EventsModule } from '../events/events.module';
import { PushModule } from '../push/push.module';
import { EmailModule } from '../email/email.module';
import { PaymentsModule } from '../payments/payments.module';
import { Bid } from '../bids/entities/bid.entity';

@Module({
  imports: [
    TypeOrmModule.forFeature([Job, User, Bid]),
    EventsModule, PushModule, EmailModule,
    forwardRef(() => PaymentsModule),
  ],
  controllers: [JobsController],
  providers: [JobsService],
  exports: [JobsService],
})
export class JobsModule {}
