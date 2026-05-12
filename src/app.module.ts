// trac-backend/src/app.module.ts
// Day 18: Added DisputesModule and Dispute entity

import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AuthModule } from './auth/auth.module';
import { UsersModule } from './users/users.module';
import { JobsModule } from './jobs/jobs.module';
import { BidsModule } from './bids/bids.module';
import { PaymentsModule } from './payments/payments.module';
import { EventsModule } from './events/events.module';
import { RatingsModule } from './ratings/ratings.module';
import { DisputesModule } from './disputes/disputes.module';
import { AnalyticsModule } from './analytics/analytics.module';
import { AdminModule } from './admin/admin.module';
import { KycModule } from './kyc/kyc.module';

import { PushModule } from './push/push.module';
import { WaybillModule } from './waybill/waybill.module';
import { CallingModule } from './calling/calling.module';
import { User } from './users/entities/user.entity';
import { Job } from './jobs/entities/job.entity';
import { Bid } from './bids/entities/bid.entity';
import { Payment } from './payments/entities/payment.entity';
import { Rating } from './ratings/entities/rating.entity';
import { Dispute } from './disputes/entities/dispute.entity';
import { PushSubscription } from './push/entities/push-subscription.entity';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    TypeOrmModule.forRootAsync({
      useFactory: () => ({
        type: 'postgres',
        url: process.env.DATABASE_URL,
        entities: [User, Job, Bid, Payment, Rating, Dispute, PushSubscription],
        synchronize: process.env.TYPEORM_SYNC !== 'false',
        ssl: process.env.NODE_ENV === 'production'
          ? { rejectUnauthorized: false }
          : false,
        logging: process.env.NODE_ENV !== 'production',
      }),
    }),
    AuthModule,
    UsersModule,
    JobsModule,
    BidsModule,
    PaymentsModule,
    EventsModule,
    RatingsModule,
    DisputesModule,
    AnalyticsModule,
    AdminModule,
    PushModule,
    WaybillModule,
    CallingModule,
    KycModule,
  ],
})
export class AppModule {}