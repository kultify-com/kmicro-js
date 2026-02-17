# kmicro-js

Simple microservice framework based on [NATS micro](https://github.com/nats-io/nats.js/tree/main/services).

Features:

- Request/response RPC over NATS with binary payloads
- OpenTelemetry distributed tracing (context propagation across service calls)
- Automatic header propagation through call chains
- Call depth limiting (max 20) to prevent infinite loops
- Pino JSON logging with trace/span correlation

## Install

```bash
npm install @kultify/kmicro-js
```

## OpenTelemetry Setup

kmicro-js uses the [OpenTelemetry API](https://opentelemetry.io/docs/languages/js/libraries/) to create spans and propagate trace context. It does **not** initialize the OTel SDK — your application is responsible for that.

If no SDK is registered, tracing becomes a no-op.

Create an `instrumentation.ts` file and load it **before** any other imports:

```typescript
// instrumentation.ts
import { NodeSDK } from "@opentelemetry/sdk-node";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-proto";
import { resourceFromAttributes } from "@opentelemetry/resources";
import { PinoInstrumentation } from "@opentelemetry/instrumentation-pino";
import { ATTR_SERVICE_NAME } from "@opentelemetry/semantic-conventions";
import { ATTR_MESSAGING_SYSTEM } from "@opentelemetry/semantic-conventions/incubating";

const sdk = new NodeSDK({
  resource: resourceFromAttributes({
    [ATTR_SERVICE_NAME]: "my-service",
    [ATTR_MESSAGING_SYSTEM]: "nats",
  }),
  traceExporter: new OTLPTraceExporter(),
  instrumentations: [
    new PinoInstrumentation({ disableLogSending: true }),
  ],
});

sdk.start();
```

Then load it first via Node's `--import` flag:

```bash
node --import ./instrumentation.js ./main.js
```

Required OTel packages for the application:

```bash
npm install @opentelemetry/sdk-node @opentelemetry/exporter-trace-otlp-proto \
  @opentelemetry/resources @opentelemetry/semantic-conventions \
  @opentelemetry/instrumentation-pino
```

## Usage

```typescript
import { init } from "@kultify/kmicro-js";

const service = await init("nats://localhost:4222", "my-service", "0.0.1");

// Register an endpoint
service.addEndpoint("greet", async (context, data) => {
  const request = JSON.parse(Buffer.from(data).toString());
  const logger = context.getLogger("greet");
  logger.info({ request }, "received greeting request");

  return Buffer.from(JSON.stringify({ hello: request.name }));
});

// Call another service
const result = await service.call(
  "other-service.action",
  Buffer.from(JSON.stringify({ key: "value" })),
);

// Call with custom headers and timeout
const result2 = await service.call(
  "other-service.action",
  Buffer.from(JSON.stringify({ key: "value" })),
  {
    timeout: 10000,
    header: { "X-Auth": "token" },
  },
);

// Downstream calls from within a handler preserve trace context and headers
service.addEndpoint("orchestrate", async (context, data) => {
  const downstream = await context.call(
    "other-service.action",
    Buffer.from(JSON.stringify({ foo: "bar" })),
  );
  return downstream;
});

// Graceful shutdown
await service.stop();
```

## License

MIT
