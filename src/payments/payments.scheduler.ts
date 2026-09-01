import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, LessThan } from 'typeorm';
import { Job, JobStatus } from '../jobs/entities/job.entity';
import { Payment, PaymentStatus, PaymentType } from './entities/payment.entity';
import { PaymentsService } from './payments.service';

@Injectable()
export class PaymentsScheduler {
  private readonly logger = new Logger(PaymentsScheduler.name);

  constructor(
    @InjectRepository(Job)   private jobRepo: Repository<Job>,
    @InjectRepository(Payment) private paymentRepo: Repository<Payment>,
    private paymentsService: PaymentsService,
  ) {}

  @Cron(CronExpression.EVERY_10_MINUTES)
  async reconcilePendingPayments(): Promise<void> {
    const cutoff = new Date(Date.now() - 10 * 60 * 1000);
    const pending = await this.paymentRepo.find({
      where: {
        status: PaymentStatus.PENDING,
        type: PaymentType.ESCROW,
        createdAt: LessThan(cutoff),
      },
    });
    for (const payment of pending) {
      // Never mark a transaction failed merely because the webhook was delayed.
      // Ask Paystack for the authoritative status; verifyPayment activates a
      // successful job and only cancels statuses Paystack confirms as terminal.
      await this.paymentsService.verifyPayment(payment.reference, payment.customerId)
        .catch((error: any) => this.logger.warn(
          `Payment reconciliation deferred for ${payment.reference}: ${error?.message || 'verification unavailable'}`,
        ));
    }
  }

  @Cron(CronExpression.EVERY_HOUR)
  async autoReleaseStaleEscrows(): Promise<void> {
    const cutoff = new Date(Date.now() - 24 * 60 * 60 * 1000);

    const staleJobs = await this.jobRepo.find({
      where: { status: JobStatus.DELIVERED, deliveredAt: LessThan(cutoff) },
    });

    if (staleJobs.length === 0) return;

    this.logger.log(`⏰ Auto-release: ${staleJobs.length} stale job(s) found`);

    for (const job of staleJobs) {
      const payment = await this.paymentRepo.findOne({
        where: { jobId: job.id, status: PaymentStatus.HELD },
      });

      if (!payment) continue;

      this.logger.log(`🔓 Auto-releasing escrow for job ${job.id}`);

      try {
        if (!job.transporterId) continue;
        await this.paymentsService.approveWithdrawal(job.id, job.transporterId);
        this.logger.log(`✅ Auto-released job ${job.id}`);
      } catch (err: any) {
        if (err?.message?.includes('bank account')) {
          this.logger.warn(`⚠️  Job ${job.id}: transporter has no bank account — skipping`);
        } else {
          this.logger.error(`❌ Auto-release failed for job ${job.id}: ${err?.message}`);
        }
      }
    }
  }
}
