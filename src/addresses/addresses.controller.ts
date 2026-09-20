import { Body, Controller, Delete, Get, Param, ParseUUIDPipe, Patch, Post, Req, UseGuards } from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { AddressesService } from './addresses.service';
import { CreateSavedAddressDto } from './dto/create-saved-address.dto';
import { UpdateSavedAddressDto } from './dto/update-saved-address.dto';

@Controller('addresses')
@UseGuards(AuthGuard('jwt'))
export class AddressesController {
  constructor(private readonly addressesService: AddressesService) {}

  @Get()
  list(@Req() req: any) {
    return this.addressesService.list(req.user.id);
  }

  @Post()
  create(@Req() req: any, @Body() body: CreateSavedAddressDto) {
    return this.addressesService.create(req.user.id, body);
  }

  @Patch(':id')
  update(
    @Req() req: any,
    @Param('id', new ParseUUIDPipe({ version: '4' })) id: string,
    @Body() body: UpdateSavedAddressDto,
  ) {
    return this.addressesService.update(req.user.id, id, body);
  }

  @Delete(':id')
  remove(@Req() req: any, @Param('id', new ParseUUIDPipe({ version: '4' })) id: string) {
    return this.addressesService.remove(req.user.id, id);
  }
}
