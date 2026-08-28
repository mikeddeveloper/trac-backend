import axios from 'axios';
import { BadRequestException, UnauthorizedException } from '@nestjs/common';
import { JobStatus } from '../jobs/entities/job.entity';
import { PaymentsService } from './payments.service';
import { PaymentStatus, PaymentType } from './entities/payment.entity';

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
    manager: { findOne: jest.fn().mockResolvedValue(null) },
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
    { sendToUser: jest.fn().mockResolvedValue(undefined) } as any,
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

  it('uses the fixed 10% default commission for every route distance', () => {
    expect(service.calculatePayout(150, 100).tracCommission).toBe(15);
    expect(service.calculatePayout(150, 100).transporterPayout).toBe(135);
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

  it('checks the Paystack balance and records a payout after admin approval', async () => {
    const escrowPayment = {
      id: 'payment-1',
      jobId: job.id,
      customerId: job.customerId,
      amount: 125000,
      transporterPayout: 115625,
      tracCommission: 9375,
      status: PaymentStatus.HELD,
      type: 'escrow',
    };
    paymentRepo.findOne
      .mockResolvedValueOnce(escrowPayment)
      .mockResolvedValueOnce(null);
    userRepo.findOne.mockResolvedValue({ id: job.transporterId, recipientCode: 'RCP_test' });
    mockedAxios.get.mockResolvedValue({ data: { data: [{ currency: 'NGN', balance: 20_000_000 }] } });
    mockedAxios.post.mockResolvedValue({ data: { status: true, data: { status: 'pending' } } });

    await service.approveWithdrawal(job.id, job.transporterId);

    expect(mockedAxios.get).toHaveBeenCalledWith(
      expect.stringContaining('/balance'),
      expect.any(Object),
    );
    expect(mockedAxios.post).toHaveBeenCalledWith(
      expect.stringContaining('/transfer'),
      expect.objectContaining({
        source: 'balance',
        amount: 11_250_000,
        recipient: 'RCP_test',
        reference: 'trac_payout_job1',
      }),
      expect.any(Object),
    );
    expect(paymentRepo.update).toHaveBeenCalledWith(
      { id: escrowPayment.id, status: PaymentStatus.HELD },
      expect.objectContaining({
        status: PaymentStatus.RELEASED,
        tracCommission: 12500,
        transporterPayout: 112500,
      }),
    );
    expect(paymentRepo.save.mock.invocationCallOrder[0])
      .toBeLessThan(mockedAxios.post.mock.invocationCallOrder[0]);
  });

  it('does not create another transfer while a payout is already pending', async () => {
    const escrowPayment = {
      id: 'payment-1', jobId: job.id, customerId: job.customerId,
      amount: 125000, status: PaymentStatus.HELD, type: PaymentType.ESCROW,
    };
    paymentRepo.findOne
      .mockResolvedValueOnce(escrowPayment)
      .mockResolvedValueOnce({
        id: 'release-1', jobId: job.id,
        reference: 'trac_payout_job1',
        status: PaymentStatus.PENDING,
        type: PaymentType.RELEASE,
      });
    userRepo.findOne.mockResolvedValue({ id: job.transporterId, recipientCode: 'RCP_test' });

    await expect(service.approveWithdrawal(job.id, job.transporterId))
      .rejects.toThrow('already been initiated');
    expect(mockedAxios.post).not.toHaveBeenCalled();
  });

  it('verifies a signed charge with Paystack and repairs the paid job on replay', async () => {
    const payment = {
      id: 'payment-1', reference: 'TRAC-job-1-test', jobId: job.id,
      customerId: job.customerId, amount: 125000, currency: 'NGN',
      status: PaymentStatus.SUCCESS, type: PaymentType.ESCROW,
    };
    paymentRepo.findOne.mockResolvedValueOnce(payment);
    jobRepo.findOne.mockResolvedValueOnce({
      ...job,
      status: JobStatus.PAYMENT_PENDING,
      transporterId: job.transporterId,
    });
    mockedAxios.get.mockResolvedValueOnce({ data: { data: {
      reference: payment.reference,
      amount: 12_500_000,
      currency: 'NGN',
      status: 'success',
      paid_at: new Date().toISOString(),
      metadata: { jobId: job.id, customerId: job.customerId },
    } } });

    await (service as any).handleChargeSuccess({ reference: payment.reference });

    expect(mockedAxios.get).toHaveBeenCalledWith(
      expect.stringContaining(`/transaction/verify/${payment.reference}`),
      expect.any(Object),
    );
    expect(jobRepo.update).toHaveBeenCalledWith(job.id, { status: JobStatus.ACCEPTED });
  });

  it('records a transporter withdrawal request without calling Paystack', async () => {
    const escrowPayment = {
      id: 'payment-1', jobId: job.id, customerId: job.customerId,
      amount: 125000, transporterPayout: 112500,
      status: PaymentStatus.SUCCESS, type: PaymentType.ESCROW,
    };
    paymentRepo.findOne.mockResolvedValueOnce(escrowPayment);
    jobRepo.findOne.mockResolvedValueOnce({
      ...job, status: JobStatus.DELIVERED, otpVerified: true,
      customerConfirmed: true, proofOfDeliveryUrl: 'https://proof.example/photo.jpg',
    });
    userRepo.findOne.mockResolvedValueOnce({ id: job.transporterId, recipientCode: 'RCP_test' });

    const result = await service.withdrawEarnings(job.id, job.transporterId);

    expect(paymentRepo.update).toHaveBeenCalledWith(
      { id: escrowPayment.id, status: PaymentStatus.SUCCESS },
      { status: PaymentStatus.HELD },
    );
    expect(mockedAxios.post).not.toHaveBeenCalled();
    expect(result.message).toContain('admin');
  });

  it('submits a full refund to Paystack without marking escrow refunded prematurely', async () => {
    const escrowPayment = {
      id: 'payment-1',
      reference: 'TRAC-job-1-123',
      jobId: job.id,
      customerId: job.customerId,
      amount: 125000,
      currency: 'NGN',
      status: PaymentStatus.HELD,
      type: PaymentType.ESCROW,
    };
    paymentRepo.findOne
      .mockResolvedValueOnce(escrowPayment)
      .mockResolvedValueOnce(null);
    mockedAxios.post.mockResolvedValue({
      data: { status: true, message: 'Refund queued', data: { id: 99, status: 'pending' } },
    });

    const result = await service.initiateRefund(escrowPayment.id);

    expect(mockedAxios.post).toHaveBeenCalledWith(
      expect.stringContaining('/refund'),
      expect.objectContaining({ transaction: escrowPayment.reference }),
      expect.any(Object),
    );
    expect(paymentRepo.save).toHaveBeenCalledWith(expect.objectContaining({
      type: PaymentType.REFUND,
      status: PaymentStatus.PENDING,
      jobId: job.id,
    }));
    expect(paymentRepo.update).not.toHaveBeenCalledWith(
      escrowPayment.id,
      expect.objectContaining({ status: PaymentStatus.REFUNDED }),
    );
    expect(result.status).toBe('pending');
  });

  it('rejects refunds after escrow has been released', async () => {
    paymentRepo.findOne.mockResolvedValueOnce({
      id: 'payment-1',
      status: PaymentStatus.RELEASED,
      type: PaymentType.ESCROW,
    });

    await expect(service.initiateRefund('payment-1')).rejects.toBeInstanceOf(BadRequestException);
    expect(mockedAxios.post).not.toHaveBeenCalled();
  });
});
