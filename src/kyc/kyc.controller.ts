import { Controller, Post, Get, Body, Request, UseGuards } from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { KycService } from './kyc.service';

@Controller('kyc')
export class KycController {
  constructor(private readonly kycService: KycService) {}

  @Get('status')
  @UseGuards(AuthGuard('jwt'))
  async getStatus(@Request() req: any) {
    return this.kycService.getKycStatus(req.user.id);
  }

  @Post('verify-nin')
  @UseGuards(AuthGuard('jwt'))
  async verifyNIN(@Request() req: any, @Body() body: {
    nin: string;
    dateOfBirth: string;
    firstName: string;
    lastName: string;
  }) {
    if (req.user.role === 'customer') {
      return this.kycService.verifyCustomerNIN(
        req.user.id, body.nin, body.dateOfBirth, body.firstName, body.lastName
      );
    }
    return this.kycService.verifyNIN(
      req.user.id, body.nin, body.dateOfBirth, body.firstName, body.lastName
    );
  }

  @Post('verify-license')
  @UseGuards(AuthGuard('jwt'))
  async verifyLicense(@Request() req: any, @Body() body: {
    licenseNumber: string;
    dateOfBirth: string;
    firstName: string;
    lastName: string;
  }) {
    return this.kycService.verifyDriversLicense(
      req.user.id, body.licenseNumber, body.dateOfBirth, body.firstName, body.lastName
    );
  }

  @Post('complete-driver-kyc')
  @UseGuards(AuthGuard('jwt'))
  async completeDriverKYC(@Request() req: any, @Body() body: {
    vehiclePlate: string;
    vehicleYear: string;
  }) {
    return this.kycService.completeDriverKYC(
      req.user.id, body.vehiclePlate, body.vehicleYear
    );
  }
}
