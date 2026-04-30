// trac-backend/src/payments/entities/payment.entity.ts
// Updated: Added currency field for USD support

import {
  Entity, PrimaryGeneratedColumn, Column, CreateDateColumn,
  UpdateDateColumn, ManyToOne, JoinColumn,
} from 'typeorm';
import { User } from '../../users/entities/user.entity';
import { Job } from '../../jobs/entities/job.entity';

export enum PaymentStatus {
  PENDING  = 'pending',
  SUCCESS  = 'success',
  HELD     = 'held',
  RELEASED = 'released',
  REFUNDED = 'refunded',
  FAILED   = 'failed',
}

export enum PaymentType {
  ESCROW     = 'escrow',
  RELEASE    = 'release',
  REFUND     = 'refund',
  COMMISSION = 'commission',
}

@Entity('payments')
export class Payment {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ unique: true })
  reference!: string;

  @Column({ type: 'decimal', precision: 15, scale: 2 })
  amount!: number;

  // ── Currency — NGN or USD ──
  @Column({ default: 'NGN' })
  currency!: string;

  @Column({ type: 'enum', enum: PaymentStatus, default: PaymentStatus.PENDING })
  status!: PaymentStatus;

  @Column({ type: 'enum', enum: PaymentType, default: PaymentType.ESCROW })
  type!: PaymentType;

  @Column({ nullable: true })
  authorizationUrl!: string;

  @Column({ type: 'jsonb', nullable: true })
  paystackMeta!: Record<string, any>;

  @Column({ type: 'decimal', precision: 15, scale: 2, nullable: true })
  tracCommission!: number;

  @Column({ type: 'decimal', precision: 15, scale: 2, nullable: true })
  transporterPayout!: number;

  @Column({ type: 'decimal', precision: 15, scale: 2, nullable: true })
  customerCashback!: number;

  @Column({ type: 'decimal', precision: 15, scale: 2, nullable: true })
  vatAmount!: number;

  @ManyToOne(() => User, { eager: false, nullable: true })
  @JoinColumn({ name: 'customerId' })
  customer!: User;

  @Column({ nullable: true })
  customerId!: string;

  @ManyToOne(() => Job, { eager: false, nullable: true })
  @JoinColumn({ name: 'jobId' })
  job!: Job;

  @Column({ nullable: true })
  jobId!: string;

  @Column({ nullable: true })
  paidAt!: Date;

  @CreateDateColumn()
  createdAt!: Date;

  @UpdateDateColumn()
  updatedAt!: Date;
}
