import { Injectable, UnauthorizedException } from '@nestjs/common';
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
    });
  }

  async validate(payload: any) {
    const userId = payload.id || payload.sub;
    const user = await this.usersService.findById(userId);
    if (user.isSuspended) throw new UnauthorizedException('Account suspended');
    return {
      id: user.id,
      sub: user.id,
      email: user.email,
      role: user.role,
      fullName: user.fullName,
    };
  }
}
