// trac-backend/src/analytics/analytics.service.ts
// Day 20: Analytics service — real data from DB

import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Job, JobStatus } from '../jobs/entities/job.entity';
import { Payment, PaymentStatus } from '../payments/entities/payment.entity';
import { Rating } from '../ratings/entities/rating.entity';

@Injectable()
export class AnalyticsService {
  constructor(
    @InjectRepository(Job)
    private jobRepo: Repository<Job>,
    @InjectRepository(Payment)
    private paymentRepo: Repository<Payment>,
    @InjectRepository(Rating)
    private ratingRepo: Repository<Rating>,
  ) {}

  // ─── Customer Analytics ──────────────────────────────────────────────────────

  async getCustomerAnalytics(customerId: string) {
    const jobs = await this.jobRepo.find({ where: { customerId }, order: { createdAt: 'ASC' } });
    const payments = await this.paymentRepo.find({ where: { customerId }, order: { createdAt: 'ASC' } });

    // ── Status breakdown ──
    const statusBreakdown = {
      bidding:    jobs.filter(j => j.status === JobStatus.BIDDING).length,
      accepted:   jobs.filter(j => j.status === JobStatus.ACCEPTED).length,
      inTransit:  jobs.filter(j => j.status === JobStatus.IN_TRANSIT).length,
      delivered:  jobs.filter(j => j.status === JobStatus.DELIVERED).length,
      cancelled:  jobs.filter(j => j.status === JobStatus.CANCELLED).length,
    };

    // ── Monthly spending (last 6 months) ──
    const monthlySpending = this.getMonthlyData(payments, 6);

    // ── Top routes ──
    const routeCounts: Record<string, number> = {};
    jobs.forEach(j => {
      const route = `${j.pickupState} → ${j.deliveryState}`;
      routeCounts[route] = (routeCounts[route] || 0) + 1;
    });
    const topRoutes = Object.entries(routeCounts)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5)
      .map(([route, count]) => ({ route, count }));

    // ── Total stats ──
    const totalSpent = payments
      .filter(p => p.status === PaymentStatus.RELEASED || p.status === PaymentStatus.SUCCESS)
      .reduce((s, p) => s + Number(p.amount), 0);

    const totalCashback = payments
      .filter(p => p.customerCashback)
      .reduce((s, p) => s + Number(p.customerCashback), 0);

    // ── Average delivery time (in hours) ──
    const deliveredJobs = jobs.filter(j => j.status === JobStatus.DELIVERED && j.pickedUpAt && j.deliveredAt);
    const avgDeliveryHours = deliveredJobs.length > 0
      ? deliveredJobs.reduce((s, j) => {
          const hours = (new Date(j.deliveredAt).getTime() - new Date(j.pickedUpAt).getTime()) / (1000 * 60 * 60);
          return s + hours;
        }, 0) / deliveredJobs.length
      : 0;

    // ── Cargo types ──
    const cargoTypes: Record<string, number> = {};
    jobs.forEach(j => {
      const type = j.cargoDescription?.split(' ')[0] || 'Other';
      cargoTypes[type] = (cargoTypes[type] || 0) + 1;
    });

