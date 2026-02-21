declare module "node:crypto" {
  export interface Hmac {
    update(data: string): Hmac;
    digest(encoding: "base64" | "hex"): string;
  }

  export function createHmac(algorithm: string, key: string): Hmac;
  export function timingSafeEqual(left: Buffer, right: Buffer): boolean;
}

declare class Buffer {
  static from(data: string, encoding: "base64" | "utf8"): Buffer;
  readonly length: number;
  toString(encoding: "utf8" | "base64"): string;
}
