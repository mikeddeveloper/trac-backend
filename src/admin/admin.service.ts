// trac-backend/src/admin/admin.service.ts
// Day 22: Admin service — platform-wide data

import { BadRequestException, ForbiddenException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, MoreThanOrEqual } from 'typeorm';
import { Job, JobStatus } from '../jobs/entities/job.entity';
import { Payment, PaymentStatus, PaymentType } from '../payments/entities/payment.entity';
import { Dispute, DisputeStatus } from '../disputes/entities/dispute.entity';
import { User, UserRole } from '../users/entities/user.entity';
import { Rating } from '../ratings/entities/rating.entity';
import { PushService } from '../push/push.service';
import { EventsGateway } from '../events/events.gateway';
import { EmailService } from '../email/email.service';
import { PaymentsService } from '../payments/payments.service';

@Injectable()
export class AdminService {
  private readonly logger = new Logger(AdminService.name);

  constructor(
    @InjectRepository(Job)
    private jobRepo: Repository<Job>,
    @InjectRepository(Payment)
    private paymentRepo: Repository<Payment>,
    @InjectRepository(Dispute)
    private disputeRepo: Repository<Dispute>,
    @InjectRepository(User)
    private userRepo: Repository<User>,
    @InjectRepository(Rating)
    private ratingRepo: Repository<Rating>,
    private pushService: PushService,
    private eventsGateway: EventsGateway,
    private emailService: EmailService,
    private paymentsService: PaymentsService,
  ) {}

  // ─── Platform overview ───────────────────────────────────────────────────────

  async getPlatformOverview() {
    const [jobs, payments, disputes, users, ratings] = await Promise.all([
      this.jobRepo.find({ order: { createdAt: 'DESC' } }),
      this.paymentRepo.find(),
      this.disputeRepo.find({ order: { createdAt: 'DESC' } }),
      this.userRepo.find(),
      this.ratingRepo.find(),
    ]);

    // ── User stats ──
    const totalCustomers    = users.filter(u => u.role === 'customer').length;
    const totalTransporters = users.filter(u => u.role === 'transporter').length;

    // ── Job stats ──
    const totalJobs      = jobs.length;
    const activeJobs     = jobs.filter(j => [JobStatus.ACCEPTED, JobStatus.IN_TRANSIT].includes(j.status)).length;
    const deliveredJobs  = jobs.filter(j => j.status === JobStatus.DELIVERED).length;
    const cancelledJobs  = jobs.filter(j => j.status === JobStatus.CANCELLED).length;

    // ── Revenue stats ──
    const totalRevenue = payments
      .filter(p => p.status === PaymentStatus.SUCCESS || p.status === PaymentStatus.RELEASED)
      .reduce((s, p) => s + Number(p.amount), 0);

    const tracCommission = payments
      .filter(p => p.tracCommission)
      .reduce((s, p) => s + Number(p.tracCommission), 0);

    const totalEscrow = payments
      .filter(p => p.status === PaymentStatus.SUCCESS || p.status === PaymentStatus.HELD)
      .reduce((s, p) => s + Number(p.amount), 0);

    // ── Dispute stats ──
    const openDisputes     = disputes.filter(d => d.status === DisputeStatus.OPEN).length;
    const resolvedDisputes = disputes.filter(d => d.status === DisputeStatus.RESOLVED).length;

    // ── Rating stats ──
    const avgPlatformRating = ratings.length > 0
      ? +(ratings.reduce((s, r) => s + r.stars, 0) / ratings.length).toFixed(1)
      : 0;

    // ── Monthly revenue (last 6 months) ──
    const monthlyRevenue: { month: string; revenue: number; jobs: number }[] = [];
    for (let i = 5; i >= 0; i--) {
      const date = new Date();
      date.setMonth(date.getMonth() - i);
      const month = date.toLocaleString('en-NG', { month: 'short' });
      const year = date.getFullYear();
      const monthPayments = payments.filter(p => {
        const d = new Date(p.createdAt);
        return d.getMonth() === date.getMonth() && d.getFullYear() === year;
      });
      const monthJobs = jobs.filter(j => {
        const d = new Date(j.createdAt);
        return d.getMonth() === date.getMonth() && d.getFullYear() === year;
      });
      monthlyRevenue.push({
        month: `${month} ${year}`,
        revenue: monthPayments.reduce((s, p) => s + Number(p.amount), 0),
        jobs: monthJobs.length,
      });
    }

    return {
      users: { total: users.length, customers: totalCustomers, transporters: totalTransporters },
      jobs: { total: totalJobs, active: activeJobs, delivered: deliveredJobs, cancelled: cancelledJobs },
      revenue: { total: totalRevenue, commission: tracCommission, escrow: totalEscrow },
      disputes: { total: disputes.length, open: openDisputes, resolved: resolvedDisputes },
      ratings: { total: ratings.length, average: avgPlatformRating },
      monthlyRevenue,
      recentJobs: jobs.slice(0, 10),
    };
  }

  // ─── Get all disputes ────────────────────────────────────────────────────────

  async getAllDisputes() {
    return this.disputeRepo.find({ order: { createdAt: 'DESC' } });
  }

  // ─── Resolve dispute ─────────────────────────────────────────────────────────

  async resolveDispute(id: string, resolutionNote: string) {
    const dispute = await this.disputeRepo.findOne({ where: { id } });

    await this.disputeRepo.update(id, {
      status: DisputeStatus.RESOLVED,
      resolutionNote,
      resolvedAt: new Date(),
    });

    if (dispute) {
      const job = await this.jobRepo.findOne({ where: { id: dispute.jobId } });

      const notifyIds = new Set<string>();
      if (dispute.raisedById) notifyIds.add(dispute.raisedById);
      if (job?.customerId) notifyIds.add(job.customerId);
      if (job?.transporterId) notifyIds.add(job.transporterId);

      for (const userId of notifyIds) {
        this.eventsGateway.notifyUser(userId, 'dispute:resolved', {
          disputeId: id,
          resolutionNote,
          message: 'Your dispute has been resolved by Trac support',
        });
        await this.pushService.sendToUser(userId, {
          title: '✅ Dispute Resolved',
          body: `Your delivery dispute has been resolved: ${resolutionNote}`,
          icon: '/icon-192.png',
        }).catch(() => {});
      }
    }

    return this.disputeRepo.findOne({ where: { id } });
  }

