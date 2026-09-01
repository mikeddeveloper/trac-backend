// trac-backend/src/jobs/jobs.controller.ts
// Day 16: Added POST /jobs/:id/proof endpoint
/// <reference types="multer" />

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
  ForbiddenException,
  ParseUUIDPipe,
  Query,
} from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { FileInterceptor } from '@nestjs/platform-express';
import { Throttle } from '@nestjs/throttler';
import { JobsService } from './jobs.service';
import { JobStatus } from './entities/job.entity';
import { detectSafeImage } from '../common/security/image-signature';
import { SearchJobsQueryDto } from './dto/search-jobs-query.dto';

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
  async getOpenJobs(@Req() req: any) {
    if (!['transporter', 'admin'].includes(req.user.role)) {
      throw new ForbiddenException('Transporter access required');
    }
    const jobs = await this.jobsService.getOpenJobs();
    return jobs.map((job) => this.jobsService.toClientJob(job, false));
  }

  // ─── GET /jobs/mine ────────────────────────────────────────────────────────
  @Get('mine')
  async getMyJobs(@Req() req: any) {
    const userId = req.user.id;
    const role   = req.user.role;

    if (role === 'transporter') {
      const jobs = await this.jobsService.getTransporterJobs(userId);
      return jobs.map((job) => this.jobsService.toClientJob(job, true, false));
    }
    if (role === 'customer' || role === 'enterprise') {
      const jobs = await this.jobsService.getMyJobs(userId);
      return jobs.map((job) => this.jobsService.toClientJob(job, true));
    }

    // Fallback — merge both
    const [asCustomer, asTransporter] = await Promise.all([
      this.jobsService.getMyJobs(userId),
      this.jobsService.getTransporterJobs(userId),
    ]);
    return [...asCustomer, ...asTransporter].map((job) => this.jobsService.toClientJob(job, true));
  }

  @Get('search')
  async searchJobs(@Req() req: any, @Query() query: SearchJobsQueryDto) {
    if (!['transporter', 'admin'].includes(req.user.role)) {
      throw new ForbiddenException('Transporter access required');
    }
    const jobs = await this.jobsService.searchOpenJobs(query.search);
    return jobs.map(job => this.jobsService.toClientJob(job, false));
  }

  @Get('available')
  async getAvailableJobs(@Req() req: any, @Query() query: SearchJobsQueryDto) {
    if (!['transporter', 'admin'].includes(req.user.role)) {
      throw new ForbiddenException('Transporter access required');
    }
    const jobs = await this.jobsService.searchOpenJobs(query.search);
    return jobs.map(job => this.jobsService.toClientJob(job, false));
  }

  // ─── GET /jobs/:id ─────────────────────────────────────────────────────────
  @Get(':id/editable')
  async getEditability(@Param('id', new ParseUUIDPipe({ version: '4' })) id: string, @Req() req: any) {
    return this.jobsService.getEditability(id, req.user.id);
  }

  @Get(':id')
  async getJob(@Param('id', new ParseUUIDPipe({ version: '4' })) id: string, @Req() req: any) {
    const job = await this.jobsService.getJobById(id);
    const isParty = job.customerId === req.user.id || job.transporterId === req.user.id;
    const canBrowse = job.status === JobStatus.BIDDING && req.user.role === 'transporter';
    if (!isParty && !canBrowse && req.user.role !== 'admin') {
      throw new ForbiddenException('You cannot access this job');
    }
    const includeDetails = isParty || req.user.role === 'admin';
    const includeOtp = job.customerId === req.user.id || req.user.role === 'admin';
    return this.jobsService.toClientJob(job, includeDetails, includeOtp);
  }

  @Patch(':id')
  async updateJob(@Param('id', new ParseUUIDPipe({ version: '4' })) id: string, @Req() req: any, @Body() body: any) {
    const job = await this.jobsService.updateUnbidJob(id, req.user.id, body);
    return this.jobsService.toClientJob(job, true);
  }

  @Post(':id/location')
  async updateLocation(
    @Param('id', new ParseUUIDPipe({ version: '4' })) id: string,
    @Req() req: any,
    @Body() body: { lat: number; lng: number; accuracy?: number; speed?: number },
  ) {
    return this.jobsService.updateTransporterLocation(id, req.user.id, body);
  }

  // ─── PATCH /jobs/:id/status ────────────────────────────────────────────────
  @Patch(':id/status')
  async updateStatus(
    @Param('id', new ParseUUIDPipe({ version: '4' })) id: string,
    @Req() req: any,
    @Body() body: { status: JobStatus; note?: string },
  ) {
    const role = req.user.role || 'transporter';
    if (role !== 'admin') {
      throw new ForbiddenException('Use the dedicated delivery action for status changes');
    }
    const job = await this.jobsService.updateJobStatus(
      id, body.status, req.user.id, role, body.note,
    );
    return this.jobsService.toClientJob(job, true, role !== 'transporter');
  }

  @Post(':id/deliver')
  async confirmDelivery(
    @Param('id', new ParseUUIDPipe({ version: '4' })) id: string,
    @Req() req: any,
  ) {
    if (req.user.role !== 'transporter') {
      throw new ForbiddenException('Only the assigned transporter can complete a delivery');
    }
    const job = await this.jobsService.updateJobStatus(
      id, JobStatus.DELIVERED, req.user.id, req.user.role,
    );
    return this.jobsService.toClientJob(job, true, false);
  }

  @Post(':id/cancel')
  async cancelJob(
    @Param('id', new ParseUUIDPipe({ version: '4' })) id: string,
    @Req() req: any,
  ) {
    if (req.user.role !== 'customer') {
      throw new ForbiddenException('Only the customer who posted this delivery can cancel it');
    }
    const job = await this.jobsService.updateJobStatus(
      id, JobStatus.CANCELLED, req.user.id, req.user.role,
    );
    return this.jobsService.toClientJob(job, true, true);
  }

  // A transporter can start a trip only by recording photographic evidence
  // of the physical pickup. The generic status endpoint cannot bypass this.
  @Post(':id/pickup')
  @UseInterceptors(FileInterceptor('pickupPhoto', {
    limits: { fileSize: 5 * 1024 * 1024 },
    fileFilter: (_req, file, cb) => {
      const allowed = ['image/jpeg', 'image/png', 'image/webp', 'image/jpg'];
      allowed.includes(file.mimetype)
        ? cb(null, true)
        : cb(new BadRequestException('Only image files are allowed (jpg, png, webp)'), false);
    },
  }))
  async confirmPickup(
    @Param('id', new ParseUUIDPipe({ version: '4' })) id: string,
    @Req() req: any,
    @UploadedFile() file: Express.Multer.File,
    @Body() body: { lat?: string; lng?: string },
  ) {
    if (!file) throw new BadRequestException('Take or upload a pickup photo to start the delivery');
    const verifiedMime = detectSafeImage(file.buffer);
    if (!verifiedMime) throw new BadRequestException('The pickup photo is not a valid JPEG, PNG, or WebP image');
    const job = await this.jobsService.confirmPickup(
      id,
      req.user.id,
      file.buffer,
      verifiedMime,
      body.lat === undefined ? undefined : Number(body.lat),
      body.lng === undefined ? undefined : Number(body.lng),
    );
    return this.jobsService.toClientJob(job, true, false);
  }

  // ─── POST /jobs/:id/generate-otp ──────────────────────────────────────────
  @Post(':id/generate-otp')
  @Throttle({ default: { limit: 3, ttl: 60000 } })
  async generateOtp(@Param('id', new ParseUUIDPipe({ version: '4' })) id: string, @Req() req: any) {
    return this.jobsService.generateDeliveryOtp(id, req.user.id);
  }

  // ─── POST /jobs/:id/verify-otp ────────────────────────────────────────────
  @Post(':id/verify-otp')
  @Throttle({ default: { limit: 8, ttl: 60000 } })
  async verifyOtp(
    @Param('id', new ParseUUIDPipe({ version: '4' })) id: string,
    @Req() req: any,
    @Body() body: { otp: string },
  ) {
    return this.jobsService.verifyDeliveryOtp(id, req.user.id, body.otp);
  }

  // ─── POST /jobs/:id/confirm-receipt ──────────────────────────────────────
  @Post(':id/confirm-receipt')
  async confirmReceipt(@Param('id', new ParseUUIDPipe({ version: '4' })) id: string, @Req() req: any) {
    return this.jobsService.confirmReceipt(id, req.user.id);
  }

  // ─── POST /jobs/:id/dispute ───────────────────────────────────────────────
  @Post(':id/dispute')
  async raiseDispute(
    @Param('id', new ParseUUIDPipe({ version: '4' })) id: string,
    @Req() req: any,
    @Body() body: { reason: string },
  ) {
    return this.jobsService.raiseDispute(id, req.user.id, body.reason || 'No reason provided');
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
    @Param('id', new ParseUUIDPipe({ version: '4' })) id: string,
    @Req() req: any,
    @UploadedFile() file: Express.Multer.File,
  ) {
    if (!file) {
      throw new BadRequestException('Please select a photo to upload');
    }
    const verifiedMime = detectSafeImage(file.buffer);
    if (!verifiedMime) throw new BadRequestException('The uploaded file is not a valid JPEG, PNG, or WebP image');

    const job = await this.jobsService.uploadProofOfDelivery(
      id,
      req.user.id,
      file.buffer,
      verifiedMime,
      file.originalname,
    );
    return this.jobsService.toClientJob(job, true, false);
  }
}
