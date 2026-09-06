// trac-backend/src/push/push.service.ts
// Day 24: Web Push notification service

import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import * as webpush from 'web-push';
import { ConfigService } from '@nestjs/config';
import { PushSubscription } from './entities/push-subscription.entity';

@Injectable()
export class PushService {
  private readonly logger = new Logger(PushService.name);

  constructor(
    @InjectRepository(PushSubscription)
    private subRepo: Repository<PushSubscription>,
    private config: ConfigService,
  ) {
    // Set VAPID keys
    const publicKey  = this.config.get<string>('VAPID_PUBLIC_KEY');
    const privateKey = this.config.get<string>('VAPID_PRIVATE_KEY');
    const email      = this.config.get<string>('VAPID_EMAIL') || 'mailto:info@trac.com.ng';

    if (publicKey && privateKey) {
      webpush.setVapidDetails(email, publicKey, privateKey);
      this.logger.log('✅ VAPID keys configured');
    } else {
      this.logger.warn('⚠️ VAPID keys not set — push notifications disabled');
    }
  }

  // ─── Save push subscription ──────────────────────────────────────────────────

  async saveSubscription(userId: string, subscription: any): Promise<void> {
    if (!userId || userId === 'undefined') {
      this.logger.warn('saveSubscription: skipping undefined userId');
      return;
    }

    const endpoint = subscription.endpoint;

    // Check if already exists
    const existing = await this.subRepo.findOne({ where: { endpoint } });
    if (existing) {
      // Update userId if changed
      if (existing.userId !== userId) {
        await this.subRepo.update(existing.id, { userId });
      }
      return;
    }

    const sub = this.subRepo.create({
      userId,
      endpoint,
      p256dh: subscription.keys?.p256dh,
      auth: subscription.keys?.auth,
      raw: JSON.stringify(subscription),
    });

    await this.subRepo.save(sub);
    this.logger.log(`📱 Push subscription saved for user ${userId}`);
  }

  // ─── Send push to a specific user ───────────────────────────────────────────

  async sendToUser(userId: string, payload: {
    title: string;
    body: string;
    url?: string;
    tag?: string;
    icon?: string;
    data?: any;
  }): Promise<{ sent: number }> {
    try {
      const subs = await this.subRepo.find({ where: { userId } });
      if (!subs.length) {
        this.logger.warn(`📵 No push subscriptions found for user ${userId}`);
        return { sent: 0 };
      }

      const message = JSON.stringify({
        title: payload.title,
        body:  payload.body,
        url:   payload.url  || '/dashboard',
        tag:   payload.tag  || 'trac',
        icon:  payload.icon || '/icons/icon-192x192.png',
        data:  payload.data ?? {},
      });

      let sent = 0;
      for (const sub of subs) {
        try {
          const subscription = {
            endpoint: sub.endpoint,
            keys: { p256dh: sub.p256dh, auth: sub.auth },
          };
          await webpush.sendNotification(subscription as any, message);
          sent++;
        } catch (err: any) {
          if (err.statusCode === 410 || err.statusCode === 404) {
            await this.subRepo.delete(sub.id);
            this.logger.warn(`🗑️ Removed expired push subscription for user ${userId}`);
          } else {
            this.logger.warn(`⚠️ Push failed for sub ${sub.id}: ${err.message}`);
          }
        }
      }

      this.logger.log(`📤 Push to ${userId}: ${sent}/${subs.length} sent`);
      return { sent };
    } catch (err: any) {
      this.logger.warn(`⚠️ sendToUser error for ${userId}: ${err.message}`);
      return { sent: 0 };
    }
  }

  // ─── Remove subscription ─────────────────────────────────────────────────────

  async removeSubscription(endpoint: string): Promise<void> {
    await this.subRepo.delete({ endpoint });
  }

  // ─── Generate VAPID keys (run once) ──────────────────────────────────────────

  generateVapidKeys() {
    return webpush.generateVAPIDKeys();
  }

  // ─── Notification templates ───────────────────────────────────────────────────

  templates = {
    newBid: (jobRoute: string, amount: string) => ({
      title: '🏷️ New Bid Received',
      body: `A transporter bid ₦${amount} on your ${jobRoute} delivery`,
      url: '/dashboard/deliveries',
      tag: 'new-bid',
    }),
    bidAccepted: (jobRoute: string) => ({
      title: '✅ Bid Accepted!',
      body: `Your bid on ${jobRoute} was accepted. Get ready to deliver!`,
      url: '/dashboard/tracking',
      tag: 'bid-accepted',
    }),
    paymentConfirmed: (amount: string) => ({
      title: '💰 Payment Confirmed',
      body: `₦${amount} is now secured for your delivery`,
      url: '/dashboard/payments',
      tag: 'payment',
    }),
    jobPickedUp: (jobRoute: string) => ({
      title: '🚚 Cargo Picked Up',
      body: `Your cargo is on its way — ${jobRoute}`,
      url: '/dashboard/tracking',
      tag: 'pickup',
    }),
    jobDelivered: (jobRoute: string) => ({
      title: '📦 Delivery Complete!',
      body: `Your ${jobRoute} delivery has been completed`,
      url: '/dashboard/tracking',
      tag: 'delivered',
    }),
    payoutReleased: (amount: string) => ({
      title: '💸 Payout Released',
      body: `₦${amount} has been sent to your bank account`,
      url: '/dashboard/earnings',
      tag: 'payout',
    }),
    disputeRaised: (reason: string) => ({
      title: '🚨 Dispute Raised',
      body: `A dispute has been raised on your delivery: ${reason}`,
      url: '/dashboard/disputes',
      tag: 'dispute',
    }),
    disputeResolved: () => ({
      title: '✅ Dispute Resolved',
      body: 'Your delivery dispute has been resolved by Trac support',
      url: '/dashboard/disputes',
      tag: 'dispute-resolved',
    }),
    newRating: (stars: number) => ({
      title: '⭐ New Rating Received',
      body: `You received a ${stars}-star rating`,
      url: '/dashboard/ratings',
      tag: 'rating',
    }),
  };
}