  // ─── Get all users (paginated) ───────────────────────────────────────────────

  async getAllUsers(role?: string, search?: string, page = 1, limit = 10) {
    const query = this.userRepo.createQueryBuilder('user');

    if (role) {
      query.andWhere('user.role = :role', { role });
    }

    if (search) {
      query.andWhere(
        '(user.fullName ILIKE :search OR user.email ILIKE :search OR user.phone ILIKE :search)',
        { search: `%${search}%` },
      );
    }

    query.orderBy('user.createdAt', 'DESC');
    query.skip((page - 1) * limit).take(limit);

    const [users, total] = await query.getManyAndCount();

    return {
      users: users.map(u => ({
        _id: u.id,
        id: u.id,
        fullName: u.fullName,
        email: u.email,
        phone: u.phone,
        role: u.role,
        isVerified: u.isVerified,
        status: u.isSuspended ? 'suspended' : 'active',
        kycStatus: (u as any).kycStatus || 'pending',
        kycTier: (u as any).kycTier || 0,
        rating: u.rating,
        tripsCompleted: u.tripsCompleted,
        avatarUrl: u.avatarUrl,
        vehicleType: u.vehicleType,
        licenseNumber: u.licenseNumber,
        licenseExpiry: u.licenseExpiry,
        licenseStatus: u.licenseStatus,
        licenseSubmittedAt: u.licenseSubmittedAt,
        licensePhotoUrl: u.licensePhotoUrl,
        createdAt: u.createdAt,
      })),
      total,
      page,
      totalPages: Math.ceil(total / limit),
    };
  }

  // ─── Get user by id ──────────────────────────────────────────────────────────

  async getUserById(userId: string) {
    const user = await this.userRepo.findOne({ where: { id: userId } });
    if (!user) throw new Error('User not found');

    const [jobs, payments] = await Promise.all([
      this.jobRepo.find({
        where: [{ customerId: userId }, { transporterId: userId }],
        order: { createdAt: 'DESC' },
        take: 10,
      }),
      this.paymentRepo.find({
        where: { customerId: userId } as any,
        order: { createdAt: 'DESC' },
        take: 10,
      }),
    ]);

    return {
      id: user.id,
      fullName: user.fullName,
      email: user.email,
      phone: user.phone,
      role: user.role,
      isVerified: user.isVerified,
      isSuspended: (user as any).isSuspended || false,
      kycStatus: (user as any).kycStatus || 'pending',
      kycTier: (user as any).kycTier || 0,
      rating: user.rating,
      tripsCompleted: user.tripsCompleted,
      avatarUrl: user.avatarUrl,
      state: user.state,
      vehicleType: user.vehicleType,
      licenseNumber: user.licenseNumber,
      licenseExpiry: user.licenseExpiry,
      licenseStatus: user.licenseStatus,
      licenseSubmittedAt: user.licenseSubmittedAt,
      licensePhotoUrl: user.licensePhotoUrl,
      createdAt: user.createdAt,
      recentJobs: jobs,
      recentPayments: payments,
    };
  }

  // ─── Suspend / unsuspend user ────────────────────────────────────────────────

  async suspendUser(userId: string) {
    const user = await this.userRepo.findOne({ where: { id: userId } });
    await this.userRepo.update(userId, { isSuspended: true });
    if (user) {
      this.eventsGateway.notifyUser(userId, 'account:suspended', {
        message: 'Your account has been suspended. Complete verification or contact support.',
        url: '/dashboard/verification',
      });
      await this.pushService.sendToUser(userId, {
        title: 'Account suspended',
        body: 'Your Trac account has been suspended. Complete verification or contact support for help.',
        url: '/dashboard/verification',
        tag: 'account-suspended',
      }).catch(() => {});
      await this.emailService.sendActivityEmail(
        user,
        'Important: your Trac account has been suspended',
        'Account suspended',
        'Your account has been suspended. Please complete your verification or contact info@trac.com.ng if you need assistance.',
        'https://traclogistics.com.ng/dashboard/verification',
        'Complete Verification',
      );
    }
    return { message: 'User suspended', user: { status: 'suspended', isSuspended: true } };
  }

  async unsuspendUser(userId: string) {
    await this.userRepo.update(userId, { isSuspended: false });
    return { message: 'User unsuspended', user: { status: 'active', isSuspended: false } };
  }

  // ─── Admin verify user ───────────────────────────────────────────────────────

  async verifyUser(userId: string) {
    await this.userRepo.update(userId, {
      isVerified: true,
      kycStatus: 'approved',
      kycTier: 1,
      kycCompletedAt: new Date(),
    } as any);

    await this.pushService.sendToUser(userId, {
      title: '✅ Account Verified!',
      body: 'Your account has been verified by admin. You can now bid on jobs.',
      icon: '/icon-192.png',
    }).catch(() => {});

    return { message: 'User verified successfully' };
  }

  // ─── Deactivate user ─────────────────────────────────────────────────────────

  async deleteUser(userId: string) {
    await this.userRepo.update(userId, { isActive: false } as any);
    return { message: 'User deactivated successfully' };
  }

  // ─── Get recent jobs ─────────────────────────────────────────────────────────

  async getRecentJobs() {
    return this.jobRepo.find({ order: { createdAt: 'DESC' }, take: 20 });
  }

  // ─── Get all jobs (paginated) ─────────────────────────────────────────────────

