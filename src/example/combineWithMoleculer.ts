/* eslint-disable unicorn/prevent-abbreviations */
/* eslint-disable no-promise-executor-return */
/* eslint-disable promise/param-names */
/* eslint-disable @typescript-eslint/no-unsafe-assignment */
import {ServiceBroker} from 'moleculer';
import {init} from '../KMicro.js';

const broker = new ServiceBroker({
	logger: console as any,
	tracing: {
		enabled: true,
		exporter: [
			{
				type: 'Jaeger',
				host: 'localhost',
				// UDP Sender port option.
				port: 6832,
			},
			{type: 'Console'},
		] as any,
	},
});
const molkMicro = await init('nats://localhost:4222', 'mol', '0.0.1');
broker.createService({
	name: 'mol1',
	actions: {
		async callMicro(context) {
			const data = Buffer.from(JSON.stringify({foo: 'bar'}));
			console.log('call kmicro with trace', {
				parentId: context.span?.parentID,
				id: context.span?.traceID,
			});
			await context.call('mol1.molCall');
			return molkMicro.call('service1.hello', data, {
				moleculerTrace: {
					parentId: context.span?.id,
					traceId: context.span?.traceID, // current span id will be the parent
				},
			});
		},
		async molCall(context) {
			console.log('received mol call');
		},
	},
});

await broker.start();
const kmicroService1 = await init('nats://localhost:4222', 'service1', '0.0.1');

// setup service 1
kmicroService1.addEndpoint('hello', async (context, data) => {
	console.log(
		'handle > hello',
		JSON.stringify(context.context),
		JSON.parse(Buffer.from(data).toString()),
	);
	return Buffer.from(JSON.stringify({foo: 'bar'}));
});

await broker.call('mol1.callMicro');

await new Promise((res) => setTimeout(res, 2000));

await kmicroService1.stop();
await molkMicro.stop();
await broker.stop();
