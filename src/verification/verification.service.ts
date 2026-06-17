import { Injectable, Logger, BadRequestException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { User } from '../users/entities/user.entity';
import axios from 'axios';

@Injectable()
export class VerificationService {
  private readonly logger = new Logger(VerificationService.name);
  private baseUrl: string = '';
  private clientId: string = '';
  private secretKey: string = '';
  private workflowId: string = '';
  private accessToken: string | null = null;
  private tokenExpiry: number = 0;

  constructor(
    private configService: ConfigService,
    @InjectRepository(User) private userRepo: Repository<User>,
  ) {
    this.baseUrl = this.configService.get('QOREID_BASE_URL') || 'https://api.qoreid.com';
    this.clientId = this.configService.get('QOREID_CLIENT_ID') || '';
    this.secretKey = this.configService.get('QOREID_SECRET_KEY') || '';
    this.workflowId = this.configService.get('QOREID_WORKFLOW_ID') || '';
  }

  private async getAccessToken(): Promise<string> {
    if (this.accessToken && Date.now() < this.tokenExpiry) {
      return this.accessToken;
    }

    try {
      const response = await axios.post(`${this.baseUrl}/token`, {
        clientId: this.clientId,
        secret: this.secretKey,
      });

      this.accessToken = response.data.accessToken || null;
      this.tokenExpiry = Date.now() + (50 * 60 * 1000);
      return this.accessToken || '';
    } catch (error: any) {
      this.logger.error('QoreID token error:', error?.response?.data || error.message);
      throw new BadRequestException('Failed to authenticate with verification service');
    }
  }

  async initiateVerification(userId: string, data: {
    idType: 'nin' | 'license';
    idNumber: string;
    firstName: string;
    lastName: string;
    dob?: string;
  }) {
    const user = await this.userRepo.findOne({ where: { id: userId } });
    if (!user) throw new BadRequestException('User not found');

    if ((user as any).kycStatus === 'approved') {
      throw new BadRequestException('User is already verified');
    }

    const token = await this.getAccessToken();

    try {
      const endpoint = `${this.baseUrl}/v1/workflows/${this.workflowId}`;

      const payload: any = {
        customerReference: userId,
        applicant: {
          firstname: data.firstName,
          lastname: data.lastName,
          dob: data.dob || undefined,
        },
      };

      if (data.idType === 'nin') {
        payload.idNumber = data.idNumber;
        payload.idType = 'nin';
      } else {
        payload.idNumber = data.idNumber;
        payload.idType = 'license';
      }

      this.logger.log(`Calling QoreID workflow endpoint: ${endpoint}`);
      this.logger.log(`Payload: ${JSON.stringify(payload)}`);

      const response = await axios.post(
        endpoint,
        payload,
        {
          headers: {
            Authorization: `Bearer ${token}`,
            'Content-Type': 'application/json',
          },
        }
      );

      const result = response.data;
      this.logger.log(`QoreID workflow response: ${JSON.stringify(result)}`);

      const status = result?.status?.status || result?.status?.state;
      const verified = status === 'verified' || status === 'VERIFIED' || status === 'complete' || status === 'EXACT_MATCH';

      await this.userRepo.update(userId, {
        kycStatus: verified ? 'approved' : 'rejected',
        isVerified: verified,
        kycTier: verified ? 1 : 0,
        kycCompletedAt: verified ? new Date() : null,
        ninVerified: data.idType === 'nin' ? verified : (user as any).ninVerified,
        licenseVerified: data.idType === 'license' ? verified : (user as any).licenseVerified,
      } as any);

      this.logger.log(`QoreID verification for ${user.email}: ${verified ? 'PASSED' : 'FAILED'}`);

      return {
        verified,
        message: verified
          ? 'Identity verified successfully!'
          : 'Verification failed. Details did not match official records.',
        raw: result,
      };
    } catch (error: any) {
      this.logger.error('QoreID workflow error:', JSON.stringify(error?.response?.data) || error.message);
      this.logger.error('QoreID workflow error status:', error?.response?.status);

      await this.userRepo.update(userId, {
        kycStatus: 'rejected',
      } as any);

      throw new BadRequestException(
        error?.response?.data?.message || 'Verification failed. Please check your details and try again.'
      );
    }
  }

  async getVerificationStatus(userId: string) {
    const user = await this.userRepo.findOne({ where: { id: userId } });
    if (!user) throw new BadRequestException('User not found');

    return {
      kycStatus: (user as any).kycStatus || 'pending',
      isVerified: user.isVerified,
      kycTier: (user as any).kycTier || 0,
      ninVerified: (user as any).ninVerified || false,
      licenseVerified: (user as any).licenseVerified || false,
      kycCompletedAt: (user as any).kycCompletedAt || null,
    };
  }
}
