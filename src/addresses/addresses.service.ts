import { ForbiddenException, Injectable, NotFoundException, OnModuleInit } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { SavedAddress } from './entities/saved-address.entity';
import { CreateSavedAddressDto } from './dto/create-saved-address.dto';
import { UpdateSavedAddressDto } from './dto/update-saved-address.dto';

const MAX_SAVED_ADDRESSES = 20;

@Injectable()
export class AddressesService implements OnModuleInit {
  constructor(
    @InjectRepository(SavedAddress) private addressRepo: Repository<SavedAddress>,
  ) {}

  async onModuleInit() {
    await this.addressRepo.query(`
      CREATE TABLE IF NOT EXISTS saved_addresses (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        "userId" varchar NOT NULL,
        label varchar NOT NULL,
        address varchar NOT NULL,
        "recipientName" varchar,
        "recipientPhone" varchar,
        "isDefault" boolean NOT NULL DEFAULT false,
        "createdAt" timestamptz NOT NULL DEFAULT now()
      )
    `);
    await this.addressRepo.query('CREATE INDEX IF NOT EXISTS "IDX_saved_addresses_user" ON saved_addresses ("userId", "createdAt" DESC)');
  }

  async list(userId: string) {
    return this.addressRepo.find({ where: { userId }, order: { isDefault: 'DESC', createdAt: 'DESC' } });
  }

  private async findOwned(userId: string, id: string) {
    const address = await this.addressRepo.findOne({ where: { id } });
    if (!address) throw new NotFoundException('Saved address not found');
    if (address.userId !== userId) throw new ForbiddenException('This address does not belong to you');
    return address;
  }

  async create(userId: string, input: CreateSavedAddressDto) {
    const count = await this.addressRepo.count({ where: { userId } });
    if (count >= MAX_SAVED_ADDRESSES) {
      throw new ForbiddenException(`You can save up to ${MAX_SAVED_ADDRESSES} addresses. Delete one before adding another.`);
    }
    if (input.isDefault) await this.addressRepo.update({ userId }, { isDefault: false });
    const address = this.addressRepo.create({ ...input, userId, isDefault: !!input.isDefault || count === 0 });
    return this.addressRepo.save(address);
  }

  async update(userId: string, id: string, input: UpdateSavedAddressDto) {
    await this.findOwned(userId, id);
    if (input.isDefault) await this.addressRepo.update({ userId }, { isDefault: false });
    await this.addressRepo.update(id, input);
    return this.findOwned(userId, id);
  }

  async remove(userId: string, id: string) {
    const address = await this.findOwned(userId, id);
    await this.addressRepo.delete(id);
    if (address.isDefault) {
      const next = await this.addressRepo.findOne({ where: { userId }, order: { createdAt: 'DESC' } });
      if (next) await this.addressRepo.update(next.id, { isDefault: true });
    }
    return { success: true };
  }
}
