import {Injectable,OnModuleInit} from '@nestjs/common';
import {InjectRepository} from '@nestjs/typeorm';
import {Repository} from 'typeorm';
import {WaitlistEntry} from './entities/waitlist-entry.entity';
import {JoinWaitlistDto} from './dto/join-waitlist.dto';

@Injectable()
export class WaitlistService implements OnModuleInit{
 constructor(@InjectRepository(WaitlistEntry) private repo:Repository<WaitlistEntry>){}

 async onModuleInit(){
  await this.repo.query(`
   CREATE TABLE IF NOT EXISTS waitlist_entries (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    email varchar NOT NULL UNIQUE,
    type varchar NOT NULL DEFAULT 'customer',
    "fullName" varchar,
    city varchar,
    "createdAt" timestamptz NOT NULL DEFAULT now()
   )
  `);
  await this.repo.query(`ALTER TABLE waitlist_entries ADD COLUMN IF NOT EXISTS type varchar NOT NULL DEFAULT 'customer'`);
 }

 // Someone resubmitting the same email (e.g. double-tapping the button) is
 // the normal case, not an error -- treat it as a successful join either way.
 async join(dto:JoinWaitlistDto):Promise<{joined:boolean;position:number}>{
  const existing=await this.repo.findOne({where:{email:dto.email}});
  if(!existing){
   await this.repo.save(this.repo.create({...dto,type:dto.type||'customer'}));
  }
  const position=await this.repo.count({where:{type:dto.type||'customer'}});
  return {joined:true,position};
 }

 async count():Promise<{total:number;customers:number;vendors:number}>{
  const [total,customers,vendors]=await Promise.all([
   this.repo.count(),
   this.repo.count({where:{type:'customer'}}),
   this.repo.count({where:{type:'vendor'}}),
  ]);
  return {total,customers,vendors};
 }
}
