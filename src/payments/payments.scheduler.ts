import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, LessThan } from 'typeorm';
import { Job, JobStatus } from '../jobs/entities/job.entity';
import { Payment, PaymentStatus } from './entities/payment.entity';
import { PaymentsService } from './payments.service';

@Injectable()
export class PaymentsScheduler {
  private readonly logger = new Logger(PaymentsScheduler.name);

  constructor(
    @InjectRepository(Job)   private jobRepo: Repository<Job>,
    @InjectRepository(Payment) private paymentRepo: Repository<Payment>,
    private paymentsService: PaymentsService,
  ) {}

  @Cron(CronExpression.EVERY_HOUR)
  async recoverAbandonedPayments(): Promise<void> {
    const cutoff = new Date(Date.now() - 30 * 60 * 1000);
    const pending = await this.paymentRepo.find({ where: { status: PaymentStatus.PENDING, createdAt: LessThan(cutoff) } });
    for (const payment of pending) {
      await this.paymentsService.cancelPendingPayment(payment.reference, payment.customerId).catch(() => {});
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
        where: { jobId: job.id, status: PaymentStatus.SUCCESS },
      });

      if (!payment) continue;

      this.logger.log(`🔓 Auto-releasing escrow for job ${job.id}`);

      try {
        await this.paymentsService.releaseEscrow(job.id);
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
