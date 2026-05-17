// trac-backend/src/admin/admin.service.ts
// Day 22: Admin service — platform-wide data

import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, MoreThanOrEqual } from 'typeorm';
import { Job, JobStatus } from '../jobs/entities/job.entity';
import { Payment, PaymentStatus } from '../payments/entities/payment.entity';
import { Dispute, DisputeStatus } from '../disputes/entities/dispute.entity';
import { User } from '../users/entities/user.entity';
import { Rating } from '../ratings/entities/rating.entity';
import { PushService } from '../push/push.service';

@Injectable()
export class AdminService {
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
    await this.disputeRepo.update(id, {
      status: DisputeStatus.RESOLVED,
      resolutionNote,
      resolvedAt: new Date(),
    });
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
        id: u.id,
        fullName: u.fullName,
        email: u.email,
        phone: u.phone,
        role: u.role,
        isVerified: u.isVerified,
        isSuspended: (u as any).isSuspended || false,
        kycStatus: (u as any).kycStatus || 'pending',
        kycTier: (u as any).kycTier || 0,
        rating: u.rating,
        tripsCompleted: u.tripsCompleted,
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
      createdAt: user.createdAt,
      recentJobs: jobs,
      recentPayments: payments,
    };
  }

  // ─── Suspend / unsuspend user ────────────────────────────────────────────────

  async suspendUser(userId: string) {
    const user = await this.userRepo.findOne({ where: { id: userId } });
    if (!user) throw new Error('User not found');

    const isSuspended = !((user as any).isSuspended || false);
    await this.userRepo.update(userId, { isSuspended } as any);

    return {
      message: isSuspended ? 'User suspended' : 'User unsuspended',
      isSuspended,
    };
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
}