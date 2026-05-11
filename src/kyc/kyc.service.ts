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
  private readonly premblyUrl = 'https://api.prembly.com/api/identitypass/verification';

  constructor(
    private configService: ConfigService,
    @InjectRepository(User)
    private userRepo: Repository<User>,
    private pushService: PushService,
  ) {}

  private get headers() {
    return {
      'x-api-key': this.configService.get('PREMBLY_API_KEY'),
      'app-id': this.configService.get('PREMBLY_APP_ID'),
      'Content-Type': 'application/json',
    };
  }

  async verifyNIN(userId: string, nin: string, dateOfBirth: string, firstName: string, lastName: string) {
    this.logger.log(`Verifying NIN for user ${userId}`);
    try {
      const response = await axios.post(
        `${this.premblyUrl}/nin_wo_face`,
        { nin, dateofbirth: dateOfBirth, firstname: firstName, lastname: lastName },
        { headers: this.headers }
      );

      const verified = response.data?.verification?.status === 'VERIFIED' ||
                       response.data?.status === true;

      if (verified) {
        await this.userRepo.update(userId, {
          ninVerified: true,
          kycStatus: 'nin_verified',
        } as any);
        this.logger.log(`✅ NIN verified for user ${userId}`);
      }

      return {
        verified,
        message: verified ? 'NIN verified successfully' : 'NIN verification failed. Check your details.',
        data: response.data,
      };
    } catch (error: any) {
      this.logger.error('NIN verification error:', error?.response?.data || error.message);
      return {
        verified: false,
        message: error?.response?.data?.detail || 'NIN verification failed. Please try again.',
      };
    }
  }

  async verifyDriversLicense(userId: string, licenseNumber: string, dateOfBirth: string, firstName: string, lastName: string) {
    this.logger.log(`Verifying license for user ${userId}`);
    try {
      const response = await axios.post(
        `${this.premblyUrl}/drivers_license`,
        {
          license_number: licenseNumber,
          dob: dateOfBirth,
          firstname: firstName,
          lastname: lastName,
        },
        { headers: this.headers }
      );

      const verified = response.data?.verification?.status === 'VERIFIED' ||
                       response.data?.status === true;

      if (verified) {
        await this.userRepo.update(userId, {
          licenseVerified: true,
          kycStatus: 'license_verified',
        } as any);
        this.logger.log(`✅ License verified for user ${userId}`);
      }

      return {
        verified,
        message: verified ? 'License verified successfully' : 'License verification failed. Check your details.',
        data: response.data,
      };
    } catch (error: any) {
      this.logger.error('License verification error:', error?.response?.data || error.message);
      return {
        verified: false,
        message: error?.response?.data?.detail || 'License verification failed. Please try again.',
      };
    }
  }

  async completeDriverKYC(userId: string, vehiclePlate: string, vehicleYear: string) {
    const user = await this.userRepo.findOne({ where: { id: userId } });
    if (!user) throw new Error('User not found');

    const ninOk     = user.ninVerified;
    const licenseOk = user.licenseVerified;

    if (ninOk && licenseOk) {
      await this.userRepo.update(userId, {
        isVerified: true,
        kycStatus: 'approved',
        kycCompletedAt: new Date(),
        vehiclePlate,
        vehicleYear,
        kycTier: 1,
      } as any);

      await this.pushService.sendToUser(userId, {
        title: '✅ Account Verified!',
        body: 'Congratulations! Your account is now verified. You can start bidding on jobs.',
        icon: '/icon-192.png',
      }).catch(() => {});

      this.logger.log(`🎉 Driver KYC complete for user ${userId}`);
      return { completed: true, message: 'KYC completed. You can now bid on jobs!' };
    }

    return {
      completed: false,
      message: 'Please complete both NIN and License verification first.',
      ninVerified: ninOk,
      licenseVerified: licenseOk,
    };
  }

  async verifyCustomerNIN(userId: string, nin: string, dateOfBirth: string, firstName: string, lastName: string) {
    const result = await this.verifyNIN(userId, nin, dateOfBirth, firstName, lastName);
    if (result.verified) {
      await this.userRepo.update(userId, {
        kycStatus: 'approved',
        kycTier: 1,
        isVerified: true,
        kycCompletedAt: new Date(),
      } as any);

      await this.pushService.sendToUser(userId, {
        title: '✅ Identity Verified!',
        body: 'Your account is now Tier 1 verified. Enjoy full platform access.',
        icon: '/icon-192.png',
      }).catch(() => {});
    }
    return result;
  }

  async getKycStatus(userId: string) {
    const user = await this.userRepo.findOne({ where: { id: userId } });
    if (!user) throw new Error('User not found');

    const monthsOld = Math.floor(
      (Date.now() - new Date(user.createdAt).getTime()) / (1000 * 60 * 60 * 24 * 30)
    );

    return {
      role:            user.role,
      isVerified:      user.isVerified,
      ninVerified:     user.ninVerified,
      licenseVerified: user.licenseVerified,
      kycStatus:       user.kycStatus || 'pending',
      kycTier:         user.kycTier || 0,
      kycCompletedAt:  user.kycCompletedAt || null,
      monthsOld,
      requiresTier1:   user.role === 'customer' && monthsOld >= 6 && !user.ninVerified,
    };
  }
}
