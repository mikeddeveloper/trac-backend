import {
  Controller, Post, Get,
  Body, Request, Res, UseGuards, HttpCode, HttpStatus,
} from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { Throttle } from '@nestjs/throttler';
import { ConfigService } from '@nestjs/config';
import { AuthService } from './auth.service';
import { UsersService } from '../users/users.service';
import { SignupDto } from './dto/signup.dto';
import { LoginDto } from './dto/login.dto';

@Controller('auth')
export class AuthController {
  constructor(
    private readonly authService: AuthService,
    private readonly usersService: UsersService,
    private readonly configService: ConfigService,
  ) {}

  @Throttle({ default: { limit: 3, ttl: 60000 } })
  @Post('signup')
  async signup(@Body() dto: SignupDto) {
    return this.authService.signup(dto);
  }

  @Throttle({ default: { limit: 5, ttl: 60000 } })
  @Post('login')
  @HttpCode(HttpStatus.OK)
  async login(@Body() dto: LoginDto) {
    return this.authService.login(dto);
  }

  @Throttle({ default: { limit: 10, ttl: 60000 } })
  @Post('refresh')
  @HttpCode(HttpStatus.OK)
  async refresh(@Body() body: { refreshToken: string }) {
    return this.authService.refreshTokens(body.refreshToken);
  }

  @Throttle({ default: { limit: 10, ttl: 60000 } })
  @Post('google/exchange')
  @HttpCode(HttpStatus.OK)
  async exchangeGoogleCode(@Body() body: { code: string }) {
    return this.authService.exchangeGoogleCode(body.code);
  }

  @Post('change-password')
  @UseGuards(AuthGuard('jwt'))
  @Throttle({ default: { limit: 5, ttl: 60000 } })
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

    const code = this.authService.createGoogleExchangeCode(user.id);

    const frontendUrl =
      this.configService.get<string>('FRONTEND_URL') ||
      'https://traclogistics.com.ng';

    res.redirect(`${frontendUrl}/auth/google/callback?code=${encodeURIComponent(code)}`);
  }

  @Post('forgot-password')
  @Throttle({ default: { limit: 3, ttl: 60000 } })
  async forgotPassword(@Body() body: { email: string }) {
    return this.authService.forgotPassword(body.email);
  }

  @Post('reset-password')
  @Throttle({ default: { limit: 5, ttl: 60000 } })
  async resetPassword(@Body() body: { token: string; newPassword: string }) {
    return this.authService.resetPassword(body.token, body.newPassword);
  }

  @Post('verify-email')
  @UseGuards(AuthGuard('jwt'))
  @Throttle({ default: { limit: 8, ttl: 60000 } })
  async verifyEmail(@Request() req: any, @Body() body: { otp: string }) {
    return this.authService.verifyEmailOtp(req.user.id, body.otp);
  }

  @Post('resend-otp')
  @UseGuards(AuthGuard('jwt'))
  @Throttle({ default: { limit: 3, ttl: 60000 } })
  async resendOtp(@Request() req: any) {
    return this.authService.resendEmailOtp(req.user.id);
  }

  @Get('server-ip')
  async getServerIp() {
    try {
      const https = require('https');
      return new Promise((resolve) => {
        https.get('https://api.ipify.org?format=json', (res: any) => {
          let data = '';
          res.on('data', (chunk: any) => data += chunk);
          res.on('end', () => resolve(JSON.parse(data)));
        }).on('error', () => resolve({ ip: 'Could not fetch' }));
      });
    } catch {
      return { ip: 'Error fetching IP' };
    }
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
        emailVerified: user.emailVerified,
        rating: user.rating,
        totalRatings: user.totalRatings,
        tripsCompleted: user.tripsCompleted,
        vehicleType: user.vehicleType,
        licenseNumber: user.licenseNumber,
        vehiclePlate: user.vehiclePlate,
        vehicleYear: user.vehicleYear,
        rcNumber: user.rcNumber,
        state: user.state,
        companyName: user.companyName,
        avatarUrl: user.avatarUrl,
      }
    };
  }
}
