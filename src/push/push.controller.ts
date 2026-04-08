// trac-backend/src/push/push.controller.ts
// Day 24: Push notification endpoints

import { Controller, Post, Delete, Get, Body, Req, UseGuards } from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { PushService } from './push.service';

@Controller('push')
@UseGuards(AuthGuard('jwt'))
export class PushController {
  constructor(private readonly pushService: PushService) {}

  // ─── POST /push/subscribe ────────────────────────────────────────────────────
  // Save browser push subscription
  @Post('subscribe')
  async subscribe(@Req() req: any, @Body() body: any) {
    await this.pushService.saveSubscription(req.user.id, body);
    return { success: true, message: 'Push subscription saved' };
  }

  // ─── DELETE /push/unsubscribe ────────────────────────────────────────────────
  @Delete('unsubscribe')
  async unsubscribe(@Body() body: { endpoint: string }) {
    await this.pushService.removeSubscription(body.endpoint);
    return { success: true };
  }

  // ─── GET /push/vapid-public-key ──────────────────────────────────────────────
  // Frontend needs this to subscribe
  @Get('vapid-public-key')
  getVapidPublicKey() {
    return { publicKey: process.env.VAPID_PUBLIC_KEY || '' };
  }

  // ─── POST /push/test ─────────────────────────────────────────────────────────
  // Send a test notification to yourself
  @Post('test')
  async sendTest(@Req() req: any) {
    await this.pushService.sendToUser(req.user.id, {
      title: '🚀 Trac Notifications Active!',
      body:  'You will now receive real-time delivery updates',
      url:   '/dashboard',
      tag:   'test',
    });
    return { success: true, message: 'Test notification sent' };
  }
}