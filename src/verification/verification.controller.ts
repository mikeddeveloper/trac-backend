import {
  Controller, Post, Get, Body, Request, UseGuards,
  UseInterceptors, UploadedFile, BadRequestException,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { AuthGuard } from '@nestjs/passport';
import { Throttle } from '@nestjs/throttler';
import { memoryStorage } from 'multer';
import { v2 as cloudinary } from 'cloudinary';
import { VerificationService } from './verification.service';
import { detectSafeImage } from '../common/security/image-signature';

cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key:    process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
});

function uploadToCloudinary(buffer: Buffer, publicId: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const stream = cloudinary.uploader.upload_stream(
      { folder: 'trac-licenses', public_id: publicId, resource_type: 'image' },
      (error, result) => {
        if (error) reject(error);
        else resolve(result!.secure_url);
      },
    );
    stream.end(buffer);
  });
}

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

  // ── Upload license photo to Cloudinary ────────────────────────────────────
  @Post('license/photo')
  @UseGuards(AuthGuard('jwt'))
  @UseInterceptors(FileInterceptor('photo', {
    storage: memoryStorage(),
    fileFilter: (_r, file, cb) => {
      if (file.mimetype.startsWith('image/')) cb(null, true);
      else cb(new BadRequestException('Only image files are allowed'), false);
    },
    // Modern phone-camera images commonly exceed 5 MB. The web client
    // compresses them first, while this limit leaves safe headroom.
    limits: { fileSize: 12 * 1024 * 1024 },
  }))
  async uploadLicensePhoto(@Request() req: any, @UploadedFile() file: Express.Multer.File) {
    if (!file) throw new BadRequestException('No file uploaded');
    if (!detectSafeImage(file.buffer)) throw new BadRequestException('The uploaded file is not a valid JPEG, PNG, or WebP image');
    const publicId = `license-${req.user?.id}-${Date.now()}`;
    const licensePhotoUrl = await uploadToCloudinary(file.buffer, publicId);
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
