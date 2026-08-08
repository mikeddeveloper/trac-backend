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
})
export class EventsGateway
  implements OnGatewayInit, OnGatewayConnection, OnGatewayDisconnect
{
  @WebSocketServer()
  server!: Server;

  private readonly logger = new Logger(EventsGateway.name);
  private userSocketMap = new Map<string, string>();
  private socketUserMap = new Map<string, string>();
  private jobLocationMap = new Map<string, { lat: number; lng: number; updatedAt: Date }>();
  private pendingNotifications = new Map<string, Array<{ event: string; data: any }>>();

  constructor(
    private jwtService: JwtService,
    private configService: ConfigService,
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
      this.userSocketMap.set(userId, client.id);
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
      this.userSocketMap.delete(userId);
      this.socketUserMap.delete(client.id);
      this.logger.log(`❌ User ${userId} disconnected`);
    }
  }

  // ─── Notify specific user ─────────────────────────────────────────────────

  notifyUser(userId: string, event: string, data: any) {
    const socketId = this.userSocketMap.get(userId);
    if (socketId) {
      this.server.to(socketId).emit(event, data);
      this.logger.log(`📡 Emitted '${event}' to user ${userId}`);
    } else {
      const existing = this.pendingNotifications.get(userId) || [];
      existing.push({ event, data });
      this.pendingNotifications.set(userId, existing);
      this.logger.log(`📬 Queued '${event}' for user ${userId} (not connected)`);
    }
  }

  // ─── Location update from transporter ────────────────────────────────────

  @SubscribeMessage('transporter:locationUpdate')
  handleLocationUpdate(
    @MessageBody() data: { jobId: string; lat: number; lng: number; customerId: string },
    @ConnectedSocket() client: Socket,
  ) {
    const { jobId, lat, lng, customerId } = data;
    this.jobLocationMap.set(jobId, { lat, lng, updatedAt: new Date() });
    this.logger.log(`📍 Location update job ${jobId}: ${lat}, ${lng}`);
    this.notifyUser(customerId, 'job:locationUpdate', { jobId, lat, lng, updatedAt: new Date() });
  }

  // ─── Call accepted ────────────────────────────────────────────────────────

  @SubscribeMessage('call:accepted')
  handleCallAccepted(
    @MessageBody() data: { jobId: string },
    @ConnectedSocket() client: Socket,
  ) {
    this.server.emit(`call:accepted:${data.jobId}`, data);
    this.logger.log(`📞 Call accepted for job ${data.jobId}`);
  }

  // ─── Call declined ────────────────────────────────────────────────────────

  @SubscribeMessage('call:declined')
  handleCallDeclined(
    @MessageBody() data: { jobId: string },
    @ConnectedSocket() client: Socket,
  ) {
    this.server.emit(`call:declined:${data.jobId}`, data);
    this.logger.log(`📵 Call declined for job ${data.jobId}`);
  }

  // ─── Call cancelled ───────────────────────────────────────────────────────

  @SubscribeMessage('call:cancelled')
  handleCallCancelled(
    @MessageBody() data: { jobId: string },
    @ConnectedSocket() client: Socket,
  ) {
    this.server.emit(`call:cancelled:${data.jobId}`, data);
    this.logger.log(`❌ Call cancelled for job ${data.jobId}`);
  }

  // ─── Helpers ──────────────────────────────────────────────────────────────

  getJobLocation(jobId: string) {
    return this.jobLocationMap.get(jobId) || null;
  }

  broadcast(event: string, data: any) {
    this.server.emit(event, data);
  }
}