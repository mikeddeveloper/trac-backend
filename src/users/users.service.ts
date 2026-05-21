import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { User } from './entities/user.entity';

@Injectable()
export class UsersService {
  constructor(
    @InjectRepository(User)
    private usersRepo: Repository<User>,
  ) {}

  async create(data: Partial<User>): Promise<User> {
    const user = this.usersRepo.create(data);
    return this.usersRepo.save(user);
  }

  async findById(id: string): Promise<User> {
    const user = await this.usersRepo.findOne({ where: { id } });
    if (!user) throw new NotFoundException('User not found');
    return user;
  }

  async findByEmail(email: string): Promise<User | null> {
    return this.usersRepo.findOne({ where: { email } });
  }

  async findByGoogleId(googleId: string): Promise<User | null> {
    return this.usersRepo.findOne({ where: { googleId } });
  }

  async findByEmailWithPassword(email: string): Promise<User | null> {
    return this.usersRepo
      .createQueryBuilder('user')
      .addSelect('user.password')
      .where('user.email = :email', { email })
      .getOne();
  }

  async updateRefreshToken(id: string, token: string | null): Promise<void> {
    await this.usersRepo
      .createQueryBuilder()
      .update(User)
      .set({ refreshToken: token as any })
      .where('id = :id', { id })
      .execute();
  }

  async updateProfile(id: string, data: Partial<User>): Promise<User> {
    await this.usersRepo.update(id, data);
    return this.findById(id);
  }

  async findAll(): Promise<User[]> {
    return this.usersRepo.find();
  }

  async deactivateAccount(userId: string): Promise<void> {
    await this.usersRepo.update(userId, { isActive: false } as any);
  }
}