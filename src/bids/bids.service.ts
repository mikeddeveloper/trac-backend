// trac-backend/src/bids/bids.service.ts
// Day 27: Added push notifications for bid events

import {
  Injectable, NotFoundException,
  ForbiddenException, BadRequestException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Bid, BidStatus } from './entities/bid.entity';
import { JobsService } from '../jobs/jobs.service';
import { JobStatus } from '../jobs/entities/job.entity';
import { PushService } from '../push/push.service';
import { EventsGateway } from '../events/events.gateway';

@Injectable()
export class BidsService {
  constructor(
    @InjectRepository(Bid)
    private bidsRepo: Repository<Bid>,
    private jobsService: JobsService,
    private pushService: PushService,
    private eventsGateway: EventsGateway,
  ) {}

  async placeBid(transporterId: string, jobId: string, amount: number, note?: string): Promise<Bid> {
    const job = await this.jobsService.findById(jobId);
    if (job.status !== JobStatus.BIDDING) {
      throw new BadRequestException('This job is no longer accepting bids');
    }

    const existing = await this.bidsRepo.findOne({ where: { jobId, transporterId } });
    if (existing) throw new BadRequestException('You have already bid on this job');

    const bid = this.bidsRepo.create({ transporterId, jobId, amount, note });
    const saved = await this.bidsRepo.save(bid);

    // ── Socket: notify customer of new bid in real-time ──
    if (job.customerId) {
      this.eventsGateway.notifyUser(job.customerId, 'bid:new', {
        jobId,
        amount,
        transporterId,
        message: 'A new bid has been placed on your delivery',
      });
    }

    // ── Push: notify customer of new bid ──
    if (job.customerId) {
      const route = `${job.pickupState} → ${job.deliveryState}`;
      await this.pushService.sendToUser(
        job.customerId,
        this.pushService.templates.newBid(route, Number(amount).toLocaleString('en-NG')),
      ).catch(() => {});
    }

    return saved;
  }

  async getBidsForJob(jobId: string): Promise<Bid[]> {
    return this.bidsRepo.find({
      where: { jobId },
      relations: ['transporter'],
      order: { amount: 'ASC' },
    });
  }

  async getMyBids(transporterId: string): Promise<Bid[]> {
    return this.bidsRepo.find({
      where: { transporterId },
      relations: ['job'],
      order: { createdAt: 'DESC' },
    });
  }

  async acceptBid(bidId: string, customerId: string): Promise<Bid> {
    const bid = await this.bidsRepo.findOne({
      where: { id: bidId },
      relations: ['job'],
    });
    if (!bid) throw new NotFoundException('Bid not found');
    if (bid.job.customerId !== customerId) throw new ForbiddenException('You do not own this job');
    if (bid.job.status !== JobStatus.BIDDING) throw new BadRequestException('This job already has an accepted bid');

    bid.status = BidStatus.ACCEPTED;
    await this.bidsRepo.save(bid);

    await this.bidsRepo
      .createQueryBuilder()
      .update(Bid)
      .set({ status: BidStatus.REJECTED })
      .where('jobId = :jobId AND id != :bidId', { jobId: bid.jobId, bidId })
      .execute();

    await this.jobsService.assignTransporter(bid.jobId, bid.transporterId, bid.amount);

    // ── Push: notify transporter their bid was accepted ──
    const route = `${bid.job.pickupState} → ${bid.job.deliveryState}`;
    await this.pushService.sendToUser(
      bid.transporterId,
      this.pushService.templates.bidAccepted(route),
    ).catch(() => {});

    return bid;
  }

  async rejectBid(bidId: string, customerId: string): Promise<Bid> {
    const bid = await this.bidsRepo.findOne({
      where: { id: bidId },
      relations: ['job'],
    });
    if (!bid) throw new NotFoundException('Bid not found');
    if (bid.job.customerId !== customerId) throw new ForbiddenException('You do not own this job');

    bid.status = BidStatus.REJECTED;
    return this.bidsRepo.save(bid);
  }
}