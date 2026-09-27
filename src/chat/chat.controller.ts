// trac-backend/src/chat/chat.controller.ts

import { Body, Controller, Get, Param, Patch, Post, Req, UseGuards } from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { ChatService } from './chat.service';

@Controller('jobs/:jobId/messages')
@UseGuards(AuthGuard('jwt'))
export class ChatController {
  constructor(private readonly chatService: ChatService) {}

  @Get()
  async list(@Param('jobId') jobId: string, @Req() req: any) {
    return this.chatService.listMessages(jobId, req.user.id);
  }

  @Post()
  async send(@Param('jobId') jobId: string, @Req() req: any, @Body() body: { body: string }) {
    return this.chatService.sendMessage(jobId, req.user.id, body.body);
  }

  @Patch('read')
  async read(@Param('jobId') jobId: string, @Req() req: any) {
    await this.chatService.markRead(jobId, req.user.id);
    return { ok: true };
  }
}
