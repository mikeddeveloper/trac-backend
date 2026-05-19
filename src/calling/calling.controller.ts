// trac-backend/src/calling/calling.controller.ts
// Day 26: Agora calling controller

import { Controller, Post, Param, Req, UseGuards } from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { CallingService } from './calling.service';
import { EventsGateway } from '../events/events.gateway';

@Controller('calling')
@UseGuards(AuthGuard('jwt'))
export class CallingController {
  constructor(
    private readonly callingService: CallingService,
    private readonly eventsGateway: EventsGateway,
  ) {}

  // ─── POST /calling/initiate/:jobId ───────────────────────────────────────────
  // Customer initiates a call — validates job state, returns Agora token
  @Post('initiate/:jobId')
  async initiateCall(@Param('jobId') jobId: string, @Req() req: any) {
    const session = await this.callingService.initiateCall(jobId);
    const callerName = req.user.fullName || req.user.firstName || 'Customer';

    // Notify transporter via socket
    this.eventsGateway.server.emit(`call:incoming:${jobId}`, {
      jobId,
      channelName: session.channelName,
      callerName,
      callerId: req.user.id,
    });

    return { ...session, callerName };
  }

  // ─── POST /calling/join/:jobId ───────────────────────────────────────────────
  // Transporter joins the call — gets their own token
  @Post('join/:jobId')
  async joinCall(@Param('jobId') jobId: string, @Req() req: any) {
    const session = this.callingService.createCallSession(jobId, req.user.id, 'receiver');
    return session;
  }

  // ─── POST /calling/token/:jobId ──────────────────────────────────────────────
  // Get a fresh token (for reconnection)
  @Post('token/:jobId')
  async getToken(@Param('jobId') jobId: string, @Req() req: any) {
    const session = this.callingService.createCallSession(jobId, req.user.id, 'publisher');
    return session;
  }
}