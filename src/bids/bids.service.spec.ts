import { BadRequestException } from '@nestjs/common';
import { BidsService } from './bids.service';
import { BidStatus } from './entities/bid.entity';
import { JobStatus } from '../jobs/entities/job.entity';

describe('BidsService acceptance protections', () => {
  const bid = {
    id: 'bid-1', jobId: 'job-1', transporterId: 'transporter-1',
    amount: 100, note: null, status: BidStatus.PENDING,
  } as any;
  const job = {
    id: 'job-1', customerId: 'customer-1', status: JobStatus.BIDDING,
    pickupState: 'Lagos', deliveryState: 'Ogun',
  } as any;

  const execute = jest.fn().mockResolvedValue({ affected: 1 });
  const manager = {
    findOne: jest.fn(),
    update: jest.fn().mockResolvedValue({ affected: 1 }),
    createQueryBuilder: jest.fn(() => ({
      update: jest.fn().mockReturnThis(),
      set: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      execute,
    })),
  };
  const bidsRepo = {
    manager: { transaction: jest.fn((callback) => callback(manager)) },
  };
  const service = new BidsService(
    bidsRepo as any,
    { findOne: jest.fn().mockResolvedValue(null) } as any,
    {} as any,
    { sendToUser: jest.fn() } as any,
    { notifyUser: jest.fn() } as any,
    { sendActivityEmail: jest.fn() } as any,
  );

  beforeEach(() => {
    jest.clearAllMocks();
    manager.findOne
      .mockResolvedValueOnce({ ...bid })
      .mockResolvedValueOnce({ ...job });
  });

  it('locks and updates the job in one transaction and returns no nested records', async () => {
    const result = await service.acceptBid(bid.id, job.customerId);

    expect(manager.findOne).toHaveBeenNthCalledWith(2, expect.anything(), expect.objectContaining({
      loadEagerRelations: false,
      lock: { mode: 'pessimistic_write' },
    }));
    expect(manager.update).toHaveBeenCalledWith(expect.anything(), job.id, expect.objectContaining({
      transporterId: bid.transporterId,
      status: JobStatus.BID_SELECTED,
    }));
    expect(result.status).toBe(BidStatus.ACCEPTED);
    expect((result as any).job).toBeUndefined();
    expect((result as any).transporter).toBeUndefined();
  });

  it('rejects a second acceptance after the job leaves bidding', async () => {
    manager.findOne
      .mockReset()
      .mockResolvedValueOnce({ ...bid })
      .mockResolvedValueOnce({ ...job, status: JobStatus.BID_SELECTED });

    await expect(service.acceptBid(bid.id, job.customerId))
      .rejects.toBeInstanceOf(BadRequestException);
    expect(manager.update).not.toHaveBeenCalled();
  });
});
