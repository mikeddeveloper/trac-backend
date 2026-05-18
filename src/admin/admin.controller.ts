// trac-backend/src/admin/admin.controller.ts
// Day 22: Admin endpoints — platform overview

import { Controller, Get, Patch, Delete, Param, Query, Body, Req, Request, UseGuards, ForbiddenException } from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { AdminService } from './admin.service';

@Controller('admin')
@UseGuards(AuthGuard('jwt'))
export class AdminController {
  constructor(private readonly adminService: AdminService) {}

  // ─── GET /admin/overview ─────────────────────────────────────────────────────
  @Get('overview')
  async getOverview(@Req() req: any) {
    return this.adminService.getPlatformOverview();
  }

  // ─── GET /admin/disputes ─────────────────────────────────────────────────────
  @Get('disputes')
  @UseGuards(AuthGuard('jwt'))
  async getDisputes(@Request() req: any) {
    if (req.user.role !== 'admin') throw new ForbiddenException();
    return this.adminService.getDisputes();
  }

  // ─── PATCH /admin/disputes/:id/resolve ───────────────────────────────────────
  @Patch('disputes/:id/resolve')
  @UseGuards(AuthGuard('jwt'))
  async resolveDispute(
    @Request() req: any,
    @Param('id') id: string,
    @Body() body: { resolutionNote: string },
  ) {
    if (req.user.role !== 'admin') throw new ForbiddenException();
    return this.adminService.resolveDispute(id, body.resolutionNote);
  }

  // ─── PATCH /admin/disputes/:id/rule-customer ──────────────────────────────────
  @Patch('disputes/:id/rule-customer')
  @UseGuards(AuthGuard('jwt'))
  async ruleForCustomer(@Request() req: any, @Param('id') id: string) {
    if (req.user.role !== 'admin') throw new ForbiddenException();
    return this.adminService.ruleForCustomer(id);
  }

  // ─── PATCH /admin/disputes/:id/rule-transporter ───────────────────────────────
  @Patch('disputes/:id/rule-transporter')
  @UseGuards(AuthGuard('jwt'))
  async ruleForTransporter(@Request() req: any, @Param('id') id: string) {
    if (req.user.role !== 'admin') throw new ForbiddenException();
    return this.adminService.ruleForTransporter(id);
  }

  // ─── GET /admin/users ────────────────────────────────────────────────────────
  @Get('users')
  @UseGuards(AuthGuard('jwt'))
  async getAllUsers(
    @Request() req: any,
    @Query('role') role?: string,
    @Query('search') search?: string,
    @Query('page') page?: string,
    @Query('limit') limit?: string,
  ) {
    if (req.user.role !== 'admin') throw new ForbiddenException();
    return this.adminService.getAllUsers(role, search, Number(page) || 1, Number(limit) || 10);
  }

  // ─── GET /admin/users/:id ─────────────────────────────────────────────────────
  @Get('users/:id')
  @UseGuards(AuthGuard('jwt'))
  async getUserById(@Request() req: any, @Param('id') id: string) {
    if (req.user.role !== 'admin') throw new ForbiddenException();
    return this.adminService.getUserById(id);
  }

  // ─── PATCH /admin/users/:id/suspend ──────────────────────────────────────────
  @Patch('users/:id/suspend')
  @UseGuards(AuthGuard('jwt'))
  async suspendUser(@Request() req: any, @Param('id') id: string) {
    if (req.user.role !== 'admin') throw new ForbiddenException();
    return this.adminService.suspendUser(id);
  }

  // ─── PATCH /admin/users/:id/verify ───────────────────────────────────────────
  @Patch('users/:id/verify')
  @UseGuards(AuthGuard('jwt'))
  async verifyUser(@Request() req: any, @Param('id') id: string) {
    if (req.user.role !== 'admin') throw new ForbiddenException();
    return this.adminService.verifyUser(id);
  }

