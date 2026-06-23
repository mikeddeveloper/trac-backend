import { Injectable, Logger, BadRequestException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { User } from '../users/entities/user.entity';
import axios from 'axios';

@Injectable()
export class VerificationService {
  private readonly logger = new Logger(VerificationService.name);
  private baseUrl: string = 'https://api.qoreid.com';
  private clientId: string = '';
  private secretKey: string = '';
  private accessToken: string | null = null;
  private tokenExpiry: number = 0;

  constructor(
    private configService: ConfigService,
    @InjectRepository(User) private userRepo: Repository<User>,
  ) {
    this.clientId = this.configService.get('QOREID_COLLECTION_CLIENT_ID') || '';
    this.secretKey = this.configService.get('QOREID_COLLECTION_SECRET_KEY') || '';
    this.baseUrl = this.configService.get('QOREID_BASE_URL') || 'https://api.qoreid.com';
    this.logger.log(`QoreID initialized - clientId: ${this.clientId}`);
  }

  private async getAccessToken(): Promise<string> {
    const manualToken = this.configService.get<string>('QOREID_BEARER_TOKEN');
    if (manualToken) {
      this.logger.log('Using manual bearer token from environment variable');
      return manualToken;
    }

    if (this.accessToken && Date.now() < this.tokenExpiry) {
      this.logger.log('Using cached QoreID token');
      return this.accessToken;
    }

    try {
      this.logger.log('Generating new QoreID token via Keycloak...');

      const params = new URLSearchParams();
      params.append('grant_type', 'client_credentials');
      params.append('client_id', this.clientId);
      params.append('client_secret', this.secretKey);

      const response = await axios.post(
        'https://auth.qoreid.com/auth/realms/qoreid/protocol/openid-connect/token',
        params.toString(),
        {
          headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
          },
        }
      );

      const token = response.data.accessToken
        || response.data.access_token
        || response.data.token;

      if (!token) {
        this.logger.error('No access_token in Keycloak response:', JSON.stringify(response.data));
        throw new Error('No token returned from QoreID');
      }

      this.accessToken = token;
      this.tokenExpiry = Date.now() + (110 * 60 * 1000);
      this.logger.log(`✅ New QoreID token generated, length: ${token.length}`);

      return this.accessToken;
    } catch (error: any) {
      this.logger.error('QoreID token generation failed:', JSON.stringify(error?.response?.data));
      this.logger.error('Token error:', error?.message);
      throw new BadRequestException('Failed to generate QoreID access token. Please try again.');
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
      throw new BadRequestException('Your account is already verified.');
    }

    const token = await this.getAccessToken();

    try {
      const endpoint = data.idType === 'nin'
        ? `${this.baseUrl}/v1/ng/identities/nin-premium/${data.idNumber}`
        : `${this.baseUrl}/v1/ng/identities/drivers-license/${data.idNumber}`;

      const payload: any = {
        firstname: data.firstName.trim(),
        lastname: data.lastName.trim(),
      };
      if (data.dob) payload.dob = data.dob;

      this.logger.log(`Calling QoreID: ${endpoint}`);
      this.logger.log(`Payload: ${JSON.stringify(payload)}`);

      const response = await axios.post(endpoint, payload, {
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
      });

      const result = response.data;
      this.logger.log(`QoreID response: ${JSON.stringify(result)}`);

      const verified =
        result?.status?.status === 'verified' ||
        result?.status?.state === 'complete' ||
        result?.summary?.nin_check?.status === 'EXACT_MATCH' ||
        result?.summary?.nin_check?.status === 'PARTIAL_MATCH';

      await this.userRepo.update(userId, {
        kycStatus: verified ? 'approved' : 'rejected',
        isVerified: verified,
        kycTier: verified ? 1 : 0,
        kycCompletedAt: verified ? new Date() : null,
        ninVerified: data.idType === 'nin' ? verified : (user as any).ninVerified || false,
        licenseVerified: data.idType === 'license' ? verified : (user as any).licenseVerified || false,
      } as any);

      this.logger.log(`QoreID verification for ${user.email}: ${verified ? 'PASSED ✅' : 'FAILED ❌'}`);

      return {
        verified,
        message: verified
          ? 'Identity verified successfully! You can now bid on jobs.'
          : 'Verification failed. Please check your details and try again.',
        data: verified ? {
          firstname: result?.nin?.firstname,
          lastname: result?.nin?.lastname,
          middlename: result?.nin?.middlename,
          gender: result?.nin?.gender,
          birthdate: result?.nin?.birthdate,
          stateOfOrigin: result?.nin?.state_of_origin,
          photo: result?.nin?.photo || null,
        } : null,
      };
    } catch (error: any) {
      this.logger.error('QoreID verification error:', JSON.stringify({
        status: error?.response?.status,
        data: error?.response?.data,
        message: error?.message,
      }));

      if (error?.response?.status === 401) {
        this.accessToken = null;
        this.tokenExpiry = 0;
        throw new BadRequestException('Authentication failed. Please try again.');
      }

      if (error?.response?.status === 403) {
        throw new BadRequestException('Access denied. Please contact support.');
      }

      await this.userRepo.update(userId, {
        kycStatus: 'rejected',
      } as any);

      throw new BadRequestException(
        error?.response?.data?.message ||
        'Verification failed. Please check your details and try again.'
      );
    }
  }

  async confirmVerification(userId: string, verifiedData: any) {
    await this.userRepo.update(userId, {
      isVerified: true,
      kycStatus: 'approved',
      kycTier: 1,
      kycCompletedAt: new Date(),
      ninVerified: true,
    } as any);

    this.logger.log(`✅ User ${userId} verified via frontend QoreID call`);

    return { verified: true };
  }

  async getVerificationStatus(userId: string) {
    const user = await this.userRepo.findOne({ where: { id: userId } });
    if (!user) throw new BadRequestException('User not found');

    return {
      kycStatus: (user as any).kycStatus || 'pending',
      isVerified: user.isVerified || false,
      kycTier: (user as any).kycTier || 0,
      ninVerified: (user as any).ninVerified || false,
      licenseVerified: (user as any).licenseVerified || false,
      kycCompletedAt: (user as any).kycCompletedAt || null,
    };
  }
}
