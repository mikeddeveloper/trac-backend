import { CanActivate, ExecutionContext, ForbiddenException, Injectable } from '@nestjs/common';
import { DataSource } from 'typeorm';

const ROLE_RULES: Record<string, RegExp[]> = {
  operations: [/^\/me$/, /^\/stats$/, /^\/jobs/, /^\/users(?!\/.*wallet-credit)/, /^\/verifications/, /^\/license/, /^\/disputes/, /^\/activity$/],
  finance: [/^\/me$/, /^\/payments/, /^\/analytics/, /^\/stats$/],
  compliance: [/^\/me$/, /^\/verifications/, /^\/license/, /^\/documents/, /^\/disputes/, /^\/jobs/],
  support: [/^\/me$/, /^\/jobs/, /^\/users(?!\/.*wallet-credit)/, /^\/activity$/],
  super_admin: [/^\//],
};

@Injectable()
export class AdminGuard implements CanActivate {
  constructor(private readonly dataSource: DataSource) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest();
    if (request.user?.role !== 'admin') throw new ForbiddenException('Admin access required');
    const rows = await this.dataSource.query('SELECT value FROM platform_settings WHERE key = $1 LIMIT 1', [`adminRole:${request.user.id}`]);
    const ownerEmail = String(process.env.ADMIN_EMAIL || 'mikeddev6@gmail.com').trim().toLowerCase();
    const role = String(rows[0]?.value || (String(request.user.email || '').toLowerCase() === ownerEmail ? 'super_admin' : 'unassigned')).replace(/^"|"$/g, '');
    request.adminRole = role;
    const path = String(request.route?.path || request.path || '').replace(/^\/api\/admin/, '') || '/';
    if (!(ROLE_RULES[role] || []).some(rule => rule.test(path))) {
      throw new ForbiddenException(`Administrator role "${role}" cannot access this area`);
    }
    return true;
  }
}