  async getAllJobs(status?: string, search?: string, page = 1, limit = 10) {
    const query = this.jobRepo.createQueryBuilder('job')
      .leftJoinAndSelect('job.customer', 'customer')
      .leftJoinAndSelect('job.transporter', 'transporter');

    if (status) {
      query.andWhere('job.status = :status', { status });
    }

    if (search) {
      query.andWhere(
        '(job.pickupState ILIKE :search OR job.deliveryState ILIKE :search OR customer.fullName ILIKE :search)',
        { search: `%${search}%` },
      );
    }

    query.orderBy('job.createdAt', 'DESC');
    query.skip((page - 1) * limit).take(limit);

    const [jobs, total] = await query.getManyAndCount();

    return {
      jobs: jobs.map(j => ({
        id: j.id,
        pickupAddress: j.pickupAddress,
        pickupState: j.pickupState,
        deliveryAddress: j.deliveryAddress,
        deliveryState: j.deliveryState,
        status: j.status,
        vehicleType: j.vehicleType,
        cargoDescription: j.cargoDescription,
        cargoWeight: j.cargoWeight,
        cargoValue: j.cargoValue,
        acceptedAmount: j.acceptedAmount,
        goodsCategory: (j as any).goodsCategory,
        disclaimerAccepted: (j as any).disclaimerAccepted,
        deliveryOtp: (j as any).deliveryOtp,
        otpVerified: (j as any).otpVerified,
        proofOfDeliveryUrl: j.proofOfDeliveryUrl,
        proofUploadedAt: j.proofUploadedAt,
        createdAt: j.createdAt,
        customer: j.customer ? {
          id: j.customer.id,
          fullName: j.customer.fullName,
          email: j.customer.email,
          phone: j.customer.phone,
        } : null,
        transporter: j.transporter ? {
          id: j.transporter.id,
          fullName: j.transporter.fullName,
          email: j.transporter.email,
          phone: j.transporter.phone,
          isVerified: j.transporter.isVerified,
        } : null,
      })),
      total,
      page,
      totalPages: Math.ceil(total / limit),
    };
  }

  // ─── Get job by id ────────────────────────────────────────────────────────────

  async getJobById(jobId: string) {
    const job = await this.jobRepo.findOne({
      where: { id: jobId },
      relations: ['customer', 'transporter'],
    });
    if (!job) throw new Error('Job not found');

    const payment = await this.paymentRepo.findOne({
      where: { jobId } as any,
    });

    return { ...job, payment: payment || null };
  }

  // ─── Cancel job (admin) ───────────────────────────────────────────────────────

  async cancelJob(jobId: string) {
    const job = await this.jobRepo.findOne({ where: { id: jobId } });
    if (!job) throw new Error('Job not found');

    await this.jobRepo.update(jobId, { status: 'cancelled' as any });

    if (job.customerId) {
      this.eventsGateway.notifyUser(job.customerId, 'job:statusUpdate', {
        jobId,
        status: 'cancelled',
        message: 'Your job has been cancelled by admin.',
      });
    }

    if (job.transporterId) {
      this.eventsGateway.notifyUser(job.transporterId, 'job:statusUpdate', {
        jobId,
        status: 'cancelled',
        message: 'A job has been cancelled by admin.',
      });
    }

    return { message: 'Job cancelled successfully' };
  }

  // ─── Job analytics ────────────────────────────────────────────────────────────

  async getJobAnalytics() {
    const [
      bidding, accepted, inTransit, delivered, cancelled,
      rider, van, truckSmall, truckMedium, truckLarge,
      totalJobs,
    ] = await Promise.all([
      this.jobRepo.count({ where: { status: 'bidding' as any } }),
      this.jobRepo.count({ where: { status: 'accepted' as any } }),
      this.jobRepo.count({ where: { status: 'in-transit' as any } }),
      this.jobRepo.count({ where: { status: 'delivered' as any } }),
      this.jobRepo.count({ where: { status: 'cancelled' as any } }),
      this.jobRepo.count({ where: { vehicleType: 'rider' as any } }),
      this.jobRepo.count({ where: { vehicleType: 'van' as any } }),
      this.jobRepo.count({ where: { vehicleType: 'truck-small' as any } }),
      this.jobRepo.count({ where: { vehicleType: 'truck-medium' as any } }),
      this.jobRepo.count({ where: { vehicleType: 'truck-large' as any } }),
      this.jobRepo.count(),
    ]);

    const completionRate = totalJobs > 0
      ? Math.round((delivered / totalJobs) * 100)
      : 0;

    return {
      byStatus: { bidding, accepted, inTransit, delivered, cancelled },
      byVehicleType: { rider, van, truckSmall, truckMedium, truckLarge },
      completionRate,
      totalJobs,
    };
  }

  // ─── Stats ───────────────────────────────────────────────────────────────────

  async getStats() {
    const monthStart = new Date(new Date().getFullYear(), new Date().getMonth(), 1);

    const [
      totalUsers,
      totalCustomers,
      totalTransporters,
      totalJobs,
      payments,
      pendingVerifications,
      jobsThisMonth,
      newUsersThisMonth,
    ] = await Promise.all([
      this.userRepo.count(),
      this.userRepo.count({ where: { role: 'customer' as any } }),
      this.userRepo.count({ where: { role: 'transporter' as any } }),
      this.jobRepo.count(),
      this.paymentRepo.find({ where: { status: 'success' as any } }),
      this.userRepo.count({ where: { role: 'transporter' as any, isVerified: false } }),
      this.jobRepo.count({ where: { createdAt: MoreThanOrEqual(monthStart) } }),
      this.userRepo.count({ where: { createdAt: MoreThanOrEqual(monthStart) } }),
    ]);

    const totalRevenue = payments.reduce((sum, p) => sum + Number(p.amount), 0);
    const platformCommission = totalRevenue * 0.10;
    const totalVAT = payments.reduce((sum, p) => sum + Number((p as any).vatAmount || 0), 0);

    return {
      totalUsers,
      totalCustomers,
      totalTransporters,
      totalJobs,
      totalRevenue,
      platformCommission,
      totalVAT,
      pendingVerifications,
      jobsThisMonth,
      newUsersThisMonth,
      revenueThisMonth: 0,
      activeDisputes: 0,
    };
  }

  // ─── Get all payments (paginated) ────────────────────────────────────────────

