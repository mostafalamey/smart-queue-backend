import { All, Controller, Inject, Req, Res } from "@nestjs/common";
import type { Request, Response } from "express";
import type { IncomingMessage, ServerResponse } from "node:http";
import { ApiRequestHandler } from "../api/server";

export const API_REQUEST_HANDLER = Symbol("API_REQUEST_HANDLER");

@Controller()
export class ApiGatewayController {
  constructor(
    @Inject(API_REQUEST_HANDLER)
    private readonly requestHandler: ApiRequestHandler
  ) {}

  @All("*")
  async handle(
    @Req() request: Request,
    @Res() response: Response
  ): Promise<void> {
    await this.requestHandler(
      request as unknown as IncomingMessage,
      response as unknown as ServerResponse
    );
  }
}
