import { Server as HttpServer } from "node:http";
import { Server as SocketIOServer } from "socket.io";
import { AppRole, PrismaClient } from "@prisma/client";
import { AuthenticatedPrincipal, AuthTokenError, verifyAccessToken } from "../auth";

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

type RealtimeSocketData = {
  principal?: AuthenticatedPrincipal;
};

const AUTHORIZATION_ERROR_EVENT = "authorization.error";

const ALLOWED_REALTIME_ROLES = new Set<AppRole>([
  AppRole.ADMIN,
  AppRole.IT,
  AppRole.MANAGER,
  AppRole.STAFF,
]);

const isNonEmptyString = (value: unknown): value is string =>
  typeof value === "string" && value.trim().length > 0;

const getBearerTokenFromAuthorizationHeader = (
  authorizationHeader: string
): string | null => {
  const bearerPrefix = "Bearer ";
  if (!authorizationHeader.startsWith(bearerPrefix)) {
    return null;
  }

  const token = authorizationHeader.slice(bearerPrefix.length).trim();
  return token.length > 0 ? token : null;
};

const extractAccessTokenFromHandshake = (socket: {
  handshake: {
    auth?: Record<string, unknown>;
    headers?: Record<string, unknown>;
    query?: Record<string, unknown>;
  };
}): string | null => {
  const authTokenCandidate = socket.handshake.auth?.token;
  if (isNonEmptyString(authTokenCandidate)) {
    return authTokenCandidate.trim();
  }

  const authorizationHeader = socket.handshake.headers?.authorization;
  if (isNonEmptyString(authorizationHeader)) {
    return getBearerTokenFromAuthorizationHeader(authorizationHeader.trim());
  }

  const queryTokenCandidate = socket.handshake.query?.token;
  if (isNonEmptyString(queryTokenCandidate)) {
    return queryTokenCandidate.trim();
  }

  return null;
};

const getPrincipalFromSocketData = (
  socket: { data: RealtimeSocketData }
): AuthenticatedPrincipal | null => {
  const principal = socket.data.principal;
  if (!principal) {
    return null;
  }

  if (!ALLOWED_REALTIME_ROLES.has(principal.role)) {
    return null;
  }

  return principal;
};

const emitAuthorizationError = (
  socket: { emit: (event: string, payload: unknown) => void },
  message: string
): void => {
  socket.emit(AUTHORIZATION_ERROR_EVENT, {
    code: "FORBIDDEN",
    message,
  });
};

const isServiceAccessAllowed = async (
  prismaClient: PrismaClient,
  principal: AuthenticatedPrincipal,
  serviceId: string
): Promise<boolean> => {
  if (principal.role === AppRole.ADMIN || principal.role === AppRole.IT) {
    return true;
  }

  if (principal.role === AppRole.STAFF) {
    if (!principal.stationId) {
      return false;
    }

    const station = await prismaClient.counterStation.findUnique({
      where: {
        id: principal.stationId,
      },
      select: {
        serviceId: true,
        isActive: true,
      },
    });

    return Boolean(station?.isActive && station.serviceId === serviceId);
  }

  if (principal.role === AppRole.MANAGER) {
    const service = await prismaClient.service.findUnique({
      where: {
        id: serviceId,
      },
      select: {
        departmentId: true,
        isActive: true,
      },
    });

    if (!service?.isActive) {
      return false;
    }

    const managerAssignment = await prismaClient.roleAssignment.findFirst({
      where: {
        userId: principal.userId,
        role: AppRole.MANAGER,
        departmentId: service.departmentId,
      },
      select: {
        id: true,
      },
    });

    return Boolean(managerAssignment);
  }

  return false;
};

const isStationAccessAllowed = async (
  prismaClient: PrismaClient,
  principal: AuthenticatedPrincipal,
  stationId: string
): Promise<boolean> => {
  if (principal.role === AppRole.ADMIN || principal.role === AppRole.IT) {
    return true;
  }

  const station = await prismaClient.counterStation.findUnique({
    where: {
      id: stationId,
    },
    select: {
      id: true,
      isActive: true,
      service: {
        select: {
          departmentId: true,
        },
      },
    },
  });

  if (!station?.isActive) {
    return false;
  }

  if (principal.role === AppRole.STAFF) {
    return principal.stationId === station.id;
  }

  if (principal.role === AppRole.MANAGER) {
    const managerAssignment = await prismaClient.roleAssignment.findFirst({
      where: {
        userId: principal.userId,
        role: AppRole.MANAGER,
        departmentId: station.service.departmentId,
      },
      select: {
        id: true,
      },
    });

    return Boolean(managerAssignment);
  }

  return false;
};

