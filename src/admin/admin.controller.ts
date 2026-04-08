// trac-backend/src/admin/admin.controller.ts
// Day 22: Admin endpoints — platform overview

import { Controller, Get, Patch, Param, Body, Req, UseGuards } from '@nestjs/common';
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
  async getAllUsers() {
    return this.adminService.getAllUsers();
  }

  // ─── GET /admin/jobs ─────────────────────────────────────────────────────────
  @Get('jobs')
  async getAllJobs() {
    return this.adminService.getRecentJobs();
  }
}