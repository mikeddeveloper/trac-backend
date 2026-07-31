// trac-backend/src/jobs/jobs.service.ts
// Day 27 + Real-time: Push notifications + socket broadcast

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
import { User } from '../users/entities/user.entity';
import { EventsGateway } from '../events/events.gateway';
import { PushService } from '../push/push.service';
import { EmailService } from '../email/email.service';
import { PaymentsService } from '../payments/payments.service';
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
    @InjectRepository(User)
    private userRepo: Repository<User>,
    private eventsGateway: EventsGateway,
    private pushService: PushService,
    private emailService: EmailService,
    private paymentsService: PaymentsService,
    private configService: ConfigService,
  ) {
    const url = this.configService.get<string>('SUPABASE_URL');
    const key = this.configService.get<string>('SUPABASE_SERVICE_KEY');
    if (url && key) this.supabase = createClient(url, key);
  }

  // ─── Create Job ──────────────────────────────────────────────────────────

  async createJob(customerId: string, dto: Partial<Job>): Promise<Job> {
    const job = this.jobRepo.create({ ...dto, customerId, status: JobStatus.BIDDING });
    const saved = await this.jobRepo.save(job);

    // ── Broadcast new job to all connected transporters ──
    this.eventsGateway.broadcast('job:new', {
      jobId: saved.id,
      pickupState: saved.pickupState,
      deliveryState: saved.deliveryState,
      vehicleType: saved.vehicleType,
      message: 'New delivery job posted',
    });

    return saved;
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

    const allowedForRole = ROLE_PERMISSIONS[userRole] || [];
    if (!allowedForRole.includes(newStatus)) {
      throw new ForbiddenException(`Role '${userRole}' cannot set status to '${newStatus}'`);
    }

    const allowedNext = ALLOWED_TRANSITIONS[job.status] || [];
    if (!allowedNext.includes(newStatus)) {
      throw new BadRequestException(`Cannot move from '${job.status}' to '${newStatus}'`);
    }

    if (userRole === 'transporter' && job.transporterId !== userId) {
      throw new ForbiddenException('You are not assigned to this job');
    }
    if (userRole === 'customer' && job.customerId !== userId) {
      throw new ForbiddenException('This is not your job');
    }

    if (newStatus === JobStatus.DELIVERED && !job.proofOfDeliveryUrl) {
      throw new BadRequestException('Please upload proof of delivery photo before marking as delivered');
    }

    if (newStatus === JobStatus.DELIVERED && !job.otpVerified) {
      throw new BadRequestException('Please verify delivery PIN before marking as delivered');
    }

    const previousStatus = job.status;
    const route = `${job.pickupState} → ${job.deliveryState}`;

    await this.jobRepo.update(jobId, {
      status: newStatus,
      ...(newStatus === JobStatus.IN_TRANSIT && { pickedUpAt: new Date() }),
      ...(newStatus === JobStatus.DELIVERED  && { deliveredAt: new Date() }),
    });

    const updatedJob = await this.getJobById(jobId);
    this.logger.log(`Job ${jobId}: ${previousStatus} → ${newStatus}`);

    const eventPayload = {
      jobId, previousStatus, newStatus,
      updatedAt: new Date(), note: note || null,
      proofOfDeliveryUrl: updatedJob.proofOfDeliveryUrl || null,
    };

    // ── Socket notifications ──
    if (updatedJob.customerId) {
      this.eventsGateway.notifyUser(updatedJob.customerId, 'job:statusUpdate', {
        ...eventPayload, message: this.getCustomerMessage(newStatus),
      });
    }
    if (updatedJob.transporterId && updatedJob.transporterId !== userId) {
      this.eventsGateway.notifyUser(updatedJob.transporterId, 'job:statusUpdate', {
        ...eventPayload, message: this.getTransporterMessage(newStatus),
      });
    }

    // ── Delivered event + auto-release escrow ──
    if (newStatus === JobStatus.DELIVERED) {
      if (updatedJob.customerId) {
        this.eventsGateway.notifyUser(updatedJob.customerId, 'job:delivered', {
          jobId,
          message: 'Your delivery has been confirmed. Payment is being released to the transporter.',
        });
      }
      // Trac auto-releases the escrow — no customer action needed
      this.paymentsService.releaseEscrow(jobId).catch((err) => {
        this.logger.warn(`Auto-release failed for job ${jobId}: ${err?.message}`);
        // Non-blocking: job is marked delivered regardless; admin can manually trigger release
      });
    }

    // ── Push notifications ──
    if (newStatus === JobStatus.IN_TRANSIT && updatedJob.customerId) {
      await this.pushService.sendToUser(
        updatedJob.customerId,
        this.pushService.templates.jobPickedUp(route),
      ).catch(() => {});
    }

    if (newStatus === JobStatus.DELIVERED && updatedJob.customerId) {
      await this.pushService.sendToUser(
        updatedJob.customerId,
        this.pushService.templates.jobDelivered(route),
      ).catch(() => {});
    }

    if (newStatus === JobStatus.DELIVERED && updatedJob.transporterId) {
      await this.pushService.sendToUser(updatedJob.transporterId, {
        title: '✅ Delivery Confirmed',
        body: 'Delivery confirmed! Your payment will be released shortly.',
        url: '/dashboard/earnings',
        tag: 'delivered',
      }).catch(() => {});
    }

    if (newStatus === JobStatus.CANCELLED && updatedJob.transporterId) {
      await this.pushService.sendToUser(updatedJob.transporterId, {
        title: '⚠️ Job Cancelled',
        body: 'The job has been cancelled by the customer',
        url: '/dashboard/tracking',
        tag: 'cancelled',
      }).catch(() => {});
    }

    if (newStatus === JobStatus.DELIVERED) {
      try {
        const customer = await this.userRepo.findOne({ where: { id: job.customerId } });
        if (customer) {
          this.emailService.sendDeliveryConfirmedEmail(
            { fullName: customer.fullName, email: customer.email },
            {
              route: job.pickupState + ' → ' + job.deliveryState,
              amount: Number(job.acceptedAmount) || 0,
            },
          ).catch(() => {});
        }
      } catch {}
    }

    return updatedJob;
  }

  // ─── Generate Delivery OTP ────────────────────────────────────────────────

  async generateDeliveryOtp(jobId: string, transporterId: string): Promise<{ otp: string; message: string }> {
    const job = await this.getJobById(jobId);

    if (job.transporterId !== transporterId) {
      throw new ForbiddenException('You are not assigned to this job');
    }
    if (job.status !== JobStatus.IN_TRANSIT) {
      throw new BadRequestException('Job must be in-transit to generate PIN');
    }

    const pin = Math.floor(1000 + Math.random() * 9000).toString();

    await this.jobRepo.update(jobId, { deliveryOtp: pin, otpGeneratedAt: new Date() });

    if (job.customerId) {
      this.eventsGateway.notifyUser(job.customerId, 'otp:generated', {
        jobId,
        otp: pin,
        message: 'Your delivery PIN is ready. Share with driver AFTER receiving goods.',
      });
    }

    this.eventsGateway.notifyUser(transporterId, 'otp:generated:transporter', {
      jobId,
      otp: pin,
      message: 'PIN generated successfully. Ask customer for this PIN.',
    });

    return { otp: pin, message: 'PIN generated successfully' };
  }

  // ─── Verify Delivery OTP ──────────────────────────────────────────────────

  async verifyDeliveryOtp(jobId: string, transporterId: string, otp: string): Promise<{ verified: boolean; message: string }> {
    const job = await this.getJobById(jobId);

    if (job.transporterId !== transporterId) {
      throw new ForbiddenException('You are not assigned to this job');
    }
    if (job.status !== JobStatus.IN_TRANSIT) {
      throw new BadRequestException('Job must be in-transit to verify PIN');
    }
    if (otp !== job.deliveryOtp) {
      throw new BadRequestException('Invalid PIN. Please try again.');
    }

    await this.jobRepo.update(jobId, { otpVerified: true });

    if (job.customerId) {
      this.eventsGateway.notifyUser(job.customerId, 'otp:verified', {
        jobId,
        message: 'Delivery PIN verified. Your goods have been confirmed received.',
      });
    }

    return { verified: true, message: 'PIN verified successfully' };
  }

  // ─── Upload Proof of Delivery ─────────────────────────────────────────────

  async uploadProofOfDelivery(
    jobId: string,
    transporterId: string,
    fileBuffer: Buffer,
    mimeType: string,
    originalName: string,
  ): Promise<Job> {
    const job = await this.getJobById(jobId);

    if (job.transporterId !== transporterId) {
      throw new ForbiddenException('You are not assigned to this job');
    }
    if (job.status !== JobStatus.IN_TRANSIT) {
      throw new BadRequestException('Job must be in-transit to upload proof of delivery');
    }

    let proofUrl: string;

    if (this.supabase) {
      const ext = originalName.split('.').pop() || 'jpg';
      const fileName = `proof-${jobId}-${Date.now()}.${ext}`;

      const { error } = await this.supabase.storage
        .from('delivery-proofs')
        .upload(fileName, fileBuffer, { contentType: mimeType, upsert: true });

      if (error) {
        this.logger.error('Supabase upload error:', error.message);
        throw new BadRequestException('Failed to upload proof image');
      }

      const { data: urlData } = this.supabase.storage
        .from('delivery-proofs')
        .getPublicUrl(fileName);

      proofUrl = urlData.publicUrl;
    } else {
      proofUrl = `data:${mimeType};base64,${fileBuffer.toString('base64')}`;
      this.logger.warn('Supabase storage not configured — using base64 fallback');
    }

    await this.jobRepo.update(jobId, {
      proofOfDeliveryUrl: proofUrl,
      proofUploadedAt: new Date(),
    });

    const updatedJob = await this.getJobById(jobId);
    this.logger.log(`✅ Proof uploaded for job ${jobId}`);

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