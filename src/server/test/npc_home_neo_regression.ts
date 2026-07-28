import { strict as assert } from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import { Entity } from '../core/Entity';
import { GameData } from '../core/GameData';
import { GlobalState } from '../core/GlobalState';
import { LevelConfig } from '../core/LevelConfig';
import { StaticServer } from '../core/StaticServer';
import { NpcLoader } from '../data/NpcLoader';
import { EntityHandler } from '../handlers/EntityHandler';
import { BitBuffer } from '../network/protocol/bitBuffer';
import { BitReader } from '../network/protocol/bitReader';
import { parseSwz } from '../scripts/swzPatchUtils';
import { getCraftTownHomeInstanceId } from '../utils/HomeVisitGuard';

const NEO_ID = 1761501;

function ensureDataLoaded(): void {
    const dataDir = path.resolve(__dirname, '../data');
    if (!LevelConfig.has('CraftTown')) {
        LevelConfig.load(dataDir);
    }
    if (Object.keys(GameData.ENTTYPES).length === 0) {
        GameData.load(dataDir);
    }
    if (NpcLoader.getRawNpcsForLevel('CraftTown').length === 0) {
        NpcLoader.load(dataDir);
    }
}

function createFakeClient(name: string): any {
    const sentPackets: { id: number; payload: Buffer }[] = [];
    return {
        token: 1,
        character: { name, level: 50, class: 'mage' },
        currentLevel: 'CraftTown',
        levelInstanceId: getCraftTownHomeInstanceId({ name } as never),
        currentRoomId: 0,
        playerSpawned: true,
        clientEntID: 1001,
        userId: 1,
        knownEntityIds: new Set<number>(),
        entityIdAliases: new Map<number, number>(),
        sharedEntityRemoteUpdateDeferredIds: new Set<number>(),
        entities: new Map<number, any>(),
        sentPackets,
        send(id: number, payload: Buffer) {
            sentPackets.push({ id, payload: Buffer.from(payload) });
        },
        sendBitBuffer(id: number, bb: BitBuffer) {
            sentPackets.push({ id, payload: bb.toBuffer() });
        }
    };
}

function readSerializedNpcEntity(payload: Buffer): Record<string, unknown> {
    const br = new BitReader(payload);
    const id = br.readMethod4();
    const name = br.readMethod13();
    const isPlayer = br.readMethod15();
    const x = br.readMethod45();
    const y = br.readMethod45();
    br.readMethod45(); // velocity
    const team = br.readMethod6(Entity.TEAM_BITS);
    return { id, name, isPlayer, x, y, team };
}

function testCraftTownAuthoredNeoNpcSpawnsAfterPlayerSpawn(): void {
    ensureDataLoaded();
    GlobalState.levelEntities.clear();

    const client = createFakeClient('NeoHomeOwner');
    EntityHandler.sendInitialLevelEntities(client, 'CraftTown');
    assert.equal(client.sentPackets.length, 0, 'client-spawn Home should not seed NPCs during initial level load');

    EntityHandler.sendCraftTownAuthoredNpcs(client);

    const spawnPackets = client.sentPackets.filter((packet: any) => packet.id === 0x0F);
    assert.equal(spawnPackets.length, 1, 'authored Home NPC should be sent after player spawn');
    assert.deepEqual(readSerializedNpcEntity(spawnPackets[0].payload), {
        id: NEO_ID,
        name: 'NPCHomeNeo',
        isPlayer: false,
        x: 1020,
        y: 1450,
        team: 3
    });
    assert.equal(client.entities.get(NEO_ID)?.name, 'NPCHomeNeo');
    assert.equal(client.knownEntityIds.has(NEO_ID), true);

    const levelMap = GlobalState.levelEntities.get(`CraftTown#${client.levelInstanceId}`);
    assert.equal(levelMap?.get(NEO_ID)?.clientSpawned, false);

    EntityHandler.sendCraftTownAuthoredNpcs(client);
    assert.equal(
        client.sentPackets.filter((packet: any) => packet.id === 0x0F).length,
        1,
        'known Home NPC should not duplicate'
    );
}

function testStaticServerAliasesVersionedManifestRequests(): void {
    const server = new StaticServer();
    const manifestRoute = (server as any).app.router.stack.find((layer: any) => {
        return String(layer.route?.path ?? '').includes('masterFileList');
    });

    assert.ok(manifestRoute, 'Static server should alias stale manifest requests such as /p/cbw/masterFileList.xml');
    assert.ok(manifestRoute.matchers?.[0]?.('/p/cbw/masterFileList.xml'));
    assert.equal(
        fs.existsSync(path.resolve(__dirname, '../../client/content/localhost/p/cbw/masterFileList.xml')),
        true
    );
}

function testLoginSwzIncludesHomeNeoEntType(): void {
    const ctx = parseSwz(path.resolve(__dirname, '../../client/content/localhost/p/cbq/Login.swz'));
    const entTypes = ctx.chunks.find((entry: any) => entry.xml.includes('<EntTypes'));

    assert.ok(entTypes, 'Login.swz should include EntTypes data');
    const neo = entTypes!.xml.match(/<EntType EntName="NPCHomeNeo"[\s\S]*?<\/EntType>/);
    assert.ok(neo, 'Login.swz should include the NPCHomeNeo EntType');
    assert.equal(neo![0].includes('<BaseAnim>ReadyLongCoat</BaseAnim>'), true);
    assert.equal(neo![0].includes('<CustomArt>Animation_NPC.swf/Rival</CustomArt>'), true);
    // 0.45 is the stationary-shopkeeper scale; world NPCs on this rig render at 0.65.
    assert.equal(neo![0].includes('<AnimScale>0.65</AnimScale>'), true);
}

function testNeoScaleMatchesSourceEntTypes(): void {
    const xml = fs.readFileSync(path.resolve(__dirname, '../../client/content/xml/EntTypes.xml'), 'utf8');
    const neo = xml.match(/<EntType EntName="NPCHomeNeo"[\s\S]*?<\/EntType>/);
    assert.ok(neo, 'source EntTypes.xml should include NPCHomeNeo');
    assert.equal(neo![0].includes('<AnimScale>0.65</AnimScale>'), true, 'source EntTypes.xml must not drift from Login.swz');
}

function main(): void {
    testCraftTownAuthoredNeoNpcSpawnsAfterPlayerSpawn();
    testStaticServerAliasesVersionedManifestRequests();
    testLoginSwzIncludesHomeNeoEntType();
    testNeoScaleMatchesSourceEntTypes();
    console.log('npc_home_neo_regression passed');
}

main();