  async getAllPayments(status?: string, startDate?: string, endDate?: string, page = 1, limit = 10) {
    const query = this.paymentRepo.createQueryBuilder('payment')
      .leftJoinAndSelect('payment.job', 'job')
      .leftJoin('job.customer', 'customer')
      .leftJoin('job.transporter', 'transporter')
      .addSelect(['customer.fullName', 'customer.email', 'transporter.fullName', 'transporter.email']);

    if (status) {
      query.andWhere('payment.status = :status', { status });
    }

    if (startDate) {
      query.andWhere('payment.createdAt >= :startDate', { startDate: new Date(startDate) });
    }

    if (endDate) {
      query.andWhere('payment.createdAt <= :endDate', { endDate: new Date(endDate) });
    }

    query.orderBy('payment.createdAt', 'DESC');
    query.skip((page - 1) * limit).take(limit);

    const [payments, total] = await query.getManyAndCount();

    return {
      payments: payments.map(p => ({
        id: p.id,
        _id: p.id,
        reference: p.reference,
        amount: p.amount,
        vat: Number(p.vatAmount) || 0,
        commission: Number(p.tracCommission) || 0,
        proofOfDeliveryUrl: p.job?.proofOfDeliveryUrl || null,
        proofUploadedAt: p.job?.proofUploadedAt || null,
        deliveryStatus: p.job?.status || null,
        otpVerified: Boolean(p.job?.otpVerified),
        status: p.status,
        createdAt: p.createdAt,
        jobId: p.jobId,
        jobRoute: p.job ? `${p.job.pickupState} → ${p.job.deliveryState}` : 'N/A',
        customer: p.job?.customer ? {
          id: p.job.customer.id,
          _id: p.job.customer.id,
          fullName: p.job.customer.fullName,
          email: p.job.customer.email,
        } : null,
        transporter: p.job?.transporter ? {
          id: p.job.transporter.id,
          _id: p.job.transporter.id,
          fullName: p.job.transporter.fullName,
          email: p.job.transporter.email,
        } : null,
      })),
      total,
      page,
      totalPages: Math.ceil(total / limit),
    };
  }

  // ─── Payment stats ────────────────────────────────────────────────────────────

  async getPaymentStats() {
    const successPayments = await this.paymentRepo.find({ where: { status: 'success' as any } });
    const thisMonth    = new Date(new Date().getFullYear(), new Date().getMonth(), 1);
    const lastMonth    = new Date(new Date().getFullYear(), new Date().getMonth() - 1, 1);
    const lastMonthEnd = new Date(new Date().getFullYear(), new Date().getMonth(), 0);

    const thisMonthPayments = successPayments.filter(p => new Date(p.createdAt) >= thisMonth);
    const lastMonthPayments = successPayments.filter(
      p => new Date(p.createdAt) >= lastMonth && new Date(p.createdAt) <= lastMonthEnd,
    );

    const totalProcessed  = successPayments.reduce((sum, p) => sum + Number(p.amount), 0);
    const totalCommission = successPayments.reduce((sum, p) => sum + Number(p.tracCommission || 0), 0);
    const totalVAT        = successPayments.reduce((sum, p) => sum + Number((p as any).vatAmount || 0), 0);
    const thisMonthTotal  = thisMonthPayments.reduce((sum, p) => sum + Number(p.amount), 0);
    const lastMonthTotal  = lastMonthPayments.reduce((sum, p) => sum + Number(p.amount), 0);

    const acceptedJobs = await this.jobRepo.find({ where: { status: 'accepted' as any } });
    const escrowJobs   = await Promise.all(
      acceptedJobs.map(j => this.paymentRepo.findOne({ where: { jobId: j.id } as any })),
    );
    const escrowHeld = escrowJobs
      .filter(p => p && p.status === 'success' as any)
      .reduce((sum, p) => sum + Number(p!.amount), 0);

    return {
      totalProcessed,
      totalCommission,
      totalVat: totalVAT,
      thisMonth: thisMonthTotal,
      lastMonth: lastMonthTotal,
      escrowHeld,
      growth: lastMonthTotal > 0
        ? Math.round(((thisMonthTotal - lastMonthTotal) / lastMonthTotal) * 100)
        : 0,
    };
  }

  // ─── Release payment (admin) ──────────────────────────────────────────────────

  async releasePayment(paymentId: string) {
    const payment = await this.paymentRepo.findOne({ where: { id: paymentId } });
    if (!payment) throw new Error('Payment not found');
    if (payment.status === PaymentStatus.RELEASED) return { message: 'Payment is already approved for withdrawal', status: 'available' };
    if (![PaymentStatus.SUCCESS, PaymentStatus.HELD].includes(payment.status)) {
      throw new BadRequestException('Only a confirmed escrow payment can be approved for withdrawal');
    }

    const job = await this.jobRepo.findOne({ where: { id: (payment as any).jobId } });
    if (!job?.proofOfDeliveryUrl) throw new BadRequestException('Proof of delivery must be reviewed before approving withdrawal');
    if (!job.otpVerified || job.status !== JobStatus.DELIVERED) throw new BadRequestException('Delivery must be PIN-confirmed and marked delivered before approving withdrawal');
    await this.paymentRepo.update(paymentId, { status: 'released' as any });
    if (job?.transporterId) {
      this.eventsGateway.notifyUser(job.transporterId, 'payment:available', {
        amount: payment.amount,
        message: `Payment of ₦${Number(payment.transporterPayout || payment.amount).toLocaleString()} is approved and available for withdrawal.`,
      });
      await this.pushService.sendToUser(job.transporterId, {
        title: 'Payment ready for withdrawal',
        body: `₦${Number(payment.transporterPayout || payment.amount).toLocaleString()} is available. Open Earnings to withdraw through Paystack.`,
        url: '/dashboard/earnings',
        tag: 'payout-available',
        icon: '/icon-192.png',
      }).catch(() => {});
    }

    return { message: 'Payment approved for withdrawal. The transporter can now withdraw through Paystack.', status: 'available' };
  }

  // ─── Refund payment (admin) ───────────────────────────────────────────────────

  async refundPayment(paymentId: string) {
    return this.paymentsService.initiateRefund(paymentId);
  }

  // ─── Revenue analytics ────────────────────────────────────────────────────────

