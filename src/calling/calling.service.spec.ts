import { ForbiddenException } from '@nestjs/common';
import { CallingService } from './calling.service';

describe('CallingService authorization', () => {
  const job = {
    id: 'job-1',
    customerId: 'customer-1',
    transporterId: 'transporter-1',
    status: 'accepted',
  };
  const config = {
    get: jest.fn((key: string) => ({
      AGORA_APP_ID: 'test-app',
      AGORA_APP_CERTIFICATE: 'test-certificate',
    })[key]),
  };
  const jobsService = { findById: jest.fn().mockResolvedValue(job) };
  const service = new CallingService(config as any, jobsService as any);

  beforeEach(() => {
    jest.spyOn(service, 'generateToken').mockReturnValue('test-token');
  });

  afterEach(() => jest.restoreAllMocks());

  it('prevents unrelated users from generating call tokens', async () => {
    await expect(service.createCallSession(job.id, 'stranger', 'publisher'))
      .rejects.toBeInstanceOf(ForbiddenException);
  });

  it('only lets the assigned transporter join as receiver', async () => {
    await expect(service.createCallSession(job.id, job.customerId, 'receiver'))
      .rejects.toBeInstanceOf(ForbiddenException);
    await expect(service.createCallSession(job.id, job.transporterId, 'receiver'))
      .resolves.toEqual(expect.objectContaining({ token: 'test-token' }));
  });

  it('only lets the job customer initiate a call', async () => {
    await expect(service.initiateCall(job.id, job.transporterId))
      .rejects.toBeInstanceOf(ForbiddenException);
  });
});
