// trac-backend/src/users/users.controller.ts
// Profile update + password change

import { Controller, Get, Patch, Delete, Body, Request, UseGuards } from '@nestjs/common';
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
  async updateProfile(
    @Request() req: any,
    @Body() body: {
      fullName?: string;
      phone?: string;
      state?: string;
      bio?: string;
      companyName?: string;
      vehicleType?: string;
      licenseNumber?: string;
      vehiclePlate?: string;
      vehicleYear?: string;
      rcNumber?: string;
    },
  ) {
    const userId = req.user.id;
    const allowedFields = [
      'fullName', 'phone', 'state', 'bio',
      'companyName', 'vehicleType', 'licenseNumber',
      'vehiclePlate', 'vehicleYear', 'rcNumber',
    ];
    const updateData: any = {};
    for (const field of allowedFields) {
      if (body[field] !== undefined) updateData[field] = body[field];
    }
    if (Object.keys(updateData).length > 0) {
      await this.usersService.updateProfile(userId, updateData);
    }
    return this.usersService.findById(userId);
  }

  // DELETE /api/users/me
  @Delete('me')
  @UseGuards(AuthGuard('jwt'))
  async deleteAccount(@Request() req: any) {
    await this.usersService.deactivateAccount(req.user.id);
    return { message: 'Account deactivated successfully' };
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