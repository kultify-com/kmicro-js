import { randomUUID } from "node:crypto";
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
import { CallError, init, type Kmicro, ServiceError } from "./KMicro.js";

describe("kmicro", () => {
	let node: Kmicro;
	let natsContainer: StartedNatsContainer;

	let serviceName: string;

	beforeAll(async () => {
		natsContainer = await new NatsContainer("nats:2.11-alpine").start();
	}, 30_000);

	afterAll(() => {
		return natsContainer.stop();
	});

	beforeEach(async () => {
		serviceName = randomUUID();
		const opts = natsContainer.getConnectionOptions();
		node = await init(
			`nats://${opts.user}:${opts.pass}@${opts.servers}`,
			serviceName,
			"0.0.1",
		);
	});

	afterEach(async () => {
		await node.stop();
	});

	it("should communication", async () => {
		let action1ReceivedData: Uint8Array = new Uint8Array();
		let action2ReceivedData: Uint8Array = new Uint8Array();
		node.addEndpoint("action1", async (context, data) => {
			action1ReceivedData = data;
			const payload = { foo: "bar" };
			const action2Result = await context.call(
				`${serviceName}.action2`,
				Buffer.from(JSON.stringify(payload)),
			);
			return action2Result;
		});

		node.addEndpoint("action2", async (context, data) => {
			expect(context.span).toBeDefined();
			action2ReceivedData = data;
			return Buffer.from(JSON.stringify({ ret: "var" }));
		});

		const payload = { hello: "world" };
		const callResult = await node.call(
			`${serviceName}.action1`,
			Buffer.from(JSON.stringify(payload)),
		);
		expect(JSON.parse(Buffer.from(callResult).toString())).toEqual({
			ret: "var",
		});
		expect(JSON.parse(Buffer.from(action1ReceivedData).toString())).toEqual({
			hello: "world",
		});
		expect(JSON.parse(Buffer.from(action2ReceivedData).toString())).toEqual({
			foo: "bar",
		});
	});

	it("should keep header communication", async () => {
		let action1ReceivedData: Uint8Array = new Uint8Array();
		let action2ReceivedData: Uint8Array = new Uint8Array();
		node.addEndpoint("action1", async (context, data) => {
			expect(context.meta.header["X-AUTH"]).toEqual("abc");

			action1ReceivedData = data;
			const payload = { foo: "bar" };
			const action2Result = await context.call(
				`${serviceName}.action2`,
				Buffer.from(JSON.stringify(payload)),
			);
			return action2Result;
		});

		node.addEndpoint("action2", async (context, data) => {
			expect(context.span).toBeDefined();
			expect(context.meta.header["X-AUTH"]).toEqual("abc");
			action2ReceivedData = data;
			return Buffer.from(JSON.stringify({ ret: "var" }));
		});

		const payload = { hello: "world" };
		const callResult = await node.call(
			`${serviceName}.action1`,
			Buffer.from(JSON.stringify(payload)),
			{
				header: {
					"X-AUTH": "abc",
				},
			},
		);
		expect(JSON.parse(Buffer.from(callResult).toString())).toEqual({
			ret: "var",
		});
		expect(JSON.parse(Buffer.from(action1ReceivedData).toString())).toEqual({
			hello: "world",
		});
		expect(JSON.parse(Buffer.from(action2ReceivedData).toString())).toEqual({
			foo: "bar",
		});
	});

	it("should get correct errors", async () => {
		node.addEndpoint("action1", async (context, data) => {
			const action2Result = await context.call(
				`${serviceName}.action2`,
				Buffer.from(
					JSON.stringify({
						foo: "bar",
					}),
				),
			);
			return action2Result;
		});

		node.addEndpoint("action2", async () => {
			throw new Error("some error");
		});

		const promise = node.call(
			`${serviceName}.action1`,
			Buffer.from(
				JSON.stringify({
					hello: "world",
				}),
			),
		);
		await expect(promise).rejects.toBeInstanceOf(CallError);
	});

	it("should carry the code and description a handler answers with", async () => {
		node.addEndpoint("refuse", async () => {
			throw new ServiceError(400, "name is required");
		});

		const error = await node
			.call(`${serviceName}.refuse`, new Uint8Array())
			.catch((error_: unknown) => error_);
		expect(error).toBeInstanceOf(CallError);
		expect((error as CallError).code).toBe("400");
		expect((error as CallError).description).toBe("name is required");
		expect((error as CallError).message).toBe(
			"received error: name is required",
		);
		expect((error as CallError).isClientError()).toBe(true);
	});

	it("should answer 500 for any other handler error", async () => {
		node.addEndpoint("crash", async () => {
			throw new Error("boom");
		});

		const error = await node
			.call(`${serviceName}.crash`, new Uint8Array())
			.catch((error_: unknown) => error_);
		expect(error).toBeInstanceOf(CallError);
		expect((error as CallError).code).toBe("500");
		expect((error as CallError).isClientError()).toBe(false);
	});
});
