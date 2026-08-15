// trac-backend/src/disputes/disputes.controller.ts
// Day 18: Disputes controller — clean rewrite

import {
  Controller,
  Post,
  Get,
  Patch,
  Body,
  Param,
  Req,
  UseGuards,
  ForbiddenException,
} from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { DisputesService } from './disputes.service';
import { DisputeReason } from './entities/dispute.entity';

@Controller('disputes')
@UseGuards(AuthGuard('jwt'))
export class DisputesController {
  constructor(private readonly disputesService: DisputesService) {}

  // ─── POST /disputes ─────────────────────────────────────────────────────────
  @Post()
  async raiseDispute(
    @Req() req: any,
    @Body() body: { jobId: string; reason: DisputeReason; description: string },
  ) {
    return this.disputesService.raiseDispute(
      req.user.id,
      req.user.role,
      body.jobId,
      body.reason,
      body.description,
    );
  }

  // ─── GET /disputes/me ───────────────────────────────────────────────────────
  @Get('me')
  async getMyDisputes(@Req() req: any) {
    return this.disputesService.getMyDisputes(req.user.id);
  }

  // ─── GET /disputes/job/:jobId ───────────────────────────────────────────────
  @Get('job/:jobId')
  async getDisputeByJob(@Param('jobId') jobId: string, @Req() req: any) {
    return this.disputesService.getDisputeByJob(jobId, req.user.id, req.user.role);
  }

  // ─── GET /disputes/admin/all ────────────────────────────────────────────────
  @Get('admin/all')
  async getAllDisputes(@Req() req: any) {
    if (req.user.role !== 'admin') throw new ForbiddenException('Admin access required');
    return this.disputesService.getAllDisputes();
  }

  // Keep parameterized routes after fixed routes so "admin/all" is not treated as an ID.
  // ─── GET /disputes/:id ──────────────────────────────────────────────────────
  @Get(':id')
  async getDispute(@Param('id') id: string, @Req() req: any) {
    return this.disputesService.getDisputeByIdForUser(id, req.user.id, req.user.role);
  }

  // ─── PATCH /disputes/:id/resolve ────────────────────────────────────────────
  @Patch(':id/resolve')
  async resolveDispute(
    @Param('id') id: string,
    @Req() req: any,
    @Body() body: { resolutionNote: string },
  ) {
    if (req.user.role !== 'admin') throw new ForbiddenException('Admin access required');
    return this.disputesService.resolveDispute(id, body.resolutionNote);
  }

}
