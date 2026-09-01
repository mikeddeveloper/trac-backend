import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  UpdateDateColumn,
} from 'typeorm';
import { Exclude } from 'class-transformer';

export enum UserRole {
  CUSTOMER = 'customer',
  TRANSPORTER = 'transporter',
  ENTERPRISE = 'enterprise',
  ADMIN = 'admin',
}

@Entity('users')
export class User {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column()
  fullName!: string;

  @Column({ unique: true })
  email!: string;

  @Column({ nullable: true })
  phone!: string;

  @Column({ select: false, nullable: true })
  password!: string;

  @Column({ nullable: true })
  googleId!: string;

  @Column({ type: 'enum', enum: UserRole, default: UserRole.CUSTOMER })
  role!: UserRole;

  @Column({ default: false })
  isVerified!: boolean;

  @Column({ default: false })
  emailVerified!: boolean;

  @Column({ nullable: true })
  @Exclude()
  emailOtp!: string;

  @Column({ type: 'timestamp', nullable: true })
  @Exclude()
  emailOtpExpiry!: Date;

  @Column({ nullable: true })
  state!: string;

  @Column({ nullable: true })
  vehicleType!: string;

  @Column({ nullable: true })
  licenseNumber!: string;

  @Column({ nullable: true })
  licenseExpiry!: string;

  @Column({ nullable: true, default: 'pending' })
  licenseStatus!: string;

  @Column({ type: 'timestamp', nullable: true })
  licenseSubmittedAt!: Date;

  @Column({ nullable: true })
  licensePhotoUrl!: string;

  @Column({ nullable: true })
  companyName!: string;

  @Column({ nullable: true })
  rcNumber!: string;

  @Column({ nullable: true })
  avatarUrl!: string;

  @Column({ nullable: true })
  bio!: string;

  @Column({ type: 'decimal', precision: 10, scale: 2, default: 0 })
  rating!: number;

  @Column({ default: 0 })
  totalRatings!: number;

  @Column({ default: 0 })
  tripsCompleted!: number;

  @Column({ nullable: true })
  @Exclude()
  refreshToken!: string;

  @Column({ default: 0 })
  @Exclude()
  sessionVersion!: number;

  @Column({ nullable: true })
  @Exclude()
  passwordResetToken!: string;

  @Column({ type: 'timestamp', nullable: true })
  @Exclude()
  passwordResetExpiry!: Date;

  // ─── Account status ────────────────────────────────────────────────────────
  @Column({ default: false })
  isSuspended!: boolean;

  // ─── KYC ──────────────────────────────────────────────────────────────────
  @Column({ default: false })
  ninVerified!: boolean;

  @Column({ default: false })
  licenseVerified!: boolean;

  @Column({ nullable: true })
  kycStatus!: string;

  @Column({ default: 0 })
  kycTier!: number;

  @Column({ nullable: true, type: 'timestamp' })
  kycCompletedAt!: Date;

  @Column({ nullable: true })
  vehiclePlate!: string;

  @Column({ nullable: true })
  vehicleYear!: string;

  // ─── Bank account ──────────────────────────────────────────────────────────
  @Column({ nullable: true })
  bankName!: string;

  @Column({ nullable: true })
  accountNumber!: string;

  @Column({ nullable: true })
  accountName!: string;

  @Column({ nullable: true })
  recipientCode!: string; // Paystack transfer recipient code for auto-payouts

  @CreateDateColumn()
  createdAt!: Date;

  @UpdateDateColumn()
  updatedAt!: Date;
}
