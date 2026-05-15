import {
  Controller, Post, Get, Body, Param,
  Request, UseGuards,
} from '@nestjs/common';
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

  @Post('create-session')
  @UseGuards(AuthGuard('jwt'))
  async createSession(@Request() req: any) {
    return this.kycService.createVerificationSession(req.user.id);
  }

  @Post('webhook')
  async handleWebhook(@Body() payload: any) {
    return this.kycService.handleWebhook(payload);
  }

  @Get('session/:sessionId')
  @UseGuards(AuthGuard('jwt'))
  async getSession(@Param('sessionId') sessionId: string) {
    return this.kycService.getSessionStatus(sessionId);
  }
}
