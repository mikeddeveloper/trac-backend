// trac-backend/src/events/events.gateway.ts
// Day 15 + Day 26: Location updates + Call signaling

import {
  WebSocketGateway,
  WebSocketServer,
  OnGatewayConnection,
  OnGatewayDisconnect,
  OnGatewayInit,
  SubscribeMessage,
  MessageBody,
  ConnectedSocket,
} from '@nestjs/websockets';
import { Server, Socket } from 'socket.io';
import { Logger } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Job, JobStatus } from '../jobs/entities/job.entity';

const WS_ALLOWED_ORIGINS = [
  'https://traclogistics.com.ng',
  'https://www.traclogistics.com.ng',
  'https://trac-logistics-web-app.vercel.app',
  'http://localhost:5173',
  'http://localhost:3000',
];

@WebSocketGateway({
  cors: {
    origin: (origin: string, cb: (err: Error | null, allow?: boolean) => void) => {
      cb(null, !origin || WS_ALLOWED_ORIGINS.includes(origin));
    },
    credentials: true,
    methods: ['GET', 'POST'],
  },
  transports: ['websocket', 'polling'],
  namespace: '/',
  // Keep connections alive through Render's proxy timeout (60s default)
  pingInterval: 20000,
  pingTimeout: 10000,
})
export class EventsGateway
  implements OnGatewayInit, OnGatewayConnection, OnGatewayDisconnect
{
  @WebSocketServer()
  server!: Server;

  private readonly logger = new Logger(EventsGateway.name);
  // A user can have the notification socket plus a tracking-page socket (and
  // may also be signed in on phone and desktop). Keep every live socket so a
  // later connection does not silently steal location updates from the map.
  private userSocketMap = new Map<string, Set<string>>();
  private socketUserMap = new Map<string, string>();
  private jobLocationMap = new Map<string, { lat: number; lng: number; accuracy?: number; speed?: number; updatedAt: Date }>();
  private pendingNotifications = new Map<string, Array<{ event: string; data: any }>>();
  private lastLocationUpdate = new Map<string, number>();

  constructor(
    private jwtService: JwtService,
    private configService: ConfigService,
    @InjectRepository(Job)
    private readonly jobRepo: Repository<Job>,
  ) {}

  afterInit() {
    this.logger.log('⚡ WebSocket Gateway initialized');
  }

  async handleConnection(client: Socket) {
    try {
      const token =
        (client.handshake.auth?.token as string) ||
        (client.handshake.headers?.authorization as string);

      if (!token) { client.disconnect(); return; }

      const cleanToken = token.replace('Bearer ', '');
      const payload = this.jwtService.verify(cleanToken, {
        secret: this.configService.get<string>('JWT_SECRET'),
      });

      const userId = payload.sub;
      const userSockets = this.userSocketMap.get(userId) || new Set<string>();
      userSockets.add(client.id);
      this.userSocketMap.set(userId, userSockets);
      this.socketUserMap.set(client.id, userId);
      client.data.userId = userId;

      this.logger.log(`✅ User ${userId} connected via socket ${client.id}`);
      client.emit('connected', { message: 'Socket connected', userId });

      const pending = this.pendingNotifications.get(userId);
      if (pending && pending.length > 0) {
        pending.forEach(({ event, data }) => {
          client.emit(event, data);
          this.logger.log(`📨 Delivered queued '${event}' to ${userId}`);
        });
        this.pendingNotifications.delete(userId);
      }
    } catch (err) {
      this.logger.warn(`Socket auth failed: ${(err as any).message}`);
      client.disconnect();
    }
  }

  handleDisconnect(client: Socket) {
    const userId = client.data?.userId;
    if (userId) {
      const userSockets = this.userSocketMap.get(userId);
      userSockets?.delete(client.id);
      if (userSockets?.size === 0) this.userSocketMap.delete(userId);
      this.socketUserMap.delete(client.id);
      this.logger.log(`❌ User ${userId} disconnected`);
      for (const key of this.lastLocationUpdate.keys()) {
        if (key.startsWith(`${userId}:`)) this.lastLocationUpdate.delete(key);
      }
    }
  }

  // ─── Notify specific user ─────────────────────────────────────────────────

  notifyUser(userId: string, event: string, data: any) {
    const socketIds = this.userSocketMap.get(userId);
    if (socketIds?.size) {
      socketIds.forEach(socketId => this.server.to(socketId).emit(event, data));
      this.logger.log(`📡 Emitted '${event}' to user ${userId}`);
    } else {
      const existing = this.pendingNotifications.get(userId) || [];
      existing.push({ event, data });
      if (existing.length > 50) {
        existing.splice(0, existing.length - 50);
      }
      this.pendingNotifications.set(userId, existing);
      this.logger.log(`📬 Queued '${event}' for user ${userId} (not connected)`);
    }
  }

  emitToConnectedUser(userId: string, event: string, data: any): boolean {
    const socketIds = this.userSocketMap.get(userId);
    if (!socketIds?.size) return false;
    socketIds.forEach(socketId => this.server.to(socketId).emit(event, data));
    return true;
  }

  // ─── Location update from transporter ────────────────────────────────────

  @SubscribeMessage('transporter:locationUpdate')
  async handleLocationUpdate(
    @MessageBody() data: { jobId: string; lat: number; lng: number; accuracy?: number; speed?: number },
    @ConnectedSocket() client: Socket,
  ) {
    const { jobId, lat, lng, accuracy, speed } = data;
    if (
      !jobId ||
      !Number.isFinite(lat) ||
      !Number.isFinite(lng) ||
      Math.abs(lat) > 90 ||
      Math.abs(lng) > 180
    ) {
      return { ok: false, error: 'Invalid location update' };
    }

    const job = await this.jobRepo.findOne({ where: { id: jobId } });
    if (!job || job.transporterId !== client.data.userId || !job.customerId) {
      return { ok: false, error: 'Not authorized for this job' };
    }
    if (job.status !== JobStatus.IN_TRANSIT) {
      return { ok: false, error: 'Live location is only available for paid, in-transit jobs' };
    }

    const rateKey = `${client.data.userId}:${jobId}`;
    const now = Date.now();
    if (now - (this.lastLocationUpdate.get(rateKey) || 0) < 3000) {
      return { ok: false, error: 'Location updates are limited to one every 3 seconds' };
    }
    this.lastLocationUpdate.set(rateKey, now);

    const updatedAt = new Date();
    const location = {
      lat,
      lng,
      accuracy: Number.isFinite(accuracy) ? accuracy : undefined,
      speed: Number.isFinite(speed) ? speed : undefined,
      updatedAt,
    };
    this.jobLocationMap.set(jobId, location);
    await this.jobRepo.update(jobId, {
      lastKnownLat: lat,
      lastKnownLng: lng,
      lastLocationAccuracy: location.accuracy ?? null as any,
      lastLocationSpeed: location.speed ?? null as any,
      lastLocationAt: updatedAt,
    });
    if (process.env.NODE_ENV !== 'production') this.logger.debug(`Location updated for job ${jobId}`);
    this.notifyUser(job.customerId, 'job:locationUpdate', { jobId, ...location });
    return { ok: true };
  }

  @SubscribeMessage('job:getLocation')
  async handleGetLocation(
    @MessageBody() data: { jobId: string },
    @ConnectedSocket() client: Socket,
  ) {
    if (!data?.jobId) return { ok: false, error: 'Job ID is required' };
    const job = await this.jobRepo.findOne({ where: { id: data.jobId } });
    if (!job || ![job.customerId, job.transporterId].includes(client.data.userId)) {
      return { ok: false, error: 'Not authorized for this job' };
    }
    const memoryLocation = this.jobLocationMap.get(data.jobId);
    const location = memoryLocation || (Number.isFinite(Number(job.lastKnownLat)) && Number.isFinite(Number(job.lastKnownLng)) && job.lastLocationAt ? {
      lat: Number(job.lastKnownLat), lng: Number(job.lastKnownLng), accuracy: job.lastLocationAccuracy == null ? undefined : Number(job.lastLocationAccuracy),
      speed: job.lastLocationSpeed == null ? undefined : Number(job.lastLocationSpeed), updatedAt: job.lastLocationAt,
    } : null);
    return location ? { ok: true, jobId: data.jobId, ...location } : { ok: true, jobId: data.jobId, location: null };
  }

  // ─── Call accepted ────────────────────────────────────────────────────────

  @SubscribeMessage('call:accepted')
  async handleCallAccepted(
    @MessageBody() data: { jobId: string },
    @ConnectedSocket() client: Socket,
  ) {
    const job = await this.getAuthorizedCallJob(data.jobId, client.data.userId, 'transporter');
    if (!job) return { ok: false, error: 'Not authorized for this call' };
    this.emitToConnectedUser(job.customerId, `call:accepted:${data.jobId}`, data);
    this.logger.log(`📞 Call accepted for job ${data.jobId}`);
  }

  // ─── Call declined ────────────────────────────────────────────────────────

  @SubscribeMessage('call:declined')
  async handleCallDeclined(
    @MessageBody() data: { jobId: string },
    @ConnectedSocket() client: Socket,
  ) {
    const job = await this.getAuthorizedCallJob(data.jobId, client.data.userId, 'transporter');
    if (!job) return { ok: false, error: 'Not authorized for this call' };
    this.emitToConnectedUser(job.customerId, `call:declined:${data.jobId}`, data);
    this.logger.log(`📵 Call declined for job ${data.jobId}`);
  }

  // ─── Call cancelled ───────────────────────────────────────────────────────

  @SubscribeMessage('call:cancelled')
  async handleCallCancelled(
    @MessageBody() data: { jobId: string },
    @ConnectedSocket() client: Socket,
  ) {
    const job = await this.getAuthorizedCallJob(data.jobId, client.data.userId);
    if (!job) return { ok: false, error: 'Not authorized for this call' };
    const recipientId = job.customerId === client.data.userId ? job.transporterId : job.customerId;
    if (recipientId) this.emitToConnectedUser(recipientId, `call:cancelled:${data.jobId}`, data);
    this.logger.log(`❌ Call cancelled for job ${data.jobId}`);
  }

  // ─── Helpers ──────────────────────────────────────────────────────────────

  getJobLocation(jobId: string) {
    return this.jobLocationMap.get(jobId) || null;
  }

  private async getAuthorizedCallJob(jobId: string, userId: string, requiredRole?: 'transporter') {
    if (!jobId || !userId) return null;
    const job = await this.jobRepo.findOne({ where: { id: jobId } });
    if (!job || (job.customerId !== userId && job.transporterId !== userId)) return null;
    if (requiredRole === 'transporter' && job.transporterId !== userId) return null;
    return job;
  }

  broadcast(event: string, data: any) {
    this.server.emit(event, data);
  }
}
