// trac-backend/src/calling/calling.service.ts
// Day 26: In-app calling via Agora.io

import { Injectable, Logger, BadRequestException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { RtcTokenBuilder, RtcRole } from 'agora-token';

@Injectable()
export class CallingService {
  private readonly logger = new Logger(CallingService.name);

  constructor(private config: ConfigService) {}

  private get appId() { return this.config.get<string>('AGORA_APP_ID'); }
  private get appCert() { return this.config.get<string>('AGORA_APP_CERTIFICATE'); }

  // ─── Generate channel name for a job ────────────────────────────────────────
  getChannelName(jobId: string): string {
    return `trac-${jobId.slice(0, 8).toLowerCase()}`;
  }

  // ─── Generate Agora RTC token ────────────────────────────────────────────────
  generateToken(channelName: string, uid: number, role: 'publisher' | 'subscriber' = 'publisher'): string {
    const appId   = this.appId;
    const appCert = this.appCert;

    if (!appId || !appCert) {
      throw new BadRequestException('Agora credentials not configured');
    }

    const agoraRole = role === 'publisher' ? RtcRole.PUBLISHER : RtcRole.SUBSCRIBER;
    const expireTime = 3600; // 1 hour in seconds
    const currentTime = Math.floor(Date.now() / 1000);
    const privilegeExpireTime = currentTime + expireTime;

    const token = RtcTokenBuilder.buildTokenWithUid(
      appId,
      appCert,
      channelName,
      uid,
      agoraRole,
      privilegeExpireTime,
      privilegeExpireTime,
    );

    this.logger.log(`📞 Agora token generated for channel: ${channelName} uid: ${uid}`);
    return token;
  }

  // ─── Create call session ─────────────────────────────────────────────────────
  // Returns everything frontend needs to join the call

  createCallSession(jobId: string, userId: string, role: 'caller' | 'receiver' | 'publisher'): {
    appId: string;
    channelName: string;
    token: string;
    uid: number;
  } {
    const appId = this.appId;
    if (!appId) throw new BadRequestException('Agora not configured');

    const channelName = this.getChannelName(jobId);

    // Generate unique UID per role — caller gets even, receiver gets odd
    const base = Math.floor(Math.random() * 40000) + 1000;
    const uid = role === 'caller' ? base * 2 : base * 2 + 1;

    const token = this.generateToken(channelName, uid, 'publisher');

    return { appId, channelName, token, uid };
  }
}