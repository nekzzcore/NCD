const { test } = require('node:test');
const assert = require('node:assert/strict');
const { HealthService, STORAGE_KEY } = require('../health.js');

function memoryStorage() {
    const values = new Map();
    return {
        getItem: key => values.get(key) ?? null,
        setItem: (key, value) => values.set(key, value),
        removeItem: key => values.delete(key)
    };
}

function adapter(overrides = {}) {
    return {
        getAvailability: async () => ({ status: 'available' }),
        requestPermissions: async () => ({ granted: ['steps', 'heartRate', 'sleep', 'weight'] }),
        getPermissions: async () => ({ granted: ['steps', 'heartRate', 'sleep', 'weight'] }),
        readLatest: async () => ({ metrics: {} }),
        revokePermissions: async () => {},
        ...overrides
    };
}

test('Android: реальные показания отделены от служебных разрешений устройства', async () => {
    const storage = memoryStorage();
    const service = new HealthService({
        platform: 'android', storage, now: () => new Date('2026-10-14T10:00:00Z'),
        adapter: adapter({
            readLatest: async () => ({ metrics: {
                steps: { value: 5432, unit: 'count', source: 'Mi Fitness', measuredAt: '2026-10-14T09:00:00Z' },
                heartRate: { value: 71, unit: 'bpm', source: 'Mi Fitness', measuredAt: '2026-10-14T09:55:00Z' }
            } })
        })
    });
    await service.connect();
    await service.sync();
    assert.equal(service.state.status, 'data');
    assert.equal(service.state.metrics.steps.value, 5432);
    assert.equal(service.state.metrics.steps.source, 'Mi Fitness');
    assert.equal(service.state.lastReadAt, '2026-10-14T10:00:00.000Z');
    assert.ok(storage.getItem(STORAGE_KEY));
    assert.equal(storage.getItem('goalTracker_data'), null);
});

test('Android: отказ в разрешении не запускает чтение и не создаёт значения', async () => {
    let reads = 0;
    const service = new HealthService({
        platform: 'android', storage: memoryStorage(),
        adapter: adapter({
            requestPermissions: async () => ({ granted: [] }),
            getPermissions: async () => ({ granted: [] }),
            readLatest: async () => { reads++; return { metrics: {} }; }
        })
    });
    await service.connect();
    await service.sync();
    assert.equal(service.state.status, 'permission-denied');
    assert.deepEqual(service.state.metrics, {});
    assert.equal(reads, 0);
});

test('Android: недоступный Health Connect обрабатывается как состояние интерфейса', async () => {
    let requested = false;
    const service = new HealthService({
        platform: 'android', storage: memoryStorage(),
        adapter: adapter({
            getAvailability: async () => ({ status: 'unavailable' }),
            requestPermissions: async () => { requested = true; return { granted: [] }; }
        })
    });
    await service.connect();
    assert.equal(service.state.status, 'unavailable');
    assert.equal(requested, false);
});

test('Android: успешное чтение без данных не выдумывает показатели', async () => {
    const service = new HealthService({
        platform: 'android', storage: memoryStorage(), now: () => new Date('2026-10-14T10:00:00Z'),
        adapter: adapter({ readLatest: async () => ({ metrics: {} }) })
    });
    await service.connect();
    await service.sync();
    assert.equal(service.state.status, 'empty');
    assert.deepEqual(service.state.metrics, {});
    assert.equal(service.state.lastReadAt, '2026-10-14T10:00:00.000Z');
});

test('Electron и PWA не обращаются к Health Connect', async t => {
    for (const platform of ['electron', 'web']) {
        await t.test(platform, async () => {
            let calls = 0;
            const fake = adapter({ getAvailability: async () => { calls++; return { status: 'available' }; } });
            const service = new HealthService({ platform, adapter: fake, storage: memoryStorage() });
            await service.checkAvailability();
            await service.connect();
            await service.sync();
            assert.equal(service.state.status, 'platform-unavailable');
            assert.equal(calls, 0);
        });
    }
});

test('Отключение отзывает разрешения и удаляет локальный кэш', async () => {
    let revoked = false;
    const storage = memoryStorage();
    const service = new HealthService({
        platform: 'android', storage,
        adapter: adapter({ revokePermissions: async () => { revoked = true; } })
    });
    await service.connect();
    await service.disconnect();
    assert.equal(revoked, true);
    assert.equal(storage.getItem(STORAGE_KEY), null);
    assert.deepEqual(service.state.metrics, {});
});

test('A delayed Health Connect response cannot restore prior account metrics after clearAccount',async()=>{
 const storage=memoryStorage();let release;const gate=new Promise(r=>release=r);const service=new HealthService({platform:'android',storage,adapter:adapter({readLatest:async()=>{await gate;return {metrics:{steps:{value:8888,source:'PRIVATE'}}};}})});
 const pending=service.sync();await new Promise(r=>setImmediate(r));service.clearAccount();release();await pending;
 assert.deepEqual(service.state.metrics,{});assert.equal(service.state.connected,false);assert.equal(storage.getItem(STORAGE_KEY),null);
});

test('Account health snapshot contains readings without device permissions and survives disconnect',async()=>{
 const storage=memoryStorage();const service=new HealthService({platform:'android',storage,adapter:adapter({readLatest:async()=>({metrics:{steps:{value:100,unit:'count',source:'Device'}}})})});
 await service.connect();await service.sync();
 const saved=JSON.parse(storage.getItem('goalTracker_health_account_v1'));
 assert.equal(saved.metrics.steps.value,100);assert.equal(saved.connected,undefined);assert.equal(saved.granted,undefined);
 await service.disconnect();assert.equal(storage.getItem(STORAGE_KEY),null);
 assert.equal(JSON.parse(storage.getItem('goalTracker_health_account_v1')).metrics.steps.value,100);
 service.clearAccount();assert.equal(storage.getItem('goalTracker_health_account_v1'),null);
});

test('A desktop opens account readings without inheriting Health Connect permission state',()=>{
 const storage=memoryStorage();storage.setItem('goalTracker_health_account_v1',JSON.stringify({connected:true,granted:['steps'],metrics:{steps:{value:321,unit:'count',source:'Phone'}},lastReadAt:'2026-10-28T01:00:00Z'}));
 const service=new HealthService({platform:'electron',storage});
 assert.equal(service.state.metrics.steps.value,321);assert.equal(service.state.connected,false);assert.equal(service.state.granted,undefined);assert.equal(service.isAndroid(),false);
});
