import { BadRequestException, UnauthorizedException } from '@nestjs/common';
import { AuthService } from './auth.service';
import { UserRole } from '../users/entities/user.entity';

describe('AuthService public signup role protections', () => {
  it('rejects an admin role before looking up or creating an account', async () => {
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
      role: UserRole.ADMIN,
    })).rejects.toBeInstanceOf(BadRequestException);

    expect(usersService.findByEmail).not.toHaveBeenCalled();
    expect(usersService.create).not.toHaveBeenCalled();
  });
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
