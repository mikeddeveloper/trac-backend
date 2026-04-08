// trac-backend/src/disputes/entities/dispute.entity.ts
// Day 18: Dispute entity

import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  UpdateDateColumn,
  ManyToOne,
  JoinColumn,
} from 'typeorm';
import { User } from '../../users/entities/user.entity';
import { Job } from '../../jobs/entities/job.entity';

export enum DisputeStatus {
  OPEN       = 'open',
  REVIEWING  = 'reviewing',
  RESOLVED   = 'resolved',
  CLOSED     = 'closed',
}

export enum DisputeReason {
  WRONG_CARGO       = 'wrong_cargo',
  DAMAGED_CARGO     = 'damaged_cargo',
  NON_DELIVERY      = 'non_delivery',
  LATE_DELIVERY     = 'late_delivery',
  PAYMENT_ISSUE     = 'payment_issue',
  TRANSPORTER_ISSUE = 'transporter_issue',
  OTHER             = 'other',
}

@Entity('disputes')
export class Dispute {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'enum', enum: DisputeReason })
  reason: DisputeReason;

  @Column({ type: 'text' })
  description: string;

  @Column({ type: 'enum', enum: DisputeStatus, default: DisputeStatus.OPEN })
  status: DisputeStatus;

  // Evidence — array of image URLs
  @Column({ type: 'jsonb', nullable: true, default: [] })
  evidence: string[];

  // Admin resolution note
  @Column({ type: 'text', nullable: true })
  resolutionNote: string;

  // Who raised the dispute
  @ManyToOne(() => User, { eager: true })
  @JoinColumn({ name: 'raisedById' })
  raisedBy: User;

  @Column()
  raisedById: string;

  // Which job the dispute is about
  @ManyToOne(() => Job, { eager: false })
  @JoinColumn({ name: 'jobId' })
  job: Job;

  @Column()
  jobId: string;

  @Column({ nullable: true })
  resolvedAt: Date;

  @CreateDateColumn()
  createdAt: Date;

  @UpdateDateColumn()
  updatedAt: Date;
}