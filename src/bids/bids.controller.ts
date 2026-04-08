import {
  Controller, Get, Post, Patch, Body,
  Param, UseGuards, Request,
} from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { BidsService } from './bids.service';

@Controller('bids')
export class BidsController {
  constructor(private bidsService: BidsService) {}

  // POST /api/bids — transporter places a bid
  @Post()
  @UseGuards(AuthGuard('jwt'))
  async placeBid(@Request() req, @Body() body: { jobId: string; amount: number; note?: string }) {
    const bid = await this.bidsService.placeBid(
      req.user.id,
      body.jobId,
      body.amount,
      body.note,
    );
    return { bid };
  }

  // GET /api/bids/job/:jobId — customer views all bids on their job
  @Get('job/:jobId')
  @UseGuards(AuthGuard('jwt'))
  async getBidsForJob(@Param('jobId') jobId: string) {
    const bids = await this.bidsService.getBidsForJob(jobId);
    return { bids };
  }

  // GET /api/bids/mine — transporter views their own bids
  @Get('mine')
  @UseGuards(AuthGuard('jwt'))
  async getMyBids(@Request() req) {
    const bids = await this.bidsService.getMyBids(req.user.id);
    return { bids };
  }

  // PATCH /api/bids/:id/accept — customer accepts a bid
  @Patch(':id/accept')
  @UseGuards(AuthGuard('jwt'))
  async acceptBid(@Param('id') id: string, @Request() req) {
    const bid = await this.bidsService.acceptBid(id, req.user.id);
    return { bid, message: 'Bid accepted — escrow payment initiated' };
  }

  // PATCH /api/bids/:id/reject — customer rejects a bid
  @Patch(':id/reject')
  @UseGuards(AuthGuard('jwt'))
  async rejectBid(@Param('id') id: string, @Request() req) {
    const bid = await this.bidsService.rejectBid(id, req.user.id);
    return { bid, message: 'Bid rejected' };
  }
}