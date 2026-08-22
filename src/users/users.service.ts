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
    return this.usersRepo
      .createQueryBuilder('user')
      .where('LOWER(user.email) = LOWER(:email)', { email: email.trim() })
      .getOne();
  }

  async findByGoogleId(googleId: string): Promise<User | null> {
    return this.usersRepo.findOne({ where: { googleId } });
  }

  async findByEmailWithPassword(email: string): Promise<User | null> {
    return this.usersRepo
      .createQueryBuilder('user')
      .addSelect('user.password')
      .where('LOWER(user.email) = LOWER(:email)', { email: email.trim() })
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

  async findByPasswordResetToken(token: string): Promise<User | null> {
    return this.usersRepo.findOne({ where: { passwordResetToken: token } as any });
  }

  async findAll(): Promise<User[]> {
    return this.usersRepo.find();
  }

  async deactivateAccount(userId: string): Promise<void> {
    await this.usersRepo.update(userId, { isActive: false } as any);
  }

  async revokeSessions(id: string): Promise<void> {
    await this.usersRepo.increment({ id }, 'sessionVersion', 1);
    await this.updateRefreshToken(id, null);
  }

  private async ensurePreferencesTable(): Promise<void> {
    await this.usersRepo.query(`
      CREATE TABLE IF NOT EXISTS user_preferences (
        user_id uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
        notifications jsonb NOT NULL DEFAULT '{}'::jsonb,
        privacy jsonb NOT NULL DEFAULT '{}'::jsonb,
        updated_at timestamptz NOT NULL DEFAULT now()
      )
    `);
  }

  async getPreferences(userId: string) {
    await this.ensurePreferencesTable();
    const rows = await this.usersRepo.query(
      'SELECT notifications, privacy FROM user_preferences WHERE user_id = $1',
      [userId],
    );
    return rows[0] || { notifications: {}, privacy: {} };
  }

  async savePreferences(userId: string, body: { notifications?: object; privacy?: object }) {
    await this.ensurePreferencesTable();
    const current = await this.getPreferences(userId);
    const notifications = body.notifications ?? current.notifications ?? {};
    const privacy = body.privacy ?? current.privacy ?? {};
    await this.usersRepo.query(
      `INSERT INTO user_preferences (user_id, notifications, privacy, updated_at)
       VALUES ($1, $2::jsonb, $3::jsonb, now())
       ON CONFLICT (user_id) DO UPDATE SET
         notifications = EXCLUDED.notifications,
         privacy = EXCLUDED.privacy,
         updated_at = now()`,
      [userId, JSON.stringify(notifications), JSON.stringify(privacy)],
    );
    return { notifications, privacy };
  }
}
