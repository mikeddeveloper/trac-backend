import { ExceptionFilter, Catch, ArgumentsHost, HttpException, HttpStatus, Logger } from '@nestjs/common';
import { Request, Response } from 'express';

@Catch()
export class GlobalExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger('ExceptionFilter');

  catch(exception: unknown, host: ArgumentsHost) {
    const ctx    = host.switchToHttp();
    const res    = ctx.getResponse<Response>();
    const req    = ctx.getRequest<Request>();
    const isProd = process.env.NODE_ENV === 'production';

    let status  = HttpStatus.INTERNAL_SERVER_ERROR;
    let message: string | string[] = 'An unexpected error occurred';

    if (exception instanceof HttpException) {
      status = exception.getStatus();
      const body = exception.getResponse();
      message = typeof body === 'string'
        ? body
        : (body as any).message || message;
    } else {
      // Log the real error server-side but never send stack to client
      this.logger.error(
        `Unhandled exception: ${(exception as any)?.message}`,
        isProd ? undefined : (exception as any)?.stack,
      );
    }

    res.status(status).json({
      statusCode: status,
      message,
      timestamp: new Date().toISOString(),
      path: req.url,
      // Never expose stack traces or internal details to clients
    });
  }
}
