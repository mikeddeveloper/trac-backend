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
import { Job, JobStatus } from '../jobs/entities/job.entity';
import { User } from '../users/entities/user.entity';
import { EventsGateway } from '../events/events.gateway';
import { PushService } from '../push/push.service';
import { EmailService } from '../email/email.service';

@Injectable()
export class PaymentsService {
  private readonly logger = new Logger(PaymentsService.name);
  private readonly paystackUrl = 'https://api.paystack.co';

  private readonly CASHBACK_RATE = 0.015;
  private readonly CASHBACK_MIN  = 10_000;
  private readonly VAT_RATE      = 0.075;

  private commissionRate(distanceKm?: number): number {
    if (!distanceKm || distanceKm < 10) return 0.10;
    if (distanceKm <= 30)               return 0.09;
    return 0.08;
  }

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

  private async getAvailablePaystackBalanceKobo(): Promise<number> {
    try {
      const response = await axios.get(`${this.paystackUrl}/balance`, { headers: this.headers });
      const balances = Array.isArray(response.data?.data) ? response.data.data : [];
      const naira = balances.find((entry: any) => entry.currency === 'NGN');
      if (!naira || !Number.isFinite(Number(naira.balance))) {
        throw new Error('NGN balance was not returned');
      }
      return Number(naira.balance);
    } catch (error) {
      this.logger.error('Paystack balance check failed', (error as any)?.response?.data || (error as any)?.message);
      throw new BadRequestException('Could not confirm the payout balance. Please try again shortly.');
    }
  }

  async assertEscrowPaid(jobId: string): Promise<void> {
    const payment = await this.paymentRepo.findOne({
      where: [
        { jobId, type: PaymentType.ESCROW, status: PaymentStatus.SUCCESS },
        { jobId, type: PaymentType.ESCROW, status: PaymentStatus.HELD },
        { jobId, type: PaymentType.ESCROW, status: PaymentStatus.RELEASED },
      ],
      order: { createdAt: 'DESC' },
    });
    if (!payment) throw new BadRequestException('Payment must be confirmed in escrow before this delivery can start');
  }

  private async activatePaidJob(payment: Payment): Promise<void> {
    const job = await this.jobRepo.findOne({ where: { id: payment.jobId } });
    if (!job || !job.transporterId || [JobStatus.ACCEPTED, JobStatus.IN_TRANSIT, JobStatus.DELIVERED, JobStatus.CANCELLED].includes(job.status)) return;
    await this.jobRepo.update(job.id, { status: JobStatus.ACCEPTED });
    const payload = { jobId: job.id, previousStatus: job.status, newStatus: JobStatus.ACCEPTED, message: 'Payment confirmed. Delivery is ready for pickup.', updatedAt: new Date() };
    this.eventsGateway.notifyUser(job.customerId, 'job:statusUpdate', payload);
    this.eventsGateway.notifyUser(job.transporterId, 'job:statusUpdate', payload);
    this.eventsGateway.notifyUser(job.transporterId, 'payment:confirmed:transporter', {
      jobId: job.id, amount: payment.amount, reference: payment.reference,
      message: `Customer has paid ₦${Number(payment.amount).toLocaleString()}. Proceed to pickup!`,
    });
    await this.pushService.sendToUser(job.transporterId, {
      title: '💰 Payment Confirmed', body: `Customer paid ₦${Number(payment.amount).toLocaleString()}. Head to pickup now!`,
      url: '/dashboard/tracking', tag: 'payment', icon: '/icons/icon-192x192.png',
    }).catch(() => {});
  }

  async cancelPendingPayment(reference: string, customerId: string): Promise<{ status: string; jobId: string }> {
    const payment = await this.paymentRepo.findOne({ where: { reference, customerId, type: PaymentType.ESCROW } });
    if (!payment) throw new NotFoundException('Payment not found');
    if ([PaymentStatus.SUCCESS, PaymentStatus.HELD, PaymentStatus.RELEASED].includes(payment.status)) {
      throw new BadRequestException('A confirmed payment cannot be cancelled');
    }
    await this.paymentRepo.update(payment.id, { status: PaymentStatus.FAILED, authorizationUrl: null as any });
    const job = await this.jobRepo.findOne({ where: { id: payment.jobId } });
    if (job?.status === JobStatus.PAYMENT_PENDING) {
      await this.jobRepo.update(job.id, { status: JobStatus.BID_SELECTED });
      this.eventsGateway.notifyUser(job.customerId, 'job:statusUpdate', { jobId: job.id, previousStatus: JobStatus.PAYMENT_PENDING, newStatus: JobStatus.BID_SELECTED, message: 'Payment was not completed. You can try again.', updatedAt: new Date() });
    }
    return { status: 'cancelled', jobId: payment.jobId };
  }

