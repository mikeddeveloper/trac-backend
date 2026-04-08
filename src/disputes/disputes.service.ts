// trac-backend/src/disputes/disputes.service.ts
// Day 18: Disputes service

import {
  Injectable,
  BadRequestException,
  NotFoundException,
  ForbiddenException,
  Logger,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Dispute, DisputeStatus, DisputeReason } from './entities/dispute.entity';
import { Job, JobStatus } from '../jobs/entities/job.entity';
import { EventsGateway } from '../events/events.gateway';

@Injectable()
export class DisputesService {
  private readonly logger = new Logger(DisputesService.name);

  constructor(
    @InjectRepository(Dispute)
    private disputeRepo: Repository<Dispute>,
    @InjectRepository(Job)
    private jobRepo: Repository<Job>,
    private eventsGateway: EventsGateway,
  ) {}

  // ─── Raise a dispute ────────────────────────────────────────────────────────

  async raiseDispute(
    userId: string,
    userRole: string,
    jobId: string,
    reason: DisputeReason,
    description: string,
  ): Promise<Dispute> {
    const job = await this.jobRepo.findOne({ where: { id: jobId } });
    if (!job) throw new NotFoundException('Job not found');

    // Only customer or transporter on the job can raise a dispute
    if (userRole === 'customer' && job.customerId !== userId) {
      throw new ForbiddenException('This is not your job');
    }
    if (userRole === 'transporter' && job.transporterId !== userId) {
      throw new ForbiddenException('You are not assigned to this job');
    }

    // Can only dispute active or delivered jobs
    const disputeableStatuses = [
      JobStatus.ACCEPTED,
      JobStatus.IN_TRANSIT,
      JobStatus.DELIVERED,
    ];
    if (!disputeableStatuses.includes(job.status)) {
      throw new BadRequestException('Cannot raise a dispute on this job');
    }

    // Check if dispute already exists for this job
    const existing = await this.disputeRepo.findOne({ where: { jobId } });
    if (existing) {
      throw new BadRequestException('A dispute already exists for this job');
    }

    const dispute = this.disputeRepo.create({
      reason,
      description,
      raisedById: userId,
      jobId,
      status: DisputeStatus.OPEN,
      evidence: [],
    });

    const saved = await this.disputeRepo.save(dispute);

    this.logger.log(`🚨 Dispute raised for job ${jobId} by user ${userId}`);

    // Notify the other party
    const notifyUserId = userRole === 'customer'
      ? job.transporterId
      : job.customerId;

    if (notifyUserId) {
      this.eventsGateway.notifyUser(notifyUserId, 'dispute:raised', {
        disputeId: saved.id,
        jobId,
        reason,
        message: 'A dispute has been raised on your job',
      });
    }

    return saved;
  }

  // ─── Get disputes for a user ─────────────────────────────────────────────────

  async getMyDisputes(userId: string): Promise<Dispute[]> {
    return this.disputeRepo.find({
      where: { raisedById: userId },
      order: { createdAt: 'DESC' },
    });
  }

  // ─── Get dispute by job ──────────────────────────────────────────────────────

  async getDisputeByJob(jobId: string): Promise<Dispute | null> {
    return this.disputeRepo.findOne({ where: { jobId } });
  }

  // ─── Get single dispute ──────────────────────────────────────────────────────

  async getDisputeById(disputeId: string): Promise<Dispute> {
    const dispute = await this.disputeRepo.findOne({ where: { id: disputeId } });
    if (!dispute) throw new NotFoundException('Dispute not found');
    return dispute;
  }

  // ─── Add evidence ────────────────────────────────────────────────────────────

  async addEvidence(
    disputeId: string,
    userId: string,
    evidenceUrl: string,
  ): Promise<Dispute> {
    const dispute = await this.getDisputeById(disputeId);

    if (dispute.raisedById !== userId) {
      throw new ForbiddenException('You did not raise this dispute');
    }

    if (dispute.status === DisputeStatus.RESOLVED || dispute.status === DisputeStatus.CLOSED) {
      throw new BadRequestException('Cannot add evidence to a resolved dispute');
    }

    const updatedEvidence = [...(dispute.evidence || []), evidenceUrl];
    await this.disputeRepo.update(disputeId, { evidence: updatedEvidence });

    return this.getDisputeById(disputeId);
  }

  // ─── Resolve dispute (admin) ─────────────────────────────────────────────────

  async resolveDispute(
    disputeId: string,
    resolutionNote: string,
  ): Promise<Dispute> {
    const dispute = await this.getDisputeById(disputeId);

    await this.disputeRepo.update(disputeId, {
      status: DisputeStatus.RESOLVED,
      resolutionNote,
      resolvedAt: new Date(),
    });

    const updated = await this.getDisputeById(disputeId);

    // Notify the person who raised the dispute
    this.eventsGateway.notifyUser(dispute.raisedById, 'dispute:resolved', {
      disputeId,
      resolutionNote,
      message: 'Your dispute has been resolved',
    });

    this.logger.log(`✅ Dispute ${disputeId} resolved`);
    return updated;
  }

  // ─── Get all disputes (admin) ────────────────────────────────────────────────

  async getAllDisputes(): Promise<Dispute[]> {
    return this.disputeRepo.find({ order: { createdAt: 'DESC' } });
  }
}