  async getRevenueAnalytics() {
    const last7days: { date: string; amount: number; commission: number }[] = [];

    for (let i = 6; i >= 0; i--) {
      const date     = new Date();
      date.setDate(date.getDate() - i);
      const dayStart = new Date(date.getFullYear(), date.getMonth(), date.getDate());
      const dayEnd   = new Date(date.getFullYear(), date.getMonth(), date.getDate() + 1);

      const payments = await this.paymentRepo.find({
        where: { status: 'success' as any, createdAt: MoreThanOrEqual(dayStart) },
      });
      const dayPayments = payments.filter(p => new Date(p.createdAt) < dayEnd);
      const amount      = dayPayments.reduce((sum, p) => sum + Number(p.amount), 0);

      last7days.push({
        date: dayStart.toLocaleDateString('en-NG', { weekday: 'short', day: 'numeric' }),
        amount,
        commission: amount * 0.10,
      });
    }

    const allJobs = await this.jobRepo.find();
    const routeCounts: Record<string, { count: number; revenue: number }> = {};
    allJobs.forEach(j => {
      const route = `${j.pickupState} → ${j.deliveryState}`;
      if (!routeCounts[route]) routeCounts[route] = { count: 0, revenue: 0 };
      routeCounts[route].count++;
      routeCounts[route].revenue += Number(j.acceptedAmount || 0);
    });
    const topRoutes = Object.entries(routeCounts)
      .map(([route, data]) => ({ route, ...data }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 5);

    const transporters = await this.userRepo.find({
      where: { role: 'transporter' as any },
      order: { tripsCompleted: 'DESC' },
      take: 5,
    });
    const topTransporters = transporters.map(t => ({
      id: t.id,
      fullName: t.fullName,
      tripsCompleted: t.tripsCompleted,
      rating: t.rating,
    }));

    return { last7days, topRoutes, topTransporters };
  }

  // ─── User analytics ───────────────────────────────────────────────────────────

  async getUserAnalytics() {
    const thisMonth = new Date(new Date().getFullYear(), new Date().getMonth(), 1);

    const [totalCustomers, totalTransporters, newCustomersThisMonth, newTransportersThisMonth] =
      await Promise.all([
        this.userRepo.count({ where: { role: 'customer' as any } }),
        this.userRepo.count({ where: { role: 'transporter' as any } }),
        this.userRepo.count({ where: { role: 'customer' as any, createdAt: MoreThanOrEqual(thisMonth) } }),
        this.userRepo.count({ where: { role: 'transporter' as any, createdAt: MoreThanOrEqual(thisMonth) } }),
      ]);

    const [topCustomers, topTransporters] = await Promise.all([
      this.userRepo.find({ where: { role: 'customer' as any }, order: { tripsCompleted: 'DESC' }, take: 5 }),
      this.userRepo.find({ where: { role: 'transporter' as any }, order: { tripsCompleted: 'DESC' }, take: 5 }),
    ]);

    return {
      totalCustomers,
      totalTransporters,
      newCustomersThisMonth,
      newTransportersThisMonth,
      topCustomers: topCustomers.map(u => ({
        id: u.id,
        fullName: u.fullName,
        email: u.email,
        tripsCompleted: u.tripsCompleted,
      })),
      topTransporters: topTransporters.map(u => ({
        id: u.id,
        fullName: u.fullName,
        email: u.email,
        tripsCompleted: u.tripsCompleted,
        rating: u.rating,
      })),
    };
  }

  // ─── Activity ─────────────────────────────────────────────────────────────────

  async getActivity() {
    const [recentJobs, recentUsers, recentPayments] = await Promise.all([
      this.jobRepo.find({ order: { createdAt: 'DESC' }, take: 5, relations: ['customer'] }),
      this.userRepo.find({ order: { createdAt: 'DESC' }, take: 5 }),
      this.paymentRepo.find({ where: { status: 'success' as any }, order: { createdAt: 'DESC' }, take: 5 }),
    ]);

    return [
      ...recentJobs.map(j => ({
        type: 'new_job',
        description: `New job posted: ${j.pickupState} → ${j.deliveryState}`,
        timestamp: j.createdAt,
        userId: j.customerId,
      })),
      ...recentUsers.map(u => ({
        type: 'new_user',
        description: `New ${u.role} signed up: ${u.fullName}`,
        timestamp: u.createdAt,
        userId: u.id,
      })),
      ...recentPayments.map(p => ({
        type: 'payment',
        description: `Payment of ₦${Number(p.amount).toLocaleString()} confirmed`,
        timestamp: p.createdAt,
        userId: (p as any).customerId,
      })),
    ]
      .sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime())
      .slice(0, 20);
  }

  // ─── Pending license submissions ─────────────────────────────────────────────

  async getPendingLicenses() {
    const pending = await this.userRepo.find({
      where: { role: 'transporter' as any, licenseStatus: 'pending' } as any,
      order: { licenseSubmittedAt: 'DESC' } as any,
    });

    return pending.map(u => ({
      id: u.id,
      fullName: u.fullName,
      email: u.email,
      phone: u.phone,
      licenseNumber: (u as any).licenseNumber,
      licenseExpiry: (u as any).licenseExpiry,
      licenseStatus: (u as any).licenseStatus,
      licenseSubmittedAt: (u as any).licenseSubmittedAt,
      licensePhotoUrl: (u as any).licensePhotoUrl || null,
      vehicleType: u.vehicleType,
      avatarUrl: u.avatarUrl,
      isVerified: u.isVerified,
      kycStatus: (u as any).kycStatus,
    }));
  }

  // ─── Pending verifications ────────────────────────────────────────────────────

  async getPendingVerifications() {
    const pending = await this.userRepo.find({
      where: { role: 'transporter' as any, isVerified: false },
      order: { createdAt: 'DESC' },
    });

    return pending.map(u => ({
      _id: u.id,
      id: u.id,
      user: { _id: u.id, fullName: u.fullName, email: u.email },
      fullName: u.fullName,
      email: u.email,
      phone: u.phone,
      kycStatus: u.kycStatus || 'pending',
      vehicleType: u.vehicleType,
      vehiclePlate: u.vehiclePlate,
      vehicleYear: u.vehicleYear,
      licenseNumber: u.licenseNumber,
      licenseExpiry: u.licenseExpiry,
      licenseStatus: u.licenseStatus,
      ninVerified: u.ninVerified,
      submittedAt: u.createdAt,
      createdAt: u.createdAt,
      avatarUrl: u.avatarUrl,
    }));
  }

  // ─── Approved verifications ───────────────────────────────────────────────────

