import {
  Controller, Post, Get, Body, Request, UseGuards,
  UseInterceptors, UploadedFile, BadRequestException,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { AuthGuard } from '@nestjs/passport';
import { Throttle } from '@nestjs/throttler';
import { diskStorage } from 'multer';
import { extname, join } from 'path';
import * as fs from 'fs';
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
    if (!body.verified) throw new Error('Verification not confirmed');
    return this.verificationService.confirmVerification(req.user.id, body.verifiedData);
  }

  // ── Upload license photo ───────────────────────────────────────────────────
  @Post('license/photo')
  @UseGuards(AuthGuard('jwt'))
  @UseInterceptors(FileInterceptor('photo', {
    storage: diskStorage({
      destination: (_req, _file, cb) => {
        const dir = join(process.cwd(), 'uploads', 'licenses');
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
        cb(null, dir);
      },
      filename: (req: any, file, cb) => {
        const ext = extname(file.originalname) || '.jpg';
        cb(null, `license-${req.user?.id}-${Date.now()}${ext}`);
      },
    }),
    fileFilter: (_req, file, cb) => {
      if (file.mimetype.startsWith('image/')) cb(null, true);
      else cb(new BadRequestException('Only image files are allowed'), false);
    },
    limits: { fileSize: 5 * 1024 * 1024 }, // 5MB max
  }))
  async uploadLicensePhoto(@Request() req: any, @UploadedFile() file: Express.Multer.File) {
    if (!file) throw new BadRequestException('No file uploaded');
    const baseUrl = process.env.BACKEND_URL || `http://localhost:${process.env.PORT || 3001}`;
    const licensePhotoUrl = `${baseUrl}/uploads/licenses/${file.filename}`;
    return { licensePhotoUrl };
  }

  @Post('license/submit')
  @UseGuards(AuthGuard('jwt'))
  async submitLicense(@Request() req: any, @Body() body: {
    licenseNumber: string;
    licenseExpiry: string;
    vehicleType: string;
    licensePhotoUrl?: string;
  }) {
    return this.verificationService.submitLicense(req.user.id, body);
  }

  @Get('license/status')
  @UseGuards(AuthGuard('jwt'))
  async getLicenseStatus(@Request() req: any) {
    return this.verificationService.getLicenseStatus(req.user.id);
  }
}
