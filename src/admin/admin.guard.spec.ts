import { ExecutionContext, ForbiddenException } from '@nestjs/common';
import { AdminGuard } from './admin.guard';

describe('AdminGuard', () => {
  const contextFor = (role?: string) => ({
    switchToHttp: () => ({ getRequest: () => ({ user: role ? { role } : undefined }) }),
  } as unknown as ExecutionContext);

  it('allows administrators', () => {
    expect(new AdminGuard().canActivate(contextFor('admin'))).toBe(true);
  });

  it('rejects non-administrators', () => {
    expect(() => new AdminGuard().canActivate(contextFor('customer')))
      .toThrow(ForbiddenException);
  });
});
