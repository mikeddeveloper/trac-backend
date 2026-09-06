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
import { User, UserRole } from '../users/entities/user.entity';
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

  private commissionRate(_distanceKm?: number): number {
    // The platform default is a fixed 10%. Distance affects delivery pricing,
    // not Trac's commission. An explicit admin setting may override this.
    return 0.10;
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

  private async ensureWalletTables(): Promise<void> {
    await this.paymentRepo.query(`
      CREATE TABLE IF NOT EXISTS wallet_accounts (
        "userId" uuid PRIMARY KEY,
        "balance" numeric(14,2) NOT NULL DEFAULT 0 CHECK ("balance" >= 0),
        "createdAt" timestamptz NOT NULL DEFAULT now(),
        "updatedAt" timestamptz NOT NULL DEFAULT now()
      );
      CREATE TABLE IF NOT EXISTS wallet_entries (
        "reference" varchar(160) PRIMARY KEY,
        "userId" uuid NOT NULL,
        "amount" numeric(14,2) NOT NULL CHECK ("amount" > 0),
        "direction" varchar(10) NOT NULL CHECK ("direction" IN ('credit','debit')),
        "kind" varchar(30) NOT NULL,
        "status" varchar(15) NOT NULL DEFAULT 'pending',
        "jobId" uuid NULL,
        "metadata" jsonb NULL,
        "createdAt" timestamptz NOT NULL DEFAULT now(),
        "completedAt" timestamptz NULL
      );
      CREATE INDEX IF NOT EXISTS "IDX_wallet_entries_user_created" ON wallet_entries ("userId", "createdAt" DESC);
    `);
  }

  async creditSignupLaunchBonus(user: Pick<User, 'id' | 'role' | 'fullName' | 'email'>): Promise<boolean> {
    if (![UserRole.CUSTOMER, UserRole.TRANSPORTER].includes(user.role)) return false;
    await this.ensureWalletTables();
    const amount = 500;
    const credited = await this.paymentRepo.manager.transaction(async manager => {
      await manager.query(`SELECT pg_advisory_xact_lock(hashtext('trac-launch-bonus-2026'))`);
      const countRows = await manager.query(`
        SELECT COUNT(*)::int AS count
        FROM wallet_entries entry
        INNER JOIN users u ON u.id = entry."userId"
        WHERE entry.kind = 'launch_bonus' AND entry.status = 'success' AND u.role = $1
      `, [user.role]);
      if (Number(countRows[0]?.count || 0) >= 50) return false;

      const reference = `LAUNCH-BONUS-2026-${user.id}`;
      const result = await manager.query(`
        WITH credited AS (
          INSERT INTO wallet_entries
            ("reference", "userId", "amount", "direction", "kind", "status", "metadata", "completedAt")
          VALUES ($1, $2, $3, 'credit', 'launch_bonus', 'success', $4::jsonb, now())
          ON CONFLICT ("reference") DO NOTHING
          RETURNING "userId", "amount"
        )
        INSERT INTO wallet_accounts ("userId", "balance")
        SELECT "userId", "amount" FROM credited
        ON CONFLICT ("userId") DO UPDATE
          SET "balance" = wallet_accounts."balance" + EXCLUDED."balance", "updatedAt" = now()
        RETURNING "userId"
      `, [reference, user.id, amount, JSON.stringify({ campaign: 'launch-2026', usage: 'delivery_only', cashWithdrawable: false, awardedAtSignup: true })]);
      return result.length > 0;
    });
    if (credited) {
      this.eventsGateway.notifyUser(user.id, 'wallet:credited', { amount, kind: 'launch_bonus', usage: 'delivery_only' });
      void this.emailService.sendActivityEmail(
        user,
        'Your NGN 500 Trac wallet bonus is ready',
        'Welcome bonus received',
        'We credited NGN 500 to your Trac wallet. This promotional credit can be used toward delivery payments and cannot be withdrawn as cash.',
        'https://traclogistics.com.ng/dashboard/payments',
        'View wallet',
      ).then(result => {
        if (!result.success) this.logger.error(`Launch bonus email was not delivered to ${user.email}`);
      }).catch((error: Error) => {
        this.logger.error(`Launch bonus email failed for ${user.email}: ${error.message}`);
      });
    }
    return credited;
  }

  async initializeWalletTopup(email: string, userId: string, requestedAmount: number) {
    const amount = Number(requestedAmount);
    if (!Number.isFinite(amount) || amount < 100 || amount > 5_000_000 || Math.round(amount * 100) !== amount * 100) {
      throw new BadRequestException('Top-up amount must be between NGN 100 and NGN 5,000,000');
    }
    await this.ensureWalletTables();
    const reference = `TRAC-WALLET-${userId}-${Date.now()}`;
    await this.paymentRepo.query(
      `INSERT INTO wallet_entries ("reference", "userId", "amount", "direction", "kind", "status", "metadata") VALUES ($1,$2,$3,'credit','topup','pending',$4)`,
      [reference, userId, amount, JSON.stringify({ purpose: 'wallet_topup' })],
    );
    try {
      const response = await axios.post(`${this.paystackUrl}/transaction/initialize`, {
        email,
        amount: Math.round(amount * 100),
        reference,
        callback_url: `${this.configService.get('FRONTEND_URL') || 'https://traclogistics.com.ng'}/dashboard/payments?wallet_topup=1`,
        metadata: { purpose: 'wallet_topup', customerId: userId },
      }, { headers: this.headers });
      if (response.data?.status !== true) throw new Error(response.data?.message || 'Paystack rejected the top-up');
      return {
        authorizationUrl: response.data.data.authorization_url,
        accessCode: response.data.data.access_code,
        reference,
        amount,
      };
    } catch (error) {
      await this.paymentRepo.query(`UPDATE wallet_entries SET "status"='failed' WHERE "reference"=$1`, [reference]);
      this.logger.error('Wallet top-up initialization failed', (error as any)?.response?.data || (error as any)?.message);
      throw new BadRequestException('Wallet top-up initialization failed');
    }
  }

  private async creditVerifiedTopup(data: any, expectedUserId?: string): Promise<boolean> {
    await this.ensureWalletTables();
    const rows = await this.paymentRepo.query(`SELECT * FROM wallet_entries WHERE "reference"=$1 AND "kind"='topup'`, [data.reference]);
    const entry = rows[0];
    if (!entry || (expectedUserId && entry.userId !== expectedUserId)) return false;
    if (entry.status === 'success') return true;
    const valid = data.status === 'success'
      && Number(data.amount) === Math.round(Number(entry.amount) * 100)
      && data.currency === 'NGN'
      && data.metadata?.purpose === 'wallet_topup'
      && data.metadata?.customerId === entry.userId;
    if (!valid) return false;
    await this.paymentRepo.manager.transaction(async manager => {
      const locked = (await manager.query(`SELECT * FROM wallet_entries WHERE "reference"=$1 FOR UPDATE`, [data.reference]))[0];
      if (!locked || locked.status === 'success') return;
      await manager.query(`INSERT INTO wallet_accounts ("userId", "balance") VALUES ($1,0) ON CONFLICT ("userId") DO NOTHING`, [entry.userId]);
      await manager.query(`UPDATE wallet_accounts SET "balance"="balance"+$1, "updatedAt"=now() WHERE "userId"=$2`, [entry.amount, entry.userId]);
      await manager.query(`UPDATE wallet_entries SET "status"='success', "completedAt"=now(), "metadata"=$2 WHERE "reference"=$1`, [data.reference, JSON.stringify(data)]);
    });
    this.eventsGateway.notifyUser(entry.userId, 'wallet:credited', { amount: Number(entry.amount), reference: entry.reference });
    return true;
  }

  private async creditDeliveryCashback(payment: Payment): Promise<void> {
    const amount = Number(payment.customerCashback || 0);
    if (!payment.customerId || amount <= 0) return;
    await this.ensureWalletTables();
    const reference = `CASHBACK-${payment.reference}`;
    await this.paymentRepo.manager.transaction(async manager => {
      const exists = (await manager.query(`SELECT "reference" FROM wallet_entries WHERE "reference"=$1 FOR UPDATE`, [reference]))[0];
      if (exists) return;
      await manager.query(`INSERT INTO wallet_accounts ("userId", "balance") VALUES ($1,0) ON CONFLICT ("userId") DO NOTHING`, [payment.customerId]);
      await manager.query(`UPDATE wallet_accounts SET "balance"="balance"+$1, "updatedAt"=now() WHERE "userId"=$2`, [amount, payment.customerId]);
      await manager.query(`INSERT INTO wallet_entries ("reference", "userId", "amount", "direction", "kind", "status", "jobId", "metadata", "completedAt") VALUES ($1,$2,$3,'credit','cashback','success',$4,$5,now())`, [reference, payment.customerId, amount, payment.jobId, JSON.stringify({ paymentReference: payment.reference })]);
    });
    this.eventsGateway.notifyUser(payment.customerId, 'wallet:credited', { amount, reference, kind: 'cashback' });
  }

  async verifyWalletTopup(reference: string, userId: string) {
    await this.ensureWalletTables();
    const existing = (await this.paymentRepo.query(`SELECT * FROM wallet_entries WHERE "reference"=$1 AND "userId"=$2 AND "kind"='topup'`, [reference, userId]))[0];
    if (!existing) throw new NotFoundException('Wallet top-up not found');
    if (existing.status === 'success') return { status: 'success', reference, amount: Number(existing.amount), purpose: 'wallet_topup' };
    try {
      const response = await axios.get(`${this.paystackUrl}/transaction/verify/${encodeURIComponent(reference)}`, { headers: this.headers });
      const credited = await this.creditVerifiedTopup(response.data?.data, userId);
      return { status: credited ? 'success' : response.data?.data?.status || 'pending', reference, amount: Number(existing.amount), purpose: 'wallet_topup' };
    } catch (error) {
      this.logger.error('Wallet top-up verification failed', (error as any)?.response?.data || (error as any)?.message);
      throw new BadRequestException('Wallet top-up verification failed');
    }
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
    if (!payment) throw new BadRequestException('Payment must be confirmed before this delivery can start');
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
    useWallet = false,
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

    if (useWallet) {
      await this.ensureWalletTables();
      const reference = `TRAC-WALLET-PAY-${jobId}-${Date.now()}`;
      const payment = await this.paymentRepo.manager.transaction(async manager => {
        await manager.query(`INSERT INTO wallet_accounts ("userId", "balance") VALUES ($1,0) ON CONFLICT ("userId") DO NOTHING`, [customerId]);
        const account = (await manager.query(`SELECT "balance" FROM wallet_accounts WHERE "userId"=$1 FOR UPDATE`, [customerId]))[0];
        if (Number(account?.balance || 0) < totalCharged) throw new BadRequestException('Your Trac Balance is insufficient for this payment');
        await manager.query(`UPDATE wallet_accounts SET "balance"="balance"-$1, "updatedAt"=now() WHERE "userId"=$2`, [totalCharged, customerId]);
        await manager.query(`INSERT INTO wallet_entries ("reference", "userId", "amount", "direction", "kind", "status", "jobId", "metadata", "completedAt") VALUES ($1,$2,$3,'debit','escrow_payment','success',$4,$5,now())`, [reference, customerId, totalCharged, jobId, JSON.stringify({ purpose: 'escrow_payment' })]);
        const created = manager.create(Payment, {
          reference, amount, currency, status: PaymentStatus.SUCCESS, type: PaymentType.ESCROW,
          jobId, customerId, tracCommission: breakdown.tracCommission,
          transporterPayout: breakdown.transporterPayout, customerCashback: breakdown.customerCashback,
          vatAmount, paidAt: new Date(), paystackMeta: { source: 'wallet', walletReference: reference },
        });
        await manager.save(created);
        return created;
      });
      await this.activatePaidJob(payment);
      this.eventsGateway.notifyUser(customerId, 'payment:confirmed', { reference, amount, status: 'success', paidAt: new Date(), jobId, message: `Payment of NGN ${amount.toLocaleString()} from Trac Balance is secured for this delivery` });
      return { status: 'success', paidWith: 'wallet', reference, vatAmount, totalCharged, jobId };
    }

    try {
      const response = await axios.post(
        `${this.paystackUrl}/transaction/initialize`,
        {
          email,
          amount: Math.round(totalCharged * 100),
          reference,
          callback_url: `${this.configService.get('FRONTEND_URL') || 'https://traclogistics.com.ng'}/dashboard/payments`,
          metadata: {
            jobId,
            customerId,
            custom_fields: [{
              display_name: 'Payment purpose',
              variable_name: 'payment_purpose',
              value: 'Secure Trac delivery payment',
            }],
          },
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
    if ([PaymentStatus.SUCCESS, PaymentStatus.HELD, PaymentStatus.RELEASED].includes(payment.status)) {
      return { status: payment.status, amount: Number(payment.amount), reference: payment.reference, paidAt: payment.paidAt };
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
      const metadataMatches = data.metadata?.jobId === payment.jobId && data.metadata?.customerId === payment.customerId;
      if (!amountMatches || !currencyMatches || !referenceMatches || !metadataMatches) {
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
    const expected = Buffer.from(hash, 'hex');
    const received = /^[a-f0-9]{128}$/i.test(signature) ? Buffer.from(signature, 'hex') : Buffer.alloc(0);
    if (received.length !== expected.length || !crypto.timingSafeEqual(expected, received)) {
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
      case 'refund.pending':
      case 'refund.processing':
      case 'refund.needs-attention':
      case 'refund.processed':
      case 'refund.failed':
        await this.handleRefundEvent(event.data, event.event);
        break;
    }
  }

  async initiateRefund(paymentId: string, reason = 'Refund approved by Trac support'): Promise<{ message: string; status: string }> {
    const payment = await this.paymentRepo.findOne({ where: { id: paymentId } });
    if (!payment) throw new NotFoundException('Payment not found');
    if (payment.type !== PaymentType.ESCROW) throw new BadRequestException('Only the original delivery payment can be refunded');
    if (payment.status === PaymentStatus.REFUNDED) return { message: 'Payment has already been refunded', status: 'refunded' };
    if (payment.status === PaymentStatus.RELEASED) throw new BadRequestException('Payment has already been released to the transporter');
    if (![PaymentStatus.SUCCESS, PaymentStatus.HELD].includes(payment.status)) {
      throw new BadRequestException('Only a confirmed payment can be refunded');
    }

    if ((payment.paystackMeta as any)?.source === 'wallet') {
      await this.ensureWalletTables();
      const refundReference = `WALLET-REFUND-${payment.reference}`;
      await this.paymentRepo.manager.transaction(async manager => {
        const already = (await manager.query(`SELECT "reference" FROM wallet_entries WHERE "reference"=$1 FOR UPDATE`, [refundReference]))[0];
        if (already) return;
        await manager.query(`INSERT INTO wallet_accounts ("userId", "balance") VALUES ($1,0) ON CONFLICT ("userId") DO NOTHING`, [payment.customerId]);
        await manager.query(`UPDATE wallet_accounts SET "balance"="balance"+$1, "updatedAt"=now() WHERE "userId"=$2`, [payment.amount, payment.customerId]);
        await manager.query(`INSERT INTO wallet_entries ("reference", "userId", "amount", "direction", "kind", "status", "jobId", "metadata", "completedAt") VALUES ($1,$2,$3,'credit','refund','success',$4,$5,now())`, [refundReference, payment.customerId, payment.amount, payment.jobId, JSON.stringify({ originalReference: payment.reference, reason })]);
        await manager.update(Payment, payment.id, { status: PaymentStatus.REFUNDED });
      });
      this.eventsGateway.notifyUser(payment.customerId, 'payment:refunded', { amount: Number(payment.amount), reference: refundReference, message: `NGN ${Number(payment.amount).toLocaleString()} was returned to your Trac Balance.` });
      return { message: 'Refund returned to the customer Trac Balance', status: 'refunded' };
    }

    const existing = await this.paymentRepo.findOne({
      where: { jobId: payment.jobId, type: PaymentType.REFUND },
      order: { createdAt: 'DESC' },
    });
    if (existing && existing.status !== PaymentStatus.FAILED) {
      return {
        message: existing.status === PaymentStatus.REFUNDED ? 'Payment has already been refunded' : 'Refund is already being processed',
        status: existing.status === PaymentStatus.REFUNDED ? 'refunded' : 'pending',
      };
    }

    const refund = this.paymentRepo.create({
      reference: `REFUND-${payment.reference}-${Date.now()}`,
      amount: Number(payment.amount),
      currency: payment.currency,
      status: PaymentStatus.PENDING,
      type: PaymentType.REFUND,
      customerId: payment.customerId,
      jobId: payment.jobId,
      paystackMeta: { originalReference: payment.reference, reason },
    });
    await this.paymentRepo.save(refund);

    try {
      const response = await axios.post(
        `${this.paystackUrl}/refund`,
        {
          transaction: payment.reference,
          customer_note: reason,
          merchant_note: `Trac refund for job ${payment.jobId}`,
        },
        { headers: this.headers },
      );
      if (response.data?.status !== true) throw new Error(response.data?.message || 'Paystack rejected the refund');

      const paystackStatus = String(response.data?.data?.status || 'pending');
      const completed = paystackStatus === 'processed';
      await this.paymentRepo.update(refund.id, {
        status: completed ? PaymentStatus.REFUNDED : PaymentStatus.PENDING,
        paystackMeta: { ...refund.paystackMeta, ...response.data.data },
      });
      if (completed) await this.completeRefund(payment, response.data.data);

      return {
        message: completed ? 'Refund completed successfully' : 'Refund submitted to Paystack and is being processed',
        status: completed ? 'refunded' : 'pending',
      };
    } catch (error) {
      await this.paymentRepo.update(refund.id, {
        status: PaymentStatus.FAILED,
        paystackMeta: { ...refund.paystackMeta, error: (error as any)?.response?.data || (error as any)?.message },
      });
      const message = (error as any)?.response?.data?.message || (error as any)?.message || 'Refund could not be initiated';
      this.logger.error(`Refund initiation failed for ${payment.reference}: ${message}`);
      throw new BadRequestException(`Refund failed: ${message}`);
    }
  }

  private async handleRefundEvent(data: any, eventName: string): Promise<void> {
    const originalReference = data.transaction_reference || data.transaction?.reference;
    if (!originalReference) return;
    const payment = await this.paymentRepo.findOne({ where: { reference: originalReference, type: PaymentType.ESCROW } });
    if (!payment) {
      this.logger.warn(`Ignoring ${eventName} for unknown transaction ${originalReference}`);
      return;
    }
    const refund = await this.paymentRepo.findOne({
      where: { jobId: payment.jobId, type: PaymentType.REFUND },
      order: { createdAt: 'DESC' },
    });
    if (!refund) {
      this.logger.warn(`Ignoring ${eventName}; no local refund exists for ${originalReference}`);
      return;
    }

    if (eventName === 'refund.processed') {
      await this.paymentRepo.update(refund.id, { status: PaymentStatus.REFUNDED, paystackMeta: data });
      await this.completeRefund(payment, data);
    } else if (eventName === 'refund.failed') {
      await this.paymentRepo.update(refund.id, { status: PaymentStatus.FAILED, paystackMeta: data });
      if (payment.customerId) {
        this.eventsGateway.notifyUser(payment.customerId, 'payment:refundFailed', {
          amount: payment.amount,
          message: 'Your refund could not be processed. Trac support has been notified.',
        });
      }
    } else {
      await this.paymentRepo.update(refund.id, { status: PaymentStatus.PENDING, paystackMeta: data });
    }
  }

  private async completeRefund(payment: Payment, paystackMeta: any): Promise<void> {
    if (payment.status === PaymentStatus.REFUNDED) return;
    await this.paymentRepo.update(payment.id, { status: PaymentStatus.REFUNDED });
    if (!payment.customerId) return;
    const amount = Number(payment.amount).toLocaleString('en-NG');
    this.eventsGateway.notifyUser(payment.customerId, 'payment:refunded', {
      amount: payment.amount,
      reference: paystackMeta?.refund_reference || paystackMeta?.id,
      message: `Your refund of ₦${amount} has been processed to your original payment method.`,
    });
    await this.pushService.sendToUser(payment.customerId, {
      title: 'Refund processed',
      body: `Your ₦${amount} refund has been processed. Your bank may take several business days to reflect it.`,
      url: '/dashboard/payments',
      tag: 'payment-refunded',
      icon: '/icons/icon-192x192.png',
    }).catch(() => {});
  }

  private async handleChargeSuccess(data: any): Promise<void> {
    const { reference } = data;
    this.logger.log(`✅ charge.success: ref=${reference}`);

    if (data.metadata?.purpose === 'wallet_topup') {
      const credited = await this.creditVerifiedTopup(data);
      if (!credited) this.logger.error(`Ignoring invalid wallet top-up ${reference}`);
      return;
    }

    const payment = await this.paymentRepo.findOne({ where: { reference } });
    if (!payment) {
      this.logger.warn(`Ignoring charge.success for unknown reference ${reference}`);
      return;
    }

    // A valid webhook signature proves who sent the event. Verifying the
    // reference with Paystack also proves its current status and canonical
    // amount/metadata before Trac changes financial state.
    const verification = await axios.get(
      `${this.paystackUrl}/transaction/verify/${encodeURIComponent(reference)}`,
      { headers: this.headers },
    );
    const verified = verification.data?.data;
    if (!verified || verified.status !== 'success') {
      this.logger.warn(`Ignoring unconfirmed charge.success for ${reference}`);
      return;
    }

    const { amount, paid_at, metadata } = verified;

    if (
      Number(amount) !== Math.round(Number(payment.amount) * 100) ||
      verified.reference !== payment.reference ||
      verified.currency !== payment.currency ||
      metadata?.jobId !== payment.jobId ||
      metadata?.customerId !== payment.customerId
    ) {
      this.logger.error(`Ignoring mismatched charge.success for ${reference}`);
      return;
    }

    if ([PaymentStatus.SUCCESS, PaymentStatus.HELD, PaymentStatus.RELEASED].includes(payment.status)) {
      // Replays are idempotent, but can safely repair a job whose earlier
      // state transition was interrupted after the payment was recorded.
      await this.activatePaidJob(payment);
      return;
    }

    await this.paymentRepo.update({ reference }, {
      status: PaymentStatus.SUCCESS,
      paidAt: new Date(paid_at),
      paystackMeta: verified,
    });
    await this.activatePaidJob({ ...payment, status: PaymentStatus.SUCCESS, paidAt: new Date(paid_at), paystackMeta: verified });

    this.logger.log(`💰 Payment ${reference} → SUCCESS`);

    if (payment.customerId) {
      this.eventsGateway.notifyUser(payment.customerId, 'payment:confirmed', {
        reference, amount: payment.amount, status: PaymentStatus.SUCCESS,
        paidAt: new Date(),
        message: `Payment of ₦${Number(payment.amount).toLocaleString()} confirmed and secured`,
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
        { jobId: release.jobId, type: PaymentType.ESCROW, status: PaymentStatus.RELEASED },
        { status: PaymentStatus.HELD },
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
    if (payment.status === PaymentStatus.RELEASED) {
      await this.creditDeliveryCashback(payment);
      return { message: 'Payment already released' };
    }

    await this.paymentRepo.update(payment.id, { status: PaymentStatus.RELEASED });
    await this.creditDeliveryCashback(payment);
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
  // Called when the transporter asks to withdraw. This records the request;
  // the actual Paystack transfer is initiated only after admin approval.
  async withdrawEarnings(jobId: string, transporterId: string): Promise<{ message: string }> {
    const payment = await this.paymentRepo.findOne({
      where: { jobId, status: PaymentStatus.SUCCESS, type: PaymentType.ESCROW },
    });

    if (!payment) {
      const requested = await this.paymentRepo.findOne({
        where: { jobId, status: PaymentStatus.HELD, type: PaymentType.ESCROW },
      });
      if (requested) return { message: 'Withdrawal request is already awaiting admin approval.' };
      throw new NotFoundException('No earnings are ready for withdrawal for this job.');
    }

    const job = await this.jobRepo.findOne({ where: { id: jobId } });
    if (!job || job.transporterId !== transporterId) throw new UnauthorizedException('This job does not belong to you');

    if (job.status !== JobStatus.DELIVERED || !job.otpVerified || !job.customerConfirmed) {
      throw new BadRequestException('Delivery must be completed and confirmed before requesting withdrawal');
    }
    if (!job.proofOfDeliveryUrl) throw new BadRequestException('Upload proof of delivery before requesting withdrawal');
    if (job.disputeRaised) throw new BadRequestException('Payout is frozen while this job is disputed');

    const transporter = await this.userRepo.findOne({ where: { id: transporterId } });
    if (!transporter?.recipientCode) throw new BadRequestException('Please add your bank account in Earnings before withdrawing.');

    const claimed = await this.paymentRepo.update(
      { id: payment.id, status: PaymentStatus.SUCCESS },
      { status: PaymentStatus.HELD },
    );
    if (!claimed.affected) throw new BadRequestException('This withdrawal has already been requested');

    return { message: 'Withdrawal request submitted. An administrator will review and approve the bank transfer.' };
  }

  // Called by admin approval (and the 24-hour fallback scheduler).
  // This is the only path that initiates the Paystack bank transfer.
  async approveWithdrawal(jobId: string, transporterId: string): Promise<{ message: string }> {
    const payment = await this.paymentRepo.findOne({
      where: { jobId, status: PaymentStatus.HELD, type: PaymentType.ESCROW },
    });
    if (!payment) throw new NotFoundException('No pending withdrawal request found for this job');

    const job = await this.jobRepo.findOne({ where: { id: jobId } });
    if (!job || job.transporterId !== transporterId) throw new UnauthorizedException('Transporter does not match this job');
    if (job.disputeRaised) throw new BadRequestException('Payout is frozen while this job is disputed');

    const transporter = await this.userRepo.findOne({ where: { id: transporterId } });
    const recipientCode = transporter?.recipientCode;
    if (!recipientCode) throw new BadRequestException('Transporter has not configured a payout bank account.');

    const previousRelease = await this.paymentRepo.findOne({ where: { jobId, type: PaymentType.RELEASE } });
    if (previousRelease && previousRelease.status !== PaymentStatus.FAILED) {
      throw new BadRequestException('A withdrawal has already been initiated for this job');
    }

    const correctedBreakdown = this.calculatePayout(
      Number(payment.amount),
      job.distanceKm ? Number(job.distanceKm) : undefined,
    );
    // Recalculate at approval so withdrawals created under an old commission
    // setting cannot pay more or less than the fixed 10% platform rate.
    const payoutAmount = correctedBreakdown.transporterPayout;
    const payoutKobo = Math.round(payoutAmount * 100);
    const availableBalanceKobo = await this.getAvailablePaystackBalanceKobo();
    if (availableBalanceKobo < payoutKobo) {
      throw new BadRequestException('Payout is temporarily unavailable because the transfer balance needs to be topped up.');
    }

    const claimed = await this.paymentRepo.update(
      { id: payment.id, status: PaymentStatus.HELD },
      {
        status: PaymentStatus.RELEASED,
        tracCommission: correctedBreakdown.tracCommission,
        transporterPayout: correctedBreakdown.transporterPayout,
        vatAmount: correctedBreakdown.vatOnCommission,
      },
    );
    if (!claimed.affected) throw new BadRequestException('This payout is already being processed');

    // One job always uses one Paystack reference. If our connection times out
    // after Paystack receives the request, a retry must not create a second
    // transfer with a new reference.
    const transferRef = `trac_payout_${jobId.replace(/-/g, '')}`;
    const releaseRecord = this.paymentRepo.create({
      reference: transferRef,
      amount: payoutAmount,
      status: PaymentStatus.PENDING,
      type: PaymentType.RELEASE,
      jobId,
      customerId: payment.customerId,
      tracCommission: correctedBreakdown.tracCommission,
      transporterPayout: payoutAmount,
      customerCashback: payment.customerCashback,
    });

    let definitivelyRejected = false;
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

      if (transferResponse.data?.status !== true) {
        definitivelyRejected = true;
        throw new Error(transferResponse.data?.message || 'Paystack rejected the transfer');
      }

      if (transferResponse.data?.data?.status === 'otp') {
        throw new Error(
          'Paystack accepted the transfer but confirmation OTP is still enabled',
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
      const httpStatus = axios.isAxiosError(error) ? error.response?.status : undefined;
      const conclusiveClientError = httpStatus !== undefined && httpStatus >= 400 && httpStatus < 500;
      const safeToRetry = definitivelyRejected || conclusiveClientError;

      if (releaseRecord.id) {
        await this.paymentRepo.update(releaseRecord.id, {
          // A timeout, server error, or OTP response may mean Paystack already
          // has the transfer. Keep it pending so another approval cannot pay
          // the transporter twice. Reconcile it by this same reference.
          status: safeToRetry ? PaymentStatus.FAILED : PaymentStatus.PENDING,
          paystackMeta: (error as any)?.response?.data || { message: (error as any)?.message },
        });
      }
      if (safeToRetry) {
        await this.paymentRepo.update(
          { id: payment.id, status: PaymentStatus.RELEASED },
          { status: PaymentStatus.HELD },
        );
      }
      const paystackError = (error as any)?.response?.data;
      const errorMsg = paystackError?.message || (error as any)?.message || 'Unknown error';
      this.logger.error(`❌ withdrawEarnings failed for job ${jobId}: ${errorMsg}`);
      if (!safeToRetry) {
        throw new BadRequestException(
          `Paystack may still be processing this withdrawal. Do not approve it again; reconcile reference ${transferRef}.`,
        );
      }
      throw new BadRequestException(`Withdrawal approval failed: ${errorMsg}. Ensure your Paystack balance has sufficient funds.`);
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

  async calculateConfiguredPayout(totalAmount: number, distanceKm?: number) {
    return this.calculatePayout(totalAmount, distanceKm);
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
    await this.ensureWalletTables();
    const payments = await this.paymentRepo.find({ where: { customerId: userId } });
    const escrowHeld  = payments.filter(p => p.status === PaymentStatus.HELD || p.status === PaymentStatus.SUCCESS).reduce((s, p) => s + Number(p.amount), 0);
    const totalSpent  = payments.filter(p => p.status === PaymentStatus.RELEASED).reduce((s, p) => s + Number(p.amount), 0);
    const account = (await this.paymentRepo.query(`SELECT "balance" FROM wallet_accounts WHERE "userId"=$1`, [userId]))[0];
    const cashback = (await this.paymentRepo.query(`SELECT COALESCE(SUM("amount"),0) AS total FROM wallet_entries WHERE "userId"=$1 AND "kind"='cashback' AND "status"='success'`, [userId]))[0];
    const totalCashback = Number(cashback?.total || 0);
    const walletTransactions = await this.paymentRepo.query(`SELECT "reference", "amount", "direction", "kind", "status", "jobId", "createdAt", "completedAt" FROM wallet_entries WHERE "userId"=$1 ORDER BY "createdAt" DESC LIMIT 50`, [userId]);
    return { balance: Number(account?.balance || 0), escrowHeld, totalSpent, totalCashback, walletTransactions };
  }

  // ─── Get transporter earnings ────────────────────────────────────────────────

  async getTransporterEarnings(transporterId: string) {
    const transporter = await this.userRepo.findOne({ where: { id: transporterId } });
    const payments = await this.paymentRepo
      .createQueryBuilder('payment')
      .innerJoin('jobs', 'job', 'job.id = payment.jobId')
      .where('job.transporterId = :transporterId', { transporterId })
      .andWhere('payment.type = :type', { type: PaymentType.ESCROW })
      .getMany();

    // Load delivery state so only genuinely completed jobs can request payout.
    const jobIds = payments.map(p => p.jobId).filter(Boolean);
    let jobMap: Record<string, any> = {};
    if (jobIds.length > 0) {
      const jobs = await this.jobRepo.findByIds(jobIds);
      jobMap = Object.fromEntries(jobs.map(j => [j.id, j]));
    }

    const canRequest = (p: Payment) => {
      const job = jobMap[p.jobId];
      return p.status === PaymentStatus.SUCCESS && job?.status === JobStatus.DELIVERED
        && job.otpVerified && job.customerConfirmed && job.proofOfDeliveryUrl && !job.disputeRaised;
    };
    const availablePayments = payments.filter(canRequest);

    const pendingPayout = payments
      .filter(p => p.status === PaymentStatus.SUCCESS && !canRequest(p))
      .reduce((s, p) => s + Number(p.transporterPayout || 0), 0);

    const availableToWithdraw = availablePayments
      .reduce((s, p) => s + Number(p.transporterPayout || 0), 0);

    const totalEarned = payments
      .filter(p => p.status === PaymentStatus.RELEASED)
      .reduce((s, p) => s + Number(p.transporterPayout || 0), 0);

    const totalCommissionPaid = payments
      .filter(p => p.status === PaymentStatus.RELEASED)
      .reduce((s, p) => s + Number(p.tracCommission || 0), 0);

    const awaitingApproval = payments
      .filter(p => p.status === PaymentStatus.HELD)
      .reduce((s, p) => s + Number(p.transporterPayout || 0), 0);

    return {
      totalEarned,
      pendingPayout,
      availableToWithdraw,
      awaitingApproval,
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
      payoutConfigured: Boolean(transporter?.recipientCode),
    };
  }

}
