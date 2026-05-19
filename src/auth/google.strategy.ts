import { Injectable } from '@nestjs/common';
import { PassportStrategy } from '@nestjs/passport';
import { Strategy, VerifyCallback } from 'passport-google-oauth20';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { User, UserRole } from '../users/entities/user.entity';

@Injectable()
export class GoogleStrategy extends PassportStrategy(Strategy, 'google') {
  constructor(
    configService: ConfigService,
    @InjectRepository(User)
    private userRepo: Repository<User>,
  ) {
    super({
      clientID: configService.get<string>('GOOGLE_CLIENT_ID', ''),
      clientSecret: configService.get<string>('GOOGLE_CLIENT_SECRET', ''),
      callbackURL: configService.get<string>('GOOGLE_CALLBACK_URL', ''),
      scope: ['email', 'profile'],
    });
  }

  async validate(_accessToken: string, _refreshToken: string, profile: any, done: VerifyCallback) {
    try {
      const email = profile.emails?.[0]?.value as string | undefined;
      const fullName = profile.displayName as string;
      const googleId = profile.id as string;
      const avatarUrl = profile.photos?.[0]?.value as string | undefined;

      if (!email) return done(new Error('No email from Google'), false as any);

      let user = await this.userRepo.findOne({ where: { email } });

      if (!user) {
        const newUser = this.userRepo.create({
          fullName,
          email,
          googleId,
          avatarUrl: avatarUrl ?? undefined,
          role: UserRole.CUSTOMER,
          isVerified: true,
          phone: '00000000000',
        });
        newUser.password = Math.random().toString(36);
        user = await this.userRepo.save(newUser);
      } else {
        await this.userRepo.update(user.id, { googleId, avatarUrl: avatarUrl ?? undefined });
        user.googleId = googleId;
        user.avatarUrl = avatarUrl ?? user.avatarUrl;
      }

      return done(null, user);
    } catch (error) {
      return done(error as Error, false as any);
    }
  }
}
