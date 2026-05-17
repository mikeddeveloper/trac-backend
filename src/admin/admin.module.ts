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

@Module({
  imports: [TypeOrmModule.forFeature([Job, Payment, Dispute, User, Rating]), PushModule],
  controllers: [AdminController],
  providers: [AdminService],
  exports: [AdminService],
})
export class AdminModule {}