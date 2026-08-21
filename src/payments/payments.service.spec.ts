import axios from 'axios';
import { BadRequestException, UnauthorizedException } from '@nestjs/common';
import { JobStatus } from '../jobs/entities/job.entity';
import { PaymentsService } from './payments.service';

jest.mock('axios');
const mockedAxios = axios as jest.Mocked<typeof axios>;

describe('PaymentsService launch protections', () => {
  const job = {
    id: 'job-1',
    customerId: 'customer-1',
    transporterId: 'transporter-1',
    acceptedAmount: 125000,
    distanceKm: 12,
    status: JobStatus.BID_SELECTED,
  };
  const paymentRepo = {
    findOne: jest.fn(),
    create: jest.fn((value) => value),
    save: jest.fn(async (value) => value),
    update: jest.fn().mockResolvedValue({ affected: 1 }),
  };
  const jobRepo = { findOne: jest.fn(), update: jest.fn().mockResolvedValue({ affected: 1 }) };
  const userRepo = { findOne: jest.fn() };
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
    { notifyUser: jest.fn() } as any,
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

  it('does not initialize payment until a bid has been selected', async () => {
    jobRepo.findOne.mockResolvedValueOnce({ ...job, status: JobStatus.BIDDING });
    await expect(service.initializePayment('customer@example.com', job.id, job.customerId))
      .rejects.toBeInstanceOf(BadRequestException);
    expect(mockedAxios.post).not.toHaveBeenCalled();
  });

  it('checks the Paystack balance and records a payout before initiating transfer', async () => {
    const escrowPayment = {
      id: 'payment-1',
      jobId: job.id,
      customerId: job.customerId,
      amount: 125000,
      transporterPayout: 112500,
      tracCommission: 12500,
      status: 'released',
      type: 'escrow',
    };
    paymentRepo.findOne
      .mockResolvedValueOnce(escrowPayment)
      .mockResolvedValueOnce(null);
    userRepo.findOne.mockResolvedValue({ id: job.transporterId, recipientCode: 'RCP_test' });
    mockedAxios.get.mockResolvedValue({ data: { data: [{ currency: 'NGN', balance: 20_000_000 }] } });
    mockedAxios.post.mockResolvedValue({ data: { status: true, data: { status: 'pending' } } });

    await service.withdrawEarnings(job.id, job.transporterId);

    expect(mockedAxios.get).toHaveBeenCalledWith(
      expect.stringContaining('/balance'),
      expect.any(Object),
    );
    expect(mockedAxios.post).toHaveBeenCalledWith(
      expect.stringContaining('/transfer'),
      expect.objectContaining({ source: 'balance', amount: 11_250_000, recipient: 'RCP_test' }),
      expect.any(Object),
    );
    expect(paymentRepo.save.mock.invocationCallOrder[0])
      .toBeLessThan(mockedAxios.post.mock.invocationCallOrder[0]);
  });
});
