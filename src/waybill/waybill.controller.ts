// trac-backend/src/waybill/waybill.controller.ts

import { Controller, Get, Param, Req, Res, UseGuards } from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import type { Response } from 'express';
import { WaybillService } from './waybill.service';

@Controller('waybill')
@UseGuards(AuthGuard('jwt'))
export class WaybillController {
  constructor(private readonly waybillService: WaybillService) {}

  @Get(':jobId')
  async downloadWaybill(@Param('jobId') jobId: string, @Req() req: any, @Res() res: Response) {
    const pdfBuffer = await this.waybillService.generateWaybill(jobId, req.user.id, req.user.role);
    res.set({
      'Content-Type': 'application/pdf',
      'Content-Disposition': `attachment; filename="trac-waybill-${jobId.slice(0, 8).toUpperCase()}.pdf"`,
      'Content-Length': pdfBuffer.length,
    });
    res.end(pdfBuffer);
  }
}
