// trac-backend/src/ratings/entities/rating.entity.ts
// Day 17: Rating entity

import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  ManyToOne,
  JoinColumn,
} from 'typeorm';
import { User } from '../../users/entities/user.entity';
import { Job } from '../../jobs/entities/job.entity';

export enum RatingRole {
  CUSTOMER_TO_TRANSPORTER = 'customer_to_transporter',
  TRANSPORTER_TO_CUSTOMER = 'transporter_to_customer',
}

@Entity('ratings')
export class Rating {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'int' })
  stars: number; // 1–5

  @Column({ nullable: true })
  comment: string;

  @Column({ type: 'enum', enum: RatingRole })
  type: RatingRole;

  // Who gave the rating
  @ManyToOne(() => User, { eager: true })
  @JoinColumn({ name: 'fromUserId' })
  fromUser: User;

  @Column()
  fromUserId: string;

  // Who received the rating
  @ManyToOne(() => User, { eager: true })
  @JoinColumn({ name: 'toUserId' })
  toUser: User;

  @Column()
  toUserId: string;

  // Which job this rating is for
  @ManyToOne(() => Job, { eager: false })
  @JoinColumn({ name: 'jobId' })
  job: Job;

  @Column()
  jobId: string;

  @CreateDateColumn()
  createdAt: Date;
}