import { Server as HttpServer } from "node:http";
import { Server as SocketIOServer } from "socket.io";

export interface QueueRealtimeEvent {
  requestId: string;
  operation: string;
  ticketId?: string;
  serviceId?: string;
  stationId?: string;
  occurredAt: string;
}

export interface QueueRealtimeBroadcaster {
  broadcastQueueUpdated(event: QueueRealtimeEvent): void;
  broadcastNowServingUpdated(event: QueueRealtimeEvent): void;
}

export class NoopQueueRealtimeBroadcaster implements QueueRealtimeBroadcaster {
  broadcastQueueUpdated(_event: QueueRealtimeEvent): void {
    return;
  }

  broadcastNowServingUpdated(_event: QueueRealtimeEvent): void {
    return;
  }
}

export class SocketIoQueueRealtimeBroadcaster
  implements QueueRealtimeBroadcaster
{
  constructor(private readonly socketServer: SocketIOServer) {}

  broadcastQueueUpdated(event: QueueRealtimeEvent): void {
    this.socketServer.emit("queue.updated", event);

    if (event.serviceId) {
      this.socketServer
        .to(`service:${event.serviceId}`)
        .emit("queue.updated", event);
    }
  }

  broadcastNowServingUpdated(event: QueueRealtimeEvent): void {
    this.socketServer.emit("now-serving.updated", event);

    if (event.serviceId) {
      this.socketServer
        .to(`service:${event.serviceId}`)
        .emit("now-serving.updated", event);
    }

    if (event.stationId) {
      this.socketServer
        .to(`station:${event.stationId}`)
        .emit("now-serving.updated", event);
    }
  }
}

export const createRealtimeSocketServer = (): SocketIOServer => {
  const socketServer = new SocketIOServer({
    path: "/realtime/socket.io",
    cors: {
      origin: "*",
    },
  });

  socketServer.on("connection", (socket) => {
    socket.on("subscribe.service", (serviceId: string) => {
      if (typeof serviceId === "string" && serviceId.trim().length > 0) {
        socket.join(`service:${serviceId.trim()}`);
      }
    });

    socket.on("subscribe.station", (stationId: string) => {
      if (typeof stationId === "string" && stationId.trim().length > 0) {
        socket.join(`station:${stationId.trim()}`);
      }
    });
  });

  return socketServer;
};

export const attachRealtimeSocketServer = (
  socketServer: SocketIOServer,
  httpServer: HttpServer
): void => {
  socketServer.attach(httpServer as unknown as Parameters<SocketIOServer["attach"]>[0]);
};
