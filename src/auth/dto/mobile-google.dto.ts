import { IsIn, IsOptional, IsString, Matches } from 'class-validator';
import { UserRole } from '../../users/entities/user.entity';

export class MobileGoogleDto {
  @IsString()
  idToken!: string;

  @IsOptional()
  @IsIn([UserRole.CUSTOMER, UserRole.TRANSPORTER])
  role?: UserRole;

  @IsOptional()
  @IsString()
  @Matches(/^\+234\d{10}$/, {
    message: 'phone must be a valid Nigerian number in +234 format',
  })
  phone?: string;
}
