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
  BID_SELECTED = 'bid-selected',
  PAYMENT_PENDING = 'payment-pending',
  ACCEPTED   = 'accepted',
  IN_TRANSIT = 'in-transit',
  DELIVERED  = 'delivered',
  CANCELLED  = 'cancelled',
}

@Entity('jobs')
export class Job {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column()
  pickupAddress!: string;

  @Column()
  pickupState!: string;

  @Column()
  deliveryAddress!: string;

  @Column()
  deliveryState!: string;

  @Column({ nullable: true })
  pickupNote!: string;

  @Column({ nullable: true })
  deliveryNote!: string;

  @Column({ nullable: true })
  recipientName!: string;

  @Column({ nullable: true })
  recipientPhone!: string;

  @Column({ nullable: true, type: 'double precision' })
  pickupLat!: number;

  @Column({ nullable: true, type: 'double precision' })
  pickupLng!: number;

  @Column({ nullable: true, type: 'double precision' })
  deliveryLat!: number;

  @Column({ nullable: true, type: 'double precision' })
  deliveryLng!: number;

  @Column()
  cargoDescription!: string;

  @Column({ type: 'decimal', precision: 10, scale: 2 })
  cargoWeight!: number;

  @Column({ type: 'decimal', precision: 15, scale: 2 })
  cargoValue!: number;

  @Column()
  vehicleType!: string;

  @Column({ type: 'timestamp' })
  deadline!: Date;

  @Column({ nullable: true })
  specialInstructions!: string;

  @Column({ default: 'basic' })
  insurance!: string;

  @Column({ type: 'enum', enum: JobStatus, default: JobStatus.BIDDING })
  status!: JobStatus;

  @Column({ nullable: true, type: 'decimal', precision: 15, scale: 2 })
  acceptedAmount!: number;

  @Column({ nullable: true, type: 'decimal', precision: 10, scale: 2 })
  distanceKm!: number;

  // ─── Day 15: Status timestamps ────────────────────────────────────────────
  @Column({ nullable: true, type: 'timestamp' })
  pickedUpAt!: Date;

  @Column({ nullable: true, type: 'timestamp' })
  deliveredAt!: Date;

  // ─── Day 16: Proof of Delivery ────────────────────────────────────────────
  @Column({ nullable: true })
  proofOfDeliveryUrl!: string;

  @Column({ nullable: true, type: 'timestamp' })
  proofUploadedAt!: Date;

  // ─── Delivery OTP ─────────────────────────────────────────────────────────
  @Column({ nullable: true })
  deliveryOtp!: string;

  @Column({ nullable: true, type: 'timestamp' })
  otpGeneratedAt!: Date;

  @Column({ default: false })
  otpVerified!: boolean;

  // ─── Customer Confirmation & Dispute ─────────────────────────────────────
  @Column({ default: false })
  customerConfirmed!: boolean;

  @Column({ nullable: true, type: 'timestamp' })
  customerConfirmedAt!: Date;

  @Column({ default: false })
  disputeRaised!: boolean;

  @Column({ nullable: true })
  disputeReason!: string;

  @Column({ nullable: true, type: 'timestamp' })
  disputeRaisedAt!: Date;

  // ─── Goods Declaration ────────────────────────────────────────────────────
  @Column({ nullable: true })
  goodsCategory!: string;

  @Column({ default: false })
  goodsDeclared!: boolean;

  @Column({ default: false })
  disclaimerAccepted!: boolean;

  @Column({ nullable: true, type: 'timestamp' })
  disclaimerAcceptedAt!: Date;

  // ─── Relations ────────────────────────────────────────────────────────────
  @ManyToOne(() => User, { eager: true })
  @JoinColumn({ name: 'customerId' })
  customer!: User;

  @Column()
  customerId!: string;

  @ManyToOne(() => User, { nullable: true, eager: true })
  @JoinColumn({ name: 'transporterId' })
  transporter!: User;

  @Column({ nullable: true })
  transporterId!: string;

  @Column({ nullable: true, type: 'double precision' })
  lastKnownLat!: number;

  @Column({ nullable: true, type: 'double precision' })
  lastKnownLng!: number;

  @Column({ nullable: true, type: 'double precision' })
  lastLocationAccuracy!: number;

  @Column({ nullable: true, type: 'double precision' })
  lastLocationSpeed!: number;

  @Column({ nullable: true, type: 'timestamp' })
  lastLocationAt!: Date;

  @CreateDateColumn()
  createdAt!: Date;

  @UpdateDateColumn()
  updatedAt!: Date;
}
