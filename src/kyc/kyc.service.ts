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
  private readonly diditUrl = 'https://verification.didit.me';

  constructor(
    private configService: ConfigService,
    @InjectRepository(User)
    private userRepo: Repository<User>,
    private pushService: PushService,
  ) {}

  private get headers() {
    return {
      'Authorization': `Bearer ${this.configService.get('DIDIT_API_KEY')}`,
      'Content-Type': 'application/json',
    };
  }

  async createVerificationSession(userId: string, userEmail: string, userName: string) {
    try {
      const response = await axios.post(
        `${this.diditUrl}/v1/session/`,
        {
          callback: `${this.configService.get('BACKEND_URL')}/api/kyc/webhook`,
          redirect_url: `${this.configService.get('FRONTEND_URL')}/dashboard/kyc/complete`,
          features: 'documentary_liveness',
          vendor_data: userId,
        },
        { headers: this.headers }
      );

      const session = response.data;
      this.logger.log(`✅ Didit session created for user ${userId}: ${session.session_id}`);

      return {
        sessionId: session.session_id,
        verificationUrl: session.url,
        status: session.status,
      };
    } catch (error: any) {
      this.logger.error('Didit session error:', error?.response?.data || error.message);
      throw new Error('Failed to create verification session');
    }
  }

  async handleWebhook(payload: any) {
    this.logger.log(`📩 Didit webhook: ${JSON.stringify(payload)}`);

    const { status, vendor_data } = payload;
    const userId = vendor_data;

    if (!userId) return { received: true };

    if (status === 'Approved') {
      await this.userRepo.update(userId, {
        isVerified: true,
        ninVerified: true,
        licenseVerified: true,
        kycStatus: 'approved',
        kycTier: 1,
        kycCompletedAt: new Date(),
      } as any);

      await this.pushService.sendToUser(userId, {
        title: '✅ Account Verified!',
        body: 'Congratulations! Your identity has been verified. You can now bid on jobs.',
        icon: '/icon-192.png',
      }).catch(() => {});

      this.logger.log(`🎉 User ${userId} verified via Didit`);
    } else if (status === 'Declined') {
      await this.userRepo.update(userId, {
        kycStatus: 'rejected',
      } as any);

      await this.pushService.sendToUser(userId, {
        title: '❌ Verification Failed',
        body: 'Your identity verification was unsuccessful. Please try again.',
        icon: '/icon-192.png',
      }).catch(() => {});

      this.logger.log(`❌ User ${userId} verification declined`);
    }

    return { received: true };
  }

  async getSessionStatus(sessionId: string) {
    try {
      const response = await axios.get(
        `${this.diditUrl}/v1/session/${sessionId}/`,
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

    const monthsOld = Math.floor(
      (Date.now() - new Date(user.createdAt).getTime()) / (1000 * 60 * 60 * 24 * 30)
    );

    const KYC_CUTOFF_DATE = new Date('2026-05-11T00:00:00.000Z');
    const requiresKyc = new Date(user.createdAt) > KYC_CUTOFF_DATE;

    return {
      role:            user.role,
      isVerified:      user.isVerified,
      ninVerified:     user.ninVerified,
      licenseVerified: user.licenseVerified,
      kycStatus:       user.kycStatus || 'pending',
      kycTier:         user.kycTier || 0,
      kycCompletedAt:  user.kycCompletedAt || null,
      monthsOld,
      requiresKyc,
      requiresTier1:   user.role === 'customer' && monthsOld >= 6 && !user.ninVerified,
    };
  }

  async verifyCustomerNIN(userId: string) {
    return this.createVerificationSession(userId, '', '');
  }
}
