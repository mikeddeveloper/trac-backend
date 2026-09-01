import dns from 'dns';
dns.setDefaultResultOrder('ipv4first');

import { NestFactory } from '@nestjs/core';
import { NestExpressApplication } from '@nestjs/platform-express';
import { ClassSerializerInterceptor, ValidationPipe } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { GlobalExceptionFilter } from './common/filters/http-exception.filter';
import { AppModule } from './app.module';
import helmet from 'helmet';
import { json, urlencoded } from 'express';
import { join } from 'path';
import * as fs from 'fs';
import * as express from 'express';
import { AdminAuditInterceptor } from './common/interceptors/admin-audit.interceptor';

const ALLOWED_ORIGINS = [
  'https://traclogistics.com.ng',
  'https://www.traclogistics.com.ng',
  'https://trac-logistics-web-app.vercel.app',
  'http://localhost:5173',
  'http://localhost:3000',
];

async function bootstrap() {
  const app = await NestFactory.create<NestExpressApplication>(AppModule, {
    rawBody: true,
    logger: process.env.NODE_ENV === 'production'
      ? ['error', 'warn', 'log']
      : ['error', 'warn', 'log', 'debug', 'verbose'],
  });

  // Capture raw body for Paystack webhook signature verification
  app.use('/api/payments/webhook', express.raw({ type: 'application/json' }));

  // ── Static files ───────────────────────────────────────────────────────────
  const uploadsDir = join(process.cwd(), 'uploads');
  if (!fs.existsSync(uploadsDir)) fs.mkdirSync(uploadsDir, { recursive: true });
  app.useStaticAssets(uploadsDir, { prefix: '/uploads' });

  // ── Security headers ───────────────────────────────────────────────────────
  app.use(helmet({
    crossOriginResourcePolicy: { policy: 'cross-origin' },
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'none'"],
        frameAncestors: ["'none'"],
        baseUri: ["'none'"],
        formAction: ["'none'"],
      },
    },
    hsts: { maxAge: 31536000, includeSubDomains: true },
  }));

  // ── CORS — only allow known origins ───────────────────────────────────────
  app.enableCors({
    origin: (origin: string | undefined, callback: (err: Error | null, allow?: boolean) => void) => {
      if (!origin || ALLOWED_ORIGINS.includes(origin)) {
        callback(null, true);
      } else {
        callback(new Error(`Origin ${origin} not allowed by CORS`), false);
      }
    },
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    credentials: true,
    allowedHeaders: [
      'Content-Type',
      'Authorization',
      'x-paystack-signature',
      'Accept',
      'Origin',
      'X-Requested-With',
    ],
    preflightContinue: false,
    optionsSuccessStatus: 204,
  });

  // ── Body size limit (prevent DoS) ─────────────────────────────────────────
  app.use(json({ limit: '2mb' }));
  app.use(urlencoded({ extended: true, limit: '2mb' }));

  // ── Input validation ───────────────────────────────────────────────────────
  app.useGlobalPipes(new ValidationPipe({
    whitelist: true,
    forbidNonWhitelisted: true,
    transform: true,
  }));

  // Sensitive @Exclude() fields are removed even when an entity is returned
  // accidentally, and every admin request receives a structured audit entry.
  app.useGlobalInterceptors(
    new ClassSerializerInterceptor(app.get(Reflector)),
    new AdminAuditInterceptor(),
  );

  // ── Global exception filter — no stack traces to clients ──────────────────
  app.useGlobalFilters(new GlobalExceptionFilter());

  app.setGlobalPrefix('api');

  const port = process.env.PORT || 3001;
  await app.listen(port, '0.0.0.0');
  console.log(`🚀 Trac backend running on port ${port}`);
}

bootstrap();
