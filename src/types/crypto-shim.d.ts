declare module "node:crypto" {
  export interface ScryptOptions {
    N?: number;
    r?: number;
    p?: number;
    maxmem?: number;
  }

  export interface Hmac {
    update(data: string): Hmac;
    digest(encoding: "base64" | "hex"): string;
  }

  export function createHmac(algorithm: string, key: string): Hmac;
  export function randomBytes(size: number): Buffer;
  export function scryptSync(
    password: string,
    salt: Buffer,
    keylen: number,
    options?: ScryptOptions
  ): Buffer;
  export function timingSafeEqual(left: Buffer, right: Buffer): boolean;
}

declare class Buffer {
  static alloc(size: number, fill?: number): Buffer;
  static from(data: string, encoding: "base64" | "utf8" | "hex"): Buffer;
  readonly length: number;
  copy(
    target: Buffer,
    targetStart?: number,
    sourceStart?: number,
    sourceEnd?: number
  ): number;
  toString(encoding: "utf8" | "base64" | "hex"): string;
}
