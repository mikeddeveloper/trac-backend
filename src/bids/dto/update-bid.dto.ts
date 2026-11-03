import { Type } from 'class-transformer';
import { IsNumber, Min } from 'class-validator';

export class UpdateBidDto {
  @Type(() => Number)
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(1)
  amount!: number;
}