  async getApprovedVerifications() {
    const approved = await this.userRepo.find({
      where: { role: 'transporter' as any, isVerified: true },
      order: { createdAt: 'DESC' },
    });

    return approved.map(u => ({
      _id: u.id,
      id: u.id,
      user: { _id: u.id, fullName: u.fullName, email: u.email },
      fullName: u.fullName,
      email: u.email,
      phone: u.phone,
      kycStatus: (u as any).kycStatus || 'approved',
      kycTier: (u as any).kycTier || 1,
      kycCompletedAt: (u as any).kycCompletedAt,
      verifiedAt: (u as any).kycCompletedAt || u.createdAt,
      vehicleType: u.vehicleType,
      rating: u.rating,
      tripsCompleted: u.tripsCompleted,
      createdAt: u.createdAt,
    }));
  }

  // ─── Approve KYC ──────────────────────────────────────────────────────────────

  async approveKYC(userId: string) {
    const user = await this.userRepo.findOne({ where: { id: userId } });
    if (!user) throw new Error('User not found');

    await this.userRepo.update(userId, {
      isVerified: true,
      kycStatus: 'approved',
      kycTier: 1,
      kycCompletedAt: new Date(),
    } as any);

    this.eventsGateway.notifyUser(userId, 'kyc:approved', {
      message: 'Your account has been verified by admin. You can now bid on jobs.',
    });

    await this.pushService.sendToUser(userId, {
      title: '✅ Account Verified!',
      body: 'Your account has been verified by admin. You can now bid on jobs.',
      icon: '/icon-192.png',
    }).catch(() => {});

    return { message: 'User verified successfully' };
  }

  // ─── Reject KYC ───────────────────────────────────────────────────────────────

  async rejectKYC(userId: string, reason: string) {
    await this.userRepo.update(userId, { kycStatus: 'rejected' } as any);

    this.eventsGateway.notifyUser(userId, 'kyc:rejected', {
      message: `Verification rejected: ${reason}`,
      reason,
    });

    await this.pushService.sendToUser(userId, {
      title: '❌ Verification Rejected',
      body: `Your verification was rejected: ${reason}`,
      icon: '/icon-192.png',
    }).catch(() => {});

    return { message: 'Verification rejected' };
  }

  // ─── Rejected verifications ──────────────────────────────────────────────────

  async getRejectedVerifications() {
    const rejected = await this.userRepo.find({
      where: { kycStatus: 'rejected' } as any,
      order: { createdAt: 'DESC' },
    });
    return rejected.map(u => ({
      _id: u.id,
      id: u.id,
      user: { _id: u.id, fullName: u.fullName, email: u.email },
      fullName: u.fullName,
      email: u.email,
      kycStatus: (u as any).kycStatus,
      createdAt: u.createdAt,
      submittedAt: u.createdAt,
      verifiedAt: null,
    }));
  }

  // ─── List admin accounts ──────────────────────────────────────────────────────

  async getAdminUsers() {
    await this.getSettings();
    const admins = await this.userRepo.find({
      where: { role: 'admin' as any },
      order: { createdAt: 'ASC' },
    });
    const roleRows: { key: string; value: string }[] = await this.userRepo.query(
      "SELECT key, value FROM platform_settings WHERE key LIKE 'adminRole:%'",
    );
    const roles = new Map(roleRows.map(row => [row.key.slice('adminRole:'.length), String(row.value)]));
    return admins.map(u => ({
      id: u.id,
      fullName: u.fullName,
      email: u.email,
      status: u.isSuspended ? 'suspended' : 'active',
      adminRole: roles.get(u.id) || 'super_admin',
      createdAt: u.createdAt,
      lastLogin: (u as any).lastLogin || null,
    }));
  }

