import {
  Injectable,
  Optional,
  Logger,
  ConflictException,
  UnauthorizedException,
  NotFoundException,
  BadRequestException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';
import * as bcrypt from 'bcrypt';
import { UsersService } from '../users/users.service';
import { UserRole } from '../users/entities/user.entity';
import { SignupDto } from './dto/signup.dto';
import { LoginDto } from './dto/login.dto';
import { EmailService } from '../email/email.service';
import { createHash, randomBytes } from 'crypto';
import { PaymentsService } from '../payments/payments.service';

@Injectable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name);
  private readonly googleExchangeCodes = new Map<
    string,
    { userId: string; expiresAt: number }
  >();

  constructor(
    private usersService: UsersService,
    private jwtService: JwtService,
    private configService: ConfigService,
    private emailService: EmailService,
    @Optional() private paymentsService?: PaymentsService,
  ) {}

  async signup(dto: SignupDto) {
    const publicRoles = new Set<UserRole>([
      UserRole.CUSTOMER,
      UserRole.TRANSPORTER,
    ]);
    if (!publicRoles.has(dto.role)) {
      this.logger.warn(`Blocked privileged role request on public signup: ${String(dto.role)}`);
      throw new BadRequestException('This account role cannot be created through public signup');
    }
    const email = dto.email.trim().toLowerCase();
    // Check if email already exists
    const existing = await this.usersService.findByEmail(email);
    if (existing) throw new ConflictException('Email already registered');

    // Hash password
    const hashedPassword = await bcrypt.hash(dto.password, 12);

    // Create user
    const user = await this.usersService.create({
      ...dto,
      email,
      password: hashedPassword,
      // Never allow object-spread changes to bypass the public-role check.
      role: dto.role,
      // A licence is not pending until its document and details are submitted.
      licenseStatus: 'not_submitted',
    });

    await this.paymentsService?.creditSignupLaunchBonus(user).catch((error: Error) => {
      this.logger.error(`Launch bonus credit failed for ${user.email}: ${error.message}`);
    });

    const otp = Math.floor(100000 + Math.random() * 900000).toString();
    const otpExpiry = new Date(Date.now() + 10 * 60 * 1000);

    await this.usersService.updateProfile(user.id, {
      emailOtp: otp,
      emailOtpExpiry: otpExpiry,
    } as any);

    // Generate tokens
    const tokens = await this.generateTokens(user.id, user.email, user.role);

    // Do not make account creation depend on external mail-provider latency.
    void Promise.allSettled([
      this.emailService.sendOtpEmail(
        { fullName: user.fullName, email: user.email },
        otp,
      ),
      this.emailService.sendWelcomeEmail({
        fullName: user.fullName,
        email: user.email,
        role: user.role,
      }),
    ]).then((results) => {
      const labels = ['OTP', 'Welcome'];
      results.forEach((result, index) => {
        if (result.status === 'rejected' || !result.value?.success) {
          const reason =
            result.status === 'rejected' ? result.reason?.message : undefined;
          this.logger.error(
            `${labels[index]} email was not delivered to ${user.email}: ${reason || 'unknown provider error'}`,
          );
        }
      });
    });

    return {
      user: {
        id: user.id,
        fullName: user.fullName,
        email: user.email,
        phone: user.phone,
        role: user.role,
        isVerified: user.isVerified,
        emailVerified: user.emailVerified,
        ninVerified: user.ninVerified,
        licenseVerified: user.licenseVerified,
        licenseStatus: user.licenseStatus || 'not_submitted',
        kycStatus: user.kycStatus,
      },
      ...tokens,
      emailDelivery: { status: 'queued' },
    };
  }

  async login(dto: LoginDto) {
    const email = dto.email.trim().toLowerCase();
    // Find user with password
    const user = await this.usersService.findByEmailWithPassword(email);
    if (!user)
      throw new UnauthorizedException(
        'No account found with this email address',
      );

    if (user.isSuspended)
      throw new UnauthorizedException('Account is suspended');
    if (user.role === UserRole.ENTERPRISE)
      throw new UnauthorizedException('Enterprise access is not available yet');
    if (!user.password) {
      throw new UnauthorizedException(
        'This account uses Google sign-in. Continue with Google instead.',
      );
    }

    // Check password
    const passwordMatch = await bcrypt.compare(dto.password, user.password);
    if (!passwordMatch)
      throw new UnauthorizedException('Incorrect password. Please try again');

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
        emailVerified: user.emailVerified,
        ninVerified: user.ninVerified,
        licenseVerified: user.licenseVerified,
        licenseStatus: user.licenseStatus || 'not_submitted',
        kycStatus: user.kycStatus,
      },
      ...tokens,
    };
  }

  async generateTokens(userId: string, email: string, role: string) {
    const tokenUser = await this.usersService.findById(userId);
    const payload = { sub: userId, email, role, sv: Number(tokenUser.sessionVersion || 0) };

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

  async refreshTokens(refreshToken: string) {
    if (!refreshToken)
      throw new UnauthorizedException('Refresh token is required');

    let payload: { sub: string; email: string; role: string; sv?: number };
    try {
      payload = await this.jwtService.verifyAsync(refreshToken, {
        secret: this.configService.get<string>('JWT_REFRESH_SECRET'),
      });
    } catch {
      throw new UnauthorizedException('Invalid or expired refresh token');
    }

    const user = await this.usersService.findById(payload.sub);
    if (user.isSuspended || user.role === UserRole.ENTERPRISE || !user.refreshToken) {
      throw new UnauthorizedException('Session has been revoked');
    }
    if (Number(payload.sv ?? -1) !== Number(user.sessionVersion || 0)) {
      throw new UnauthorizedException('Session has been revoked');
    }

    const matches = await bcrypt.compare(refreshToken, user.refreshToken);
    if (!matches) {
      await this.usersService.updateRefreshToken(user.id, null);
      throw new UnauthorizedException('Refresh token reuse detected');
    }

    return this.generateTokens(user.id, user.email, user.role);
  }

  createGoogleExchangeCode(userId: string): string {
    const code = randomBytes(32).toString('base64url');
    const codeHash = createHash('sha256').update(code).digest('hex');
    const now = Date.now();
    for (const [hash, entry] of this.googleExchangeCodes) {
      if (entry.expiresAt <= now) this.googleExchangeCodes.delete(hash);
    }
    this.googleExchangeCodes.set(codeHash, { userId, expiresAt: now + 60_000 });
    return code;
  }

  async exchangeGoogleCode(code: string) {
    if (!code || typeof code !== 'string') {
      throw new UnauthorizedException('Google sign-in code is required');
    }

    const codeHash = createHash('sha256').update(code).digest('hex');
    const entry = this.googleExchangeCodes.get(codeHash);
    this.googleExchangeCodes.delete(codeHash);
    if (!entry || entry.expiresAt <= Date.now()) {
      throw new UnauthorizedException('Invalid or expired Google sign-in code');
    }

    const user = await this.usersService.findById(entry.userId);
    if (user.isSuspended)
      throw new UnauthorizedException('Account is suspended');
    if (user.role === UserRole.ENTERPRISE)
      throw new UnauthorizedException('Enterprise access is not available yet');
    const tokens = await this.generateTokens(user.id, user.email, user.role);
    return {
      user: {
        id: user.id,
        fullName: user.fullName,
        email: user.email,
        phone: user.phone,
        role: user.role,
        isVerified: user.isVerified,
        emailVerified: user.emailVerified,
        avatarUrl: user.avatarUrl || null,
      },
      ...tokens,
    };
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
          emailVerified: true,
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
          emailVerified: true,
        });
      }
    }

    if (user.role === UserRole.ENTERPRISE)
      throw new UnauthorizedException('Enterprise access is not available yet');
    const tokens = await this.generateTokens(user.id, user.email, user.role);

    return {
      user: {
        id: user.id,
        fullName: user.fullName,
        email: user.email,
        phone: user.phone,
        role: user.role,
        isVerified: user.isVerified,
        emailVerified: user.emailVerified,
      },
      ...tokens,
    };
  }

  async logout(userId: string) {
    await this.usersService.revokeSessions(userId);
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
      throw new BadRequestException(
        'Verification code has expired. Please request a new one.',
      );
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

    const delivery = await this.emailService.sendOtpEmail(
      {
        fullName: user.fullName,
        email: user.email,
      },
      otp,
    );

    if (!delivery?.success) {
      throw new ServiceUnavailableException(
        'We could not send the verification email. Please try again shortly.',
      );
    }

    return { message: 'Verification code resent' };
  }

  async forgotPassword(email: string) {
    const user = await this.usersService.findByEmail(
      email.trim().toLowerCase(),
    );
    if (!user) {
      return {
        message: 'If that email is registered, a reset link has been sent.',
      };
    }

    const crypto = require('crypto');
    const token = crypto.randomBytes(32).toString('hex');
    const tokenHash = createHash('sha256').update(token).digest('hex');
    const expiry = new Date(Date.now() + 60 * 60 * 1000);

    await this.usersService.updateProfile(user.id, {
      passwordResetToken: tokenHash,
      passwordResetExpiry: expiry,
    } as any);

    const frontendUrl =
      this.configService.get('FRONTEND_URL') || 'https://traclogistics.com.ng';
    const resetUrl = `${frontendUrl}/reset-password?token=${token}`;

    this.emailService
      .sendPasswordResetEmail(
        { fullName: user.fullName, email: user.email },
        resetUrl,
      )
      .catch((err) =>
        this.logger.error('Password reset email failed:', err?.message),
      );

    return {
      message: 'If that email is registered, a reset link has been sent.',
    };
  }

  async resetPassword(token: string, newPassword: string) {
    if (!token || typeof token !== 'string' || token.length !== 64) {
      throw new BadRequestException('Invalid or expired reset link.');
    }
    if (!newPassword || newPassword.length < 8) {
      throw new BadRequestException('Password must be at least 8 characters.');
    }
    const tokenHash = createHash('sha256').update(token).digest('hex');
    const user = await this.usersService.findByPasswordResetToken(tokenHash);
    if (!user) throw new BadRequestException('Invalid or expired reset link.');

    if (new Date() > new Date((user as any).passwordResetExpiry)) {
      throw new BadRequestException(
        'Reset link has expired. Please request a new one.',
      );
    }

    const hashed = await bcrypt.hash(newPassword, 12);
    await this.usersService.updateProfile(user.id, {
      password: hashed,
      passwordResetToken: null,
      passwordResetExpiry: null,
    } as any);
    await this.usersService.revokeSessions(user.id);

    return { message: 'Password reset successfully. You can now log in.' };
  }

  async changePassword(
    userId: string,
    currentPassword: string,
    newPassword: string,
  ) {
    const user = await this.usersService.findById(userId);
    if (!user) throw new NotFoundException('User not found');

    const userWithPw = await this.usersService.findByEmailWithPassword(
      user.email,
    );
    if (!userWithPw) throw new NotFoundException('User not found');

    const isValid = await bcrypt.compare(currentPassword, userWithPw.password);
    if (!isValid)
      throw new BadRequestException('Current password is incorrect');

    const hashed = await bcrypt.hash(newPassword, 10);
    await this.usersService.updateProfile(userId, { password: hashed } as any);
    await this.usersService.revokeSessions(userId);

    return { message: 'Password updated successfully' };
  }
}
