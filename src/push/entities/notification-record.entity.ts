import {Column,CreateDateColumn,Entity,PrimaryGeneratedColumn} from 'typeorm';

@Entity('notification_records')
export class NotificationRecord{
 @PrimaryGeneratedColumn('uuid') id:string;
 @Column() userId:string;
 @Column() title:string;
 @Column({type:'text'}) body:string;
 @Column({nullable:true}) url:string;
 @Column({nullable:true}) tag:string;
 @Column({type:'jsonb',nullable:true}) data:any;
 @Column({default:false}) read:boolean;
 @CreateDateColumn() createdAt:Date;
}
