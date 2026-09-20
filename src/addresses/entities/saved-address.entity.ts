import { Entity, PrimaryGeneratedColumn, Column, CreateDateColumn } from 'typeorm';

@Entity('saved_addresses')
export class SavedAddress {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column()
  userId: string;

  @Column()
  label: string;

  @Column()
  address: string;

  @Column({ nullable: true })
  recipientName: string;

  @Column({ nullable: true })
  recipientPhone: string;

  @Column({ default: false })
  isDefault: boolean;

  @CreateDateColumn()
  createdAt: Date;
}
