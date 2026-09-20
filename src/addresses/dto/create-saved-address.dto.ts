import { Transform } from 'class-transformer';
import { IsBoolean, IsOptional, IsString, MaxLength, MinLength } from 'class-validator';

export class CreateSavedAddressDto {
  @IsString()
  @MinLength(2)
  @MaxLength(40)
  @Transform(({ value }) => typeof value === 'string' ? value.trim() : value)
  label: string;

  @IsString()
  @MinLength(5)
  @MaxLength(300)
  @Transform(({ value }) => typeof value === 'string' ? value.trim() : value)
  address: string;

  @IsOptional()
  @IsString()
  @MaxLength(100)
  @Transform(({ value }) => typeof value === 'string' ? value.trim() : value)
  recipientName?: string;

  @IsOptional()
  @IsString()
  @MaxLength(20)
  @Transform(({ value }) => typeof value === 'string' ? value.trim() : value)
  recipientPhone?: string;

  @IsOptional()
  @IsBoolean()
  isDefault?: boolean;
}
