// trac-backend/src/admin/admin.module.ts
// Day 22: Admin module

import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AdminService } from './admin.service';
import { AdminController } from './admin.controller';
import { Job } from '../jobs/entities/job.entity';
import { Payment } from '../payments/entities/payment.entity';
import { Dispute } from '../disputes/entities/dispute.entity';
import { User } from '../users/entities/user.entity';
import { Rating } from '../ratings/entities/rating.entity';
import { PushModule } from '../push/push.module';
import { EventsModule } from '../events/events.module';
import { VerificationModule } from '../verification/verification.module';
import { AdminGuard } from './admin.guard';

@Module({
  imports: [TypeOrmModule.forFeature([Job, Payment, Dispute, User, Rating]), PushModule, EventsModule, VerificationModule],
  controllers: [AdminController],
  providers: [AdminService, AdminGuard],
  exports: [AdminService],
})
export class AdminModule {}
