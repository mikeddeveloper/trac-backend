// trac-backend/src/chat/chat.service.ts
// In-app text chat between a job's customer and transporter.
//
// Deliberately text-only (no attachments/images) and filters out phone
// numbers, emails and messaging-app handles before a message is stored —
// this keeps customers and transporters coordinating inside Trac instead of
// moving off-platform, which is the whole point of the feature.

import { Injectable, Logger, BadRequestException, ForbiddenException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Job, JobStatus } from '../jobs/entities/job.entity';
import { JobsService } from '../jobs/jobs.service';
import { EventsGateway } from '../events/events.gateway';
import { PushService } from '../push/push.service';

export type ChatMessage = {
  id: string;
  jobId: string;
  senderId: string;
  senderRole: 'customer' | 'transporter';
  body: string;
  createdAt: string;
};

const CHAT_ALLOWED_STATUSES = new Set([JobStatus.ACCEPTED, JobStatus.IN_TRANSIT]);

// Best-effort contact-info detector, not a perfect one — catches the
// overwhelming majority of real attempts (typed phone numbers in any common
// separator style, emails, and WhatsApp/Telegram links or handles), which is
// the same class of filter other delivery platforms rely on for this.
const PHONE_PATTERN = /(\+?\d[\d\s\-().]{6,}\d)/;
const EMAIL_PATTERN = /[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/i;
const CONTACT_APP_PATTERN = /\b(whatsapp|wa\.me|telegram|t\.me|instagram|@[a-z0-9_]{3,})\b/i;

function containsContactInfo(body: string): boolean {
  const digitsOnly = body.replace(/[^\d]/g, '');
  if (digitsOnly.length >= 7 && PHONE_PATTERN.test(body)) return true;
  if (EMAIL_PATTERN.test(body)) return true;
  if (CONTACT_APP_PATTERN.test(body)) return true;
  return false;
}

@Injectable()
export class ChatService {
  private readonly logger = new Logger(ChatService.name);

  constructor(
    @InjectRepository(Job) private jobRepo: Repository<Job>,
    private jobsService: JobsService,
    private eventsGateway: EventsGateway,
    private pushService: PushService,
  ) {}

  private async ensureTable(): Promise<void> {
    await this.jobRepo.query(`
      CREATE TABLE IF NOT EXISTS job_messages (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        "jobId" uuid NOT NULL,
        "senderId" uuid NOT NULL,
        "senderRole" varchar(12) NOT NULL,
        "body" text NOT NULL,
        "createdAt" timestamptz NOT NULL DEFAULT now()
      )
    `);
    await this.jobRepo.query('CREATE INDEX IF NOT EXISTS "IDX_job_messages_job_created" ON job_messages ("jobId", "createdAt")');
  }

  private async partyRole(jobId: string, userId: string): Promise<{ job: Job; role: 'customer' | 'transporter' }> {
    const job = await this.jobsService.findById(jobId);
    if (job.customerId === userId) return { job, role: 'customer' };
    if (job.transporterId === userId) return { job, role: 'transporter' };
    throw new ForbiddenException('You are not a party to this job');
  }

  // For admin moderation/dispute review only — bypasses the party check since
  // an admin isn't the customer or transporter on the job.
  async listMessagesForAdmin(jobId: string): Promise<ChatMessage[]> {
    await this.ensureTable();
    await this.jobsService.findById(jobId);
    return this.jobRepo.query(
      'SELECT * FROM job_messages WHERE "jobId" = $1 ORDER BY "createdAt" ASC LIMIT 200',
      [jobId],
    );
  }

  async listMessages(jobId: string, userId: string): Promise<ChatMessage[]> {
    await this.ensureTable();
    await this.partyRole(jobId, userId);
    return this.jobRepo.query(
      'SELECT * FROM job_messages WHERE "jobId" = $1 ORDER BY "createdAt" ASC LIMIT 200',
      [jobId],
    );
  }

  async sendMessage(jobId: string, userId: string, rawBody: string): Promise<ChatMessage> {
    await this.ensureTable();
    const { job, role } = await this.partyRole(jobId, userId);
    if (!CHAT_ALLOWED_STATUSES.has(job.status)) {
      throw new BadRequestException('Chat is only available once a transporter has been accepted for this job');
    }
    const body = String(rawBody || '').trim();
    if (!body) throw new BadRequestException('Message cannot be empty');
    if (body.length > 500) throw new BadRequestException('Message is too long');
    if (containsContactInfo(body)) {
      throw new BadRequestException('For everyone\'s safety, phone numbers and other contact details can\'t be shared in chat. Please keep communication inside Trac.');
    }

    const rows = await this.jobRepo.query(
      `INSERT INTO job_messages ("jobId","senderId","senderRole","body") VALUES ($1,$2,$3,$4) RETURNING *`,
      [jobId, userId, role, body],
    );
    const message: ChatMessage = rows[0];

    const recipientId = role === 'customer' ? job.transporterId : job.customerId;
    if (recipientId) {
      this.eventsGateway.notifyUser(recipientId, `chat:message:${jobId}`, message);
      this.pushService.sendToUser(recipientId, {
        title: '💬 New message',
        body: body.length > 80 ? `${body.slice(0, 77)}...` : body,
        url: '/dashboard/tracking',
        tag: 'chat-message',
        data: { jobId },
      }).catch(() => {});
    }

    return message;
  }
}
