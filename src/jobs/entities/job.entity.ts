// trac-backend/src/jobs/entities/job.entity.ts
// Day 16: Added proofOfDeliveryUrl + proofUploadedAt columns

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

export enum JobStatus {
  PENDING    = 'pending',
  BIDDING    = 'bidding',
  ACCEPTED   = 'accepted',
  IN_TRANSIT = 'in-transit',
  DELIVERED  = 'delivered',
  CANCELLED  = 'cancelled',
}

@Entity('jobs')
export class Job {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column()
  pickupAddress: string;

  @Column()
  pickupState: string;

  @Column()
  deliveryAddress: string;

  @Column()
  deliveryState: string;

  @Column()
  cargoDescription: string;

  @Column({ type: 'decimal', precision: 10, scale: 2 })
  cargoWeight: number;

  @Column({ type: 'decimal', precision: 15, scale: 2 })
  cargoValue: number;

  @Column()
  vehicleType: string;

  @Column({ type: 'timestamp' })
  deadline: Date;

  @Column({ nullable: true })
  specialInstructions: string;

  @Column({ default: 'basic' })
  insurance: string;

  @Column({ type: 'enum', enum: JobStatus, default: JobStatus.BIDDING })
  status: JobStatus;

  @Column({ nullable: true, type: 'decimal', precision: 15, scale: 2 })
  acceptedAmount: number;

  // ─── Day 15: Status timestamps ────────────────────────────────────────────
  @Column({ nullable: true, type: 'timestamp' })
  pickedUpAt: Date;

  @Column({ nullable: true, type: 'timestamp' })
  deliveredAt: Date;

  // ─── Day 16: Proof of Delivery ────────────────────────────────────────────
  @Column({ nullable: true })
  proofOfDeliveryUrl: string;

  @Column({ nullable: true, type: 'timestamp' })
  proofUploadedAt: Date;

  // ─── Goods Declaration ────────────────────────────────────────────────────
  @Column({ nullable: true })
  goodsCategory: string;

  @Column({ default: false })
  goodsDeclared: boolean;

  @Column({ default: false })
  disclaimerAccepted: boolean;

  @Column({ nullable: true, type: 'timestamp' })
  disclaimerAcceptedAt: Date;

  // ─── Relations ────────────────────────────────────────────────────────────
  @ManyToOne(() => User, { eager: true })
  @JoinColumn({ name: 'customerId' })
  customer: User;

  @Column()
  customerId: string;

  @ManyToOne(() => User, { nullable: true, eager: true })
  @JoinColumn({ name: 'transporterId' })
  transporter: User;

  @Column({ nullable: true })
  transporterId: string;

  @CreateDateColumn()
  createdAt: Date;

  @UpdateDateColumn()
  updatedAt: Date;
}