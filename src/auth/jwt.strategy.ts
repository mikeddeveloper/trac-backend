import { Injectable, UnauthorizedException } from '@nestjs/common';
import { PassportStrategy } from '@nestjs/passport';
import { ExtractJwt, Strategy } from 'passport-jwt';
import { ConfigService } from '@nestjs/config';
import { UsersService } from '../users/users.service';

@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy) {
  constructor(
    private configService: ConfigService,
    private usersService: UsersService,
  ) {
    super({
      jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
      ignoreExpiration: false,
      secretOrKey: configService.get<string>('JWT_SECRET') as string,
    });
  }

  async validate(payload: { id?: string; sub?: string; email: string; role?: string; fullName?: string }) {
    const userId = payload.id || payload.sub;
    let role = payload.role;

    // If role is missing from the JWT payload, fetch it from DB
    if (!role && userId) {
      const user = await this.usersService.findById(userId);
      if (!user) throw new UnauthorizedException('User not found');
      role = (user as any).role;
    }

    if (!role) {
      throw new UnauthorizedException('User role could not be determined');
    }

    return { id: userId, email: payload.email, role, fullName: payload.fullName };
  }
}
