import { Body, Controller, Get, Post, Req, UseGuards } from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { SupportService } from './support.service';
import { CreateSupportTicketDto } from './dto/create-support-ticket.dto';

@Controller('support')
@UseGuards(AuthGuard('jwt'))
export class SupportController {
  constructor(private readonly supportService: SupportService) {}

  @Post()
  create(@Req() req: any, @Body() body: CreateSupportTicketDto) {
    return this.supportService.create(req.user.id, { fullName: req.user.fullName, email: req.user.email }, body);
  }

  @Get()
  list(@Req() req: any) {
    return this.supportService.list(req.user.id);
  }
}
