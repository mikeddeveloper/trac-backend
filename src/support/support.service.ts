import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { SupportTicket } from './entities/support-ticket.entity';
import { CreateSupportTicketDto } from './dto/create-support-ticket.dto';
import { EmailService } from '../email/email.service';

@Injectable()
export class SupportService implements OnModuleInit {
  private readonly logger = new Logger(SupportService.name);

  constructor(
    @InjectRepository(SupportTicket) private ticketRepo: Repository<SupportTicket>,
    private emailService: EmailService,
  ) {}

  async onModuleInit() {
    await this.ticketRepo.query(`
      CREATE TABLE IF NOT EXISTS support_tickets (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        "userId" varchar NOT NULL,
        topic varchar NOT NULL,
        message text NOT NULL,
        status varchar NOT NULL DEFAULT 'open',
        "createdAt" timestamptz NOT NULL DEFAULT now()
      )
    `);
    await this.ticketRepo.query('CREATE INDEX IF NOT EXISTS "IDX_support_tickets_user_created" ON support_tickets ("userId", "createdAt" DESC)');
  }

  async list(userId: string) {
    return this.ticketRepo.find({ where: { userId }, order: { createdAt: 'DESC' } });
  }

  async create(userId: string, user: { fullName: string; email: string }, input: CreateSupportTicketDto) {
    const ticket = this.ticketRepo.create({ userId, topic: input.topic, message: input.message });
    const saved = await this.ticketRepo.save(ticket);
    this.logger.log(`🎫 Support ticket ${saved.id} opened by ${userId} (${input.topic})`);
    await this.emailService.sendSupportTicketEmail({
      ticketId: saved.id,
      userName: user.fullName,
      userEmail: user.email,
      topic: input.topic,
      message: input.message,
    }).catch(() => {});
    return saved;
  }
}
