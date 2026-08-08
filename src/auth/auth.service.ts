import { Injectable, Logger, ConflictException, UnauthorizedException, NotFoundException, BadRequestException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';
import * as bcrypt from 'bcrypt';
import { UsersService } from '../users/users.service';
import { UserRole } from '../users/entities/user.entity';
import { SignupDto } from './dto/signup.dto';
import { LoginDto } from './dto/login.dto';
import { EmailService } from '../email/email.service';

@Injectable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name);

  constructor(
    private usersService: UsersService,
    private jwtService: JwtService,
    private configService: ConfigService,
    private emailService: EmailService,
  ) {}

  async signup(dto: SignupDto) {
    // Check if email already exists
    const existing = await this.usersService.findByEmail(dto.email);
    if (existing) throw new ConflictException('Email already registered');

    // Hash password
    const hashedPassword = await bcrypt.hash(dto.password, 12);

    // Create user
    const user = await this.usersService.create({
      ...dto,
      password: hashedPassword,
    });

    const otp = Math.floor(100000 + Math.random() * 900000).toString();
    const otpExpiry = new Date(Date.now() + 10 * 60 * 1000);

    await this.usersService.updateProfile(user.id, {
      emailOtp: otp,
      emailOtpExpiry: otpExpiry,
    } as any);

    this.emailService.sendOtpEmail({
      fullName: user.fullName,
      email: user.email,
    }, otp).catch((err) => {
      this.logger.error('OTP email failed:', err?.message);
    });

    this.emailService.sendWelcomeEmail({
      fullName: user.fullName,
      email: user.email,
      role: user.role,
    }).then((result) => {
      this.logger.log('Welcome email result: ' + JSON.stringify(result));
    }).catch((error) => {
      this.logger.error('Welcome email failed to send: ' + (error?.message || error));
    });

    // Generate tokens
    const tokens = await this.generateTokens(user.id, user.email, user.role);

    return {
      user: {
        id: user.id,
        fullName: user.fullName,
        email: user.email,
        phone: user.phone,
        role: user.role,
        isVerified: user.isVerified,
      },
      ...tokens,
    };
  }

  async login(dto: LoginDto) {
    // Find user with password
    const user = await this.usersService.findByEmailWithPassword(dto.email);
    if (!user) throw new UnauthorizedException('No account found with this email address');

    // Check password
    const passwordMatch = await bcrypt.compare(dto.password, user.password);
    if (!passwordMatch) throw new UnauthorizedException('Incorrect password. Please try again');

    // Generate tokens
    const tokens = await this.generateTokens(user.id, user.email, user.role);

    return {
      user: {
        id: user.id,
        fullName: user.fullName,
        email: user.email,
        phone: user.phone,
        role: user.role,
        isVerified: user.isVerified,
      },
      ...tokens,
    };
  }

  async generateTokens(userId: string, email: string, role: string) {
    const payload = { sub: userId, email, role };

    const [accessToken, refreshToken] = await Promise.all([
      this.jwtService.signAsync(payload, {
        secret: this.configService.get('JWT_SECRET'),
        expiresIn: this.configService.get('JWT_EXPIRES_IN'),
      }),
      this.jwtService.signAsync(payload, {
        secret: this.configService.get('JWT_REFRESH_SECRET'),
        expiresIn: this.configService.get('JWT_REFRESH_EXPIRES_IN'),
      }),
    ]);

    // Save refresh token hash to DB
    const hashedRefresh = await bcrypt.hash(refreshToken, 10);
    await this.usersService.updateRefreshToken(userId, hashedRefresh);

    return { accessToken, refreshToken };
  }

  async googleLogin(googleUser: {
    googleId: string;
    email: string;
    fullName: string;
    avatarUrl?: string | null;
  }) {
    let user = await this.usersService.findByGoogleId(googleUser.googleId);

    if (!user) {
      const existing = await this.usersService.findByEmail(googleUser.email);
      if (existing) {
        await this.usersService.updateProfile(existing.id, {
          googleId: googleUser.googleId,
          avatarUrl: googleUser.avatarUrl ?? existing.avatarUrl,
        });
        user = await this.usersService.findById(existing.id);
      } else {
        user = await this.usersService.create({
          googleId: googleUser.googleId,
          email: googleUser.email,
          fullName: googleUser.fullName,
          avatarUrl: googleUser.avatarUrl ?? undefined,
          role: UserRole.CUSTOMER,
          isVerified: true,
        });
      }
    }

    const tokens = await this.generateTokens(user.id, user.email, user.role);

    return {
      user: {
        id: user.id,
        fullName: user.fullName,
        email: user.email,
        phone: user.phone,
        role: user.role,
        isVerified: user.isVerified,
      },
      ...tokens,
    };
  }

  generateAccessToken(payload: Record<string, unknown>): string {
    return this.jwtService.sign(payload);
  }

  async logout(userId: string) {
    await this.usersService.updateRefreshToken(userId, null);
    return { message: 'Logged out successfully' };
  }

  async verifyEmailOtp(userId: string, otp: string) {
    const user = await this.usersService.findById(userId);
    if (!user) throw new NotFoundException('User not found');

    if ((user as any).emailVerified) {
      return { message: 'Email already verified', verified: true };
    }

    if (!(user as any).emailOtp || (user as any).emailOtp !== otp) {
      throw new BadRequestException('Invalid verification code');
    }

    if (new Date() > new Date((user as any).emailOtpExpiry)) {
      throw new BadRequestException('Verification code has expired. Please request a new one.');
    }

    await this.usersService.updateProfile(userId, {
      emailVerified: true,
      emailOtp: null,
      emailOtpExpiry: null,
    } as any);

    return { message: 'Email verified successfully', verified: true };
  }

  async resendEmailOtp(userId: string) {
    const user = await this.usersService.findById(userId);
    if (!user) throw new NotFoundException('User not found');

    if ((user as any).emailVerified) {
      throw new BadRequestException('Email already verified');
    }

    const otp = Math.floor(100000 + Math.random() * 900000).toString();
    const otpExpiry = new Date(Date.now() + 10 * 60 * 1000);

    await this.usersService.updateProfile(userId, {
      emailOtp: otp,
      emailOtpExpiry: otpExpiry,
    } as any);

    await this.emailService.sendOtpEmail({
      fullName: user.fullName,
      email: user.email,
    }, otp);

    return { message: 'Verification code resent' };
  }

  async forgotPassword(email: string) {
    const user = await this.usersService.findByEmail(email);
    if (!user) {
      return { message: 'If that email is registered, a reset link has been sent.' };
    }

    const crypto = require('crypto');
    const token = crypto.randomBytes(32).toString('hex');
    const expiry = new Date(Date.now() + 60 * 60 * 1000);

    await this.usersService.updateProfile(user.id, {
      passwordResetToken: token,
      passwordResetExpiry: expiry,
    } as any);

    const frontendUrl = this.configService.get('FRONTEND_URL') || 'https://traclogistics.com.ng';
    const resetUrl = `${frontendUrl}/reset-password?token=${token}`;

    this.emailService.sendPasswordResetEmail({ fullName: user.fullName, email: user.email }, resetUrl)
      .catch(err => this.logger.error('Password reset email failed:', err?.message));

    return { message: 'If that email is registered, a reset link has been sent.' };
  }

  async resetPassword(token: string, newPassword: string) {
    const user = await this.usersService.findByPasswordResetToken(token);
    if (!user) throw new BadRequestException('Invalid or expired reset link.');

    if (new Date() > new Date((user as any).passwordResetExpiry)) {
      throw new BadRequestException('Reset link has expired. Please request a new one.');
    }

    const hashed = await bcrypt.hash(newPassword, 12);
    await this.usersService.updateProfile(user.id, {
      password: hashed,
      passwordResetToken: null,
      passwordResetExpiry: null,
    } as any);

    return { message: 'Password reset successfully. You can now log in.' };
  }

  async changePassword(userId: string, currentPassword: string, newPassword: string) {
    const user = await this.usersService.findById(userId);
    if (!user) throw new NotFoundException('User not found');

    const userWithPw = await this.usersService.findByEmailWithPassword(user.email);
    if (!userWithPw) throw new NotFoundException('User not found');

    const isValid = await bcrypt.compare(currentPassword, userWithPw.password);
    if (!isValid) throw new BadRequestException('Current password is incorrect');

    const hashed = await bcrypt.hash(newPassword, 10);
    await this.usersService.updateProfile(userId, { password: hashed } as any);

    return { message: 'Password updated successfully' };
  }
}