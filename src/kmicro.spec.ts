import {randomUUID} from 'node:crypto';
import {afterEach, beforeEach, describe, expect, it} from 'vitest';
import {CallError, init, type Kmicro} from './KMicro.js';

describe('kmicro', () => {
	let node: Kmicro;

	let serviceName: string;

	beforeEach(async () => {
		serviceName = randomUUID();
		node = await init('nats://localhost:4222', serviceName, '0.0.1');
	});

	afterEach(async () => {
		await node.stop();
	});

	it('should communication', async () => {
		let action1ReceivedData: any = null;
		let action2ReceivedData: any = null;
		node.addEndpoint('action1', async (context, data) => {
			action1ReceivedData = data;
			const action2Result = await context.call(`${serviceName}.action2`, {
				foo: 'bar',
			});
			return action2Result;
		});

		node.addEndpoint('action2', async (context, data) => {
			expect(context.span).toBeDefined();
			action2ReceivedData = data;
			return {ret: 'var'};
		});

		const callResult = await node.call(`${serviceName}.action1`, {
			hello: 'world',
		});
		expect(callResult).toEqual({ret: 'var'});
		expect(action1ReceivedData).toEqual({hello: 'world'});
		expect(action2ReceivedData).toEqual({foo: 'bar'});
	});

	it('should get correct errors', async () => {
		node.addEndpoint('action1', async (context, data) => {
			const action2Result = await context.call(`${serviceName}.action2`, {
				foo: 'bar',
			});
			return action2Result;
		});

		node.addEndpoint('action2', async () => {
			throw new Error('some error');
		});

		const promise = node.call(`${serviceName}.action1`, {
			hello: 'world',
		});
		await expect(promise).rejects.toBeInstanceOf(CallError);
	});
});