  async assignAdminRole(requesterId: string, email: string, adminRole: string) {
    const allowedRoles = new Set(['super_admin', 'operations', 'finance', 'compliance', 'support']);
    if (!allowedRoles.has(adminRole)) throw new BadRequestException('Invalid administrator role');
    const requester = await this.userRepo.findOne({ where: { id: requesterId } });
    await this.getSettings();
    const requesterRoleRows = await this.userRepo.query(
      "SELECT value FROM platform_settings WHERE key = $1 LIMIT 1",
      [`adminRole:${requesterId}`],
    );
    const requesterAdminRole = requesterRoleRows[0]?.value ? String(requesterRoleRows[0].value) : 'super_admin';
    if (!requester || requester.role !== UserRole.ADMIN || requesterAdminRole !== 'super_admin') {
      throw new ForbiddenException('Only a super administrator can assign administrator roles');
    }
    const target = await this.userRepo.findOne({ where: { email: email.trim().toLowerCase() } });
    if (!target) throw new NotFoundException('No user account was found for this email address');
    await this.userRepo.update(target.id, {
      role: UserRole.ADMIN,
      isSuspended: false,
      sessionVersion: Number(target.sessionVersion || 0) + 1,
    });
    await this.userRepo.query(
      `INSERT INTO platform_settings (key, value, updated_at) VALUES ($1, $2::jsonb, now())
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
      [`adminRole:${target.id}`, JSON.stringify(adminRole)],
    );
    return { message: `${target.fullName} is now assigned to the ${adminRole.replace('_', ' ')} role` };
  }

  async updateAdminRole(requesterId: string, targetId: string, adminRole: string) {
    const target = await this.userRepo.findOne({ where: { id: targetId } });
    if (!target || target.role !== UserRole.ADMIN) throw new NotFoundException('Administrator account not found');
    return this.assignAdminRole(requesterId, target.email, adminRole);
  }

  async restoreAdminAsTransporter(requesterId: string, targetId: string) {
    const requester = await this.userRepo.findOne({ where: { id: requesterId } });
    const requesterRoleRows = await this.userRepo.query(
      "SELECT value FROM platform_settings WHERE key = $1 LIMIT 1",
      [`adminRole:${requesterId}`],
    );
    const requesterAdminRole = requesterRoleRows[0]?.value ? String(requesterRoleRows[0].value) : 'super_admin';
    if (!requester || requester.role !== UserRole.ADMIN || requesterAdminRole !== 'super_admin') {
      throw new ForbiddenException('Only a super administrator can remove administrator access');
    }
    const target = await this.userRepo.findOne({ where: { id: targetId } });
    if (!target || target.role !== UserRole.ADMIN) throw new NotFoundException('Administrator account not found');
    await this.userRepo.update(target.id, {
      role: UserRole.TRANSPORTER,
      isVerified: true,
      kycStatus: 'approved',
      kycTier: 1,
      isSuspended: false,
      sessionVersion: Number(target.sessionVersion || 0) + 1,
    } as any);
    await this.userRepo.query('DELETE FROM platform_settings WHERE key = $1', [`adminRole:${target.id}`]);
    return { message: `${target.fullName} has been restored as a transporter and must sign in again` };
  }

  // ─── Revoke verification ──────────────────────────────────────────────────────

  async revokeVerification(userId: string) {
    await this.userRepo.update(userId, {
      isVerified: false,
      kycStatus: 'pending',
      kycTier: 0,
    } as any);

    await this.pushService.sendToUser(userId, {
      title: '⚠️ Verification Revoked',
      body: 'Your verification has been revoked by admin. Please contact support.',
      icon: '/icon-192.png',
    }).catch(() => {});

    return { message: 'Verification revoked' };
  }

  // ─── KYC analytics ───────────────────────────────────────────────────────────

  async getKycAnalytics() {
    const [totalVerified, totalPending, totalRejected, totalTransporters] = await Promise.all([
      this.userRepo.count({ where: { role: 'transporter' as any, isVerified: true } }),
      this.userRepo.count({ where: { role: 'transporter' as any, isVerified: false } }),
      this.userRepo.count({ where: { kycStatus: 'rejected' } as any }),
      this.userRepo.count({ where: { role: 'transporter' as any } }),
    ]);

    const verificationRate = totalTransporters > 0
      ? Math.round((totalVerified / totalTransporters) * 100)
      : 0;

    return { totalVerified, totalPending, totalRejected, totalTransporters, verificationRate };
  }

  // ─── Settings ─────────────────────────────────────────────────────────────────

  async getSettings() {
    const defaults = {
      commissionRate: 10,
      vatRate: 7.5,
      kycCutoffDate: '2026-05-11',
      maintenanceMode: false,
      platformName: 'Trac Marketplace',
      supportEmail: 'info@trac.com.ng',
      minBidAmount: 1000,
      maxBidAmount: 10000000,
    };
    await this.userRepo.query(`
      CREATE TABLE IF NOT EXISTS platform_settings (
        key varchar(80) PRIMARY KEY,
        value jsonb NOT NULL,
        updated_at timestamptz NOT NULL DEFAULT now()
      )
    `);
    const rows: { key: string; value: unknown }[] = await this.userRepo.query(
      'SELECT key, value FROM platform_settings',
    );
    for (const row of rows) {
      if (row.key in defaults) (defaults as Record<string, unknown>)[row.key] = row.value;
    }
    return defaults;
  }

  async updateSettings(settings: any) {
    const allowed = new Set([
      'commissionRate', 'vatRate', 'kycCutoffDate', 'maintenanceMode',
      'platformName', 'supportEmail', 'minBidAmount', 'maxBidAmount',
    ]);
    const entries = Object.entries(settings).filter(([key]) => allowed.has(key));
    if (!entries.length) return { message: 'No valid settings supplied', settings: {} };
    if ('commissionRate' in settings && (!Number.isFinite(Number(settings.commissionRate)) || Number(settings.commissionRate) < 0 || Number(settings.commissionRate) > 100)) {
      throw new BadRequestException('Commission rate must be between 0 and 100');
    }
    await this.getSettings();
    for (const [key, value] of entries) {
      await this.userRepo.query(
        `INSERT INTO platform_settings (key, value, updated_at)
         VALUES ($1, $2::jsonb, now())
         ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
        [key, JSON.stringify(value)],
      );
    }
    const saved = Object.fromEntries(entries);
    this.logger.log(`Admin updated settings: ${JSON.stringify(saved)}`);
    return { message: 'Settings updated successfully', settings: saved };
  }

  // ─── Disputed jobs ────────────────────────────────────────────────────────────

  async getDisputes() {
    const disputes = await this.disputeRepo.find({
      relations: ['raisedBy', 'job'],
      order: { createdAt: 'DESC' },
    });

    const results = await Promise.all(disputes.map(async d => {
      const job = d.job ?? (d.jobId ? await this.jobRepo.findOne({ where: { id: d.jobId }, relations: ['customer', 'transporter'] }) : null);
      return {
        id: d.id,
        _id: d.id,
        jobId: d.jobId,
        reason: d.reason,
        description: d.description,
        status: d.status,
        resolutionNote: d.resolutionNote,
        createdAt: d.createdAt,
        raisedBy: d.raisedBy ? {
          id: d.raisedBy.id,
          _id: d.raisedBy.id,
          fullName: d.raisedBy.fullName,
          email: d.raisedBy.email,
          phone: d.raisedBy.phone,
        } : null,
        job: job ? {
          id: job.id,
          pickupState: job.pickupState,
          deliveryState: job.deliveryState,
          acceptedAmount: job.acceptedAmount,
          status: job.status,
        } : null,
        customer: job?.customer ? {
          id: job.customer.id,
          _id: job.customer.id,
          fullName: job.customer.fullName,
          email: job.customer.email,
          phone: job.customer.phone,
        } : null,
        transporter: job?.transporter ? {
          id: job.transporter.id,
          _id: job.transporter.id,
          fullName: job.transporter.fullName,
          email: job.transporter.email,
          phone: job.transporter.phone,
        } : null,
      };
    }));

    return results;
  }

  // ─── Aggregated analytics (GET /admin/analytics) ─────────────────────────────

  async getAggregatedAnalytics() {
    const monthStart = new Date(new Date().getFullYear(), new Date().getMonth(), 1);

    const [
      totalCustomers,
      totalTransporters,
      newCustomersThisMonth,
      newTransportersThisMonth,
      allJobs,
      topTransporterUsers,
      topCustomerUsers,
    ] = await Promise.all([
      this.userRepo.count({ where: { role: 'customer' as any } }),
      this.userRepo.count({ where: { role: 'transporter' as any } }),
      this.userRepo.count({ where: { role: 'customer' as any, createdAt: MoreThanOrEqual(monthStart) } }),
      this.userRepo.count({ where: { role: 'transporter' as any, createdAt: MoreThanOrEqual(monthStart) } }),
      this.jobRepo.find(),
      this.userRepo.find({ where: { role: 'transporter' as any }, order: { tripsCompleted: 'DESC' }, take: 5 }),
      this.userRepo.find({ where: { role: 'customer' as any }, order: { tripsCompleted: 'DESC' }, take: 5 }),
    ]);

    const routeMap: Record<string, { jobs: number; revenue: number }> = {};
    const statusMap: Record<string, number> = {};

    for (const job of allJobs) {
      const route = `${job.pickupState} → ${job.deliveryState}`;
      if (!routeMap[route]) routeMap[route] = { jobs: 0, revenue: 0 };
      routeMap[route].jobs++;
      routeMap[route].revenue += Number((job as any).acceptedAmount || 0);

      const s = job.status as string;
      statusMap[s] = (statusMap[s] || 0) + 1;
    }

    const topRoutes = Object.entries(routeMap)
      .map(([route, d]) => ({ route, ...d }))
      .sort((a, b) => b.jobs - a.jobs)
      .slice(0, 5);

    const totalJobs = allJobs.length;
    const deliveredCount = statusMap['delivered'] || 0;
    const completionRate = totalJobs > 0 ? Math.round((deliveredCount / totalJobs) * 100) : 0;

    const transporterIds = topTransporterUsers.map(u => u.id);
    const customerIds = topCustomerUsers.map(u => u.id);

    const transporterEarned: Record<string, number> = {};
    for (const tid of transporterIds) {
      const earned = allJobs
        .filter(j => (j as any).transporterId === tid && j.status === 'delivered' as any)
        .reduce((sum, j) => sum + Number((j as any).acceptedAmount || 0) * 0.87, 0);
      transporterEarned[tid] = earned;
    }

    const customerSpent: Record<string, number> = {};
    for (const cid of customerIds) {
      const spent = allJobs
        .filter(j => (j as any).customerId === cid)
        .reduce((sum, j) => sum + Number((j as any).acceptedAmount || 0), 0);
      customerSpent[cid] = spent;
    }

    return {
      topRoutes,
      topTransporters: topTransporterUsers.map(t => ({
        name: t.fullName,
        trips: t.tripsCompleted,
        earned: transporterEarned[t.id] || 0,
      })),
      jobsByStatus: statusMap,
      completionRate,
      topCustomers: topCustomerUsers.map(c => ({
        name: c.fullName,
        jobs: c.tripsCompleted,
        spent: customerSpent[c.id] || 0,
      })),
      totalCustomers,
      totalTransporters,
      newCustomersThisMonth,
      newTransportersThisMonth,
    };
  }

  // ─── Rule for customer ────────────────────────────────────────────────────────

  async ruleForCustomer(disputeId: string) {
    const dispute = await this.disputeRepo.findOne({ where: { id: disputeId } });
    if (!dispute) throw new Error('Dispute not found');

    const job = dispute.jobId ? await this.jobRepo.findOne({ where: { id: dispute.jobId } }) : null;
    const payment = job ? await this.paymentRepo.findOne({
      where: { jobId: job.id, type: PaymentType.ESCROW } as any,
      order: { createdAt: 'DESC' },
    }) : null;
    if (payment) {
      await this.paymentsService.initiateRefund(payment.id, 'Dispute resolved in favour of customer');
    }

    await this.disputeRepo.update(disputeId, {
      status: DisputeStatus.RESOLVED,
      resolutionNote: 'Ruled in favor of customer',
      resolvedAt: new Date(),
    });

    if (job) {
      await this.jobRepo.update(job.id, { status: JobStatus.CANCELLED });

      if (job.customerId) {
        this.eventsGateway.notifyUser(job.customerId, 'dispute:resolved', {
          message: 'Dispute resolved in your favor. Your refund has been submitted for processing.',
          result: 'customer',
        });
        await this.pushService.sendToUser(job.customerId, {
          title: '✅ Dispute Resolved',
          body: 'Dispute resolved in your favor. Your refund is being processed to your original payment method.',
          icon: '/icon-192.png',
        }).catch(() => {});
      }

      if (job.transporterId) {
        this.eventsGateway.notifyUser(job.transporterId, 'dispute:resolved', {
          message: 'Dispute resolved in favor of customer.',
          result: 'customer',
        });
        await this.pushService.sendToUser(job.transporterId, {
          title: '❌ Dispute Resolved',
          body: 'The dispute was resolved in favor of the customer.',
          icon: '/icon-192.png',
        }).catch(() => {});
      }
    }

    return { message: 'Dispute resolved in favor of customer' };
  }

  // ─── Rule for transporter ─────────────────────────────────────────────────────

  async ruleForTransporter(disputeId: string) {
    const dispute = await this.disputeRepo.findOne({ where: { id: disputeId } });
    if (!dispute) throw new Error('Dispute not found');

    await this.disputeRepo.update(disputeId, {
      status: DisputeStatus.RESOLVED,
      resolutionNote: 'Ruled in favor of transporter',
      resolvedAt: new Date(),
    });

    const job = dispute.jobId ? await this.jobRepo.findOne({ where: { id: dispute.jobId } }) : null;
    if (job) {
      await this.jobRepo.update(job.id, { status: JobStatus.DELIVERED });

      const payment = await this.paymentRepo.findOne({ where: { jobId: job.id } as any });
      if (payment) {
        await this.paymentRepo.update(payment.id, { status: 'released' } as any);
      }

      if (job.transporterId) {
        this.eventsGateway.notifyUser(job.transporterId, 'dispute:resolved', {
          message: 'Dispute resolved in your favor. Payment has been released.',
          result: 'transporter',
        });
        await this.pushService.sendToUser(job.transporterId, {
          title: '✅ Dispute Resolved',
          body: 'Dispute resolved in your favor. Payment has been released.',
          icon: '/icon-192.png',
        }).catch(() => {});
      }

      if (job.customerId) {
        this.eventsGateway.notifyUser(job.customerId, 'dispute:resolved', {
          message: 'Dispute resolved in favor of transporter.',
          result: 'transporter',
        });
        await this.pushService.sendToUser(job.customerId, {
          title: '❌ Dispute Resolved',
          body: 'The dispute was resolved in favor of the transporter.',
          icon: '/icon-192.png',
        }).catch(() => {});
      }
    }

    return { message: 'Dispute resolved in favor of transporter' };
  }
}
