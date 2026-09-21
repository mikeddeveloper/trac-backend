import { Transform } from 'class-transformer';
import { IsIn, IsString, MaxLength, MinLength } from 'class-validator';

export class CreateSupportTicketDto {
  @IsIn(['Delivery', 'Payment', 'Account'])
  topic: string;

  @IsString()
  @MinLength(10)
  @MaxLength(500)
  @Transform(({ value }) => typeof value === 'string' ? value.trim() : value)
  message: string;
}