    return {
      summary: {
        totalJobs: jobs.length,
        totalSpent,
        totalCashback,
        avgDeliveryHours: +avgDeliveryHours.toFixed(1),
        completionRate: jobs.length > 0
          ? +((statusBreakdown.delivered / jobs.length) * 100).toFixed(1)
          : 0,
      },
      statusBreakdown,
      monthlySpending,
      topRoutes,
      cargoTypes: Object.entries(cargoTypes)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 5)
        .map(([type, count]) => ({ type, count })),
    };
  }

  // ─── Transporter Analytics ───────────────────────────────────────────────────

  async getTransporterAnalytics(transporterId: string) {
    const jobs = await this.jobRepo.find({ where: { transporterId }, order: { createdAt: 'ASC' } });
    const ratings = await this.ratingRepo.find({ where: { toUserId: transporterId }, order: { createdAt: 'ASC' } });

    // ── Monthly earnings (last 6 months) ──
    const monthlyEarnings = this.getMonthlyEarnings(jobs, 6);

    // ── Status breakdown ──
    const statusBreakdown = {
      accepted:  jobs.filter(j => j.status === JobStatus.ACCEPTED).length,
      inTransit: jobs.filter(j => j.status === JobStatus.IN_TRANSIT).length,
      delivered: jobs.filter(j => j.status === JobStatus.DELIVERED).length,
      cancelled: jobs.filter(j => j.status === JobStatus.CANCELLED).length,
    };

    // ── Rating breakdown ──
    const ratingBreakdown = [1, 2, 3, 4, 5].map(star => ({
      star,
      count: ratings.filter(r => r.stars === star).length,
    }));

    const avgRating = ratings.length > 0
      ? +(ratings.reduce((s, r) => s + r.stars, 0) / ratings.length).toFixed(1)
      : 0;

    // ── Top routes ──
    const routeCounts: Record<string, number> = {};
    jobs.forEach(j => {
      const route = `${j.pickupState} → ${j.deliveryState}`;
      routeCounts[route] = (routeCounts[route] || 0) + 1;
    });
    const topRoutes = Object.entries(routeCounts)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5)
      .map(([route, count]) => ({ route, count }));

    // ── Total earnings ──
    const totalEarned = jobs
      .filter(j => j.status === JobStatus.DELIVERED && j.acceptedAmount)
      .reduce((s, j) => s + Number(j.acceptedAmount) * 0.9, 0);

    // ── Avg delivery time ──
    const deliveredJobs = jobs.filter(j => j.status === JobStatus.DELIVERED && j.pickedUpAt && j.deliveredAt);
    const avgDeliveryHours = deliveredJobs.length > 0
      ? deliveredJobs.reduce((s, j) => {
          const hours = (new Date(j.deliveredAt).getTime() - new Date(j.pickedUpAt).getTime()) / (1000 * 60 * 60);
          return s + hours;
        }, 0) / deliveredJobs.length
      : 0;

    return {
      summary: {
        totalJobs: jobs.length,
        totalDelivered: statusBreakdown.delivered,
        totalEarned: +totalEarned.toFixed(2),
        avgRating,
        totalRatings: ratings.length,
        avgDeliveryHours: +avgDeliveryHours.toFixed(1),
        completionRate: jobs.length > 0
          ? +((statusBreakdown.delivered / jobs.length) * 100).toFixed(1)
          : 0,
      },
      statusBreakdown,
      monthlyEarnings,
      ratingBreakdown,
      topRoutes,
    };
  }

  // ─── Helpers ─────────────────────────────────────────────────────────────────

  private getMonthlyData(payments: Payment[], months: number) {
    const result: { month: string; total: number; count: number }[] = [];
    for (let i = months - 1; i >= 0; i--) {
      const date = new Date();
      date.setMonth(date.getMonth() - i);
      const month = date.toLocaleString('en-NG', { month: 'short' });
      const year = date.getFullYear();
      const monthPayments = payments.filter(p => {
        const d = new Date(p.createdAt);
        return d.getMonth() === date.getMonth() && d.getFullYear() === year;
      });
      const total = monthPayments.reduce((s, p) => s + Number(p.amount), 0);
      result.push({ month: `${month} ${year}`, total, count: monthPayments.length });
    }
    return result;
  }

  private getMonthlyEarnings(jobs: Job[], months: number) {
    const result: { month: string; total: number; count: number }[] = [];
    for (let i = months - 1; i >= 0; i--) {
      const date = new Date();
      date.setMonth(date.getMonth() - i);
      const month = date.toLocaleString('en-NG', { month: 'short' });
      const year = date.getFullYear();
      const monthJobs = jobs.filter(j => {
        if (j.status !== JobStatus.DELIVERED || !j.acceptedAmount) return false;
        const d = new Date(j.createdAt);
        return d.getMonth() === date.getMonth() && d.getFullYear() === year;
      });
      const total = monthJobs.reduce((s, j) => s + Number(j.acceptedAmount) * 0.9, 0);
      result.push({ month: `${month} ${year}`, total: +total.toFixed(2), count: monthJobs.length });
    }
    return result;
  }
}