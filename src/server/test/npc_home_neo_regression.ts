import { strict as assert } from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import * as zlib from 'zlib';
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

// Neo wears the Rival art set, so his head is sprite 482 (a_Face2_Rival). The
// stock Rival face is anchored ~178 twips lower than every shipped LongCoat set,
// which buried his head in his collar. The face art itself (DefineShape 481) is
// untouched; sprite 482's placement matrix carries the correction, lining his
// neck up with the Book/Dyer head that Neo's body proportions come from.
const NEO_FACE_SPRITE = 482;
const NEO_HEAD_TRANSLATE = { x: 830, y: -1246 };
const DEFINE_SPRITE_TAG = 39;
const PLACE_OBJECT2_TAG = 26;

function readSwfTags(file: string): { code: number; payload: Buffer }[] {
    const raw = fs.readFileSync(file);
    const body = raw.subarray(0, 3).toString('ascii') === 'CWS'
        ? zlib.inflateSync(raw.subarray(8))
        : raw.subarray(8);
    // Frame header: a RECT (5 size bits, 4 fields) then frame rate and count.
    return readTagStream(body, Math.ceil((5 + 4 * (body[0] >> 3)) / 8) + 4);
}

function readTagStream(buf: Buffer, start: number): { code: number; payload: Buffer }[] {
    const tags: { code: number; payload: Buffer }[] = [];
    let pos = start;
    while (pos + 2 <= buf.length) {
        const header = buf.readUInt16LE(pos);
        pos += 2;
        const code = header >> 6;
        let len = header & 0x3f;
        if (len === 0x3f) {
            len = buf.readUInt32LE(pos);
            pos += 4;
        }
        if (code === 0) {
            break;
        }
        tags.push({ code, payload: buf.subarray(pos, pos + len) });
        pos += len;
    }
    return tags;
}

/** Reads the translation out of a PlaceObject2 MATRIX, in twips. */
function readPlaceTranslate(payload: Buffer): { x: number; y: number } {
    const flags = payload[0];
    assert.ok(flags & 0x04, 'PlaceObject2 should carry a matrix');
    let pos = 3 + ((flags & 0x02) ? 2 : 0); // flags, depth, optional character id

    let bit = 0;
    const read = (count: number): number => {
        let value = 0;
        for (let i = 0; i < count; i += 1) {
            value = (value << 1) | ((payload[pos] >> (7 - bit)) & 1);
            bit += 1;
            if (bit === 8) {
                bit = 0;
                pos += 1;
            }
        }
        return value;
    };
    const readSigned = (count: number): number => {
        const value = read(count);
        return count && (value & (1 << (count - 1))) ? value - (1 << count) : value;
    };

    if (read(1)) {
        read(read(5) * 2); // scale
    }
    if (read(1)) {
        read(read(5) * 2); // rotate / skew
    }
    const translateBits = read(5);
    return { x: readSigned(translateBits), y: readSigned(translateBits) };
}

function testNeoHeadAnchoredToBookNeckLine(): void {
    const tags = readSwfTags(path.resolve(__dirname, '../../client/content/localhost/p/cag/Animation_NPC.swf'));
    const face = tags.find((tag) => tag.code === DEFINE_SPRITE_TAG
        && tag.payload.length >= 4
        && tag.payload.readUInt16LE(0) === NEO_FACE_SPRITE);
    assert.ok(face, `Animation_NPC.swf should define sprite ${NEO_FACE_SPRITE}`);

    // DefineSprite payload: spriteId, frameCount, then a nested tag stream.
    const place = readTagStream(face!.payload, 4).find((tag) => tag.code === PLACE_OBJECT2_TAG);
    assert.ok(place, 'a_Face2_Rival should place its face shape');
    assert.deepEqual(
        readPlaceTranslate(place!.payload),
        NEO_HEAD_TRANSLATE,
        "Neo's head must stay anchored to the Book neck line"
    );
}

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
    testNeoHeadAnchoredToBookNeckLine();
    console.log('npc_home_neo_regression passed');
}

main();
