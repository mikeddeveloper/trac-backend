import {IsEmail,IsIn,IsOptional,IsString,MaxLength} from 'class-validator';
import {Transform} from 'class-transformer';

export class JoinWaitlistDto{
 @IsEmail()
 @Transform(({value})=>typeof value==='string'?value.trim().toLowerCase():value)
 email:string;

 @IsOptional()
 @IsIn(['customer','vendor'])
 type?:'customer'|'vendor';

 @IsOptional()
 @IsString()
 @MaxLength(120)
 fullName?:string;

 @IsOptional()
 @IsString()
 @MaxLength(80)
 city?:string;
}
