import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { KycService } from './kyc.service';
import { KycController } from './kyc.controller';
import { User } from '../users/entities/user.entity';
import { PushModule } from '../push/push.module';

@Module({
  imports: [TypeOrmModule.forFeature([User]), PushModule],
  controllers: [KycController],
  providers: [KycService],
  exports: [KycService],
})
export class KycModule {}
