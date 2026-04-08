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
    return this.paymentsService.initializePayment(req.user.email, body.amount, body.jobId, { customerId: req.user.id }, body.currency || 'NGN');
  }

  // ─── GET /payments/verify/:reference ────────────────────────────────────────
  @Get('verify/:reference')
  @UseGuards(AuthGuard('jwt'))
  async verifyPayment(@Param('reference') reference: string) {
    return this.paymentsService.verifyPayment(reference);
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
    @Body() body: { accountName: string; accountNumber: string; bankCode: string },
  ) {
    const code = await this.paymentsService.createTransferRecipient(
      body.accountName,
      body.accountNumber,
      body.bankCode,
    );
    return { recipientCode: code };
  }

  // ─── POST /payments/release/:jobId ───────────────────────────────────────────
  // Day 19: Release escrow to transporter
  // Called by customer after confirming delivery
  @Post('release/:jobId')
  @UseGuards(AuthGuard('jwt'))
  async releaseEscrow(
    @Param('jobId') jobId: string,
    @Body() body: { recipientCode: string },
  ) {
    return this.paymentsService.releaseEscrow(jobId, body.recipientCode);
  }

  // ─── POST /payments/webhook ──────────────────────────────────────────────────
  @Post('webhook')
  @HttpCode(HttpStatus.OK)
  async handleWebhook(
    @Req() req: any,
    @Headers('x-paystack-signature') signature: string,
  ) {
    const rawBody: Buffer = req.rawBody;
    if (!rawBody) throw new Error('Raw body not available');
    await this.paymentsService.handleWebhook(rawBody, signature);
    return { status: 'ok' };
  }
}