// trac-backend/src/push/entities/push-subscription.entity.ts
// Day 24: Push subscription entity

import { Entity, PrimaryGeneratedColumn, Column, CreateDateColumn } from 'typeorm';

@Entity('push_subscriptions')
export class PushSubscription {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column()
  userId: string;

  @Column({ unique: true })
  endpoint: string;

  @Column({ nullable: true })
  p256dh: string;

  @Column({ nullable: true })
  auth: string;

  @Column({ type: 'text', nullable: true })
  raw: string;

  @CreateDateColumn()
  createdAt: Date;
}