  // ─── DELETE /admin/users/:id ──────────────────────────────────────────────────
  @Delete('users/:id')
  @UseGuards(AuthGuard('jwt'))
  async deleteUser(@Request() req: any, @Param('id') id: string) {
    if (req.user.role !== 'admin') throw new ForbiddenException();
    return this.adminService.deleteUser(id);
  }

  // ─── GET /admin/jobs ─────────────────────────────────────────────────────────
  @Get('jobs')
  @UseGuards(AuthGuard('jwt'))
  async getAllJobs(
    @Request() req: any,
    @Query('status') status?: string,
    @Query('search') search?: string,
    @Query('page') page?: string,
    @Query('limit') limit?: string,
  ) {
    if (req.user.role !== 'admin') throw new ForbiddenException();
    return this.adminService.getAllJobs(status, search, Number(page) || 1, Number(limit) || 10);
  }

  // ─── GET /admin/jobs/:id ──────────────────────────────────────────────────────
  @Get('jobs/:id')
  @UseGuards(AuthGuard('jwt'))
  async getJobById(@Request() req: any, @Param('id') id: string) {
    if (req.user.role !== 'admin') throw new ForbiddenException();
    return this.adminService.getJobById(id);
  }

  // ─── PATCH /admin/jobs/:id/cancel ─────────────────────────────────────────────
  @Patch('jobs/:id/cancel')
  @UseGuards(AuthGuard('jwt'))
  async cancelJob(@Request() req: any, @Param('id') id: string) {
    if (req.user.role !== 'admin') throw new ForbiddenException();
    return this.adminService.cancelJob(id);
  }

  // ─── GET /admin/analytics/jobs ────────────────────────────────────────────────
  @Get('analytics/jobs')
  @UseGuards(AuthGuard('jwt'))
  async getJobAnalytics(@Request() req: any) {
    if (req.user.role !== 'admin') throw new ForbiddenException();
    return this.adminService.getJobAnalytics();
  }

  // ─── GET /admin/payments/stats ────────────────────────────────────────────────
  @Get('payments/stats')
  @UseGuards(AuthGuard('jwt'))
  async getPaymentStats(@Request() req: any) {
    if (req.user.role !== 'admin') throw new ForbiddenException();
    return this.adminService.getPaymentStats();
  }

  // ─── GET /admin/payments ──────────────────────────────────────────────────────
  @Get('payments')
  @UseGuards(AuthGuard('jwt'))
  async getAllPayments(
    @Request() req: any,
    @Query('status') status?: string,
    @Query('startDate') startDate?: string,
    @Query('endDate') endDate?: string,
    @Query('page') page?: string,
    @Query('limit') limit?: string,
  ) {
    if (req.user.role !== 'admin') throw new ForbiddenException();
    return this.adminService.getAllPayments(status, startDate, endDate, Number(page) || 1, Number(limit) || 10);
  }

  // ─── PATCH /admin/payments/:id/release ───────────────────────────────────────
  @Patch('payments/:id/release')
  @UseGuards(AuthGuard('jwt'))
  async releasePayment(@Request() req: any, @Param('id') id: string) {
    if (req.user.role !== 'admin') throw new ForbiddenException();
    return this.adminService.releasePayment(id);
  }

  // ─── PATCH /admin/payments/:id/refund ────────────────────────────────────────
  @Patch('payments/:id/refund')
  @UseGuards(AuthGuard('jwt'))
  async refundPayment(@Request() req: any, @Param('id') id: string) {
    if (req.user.role !== 'admin') throw new ForbiddenException();
    return this.adminService.refundPayment(id);
  }

  // ─── GET /admin/analytics/revenue ────────────────────────────────────────────
  @Get('analytics/revenue')
  @UseGuards(AuthGuard('jwt'))
  async getRevenueAnalytics(@Request() req: any) {
    if (req.user.role !== 'admin') throw new ForbiddenException();
    return this.adminService.getRevenueAnalytics();
  }

