import assert from 'node:assert';
import {Svc, type Service, type ServiceGroup} from '@nats-io/services';
import {
	connect,
	headers,
	JSONCodec,
	type NatsConnection,
} from '@nats-io/transport-node';
import {
	context,
	propagation,
	SpanKind,
	SpanStatusCode,
	trace,
	type Context,
	type Span,
} from '@opentelemetry/api';
import {OTLPTraceExporter} from '@opentelemetry/exporter-trace-otlp-proto';
import {Resource} from '@opentelemetry/resources';
import {NodeSDK} from '@opentelemetry/sdk-node';
import {
	ATTR_MESSAGING_SYSTEM,
	ATTR_RPC_METHOD,
	ATTR_RPC_SERVICE,
	ATTR_SERVICE_NAME,
} from '@opentelemetry/semantic-conventions/incubating';
import pino, {type Logger} from 'pino';

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

const codec = JSONCodec(); // eslint-disable-line new-cap

// eslint-disable-next-line @typescript-eslint/consistent-type-definitions
interface Callable {
	call(
		target: string,
		payload: Record<string, any>,
		options?: {
			/**
			 * @default 5000 ms
			 */
			timeout?: number;
		},
	): Promise<Record<string, unknown>>;
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
		return this.pinoLogger.child({module});
	}

	public async init(natsConnection: string) {
		this.nc = await connect({
			name: this.meta.name,
			servers: natsConnection,
		});
		const svc = new Svc(this.nc);
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
				[ATTR_MESSAGING_SYSTEM]: 'nats',
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
			data: Record<string, any>,
		) => Promise<Record<string, any>>,
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
				message.headers?.get('kmc-depth') ?? '0',
				10,
			);
			if (currentCallDepth >= 20) {
				throw new Error('max call depth reached: ' + currentCallDepth);
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

			const tracer = trace.getTracer(name, this.meta.version);
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
						const requestContext = new RequestContext(
							contextWithOtel,
							span,
							this.nc!,
							spanLogger,
							{
								callDepth: currentCallDepth,
								currentService: this.meta.name,
							},
						);
						const result = await handler(requestContext, message.json());
						message.respond(codec.encode(result));
						span.setStatus({code: SpanStatusCode.OK});
					} catch (error_) {
						span.recordException(error_ as Error);
						message.respondError(500, (error_ as Error).message);
						span.setStatus({code: SpanStatusCode.ERROR});
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
		payload: Record<string, any>,
		options?: {
			/**
			 * @default 5000 ms
			 */
			timeout?: number;
		},
	): Promise<Record<string, unknown>> {
		assert(this.nc);
		return doCall(
			this.nc,
			target,
			payload,
			{
				callDepth: 0,
				context: undefined,
				currentService: this.meta.name,
			},
			options,
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
		},
	) {}

	public getLogger(module?: string) {
		return this.logger.child({
			module,
		});
	}

	public async call(
		target: string,
		payload: Record<string, any>,
		options?: {
			/**
			 * @default 5000 ms
			 */
			timeout?: number;
		},
	): Promise<Record<string, unknown>> {
		return doCall(
			this.nc,
			target,
			payload,
			{
				callDepth: this.meta.callDepth,
				context: this.context,
				currentService: this.meta.currentService,
			},
			options,
		);
	}
}

export class CallError extends Error {
	constructor(
		message: string,
		private readonly target: string,
		private readonly payload: Record<string, unknown>,
	) {
		super(message);
		this.name = 'CallError';
	}
}

// eslint-disable-next-line max-params
async function doCall(
	nc: NatsConnection,
	target: string,
	payload: Record<string, any>,
	meta: {
		callDepth: number;
		/**
		 * The otel context
		 */
		context: Context | undefined;
		currentService: string;
	},
	options?: {
		/**
		 * @default 5000 ms
		 */
		timeout?: number;
	},
): Promise<Record<string, unknown>> {
	if (meta.callDepth >= 20) {
		throw new Error('max call depth reached: ' + meta.callDepth);
	}

	const callingContext: Context = propagation.extract(
		context.active(),
		meta.context ?? {},
	);
	const tracer = trace.getTracer('default');
	const [service, action] = target.split('.');
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
			natsHeadersMap.set('kmc-depth', (meta.callDepth + 1).toFixed(0));
			propagation.inject(context.active(), natsHeadersMap, {
				set(carrier, key, value) {
					carrier.set(key, value);
				},
			});

			try {
				const result = await nc.request(target, codec.encode(payload), {
					headers: natsHeadersMap,
					timeout: options?.timeout ?? 5000,
				});
				span.setStatus({code: SpanStatusCode.OK});
				if (result.headers?.get('Nats-Service-Error-Code')) {
					span.setStatus({code: SpanStatusCode.ERROR});
					span.recordException(result.headers.get('Nats-Service-Error'));
					throw new CallError(
						'received error: ' + result.headers.get('Nats-Service-Error'),
						target,
						payload,
					);
				}

				return result.json<Record<string, unknown>>();
			} finally {
				span.end();
			}
		},
	);
}
