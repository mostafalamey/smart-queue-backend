import { __serverTestables } from "../server";

const equal = (actual: unknown, expected: unknown, message?: string): void => {
  if (actual !== expected) {
    throw new Error(message ?? `Expected ${String(expected)} but got ${String(actual)}`);
  }
};

const runTest = (name: string, fn: () => void): void => {
  try {
    fn();
  } catch (error: unknown) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(`[server-realtime] ${name} failed: ${reason}`);
  }
};

runTest("extractRealtimeTicketId resolves direct ticket id fields", () => {
  equal(
    __serverTestables.extractRealtimeTicketId({ id: "ticket-1" }),
    "ticket-1"
  );

  equal(
    __serverTestables.extractRealtimeTicketId({ ticketId: "ticket-2" }),
    "ticket-2"
  );
});

runTest("extractRealtimeTicketId resolves nested transfer ticket fields", () => {
  equal(
    __serverTestables.extractRealtimeTicketId({
      destinationTicket: {
        id: "ticket-destination",
      },
    }),
    "ticket-destination"
  );

  equal(
    __serverTestables.extractRealtimeTicketId({
      sourceTicket: {
        id: "ticket-source",
      },
    }),
    "ticket-source"
  );
});

runTest("extractRealtimeServiceId resolves service and fallback fields", () => {
  equal(
    __serverTestables.extractRealtimeServiceId({ serviceId: "service-1" }),
    "service-1"
  );

  equal(
    __serverTestables.extractRealtimeServiceId(
      {
        destinationTicket: {
          serviceId: "service-2",
        },
      },
      "fallback-service"
    ),
    "service-2"
  );

  equal(
    __serverTestables.extractRealtimeServiceId({}, "fallback-service"),
    "fallback-service"
  );
});

runTest("extractRealtime helpers return undefined for malformed bodies", () => {
  equal(__serverTestables.extractRealtimeTicketId(null), undefined);
  equal(__serverTestables.extractRealtimeTicketId("invalid-body"), undefined);
  equal(__serverTestables.extractRealtimeServiceId(null), undefined);
  equal(__serverTestables.extractRealtimeServiceId("invalid-body"), undefined);
});

runTest("shouldEmitNowServingUpdate allows serving-state-changing operations", () => {
  equal(__serverTestables.shouldEmitNowServingUpdate("teller.call-next"), true);
  equal(__serverTestables.shouldEmitNowServingUpdate("teller.recall"), true);
  equal(__serverTestables.shouldEmitNowServingUpdate("teller.start-serving"), true);
  equal(__serverTestables.shouldEmitNowServingUpdate("teller.complete"), true);
  equal(__serverTestables.shouldEmitNowServingUpdate("teller.skip-no-show"), true);
  equal(__serverTestables.shouldEmitNowServingUpdate("teller.transfer"), true);
});

runTest("shouldEmitNowServingUpdate blocks queue-only operations", () => {
  equal(__serverTestables.shouldEmitNowServingUpdate("teller.change-priority"), false);
  equal(__serverTestables.shouldEmitNowServingUpdate("unknown.operation"), false);
});