  // ─── GET /admin/analytics/users ──────────────────────────────────────────────
  @Get('analytics/users')
  @UseGuards(AuthGuard('jwt'))
  async getUserAnalytics(@Request() req: any) {
    if (req.user.role !== 'admin') throw new ForbiddenException();
    return this.adminService.getUserAnalytics();
  }

  // ─── GET /admin/verifications/pending ────────────────────────────────────────
  @Get('verifications/pending')
  @UseGuards(AuthGuard('jwt'))
  async getPendingVerifications(@Request() req: any) {
    if (req.user.role !== 'admin') throw new ForbiddenException();
    return this.adminService.getPendingVerifications();
  }

  // ─── GET /admin/verifications/approved ───────────────────────────────────────
  @Get('verifications/approved')
  @UseGuards(AuthGuard('jwt'))
  async getApprovedVerifications(@Request() req: any) {
    if (req.user.role !== 'admin') throw new ForbiddenException();
    return this.adminService.getApprovedVerifications();
  }

  // ─── PATCH /admin/kyc/:userId/approve ────────────────────────────────────────
  @Patch('kyc/:userId/approve')
  @UseGuards(AuthGuard('jwt'))
  async approveKYC(@Request() req: any, @Param('userId') userId: string) {
    if (req.user.role !== 'admin') throw new ForbiddenException();
    return this.adminService.approveKYC(userId);
  }

  // ─── PATCH /admin/kyc/:userId/reject ─────────────────────────────────────────
  @Patch('kyc/:userId/reject')
  @UseGuards(AuthGuard('jwt'))
  async rejectKYC(
    @Request() req: any,
    @Param('userId') userId: string,
    @Body() body: { reason: string },
  ) {
    if (req.user.role !== 'admin') throw new ForbiddenException();
    return this.adminService.rejectKYC(userId, body.reason);
  }

  // ─── PATCH /admin/kyc/:userId/revoke ─────────────────────────────────────────
  @Patch('kyc/:userId/revoke')
  @UseGuards(AuthGuard('jwt'))
  async revokeVerification(@Request() req: any, @Param('userId') userId: string) {
    if (req.user.role !== 'admin') throw new ForbiddenException();
    return this.adminService.revokeVerification(userId);
  }

  // ─── GET /admin/analytics/kyc ────────────────────────────────────────────────
  @Get('analytics/kyc')
  @UseGuards(AuthGuard('jwt'))
  async getKycAnalytics(@Request() req: any) {
    if (req.user.role !== 'admin') throw new ForbiddenException();
    return this.adminService.getKycAnalytics();
  }

  // ─── GET /admin/settings ─────────────────────────────────────────────────────
  @Get('settings')
  @UseGuards(AuthGuard('jwt'))
  async getSettings(@Request() req: any) {
    if (req.user.role !== 'admin') throw new ForbiddenException();
    return this.adminService.getSettings();
  }

  // ─── PATCH /admin/settings ───────────────────────────────────────────────────
  @Patch('settings')
  @UseGuards(AuthGuard('jwt'))
  async updateSettings(@Request() req: any, @Body() body: any) {
    if (req.user.role !== 'admin') throw new ForbiddenException();
    return this.adminService.updateSettings(body);
  }

  // ─── GET /admin/stats ────────────────────────────────────────────────────────
  @Get('stats')
  @UseGuards(AuthGuard('jwt'))
  async getStats(@Request() req: any) {
    if (req.user.role !== 'admin') throw new ForbiddenException();
    return this.adminService.getStats();
  }

  // ─── GET /admin/activity ─────────────────────────────────────────────────────
  @Get('activity')
  @UseGuards(AuthGuard('jwt'))
  async getActivity(@Request() req: any) {
    if (req.user.role !== 'admin') throw new ForbiddenException();
    return this.adminService.getActivity();
  }
}