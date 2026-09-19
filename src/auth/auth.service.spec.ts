import { BadRequestException, UnauthorizedException } from '@nestjs/common';
import { AuthService } from './auth.service';
import { UserRole } from '../users/entities/user.entity';
import { createHash } from 'crypto';

describe('AuthService public signup role protections', () => {
  it.each([UserRole.ADMIN, UserRole.ENTERPRISE])(
    'rejects the %s role before looking up or creating an account',
    async (role) => {
    const usersService = {
      findByEmail: jest.fn(),
      create: jest.fn(),
    };
    const service = new AuthService(usersService as any, {} as any, {} as any, {} as any);

    await expect(service.signup({
      fullName: 'Privilege Test',
      email: 'attacker@example.com',
      phone: '08000000000',
      password: 'Password123!',
      role,
    })).rejects.toBeInstanceOf(BadRequestException);

    expect(usersService.findByEmail).not.toHaveBeenCalled();
    expect(usersService.create).not.toHaveBeenCalled();
    },
  );
});

describe('AuthService Google exchange codes', () => {
  const user = {
    id: 'user-1',
    email: 'user@example.com',
    fullName: 'Test User',
    role: 'customer',
    isVerified: true,
    isSuspended: false,
  };
  const usersService = { findById: jest.fn().mockResolvedValue(user) };
  const service = new AuthService(
    usersService as any,
    {} as any,
    {} as any,
    {} as any,
  );

  beforeEach(() => {
    jest.spyOn(service, 'generateTokens').mockResolvedValue({
      accessToken: 'access-token',
      refreshToken: 'refresh-token',
    });
  });

  afterEach(() => jest.restoreAllMocks());

  it('exchanges a valid code for a complete session', async () => {
    const code = service.createGoogleExchangeCode(user.id);
    await expect(service.exchangeGoogleCode(code)).resolves.toEqual(
      expect.objectContaining({
        user: expect.objectContaining({ id: user.id }),
        accessToken: 'access-token',
        refreshToken: 'refresh-token',
      }),
    );
  });

  it('cannot exchange the same code twice', async () => {
    const code = service.createGoogleExchangeCode(user.id);
    await service.exchangeGoogleCode(code);
    await expect(service.exchangeGoogleCode(code)).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('rejects unknown codes', async () => {
    await expect(service.exchangeGoogleCode('unknown-code'))
      .rejects.toBeInstanceOf(UnauthorizedException);
  });
});

describe('AuthService mobile Google sign-in', () => {
  const verifiedPayload = {
    sub: 'google-123',
    email: 'driver@example.com',
    email_verified: true,
    name: 'Driver Example',
    picture: 'https://example.com/avatar.jpg',
  };

  function setup(existing: any = null) {
    const usersService = {
      findByGoogleId: jest.fn().mockResolvedValue(existing),
      findByEmail: jest.fn().mockResolvedValue(existing),
      create: jest.fn().mockImplementation(async (value) => ({ id: 'new-user', ...value })),
      updateProfile: jest.fn(),
      findById: jest.fn(),
    };
    const configService = { get: jest.fn().mockReturnValue('google-web-client-id') };
    const emailService = { sendWelcomeEmail: jest.fn().mockResolvedValue({ success: true }) };
    const paymentsService = { creditSignupLaunchBonus: jest.fn().mockResolvedValue(undefined) };
    const service = new AuthService(usersService as any, {} as any, configService as any, emailService as any, paymentsService as any);
    jest.spyOn((service as any).googleTokenClient, 'verifyIdToken').mockResolvedValue({
      getPayload: () => verifiedPayload,
    });
    jest.spyOn(service, 'generateTokens').mockResolvedValue({
      accessToken: 'access-token',
      refreshToken: 'refresh-token',
    });
    return { service, usersService };
  }

  afterEach(() => jest.restoreAllMocks());

  it('requests a phone before creating a new Google account', async () => {
    const { service, usersService } = setup();
    await expect(service.mobileGoogleLogin({
      idToken: 'verified-token',
      role: UserRole.TRANSPORTER,
    })).resolves.toEqual(expect.objectContaining({
      profileRequired: true,
      profile: expect.objectContaining({ role: UserRole.TRANSPORTER }),
    }));
    expect(usersService.create).not.toHaveBeenCalled();
  });

  it('preserves the chosen public role when completing a Google account', async () => {
    const { service, usersService } = setup();
    await expect(service.mobileGoogleLogin({
      idToken: 'verified-token',
      role: UserRole.TRANSPORTER,
      phone: '+2348012345678',
    })).resolves.toEqual(expect.objectContaining({
      profileRequired: false,
      user: expect.objectContaining({ role: UserRole.TRANSPORTER }),
    }));
    expect(usersService.create).toHaveBeenCalledWith(expect.objectContaining({
      role: UserRole.TRANSPORTER,
      phone: '+2348012345678',
      emailVerified: true,
    }));
  });
});

describe('AuthService password login', () => {
  it('normalizes email addresses before looking up an account', async () => {
    const usersService = {
      findByEmailWithPassword: jest.fn().mockResolvedValue({
        id: 'user-1', email: 'user@example.com', password: '$2b$04$invalid',
        role: 'customer', isSuspended: false,
      }),
    };
    const service = new AuthService(usersService as any, {} as any, {} as any, {} as any);

    await expect(service.login({ email: ' User@Example.COM ', password: 'wrong' }))
      .rejects.toBeInstanceOf(UnauthorizedException);
    expect(usersService.findByEmailWithPassword).toHaveBeenCalledWith('user@example.com');
  });

  it('returns a useful response for Google-only accounts', async () => {
    const usersService = {
      findByEmailWithPassword: jest.fn().mockResolvedValue({
        id: 'user-1', email: 'user@example.com', password: null,
        role: 'customer', isSuspended: false,
      }),
    };
    const service = new AuthService(usersService as any, {} as any, {} as any, {} as any);

    await expect(service.login({ email: 'user@example.com', password: 'anything' }))
      .rejects.toThrow('This account uses Google sign-in');
  });
});

describe('AuthService password reset protections', () => {
  it('stores a hash of the emailed reset token', async () => {
    const usersService = {
      findByEmail: jest.fn().mockResolvedValue({ id: 'user-1', email: 'user@example.com', fullName: 'User' }),
      updateProfile: jest.fn().mockResolvedValue(undefined),
    };
    const emailService = { sendPasswordResetEmail: jest.fn().mockResolvedValue({ success: true }) };
    const configService = { get: jest.fn().mockReturnValue('https://trac.example') };
    const service = new AuthService(usersService as any, {} as any, configService as any, emailService as any);

    await service.forgotPassword('user@example.com');

    const stored = usersService.updateProfile.mock.calls[0][1].passwordResetToken;
    const resetUrl = emailService.sendPasswordResetEmail.mock.calls[0][1] as string;
    const rawToken = new URL(resetUrl).searchParams.get('token') as string;
    expect(stored).toBe(createHash('sha256').update(rawToken).digest('hex'));
    expect(stored).not.toBe(rawToken);
  });

  it('rejects malformed reset tokens before querying the database', async () => {
    const usersService = { findByPasswordResetToken: jest.fn() };
    const service = new AuthService(usersService as any, {} as any, {} as any, {} as any);

    await expect(service.resetPassword('short', 'Password123!'))
      .rejects.toBeInstanceOf(BadRequestException);
    expect(usersService.findByPasswordResetToken).not.toHaveBeenCalled();
  });
});
