import { BadRequestException, ForbiddenException } from '@nestjs/common';
import { JobsService } from './jobs.service';
import { JobStatus } from './entities/job.entity';

describe('JobsService pickup transition', () => {
  const makeService = (jobRepo: any, paymentsService: any = {}) => new JobsService(
    jobRepo,
    {} as any,
    {} as any,
    {} as any,
    {} as any,
    {} as any,
    paymentsService,
    { get: jest.fn() } as any,
  );

  it('blocks direct accepted-to-in-transit status changes without pickup evidence', async () => {
    const jobRepo = {
      findOne: jest.fn().mockResolvedValue({
        id: 'job-1',
        status: JobStatus.ACCEPTED,
        transporterId: 'transporter-1',
        customerId: 'customer-1',
      }),
    };
    const paymentsService = { assertEscrowPaid: jest.fn() };
    const service = makeService(jobRepo as any, paymentsService as any);

    await expect(service.updateJobStatus(
      'job-1',
      JobStatus.IN_TRANSIT,
      'transporter-1',
      'transporter',
    )).rejects.toBeInstanceOf(BadRequestException);
    expect(paymentsService.assertEscrowPaid).not.toHaveBeenCalled();
  });

  it('rejects status injection through the editable-job endpoint with a 400 error', async () => {
    const service = makeService({
      findOne: jest.fn().mockResolvedValue({ customerId: 'customer-1' }),
    } as any);
    await expect(service.updateUnbidJob(
      '00000000-0000-4000-8000-000000000001',
      'customer-1',
      { status: JobStatus.IN_TRANSIT },
    )).rejects.toThrow('Status cannot be changed through the job editing endpoint');
  });

  it('rejects a non-owner edit with 403 before processing the body', async () => {
    const service = makeService({
      findOne: jest.fn().mockResolvedValue({ customerId: 'customer-owner' }),
    } as any);
    await expect(service.updateUnbidJob(
      '00000000-0000-4000-8000-000000000001',
      'customer-attacker',
      { status: JobStatus.IN_TRANSIT },
    )).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('uses a bound parameter for job searches', async () => {
    const builder: any = {
      where: jest.fn(), orderBy: jest.fn(), take: jest.fn(), andWhere: jest.fn(), getMany: jest.fn(),
    };
    Object.keys(builder).forEach(key => { if (key !== 'getMany') builder[key].mockReturnValue(builder); });
    builder.getMany.mockResolvedValue([]);
    const service = makeService({ createQueryBuilder: jest.fn().mockReturnValue(builder) } as any);

    await service.searchOpenJobs("' UNION SELECT 1 --");
    expect(builder.andWhere).toHaveBeenCalledWith(expect.any(String), {
      search: "%' UNION SELECT 1 --%",
    });
  });

  it('rejects path-traversal search input at the application layer', async () => {
    const service = makeService({} as any);
    await expect(service.searchOpenJobs('../../etc/passwd'))
      .rejects.toThrow('Search text contains unsupported characters');
  });
});
