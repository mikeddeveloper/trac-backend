// trac-backend/src/payments/payments.controller.ts
// Day 19: Added escrow release, bank endpoints, earnings

import {
  Controller,
  Post,
  Get,
  Body,
  Param,
  Req,
  Headers,
  UseGuards,
  HttpCode,
  HttpStatus,
  ForbiddenException,
} from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { PaymentsService } from './payments.service';

@Controller('payments')
export class PaymentsController {
  constructor(private readonly paymentsService: PaymentsService) {}

  // ─── POST /payments/initialize ───────────────────────────────────────────────
  @Post('initialize')
  @UseGuards(AuthGuard('jwt'))
  async initializePayment(@Req() req: any, @Body() body: { jobId: string; amount: number; currency?: string }) {
    return this.paymentsService.initializePayment(req.user.email, body.jobId, req.user.id);
  }

  // ─── GET /payments/verify/:reference ────────────────────────────────────────
  @Get('verify/:reference')
  @UseGuards(AuthGuard('jwt'))
  async verifyPayment(@Param('reference') reference: string, @Req() req: any) {
    return this.paymentsService.verifyPayment(reference, req.user.id);
  }

  @Post('cancel/:reference')
  @UseGuards(AuthGuard('jwt'))
  async cancelPayment(@Param('reference') reference: string, @Req() req: any) {
    return this.paymentsService.cancelPendingPayment(reference, req.user.id);
  }

  // ─── GET /payments/payout/:amount ───────────────────────────────────────────
  @Get('payout/:amount')
  @UseGuards(AuthGuard('jwt'))
  async calculatePayout(@Param('amount') amount: string) {
    return this.paymentsService.calculatePayout(Number(amount));
  }

  // ─── GET /payments/transactions ─────────────────────────────────────────────
  @Get('transactions')
  @UseGuards(AuthGuard('jwt'))
  async getTransactions(@Req() req: any) {
    const role = req.user.role === 'transporter' ? 'transporter' : 'customer';
    return this.paymentsService.getTransactionsByUser(req.user.id, role);
  }

  // ─── GET /payments/wallet ────────────────────────────────────────────────────
  @Get('wallet')
  @UseGuards(AuthGuard('jwt'))
  async getWallet(@Req() req: any) {
    return this.paymentsService.getWalletBalance(req.user.id);
  }

  // ─── GET /payments/earnings ──────────────────────────────────────────────────
  // Day 19: Transporter earnings
  @Get('earnings')
  @UseGuards(AuthGuard('jwt'))
  async getEarnings(@Req() req: any) {
    return this.paymentsService.getTransporterEarnings(req.user.id);
  }

  // ─── GET /payments/banks ─────────────────────────────────────────────────────
  // Day 19: Get list of Nigerian banks
  @Get('banks')
  @UseGuards(AuthGuard('jwt'))
  async getBanks() {
    return this.paymentsService.getBanks();
  }

  // ─── GET /payments/verify-account/:accountNumber/:bankCode ───────────────────
  // Day 19: Verify bank account number
  @Get('verify-account/:accountNumber/:bankCode')
  @UseGuards(AuthGuard('jwt'))
  async verifyAccount(
    @Param('accountNumber') accountNumber: string,
    @Param('bankCode') bankCode: string,
  ) {
    return this.paymentsService.verifyBankAccount(accountNumber, bankCode);
  }

  // ─── POST /payments/recipient ────────────────────────────────────────────────
  // Day 19: Create Paystack transfer recipient for transporter
  @Post('recipient')
  @UseGuards(AuthGuard('jwt'))
  async createRecipient(
    @Req() req: any,
    @Body() body: { accountName: string; accountNumber: string; bankCode: string },
  ) {
    if (req.user.role !== 'transporter') throw new ForbiddenException('Transporter access required');
    const code = await this.paymentsService.createTransferRecipient(
      body.accountName,
      body.accountNumber,
      body.bankCode,
      req.user.id,
    );
    return { recipientCode: code };
  }

  // ─── POST /payments/simulate-release ────────────────────────────────────────
  @Post('simulate-release')
  @UseGuards(AuthGuard('jwt'))
  async simulateRelease(@Req() req: any) {
    if (req.user.role !== 'transporter') throw new ForbiddenException('Transporter access required');
    return this.paymentsService.simulateRelease(req.user.id);
  }

  // ─── POST /payments/release/:jobId ───────────────────────────────────────────
  // Customer confirms delivery — marks payment as available for transporter withdrawal
  @Post('release/:jobId')
  @UseGuards(AuthGuard('jwt'))
  async releaseEscrow(@Param('jobId') jobId: string, @Req() req: any) {
    return this.paymentsService.releaseEscrow(jobId, req.user.id);
  }

  // ─── POST /payments/withdraw/:jobId ──────────────────────────────────────────
  // Transporter initiates withdrawal — triggers actual Paystack bank transfer
  @Post('withdraw/:jobId')
  @UseGuards(AuthGuard('jwt'))
  async withdrawEarnings(@Param('jobId') jobId: string, @Req() req: any) {
    if (req.user.role !== 'transporter') throw new ForbiddenException('Transporter access required');
    return this.paymentsService.withdrawEarnings(jobId, req.user.id);
  }

  // ─── POST /payments/webhook ──────────────────────────────────────────────────
  @Post('webhook')
  @HttpCode(HttpStatus.OK)
  async handleWebhook(
    @Req() req: any,
    @Headers('x-paystack-signature') signature: string,
  ) {
    const rawBody: Buffer = req.rawBody ?? (Buffer.isBuffer(req.body) ? req.body : Buffer.from(JSON.stringify(req.body ?? {})));
    await this.paymentsService.handleWebhook(rawBody, signature);
    return { status: 'ok' };
  }
}
