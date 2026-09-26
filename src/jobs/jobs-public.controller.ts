// trac-backend/src/jobs/jobs-public.controller.ts
// Public tracking page -- deliberately no AuthGuard, since the person
// opening a shared tracking link (often the recipient) isn't a Trac user.

import { Controller, Get, Param, Res } from '@nestjs/common';
import type { Response } from 'express';
import { JobsService } from './jobs.service';

@Controller('jobs-public')
export class JobsPublicController {
  constructor(private readonly jobsService: JobsService) {}

  @Get(':id/track')
  async trackPublic(@Param('id') id: string, @Res() res: Response) {
    const html = await this.jobsService.getPublicTrackingHtml(id);
    res.set('Content-Type', 'text/html; charset=utf-8').send(html);
  }
}
