// trac-backend/src/payments/payments.service.ts
// Day 19: Escrow release — transfer to transporter via Paystack

import {
  Injectable,
  BadRequestException,
  Logger,
  UnauthorizedException,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { ConfigService } from '@nestjs/config';
import axios from 'axios';
import * as crypto from 'crypto';
import { Payment, PaymentStatus, PaymentType } from './entities/payment.entity';
import { Job } from '../jobs/entities/job.entity';
import { User } from '../users/entities/user.entity';
import { EventsGateway } from '../events/events.gateway';
import { PushService } from '../push/push.service';
import { EmailService } from '../email/email.service';

@Injectable()
export class PaymentsService {
  private readonly logger = new Logger(PaymentsService.name);
  private readonly paystackUrl = 'https://api.paystack.co';

  private readonly TRAC_COMMISSION   = 0.10;
  private readonly TRANSPORTER_SHARE = 0.90;
  private readonly CASHBACK_RATE     = 0.015;
  private readonly CASHBACK_MIN      = 10_000;
  private readonly VAT_RATE          = 0.075;

  constructor(
    private configService: ConfigService,
    @InjectRepository(Payment)
    private paymentRepo: Repository<Payment>,
    @InjectRepository(Job)
    private jobRepo: Repository<Job>,
    @InjectRepository(User)
    private userRepo: Repository<User>,
    private eventsGateway: EventsGateway,
    private pushService: PushService,
    private emailService: EmailService,
  ) {}

  private get headers() {
    return {
      Authorization: `Bearer ${this.configService.get('PAYSTACK_SECRET_KEY')}`,
      'Content-Type': 'application/json',
    };
  }

  // ─── Initialize Payment ─────────────────────────────────────────────────────

  async initializePayment(
    email: string,
    amount: number,
    jobId: string,
    metadata: Record<string, any> = {},
    currency: string = 'NGN',
  ) {
    const reference    = `TRAC-${jobId}-${Date.now()}`;
    const vatAmount    = +(amount * this.VAT_RATE).toFixed(2);
    const totalCharged = +(amount + vatAmount).toFixed(2);

    try {
      const response = await axios.post(
        `${this.paystackUrl}/transaction/initialize`,
        {
          email,
          amount: Math.round(totalCharged * 100),
          reference,
          callback_url: `${this.configService.get('FRONTEND_URL') || 'https://trac-logistics-web-app.vercel.app'}/dashboard/payments`,
          metadata: { jobId, ...metadata },
        },
        { headers: this.headers },
      );

      const { authorization_url, access_code } = response.data.data;
      const breakdown = this.calculatePayout(amount);

      const payment = this.paymentRepo.create({
        reference,
        amount,
        currency,
        status: PaymentStatus.PENDING,
        type: PaymentType.ESCROW,
        authorizationUrl: authorization_url,
        jobId,
        customerId: metadata.customerId,
        tracCommission: breakdown.tracCommission,
        transporterPayout: breakdown.transporterPayout,
        customerCashback: breakdown.customerCashback,
        vatAmount,
      });
      await this.paymentRepo.save(payment);

      return { authorizationUrl: authorization_url, reference, accessCode: access_code, vatAmount, totalCharged };
    } catch (error) {
      this.logger.error('initializePayment error', (error as any)?.response?.data || (error as any)?.message);
      throw new BadRequestException('Payment initialization failed');
    }
  }

  // ─── Verify Payment ─────────────────────────────────────────────────────────

  async verifyPayment(reference: string) {
    try {
      const response = await axios.get(
        `${this.paystackUrl}/transaction/verify/${reference}`,
        { headers: this.headers },
      );
      const data = response.data.data;

      if (data.status === 'success') {
        await this.paymentRepo.update(
          { reference },
          {
            status: PaymentStatus.SUCCESS,
            paidAt: new Date(data.paid_at),
            paystackMeta: data,
          },
        );
      }

      return {
        status: data.status,
        amount: data.amount / 100,
        reference: data.reference,
        paidAt: data.paid_at,
        metadata: data.metadata,
      };
    } catch (error) {
      this.logger.error('verifyPayment error', (error as any)?.response?.data || (error as any)?.message);
      throw new BadRequestException('Payment verification failed');
    }
  }

  // ─── Webhook Handler ────────────────────────────────────────────────────────

  async handleWebhook(rawBody: Buffer, signature: string): Promise<void> {
    const secret = this.configService.get<string>('PAYSTACK_SECRET_KEY');

    if (!secret) throw new UnauthorizedException('Webhook config error');
    if (!signature) throw new UnauthorizedException('Missing signature');

    const hash = crypto.createHmac('sha512', secret).update(rawBody).digest('hex');
    if (hash !== signature) {
      this.logger.warn('⚠️ Webhook signature mismatch');
      throw new UnauthorizedException('Invalid webhook signature');
    }

    const event = JSON.parse(rawBody.toString());
    this.logger.log(`📩 Webhook: ${event.event}`);

    switch (event.event) {
      case 'charge.success':
        await this.handleChargeSuccess(event.data);
        break;
      case 'transfer.success':
        await this.handleTransferSuccess(event.data);
        break;
      case 'transfer.failed':
      case 'transfer.reversed':
        this.logger.warn(`Transfer event: ${event.event}`);
        break;
    }
  }

  private async handleChargeSuccess(data: any): Promise<void> {
    const { reference, amount, paid_at, metadata } = data;
    this.logger.log(`✅ charge.success: ref=${reference}`);

    const payment = await this.paymentRepo.findOne({ where: { reference } });

    if (!payment) {
      const amountNaira = amount / 100;
      const breakdown = this.calculatePayout(amountNaira);
      const newPayment = this.paymentRepo.create({
        reference, amount: amountNaira,
        status: PaymentStatus.SUCCESS, type: PaymentType.ESCROW,
        jobId: metadata?.jobId, customerId: metadata?.customerId,
        paidAt: new Date(paid_at), paystackMeta: data,
        tracCommission: breakdown.tracCommission,
        transporterPayout: breakdown.transporterPayout,
        customerCashback: breakdown.customerCashback,
      });
      await this.paymentRepo.save(newPayment);
      return;
    }

    if (payment.status === PaymentStatus.SUCCESS) return;

    await this.paymentRepo.update({ reference }, {
      status: PaymentStatus.SUCCESS,
      paidAt: new Date(paid_at),
      paystackMeta: data,
    });

    this.logger.log(`💰 Payment ${reference} → SUCCESS`);

    if (payment.customerId) {
      this.eventsGateway.notifyUser(payment.customerId, 'payment:confirmed', {
        reference, amount: payment.amount, status: PaymentStatus.SUCCESS,
        paidAt: new Date(),
        message: `Payment of ₦${Number(payment.amount).toLocaleString()} confirmed and held in escrow`,
      });
    }

    const job = await this.paymentRepo.manager.findOne('Job', { where: { id: payment.jobId } }) as any;
    if (job?.transporterId) {
      this.eventsGateway.notifyUser(job.transporterId, 'payment:confirmed:transporter', {
        jobId: payment.jobId,
        amount: payment.amount,
        message: `Customer has paid ₦${Number(payment.amount).toLocaleString()}. Proceed to pickup!`,
        reference: payment.reference,
      });
      await this.pushService.sendToUser(job.transporterId, {
        title: '💰 Payment Confirmed',
        body: `Customer paid ₦${Number(payment.amount).toLocaleString()}. Head to pickup now!`,
        url: '/dashboard/tracking',
        tag: 'payment',
        icon: '/icons/icon-192x192.png',
      }).catch(() => {});
    }

    try {
      const customer = job ? await this.paymentRepo.manager.findOne('User', { where: { id: job.customerId } }) as any : null;
      if (customer) {
        this.emailService.sendPaymentConfirmedEmail(
          { fullName: customer.fullName, email: customer.email },
          {
            amount: payment.amount,
            route: job ? job.pickupState + ' → ' + job.deliveryState : 'N/A',
          },
        ).catch(() => {});
      }
    } catch {}
  }

  private async handleTransferSuccess(data: any): Promise<void> {
    const { reference } = data;
    this.logger.log(`🏦 transfer.success: ref=${reference}`);
    await this.paymentRepo.update({ reference }, { status: PaymentStatus.RELEASED });

    const payment = await this.paymentRepo.findOne({ where: { reference } });
    if (payment?.jobId) {
      const job = await this.paymentRepo.manager.findOne('Job', { where: { id: payment.jobId } }) as any;
      if (job?.transporterId) {
        const amount = Number(payment.transporterPayout || payment.amount).toLocaleString('en-NG');
        this.eventsGateway.notifyUser(job.transporterId, 'payment:released', {
          amount: payment.transporterPayout || payment.amount,
          message: `₦${amount} has been released to your account.`,
        });
        await this.pushService.sendToUser(job.transporterId,
          this.pushService.templates.payoutReleased(amount),
        ).catch(() => {});
      }
    }
  }

  // ─── Create Paystack Transfer Recipient ─────────────────────────────────────
  // Called when transporter adds their bank account

  async createTransferRecipient(
    accountName: string,
    accountNumber: string,
    bankCode: string,
    userId?: string,
  ): Promise<string> {
    try {
      const response = await axios.post(
        `${this.paystackUrl}/transferrecipient`,
        {
          type: 'nuban',
          name: accountName,
          account_number: accountNumber,
          bank_code: bankCode,
          currency: 'NGN',
        },
        { headers: this.headers },
      );
      const recipientCode: string = response.data.data.recipient_code;
      // Persist on the user record so auto-release can find it without frontend involvement
      if (userId) {
        await this.userRepo.update(userId, { recipientCode } as any);
      }
      return recipientCode;
    } catch (error) {
      this.logger.error('createRecipient error', (error as any)?.response?.data);
      throw new BadRequestException('Failed to create transfer recipient');
    }
  }

  // ─── Release Escrow to Transporter ──────────────────────────────────────────
  // Day 19 core feature
  // Called when customer confirms delivery
  // Sends 90% to transporter, keeps 10% as Trac commission

  async releaseEscrow(jobId: string, transporterRecipientCode?: string): Promise<Payment> {
    // Find the payment for this job
    const payment = await this.paymentRepo.findOne({
      where: { jobId, status: PaymentStatus.SUCCESS },
    });

    if (!payment) {
      const heldPayment = await this.paymentRepo.findOne({
        where: { jobId, status: PaymentStatus.HELD },
      });
      if (!heldPayment) throw new NotFoundException('No confirmed payment found for this job');
    }

    const escrowPayment = payment || await this.paymentRepo.findOne({ where: { jobId } });
    if (!escrowPayment) throw new NotFoundException('Payment not found');

    // Auto-look up the transporter's recipient code if not supplied
    if (!transporterRecipientCode) {
      const job = await this.jobRepo.findOne({ where: { id: jobId } });
      if (job?.transporterId) {
        const transporter = await this.userRepo.findOne({ where: { id: job.transporterId } });
        transporterRecipientCode = transporter?.recipientCode ?? undefined;
      }
    }

    if (!transporterRecipientCode) {
      throw new BadRequestException(
        'Transporter has not set up a bank account for payouts. Please ask them to add their bank details in the Earnings page.',
      );
    }

    const payoutAmount = escrowPayment.transporterPayout || Number(escrowPayment.amount) * this.TRANSPORTER_SHARE;
    const payoutKobo = Math.round(payoutAmount * 100);

    const transferRef = `TRAC-PAYOUT-${jobId}-${Date.now()}`;

    try {
      // Initiate Paystack transfer
      await axios.post(
        `${this.paystackUrl}/transfer`,
        {
          source: 'balance',
          amount: payoutKobo,
          recipient: transporterRecipientCode,
          reason: `Trac Marketplace payout for job ${jobId}`,
          reference: transferRef,
        },
        { headers: this.headers },
      );

      this.logger.log(`💸 Transfer initiated: ₦${payoutAmount} to ${transporterRecipientCode}`);

      // Update payment status to held (pending transfer confirmation)
      await this.paymentRepo.update(escrowPayment.id, {
        status: PaymentStatus.HELD,
      });

      // Create a release payment record
      const releasePayment = this.paymentRepo.create({
        reference: transferRef,
        amount: payoutAmount,
        status: PaymentStatus.PENDING,
        type: PaymentType.RELEASE,
        jobId,
        customerId: escrowPayment.customerId,
        tracCommission: escrowPayment.tracCommission,
        transporterPayout: payoutAmount,
        customerCashback: escrowPayment.customerCashback,
      });
      await this.paymentRepo.save(releasePayment);

      return releasePayment;
    } catch (error) {
      const paystackError = (error as any)?.response?.data;
      const errorMsg = paystackError?.message || (error as any)?.message || 'Unknown error';
      const errorCode = paystackError?.code;
      this.logger.error(
        `❌ releaseEscrow failed for job ${jobId}: [${errorCode}] ${errorMsg}`,
        JSON.stringify(paystackError ?? {}),
      );
      throw new BadRequestException(
        `Transfer failed: ${errorMsg}. ` +
        `Check your Paystack dashboard — ensure Transfer OTP is disabled (Settings → Preferences) ` +
        `and your test balance is funded.`,
      );
    }
  }

  // ─── Get Nigerian Banks ──────────────────────────────────────────────────────

  async getBanks(): Promise<any[]> {
    try {
      const response = await axios.get(
        `${this.paystackUrl}/bank?country=nigeria&perPage=100`,
        { headers: this.headers },
      );
      return response.data.data;
    } catch {
      return [];
    }
  }

  // ─── Verify Bank Account ─────────────────────────────────────────────────────

  async verifyBankAccount(accountNumber: string, bankCode: string) {
    try {
      const response = await axios.get(
        `${this.paystackUrl}/bank/resolve?account_number=${accountNumber}&bank_code=${bankCode}`,
        { headers: this.headers },
      );
      return response.data.data;
    } catch {
      throw new BadRequestException('Could not verify bank account');
    }
  }

  // ─── Commission Calculator ───────────────────────────────────────────────────

  calculatePayout(totalAmount: number) {
    const tracCommission    = +(totalAmount * this.TRAC_COMMISSION).toFixed(2);
    const transporterPayout = +(totalAmount * this.TRANSPORTER_SHARE).toFixed(2);
    const customerCashback  = totalAmount >= this.CASHBACK_MIN
      ? +(totalAmount * this.CASHBACK_RATE).toFixed(2) : 0;
    return { total: totalAmount, tracCommission, transporterPayout, customerCashback };
  }

  // ─── Get transactions ────────────────────────────────────────────────────────

  async getTransactionsByUser(userId: string, role: 'customer' | 'transporter') {
    const where = role === 'customer' ? { customerId: userId } : {};
    return this.paymentRepo.find({ where, order: { createdAt: 'DESC' }, take: 50 });
  }

  // ─── Get wallet balance ──────────────────────────────────────────────────────

  async getWalletBalance(userId: string) {
    const payments = await this.paymentRepo.find({ where: { customerId: userId } });
    const escrowHeld  = payments.filter(p => p.status === PaymentStatus.HELD || p.status === PaymentStatus.SUCCESS).reduce((s, p) => s + Number(p.amount), 0);
    const totalSpent  = payments.filter(p => p.status === PaymentStatus.RELEASED).reduce((s, p) => s + Number(p.amount), 0);
    const totalCashback = payments.filter(p => p.customerCashback).reduce((s, p) => s + Number(p.customerCashback), 0);
    return { escrowHeld, totalSpent, totalCashback };
  }

  // ─── Get transporter earnings ────────────────────────────────────────────────

  async getTransporterEarnings(transporterId: string) {
    // Get all payments for jobs assigned to this transporter
    const payments = await this.paymentRepo
      .createQueryBuilder('payment')
      .innerJoin('jobs', 'job', 'job.id = payment.jobId')
      .where('job.transporterId = :transporterId', { transporterId })
      .getMany();

    const totalEarned = payments
      .filter(p => p.status === PaymentStatus.RELEASED)
      .reduce((s, p) => s + Number(p.transporterPayout || 0), 0);

    const pendingPayout = payments
      .filter(p => p.status === PaymentStatus.SUCCESS || p.status === PaymentStatus.HELD)
      .reduce((s, p) => s + Number(p.transporterPayout || 0), 0);

    const totalCommissionPaid = payments
      .filter(p => p.status === PaymentStatus.RELEASED)
      .reduce((s, p) => s + Number(p.tracCommission || 0), 0);

    return {
      totalEarned,
      pendingPayout,
      totalCommissionPaid,
      totalJobs: payments.length,
    };
  }

  // ─── Simulate Release (test mode only) ──────────────────────────────────────

  async simulateRelease(transporterId: string): Promise<{ released: number; count: number }> {
    // Find all escrow-held payments for this transporter's jobs
    const payments = await this.paymentRepo
      .createQueryBuilder('payment')
      .innerJoin('jobs', 'job', 'job.id = payment.jobId')
      .where('job.transporterId = :transporterId', { transporterId })
      .andWhere('payment.status IN (:...statuses)', {
        statuses: [PaymentStatus.SUCCESS, PaymentStatus.HELD, PaymentStatus.PENDING],
      })
      .getMany();

    if (payments.length === 0) return { released: 0, count: 0 };

    let totalReleased = 0;

    for (const payment of payments) {
      await this.paymentRepo.update(payment.id, { status: PaymentStatus.RELEASED });
      const payout = Number(payment.transporterPayout || payment.amount);
      totalReleased += payout;

      // Fire the same socket + push as a real transfer.success webhook
      const amount = payout.toLocaleString('en-NG');
      this.eventsGateway.notifyUser(transporterId, 'payment:released', {
        amount: payout,
        message: `₦${amount} has been released to your account.`,
      });
      await this.pushService.sendToUser(
        transporterId,
        this.pushService.templates.payoutReleased(amount),
      ).catch(() => {});
    }

    this.logger.log(`🧪 [TEST] Simulated release of ₦${totalReleased} across ${payments.length} payment(s) for transporter ${transporterId}`);
    return { released: totalReleased, count: payments.length };
  }
}