import assert from "node:assert";
import { type Service, type ServiceGroup, Svcm } from "@nats-io/services";
import { type NatsConnection, connect, headers } from "@nats-io/transport-node";
import {
	type Context,
	type Span,
	SpanKind,
	SpanStatusCode,
	context,
	propagation,
	trace,
} from "@opentelemetry/api";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-proto";
import { Resource } from "@opentelemetry/resources";
import { NodeSDK } from "@opentelemetry/sdk-node";
import { ATTR_SERVICE_NAME } from "@opentelemetry/semantic-conventions";
import {
	ATTR_MESSAGING_SYSTEM,
	ATTR_RPC_METHOD,
	ATTR_RPC_SERVICE,
} from "@opentelemetry/semantic-conventions/incubating";
import pino, { type Logger } from "pino";

/**
 * Use init to create a kmicro instance and directly start (init) it
 */
export async function init(
	nats: string,
	serviceName: string,
	version: string,
	description?: string,
) {
	const kmicro = new Kmicro({
		name: serviceName,
		version,
		description,
	});
	await kmicro.init(nats);
	return kmicro;
}

// eslint-disable-next-line @typescript-eslint/consistent-type-definitions
interface Callable {
	call(
		target: string,
		payload: Uint8Array,
		options?: {
			/**
			 * @default 5000 ms
			 */
			timeout?: number;
		},
	): Promise<Uint8Array>;
}

export class Kmicro implements Callable {
	private service: Service | undefined;
	private group: ServiceGroup | undefined;
	private nc: NatsConnection | undefined;
	private otel: NodeSDK | undefined;
	private readonly pinoLogger: pino.Logger;

	constructor(
		private readonly meta: {
			name: string;
			version: string;
			description: string | undefined;
		},
	) {
		this.pinoLogger = pino.pino();
	}

	public getLogger(module?: string) {
		return this.pinoLogger.child({ module });
	}

	public async init(natsURI: string) {
		const natsUrl = new URL(natsURI);
		this.nc = await connect({
			name: this.meta.name,
			user: natsUrl.username,
			pass: natsUrl.password,
			servers: [natsUrl.host],
		});
		const svc = new Svcm(this.nc);
		this.service = await svc.add({
			name: this.meta.name,
			version: this.meta.version,
			description: this.meta.description,
		});
		this.group = this.service.addGroup(this.meta.name);
		this.otel = new NodeSDK({
			serviceName: this.meta.name,
			traceExporter: new OTLPTraceExporter(),
			resource: new Resource({
				[ATTR_SERVICE_NAME]: this.meta.name,
				[ATTR_MESSAGING_SYSTEM]: "nats",
			}),
		});

		this.otel.start();
	}

	public async stop() {
		await this.service?.stop().catch((error: unknown) => {
			console.error(error);
		});
		await this.nc?.close().catch((error: unknown) => {
			console.error(error);
		});
		await this.otel?.shutdown().catch((error: unknown) => {
			console.error(error);
		});
	}

	public addEndpoint(
		name: string,
		handler: (
			context_: RequestContext,
			data: Uint8Array,
		) => Promise<Uint8Array>,
	) {
		assert(this.group);

		this.group.addEndpoint(name, async (error, message) => {
			assert(this.nc);
			if (error) {
				console.error(error);
				return;
			}

			// Prevent infinite loops
			const currentCallDepth = Number.parseInt(
				message.headers?.get("kmc-depth") ?? "0",
				10,
			);
			if (currentCallDepth >= 20) {
				throw new Error(`max call depth reached: ${currentCallDepth}`);
			}

			const contextWithOtel: Context = propagation.extract(
				context.active(),
				message.headers,
				{
					get(carrier, key) {
						return carrier?.get(key);
					},
					keys(carrier) {
						return carrier?.keys() ?? [];
					},
				},
			);

			const tracer = trace.getTracer(this.meta.name, this.meta.version);
			const spanName = `handle: ${this.meta.name}.${name}`;
			await tracer.startActiveSpan(
				spanName,
				{
					kind: SpanKind.SERVER,
				},
				contextWithOtel,
				async (span) => {
					const spanLogger = this.pinoLogger.child({
						action: name,
						spanId: span.spanContext().spanId,
						traceId: span.spanContext().traceId,
					});
					try {
						const header: Record<string, string> = {};
						for (const key of message.headers?.keys() ?? []) {
							if (message.headers?.has(key)) {
								header[key] = message.headers?.get(key);
							}
						}

						const requestContext = new RequestContext(
							contextWithOtel,
							span,
							// biome-ignore lint/style/noNonNullAssertion: Checked with assert
							this.nc!,
							spanLogger,
							{
								callDepth: currentCallDepth,
								currentService: this.meta.name,
								header,
							},
						);
						const result = await handler(requestContext, message.data);
						message.respond(result);
						span.setStatus({ code: SpanStatusCode.OK });
					} catch (error_) {
						span.recordException(error_ as Error);
						message.respondError(500, (error_ as Error).message);
						span.setStatus({ code: SpanStatusCode.ERROR });
					} finally {
						span.end();
					}
				},
			);
		});
	}

