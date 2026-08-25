import { ForbiddenException, Injectable, UnauthorizedException } from '@nestjs/common';
import { Request } from 'express';
import { PassportStrategy } from '@nestjs/passport';
import { ExtractJwt, Strategy } from 'passport-jwt';
import { ConfigService } from '@nestjs/config';
import { UsersService } from '../users/users.service';

@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy) {
  constructor(configService: ConfigService, private readonly usersService: UsersService) {
    super({
      jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
      ignoreExpiration: false,
      secretOrKey: configService.get<string>('JWT_SECRET') as string,
      passReqToCallback: true,
    });
  }

  async validate(req: Request, payload: any) {
    const userId = payload.id || payload.sub;
    const user = await this.usersService.findById(userId);
    const path = (req.originalUrl || req.path).split('?')[0];
    const suspensionRecoveryPath = path.startsWith('/api/verification/') || path.endsWith('/api/auth/me') || path.endsWith('/api/auth/logout');
    if (user.isSuspended && !suspensionRecoveryPath) throw new UnauthorizedException('Account suspended');
    if (Number(payload.sv ?? -1) !== Number(user.sessionVersion || 0)) {
      throw new UnauthorizedException('Session has been revoked');
    }
    const verificationPaths = [
      '/api/auth/me',
      '/api/auth/verify-email',
      '/api/auth/resend-otp',
      '/api/auth/logout',
    ];
    const canUseBeforeVerification = verificationPaths.some(allowed => path.endsWith(allowed));
    if (!user.emailVerified && user.role !== 'admin' && !canUseBeforeVerification) {
      throw new ForbiddenException('Email verification is required');
    }
    return {
      id: user.id,
      sub: user.id,
      email: user.email,
      role: user.role,
      fullName: user.fullName,
      emailVerified: user.emailVerified,
    };
  }
}
