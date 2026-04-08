// trac-backend/src/jobs/jobs.service.ts
// Day 16: Proof of delivery upload + status update

import {
  Injectable,
  NotFoundException,
  ForbiddenException,
  BadRequestException,
  Logger,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Job, JobStatus } from './entities/job.entity';
import { EventsGateway } from '../events/events.gateway';
import { createClient } from '@supabase/supabase-js';
import { ConfigService } from '@nestjs/config';

const ALLOWED_TRANSITIONS: Record<JobStatus, JobStatus[]> = {
  [JobStatus.PENDING]:    [JobStatus.BIDDING],
  [JobStatus.BIDDING]:    [JobStatus.ACCEPTED],
  [JobStatus.ACCEPTED]:   [JobStatus.IN_TRANSIT],
  [JobStatus.IN_TRANSIT]: [JobStatus.DELIVERED],
  [JobStatus.DELIVERED]:  [],
  [JobStatus.CANCELLED]:  [],
};

const ROLE_PERMISSIONS: Record<string, JobStatus[]> = {
  transporter: [JobStatus.IN_TRANSIT, JobStatus.DELIVERED],
  customer:    [JobStatus.CANCELLED],
  admin:       [JobStatus.CANCELLED],
};

@Injectable()
export class JobsService {
  private readonly logger = new Logger(JobsService.name);
  private supabase: any;

  constructor(
    @InjectRepository(Job)
    private jobRepo: Repository<Job>,
    private eventsGateway: EventsGateway,
    private configService: ConfigService,
  ) {
    // Initialize Supabase client for storage
    const url = this.configService.get<string>('SUPABASE_URL');
    const key = this.configService.get<string>('SUPABASE_SERVICE_KEY');
    if (url && key) {
      this.supabase = createClient(url, key);
    }
  }

  // ─── Create Job ──────────────────────────────────────────────────────────

  async createJob(customerId: string, dto: Partial<Job>): Promise<Job> {
    const job = this.jobRepo.create({ ...dto, customerId, status: JobStatus.BIDDING });
    return this.jobRepo.save(job);
  }

  // ─── Get open jobs ────────────────────────────────────────────────────────

  async getOpenJobs(): Promise<Job[]> {
    return this.jobRepo.find({
      where: { status: JobStatus.BIDDING },
      order: { createdAt: 'DESC' },
    });
  }

  // ─── Get customer jobs ────────────────────────────────────────────────────

  async getMyJobs(customerId: string): Promise<Job[]> {
    return this.jobRepo.find({
      where: { customerId },
      order: { createdAt: 'DESC' },
    });
  }

  // ─── Get transporter jobs ─────────────────────────────────────────────────

  async getTransporterJobs(transporterId: string): Promise<Job[]> {
    return this.jobRepo.find({
      where: { transporterId },
      order: { createdAt: 'DESC' },
    });
  }

  // ─── Get single job ───────────────────────────────────────────────────────

  async getJobById(jobId: string): Promise<Job> {
    const job = await this.jobRepo.findOne({ where: { id: jobId } });
    if (!job) throw new NotFoundException(`Job ${jobId} not found`);
    return job;
  }

  async findById(jobId: string): Promise<Job> {
    return this.getJobById(jobId);
  }

  // ─── Assign transporter ───────────────────────────────────────────────────

  async assignTransporter(
    jobId: string,
    transporterId: string,
    acceptedAmount: number,
  ): Promise<Job> {
    await this.jobRepo.update(jobId, {
      transporterId,
      acceptedAmount,
      status: JobStatus.ACCEPTED,
    });

    const updatedJob = await this.getJobById(jobId);
    this.logger.log(`Job ${jobId} assigned to transporter ${transporterId}`);

    if (updatedJob.customerId) {
      this.eventsGateway.notifyUser(updatedJob.customerId, 'job:statusUpdate', {
        jobId,
        previousStatus: JobStatus.BIDDING,
        newStatus: JobStatus.ACCEPTED,
        message: 'Your job has been accepted by a transporter',
        updatedAt: new Date(),
      });
    }

    return updatedJob;
  }

  // ─── Update job status ────────────────────────────────────────────────────

