import { Controller, Post, Get, Body, Request, UseGuards } from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { Throttle } from '@nestjs/throttler';
import { VerificationService } from './verification.service';

@Controller('verification')
export class VerificationController {
  constructor(private verificationService: VerificationService) {}

  @Post('initiate')
  @UseGuards(AuthGuard('jwt'))
  @Throttle({ default: { limit: 5, ttl: 60000 } })
  async initiate(@Request() req: any, @Body() body: {
    idType: 'nin' | 'license';
    idNumber: string;
    firstName: string;
    lastName: string;
    dob?: string;
  }) {
    return this.verificationService.initiateVerification(req.user.id, body);
  }

  @Get('token')
  @UseGuards(AuthGuard('jwt'))
  async getToken() {
    const token = await this.verificationService.getAccessToken();
    return { token };
  }

  @Get('status')
  @UseGuards(AuthGuard('jwt'))
  async status(@Request() req: any) {
    return this.verificationService.getVerificationStatus(req.user.id);
  }

  @Post('confirm')
  @UseGuards(AuthGuard('jwt'))
  async confirm(@Request() req: any, @Body() body: {
    verified: boolean;
    nin: string;
    verifiedData: any;
  }) {
    if (!body.verified) {
      throw new Error('Verification not confirmed');
    }
    return this.verificationService.confirmVerification(req.user.id, body.verifiedData);
  }

  @Post('license/submit')
  @UseGuards(AuthGuard('jwt'))
  async submitLicense(@Request() req: any, @Body() body: {
    licenseNumber: string;
    licenseExpiry: string;
    vehicleType: string;
  }) {
    return this.verificationService.submitLicense(req.user.id, body);
  }

  @Get('license/status')
  @UseGuards(AuthGuard('jwt'))
  async getLicenseStatus(@Request() req: any) {
    return this.verificationService.getLicenseStatus(req.user.id);
  }
}
