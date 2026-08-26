// trac-backend/src/ratings/ratings.module.ts
// Day 27: Added PushModule

import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { RatingsService } from './ratings.service';
import { RatingsController } from './ratings.controller';
import { Rating } from './entities/rating.entity';
import { Job } from '../jobs/entities/job.entity';
import { User } from '../users/entities/user.entity';
import { PushModule } from '../push/push.module';

@Module({
  imports: [TypeOrmModule.forFeature([Rating, Job, User]), PushModule],
  controllers: [RatingsController],
  providers: [RatingsService],
  exports: [RatingsService],
})
export class RatingsModule {}
