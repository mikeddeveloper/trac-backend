import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { CreateBidDto } from './create-bid.dto';

describe('CreateBidDto', () => {
  it.each(['', 'not-a-uuid', null])('rejects invalid jobId %p before persistence', async jobId => {
    const dto = plainToInstance(CreateBidDto, { jobId, amount: 100 });
    const errors = await validate(dto);
    expect(errors.some(error => error.property === 'jobId')).toBe(true);
  });

  it('accepts a UUID v4 jobId', async () => {
    const dto = plainToInstance(CreateBidDto, {
      jobId: '123e4567-e89b-42d3-a456-426614174000', amount: 100,
    });
    await expect(validate(dto)).resolves.toHaveLength(0);
  });
});