  async cancelPendingPaymentsForJob(jobId: string, customerId: string): Promise<void> {
    await this.paymentRepo.update(
      { jobId, customerId, type: PaymentType.ESCROW, status: PaymentStatus.PENDING },
      { status: PaymentStatus.FAILED, authorizationUrl: null as any },
    );
  }

  // ─── Initialize Payment ─────────────────────────────────────────────────────

  async initializePayment(
    email: string,
    jobId: string,
    customerId: string,
  ) {
    const job = await this.jobRepo.findOne({ where: { id: jobId } });
    if (!job) throw new NotFoundException('Job not found');
    if (job.customerId !== customerId) throw new UnauthorizedException('This job does not belong to you');
    if (!job.acceptedAmount || Number(job.acceptedAmount) <= 0) {
      throw new BadRequestException('This job does not have an accepted bid');
    }
    if (![JobStatus.BID_SELECTED, JobStatus.PAYMENT_PENDING].includes(job.status)) {
      throw new BadRequestException('Select a transporter bid before starting payment');
    }

    const existing = await this.paymentRepo.findOne({
      where: { jobId, customerId, type: PaymentType.ESCROW },
      order: { createdAt: 'DESC' },
    });
    if (existing && existing.status !== PaymentStatus.FAILED) {
      if (existing.status === PaymentStatus.PENDING && existing.authorizationUrl) {
        return {
          authorizationUrl: existing.authorizationUrl,
          reference: existing.reference,
          vatAmount: existing.vatAmount,
          totalCharged: Number(existing.amount),
        };
      }
      throw new BadRequestException('Payment has already been initialized for this job');
    }

    const amount = Number(job.acceptedAmount);
    const currency = 'NGN';
    const reference  = `TRAC-${jobId}-${Date.now()}`;
    const breakdown  = this.calculatePayout(amount, job.distanceKm ? Number(job.distanceKm) : undefined);
    // VAT is 7.5% on Trac's commission only — borne by Trac, not added to customer's bill
    const vatAmount  = breakdown.vatOnCommission;
    // Customer pays the agreed delivery amount only
    const totalCharged = amount;

    try {
      const response = await axios.post(
        `${this.paystackUrl}/transaction/initialize`,
        {
          email,
          amount: Math.round(totalCharged * 100),
          reference,
          callback_url: `${this.configService.get('FRONTEND_URL') || 'https://traclogistics.com.ng'}/dashboard/payments`,
          metadata: { jobId, customerId },
        },
        { headers: this.headers },
      );

      const { authorization_url, access_code } = response.data.data;
      const payment = this.paymentRepo.create({
        reference,
        amount,
        currency,
        status: PaymentStatus.PENDING,
        type: PaymentType.ESCROW,
        authorizationUrl: authorization_url,
        jobId,
        customerId,
        tracCommission: breakdown.tracCommission,
        transporterPayout: breakdown.transporterPayout,
        customerCashback: breakdown.customerCashback,
        vatAmount,
      });
      await this.paymentRepo.save(payment);

      await this.jobRepo.update(jobId, { status: JobStatus.PAYMENT_PENDING });
      this.eventsGateway.notifyUser(customerId, 'job:statusUpdate', {
        jobId, previousStatus: job.status, newStatus: JobStatus.PAYMENT_PENDING,
        message: 'Payment is awaiting confirmation', updatedAt: new Date(),
      });

      return { authorizationUrl: authorization_url, reference, accessCode: access_code, vatAmount, totalCharged };
    } catch (error) {
      this.logger.error('initializePayment error', (error as any)?.response?.data || (error as any)?.message);
      throw new BadRequestException('Payment initialization failed');
    }
  }

  // ─── Verify Payment ─────────────────────────────────────────────────────────

