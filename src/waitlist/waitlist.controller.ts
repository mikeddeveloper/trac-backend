import {Body,Controller,Get,Post} from '@nestjs/common';
import {WaitlistService} from './waitlist.service';
import {JoinWaitlistDto} from './dto/join-waitlist.dto';

// Public endpoints for the Trac Food waitlist landing page -- no auth,
// since visitors joining the waitlist aren't Trac accounts yet.
@Controller('waitlist')
export class WaitlistController{
 constructor(private waitlist:WaitlistService){}

 @Post('join')
 async join(@Body() dto:JoinWaitlistDto){
  return this.waitlist.join(dto);
 }

 @Get('count')
 async count(){
  return this.waitlist.count();
 }
}
