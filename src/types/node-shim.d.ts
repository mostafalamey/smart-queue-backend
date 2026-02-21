declare module "node:http" {
  export interface IncomingMessage {
    method?: string;
    url?: string;
    destroy(error?: Error): void;
    [Symbol.asyncIterator](): AsyncIterator<string | Uint8Array>;
  }

  export interface ServerResponse {
    statusCode: number;
    setHeader(name: string, value: string): void;
    end(body?: string): void;
  }

  export interface Server {
    listen(port: number, callback?: () => void): void;
    close(callback?: () => void): void;
  }

  export function createServer(
    handler: (request: IncomingMessage, response: ServerResponse) => void | Promise<void>
  ): Server;
}

declare const process: {
  env: Record<string, string | undefined>;
  on(event: string, listener: () => void): void;
  exit(code?: number): never;
};
