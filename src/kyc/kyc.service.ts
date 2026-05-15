import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { User } from '../users/entities/user.entity';
import { PushService } from '../push/push.service';
import axios from 'axios';

@Injectable()
export class KycService {
  private readonly logger = new Logger(KycService.name);
  private readonly baseUrl = 'https://verification.didit.me';

  constructor(
    private configService: ConfigService,
    @InjectRepository(User)
    private userRepo: Repository<User>,
    private pushService: PushService,
  ) {}

  private get headers() {
    return {
      'x-api-key': this.configService.get('DIDIT_API_KEY'),
      'Content-Type': 'application/json',
    };
  }

  async createVerificationSession(userId: string) {
    try {
      const workflowId  = this.configService.get('DIDIT_WORKFLOW_ID');
      const backendUrl  = this.configService.get('BACKEND_URL')  || 'https://trac-backend-399c.onrender.com';
      const frontendUrl = this.configService.get('FRONTEND_URL') || 'https://trac-logistics-web-app.vercel.app';

      if (!workflowId) {
        throw new Error('DIDIT_WORKFLOW_ID not configured in environment variables');
      }

      if (!this.configService.get('DIDIT_API_KEY')) {
        throw new Error('DIDIT_API_KEY not configured in environment variables');
      }

      this.logger.log(`Creating Didit session for user ${userId} with workflow ${workflowId}`);

      const response = await axios.post(
        `${this.baseUrl}/v3/sessions/`,
        {
          workflow_id:  workflowId,
          vendor_data:  userId,
          callback:     `${backendUrl}/api/kyc/webhook`,
          redirect_url: `${frontendUrl}/dashboard/kyc/complete`,
        },
        { headers: this.headers }
      );

      const session = response.data;
      this.logger.log(`✅ Session created: ${session.session_id}`);

      return {
        sessionId:       session.session_id,
        verificationUrl: session.url,
        status:          session.status,
      };
    } catch (error: any) {
      this.logger.error('Didit session error:', error?.response?.data || error.message);
      throw new Error(
        error?.response?.data?.detail  ||
        error?.response?.data?.message ||
        error.message                  ||
        'Failed to create verification session'
      );
    }
  }

  async handleWebhook(payload: any) {
    this.logger.log(`📩 Didit webhook received: ${JSON.stringify(payload)}`);

    const status = payload?.status || payload?.verification_status;
    const userId = payload?.vendor_data;

    if (!userId) {
      this.logger.warn('Webhook received without vendor_data');
      return { received: true };
    }

    if (status === 'Approved') {
      await this.userRepo.update(userId, {
        isVerified:      true,
        ninVerified:     true,
        licenseVerified: true,
        kycStatus:       'approved',
        kycTier:         1,
        kycCompletedAt:  new Date(),
      } as any);

      await this.pushService.sendToUser(userId, {
        title: '✅ Account Verified!',
        body:  'Your identity has been verified. You can now bid on jobs.',
        icon:  '/icon-192.png',
      }).catch(() => {});

      this.logger.log(`🎉 User ${userId} verified via Didit`);
    } else if (status === 'Declined') {
      await this.userRepo.update(userId, {
        kycStatus: 'rejected',
      } as any);

      await this.pushService.sendToUser(userId, {
        title: '❌ Verification Failed',
        body:  'Your verification was unsuccessful. Please try again with valid documents.',
        icon:  '/icon-192.png',
      }).catch(() => {});

      this.logger.log(`❌ User ${userId} verification declined`);
    }

    return { received: true };
  }

  async getSessionStatus(sessionId: string) {
    try {
      const response = await axios.get(
        `${this.baseUrl}/v3/sessions/${sessionId}/`,
        { headers: this.headers }
      );
      return response.data;
    } catch (error: any) {
      this.logger.error('Get session error:', error?.response?.data);
      throw new Error('Failed to get session status');
    }
  }

  async getKycStatus(userId: string) {
    const user = await this.userRepo.findOne({ where: { id: userId } });
    if (!user) throw new Error('User not found');

    const KYC_CUTOFF_DATE = new Date('2026-05-11T00:00:00.000Z');
    const userCreatedAt   = new Date(user.createdAt);
    const requiresKyc     = userCreatedAt > KYC_CUTOFF_DATE;

    const monthsOld = Math.floor(
      (Date.now() - userCreatedAt.getTime()) / (1000 * 60 * 60 * 24 * 30)
    );

    return {
      role:            user.role,
      isVerified:      user.isVerified,
      ninVerified:     user.ninVerified,
      licenseVerified: user.licenseVerified,
      kycStatus:       user.kycStatus  || 'pending',
      kycTier:         user.kycTier    || 0,
      kycCompletedAt:  user.kycCompletedAt || null,
      monthsOld,
      requiresKyc,
      requiresTier1:   user.role === 'customer' && monthsOld >= 6 && !user.ninVerified,
    };
  }
}
