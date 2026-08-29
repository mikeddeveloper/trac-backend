import { Injectable, Logger, BadRequestException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { User, UserRole } from '../users/entities/user.entity';
import { EventsGateway } from '../events/events.gateway';
import { PushService } from '../push/push.service';
import { EmailService } from '../email/email.service';
import axios from 'axios';

@Injectable()
export class VerificationService {
  private readonly logger = new Logger(VerificationService.name);
  private baseUrl: string = 'https://api.qoreid.com';
  private clientId: string = '';
  private secretKey: string = '';
  private accessToken: string = '';
  private tokenExpiry: number = 0;

  constructor(
    private configService: ConfigService,
    @InjectRepository(User) private userRepo: Repository<User>,
    private eventsGateway: EventsGateway,
    private pushService: PushService,
    private emailService: EmailService,
  ) {
    this.clientId = this.configService.get('QOREID_COLLECTION_CLIENT_ID') || '';
    this.secretKey = this.configService.get('QOREID_COLLECTION_SECRET_KEY') || '';
    this.baseUrl = this.configService.get('QOREID_BASE_URL') || 'https://api.qoreid.com';
    this.logger.log(`QoreID initialized - clientId: ${this.clientId}`);
  }

  async getAccessToken(): Promise<string> {
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
      this.logger.log(`ClientId: ${this.clientId}`);

      const params = new URLSearchParams();
      params.append('grant_type', 'client_credentials');
      params.append('client_id', this.clientId);
      params.append('client_secret', this.secretKey);

      const response = await axios.post(
        'https://auth.qoreid.com/auth/realms/qoreid/protocol/openid-connect/token',
        params.toString(),
        {
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        }
      );

      this.logger.log(`Token response keys: ${Object.keys(response.data).join(', ')}`);

      const token: string = response.data.accessToken
        || response.data.access_token
        || response.data.token
        || '';

      if (!token) {
        this.logger.error('No token in response:', JSON.stringify(response.data));
        throw new Error('No token returned from QoreID');
      }

      this.accessToken = token;
      this.tokenExpiry = Date.now() + (110 * 60 * 1000);
      this.logger.log(`✅ Token generated, length: ${token.length}`);

      return this.accessToken;
    } catch (error: any) {
      this.logger.error('Token generation failed:', JSON.stringify(error?.response?.data));
      this.logger.error('Token error:', error?.message);
      throw new BadRequestException('Failed to generate QoreID access token.');
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
        isVerified: user.role === UserRole.TRANSPORTER
          ? verified && (user as any).licenseStatus === 'approved'
          : verified,
        kycTier: verified ? 1 : 0,
        kycCompletedAt: verified ? new Date() : null,
        ninVerified: data.idType === 'nin' ? verified : ((user as any).ninVerified || false),
        licenseVerified: data.idType === 'license' ? verified : ((user as any).licenseVerified || false),
      } as any);

      this.logger.log(`QoreID result for ${user.email}: ${verified ? 'PASSED ✅' : 'FAILED ❌'}`);

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
        } : null,
      };
    } catch (error: any) {
      this.logger.error('QoreID error:', JSON.stringify({
        status: error?.response?.status,
        data: error?.response?.data,
        message: error?.message,
      }));

      if (error?.response?.status === 401) {
        this.accessToken = '';
        this.tokenExpiry = 0;
        throw new BadRequestException('Authentication failed. Please try again.');
      }

      await this.userRepo.update(userId, { kycStatus: 'rejected' } as any);

      throw new BadRequestException(
        error?.response?.data?.message ||
        'Verification failed. Please check your details and try again.'
      );
    }
  }

  async confirmVerification(userId: string, _verifiedData: any) {
    const user = await this.userRepo.findOne({ where: { id: userId } });
    if (!user) throw new BadRequestException('User not found');
    await this.userRepo.update(userId, {
      isVerified: user.role === UserRole.TRANSPORTER
        ? (user as any).licenseStatus === 'approved'
        : true,
      kycStatus: 'approved',
      kycTier: 1,
      kycCompletedAt: new Date(),
      ninVerified: true,
    } as any);

    this.logger.log(`✅ User ${userId} confirmed verified via frontend QoreID call`);
    return { verified: true, message: 'Identity verified successfully!' };
  }

  // ─── License submission ───────────────────────────────────────────────────────

  async submitLicense(userId: string, data: {
    licenseNumber: string;
    licenseExpiry: string;
    vehicleType: string;
    licensePhotoUrl?: string;
  }) {
    const user = await this.userRepo.findOne({ where: { id: userId } });
    if (!user) throw new BadRequestException('User not found');

    if (!data.licenseNumber?.trim() || !data.licenseExpiry || !data.vehicleType) {
      throw new BadRequestException('License number, expiry date and vehicle type are required');
    }
    const submittedExpiry = new Date(data.licenseExpiry);
    if (Number.isNaN(submittedExpiry.getTime()) || submittedExpiry.getTime() < new Date().setHours(0, 0, 0, 0)) {
      throw new BadRequestException('License expiry date must be a valid future date');
    }

    if (!(user as any).ninVerified && !user.isVerified) {
      throw new BadRequestException('Please complete NIN verification first');
    }

    if ((user as any).licenseStatus === 'approved') {
      throw new BadRequestException('License already verified');
    }

    await this.userRepo.update(userId, {
      licenseNumber: data.licenseNumber,
      licenseExpiry: data.licenseExpiry,
      vehicleType: data.vehicleType,
      licenseStatus: 'pending',
      licenseSubmittedAt: new Date(),
      ...(data.licensePhotoUrl ? { licensePhotoUrl: data.licensePhotoUrl } : {}),
    } as any);

    this.logger.log(`📄 License submitted by ${user.email}`);

    return {
      message: 'License submitted successfully. Admin will review within 24 hours.',
      licenseStatus: 'pending',
    };
  }

  async getLicenseStatus(userId: string) {
    const user = await this.userRepo.findOne({ where: { id: userId } });
    if (!user) throw new BadRequestException('User not found');

    // Older accounts inherited "pending" before they submitted a document.
    const hasSubmission = Boolean((user as any).licenseSubmittedAt && (user as any).licensePhotoUrl);
    const storedStatus = (user as any).licenseStatus;
    const licenseStatus = storedStatus === 'pending' && !hasSubmission
      ? 'not_submitted'
      : storedStatus || 'not_submitted';

    return {
      licenseStatus,
      licenseNumber: (user as any).licenseNumber || null,
      licenseExpiry: (user as any).licenseExpiry || null,
      licenseSubmittedAt: (user as any).licenseSubmittedAt || null,
      isVerified: user.isVerified,
      ninVerified: (user as any).ninVerified || false,
    };
  }

  async updateLicenseExpiry(userId: string, licenseExpiry: string) {
    const user = await this.userRepo.findOne({ where: { id: userId } });
    if (!user) throw new BadRequestException('User not found');
    const expiry = new Date(licenseExpiry);
    if (!licenseExpiry || Number.isNaN(expiry.getTime()) || expiry.getTime() < new Date().setHours(0, 0, 0, 0)) {
      throw new BadRequestException('Enter a valid future expiry date');
    }
    await this.userRepo.update(userId, { licenseExpiry } as any);
    return { message: 'License expiry date updated', licenseExpiry };
  }

  // ─── License approval (called by admin) ──────────────────────────────────────

  async approveLicense(userId: string) {
    const user = await this.userRepo.findOne({ where: { id: userId } });
    if (!user) throw new BadRequestException('User not found');

    const expiry = (user as any).licenseExpiry ? new Date((user as any).licenseExpiry) : null;
    if (!expiry || Number.isNaN(expiry.getTime())) {
      throw new BadRequestException('Enter the license expiry date before approval');
    }
    if (expiry.getTime() < new Date().setHours(0, 0, 0, 0)) {
      throw new BadRequestException('This license has expired and cannot be approved');
    }

    await this.userRepo.update(userId, {
      licenseStatus: 'approved',
      licenseVerified: true,
      isVerified: true,
      kycTier: 2,
    } as any);

    this.eventsGateway.notifyUser(userId, 'license:approved', {
      message: 'Your driver license has been verified! You can now access the full dashboard.',
    });

    await this.pushService.sendToUser(userId, {
      title: '✅ License Verified!',
      body: 'Your driver license has been approved. You now have full dashboard access.',
      icon: '/icon-192.png',
    }).catch(() => {});

    await this.emailService.sendLicenseApprovedEmail({
      fullName: user.fullName,
      email: user.email,
    }).catch(() => {});

    this.logger.log(`✅ License approved for ${user.email}`);
    return { message: 'License approved successfully' };
  }

  async rejectLicense(userId: string, reason: string) {
    const user = await this.userRepo.findOne({ where: { id: userId } });
    if (!user) throw new BadRequestException('User not found');

    await this.userRepo.update(userId, {
      licenseStatus: 'rejected',
    } as any);

    this.eventsGateway.notifyUser(userId, 'license:rejected', {
      message: `License rejected: ${reason}`,
      reason,
    });

    await this.pushService.sendToUser(userId, {
      title: '❌ License Rejected',
      body: `Your license was rejected: ${reason}. Please resubmit.`,
      icon: '/icon-192.png',
    }).catch(() => {});

    await this.emailService.sendLicenseRejectedEmail({
      fullName: user.fullName,
      email: user.email,
    }, reason).catch(() => {});

    this.logger.log(`❌ License rejected for ${user.email}: ${reason}`);
    return { message: 'License rejected' };
  }

  // ─── Status ───────────────────────────────────────────────────────────────────

  async getVerificationStatus(userId: string) {
    const user = await this.userRepo.findOne({ where: { id: userId } });
    if (!user) throw new BadRequestException('User not found');

    return {
      kycStatus: (user as any).kycStatus || 'pending',
      isVerified: user.isVerified || false,
      kycTier: (user as any).kycTier || 0,
      ninVerified: (user as any).ninVerified || false,
      licenseVerified: (user as any).licenseVerified || false,
      licenseStatus: (user as any).licenseStatus || 'not_submitted',
      kycCompletedAt: (user as any).kycCompletedAt || null,
    };
  }
}
