import { init } from "../KMicro.js";

const nats = "nats://localhost:4222";

export async function main() {
	// setup service 1
	const kmicroService1 = await init(
		"nats://localhost:4222",
		"service1",
		"0.0.1",
	);
	kmicroService1.addEndpoint("hello", async (context, data) => {
		console.log(
			"handle > hello",
			JSON.stringify(context.context),
			JSON.parse(Buffer.from(data).toString()),
		);
		return Buffer.from(JSON.stringify({ foo: "bar" }));
	});

	kmicroService1.addEndpoint("get_data", async (context, data) => {
		console.log(
			"handle > get_data",
			JSON.stringify(context.context),
			JSON.parse(Buffer.from(data).toString()),
		);
		return Buffer.from(JSON.stringify({ response: [data, data] }));
	});

	// setup service 2
	const kmicroService2 = await init(
		"nats://localhost:4222",
		"service2",
		"0.0.1",
	);
	kmicroService2.addEndpoint("gather", async (context, data) => {
		console.log("handle > gather", data);
		const result = await context.call(
			"service1.get_data",
			Buffer.from(JSON.stringify({ foo: "Bar2" })),
		);
		console.log(
			"got data from service1",
			JSON.parse(Buffer.from(result).toString()),
		);
		return Buffer.from(JSON.stringify({ data: result }));
	});
	console.log("Server 2 listening");

	// call services
	const caller = await init(nats, "example1", "1.0.0");
	console.log("call service1.hello");

	const response = await caller.call(
		"service1.hello",
		Buffer.from(JSON.stringify({ hello: "world call" })),
	);
	console.log("Response", response);

	const response2 = await caller.call(
		"service2.gather",
		Buffer.from(JSON.stringify({})),
	);
	console.log("Response", response2);

	await kmicroService1.stop();
	await kmicroService2.stop();
	await caller.stop();
}

void main(); // eslint-disable-line unicorn/prefer-top-level-await
