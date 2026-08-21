// trac-backend/src/bids/bids.service.ts
// Day 27: Added push notifications for bid events

import {
  Injectable, NotFoundException,
  ForbiddenException, BadRequestException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Bid, BidStatus } from './entities/bid.entity';
import { User, UserRole } from '../users/entities/user.entity';
import { JobsService } from '../jobs/jobs.service';
import { JobStatus } from '../jobs/entities/job.entity';
import { PushService } from '../push/push.service';
import { EventsGateway } from '../events/events.gateway';
import { EmailService } from '../email/email.service';

@Injectable()
export class BidsService {
  constructor(
    @InjectRepository(Bid)
    private bidsRepo: Repository<Bid>,
    @InjectRepository(User)
    private userRepo: Repository<User>,
    private jobsService: JobsService,
    private pushService: PushService,
    private eventsGateway: EventsGateway,
    private emailService: EmailService,
  ) {}

  async placeBid(transporterId: string, jobId: string, amount: number, note?: string): Promise<Bid> {
    if (!Number.isFinite(Number(amount)) || Number(amount) <= 0) {
      throw new BadRequestException('Bid amount must be greater than zero');
    }
    const transporter = await this.userRepo.findOne({ where: { id: transporterId } });
    if (transporter?.role !== UserRole.TRANSPORTER) {
      throw new ForbiddenException('Only transporters can place bids');
    }
    if (!transporter?.isVerified) {
      throw new ForbiddenException('Please verify your NIN first before bidding on jobs.');
    }
    if ((transporter as any).licenseStatus !== 'approved') {
      throw new ForbiddenException('Please submit your driver license and wait for admin approval before bidding on jobs.');
    }

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
      const customer = await this.userRepo.findOne({ where: { id: job.customerId } });
      if (customer) await this.emailService.sendActivityEmail(
        customer,
        'New quote received for your Trac delivery',
        'You received a new quote',
        `A transporter quoted ₦${Number(amount).toLocaleString('en-NG')} for ${route}.`,
        undefined,
        'Review Quote',
      );
    }

    return saved;
  }

  async getBidsForJob(jobId: string, userId: string, role: string): Promise<Bid[]> {
    const job = await this.jobsService.findById(jobId);
    if (job.customerId !== userId && role !== 'admin') {
      throw new ForbiddenException('You do not own this job');
    }
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

    // ── Socket: notify transporter their bid was accepted in real-time ──
    this.eventsGateway.notifyUser(bid.transporterId, 'bid:accepted', {
      jobId: bid.jobId,
      amount: bid.amount,
      message: 'Your bid was selected. Wait for payment confirmation before pickup.',
    });

    const route = `${bid.job.pickupState} → ${bid.job.deliveryState}`;
    const transporter = await this.userRepo.findOne({ where: { id: bid.transporterId } });
    if (transporter) await this.emailService.sendActivityEmail(
      transporter,
      'Your Trac bid was accepted',
      'Your bid was selected',
      `Your bid for ${route} was selected. Wait for payment confirmation before pickup.`,
      undefined,
      'View Delivery',
    );

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
    const saved = await this.bidsRepo.save(bid);

    // ── Socket: notify transporter their bid was not selected ──
    this.eventsGateway.notifyUser(bid.transporterId, 'bid:rejected', {
      jobId: bid.jobId,
      message: 'Your bid was not selected for this job',
    });

    // ── Push: notify transporter their bid was not selected ──
    await this.pushService.sendToUser(bid.transporterId, {
      title: '❌ Bid Not Selected',
      body: 'Your bid was not selected for this job',
      url: '/dashboard/bids',
      tag: 'bid-rejected',
    }).catch(() => {});

    return saved;
  }
}
