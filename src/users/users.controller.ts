// trac-backend/src/users/users.controller.ts
// Profile update + password change + avatar upload + bank account

import {
  Controller, Get, Patch, Delete, Body, Request, UseGuards,
  UseInterceptors, UploadedFile, BadRequestException,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { AuthGuard } from '@nestjs/passport';
import { UsersService } from './users.service';
import { diskStorage } from 'multer';
import { extname, join } from 'path';
import * as fs from 'fs';
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
      avatarUrl: user.avatarUrl,
      state: user.state,
      bio: user.bio,
      companyName: user.companyName,
      vehicleType: user.vehicleType,
      licenseNumber: user.licenseNumber,
      vehiclePlate: user.vehiclePlate,
      vehicleYear: user.vehicleYear,
      rcNumber: user.rcNumber,
      bankName: user.bankName,
      accountNumber: user.accountNumber,
      accountName: user.accountName,
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

  // PATCH /api/users/profile/avatar
  @Patch('profile/avatar')
  @UseGuards(AuthGuard('jwt'))
  @UseInterceptors(FileInterceptor('avatar', {
    storage: diskStorage({
      destination: (_req, _file, cb) => {
        const dir = join(process.cwd(), 'uploads', 'avatars');
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
        cb(null, dir);
      },
      filename: (req: any, file, cb) => {
        const ext = extname(file.originalname);
        cb(null, `${req.user.id}_${Date.now()}${ext}`);
      },
    }),
    limits: { fileSize: 5 * 1024 * 1024 },
    fileFilter: (_req, file, cb) => {
      if (file.mimetype.startsWith('image/')) cb(null, true);
      else cb(new BadRequestException('Only image files allowed'), false);
    },
  }))
  async uploadAvatar(@Request() req: any, @UploadedFile() file: Express.Multer.File) {
    if (!file) throw new BadRequestException('No file uploaded');
    const baseUrl = process.env.BACKEND_URL || `http://localhost:${process.env.PORT || 3001}`;
    const avatarUrl = `${baseUrl}/uploads/avatars/${file.filename}`;
    await this.usersService.updateProfile(req.user.id, { avatarUrl } as any);
    return { avatarUrl };
  }

  // PATCH /api/users/bank-account
  @Patch('bank-account')
  @UseGuards(AuthGuard('jwt'))
  async saveBankAccount(
    @Request() req: any,
    @Body() body: { bankName: string; accountNumber: string; accountName: string },
  ) {
    await this.usersService.updateProfile(req.user.id, {
      bankName: body.bankName,
      accountNumber: body.accountNumber,
      accountName: body.accountName,
    } as any);
    return { message: 'Bank account saved successfully' };
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
    const user = await this.usersService.findByEmailWithPassword(req.user.email);
    if (!user) throw new BadRequestException('User not found');

    const match = await bcrypt.compare(body.currentPassword, user.password);
    if (!match) throw new BadRequestException('Current password is incorrect');

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
