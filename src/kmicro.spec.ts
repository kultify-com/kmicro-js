import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CallError, type Kmicro, init } from "./KMicro.js";

describe("kmicro", () => {
	let node: Kmicro;

	let serviceName: string;

	beforeEach(async () => {
		serviceName = randomUUID();
		node = await init(
			process.env.NATS ?? "nats://localhost:4222",
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
});
