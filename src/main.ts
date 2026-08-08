import dns from 'dns';
dns.setDefaultResultOrder('ipv4first');

import { NestFactory } from '@nestjs/core';
import { NestExpressApplication } from '@nestjs/platform-express';
import { ValidationPipe, HttpException, HttpStatus } from '@nestjs/common';
import { GlobalExceptionFilter } from './common/filters/http-exception.filter';
import { AppModule } from './app.module';
import helmet from 'helmet';
import { join } from 'path';
import * as fs from 'fs';

const ALLOWED_ORIGINS = [
  'https://traclogistics.com.ng',
  'https://www.traclogistics.com.ng',
  'https://trac-logistics-web-app.vercel.app', // keep during transition
  'http://localhost:5173',
  'http://localhost:3000',
];

async function bootstrap() {
  const app = await NestFactory.create<NestExpressApplication>(AppModule, {
    rawBody: true,
    // Suppress stack traces in production logs
    logger: process.env.NODE_ENV === 'production'
      ? ['error', 'warn', 'log']
      : ['error', 'warn', 'log', 'debug', 'verbose'],
  });

  // ── Static file serving (before helmet so images aren't blocked) ──────────
  const uploadsDir = join(process.cwd(), 'uploads');
  if (!fs.existsSync(uploadsDir)) fs.mkdirSync(uploadsDir, { recursive: true });
  app.useStaticAssets(uploadsDir, { prefix: '/uploads' });

  // ── Security headers ───────────────────────────────────────────────────────
  app.use(helmet({
    crossOriginResourcePolicy: { policy: 'cross-origin' }, // allow images from frontend
    contentSecurityPolicy: false, // API — no HTML served
    hsts: { maxAge: 31536000, includeSubDomains: true },
  }));

  // ── CORS — only allow known origins ───────────────────────────────────────
  app.enableCors({
    origin: (origin, callback) => {
      // Allow requests with no origin (mobile apps, curl, Postman in dev)
      if (!origin || ALLOWED_ORIGINS.includes(origin)) {
        callback(null, true);
      } else {
        callback(new HttpException('Not allowed by CORS', HttpStatus.FORBIDDEN));
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

  // ── Request body size limit (prevent DoS) ─────────────────────────────────
  // Limit JSON payloads to 2MB; file uploads use multipart (handled per-route)
  app.use(require('express').json({ limit: '2mb' }));
  app.use(require('express').urlencoded({ extended: true, limit: '2mb' }));

  // ── Input validation — reject unknown fields ───────────────────────────────
  app.useGlobalPipes(new ValidationPipe({
    whitelist: true,
    forbidNonWhitelisted: true,   // reject requests with extra fields
    transform: true,
    disableErrorMessages: false,
  }));

  app.useGlobalFilters(new GlobalExceptionFilter());

  app.setGlobalPrefix('api');

  const port = process.env.PORT || 3001;
  await app.listen(port, '0.0.0.0');
  console.log(`🚀 Trac backend running on port ${port}`);
}

bootstrap();
