// trac-backend/src/ratings/ratings.controller.ts
// Day 17: Ratings controller

import {
  Controller,
  Post,
  Get,
  Body,
  Param,
  Req,
  UseGuards,
} from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { RatingsService } from './ratings.service';

@Controller('ratings')
@UseGuards(AuthGuard('jwt'))
export class RatingsController {
  constructor(private readonly ratingsService: RatingsService) {}

  // ─── POST /ratings ──────────────────────────────────────────────────────────
  // Submit a rating for a delivered job
  @Post()
  async submitRating(
    @Req() req: any,
    @Body() body: { jobId: string; stars: number; comment?: string },
  ) {
    return this.ratingsService.submitRating(
      req.user.id,
      body.jobId,
      body.stars,
      body.comment || '',
      req.user.role,
    );
  }

  // ─── GET /ratings/me ────────────────────────────────────────────────────────
  // Get ratings received by logged-in user
  @Get('me')
  async getMyRatings(@Req() req: any) {
    return this.ratingsService.getRatingsForUser(req.user.id);
  }

  // ─── GET /ratings/pending ───────────────────────────────────────────────────
  // Get delivered jobs not yet rated by logged-in user
  @Get('pending')
  async getPendingRatings(@Req() req: any) {
    return this.ratingsService.getPendingRatings(req.user.id, req.user.role);
  }

  @Get('job/:jobId')
  async getRateableJob(@Req() req: any, @Param('jobId') jobId: string) {
    return this.ratingsService.getRateableJob(req.user.id, req.user.role, jobId);
  }

  // ─── GET /ratings/user/:userId ──────────────────────────────────────────────
  // Get ratings for any user (public — for profile pages)
  @Get('user/:userId')
  async getUserRatings(@Param('userId') userId: string) {
    return this.ratingsService.getRatingsForUser(userId);
  }
}
