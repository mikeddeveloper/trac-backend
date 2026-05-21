import {
  Controller, Post, Get,
  Body, Request, Res, UseGuards, HttpCode, HttpStatus,
} from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { Throttle } from '@nestjs/throttler';
import { ConfigService } from '@nestjs/config';
import { AuthService } from './auth.service';
import { UsersService } from '../users/users.service';

@Controller('auth')
export class AuthController {
  constructor(
    private readonly authService: AuthService,
    private readonly usersService: UsersService,
    private readonly configService: ConfigService,
  ) {}

  @Throttle({ default: { limit: 3, ttl: 60000 } })
  @Post('signup')
  async signup(@Body() dto: any) {
    return this.authService.signup(dto);
  }

  @Throttle({ default: { limit: 5, ttl: 60000 } })
  @Post('login')
  @HttpCode(HttpStatus.OK)
  async login(@Body() dto: any) {
    return this.authService.login(dto);
  }

  @Post('change-password')
  @UseGuards(AuthGuard('jwt'))
  async changePassword(
    @Request() req: any,
    @Body() body: { currentPassword: string; newPassword: string },
  ) {
    return this.authService.changePassword(req.user.id, body.currentPassword, body.newPassword);
  }

  @Post('logout')
  @UseGuards(AuthGuard('jwt'))
  @HttpCode(HttpStatus.OK)
  async logout(@Request() req: any) {
    return this.authService.logout(req.user.id);
  }

  @Get('google')
  @UseGuards(AuthGuard('google'))
  async googleAuth() {
    // Passport redirects to Google — no body needed
  }

  @Get('google/callback')
  @UseGuards(AuthGuard('google'))
  async googleCallback(@Request() req: any, @Res() res: any) {
    const user = req.user;

    const payload = {
      id: user.id,
      sub: user.id,
      email: user.email,
      role: user.role,
      fullName: user.fullName,
    };

    const accessToken = this.authService.generateAccessToken(payload);

    const frontendUrl =
      this.configService.get<string>('FRONTEND_URL') ||
      'https://trac-logistics-web-app.vercel.app';

    const userObj = {
      id: user.id,
      fullName: user.fullName,
      email: user.email,
      role: user.role,
      isVerified: user.isVerified,
      avatarUrl: user.avatarUrl || null,
      phone: user.phone || null,
    };

    const userStr = encodeURIComponent(JSON.stringify(userObj));
    res.redirect(`${frontendUrl}/auth/google/callback?token=${accessToken}&user=${userStr}`);
  }

  // GET /api/auth/me — returns full user from DB including fullName
  @Get('me')
  @UseGuards(AuthGuard('jwt'))
  async me(@Request() req: any) {
    const user = await this.usersService.findById(req.user.id);
    return {
      user: {
        id: user.id,
        fullName: user.fullName,
        email: user.email,
        phone: user.phone,
        role: user.role,
        isVerified: user.isVerified,
      }
    };
  }
}