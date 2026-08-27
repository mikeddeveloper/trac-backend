import { IsEmail, IsIn, IsNotEmpty, IsOptional, IsString, MinLength } from 'class-validator';
import { Transform } from 'class-transformer';
import { UserRole } from '../../users/entities/user.entity';

export class SignupDto {
  @IsString()
  @IsNotEmpty()
  fullName: string;

  @IsEmail()
  @Transform(({ value }) => typeof value === 'string' ? value.trim().toLowerCase() : value)
  email: string;

  @IsString()
  @IsNotEmpty()
  phone: string;

  @IsString()
  @MinLength(8)
  password: string;

  @IsIn([UserRole.CUSTOMER, UserRole.TRANSPORTER, UserRole.ENTERPRISE], {
    message: 'role must be customer, transporter, or enterprise',
  })
  role: UserRole;

  @IsOptional()
  @IsString()
  state?: string;

  @IsOptional()
  @IsString()
  vehicleType?: string;

  @IsOptional()
  @IsString()
  licenseNumber?: string;

  @IsOptional()
  @IsString()
  companyName?: string;

  @IsOptional()
  @IsString()
  rcNumber?: string;
}
