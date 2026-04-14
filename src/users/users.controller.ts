// trac-backend/src/users/users.controller.ts
// Profile update + password change

import { Controller, Get, Patch, Body, Request, UseGuards } from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { UsersService } from './users.service';
import * as bcrypt from 'bcrypt';

@Controller('users')
export class UsersController {
  constructor(private readonly usersService: UsersService) {}

  // GET /api/users/me
  @Get('me')
  @UseGuards(AuthGuard('jwt'))
  async getMe(@Request() req: any) {
    const user = await this.usersService.findById(req.user.id);
    return {
      id: user.id,
      fullName: user.fullName,
      email: user.email,
      phone: user.phone,
      role: user.role,
      isVerified: user.isVerified,
    };
  }

  // PATCH /api/users/profile
  @Patch('profile')
  @UseGuards(AuthGuard('jwt'))
  async updateProfile(@Request() req: any, @Body() body: { fullName?: string; phone?: string }) {
    const updated = await this.usersService.updateProfile(req.user.id, {
      ...(body.fullName && { fullName: body.fullName }),
      ...(body.phone    && { phone: body.phone }),
    });
    return {
      id: updated.id,
      fullName: updated.fullName,
      email: updated.email,
      phone: updated.phone,
      role: updated.role,
    };
  }

  // PATCH /api/users/change-password
  @Patch('change-password')
  @UseGuards(AuthGuard('jwt'))
  async changePassword(
    @Request() req: any,
    @Body() body: { currentPassword: string; newPassword: string },
  ) {
    // Get user with password
    const user = await this.usersService.findByEmailWithPassword(req.user.email);
    if (!user) throw new Error('User not found');

    // Verify current password
    const match = await bcrypt.compare(body.currentPassword, user.password);
    if (!match) {
      const { BadRequestException } = await import('@nestjs/common');
      throw new BadRequestException('Current password is incorrect');
    }

    // Hash new password
    const hashed = await bcrypt.hash(body.newPassword, 12);
    await this.usersService.updateProfile(req.user.id, { password: hashed } as any);

    return { message: 'Password updated successfully' };
  }

  // GET /api/users/all (admin only)
  @Get('all')
  @UseGuards(AuthGuard('jwt'))
  async getAllUsers() {
    return this.usersService.findAll();
  }
}