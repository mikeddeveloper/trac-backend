import { UnauthorizedException } from '@nestjs/common';
import { AuthService } from './auth.service';

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
