// trac-backend/src/calling/calling.service.ts
// Day 26: In-app calling via Agora.io

import { Injectable, Logger, BadRequestException, ForbiddenException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { RtcTokenBuilder, RtcRole } from 'agora-token';
import { JobsService } from '../jobs/jobs.service';
import { JobStatus } from '../jobs/entities/job.entity';

// How long a "the transporter joined" marker stays valid for the customer's
// reconnect-resync check (see acceptedAt below). Comfortably longer than any
// realistic ringing duration, short enough that a stale marker from a much
// earlier call on the same job can't bleed into a later one.
const ACCEPTED_MARKER_TTL_MS = 2 * 60 * 1000;

@Injectable()
export class CallingService {
  private readonly logger = new Logger(CallingService.name);

  // jobId -> when the transporter's REST /calling/join call last succeeded.
  // Exists because the live call:accepted socket event is the only other way
  // the caller learns the call was picked up, and on flaky mobile
  // connections that event can be queued-and-never-redelivered if the
  // caller's socket doesn't reconnect in time. This REST-backed marker lets
  // the caller's client actively re-check "was this accepted?" the moment
  // its socket reconnects, instead of only passively waiting on a socket
  // event that may never arrive.
  private acceptedAt = new Map<string, number>();

  constructor(
    private config: ConfigService,
    private jobsService: JobsService,
  ) {}

  private get appId() { return this.config.get<string>('AGORA_APP_ID'); }
  private get appCert() { return this.config.get<string>('AGORA_APP_CERTIFICATE'); }

  markAccepted(jobId: string) {
    this.acceptedAt.set(jobId, Date.now());
  }

  wasRecentlyAccepted(jobId: string): boolean {
    const at = this.acceptedAt.get(jobId);
    if (!at) return false;
    if (Date.now() - at > ACCEPTED_MARKER_TTL_MS) {
      this.acceptedAt.delete(jobId);
      return false;
    }
    return true;
  }

  // ─── Generate channel name for a job ────────────────────────────────────────
  getChannelName(jobId: string): string {
    return `trac-${jobId}`;
  }

  // ─── Generate Agora RTC token ────────────────────────────────────────────────
  generateToken(channelName: string, uid: number, role: 'publisher' | 'subscriber' = 'publisher'): string {
    const appId   = this.appId;
    const appCert = this.appCert;

    if (!appId || !appCert) {
      throw new BadRequestException('Agora credentials not configured');
    }

    const agoraRole = role === 'publisher' ? RtcRole.PUBLISHER : RtcRole.SUBSCRIBER;
    const expireTime = 3600;
    const currentTime = Math.floor(Date.now() / 1000);
    const privilegeExpiredTs = currentTime + expireTime;

    const token = RtcTokenBuilder.buildTokenWithUid(
      appId,
      appCert,
      channelName,
      uid,
      agoraRole,
      privilegeExpiredTs,
      privilegeExpiredTs,
    );

    this.logger.log(`Agora token generated for channel: ${channelName} uid: ${uid}`);
    return token;
  }

  // ─── Initiate a call for a job ───────────────────────────────────────────────
  async initiateCall(jobId: string, userId: string): Promise<{ token: string; channelName: string; appId: string; uid: number; transporterId: string }> {
    try {
      const appId = this.appId;
      if (!appId || !this.appCert) {
        throw new BadRequestException('Agora credentials not configured');
      }

      const job = await this.jobsService.findById(jobId);

      if (job.customerId !== userId) {
        throw new ForbiddenException('Only the customer for this job can initiate a call');
      }

      if (!job.customerId || !job.transporterId) {
        throw new BadRequestException('Job does not have both customer and transporter assigned');
      }

      if (job.status === JobStatus.BIDDING) {
        throw new BadRequestException('Cannot initiate call - job has not been accepted yet');
      }

      if (job.status !== JobStatus.ACCEPTED && job.status !== JobStatus.IN_TRANSIT) {
        throw new BadRequestException(`Cannot initiate call for a job with status: ${job.status}`);
      }

      const channelName = this.getChannelName(jobId);
      const uid = 0;
      const token = this.generateToken(channelName, uid);

      return { token, channelName, appId, uid, transporterId: job.transporterId };
    } catch (err) {
      this.logger.error('initiateCall failed', err instanceof Error ? err.stack : String(err));
      throw err;
    }
  }

  // ─── Create call session (join / token refresh) ──────────────────────────────
  async createCallSession(jobId: string, userId: string, role: 'caller' | 'receiver' | 'publisher'): Promise<{
    appId: string;
    channelName: string;
    token: string;
    uid: number;
  }> {
    const appId = this.appId;
    if (!appId) throw new BadRequestException('Agora not configured');

    const job = await this.jobsService.findById(jobId);
    const isCustomer = job.customerId === userId;
    const isTransporter = job.transporterId === userId;
    if (!isCustomer && !isTransporter) {
      throw new ForbiddenException('You are not a party to this job');
    }
    if (role === 'receiver' && !isTransporter) {
      throw new ForbiddenException('Only the assigned transporter can join this call');
    }

    const channelName = this.getChannelName(jobId);

    const base = Math.floor(Math.random() * 40000) + 1000;
    const uid = role === 'caller' ? base * 2 : base * 2 + 1;

    const token = this.generateToken(channelName, uid, 'publisher');

    return { appId, channelName, token, uid };
  }
}
