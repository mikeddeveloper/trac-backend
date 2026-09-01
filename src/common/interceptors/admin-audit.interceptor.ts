import {
  CallHandler,
  ExecutionContext,
  Injectable,
  Logger,
  NestInterceptor,
} from '@nestjs/common';
import { Observable, catchError, tap, throwError } from 'rxjs';

@Injectable()
export class AdminAuditInterceptor implements NestInterceptor {
  private readonly logger = new Logger('AdminAudit');

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const request = context.switchToHttp().getRequest();
    const response = context.switchToHttp().getResponse();
    const path = String(request.originalUrl || request.url || '');
    if (!path.startsWith('/api/admin')) return next.handle();

    const startedAt = Date.now();
    const details = () => ({
      event: 'admin_request',
      adminId: request.user?.id || 'unauthenticated',
      method: request.method,
      path: path.split('?')[0],
      ip: request.ip || request.socket?.remoteAddress || 'unknown',
      statusCode: response.statusCode,
      durationMs: Date.now() - startedAt,
      timestamp: new Date().toISOString(),
    });

    return next.handle().pipe(
      tap(() => this.logger.log(JSON.stringify(details()))),
      catchError((error) => {
        this.logger.warn(JSON.stringify({ ...details(), statusCode: error?.status || 500 }));
        return throwError(() => error);
      }),
    );
  }
}