  async verifyPayment(reference: string, customerId: string) {
    const payment = await this.paymentRepo.findOne({ where: { reference } });
    if (!payment || payment.customerId !== customerId) {
      throw new NotFoundException('Payment not found');
    }
    try {
      const response = await axios.get(
        `${this.paystackUrl}/transaction/verify/${reference}`,
        { headers: this.headers },
      );
      const data = response.data.data;

      const amountMatches = Number(data.amount) === Math.round(Number(payment.amount) * 100);
      const currencyMatches = data.currency === payment.currency;
      const referenceMatches = data.reference === payment.reference;
      if (!amountMatches || !currencyMatches || !referenceMatches) {
        this.logger.error(`Payment verification mismatch for ${reference}`);
        throw new BadRequestException('Payment details did not match the expected transaction');
      }

      if (data.status === 'success') {
        await this.paymentRepo.update(
          { reference },
          {
            status: PaymentStatus.SUCCESS,
            paidAt: new Date(data.paid_at),
            paystackMeta: data,
          },
        );
        await this.activatePaidJob({ ...payment, status: PaymentStatus.SUCCESS, paidAt: new Date(data.paid_at), paystackMeta: data });
      } else if (['abandoned', 'failed', 'reversed'].includes(data.status)) {
        await this.cancelPendingPayment(reference, customerId);
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
        await this.handleTransferFailure(event.data, event.event);
        break;
    }
  }

  private async handleChargeSuccess(data: any): Promise<void> {
    const { reference, amount, paid_at, metadata } = data;
    this.logger.log(`✅ charge.success: ref=${reference}`);

    const payment = await this.paymentRepo.findOne({ where: { reference } });
    if (!payment) {
      this.logger.warn(`Ignoring charge.success for unknown reference ${reference}`);
      return;
    }

    if (
      Number(amount) !== Math.round(Number(payment.amount) * 100) ||
      data.currency !== payment.currency ||
      metadata?.jobId !== payment.jobId ||
      metadata?.customerId !== payment.customerId
    ) {
      this.logger.error(`Ignoring mismatched charge.success for ${reference}`);
      return;
    }

    if (payment.status === PaymentStatus.SUCCESS) return;

    await this.paymentRepo.update({ reference }, {
      status: PaymentStatus.SUCCESS,
      paidAt: new Date(paid_at),
      paystackMeta: data,
    });
    await this.activatePaidJob({ ...payment, status: PaymentStatus.SUCCESS, paidAt: new Date(paid_at), paystackMeta: data });

    this.logger.log(`💰 Payment ${reference} → SUCCESS`);

    if (payment.customerId) {
      this.eventsGateway.notifyUser(payment.customerId, 'payment:confirmed', {
        reference, amount: payment.amount, status: PaymentStatus.SUCCESS,
        paidAt: new Date(),
        message: `Payment of ₦${Number(payment.amount).toLocaleString()} confirmed and held in escrow`,
      });
    }

    const job = await this.paymentRepo.manager.findOne('Job', { where: { id: payment.jobId } }) as any;

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
        const transporter = await this.userRepo.findOne({ where: { id: job.transporterId } });
        if (transporter && typeof this.emailService.sendActivityEmail === 'function') await this.emailService.sendActivityEmail(
          transporter,
          'Your Trac payment has been disbursed',
          'Payment disbursed',
          `NGN ${amount} has been released to your registered bank account.`,
          undefined,
          'View Earnings',
        );
      }
    }
  }

  private async handleTransferFailure(data: any, eventName: string): Promise<void> {
    const release = await this.paymentRepo.findOne({ where: { reference: data.reference } });
    if (!release) return;
    await this.paymentRepo.update(release.id, { status: PaymentStatus.FAILED, paystackMeta: data });
    if (release.jobId) {
      await this.paymentRepo.update(
        { jobId: release.jobId, type: PaymentType.ESCROW, status: PaymentStatus.HELD },
        { status: PaymentStatus.RELEASED },
      );
    }
    this.logger.warn(`${eventName}: ref=${data.reference}`);
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

  // ─── Release Escrow (customer confirms delivery) ────────────────────────────
  // Marks payment as available for transporter withdrawal — no Paystack call here.
  // Transporter initiates the actual bank transfer from their Earnings page.

  async releaseEscrow(jobId: string, customerId?: string): Promise<{ message: string }> {
    const job = await this.jobRepo.findOne({ where: { id: jobId } });
    if (!job) throw new NotFoundException('Job not found');
    if (customerId && job.customerId !== customerId) {
      throw new UnauthorizedException('This job does not belong to you');
    }
    if (
      job.status !== JobStatus.DELIVERED ||
      !job.otpVerified ||
      (customerId !== undefined && !job.customerConfirmed)
    ) {
      throw new BadRequestException('Delivery must be completed and confirmed with the delivery PIN');
    }
    if (job.disputeRaised) throw new BadRequestException('Payout is frozen while this job is disputed');

    const payment = await this.paymentRepo.findOne({
      where: [
        { jobId, status: PaymentStatus.SUCCESS },
        { jobId, status: PaymentStatus.HELD },
        { jobId, status: PaymentStatus.RELEASED },
      ],
    });

    if (!payment) throw new NotFoundException('No confirmed payment found for this job');
    if (payment.status === PaymentStatus.RELEASED) return { message: 'Payment already released' };

    await this.paymentRepo.update(payment.id, { status: PaymentStatus.RELEASED });
    this.logger.log(`✅ Escrow released for job ${jobId} — available for withdrawal`);

    // Notify transporter
    if (job?.transporterId) {
      const amount = Number(payment.transporterPayout || payment.amount).toLocaleString('en-NG');
      this.eventsGateway.notifyUser(job.transporterId, 'payment:available', {
        jobId,
        amount: payment.transporterPayout,
        message: `₦${amount} is now available! Go to Earnings to withdraw.`,
      });
      await this.pushService.sendToUser(job.transporterId, {
        title: '💰 Payment Available!',
        body: `₦${amount} is ready to withdraw for your delivery.`,
        url: '/dashboard/earnings',
        tag: 'payout',
        icon: '/icons/icon-192x192.png',
      }).catch(() => {});
    }

    return { message: 'Payment released. Transporter can now withdraw from their Earnings page.' };
  }

  // ─── Withdraw Earnings (transporter initiates payout) ───────────────────────
  // Called when transporter clicks Withdraw on the Earnings page.
  // This is where the actual Paystack transfer happens.

  async withdrawEarnings(jobId: string, transporterId: string): Promise<{ message: string }> {
    const payment = await this.paymentRepo.findOne({
      where: { jobId, status: PaymentStatus.RELEASED, type: PaymentType.ESCROW },
    });

    if (!payment) throw new NotFoundException('No available payout found for this job. Ensure the customer has confirmed delivery.');

    const job = await this.jobRepo.findOne({ where: { id: jobId } });
    if (!job || job.transporterId !== transporterId) throw new UnauthorizedException('This job does not belong to you');

    const transporter = await this.userRepo.findOne({ where: { id: transporterId } });
    const recipientCode = transporter?.recipientCode;
    if (!recipientCode) throw new BadRequestException('Please add your bank account in Earnings before withdrawing.');

    const previousRelease = await this.paymentRepo.findOne({ where: { jobId, type: PaymentType.RELEASE } });
    if (previousRelease && previousRelease.status !== PaymentStatus.FAILED) {
      throw new BadRequestException('A withdrawal has already been initiated for this job');
    }

    const fallbackBreakdown = this.calculatePayout(
      Number(payment.amount),
      job.distanceKm ? Number(job.distanceKm) : undefined,
    );
    const payoutAmount = Number(payment.transporterPayout) || fallbackBreakdown.transporterPayout;
    const payoutKobo = Math.round(payoutAmount * 100);
    const availableBalanceKobo = await this.getAvailablePaystackBalanceKobo();
    if (availableBalanceKobo < payoutKobo) {
      throw new BadRequestException('Payout is temporarily unavailable because the transfer balance needs to be topped up.');
    }

    const claimed = await this.paymentRepo.update(
      { id: payment.id, status: PaymentStatus.RELEASED },
      { status: PaymentStatus.HELD },
    );
    if (!claimed.affected) throw new BadRequestException('This payout is already being processed');

    const transferRef = `trac_payout_${jobId.replace(/-/g, '').slice(0, 18)}_${Date.now()}`;
    const releaseRecord = this.paymentRepo.create({
      reference: transferRef,
      amount: payoutAmount,
      status: PaymentStatus.PENDING,
      type: PaymentType.RELEASE,
      jobId,
      customerId: payment.customerId,
      tracCommission: payment.tracCommission,
      transporterPayout: payoutAmount,
      customerCashback: payment.customerCashback,
    });

    try {
      await this.paymentRepo.save(releaseRecord);
      const transferResponse = await axios.post(
        `${this.paystackUrl}/transfer`,
        {
          source: 'balance',
          amount: payoutKobo,
          recipient: recipientCode,
          reason: `Trac payout for job ${jobId}`,
          reference: transferRef,
        },
        { headers: this.headers },
      );

      if (transferResponse.data?.status !== true || transferResponse.data?.data?.status === 'otp') {
        throw new Error(
          transferResponse.data?.data?.status === 'otp'
            ? 'Paystack transfer confirmation OTP is still enabled'
            : transferResponse.data?.message || 'Paystack rejected the transfer',
        );
      }

      this.logger.log(`💸 Withdrawal initiated: ₦${payoutAmount} → ${recipientCode}`);

      await this.paymentRepo.update(releaseRecord.id, { paystackMeta: transferResponse.data?.data });
      if (transporter && typeof this.emailService.sendActivityEmail === 'function') await this.emailService.sendActivityEmail(
        transporter,
        'Your Trac withdrawal is being processed',
        'Withdrawal initiated',
        `Your withdrawal of NGN ${payoutAmount.toLocaleString('en-NG')} has been submitted to your bank. We will notify you when it is disbursed.`,
        undefined,
        'View Earnings',
      );

      return { message: `₦${payoutAmount.toLocaleString('en-NG')} withdrawal initiated. Arrives in your bank shortly.` };
    } catch (error) {
      if (releaseRecord.id) {
        await this.paymentRepo.update(releaseRecord.id, {
          status: PaymentStatus.FAILED,
          paystackMeta: (error as any)?.response?.data || { message: (error as any)?.message },
        });
      }
      await this.paymentRepo.update(
        { id: payment.id, status: PaymentStatus.HELD },
        { status: PaymentStatus.RELEASED },
      );
      const paystackError = (error as any)?.response?.data;
      const errorMsg = paystackError?.message || (error as any)?.message || 'Unknown error';
      this.logger.error(`❌ withdrawEarnings failed for job ${jobId}: ${errorMsg}`);
      throw new BadRequestException(`Withdrawal failed: ${errorMsg}. Ensure your Paystack balance has sufficient funds.`);
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

  calculatePayout(totalAmount: number, distanceKm?: number) {
    const rate              = this.commissionRate(distanceKm);
    const tracCommission    = +(totalAmount * rate).toFixed(2);
    const vatOnCommission   = +(tracCommission * this.VAT_RATE).toFixed(2);
    const transporterPayout = +(totalAmount * (1 - rate)).toFixed(2);
    const customerCashback  = totalAmount >= this.CASHBACK_MIN
      ? +(totalAmount * this.CASHBACK_RATE).toFixed(2) : 0;
    return { total: totalAmount, tracCommission, vatOnCommission, transporterPayout, customerCashback, commissionRate: rate };
  }

  // ─── Get transactions ────────────────────────────────────────────────────────

  async getTransactionsByUser(userId: string, role: 'customer' | 'transporter') {
    if (role === 'customer') {
      return this.paymentRepo.find({ where: { customerId: userId }, order: { createdAt: 'DESC' }, take: 50 });
    }
    return this.paymentRepo
      .createQueryBuilder('payment')
      .innerJoin('jobs', 'job', 'job.id = payment.jobId')
      .where('job.transporterId = :userId', { userId })
      .orderBy('payment.createdAt', 'DESC')
      .take(50)
      .getMany();
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
    const payments = await this.paymentRepo
      .createQueryBuilder('payment')
      .innerJoin('jobs', 'job', 'job.id = payment.jobId')
      .where('job.transporterId = :transporterId', { transporterId })
      .andWhere('payment.type = :type', { type: PaymentType.ESCROW })
      .getMany();

    // Jobs to include route info for available payments
    const availablePayments = payments.filter(p => p.status === PaymentStatus.RELEASED);
    const jobIds = availablePayments.map(p => p.jobId).filter(Boolean);
    let jobMap: Record<string, any> = {};
    if (jobIds.length > 0) {
      const jobs = await this.jobRepo.findByIds(jobIds);
      jobMap = Object.fromEntries(jobs.map(j => [j.id, j]));
    }

    const pendingPayout = payments
      .filter(p => p.status === PaymentStatus.SUCCESS)
      .reduce((s, p) => s + Number(p.transporterPayout || 0), 0);

    const availableToWithdraw = availablePayments
      .reduce((s, p) => s + Number(p.transporterPayout || 0), 0);

    const totalEarned = payments
      .filter(p => p.status === PaymentStatus.HELD)
      .reduce((s, p) => s + Number(p.transporterPayout || 0), 0);

    const totalCommissionPaid = payments
      .filter(p => p.status === PaymentStatus.HELD)
      .reduce((s, p) => s + Number(p.tracCommission || 0), 0);

    return {
      totalEarned,
      pendingPayout,
      availableToWithdraw,
      availableJobs: availablePayments.map(p => ({
        jobId: p.jobId,
        amount: Number(p.transporterPayout || 0),
        route: jobMap[p.jobId]
          ? `${jobMap[p.jobId].pickupState} → ${jobMap[p.jobId].deliveryState}`
          : 'Delivery',
        paidAt: p.paidAt,
      })),
      totalCommissionPaid,
      totalJobs: payments.length,
    };
  }

}
