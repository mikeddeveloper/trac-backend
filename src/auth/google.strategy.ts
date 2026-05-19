import { Injectable, Logger } from '@nestjs/common';
import { PassportStrategy } from '@nestjs/passport';
import { Strategy, VerifyCallback } from 'passport-google-oauth20';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { User, UserRole } from '../users/entities/user.entity';

@Injectable()
export class GoogleStrategy extends PassportStrategy(Strategy, 'google') {
  private readonly logger = new Logger(GoogleStrategy.name);

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
      const email: string | undefined = profile.emails?.[0]?.value;
      const fullName: string = profile.displayName;
      const googleId: string = profile.id;
      const avatarUrl: string | undefined = profile.photos?.[0]?.value;

      if (!email) return done(new Error('No email from Google'), false as any);

      let user = await this.userRepo.findOne({ where: { googleId } });

      if (!user) {
        user = await this.userRepo.findOne({ where: { email } });
      }

      if (user) {
        user.googleId = googleId;
        if (avatarUrl) user.avatarUrl = avatarUrl;
        user = await this.userRepo.save(user);
      } else {
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
      }

      this.logger.log(`Google login: ${user.fullName} (${user.role}) - ${user.email}`);
      return done(null, user);
    } catch (error) {
      this.logger.error('Google OAuth error:', error);
      return done(error as Error, false as any);
    }
  }
}
