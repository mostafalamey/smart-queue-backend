import { DynamicModule, Module } from "@nestjs/common";
import { ApiRequestHandler } from "../api/server";
import {
  ApiGatewayController,
  API_REQUEST_HANDLER,
} from "./api-gateway.controller";

@Module({})
export class AppModule {
  static register(requestHandler: ApiRequestHandler): DynamicModule {
    return {
      module: AppModule,
      controllers: [ApiGatewayController],
      providers: [
        {
          provide: API_REQUEST_HANDLER,
          useValue: requestHandler,
        },
      ],
    };
  }
}
