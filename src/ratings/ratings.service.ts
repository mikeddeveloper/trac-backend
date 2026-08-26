// trac-backend/src/ratings/ratings.service.ts
// Day 27: Added push notifications for ratings

import {
  Injectable, BadRequestException, NotFoundException, Logger,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Rating, RatingRole } from './entities/rating.entity';
import { Job, JobStatus } from '../jobs/entities/job.entity';
import { PushService } from '../push/push.service';

@Injectable()
export class RatingsService {
  private readonly logger = new Logger(RatingsService.name);

  constructor(
    @InjectRepository(Rating)
    private ratingRepo: Repository<Rating>,
    @InjectRepository(Job)
    private jobRepo: Repository<Job>,
    private pushService: PushService,
  ) {}

  async submitRating(
    fromUserId: string,
    jobId: string,
    stars: number,
    comment: string,
    userRole: string,
  ): Promise<Rating> {
    if (stars < 1 || stars > 5) throw new BadRequestException('Stars must be between 1 and 5');

    const job = await this.jobRepo.findOne({ where: { id: jobId } });
    if (!job) throw new NotFoundException('Job not found');
    if (job.status !== JobStatus.DELIVERED) throw new BadRequestException('Can only rate after job is delivered');

    let toUserId: string;
    let type: RatingRole;

    if (userRole === 'customer') {
      if (job.customerId !== fromUserId) throw new BadRequestException('This is not your job');
      if (!job.transporterId) throw new BadRequestException('No transporter assigned to this job');
      toUserId = job.transporterId;
      type = RatingRole.CUSTOMER_TO_TRANSPORTER;
    } else {
      if (job.transporterId !== fromUserId) throw new BadRequestException('You are not assigned to this job');
      toUserId = job.customerId;
      type = RatingRole.TRANSPORTER_TO_CUSTOMER;
    }

    const existing = await this.ratingRepo.findOne({ where: { jobId, fromUserId, type } });
    if (existing) throw new BadRequestException('You have already rated this job');

    const rating = this.ratingRepo.create({ stars, comment, type, fromUserId, toUserId, jobId });
    const saved  = await this.ratingRepo.save(rating);
    this.logger.log(`⭐ Rating submitted: ${stars} stars for user ${toUserId}`);

    // ── Push: notify recipient of new rating ──
    await this.pushService.sendToUser(
      toUserId,
      this.pushService.templates.newRating(stars),
    ).catch(() => {});

    return saved;
  }

  async getRatingsForUser(userId: string): Promise<{ ratings: Rating[]; averageStars: number; totalRatings: number; }> {
    const ratings = await this.ratingRepo.find({ where: { toUserId: userId }, order: { createdAt: 'DESC' } });
    const totalRatings = ratings.length;
    const averageStars = totalRatings > 0
      ? +(ratings.reduce((sum, r) => sum + r.stars, 0) / totalRatings).toFixed(1) : 0;
    return { ratings, averageStars, totalRatings };
  }

  async getRatingsByUser(userId: string): Promise<Rating[]> {
    return this.ratingRepo.find({ where: { fromUserId: userId }, order: { createdAt: 'DESC' } });
  }

  async hasRated(userId: string, jobId: string, type: RatingRole): Promise<boolean> {
    const existing = await this.ratingRepo.findOne({ where: { jobId, fromUserId: userId, type } });
    return !!existing;
  }

  async getPendingRatings(userId: string, userRole: string): Promise<Job[]> {
    const whereClause = userRole === 'customer'
      ? { customerId: userId, status: JobStatus.DELIVERED }
      : { transporterId: userId, status: JobStatus.DELIVERED };

    const deliveredJobs = await this.jobRepo.find({
      where: whereClause,
      relations: ['customer', 'transporter'],
      order: { deliveredAt: 'DESC' },
    });
    const ratingType = userRole === 'customer'
      ? RatingRole.CUSTOMER_TO_TRANSPORTER
      : RatingRole.TRANSPORTER_TO_CUSTOMER;

    const pending: Job[] = [];
    for (const job of deliveredJobs) {
      const rated = await this.hasRated(userId, job.id, ratingType);
      if (!rated) pending.push(job);
    }
    return pending;
  }
}
