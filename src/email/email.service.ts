import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Resend } from 'resend';
import * as nodemailer from 'nodemailer';

@Injectable()
export class EmailService {
  private readonly logger = new Logger(EmailService.name);
  private resend: Resend;
  private transporter: any;
  private readonly fromAddress: string;

  constructor(private configService: ConfigService) {
    const apiKey = this.configService.get<string>('RESEND_API_KEY');
    if (!apiKey) {
      this.logger.error('RESEND_API_KEY is not set in environment variables');
    }
    this.resend = new Resend(apiKey || 're_placeholder');
    this.fromAddress = this.configService.get<string>('EMAIL_FROM') || 'Trac Logistics <info@trac.com.ng>';
    this.logger.log(`Email service initialized. API key present: ${!!apiKey}`);

    this.transporter = nodemailer.createTransport({
      host: 'smtp.office365.com',
      port: 587,
      secure: false,
      family: 4,
      requireTLS: true,
      auth: {
        user: this.configService.get('SMTP_USER'),
        pass: this.configService.get('SMTP_PASS'),
      },
      connectionTimeout: 15000,
      greetingTimeout: 15000,
      socketTimeout: 30000,
    });

    this.logger.log(`SMTP configured for: ${this.configService.get('SMTP_USER')}`);
  }

  private async sendEmail(message: { from?: string; to: string | string[]; subject: string; html: string }) {
    const resendKey = this.configService.get<string>('RESEND_API_KEY');
    if (resendKey) {
      try {
        const result = await this.resend.emails.send(
          {
            ...message,
            from: this.fromAddress,
          },
          // The Resend SDK otherwise waits indefinitely when an outbound
          // connection stalls, preventing the configured SMTP fallback.
          { signal: AbortSignal.timeout(15000) } as any,
        );
        if (!result.error) return result;
        this.logger.error(`Resend rejected email to ${message.to}: ${JSON.stringify(result.error)}`);
      } catch (error: any) {
        this.logger.error(`Resend failed for ${message.to}: ${error?.message || error}`);
      }
    }

    const smtpUser = this.configService.get<string>('SMTP_USER');
    const smtpPass = this.configService.get<string>('SMTP_PASS');
    if (smtpUser && smtpPass) {
      const recipients = Array.isArray(message.to) ? message.to.join(',') : message.to;
      const result = await this.sendViaSmtp(recipients, message.subject, message.html);
      if (result.success) return { data: result, error: null };
    }

    const error = new Error('Email delivery failed: configure RESEND_API_KEY or SMTP_USER and SMTP_PASS');
    this.logger.error(`${error.message}; recipient=${message.to}`);
    throw error;
  }

  private async sendViaSmtp(to: string, subject: string, html: string) {
    try {
      const info = await this.transporter.sendMail({
        from: `"Trac Logistics" <${this.configService.get('SMTP_USER')}>`,
        to,
        subject,
        html,
      });
      this.logger.log(`✅ SMTP email sent to ${to}, messageId: ${info.messageId}`);
      return { success: true };
    } catch (error: any) {
      this.logger.error(`SMTP email error for ${to}:`, error?.message);
      this.logger.error('SMTP error details:', JSON.stringify(error));
      return { success: false };
    }
  }

