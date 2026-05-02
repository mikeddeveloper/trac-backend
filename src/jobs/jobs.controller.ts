// trac-backend/src/jobs/jobs.controller.ts
// Day 16: Added POST /jobs/:id/proof endpoint

import {
  Controller,
  Get,
  Post,
  Patch,
  Body,
  Param,
  Req,
  UseGuards,
  UseInterceptors,
  UploadedFile,
  BadRequestException,
} from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { FileInterceptor } from '@nestjs/platform-express';
import { JobsService } from './jobs.service';
import { JobStatus } from './entities/job.entity';

@Controller('jobs')
@UseGuards(AuthGuard('jwt'))
export class JobsController {
  constructor(private readonly jobsService: JobsService) {}

  // ─── POST /jobs ────────────────────────────────────────────────────────────
  @Post()
  async createJob(@Req() req: any, @Body() body: any) {
    return this.jobsService.createJob(req.user.id, body);
  }

  // ─── GET /jobs/open ────────────────────────────────────────────────────────
  @Get('open')
  async getOpenJobs() {
    return this.jobsService.getOpenJobs();
  }

  // ─── GET /jobs/mine ────────────────────────────────────────────────────────
  @Get('mine')
  async getMyJobs(@Req() req: any) {
    const userId = req.user.id;
    const role   = req.user.role;

    console.log(`GET /jobs/mine — userId: ${userId}, role: ${role}`);

    if (role === 'transporter') return this.jobsService.getTransporterJobs(userId);
    if (role === 'customer' || role === 'enterprise') return this.jobsService.getMyJobs(userId);

    // Fallback — merge both
    const [asCustomer, asTransporter] = await Promise.all([
      this.jobsService.getMyJobs(userId),
      this.jobsService.getTransporterJobs(userId),
    ]);
    return [...asCustomer, ...asTransporter];
  }

  // ─── GET /jobs/:id ─────────────────────────────────────────────────────────
  @Get(':id')
  async getJob(@Param('id') id: string) {
    return this.jobsService.getJobById(id);
  }

  // ─── PATCH /jobs/:id/status ────────────────────────────────────────────────
  @Patch(':id/status')
  async updateStatus(
    @Param('id') id: string,
    @Req() req: any,
    @Body() body: { status: JobStatus; note?: string },
  ) {
    const role = req.user.role || 'transporter';
    return this.jobsService.updateJobStatus(
      id, body.status, req.user.id, role, body.note,
    );
  }

  // ─── POST /jobs/:id/generate-otp ──────────────────────────────────────────
  @Post(':id/generate-otp')
  async generateOtp(@Param('id') id: string, @Req() req: any) {
    return this.jobsService.generateDeliveryOtp(id, req.user.id);
  }

  // ─── POST /jobs/:id/verify-otp ────────────────────────────────────────────
  @Post(':id/verify-otp')
  async verifyOtp(
    @Param('id') id: string,
    @Req() req: any,
    @Body() body: { otp: string },
  ) {
    return this.jobsService.verifyDeliveryOtp(id, req.user.id, body.otp);
  }

  // ─── POST /jobs/:id/proof ──────────────────────────────────────────────────
  // Day 16: Transporter uploads proof of delivery photo
  // Accepts multipart/form-data with field name "proof"
  // Max file size: 5MB
  // Allowed types: image/jpeg, image/png, image/webp

  @Post(':id/proof')
  @UseInterceptors(FileInterceptor('proof', {
    limits: { fileSize: 5 * 1024 * 1024 }, // 5MB
    fileFilter: (req, file, cb) => {
      const allowed = ['image/jpeg', 'image/png', 'image/webp', 'image/jpg'];
      if (allowed.includes(file.mimetype)) {
        cb(null, true);
      } else {
        cb(new BadRequestException('Only image files are allowed (jpg, png, webp)'), false);
      }
    },
  }))
  async uploadProof(
    @Param('id') id: string,
    @Req() req: any,
    @UploadedFile() file: Express.Multer.File,
  ) {
    if (!file) {
      throw new BadRequestException('Please select a photo to upload');
    }

    return this.jobsService.uploadProofOfDelivery(
      id,
      req.user.id,
      file.buffer,
      file.mimetype,
      file.originalname,
    );
  }
}