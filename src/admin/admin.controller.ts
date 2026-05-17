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
  async getAllDisputes() {
    return this.adminService.getAllDisputes();
  }

  // ─── PATCH /admin/disputes/:id/resolve ───────────────────────────────────────
  @Patch('disputes/:id/resolve')
  async resolveDispute(
    @Param('id') id: string,
    @Body() body: { resolutionNote: string },
  ) {
    return this.adminService.resolveDispute(id, body.resolutionNote);
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