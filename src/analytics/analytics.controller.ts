// trac-backend/src/analytics/analytics.controller.ts
// Day 20: Customer analytics endpoints

import { Controller, Get, Req, UseGuards } from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { AnalyticsService } from './analytics.service';

@Controller('analytics')
@UseGuards(AuthGuard('jwt'))
export class AnalyticsController {
  constructor(private readonly analyticsService: AnalyticsService) {}

  // ─── GET /analytics/customer ─────────────────────────────────────────────────
  @Get('customer')
  async getCustomerAnalytics(@Req() req: any) {
    return this.analyticsService.getCustomerAnalytics(req.user.id);
  }

  // ─── GET /analytics/transporter ──────────────────────────────────────────────
  @Get('transporter')
  async getTransporterAnalytics(@Req() req: any) {
    return this.analyticsService.getTransporterAnalytics(req.user.id);
  }
}