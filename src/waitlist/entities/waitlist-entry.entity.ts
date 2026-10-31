import {Column,CreateDateColumn,Entity,PrimaryGeneratedColumn,Unique} from 'typeorm';

@Entity('waitlist_entries')
@Unique(['email'])
export class WaitlistEntry{
 @PrimaryGeneratedColumn('uuid') id:string;
 @Column() email:string;
 @Column({default:'customer'}) type:'customer'|'vendor';
 @Column({nullable:true}) fullName:string;
 @Column({nullable:true}) city:string;
 @CreateDateColumn() createdAt:Date;
}
