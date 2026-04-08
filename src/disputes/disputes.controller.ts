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
  async getDisputeByJob(@Param('jobId') jobId: string) {
    return this.disputesService.getDisputeByJob(jobId);
  }

  // ─── GET /disputes/:id ──────────────────────────────────────────────────────
  @Get(':id')
  async getDispute(@Param('id') id: string) {
    return this.disputesService.getDisputeById(id);
  }

  // ─── PATCH /disputes/:id/resolve ────────────────────────────────────────────
  @Patch(':id/resolve')
  async resolveDispute(
    @Param('id') id: string,
    @Body() body: { resolutionNote: string },
  ) {
    return this.disputesService.resolveDispute(id, body.resolutionNote);
  }

  // ─── GET /disputes/admin/all ────────────────────────────────────────────────
  @Get('admin/all')
  async getAllDisputes() {
    return this.disputesService.getAllDisputes();
  }
}