  async updateJobStatus(
    jobId: string,
    newStatus: JobStatus,
    userId: string,
    userRole: string,
    note?: string,
  ): Promise<Job> {
    const job = await this.getJobById(jobId);

    // Check role permission
    const allowedForRole = ROLE_PERMISSIONS[userRole] || [];
    if (!allowedForRole.includes(newStatus)) {
      throw new ForbiddenException(`Role '${userRole}' cannot set status to '${newStatus}'`);
    }

    // Check valid transition
    const allowedNext = ALLOWED_TRANSITIONS[job.status] || [];
    if (!allowedNext.includes(newStatus)) {
      throw new BadRequestException(`Cannot move from '${job.status}' to '${newStatus}'`);
    }

    // Check user is assigned
    if (userRole === 'transporter' && job.transporterId !== userId) {
      throw new ForbiddenException('You are not assigned to this job');
    }
    if (userRole === 'customer' && job.customerId !== userId) {
      throw new ForbiddenException('This is not your job');
    }

    // Day 16: Require proof before marking delivered
    if (newStatus === JobStatus.DELIVERED && !job.proofOfDeliveryUrl) {
      throw new BadRequestException(
        'Please upload proof of delivery photo before marking as delivered',
      );
    }

    const previousStatus = job.status;

    await this.jobRepo.update(jobId, {
      status: newStatus,
      ...(newStatus === JobStatus.IN_TRANSIT && { pickedUpAt: new Date() }),
      ...(newStatus === JobStatus.DELIVERED  && { deliveredAt: new Date() }),
    });

    const updatedJob = await this.getJobById(jobId);
    this.logger.log(`Job ${jobId}: ${previousStatus} → ${newStatus}`);

    const eventPayload = {
      jobId,
      previousStatus,
      newStatus,
      updatedAt: new Date(),
      note: note || null,
      proofOfDeliveryUrl: updatedJob.proofOfDeliveryUrl || null,
    };

    // Notify customer
    if (updatedJob.customerId) {
      this.eventsGateway.notifyUser(updatedJob.customerId, 'job:statusUpdate', {
        ...eventPayload,
        message: this.getCustomerMessage(newStatus),
      });
    }

    // Notify transporter
    if (updatedJob.transporterId && updatedJob.transporterId !== userId) {
      this.eventsGateway.notifyUser(updatedJob.transporterId, 'job:statusUpdate', {
        ...eventPayload,
        message: this.getTransporterMessage(newStatus),
      });
    }

    return updatedJob;
  }

  // ─── Upload Proof of Delivery ─────────────────────────────────────────────
  // Day 16 core feature

  async uploadProofOfDelivery(
    jobId: string,
    transporterId: string,
    fileBuffer: Buffer,
    mimeType: string,
    originalName: string,
  ): Promise<Job> {
    const job = await this.getJobById(jobId);

    // Verify transporter is assigned to this job
    if (job.transporterId !== transporterId) {
      throw new ForbiddenException('You are not assigned to this job');
    }

    // Job must be in-transit to upload proof
    if (job.status !== JobStatus.IN_TRANSIT) {
      throw new BadRequestException('Job must be in-transit to upload proof of delivery');
    }

    let proofUrl: string;

    // Upload to Supabase Storage if configured
    if (this.supabase) {
      const ext = originalName.split('.').pop() || 'jpg';
      const fileName = `proof-${jobId}-${Date.now()}.${ext}`;

      const { data, error } = await this.supabase.storage
        .from('delivery-proofs')
        .upload(fileName, fileBuffer, {
          contentType: mimeType,
          upsert: true,
        });

      if (error) {
        this.logger.error('Supabase upload error:', error.message);
        throw new BadRequestException('Failed to upload proof image');
      }

      const { data: urlData } = this.supabase.storage
        .from('delivery-proofs')
        .getPublicUrl(fileName);

      proofUrl = urlData.publicUrl;
    } else {
      // Fallback: store as base64 data URL (dev mode without Supabase storage)
      proofUrl = `data:${mimeType};base64,${fileBuffer.toString('base64')}`;
      this.logger.warn('Supabase storage not configured — using base64 fallback');
    }

    // Save proof URL to job
    await this.jobRepo.update(jobId, {
      proofOfDeliveryUrl: proofUrl,
      proofUploadedAt: new Date(),
    });

    const updatedJob = await this.getJobById(jobId);
    this.logger.log(`✅ Proof of delivery uploaded for job ${jobId}`);

    // Notify customer with the proof photo
    if (updatedJob.customerId) {
      this.eventsGateway.notifyUser(updatedJob.customerId, 'job:proofUploaded', {
        jobId,
        proofOfDeliveryUrl: proofUrl,
        message: 'Your transporter has uploaded proof of delivery',
        uploadedAt: new Date(),
      });
    }

    return updatedJob;
  }

  // ─── Messages ─────────────────────────────────────────────────────────────

  private getCustomerMessage(status: JobStatus): string {
    const messages: Partial<Record<JobStatus, string>> = {
      [JobStatus.ACCEPTED]:   'Your job has been accepted by a transporter',
      [JobStatus.IN_TRANSIT]: 'Your cargo has been picked up and is in transit',
      [JobStatus.DELIVERED]:  'Your cargo has been delivered successfully! 🎉',
      [JobStatus.CANCELLED]:  'Your job has been cancelled',
    };
    return messages[status] || `Job status updated to ${status}`;
  }

  private getTransporterMessage(status: JobStatus): string {
    const messages: Partial<Record<JobStatus, string>> = {
      [JobStatus.CANCELLED]: 'The job has been cancelled by the customer',
    };
    return messages[status] || `Job status updated to ${status}`;
  }
}