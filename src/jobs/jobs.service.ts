// trac-backend/src/jobs/jobs.service.ts
// Day 27 + Real-time: Push notifications + socket broadcast

import {
  Injectable,
  NotFoundException,
  ForbiddenException,
  BadRequestException,
  ServiceUnavailableException,
  Logger,
} from '@nestjs/common';
import { randomInt } from 'crypto';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';
import { Job, JobStatus } from './entities/job.entity';
import { User } from '../users/entities/user.entity';
import { EventsGateway } from '../events/events.gateway';
import { PushService } from '../push/push.service';
import { EmailService } from '../email/email.service';
import { PaymentsService } from '../payments/payments.service';
import { createClient } from '@supabase/supabase-js';
import { ConfigService } from '@nestjs/config';

const ALLOWED_TRANSITIONS: Record<JobStatus, JobStatus[]> = {
  [JobStatus.PENDING]:    [JobStatus.BIDDING, JobStatus.CANCELLED],
  [JobStatus.BIDDING]:    [JobStatus.BID_SELECTED, JobStatus.CANCELLED],
  [JobStatus.BID_SELECTED]: [JobStatus.PAYMENT_PENDING, JobStatus.BIDDING, JobStatus.CANCELLED],
  [JobStatus.PAYMENT_PENDING]: [JobStatus.ACCEPTED, JobStatus.BID_SELECTED, JobStatus.BIDDING, JobStatus.CANCELLED],
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
    if (dto.disclaimerAccepted !== true || !dto.goodsCategory) {
      throw new BadRequestException('You must complete the goods declaration and accept the prohibited-items policy');
    }
    if (!dto.recipientName?.trim() || !dto.recipientPhone?.trim()) {
      throw new BadRequestException('Recipient name and phone number are required');
    }
    const cargoWeight = Number(dto.cargoWeight);
    const validVehicleTypes = new Set(['rider', 'van', 'truck-small', 'truck-medium', 'truck-large']);
    if (!Number.isFinite(cargoWeight) || cargoWeight <= 0) {
      throw new BadRequestException('Cargo weight must be greater than 0 kg');
    }
    if (!validVehicleTypes.has(String(dto.vehicleType || ''))) {
      throw new BadRequestException('Select a valid vehicle type');
    }
    await this.jobRepo.query(`
      CREATE TABLE IF NOT EXISTS platform_settings (
        key varchar(80) PRIMARY KEY,
        value jsonb NOT NULL,
        updated_at timestamptz NOT NULL DEFAULT now()
      )
    `);
    const rows = await this.jobRepo.query(
      "SELECT value FROM platform_settings WHERE key = 'maintenanceMode' LIMIT 1",
    );
    if (rows[0]?.value === true || rows[0]?.value === 'true') {
      throw new ServiceUnavailableException('New bookings are temporarily paused for maintenance');
    }
    const job = this.jobRepo.create({
      ...dto,
      customerId,
      status: JobStatus.BIDDING,
      goodsDeclared: true,
      disclaimerAccepted: true,
      disclaimerAcceptedAt: new Date(),
    });
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
      where: { transporterId, status: In([JobStatus.ACCEPTED, JobStatus.IN_TRANSIT, JobStatus.DELIVERED]) },
      order: { createdAt: 'DESC' },
    });
  }

  // ─── Get single job ───────────────────────────────────────────────────────

  async getJobById(jobId: string): Promise<Job> {
    const job = await this.jobRepo.findOne({ where: { id: jobId } });
    if (!job) throw new NotFoundException(`Job ${jobId} not found`);
    return job;
  }

  async updateTransporterLocation(
    jobId: string,
    transporterId: string,
    data: { lat: number; lng: number; accuracy?: number; speed?: number },
  ): Promise<{ ok: true; updatedAt: Date }> {
    const lat = Number(data.lat);
    const lng = Number(data.lng);
    if (!Number.isFinite(lat) || !Number.isFinite(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180) {
      throw new BadRequestException('Invalid location coordinates');
    }
    const job = await this.getJobById(jobId);
    if (job.transporterId !== transporterId) throw new ForbiddenException('You are not assigned to this job');
    if (job.status !== JobStatus.IN_TRANSIT) throw new BadRequestException('Job must be in transit to share location');
    const updatedAt = new Date();
    const accuracy = Number(data.accuracy);
    const speed = Number(data.speed);
    await this.jobRepo.update(jobId, {
      lastKnownLat: lat,
      lastKnownLng: lng,
      lastLocationAccuracy: Number.isFinite(accuracy) ? accuracy : null as any,
      lastLocationSpeed: Number.isFinite(speed) ? speed : null as any,
      lastLocationAt: updatedAt,
    });
    this.eventsGateway.notifyUser(job.customerId, 'job:locationUpdate', {
      jobId, lat, lng,
      accuracy: Number.isFinite(accuracy) ? accuracy : undefined,
      speed: Number.isFinite(speed) ? speed : undefined,
      updatedAt,
    });
    return { ok: true, updatedAt };
  }

  toClientJob(job: Job, includeDeliveryDetails = false, includeDeliveryOtp = includeDeliveryDetails): Record<string, any> {
    const safeParty = (user?: User) => user ? {
      id: user.id,
      fullName: user.fullName,
      rating: Number(user.rating || 0),
      totalRatings: user.totalRatings,
      tripsCompleted: user.tripsCompleted,
      avatarUrl: user.avatarUrl,
      vehicleType: user.vehicleType,
      state: user.state,
    } : undefined;
    const safeJob: Record<string, any> = {
      ...job,
      customer: safeParty(job.customer),
      transporter: safeParty(job.transporter),
    };
    if (!includeDeliveryDetails) {
      delete safeJob.disputeReason;
      delete safeJob.proofOfDeliveryUrl;
      delete safeJob.recipientName;
      delete safeJob.recipientPhone;
      delete safeJob.pickupNote;
      delete safeJob.deliveryNote;
    }
    if (!includeDeliveryOtp) delete safeJob.deliveryOtp;
    return safeJob;
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
      status: JobStatus.BID_SELECTED,
    });

    const updatedJob = await this.getJobById(jobId);
    this.logger.log(`Job ${jobId} assigned to transporter ${transporterId}`);

    if (updatedJob.customerId) {
      this.eventsGateway.notifyUser(updatedJob.customerId, 'job:statusUpdate', {
        jobId,
        previousStatus: JobStatus.BIDDING,
        newStatus: JobStatus.BID_SELECTED,
        message: 'Transporter selected. Complete payment to confirm the delivery.',
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

    if (newStatus === JobStatus.CANCELLED && job.status === JobStatus.PAYMENT_PENDING) {
      await this.paymentsService.cancelPendingPaymentsForJob(jobId, userId);
    }

    if (newStatus === JobStatus.IN_TRANSIT) {
      await this.paymentsService.assertEscrowPaid(jobId);
    }

    if (newStatus === JobStatus.DELIVERED && !job.proofOfDeliveryUrl) {
      throw new BadRequestException('Please upload proof of delivery photo before marking as delivered');
    }

    if (newStatus === JobStatus.DELIVERED && !job.otpVerified) {
      throw new BadRequestException('Please verify delivery PIN before marking as delivered');
    }

    const previousStatus = job.status;
    const route = `${job.pickupState} → ${job.deliveryState}`;

    // Auto-generate delivery PIN when transporter goes in-transit
    if (newStatus === JobStatus.IN_TRANSIT && !job.deliveryOtp) {
      const pin = randomInt(1000, 10000).toString();
      await this.jobRepo.update(jobId, {
        status: newStatus,
        pickedUpAt: new Date(),
        deliveryOtp: pin,
        otpGeneratedAt: new Date(),
        otpFailedAttempts: 0,
        otpLockedUntil: null as any,
      });
      if (job.customerId) {
        this.eventsGateway.notifyUser(job.customerId, 'otp:generated', {
          jobId, otp: pin,
          message: `Your delivery PIN is ${pin}. The driver will ask for it on arrival. Do NOT share early.`,
        });
        await this.pushService.sendToUser(job.customerId, {
          title: '📦 Your Delivery is On the Way!',
          body: `Delivery PIN: ${pin}. Share ONLY with driver when goods arrive.`,
          url: '/dashboard/tracking',
          tag: 'delivery-pin',
          icon: '/icons/icon-192x192.png',
        }).catch(() => {});
      }
      this.eventsGateway.notifyUser(userId, 'otp:generated:transporter', {
        jobId, message: 'Delivery PIN sent to customer. Ask them for it when you arrive.',
      });
    } else {
      await this.jobRepo.update(jobId, {
        status: newStatus,
        ...(newStatus === JobStatus.IN_TRANSIT && { pickedUpAt: new Date() }),
        ...(newStatus === JobStatus.DELIVERED  && { deliveredAt: new Date() }),
      });
    }

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

    // ── Delivered event — customer must confirm receipt to release payment ──
    if (newStatus === JobStatus.DELIVERED) {
      if (updatedJob.customerId) {
        this.eventsGateway.notifyUser(updatedJob.customerId, 'job:delivered', {
          jobId,
          message: 'Your goods have arrived! Please confirm receipt or raise a dispute.',
        });
        await this.pushService.sendToUser(updatedJob.customerId, {
          title: '📦 Goods Delivered!',
          body: 'Open Trac to confirm you received your goods and release payment to the driver.',
          url: '/dashboard/tracking',
          tag: 'confirm-receipt',
        }).catch(() => {});
      }
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

  async generateDeliveryOtp(jobId: string, transporterId: string): Promise<{ message: string }> {
    const job = await this.getJobById(jobId);

    if (job.transporterId !== transporterId) {
      throw new ForbiddenException('You are not assigned to this job');
    }
    if (job.status !== JobStatus.IN_TRANSIT) {
      throw new BadRequestException('Job must be in-transit to generate PIN');
    }
    if (job.otpGeneratedAt && Date.now() - new Date(job.otpGeneratedAt).getTime() < 60_000) {
      throw new BadRequestException('Please wait before generating another delivery PIN');
    }

    const pin = randomInt(1000, 10000).toString();
    await this.jobRepo.update(jobId, { deliveryOtp: pin, otpGeneratedAt: new Date(), otpFailedAttempts: 0, otpLockedUntil: null as any });

    // PIN goes to CUSTOMER only — transporter asks customer for it verbally at delivery
    if (job.customerId) {
      this.eventsGateway.notifyUser(job.customerId, 'otp:generated', {
        jobId,
        otp: pin,
        message: `Your delivery PIN is ${pin}. The driver will ask for it when goods arrive. Do NOT share before receiving.`,
      });
      await this.pushService.sendToUser(job.customerId, {
        title: '📦 Delivery PIN Ready',
        body: `Your delivery PIN is ${pin}. Share it with the driver ONLY after receiving your goods.`,
        url: '/dashboard/tracking',
        tag: 'delivery-pin',
        icon: '/icons/icon-192x192.png',
      }).catch(() => {});
    }

    // Transporter is NOT sent the PIN — only told to ask the customer
    this.eventsGateway.notifyUser(transporterId, 'otp:generated:transporter', {
      jobId,
      message: 'Delivery PIN sent to customer. Ask them for the PIN when you arrive.',
    });

    return { message: 'PIN sent to customer' };
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
    if (job.otpVerified) return { verified: true, message: 'PIN was already verified' };
    if (!job.otpGeneratedAt || Date.now() - new Date(job.otpGeneratedAt).getTime() > 24 * 60 * 60 * 1000) {
      throw new BadRequestException('Delivery PIN has expired. Generate a new PIN.');
    }
    if (job.otpLockedUntil && new Date(job.otpLockedUntil).getTime() > Date.now()) {
      throw new BadRequestException('Too many incorrect attempts. Try again later.');
    }
    if (!/^\d{4}$/.test(String(otp || ''))) throw new BadRequestException('PIN must contain exactly 4 digits');
    if (otp !== job.deliveryOtp) {
      const attempts = Number(job.otpFailedAttempts || 0) + 1;
      await this.jobRepo.update(jobId, {
        otpFailedAttempts: attempts,
        otpLockedUntil: attempts >= 5 ? new Date(Date.now() + 15 * 60 * 1000) : null as any,
      });
      throw new BadRequestException('Invalid PIN. Please try again.');
    }

    await this.jobRepo.update(jobId, { otpVerified: true, deliveryOtp: null as any, otpFailedAttempts: 0, otpLockedUntil: null as any });

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
    _originalName: string,
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
      const ext = ({ 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp' } as Record<string, string>)[mimeType] || 'jpg';
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

  // ─── Confirm Receipt ─────────────────────────────────────────────────────

  async confirmReceipt(jobId: string, customerId: string): Promise<{ message: string }> {
    const job = await this.getJobById(jobId);
    if (job.customerId !== customerId) throw new ForbiddenException('This is not your job');
    if (job.status !== JobStatus.DELIVERED) throw new BadRequestException('Job must be delivered first');
    if (job.disputeRaised) throw new BadRequestException('A dispute has been raised for this job');
    if (job.customerConfirmed) return { message: 'Receipt already confirmed' };

    await this.jobRepo.update(jobId, {
      customerConfirmed: true,
      customerConfirmedAt: new Date(),
    });

    // Customer confirmation completes the delivery, but the escrow remains
    // locked until an admin reviews the proof and approves withdrawal. The
    // 24-hour scheduler remains the fallback when no admin is available.
    if (job.transporterId) {
      this.eventsGateway.notifyUser(job.transporterId, 'payment:approvalPending', {
        jobId,
        message: 'Customer confirmed receipt. Your payment is awaiting withdrawal approval.',
      });
      await this.pushService.sendToUser(job.transporterId, {
        title: 'Delivery confirmed',
        body: 'Your payment is awaiting withdrawal approval. We will notify you when it is available.',
        url: '/dashboard/earnings',
        tag: 'payment-approval-pending',
      }).catch(() => {});
    }

    return { message: 'Receipt confirmed. Payment is awaiting withdrawal approval.' };
  }

  // ─── Raise Dispute ────────────────────────────────────────────────────────

  async raiseDispute(jobId: string, customerId: string, reason: string): Promise<{ message: string }> {
    const job = await this.getJobById(jobId);
    if (job.customerId !== customerId) throw new ForbiddenException('This is not your job');
    if (job.status !== JobStatus.DELIVERED) throw new BadRequestException('Job must be delivered to raise a dispute');
    if (job.customerConfirmed) throw new BadRequestException('You have already confirmed receipt');
    if (job.disputeRaised) return { message: 'Dispute already raised' };

    await this.jobRepo.update(jobId, {
      disputeRaised: true,
      disputeReason: reason,
      disputeRaisedAt: new Date(),
    });

    // Notify admin via email
    await this.emailService.sendDisputeEmail({
      jobId,
      customerId,
      customerName: job.customer?.fullName || 'Unknown',
      reason,
      route: `${job.pickupState} → ${job.deliveryState}`,
      amount: Number(job.acceptedAmount),
    }).catch(() => {});

    // Notify transporter
    if (job.transporterId) {
      this.eventsGateway.notifyUser(job.transporterId, 'job:dispute', {
        jobId,
        message: 'The customer has raised a dispute. Payment is frozen pending review.',
      });
    }

    return { message: 'Dispute raised. Our team will review and contact you within 24 hours.' };
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
