import { randomUUID } from "node:crypto";
import { AckPolicy, jetstreamManager } from "@nats-io/jetstream";
import { NatsContainer, type StartedNatsContainer } from "@testcontainers/nats";
import {
	afterAll,
	afterEach,
	beforeAll,
	beforeEach,
	describe,
	expect,
	it,
} from "vitest";
import { type DomainEvent, init, type Kmicro } from "./KMicro.js";

describe("domain events", () => {
	let publisher: Kmicro;
	let subscriber: Kmicro;
	let natsContainer: StartedNatsContainer;
	let natsUrl: string;

	beforeAll(async () => {
		natsContainer = await new NatsContainer("nats:2.11-alpine")
			.withJetStream()
			.start();
	}, 30_000);

	afterAll(() => {
		return natsContainer.stop();
	});

	beforeEach(async () => {
		const opts = natsContainer.getConnectionOptions();
		natsUrl = `nats://${opts.user}:${opts.pass}@${opts.servers}`;
		publisher = await init(natsUrl, randomUUID(), "0.0.1");
		subscriber = await init(natsUrl, randomUUID(), "0.0.1");
	});

	afterEach(async () => {
		await subscriber.stop();
		await publisher.stop();
	});

	async function createStreamAndConsumer(
		streamName: string,
		consumerName: string,
		subjects: string[],
	) {
		const nc = publisher.getNc();
		const jsm = await jetstreamManager(nc);
		await jsm.streams.add({
			name: streamName,
			subjects,
		});
		await jsm.consumers.add(streamName, {
			durable_name: consumerName,
			ack_policy: AckPolicy.Explicit,
		});
	}

	it("should publish and subscribe to domain events", async () => {
		const streamName = `stream-${randomUUID().slice(0, 8)}`;
		const consumerName = `consumer-${randomUUID().slice(0, 8)}`;
		const orgId = `org-${randomUUID().slice(0, 8)}`;

		await createStreamAndConsumer(streamName, consumerName, [
			`events.${orgId}.>`,
		]);

		const received: DomainEvent[] = [];
		const eventReceived = new Promise<void>((resolve) => {
			subscriber.subscribe(streamName, consumerName, async (_ctx, event) => {
				received.push(event);
				resolve();
			});
		});

		const event: DomainEvent = {
			id: randomUUID(),
			domain: "order",
			type: "completed",
			orgId,
			entityId: "123",
			payload: Buffer.from(JSON.stringify({ orderId: "123" })),
		};

		await publisher.publish(event);
		await eventReceived;

		expect(received).toHaveLength(1);
		expect(received[0].id).toBe(event.id);
		expect(received[0].domain).toBe("order");
		expect(received[0].type).toBe("completed");
		expect(received[0].orgId).toBe(orgId);
		expect(JSON.parse(Buffer.from(received[0].payload).toString())).toEqual({
			orderId: "123",
		});
	});

	it("should propagate headers through events", async () => {
		const streamName = `stream-${randomUUID().slice(0, 8)}`;
		const consumerName = `consumer-${randomUUID().slice(0, 8)}`;
		const orgId = `org-${randomUUID().slice(0, 8)}`;

		await createStreamAndConsumer(streamName, consumerName, [
			`events.${orgId}.>`,
		]);

		let receivedHeader: Record<string, string> = {};
		const eventReceived = new Promise<void>((resolve) => {
			subscriber.subscribe(streamName, consumerName, async (ctx, _event) => {
				receivedHeader = ctx.meta.header;
				resolve();
			});
		});

		const event: DomainEvent = {
			id: randomUUID(),
			domain: "user",
			type: "created",
			orgId,
			entityId: "user-456",
			payload: new Uint8Array(),
		};

		await publisher.publish(event);
		await eventReceived;

		expect(receivedHeader).toBeDefined();
	});

	it("should nak and retry on handler error", async () => {
		const streamName = `stream-${randomUUID().slice(0, 8)}`;
		const consumerName = `consumer-${randomUUID().slice(0, 8)}`;
		const orgId = `org-${randomUUID().slice(0, 8)}`;

		await createStreamAndConsumer(streamName, consumerName, [
			`events.${orgId}.>`,
		]);

		let attempt = 0;
		const eventProcessed = new Promise<void>((resolve) => {
			subscriber.subscribe(streamName, consumerName, async (_ctx, _event) => {
				attempt++;
				if (attempt === 1) {
					throw new Error("temporary failure");
				}
				resolve();
			});
		});

		const event: DomainEvent = {
			id: randomUUID(),
			domain: "order",
			type: "failed",
			orgId,
			entityId: "order-789",
			payload: new Uint8Array(),
		};

		await publisher.publish(event);
		await eventProcessed;

		expect(attempt).toBe(2);
	});

	it("should deduplicate events with same id", async () => {
		const streamName = `stream-${randomUUID().slice(0, 8)}`;
		const consumerName = `consumer-${randomUUID().slice(0, 8)}`;
		const orgId = `org-${randomUUID().slice(0, 8)}`;

		await createStreamAndConsumer(streamName, consumerName, [
			`events.${orgId}.>`,
		]);

		const eventId = randomUUID();
		const event: DomainEvent = {
			id: eventId,
			domain: "order",
			type: "completed",
			orgId,
			entityId: "order-999",
			payload: new Uint8Array(),
		};

		// Publish same event twice
		await publisher.publish(event);
		await publisher.publish(event);

		const received: DomainEvent[] = [];
		const eventReceived = new Promise<void>((resolve) => {
			subscriber.subscribe(streamName, consumerName, async (_ctx, evt) => {
				received.push(evt);
				// Give some time to ensure no second message arrives
				setTimeout(resolve, 500);
			});
		});

		await eventReceived;
		expect(received).toHaveLength(1);
		expect(received[0].id).toBe(eventId);
	});
});
