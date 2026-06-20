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
    this.clientId = this.configService.get('QOREID_COLLECTION_CLIENT_ID') || '';
    this.secretKey = this.configService.get('QOREID_COLLECTION_SECRET_KEY') || '';
    this.workflowId = this.configService.get('QOREID_WORKFLOW_ID') || '';
  }

  private async getAccessToken(): Promise<string> {
    if (this.accessToken && Date.now() < this.tokenExpiry) {
      this.logger.log('Using cached QoreID token');
      return this.accessToken;
    }

    try {
      this.logger.log(`Requesting QoreID token...`);
      this.logger.log(`ClientId: ${this.clientId}`);

      const response = await axios.post(
        `${this.baseUrl}/token`,
        {
          clientId: this.clientId,
          secret: this.secretKey,
        },
        {
          headers: {
            'Content-Type': 'application/json',
            'Accept': 'application/json',
          },
        }
      );

      this.logger.log(`Token response status: ${response.status}`);
      this.logger.log(`Token response keys: ${Object.keys(response.data).join(', ')}`);

      const token = response.data.accessToken
        || response.data.token
        || response.data.access_token
        || response.data.data?.accessToken
        || response.data.data?.token;

      if (!token) {
        this.logger.error('No token found in response:', JSON.stringify(response.data));
        throw new Error('No token returned from QoreID');
      }

      this.accessToken = token;
      this.tokenExpiry = Date.now() + (50 * 60 * 1000);
      this.logger.log(`Token received successfully, length: ${token.length}`);

      return this.accessToken || '';
    } catch (error: any) {
      this.logger.error('QoreID token error status:', error?.response?.status);
      this.logger.error('QoreID token error data:', JSON.stringify(error?.response?.data));
      this.logger.error('QoreID token error message:', error?.message);
      throw new BadRequestException('Failed to get QoreID access token');
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
      const endpoint = data.idType === 'nin'
        ? `${this.baseUrl}/v1/ng/identities/nin/${data.idNumber}`
        : `${this.baseUrl}/v1/ng/identities/drivers-license/${data.idNumber}`;

      const payload: any = {
        firstname: data.firstName,
        lastname: data.lastName,
      };
      if (data.dob) payload.dob = data.dob;

      this.logger.log(`Calling QoreID endpoint: ${endpoint}`);
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
      this.logger.log(`QoreID response: ${JSON.stringify(result)}`);

      const verified = result?.status?.status === 'verified' || result?.summary?.identity_check?.status === 'EXACT_MATCH';

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
      this.logger.error('QoreID full error response:', JSON.stringify({
        status: error?.response?.status,
        data: error?.response?.data,
        message: error?.message,
        headers: error?.response?.headers,
      }));

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
