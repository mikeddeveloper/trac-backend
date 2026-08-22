// trac-backend/src/waybill/waybill.service.ts
// Waybill PDF Generator using PDFKit

import { ForbiddenException, Injectable, NotFoundException, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Job } from '../jobs/entities/job.entity';
import PDFDocument = require('pdfkit');

@Injectable()
export class WaybillService {
  private readonly logger = new Logger(WaybillService.name);

  constructor(
    @InjectRepository(Job)
    private jobRepo: Repository<Job>,
  ) {}

  async generateWaybill(jobId: string, userId: string, role: string): Promise<Buffer> {
    const job = await this.jobRepo.findOne({
      where: { id: jobId },
      relations: ['customer', 'transporter'],
    });

    if (!job) throw new NotFoundException('Job not found');
    if (role !== 'admin' && ![job.customerId, job.transporterId].includes(userId)) {
      throw new ForbiddenException('You are not authorized to access this waybill');
    }

    return new Promise((resolve, reject) => {
      const doc = new PDFDocument({ size: 'A4', margin: 50 });
      const buffers: Buffer[] = [];
      doc.on('data', (chunk) => buffers.push(chunk));
      doc.on('end', () => resolve(Buffer.concat(buffers)));
      doc.on('error', reject);

      const navy  = '#1E3A5F';
      const mint  = '#6EC89A';
      const gray  = '#64748B';
      const dark  = '#111827';
      const pageW = doc.page.width;
      const margin = 50;
      const contentW = pageW - margin * 2;

      // ── Header ──
      doc.rect(0, 0, pageW, 110).fill(navy);
      doc.fontSize(26).font('Helvetica-Bold').fillColor('#fff').text('TRAC', margin, 30);
      doc.fontSize(9).font('Helvetica').fillColor(mint).text('MARKETPLACE', margin, 60);
      doc.fontSize(8).fillColor('rgba(255,255,255,0.5)').text("Nigeria's Modern Logistics Platform", margin, 75);
      doc.fontSize(20).font('Helvetica-Bold').fillColor('#fff').text('WAYBILL', pageW - 200, 32, { width: 150, align: 'right' });
      doc.fontSize(11).font('Helvetica').fillColor(mint).text(`#${job.id.slice(0, 8).toUpperCase()}`, pageW - 200, 58, { width: 150, align: 'right' });
      const now = new Date();
      doc.fontSize(8).fillColor('rgba(255,255,255,0.5)').text(`Issued: ${now.toLocaleDateString('en-NG', { day: 'numeric', month: 'long', year: 'numeric' })}`, pageW - 200, 78, { width: 150, align: 'right' });

      // ── Status badge ──
      const statusColors: Record<string, string> = { accepted: '#3B82F6', 'in-transit': '#14B8A6', delivered: '#22C55E', cancelled: '#EF4444' };
      doc.roundedRect(margin, 125, 100, 22, 5).fill(statusColors[job.status] || '#94A3B8');
      doc.fontSize(9).font('Helvetica-Bold').fillColor('#fff').text(job.status.toUpperCase().replace('-', ' '), margin + 8, 131);

      let y = 168;

      const sectionHeader = (title: string, yPos: number) => {
        doc.rect(margin, yPos, contentW, 24).fill('#F8FAFC');
        doc.fontSize(9).font('Helvetica-Bold').fillColor(navy).text(title, margin + 10, yPos + 7);
        return yPos + 32;
      };

      const row = (label: string, value: string, yPos: number, highlight = false) => {
        if (highlight) doc.rect(margin, yPos, contentW, 20).fill('#F0FDF4');
        doc.fontSize(8).font('Helvetica').fillColor(gray).text(label, margin + 10, yPos + 4);
        doc.fontSize(8).font('Helvetica-Bold').fillColor(dark).text(value || '—', margin + 150, yPos + 4, { width: contentW - 160 });
        doc.moveTo(margin, yPos + 20).lineTo(margin + contentW, yPos + 20).strokeColor('#F1F5F9').lineWidth(0.5).stroke();
        return yPos + 20;
      };

      // Route
      y = sectionHeader('📍  ROUTE INFORMATION', y);
      y = row('Pickup Address', `${job.pickupAddress || ''}, ${job.pickupState}`, y);
      y = row('Delivery Address', `${job.deliveryAddress || ''}, ${job.deliveryState}`, y);
      y = row('Pickup Date', job.createdAt ? new Date(job.createdAt).toLocaleDateString('en-NG', { day: 'numeric', month: 'long', year: 'numeric' }) : '—', y);
      y = row('Deadline', job.deadline ? new Date(job.deadline).toLocaleDateString('en-NG', { day: 'numeric', month: 'long', year: 'numeric' }) : '—', y);
      if (job.pickedUpAt) y = row('Picked Up At', new Date(job.pickedUpAt).toLocaleString('en-NG'), y);
      if (job.deliveredAt) y = row('Delivered At', new Date(job.deliveredAt).toLocaleString('en-NG'), y, true);

      y += 14;

      // Cargo
      y = sectionHeader('📦  CARGO DETAILS', y);
      y = row('Description', job.cargoDescription || '—', y);
      y = row('Weight', job.cargoWeight ? `${job.cargoWeight} kg` : '—', y);
      y = row('Vehicle Type', job.vehicleType || '—', y);
      if (job.acceptedAmount) y = row('Agreed Amount', `₦${Number(job.acceptedAmount).toLocaleString('en-NG')}`, y, true);

      y += 14;

      // Parties
      y = sectionHeader('👥  PARTIES', y);
      const customerName = (job as any).customer?.fullName || `${(job as any).customer?.firstName || ''} ${(job as any).customer?.lastName || ''}`.trim() || '—';
      const transporterName = (job as any).transporter?.fullName || `${(job as any).transporter?.firstName || ''} ${(job as any).transporter?.lastName || ''}`.trim() || 'Not Assigned';
      y = row('Customer (Shipper)', customerName, y);
      y = row('Transporter', transporterName, y);
      if ((job as any).transporter?.vehicleType) y = row('Vehicle', (job as any).transporter.vehicleType, y);

      y += 20;

      // Signature boxes
      if (y < doc.page.height - 160) {
        const colW = (contentW / 2) - 8;
        doc.rect(margin, y, colW, 70).stroke('#E5E7EB');
        doc.fontSize(8).font('Helvetica').fillColor(gray).text('Customer Signature', margin + 8, y + 6);
        doc.moveTo(margin + 8, y + 48).lineTo(margin + colW - 8, y + 48).strokeColor('#CBD5E1').lineWidth(1).stroke();
        doc.fontSize(7).fillColor(gray).text('Date: _______________', margin + 8, y + 55);

        doc.rect(margin + colW + 16, y, colW, 70).stroke('#E5E7EB');
        doc.fontSize(8).font('Helvetica').fillColor(gray).text('Transporter Signature', margin + colW + 24, y + 6);
        doc.moveTo(margin + colW + 24, y + 48).lineTo(pageW - margin - 8, y + 48).strokeColor('#CBD5E1').lineWidth(1).stroke();
        doc.fontSize(7).fillColor(gray).text('Date: _______________', margin + colW + 24, y + 55);

        y += 85;
      }

      // Terms
      doc.fontSize(7).font('Helvetica').fillColor(gray).text(
        'Terms & Conditions: This waybill serves as proof of shipment on the Trac Marketplace platform. The shipper confirms that the cargo description is accurate. Trac Marketplace is not liable for damage caused by improper packaging. Payment is held in escrow and released upon confirmed delivery.',
        margin, y, { width: contentW }
      );

      // Footer
      const footerY = doc.page.height - 40;
      doc.rect(0, footerY, pageW, 40).fill(navy);
      doc.fontSize(7.5).font('Helvetica').fillColor('rgba(255,255,255,0.5)')
        .text('Trac Marketplace  |  tracmarketplace.com  |  support@tracmarketplace.com', margin, footerY + 8, { width: contentW, align: 'center' });
      doc.fontSize(7).fillColor('rgba(255,255,255,0.3)')
        .text(`Generated: ${now.toLocaleString('en-NG')}  |  Waybill ID: ${job.id}`, margin, footerY + 22, { width: contentW, align: 'center' });

      doc.end();
    });
  }
}