  async sendActivityEmail(
    user: { fullName: string; email: string },
    subject: string,
    heading: string,
    message: string,
    actionUrl?: string,
    actionLabel = 'Open Trac Dashboard',
  ) {
    const escape = (value: string) => value.replace(/[&<>"']/g, char => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;',
    })[char] as string);
    const firstName = escape((user.fullName || 'there').split(' ')[0]);
    const frontend = this.configService.get<string>('FRONTEND_URL') || 'https://traclogistics.com.ng';
    const url = actionUrl || `${frontend}/dashboard/notifications`;
    const html = `<div style="background:#F8FAFC;padding:32px 16px;font-family:Arial,sans-serif"><div style="max-width:600px;margin:auto;background:#fff;border-radius:16px;overflow:hidden"><div style="background:#1E3A5F;padding:28px;text-align:center"><h1 style="color:#6EC89A;margin:0">Trac Logistics</h1></div><div style="padding:32px"><h2 style="color:#1E3A5F">${escape(heading)}</h2><p style="color:#64748B;line-height:1.7">Hi ${firstName},</p><p style="color:#64748B;line-height:1.7">${escape(message)}</p><a href="${escape(url)}" style="display:inline-block;margin-top:16px;background:#6EC89A;color:#1E3A5F;padding:12px 22px;border-radius:10px;text-decoration:none;font-weight:700">${escape(actionLabel)}</a></div><div style="padding:18px;text-align:center;color:#94A3B8;font-size:12px">Trac Marketplace · info@trac.com.ng</div></div></div>`;
    try {
      const { error, data } = await this.sendEmail({ to: user.email, subject, html });
      return error ? { success: false, error } : { success: true, data };
    } catch (error: any) {
      this.logger.error(`Activity email failed for ${user.email}: ${error?.message || error}`);
      return { success: false, error: error?.message };
    }
  }

  async sendWelcomeEmail(user: {
    fullName: string;
    email: string;
    role: string;
  }) {
    const firstName = user.fullName.split(' ')[0];
    const isTransporter = user.role === 'transporter';

    const html = `
<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1.0"></head>
<body style="margin:0;padding:0;background:#F8FAFC;font-family:'Helvetica Neue',Arial,sans-serif;">
<div style="max-width:600px;margin:0 auto;padding:40px 20px;">

  <div style="background:linear-gradient(135deg,#1E3A5F,#2A4F7C);border-radius:16px;padding:40px;text-align:center;margin-bottom:24px;">
    <h1 style="color:#6EC89A;font-size:2rem;font-weight:900;margin:0 0 8px;">Trac Logistics</h1>
    <p style="color:rgba(255,255,255,0.7);margin:0;font-size:0.9rem;">Nigeria's #1 Logistics Marketplace</p>
  </div>

  <div style="background:white;border-radius:16px;padding:32px;margin-bottom:24px;box-shadow:0 4px 16px rgba(0,0,0,0.06);">
    <h2 style="color:#1E3A5F;font-size:1.5rem;font-weight:800;margin:0 0 16px;">Welcome aboard, ${firstName}! 🎉</h2>

    <p style="color:#64748B;font-size:0.95rem;line-height:1.7;margin:0 0 24px;">
      ${isTransporter
        ? 'Your transporter account has been created. Complete verification to start bidding on jobs and earning money!'
        : 'Your account is ready! Start posting delivery jobs and connect with verified transporters across Nigeria.'
      }
    </p>

    <div style="margin-bottom:24px;">
      ${isTransporter ? `
        <div style="display:flex;gap:12px;margin-bottom:16px;align-items:flex-start;">
          <div style="min-width:32px;height:32px;border-radius:50%;background:#1E3A5F;color:white;display:flex;align-items:center;justify-content:center;font-weight:800;font-size:0.85rem;">1</div>
          <div><p style="color:#1E3A5F;font-weight:700;margin:0 0 4px;">Complete Verification</p><p style="color:#64748B;font-size:0.85rem;margin:0;">Upload your NIN and driver license to get verified.</p></div>
        </div>
        <div style="display:flex;gap:12px;margin-bottom:16px;align-items:flex-start;">
          <div style="min-width:32px;height:32px;border-radius:50%;background:#1E3A5F;color:white;display:flex;align-items:center;justify-content:center;font-weight:800;font-size:0.85rem;">2</div>
          <div><p style="color:#1E3A5F;font-weight:700;margin:0 0 4px;">Browse Open Jobs</p><p style="color:#64748B;font-size:0.85rem;margin:0;">Find delivery jobs and place competitive bids.</p></div>
        </div>
        <div style="display:flex;gap:12px;align-items:flex-start;">
          <div style="min-width:32px;height:32px;border-radius:50%;background:#6EC89A;color:#1E3A5F;display:flex;align-items:center;justify-content:center;font-weight:800;font-size:0.85rem;">3</div>
          <div><p style="color:#1E3A5F;font-weight:700;margin:0 0 4px;">Deliver and Get Paid</p><p style="color:#64748B;font-size:0.85rem;margin:0;">Complete deliveries and get paid instantly.</p></div>
        </div>
      ` : `
        <div style="display:flex;gap:12px;margin-bottom:16px;align-items:flex-start;">
          <div style="min-width:32px;height:32px;border-radius:50%;background:#1E3A5F;color:white;display:flex;align-items:center;justify-content:center;font-weight:800;font-size:0.85rem;">1</div>
          <div><p style="color:#1E3A5F;font-weight:700;margin:0 0 4px;">Post a Delivery Job</p><p style="color:#64748B;font-size:0.85rem;margin:0;">Enter pickup, delivery location and cargo details.</p></div>
        </div>
        <div style="display:flex;gap:12px;margin-bottom:16px;align-items:flex-start;">
          <div style="min-width:32px;height:32px;border-radius:50%;background:#1E3A5F;color:white;display:flex;align-items:center;justify-content:center;font-weight:800;font-size:0.85rem;">2</div>
          <div><p style="color:#1E3A5F;font-weight:700;margin:0 0 4px;">Receive Bids</p><p style="color:#64748B;font-size:0.85rem;margin:0;">Verified transporters compete for your job.</p></div>
        </div>
        <div style="display:flex;gap:12px;margin-bottom:16px;align-items:flex-start;">
          <div style="min-width:32px;height:32px;border-radius:50%;background:#1E3A5F;color:white;display:flex;align-items:center;justify-content:center;font-weight:800;font-size:0.85rem;">3</div>
          <div><p style="color:#1E3A5F;font-weight:700;margin:0 0 4px;">Pay Securely</p><p style="color:#64748B;font-size:0.85rem;margin:0;">Pay via Paystack. Money held in escrow until delivery.</p></div>
        </div>
        <div style="display:flex;gap:12px;align-items:flex-start;">
          <div style="min-width:32px;height:32px;border-radius:50%;background:#6EC89A;color:#1E3A5F;display:flex;align-items:center;justify-content:center;font-weight:800;font-size:0.85rem;">4</div>
          <div><p style="color:#1E3A5F;font-weight:700;margin:0 0 4px;">Confirm with PIN</p><p style="color:#64748B;font-size:0.85rem;margin:0;">Share PIN with recipient. Payment released instantly.</p></div>
        </div>
      `}
    </div>

    <div style="text-align:center;margin-top:24px;">
      <a href="https://www.traclogistics.com.ng/dashboard/ratings"
         style="display:inline-block;background:#6EC89A;color:#1E3A5F;padding:14px 32px;border-radius:12px;font-weight:800;font-size:1rem;text-decoration:none;">
        ${isTransporter ? 'Complete Verification →' : 'Post Your First Delivery →'}
      </a>
    </div>
  </div>

  <div style="background:white;border-radius:12px;padding:20px;margin-bottom:24px;box-shadow:0 2px 8px rgba(0,0,0,0.06);">
    <p style="color:#1E3A5F;font-weight:700;margin:0 0 8px;">Need help?</p>
    <p style="color:#64748B;font-size:0.85rem;margin:0 0 8px;">Our support team is available Monday to Friday, 8am - 6pm.</p>
    <a href="mailto:info@trac.com.ng" style="color:#1E3A5F;font-weight:600;font-size:0.85rem;text-decoration:none;">info@trac.com.ng</a>
  </div>

  <div style="text-align:center;padding:20px 0;">
    <p style="color:#94A3B8;font-size:0.75rem;margin:0 0 4px;">© 2026 Trac Logistics. All rights reserved.</p>
    <p style="color:#94A3B8;font-size:0.72rem;margin:0;">Made with ❤️ in Nigeria 🇳🇬</p>
  </div>

</div>
</body>
</html>`;

    try {
      const { data, error } = await this.sendEmail({
        from: this.fromAddress,
        to: user.email,
        subject: `Welcome to Trac Logistics, ${firstName}! 🎉`,
        html,
      });

      if (error) {
        this.logger.error('Resend welcome email error:', JSON.stringify(error));
        return { success: false, error };
      }

      this.logger.log(`✅ Welcome email sent to ${user.email}`);
      return { success: true, data };
    } catch (error: any) {
      this.logger.error('Welcome email error:', error?.message);
      return { success: false };
    }
  }

  async sendPaymentConfirmedEmail(user: {
    fullName: string;
    email: string;
  }, payment: {
    amount: number;
    route: string;
  }) {
    const firstName = user.fullName.split(' ')[0];
    const html = `
<!DOCTYPE html>
<html>
<head><meta charset="utf-8"></head>
<body style="margin:0;padding:0;background:#F8FAFC;font-family:'Helvetica Neue',Arial,sans-serif;">
<div style="max-width:600px;margin:0 auto;padding:40px 20px;">
  <div style="background:linear-gradient(135deg,#1E3A5F,#2A4F7C);border-radius:16px;padding:32px;text-align:center;margin-bottom:24px;">
    <h1 style="color:#6EC89A;font-size:1.8rem;font-weight:900;margin:0;">Trac Logistics</h1>
  </div>
  <div style="background:white;border-radius:16px;padding:32px;margin-bottom:24px;box-shadow:0 4px 16px rgba(0,0,0,0.06);">
    <div style="text-align:center;margin-bottom:24px;">
      <div style="font-size:3rem;margin-bottom:12px;">✅</div>
      <h2 style="color:#1E3A5F;font-size:1.4rem;font-weight:800;margin:0 0 8px;">Payment Confirmed!</h2>
      <p style="color:#64748B;margin:0;">Hi ${firstName}, your payment has been received and is held safely in escrow.</p>
    </div>
    <div style="background:#F8FAFC;border-radius:12px;padding:20px;margin-bottom:24px;">
      <div style="display:flex;justify-content:space-between;margin-bottom:12px;border-bottom:1px solid #E8ECF0;padding-bottom:12px;">
        <span style="color:#64748B;font-size:0.85rem;">Amount Paid</span>
        <span style="color:#1E3A5F;font-weight:800;">₦${Number(payment.amount).toLocaleString()}</span>
      </div>
      <div style="display:flex;justify-content:space-between;margin-bottom:12px;border-bottom:1px solid #E8ECF0;padding-bottom:12px;">
        <span style="color:#64748B;font-size:0.85rem;">Route</span>
        <span style="color:#1E3A5F;font-weight:600;font-size:0.85rem;">${payment.route}</span>
      </div>
      <div style="display:flex;justify-content:space-between;">
        <span style="color:#64748B;font-size:0.85rem;">Payment Status</span>
        <span style="color:#15803D;font-weight:700;font-size:0.85rem;">Held in Escrow ✅</span>
      </div>
    </div>
    <p style="color:#64748B;font-size:0.85rem;text-align:center;margin:0 0 20px;">
      Your money is safe. It will only be released after your recipient confirms delivery with the PIN code.
    </p>
    <div style="text-align:center;">
      <a href="https://www.traclogistics.com.ng/dashboard"
         style="display:inline-block;background:#1E3A5F;color:white;padding:12px 28px;border-radius:12px;font-weight:800;font-size:0.9rem;text-decoration:none;">
        Track Your Delivery →
      </a>
    </div>
  </div>
  <div style="text-align:center;padding:20px 0;">
    <p style="color:#94A3B8;font-size:0.75rem;margin:0;">© 2026 Trac Logistics · info@trac.com.ng</p>
    <p style="color:#CBD5E1;font-size:0.7rem;margin:4px 0 0;">Made with ❤️ in Nigeria 🇳🇬</p>
  </div>
</div>
</body>
</html>`;

    try {
      const { data, error } = await this.sendEmail({
        from: this.fromAddress,
        to: user.email,
        subject: `Payment Confirmed - ₦${Number(payment.amount).toLocaleString()} | Trac Logistics`,
        html,
      });

      if (error) {
        this.logger.error('Resend payment email error:', JSON.stringify(error));
        return { success: false, error };
      }

      this.logger.log(`✅ Payment email sent to ${user.email}`);
      return { success: true, data };
    } catch (error: any) {
      this.logger.error('Payment email error:', error?.message);
      return { success: false };
    }
  }

  async sendOtpEmail(user: { fullName: string; email: string }, otp: string) {
    const firstName = user.fullName.split(' ')[0];
    const html = `
<!DOCTYPE html>
<html>
<head><meta charset="utf-8"></head>
<body style="margin:0;padding:0;background:#F8FAFC;font-family:'Helvetica Neue',Arial,sans-serif;">
<div style="max-width:600px;margin:0 auto;padding:40px 20px;">
  <div style="background:linear-gradient(135deg,#1E3A5F,#2A4F7C);border-radius:16px;padding:32px;text-align:center;margin-bottom:24px;">
    <h1 style="color:#6EC89A;font-size:1.8rem;font-weight:900;margin:0;">Trac Logistics</h1>
  </div>
  <div style="background:white;border-radius:16px;padding:32px;text-align:center;box-shadow:0 4px 16px rgba(0,0,0,0.06);">
    <h2 style="color:#1E3A5F;font-size:1.3rem;font-weight:800;margin:0 0 8px;">Verify Your Email</h2>
    <p style="color:#64748B;font-size:0.9rem;margin:0 0 24px;">Hi ${firstName}, enter this code to verify your email address:</p>
    <div style="background:#F8FAFC;border-radius:12px;padding:20px;margin-bottom:24px;">
      <span style="font-size:2.2rem;font-weight:900;letter-spacing:8px;color:#1E3A5F;">${otp}</span>
    </div>
    <p style="color:#94A3B8;font-size:0.78rem;margin:0;">This code expires in 10 minutes. If you didn't request this, ignore this email.</p>
  </div>
  <div style="text-align:center;padding:20px 0;">
    <p style="color:#94A3B8;font-size:0.75rem;margin:0;">© 2026 Trac Logistics · info@trac.com.ng</p>
  </div>
</div>
</body>
</html>`;

    try {
      const { error } = await this.sendEmail({
        from: this.fromAddress,
        to: user.email,
        subject: `Your Trac Logistics verification code: ${otp}`,
        html,
      });
      if (error) {
        this.logger.error('OTP email error:', JSON.stringify(error));
        return { success: false };
      }
      this.logger.log(`✅ OTP email sent to ${user.email}`);
      return { success: true };
    } catch (error: any) {
      this.logger.error('OTP email error:', error?.message);
      return { success: false };
    }
  }

  async sendPasswordResetEmail(user: { fullName: string; email: string }, resetUrl: string) {
    const firstName = user.fullName.split(' ')[0];
    const html = `
<!DOCTYPE html>
<html>
<head><meta charset="utf-8"></head>
<body style="margin:0;padding:0;background:#F8FAFC;font-family:'Helvetica Neue',Arial,sans-serif;">
<div style="max-width:600px;margin:0 auto;padding:40px 20px;">
  <div style="background:linear-gradient(135deg,#1E3A5F,#2A4F7C);border-radius:16px;padding:32px;text-align:center;margin-bottom:24px;">
    <h1 style="color:#6EC89A;font-size:1.8rem;font-weight:900;margin:0;">Trac Logistics</h1>
  </div>
  <div style="background:white;border-radius:16px;padding:32px;text-align:center;box-shadow:0 4px 16px rgba(0,0,0,0.06);">
    <div style="width:56px;height:56px;border-radius:50%;background:#1E3A5F;margin:0 auto 16px;display:flex;align-items:center;justify-content:center;">
      <span style="font-size:1.5rem;">🔒</span>
    </div>
    <h2 style="color:#1E3A5F;font-size:1.3rem;font-weight:800;margin:0 0 8px;">Reset Your Password</h2>
    <p style="color:#64748B;font-size:0.9rem;margin:0 0 24px;line-height:1.6;">
      Hi ${firstName}, we received a request to reset your Trac Logistics password. Click the button below to create a new password.
    </p>
    <a href="${resetUrl}"
       style="display:inline-block;background:#1E3A5F;color:white;padding:14px 32px;border-radius:12px;font-weight:800;font-size:0.95rem;text-decoration:none;margin-bottom:24px;">
      Reset Password →
    </a>
    <p style="color:#94A3B8;font-size:0.78rem;margin:0 0 8px;">This link expires in 1 hour.</p>
    <p style="color:#94A3B8;font-size:0.78rem;margin:0;">If you didn't request this, you can safely ignore this email.</p>
  </div>
  <div style="text-align:center;padding:20px 0;">
    <p style="color:#94A3B8;font-size:0.75rem;margin:0;">© 2026 Trac Logistics · info@trac.com.ng</p>
  </div>
</div>
</body>
</html>`;

    try {
      const { error } = await this.sendEmail({
        from: this.fromAddress,
        to: user.email,
        subject: `Reset your Trac Logistics password`,
        html,
      });
      if (error) {
        this.logger.error('Password reset email error:', JSON.stringify(error));
        return { success: false };
      }
      this.logger.log(`✅ Password reset email sent to ${user.email}`);
      return { success: true };
    } catch (error: any) {
      this.logger.error('Password reset email error:', error?.message);
      return { success: false };
    }
  }

  async sendLicenseApprovedEmail(user: { fullName: string; email: string }) {
    const firstName = user.fullName.split(' ')[0];
    const html = `
<!DOCTYPE html>
<html>
<head><meta charset="utf-8"></head>
<body style="margin:0;padding:0;background:#F8FAFC;font-family:'Helvetica Neue',Arial,sans-serif;">
<div style="max-width:600px;margin:0 auto;padding:40px 20px;">
  <div style="background:linear-gradient(135deg,#1E3A5F,#2A4F7C);border-radius:16px;padding:32px;text-align:center;margin-bottom:24px;">
    <h1 style="color:#6EC89A;font-size:1.8rem;font-weight:900;margin:0;">Trac Logistics</h1>
  </div>
  <div style="background:white;border-radius:16px;padding:32px;text-align:center;box-shadow:0 4px 16px rgba(0,0,0,0.06);">
    <div style="font-size:3rem;margin-bottom:16px;">✅</div>
    <h2 style="color:#1E3A5F;font-size:1.4rem;font-weight:800;margin:0 0 8px;">License Verified, ${firstName}!</h2>
    <p style="color:#64748B;font-size:0.9rem;line-height:1.6;margin:0 0 24px;">
      Your driver license has been verified by our admin team. You now have full access to the Trac Marketplace dashboard and can start bidding on delivery jobs!
    </p>
    <a href="https://www.traclogistics.com.ng/dashboard/transporter"
       style="display:inline-block;background:#6EC89A;color:#1E3A5F;padding:14px 32px;border-radius:12px;font-weight:800;font-size:1rem;text-decoration:none;margin-bottom:24px;">
      Go to Dashboard →
    </a>
    <div style="background:#F0FDF4;border-radius:12px;padding:16px;margin-bottom:16px;">
      <p style="color:#15803D;font-weight:700;margin:0 0 8px;">✅ Verified Transporter</p>
      <p style="color:#64748B;font-size:0.85rem;margin:0;">You can now bid on jobs, accept deliveries and earn money on Trac Marketplace.</p>
    </div>
    <p style="color:#94A3B8;font-size:0.78rem;margin:0;">Welcome to the Trac family! Start earning today.</p>
  </div>
  <div style="text-align:center;padding:20px 0;">
    <p style="color:#94A3B8;font-size:0.75rem;margin:0;">© 2026 Trac Logistics · info@trac.com.ng</p>
    <p style="color:#CBD5E1;font-size:0.7rem;margin:4px 0 0;">Made with ❤️ in Nigeria 🇳🇬</p>
  </div>
</div>
</body>
</html>`;

    try {
      const { error } = await this.sendEmail({
        from: this.fromAddress,
        to: user.email,
        subject: '🎉 Your License Has Been Verified | Trac Logistics',
        html,
      });
      if (error) {
        this.logger.error('License approved email error:', JSON.stringify(error));
        return { success: false };
      }
      this.logger.log(`✅ License approved email sent to ${user.email}`);
      return { success: true };
    } catch (error: any) {
      this.logger.error('License approved email error:', error?.message);
      return { success: false };
    }
  }

  async sendLicenseRejectedEmail(user: { fullName: string; email: string }, reason: string) {
    const firstName = user.fullName.split(' ')[0];
    const html = `
<!DOCTYPE html>
<html>
<head><meta charset="utf-8"></head>
<body style="margin:0;padding:0;background:#F8FAFC;font-family:'Helvetica Neue',Arial,sans-serif;">
<div style="max-width:600px;margin:0 auto;padding:40px 20px;">
  <div style="background:linear-gradient(135deg,#1E3A5F,#2A4F7C);border-radius:16px;padding:32px;text-align:center;margin-bottom:24px;">
    <h1 style="color:#6EC89A;font-size:1.8rem;font-weight:900;margin:0;">Trac Logistics</h1>
  </div>
  <div style="background:white;border-radius:16px;padding:32px;text-align:center;box-shadow:0 4px 16px rgba(0,0,0,0.06);">
    <div style="font-size:3rem;margin-bottom:16px;">❌</div>
    <h2 style="color:#1E3A5F;font-size:1.4rem;font-weight:800;margin:0 0 8px;">License Verification Failed</h2>
    <p style="color:#64748B;font-size:0.9rem;line-height:1.6;margin:0 0 16px;">
      Hi ${firstName}, unfortunately your driver license could not be verified.
    </p>
    <div style="background:#FEF2F2;border:1px solid #FECACA;border-radius:12px;padding:16px;margin-bottom:24px;text-align:left;">
      <p style="color:#991B1B;font-weight:700;margin:0 0 4px;">Reason:</p>
      <p style="color:#991B1B;font-size:0.85rem;margin:0;">${reason}</p>
    </div>
    <a href="https://www.traclogistics.com.ng/dashboard/license"
       style="display:inline-block;background:#1E3A5F;color:white;padding:14px 32px;border-radius:12px;font-weight:800;font-size:1rem;text-decoration:none;margin-bottom:16px;">
      Resubmit License →
    </a>
    <p style="color:#94A3B8;font-size:0.78rem;margin:0;">If you have questions contact us at info@trac.com.ng</p>
  </div>
  <div style="text-align:center;padding:20px 0;">
    <p style="color:#94A3B8;font-size:0.75rem;margin:0;">© 2026 Trac Logistics · info@trac.com.ng</p>
  </div>
</div>
</body>
</html>`;

    try {
      const { error } = await this.sendEmail({
        from: this.fromAddress,
        to: user.email,
        subject: '📋 License Verification Update | Trac Logistics',
        html,
      });
      if (error) {
        this.logger.error('License rejected email error:', JSON.stringify(error));
        return { success: false };
      }
      this.logger.log(`✅ License rejected email sent to ${user.email}`);
      return { success: true };
    } catch (error: any) {
      this.logger.error('License rejected email error:', error?.message);
      return { success: false };
    }
  }

  async sendDeliveryConfirmedEmail(user: {
    fullName: string;
    email: string;
  }, delivery: {
    route: string;
    amount: number;
  }) {
    const firstName = user.fullName.split(' ')[0];
    const html = `
<!DOCTYPE html>
<html>
<head><meta charset="utf-8"></head>
<body style="margin:0;padding:0;background:#F8FAFC;font-family:'Helvetica Neue',Arial,sans-serif;">
<div style="max-width:600px;margin:0 auto;padding:40px 20px;">
  <div style="background:linear-gradient(135deg,#1E3A5F,#2A4F7C);border-radius:16px;padding:32px;text-align:center;margin-bottom:24px;">
    <h1 style="color:#6EC89A;font-size:1.8rem;font-weight:900;margin:0;">Trac Logistics</h1>
  </div>
  <div style="background:white;border-radius:16px;padding:32px;margin-bottom:24px;box-shadow:0 4px 16px rgba(0,0,0,0.06);">
    <div style="text-align:center;margin-bottom:24px;">
      <div style="font-size:3rem;margin-bottom:12px;">🎉</div>
      <h2 style="color:#1E3A5F;font-size:1.4rem;font-weight:800;margin:0 0 8px;">Delivery Confirmed!</h2>
      <p style="color:#64748B;margin:0;">Hi ${firstName}, your delivery has been completed successfully.</p>
    </div>
    <div style="background:#F0FDF4;border:1px solid #BBF7D0;border-radius:12px;padding:20px;margin-bottom:24px;">
      <div style="display:flex;justify-content:space-between;margin-bottom:8px;">
        <span style="color:#64748B;font-size:0.85rem;">Route</span>
        <span style="color:#1E3A5F;font-weight:600;font-size:0.85rem;">${delivery.route}</span>
      </div>
      <div style="display:flex;justify-content:space-between;">
        <span style="color:#64748B;font-size:0.85rem;">Payment Released</span>
        <span style="color:#15803D;font-weight:800;">₦${Number(delivery.amount).toLocaleString()}</span>
      </div>
    </div>
    <p style="color:#64748B;font-size:0.85rem;text-align:center;margin:0 0 20px;">
      Thank you for using Trac Logistics! Please rate your transporter to help build trust in our community.
    </p>
    <div style="text-align:center;">
      <a href="https://www.traclogistics.com.ng/dashboard"
         style="display:inline-block;background:#6EC89A;color:#1E3A5F;padding:12px 28px;border-radius:12px;font-weight:800;font-size:0.9rem;text-decoration:none;">
        Rate Your Transporter →
      </a>
    </div>
  </div>
  <div style="text-align:center;padding:20px 0;">
    <p style="color:#94A3B8;font-size:0.75rem;margin:0;">© 2026 Trac Logistics · info@trac.com.ng</p>
    <p style="color:#CBD5E1;font-size:0.7rem;margin:4px 0 0;">Made with ❤️ in Nigeria 🇳🇬</p>
  </div>
</div>
</body>
</html>`;

    try {
      const { data, error } = await this.sendEmail({
        from: this.fromAddress,
        to: user.email,
        subject: `Delivery Confirmed! | Trac Logistics`,
        html,
      });

      if (error) {
        this.logger.error('Resend delivery email error:', JSON.stringify(error));
        return { success: false, error };
      }

      this.logger.log(`✅ Delivery email sent to ${user.email}`);
      return { success: true, data };
    } catch (error: any) {
      this.logger.error('Delivery email error:', error?.message);
      return { success: false };
    }
  }

  async sendDisputeEmail(dispute: {
    jobId: string;
    customerId: string;
    customerName: string;
    reason: string;
    route: string;
    amount: number;
  }) {
    const html = `
<!DOCTYPE html>
<html>
<head><meta charset="utf-8"></head>
<body style="margin:0;padding:0;background:#F8FAFC;font-family:'Helvetica Neue',Arial,sans-serif;">
<div style="max-width:600px;margin:0 auto;padding:40px 20px;">
  <div style="background:linear-gradient(135deg,#1E3A5F,#2A4F7C);border-radius:16px;padding:32px;text-align:center;margin-bottom:24px;">
    <h1 style="color:#F87171;font-size:1.8rem;font-weight:900;margin:0;">⚠️ Dispute Raised</h1>
  </div>
  <div style="background:white;border-radius:16px;padding:32px;margin-bottom:24px;box-shadow:0 4px 16px rgba(0,0,0,0.06);">
    <h2 style="color:#1E3A5F;font-size:1.2rem;font-weight:800;margin:0 0 16px;">A customer has raised a delivery dispute</h2>
    <table style="width:100%;border-collapse:collapse;font-size:0.85rem;">
      <tr><td style="padding:8px 0;color:#64748B;width:140px;">Job ID</td><td style="color:#1E3A5F;font-weight:600;">${dispute.jobId}</td></tr>
      <tr><td style="padding:8px 0;color:#64748B;">Customer</td><td style="color:#1E3A5F;font-weight:600;">${dispute.customerName}</td></tr>
      <tr><td style="padding:8px 0;color:#64748B;">Route</td><td style="color:#1E3A5F;font-weight:600;">${dispute.route}</td></tr>
      <tr><td style="padding:8px 0;color:#64748B;">Amount (Held)</td><td style="color:#DC2626;font-weight:800;">₦${Number(dispute.amount).toLocaleString()}</td></tr>
      <tr><td style="padding:8px 0;color:#64748B;vertical-align:top;">Reason</td><td style="color:#1E3A5F;font-weight:600;">${dispute.reason}</td></tr>
    </table>
    <div style="background:#FEF2F2;border:1px solid #FECACA;border-radius:12px;padding:16px;margin-top:20px;">
      <p style="color:#DC2626;font-size:0.85rem;margin:0;font-weight:600;">Payment is frozen. Please review and resolve within 24 hours.</p>
    </div>
  </div>
</div>
</body>
</html>`;

    try {
      const adminEmail = this.configService.get<string>('ADMIN_EMAIL') || 'mikeddev6@gmail.com';
      const { data, error } = await this.sendEmail({
        from: this.fromAddress,
        to: adminEmail,
        subject: `⚠️ Dispute Raised — Job ${dispute.jobId.slice(0, 8)}`,
        html,
      });
      if (error) { this.logger.error('Dispute email error:', JSON.stringify(error)); return { success: false }; }
      this.logger.log(`✅ Dispute email sent to admin`);
      return { success: true, data };
    } catch (error: any) {
      this.logger.error('Dispute email error:', error?.message);
      return { success: false };
    }
  }
}
