import axios from 'axios';
import { UnauthorizedException } from '@nestjs/common';
import { PaymentsService } from './payments.service';

jest.mock('axios');
const mockedAxios = axios as jest.Mocked<typeof axios>;

describe('PaymentsService launch protections', () => {
  const job = {
    id: 'job-1',
    customerId: 'customer-1',
    acceptedAmount: 125000,
    distanceKm: 12,
  };
  const paymentRepo = {
    findOne: jest.fn(),
    create: jest.fn((value) => value),
    save: jest.fn(async (value) => value),
  };
  const jobRepo = { findOne: jest.fn() };
  const userRepo = {};
  const configService = {
    get: jest.fn((key: string) => ({
      PAYSTACK_SECRET_KEY: 'test-secret',
      FRONTEND_URL: 'https://trac.example',
    })[key]),
  };

  const service = new PaymentsService(
    configService as any,
    paymentRepo as any,
    jobRepo as any,
    userRepo as any,
    {} as any,
    {} as any,
    {} as any,
  );

  beforeEach(() => {
    jest.clearAllMocks();
    jobRepo.findOne.mockResolvedValue(job);
    paymentRepo.findOne.mockResolvedValue(null);
    mockedAxios.post.mockResolvedValue({
      data: { data: { authorization_url: 'https://checkout.example', access_code: 'access' } },
    });
  });

  it('charges the accepted bid amount loaded from the database', async () => {
    await service.initializePayment('customer@example.com', job.id, job.customerId);

    expect(mockedAxios.post).toHaveBeenCalledWith(
      expect.stringContaining('/transaction/initialize'),
      expect.objectContaining({ amount: 12_500_000 }),
      expect.any(Object),
    );
    expect(paymentRepo.create).toHaveBeenCalledWith(
      expect.objectContaining({ amount: 125000, customerId: job.customerId, jobId: job.id }),
    );
  });

  it('does not let another customer initialize payment for the job', async () => {
    await expect(service.initializePayment('attacker@example.com', job.id, 'customer-2'))
      .rejects.toBeInstanceOf(UnauthorizedException);
    expect(mockedAxios.post).not.toHaveBeenCalled();
  });
});
