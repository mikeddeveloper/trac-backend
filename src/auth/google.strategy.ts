import { Injectable, Logger } from '@nestjs/common';
import { PassportStrategy } from '@nestjs/passport';
import { Strategy, VerifyCallback } from 'passport-google-oauth20';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { User } from '../users/entities/user.entity';

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

  async validate(
    _accessToken: string,
    _refreshToken: string,
    profile: any,
    done: VerifyCallback,
  ) {
    try {
      const email = profile.emails?.[0]?.value;
      const fullName = profile.displayName;
      const googleId = profile.id;
      const avatarUrl = profile.photos?.[0]?.value || null;

      if (!email) {
        return done(new Error('No email from Google'), false as any);
      }

      this.logger.log(`Google login attempt: ${fullName} - ${email}`);

      let user = await this.userRepo.findOne({ where: { googleId } });

      if (!user) {
        user = await this.userRepo.findOne({ where: { email } });
      }

      if (user) {
        user.googleId = googleId;
        if (avatarUrl) {
          user.avatarUrl = avatarUrl;
        }
        await this.userRepo.save(user);
        user = await this.userRepo.findOne({ where: { id: user.id } });
        this.logger.log(`Google login existing user: ${user!.fullName} (${user!.role})`);
      } else {
        const newUser = new User();
        newUser.fullName = fullName;
        newUser.email = email;
        (newUser as any).googleId = googleId;
        newUser.avatarUrl = avatarUrl;
        newUser.role = 'customer' as any;
        newUser.isVerified = true;
        newUser.password = Math.random().toString(36);
        newUser.phone = '00000000000';
        user = await this.userRepo.save(newUser);
        this.logger.log(`Google login new user created: ${user.fullName}`);
      }

      return done(null, user ?? false);
    } catch (error) {
      this.logger.error('Google OAuth error:', (error as Error).message);
      return done(error as Error, false as any);
    }
  }
}