	/**
	 * Start a new call
	 */
	public async call(
		target: string,
		payload: Uint8Array,
		options?: {
			/**
			 * @default 5000 ms
			 */
			timeout?: number;
			header?: Record<string, string>;
			moleculerTrace?: {
				traceId?: string | undefined;
				parentId?: string | undefined;
			};
		},
	): Promise<Uint8Array> {
		assert(this.nc);

		let trace:
			| undefined
			| {
					traceId: string;
					parentId: string;
			  };
		if (options?.moleculerTrace) {
			// we have to shorten the moleculer trace id because the jaeger exporter uses only 16 chars
			const molTraceId = options.moleculerTrace.traceId
				?.replaceAll("-", "")
				.slice(0, 16);
			const traceId = Array.from({ length: 16 })
				.fill("0")
				.join("")
				.concat(molTraceId ?? "");
			const molParentId = options.moleculerTrace.parentId
				?.replaceAll("-", "")
				.slice(0, 16);
			trace = {
				traceId,
				parentId: molParentId ?? "",
			};
		}

		return doCall(
			this.nc,
			target,
			payload,
			{
				callDepth: 0,
				context: undefined,
				currentService: this.meta.name,
				header: options?.header ?? {},
			},
			{
				timeout: options?.timeout,
				trace,
			},
		);
	}
}

export class RequestContext {
	// eslint-disable-next-line max-params
	constructor(
		readonly context: Context,
		readonly span: Span,
		readonly nc: NatsConnection,
		private readonly logger: Logger,
		readonly meta: {
			callDepth: number;
			currentService: string;
			header: Record<string, string>;
		},
	) {}

	public getLogger(module?: string) {
		return this.logger.child({
			module,
		});
	}

	public async call(
		target: string,
		payload: Uint8Array,
		options?: {
			/**
			 * @default 5000 ms
			 */
			timeout?: number;
			header?: Record<string, string>;
		},
	): Promise<Uint8Array> {
		return doCall(
			this.nc,
			target,
			payload,
			{
				callDepth: this.meta.callDepth,
				context: this.context,
				currentService: this.meta.currentService,
				header: this.meta.header,
			},
			options,
		);
	}
}

export class CallError extends Error {
	constructor(
		message: string,
		private readonly target: string,
		private readonly payload: Uint8Array,
	) {
		super(message);
		this.name = "CallError";
	}
}

// eslint-disable-next-line max-params
async function doCall(
	nc: NatsConnection,
	target: string,
	payload: Uint8Array,
	meta: {
		callDepth: number;
		/**
		 * The otel context
		 */
		context: Context | undefined;
		currentService: string;
		/**
		 * Headers from the parent calls
		 */
		header: Record<string, string>;
	},
	options?: {
		/**
		 * @default 5000 ms
		 */
		timeout?: number;
		header?: Record<string, string>;
		/**
		 * Optionally pass an existing trace from the moleculer framework
		 */
		trace?: {
			/**
			 * This is the ID of the whole trace forest and is used to uniquely identify a distributed trace through a system.
			 */
			traceId: string | undefined;
			/**
			 * or span id:  This is the ID of this request as known by the caller
			 */
			parentId: string | undefined;
		};
	},
): Promise<Uint8Array> {
	if (meta.callDepth >= 20) {
		throw new Error(`max call depth reached: ${meta.callDepth}`);
	}

	const carrierData: Context | { traceparent?: string } = meta.context ?? {};
	if (options?.trace && !meta.context) {
		const version = Buffer.alloc(1).toString("hex");
		const flags = "01"; // means sampled
		const header = `${version}-${options.trace.traceId}-${options.trace.parentId}-${flags}`;
		(carrierData as { traceparent?: string | undefined }).traceparent = header;
	}

	const callingContext: Context = propagation.extract(
		context.active(),
		carrierData,
	);
	const tracer = trace.getTracer("default");
	const [service, action] = target.split(".");
	return tracer.startActiveSpan(
		`call: ${target}`,
		{
			kind: SpanKind.CLIENT,
			attributes: {
				[ATTR_RPC_SERVICE]: service,
				[ATTR_RPC_METHOD]: action,
			},
		},
		callingContext,
		async (span) => {
			// Add kmicro and otel headers to the nats message headers
			const natsHeadersMap = headers();
			natsHeadersMap.set("kmc-depth", (meta.callDepth + 1).toFixed(0));
			propagation.inject(context.active(), natsHeadersMap, {
				set(carrier, key, value) {
					carrier.set(key, value);
				},
			});
			const mergedHeaders = { ...meta.header, ...options?.header };
			for (const key in mergedHeaders) {
				if (!Object.hasOwn(mergedHeaders, key)) {
					continue;
				}
				if (mergedHeaders[key]) {
					natsHeadersMap.set(key, mergedHeaders[key]);
				}
			}

			try {
				const result = await nc.request(target, payload, {
					headers: natsHeadersMap,
					timeout: options?.timeout ?? 5000,
				});
				if (result.headers?.get("Nats-Service-Error-Code")) {
					span.setStatus({ code: SpanStatusCode.ERROR });
					span.recordException(result.headers.get("Nats-Service-Error"));
					throw new CallError(
						`received error: ${result.headers.get("Nats-Service-Error")}`,
						target,
						payload,
					);
				}

				span.setStatus({ code: SpanStatusCode.OK });
				return result.data;
			} finally {
				span.end();
			}
		},
	);
}
