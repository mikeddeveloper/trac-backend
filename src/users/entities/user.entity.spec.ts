import 'reflect-metadata';
import { instanceToPlain } from 'class-transformer';
import { User } from './user.entity';

describe('User response serialization', () => {
  it('never exposes authentication and verification secrets', () => {
    const user = Object.assign(new User(), {
      id: '00000000-0000-4000-8000-000000000001',
      email: 'customer@example.com',
      fullName: 'Customer',
      emailOtp: '123456',
      emailOtpExpiry: new Date(),
      refreshToken: 'hashed-refresh-token',
      sessionVersion: 4,
      passwordResetToken: 'hashed-reset-token',
      passwordResetExpiry: new Date(),
    });

    const output = instanceToPlain(user);
    expect(output).toMatchObject({ id: user.id, email: user.email });
    expect(output).not.toHaveProperty('emailOtp');
    expect(output).not.toHaveProperty('emailOtpExpiry');
    expect(output).not.toHaveProperty('refreshToken');
    expect(output).not.toHaveProperty('sessionVersion');
    expect(output).not.toHaveProperty('passwordResetToken');
    expect(output).not.toHaveProperty('passwordResetExpiry');
  });
});