export const __realtimeTestables = {
  isServiceAccessAllowed,
  isStationAccessAllowed,
};

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
    if (event.serviceId) {
      this.socketServer.to(`service:${event.serviceId}`).emit("queue.updated", event);
      return;
    }

    this.socketServer.emit("queue.updated", event);
  }

  broadcastNowServingUpdated(event: QueueRealtimeEvent): void {
    const serviceRoom = event.serviceId ? `service:${event.serviceId}` : null;
    const stationRoom = event.stationId ? `station:${event.stationId}` : null;

    if (serviceRoom && stationRoom) {
      this.socketServer
        .to(serviceRoom)
        .to(stationRoom)
        .emit("now-serving.updated", event);
      return;
    }

    if (serviceRoom) {
      this.socketServer.to(serviceRoom).emit("now-serving.updated", event);
      return;
    }

    if (stationRoom) {
      this.socketServer.to(stationRoom).emit("now-serving.updated", event);
      return;
    }

    this.socketServer.emit("now-serving.updated", event);
  }
}

export const createRealtimeSocketServer = (
  prismaClient: PrismaClient,
  jwtAccessTokenSecret: string,
  corsAllowedOrigins: "*" | string[]
): SocketIOServer => {
  const socketServer = new SocketIOServer({
    path: "/realtime/socket.io",
    cors: {
      origin: corsAllowedOrigins,
    },
  });

  socketServer.use((socket, next) => {
    try {
      const accessToken = extractAccessTokenFromHandshake(socket);
      if (!accessToken) {
        next(new Error("UNAUTHORIZED"));
        return;
      }

      const claims = verifyAccessToken(accessToken, jwtAccessTokenSecret);

      const principal: AuthenticatedPrincipal = {
        userId: claims.sub,
        role: claims.role,
        stationId: claims.stationId,
      };

      if (!ALLOWED_REALTIME_ROLES.has(principal.role)) {
        next(new Error("FORBIDDEN"));
        return;
      }

      (socket.data as RealtimeSocketData).principal = principal;
      next();
    } catch (error: unknown) {
      if (error instanceof AuthTokenError) {
        next(new Error("UNAUTHORIZED"));
        return;
      }

      next(new Error("UNAUTHORIZED"));
    }
  });

  socketServer.on("connection", (socket) => {
    socket.on("disconnect", (reason: string) => {
      const principal = getPrincipalFromSocketData(
        socket as unknown as { data: RealtimeSocketData }
      );

      console.log("[realtime] client disconnected", {
        socketId: socket.id,
        userId: principal?.userId,
        role: principal?.role,
        reason,
      });
    });

    socket.on("subscribe.service", async (serviceId: string) => {
      if (!isNonEmptyString(serviceId)) {
        emitAuthorizationError(socket, "serviceId is required");
        return;
      }

      const principal = getPrincipalFromSocketData(
        socket as unknown as { data: RealtimeSocketData }
      );
      if (!principal) {
        emitAuthorizationError(socket, "Authentication is required");
        return;
      }

      try {
        const normalizedServiceId = serviceId.trim();
        const allowed = await isServiceAccessAllowed(
          prismaClient,
          principal,
          normalizedServiceId
        );

        if (!allowed) {
          emitAuthorizationError(socket, "Not authorized for requested service");
          return;
        }

        socket.join(`service:${normalizedServiceId}`);
      } catch (error: unknown) {
        console.error("[realtime] service subscription authorization failed", {
          userId: principal.userId,
          serviceId,
          error,
        });
        emitAuthorizationError(socket, "Authorization check failed");
      }
    });

    socket.on("subscribe.station", async (stationId: string) => {
      if (!isNonEmptyString(stationId)) {
        emitAuthorizationError(socket, "stationId is required");
        return;
      }

      const principal = getPrincipalFromSocketData(
        socket as unknown as { data: RealtimeSocketData }
      );
      if (!principal) {
        emitAuthorizationError(socket, "Authentication is required");
        return;
      }

      try {
        const normalizedStationId = stationId.trim();
        const allowed = await isStationAccessAllowed(
          prismaClient,
          principal,
          normalizedStationId
        );

        if (!allowed) {
          emitAuthorizationError(socket, "Not authorized for requested station");
          return;
        }

        socket.join(`station:${normalizedStationId}`);
      } catch (error: unknown) {
        console.error("[realtime] station subscription authorization failed", {
          userId: principal.userId,
          stationId,
          error,
        });
        emitAuthorizationError(socket, "Authorization check failed");
      }
    });
  });

  return socketServer;
};

export const attachRealtimeSocketServer = (
  socketServer: SocketIOServer,
  httpServer: HttpServer
): void => {
  // Socket.IO's `attach` expects a richer Node server surface (including http2 variants).
  // This workspace uses a minimal local `node:http` shim (`src/types/node-shim.d.ts`) that
  // does not model the full structural type, so we cast at the boundary while still passing
  // the concrete HTTP server instance created by the runtime.
  socketServer.attach(httpServer as unknown as Parameters<SocketIOServer["attach"]>[0]);
};
