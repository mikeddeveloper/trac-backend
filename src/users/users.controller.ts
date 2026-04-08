import { Controller, Get, Patch, Body, UseGuards, Request } from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { UsersService } from './users.service';

@Controller('users')
export class UsersController {
  constructor(private usersService: UsersService) {}

  // GET /api/users/me
  @Get('me')
  @UseGuards(AuthGuard('jwt'))
  async getMe(@Request() req) {
    return { user: req.user };
  }

  // PATCH /api/users/me
  @Patch('me')
  @UseGuards(AuthGuard('jwt'))
  async updateMe(@Request() req, @Body() body: any) {
    const updated = await this.usersService.updateProfile(req.user.id, body);
    return { user: updated };
  }
}