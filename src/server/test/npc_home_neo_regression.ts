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

// Neo's art is imported into the Rival slots, but it was drawn against the Book
// (Dyer) NPC, which is also where his body proportions come from. Each Rival
// shape therefore carries the matching Book part's footprint, and that footprint
// is what anchors the part on the ReadyLongCoat rig -- the stock Rival anchors
// sat ~178 twips low and buried his head in his collar.
const NEO_PART_FOOTPRINTS: Record<string, { neo: number; book: number }> = {
    Face2: { neo: 481, book: 1320 },
    OvercoatBack: { neo: 327, book: 343 },
    OvercoatFront: { neo: 301, book: 317 },
    SlackerLegs: { neo: 199, book: 217 },
    Torso07: { neo: 55, book: 71 }
};
const DEFINE_SHAPE_TAGS = new Set([2, 22, 32, 83]);
const DEFINE_SPRITE_TAG = 39;
const PLACE_OBJECT2_TAG = 26;

// Everything above the waist is nudged down 300 twips to close the gap where the
// coat met the legs; the left arm is scaled to 6.3/7 pinned at the shoulder.
//
// The head's scale is deliberately non-uniform. FFDec maps an imported SVG's
// canvas onto the container shape's bounds RECT, and Neo's head art has a square
// 47x47 canvas while the container is the 498x722 Book Face2 footprint -- so the
// import squashes it by 498/722. scaleY/scaleX undoes exactly that, leaving the
// head at its drawn proportions. Re-exporting the head at a different canvas
// aspect means recomputing these two numbers.
const NEO_PART_PLACEMENT: Record<string, { sprite: number; scaleX: number; scaleY: number; x: number; y: number }> = {
    head: { sprite: 482, scaleX: 6.1183, scaleY: 4.2574, x: 152, y: -70 },
    torso: { sprite: 56, scaleX: 7, scaleY: 7, x: 0, y: 300 },
    rightArm: { sprite: 302, scaleX: 7, scaleY: 7, x: 0, y: 300 },
    leftArm: { sprite: 328, scaleX: 6.3, scaleY: 6.3, x: 28, y: 117 },
    legs: { sprite: 200, scaleX: 7, scaleY: 7, x: 100, y: 0 }
};

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

/** Reads a DefineShape's bounds RECT (twips), which follows the 2-byte shape id. */
function readShapeBounds(payload: Buffer): [number, number, number, number] {
    let pos = 2;
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

    const bits = read(5);
    return [readSigned(bits), readSigned(bits), readSigned(bits), readSigned(bits)];
}

/** Reads scale and translation out of a PlaceObject2 MATRIX. */
function readPlaceMatrix(payload: Buffer): { scaleX: number; scaleY: number; x: number; y: number } {
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

    let scaleX = 1;
    let scaleY = 1;
    if (read(1)) {
        const bits = read(5);
        scaleX = readSigned(bits) / 65536; // 16.16 fixed point
        scaleY = readSigned(bits) / 65536;
    }
    if (read(1)) {
        const bits = read(5);
        readSigned(bits);
        readSigned(bits);
    }
    const translateBits = read(5);
    return { scaleX, scaleY, x: readSigned(translateBits), y: readSigned(translateBits) };
}

function testNeoPartPlacement(): void {
    const tags = readSwfTags(path.resolve(__dirname, '../../client/content/localhost/p/cag/Animation_NPC.swf'));
    for (const [part, expected] of Object.entries(NEO_PART_PLACEMENT)) {
        const sprite = tags.find((tag) => tag.code === DEFINE_SPRITE_TAG
            && tag.payload.length >= 4
            && tag.payload.readUInt16LE(0) === expected.sprite);
        assert.ok(sprite, `Animation_NPC.swf should define Neo's ${part} sprite ${expected.sprite}`);

        // DefineSprite payload: spriteId, frameCount, then a nested tag stream.
        const place = readTagStream(sprite!.payload, 4).find((tag) => tag.code === PLACE_OBJECT2_TAG);
        assert.ok(place, `Neo's ${part} sprite should place its shape`);

        const matrix = readPlaceMatrix(place!.payload);
        assert.deepEqual(
            { x: matrix.x, y: matrix.y },
            { x: expected.x, y: expected.y },
            `Neo's ${part} placement drifted`
        );
        // Scale is 16.16 fixed point, so fractional values need not round-trip exactly.
        for (const axis of ['scaleX', 'scaleY'] as const) {
            assert.ok(
                Math.abs(matrix[axis] - expected[axis]) < 1e-4,
                `Neo's ${part} ${axis} drifted: ${matrix[axis]} != ${expected[axis]}`
            );
        }
    }
}

function testNeoPartsUseBookFootprints(): void {
    const tags = readSwfTags(path.resolve(__dirname, '../../client/content/localhost/p/cag/Animation_NPC.swf'));
    const bounds = new Map<number, [number, number, number, number]>();
    for (const tag of tags) {
        if (DEFINE_SHAPE_TAGS.has(tag.code) && tag.payload.length >= 2) {
            bounds.set(tag.payload.readUInt16LE(0), readShapeBounds(tag.payload));
        }
    }

    for (const [part, { neo, book }] of Object.entries(NEO_PART_FOOTPRINTS)) {
        const neoBounds = bounds.get(neo);
        const bookBounds = bounds.get(book);
        assert.ok(neoBounds, `Animation_NPC.swf should define Neo's ${part} shape ${neo}`);
        assert.ok(bookBounds, `Animation_NPC.swf should define the Book ${part} shape ${book}`);
        assert.deepEqual(
            neoBounds,
            bookBounds,
            `Neo's ${part} must keep the Book footprint so it anchors on the LongCoat rig`
        );
    }
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
    // Other NPCs on this rig sit at 0.6-0.7; Neo is deliberately the largest.
    assert.equal(neo![0].includes('<AnimScale>0.8</AnimScale>'), true);
}

function testNeoScaleMatchesSourceEntTypes(): void {
    const xml = fs.readFileSync(path.resolve(__dirname, '../../client/content/xml/EntTypes.xml'), 'utf8');
    const neo = xml.match(/<EntType EntName="NPCHomeNeo"[\s\S]*?<\/EntType>/);
    assert.ok(neo, 'source EntTypes.xml should include NPCHomeNeo');
    assert.equal(neo![0].includes('<AnimScale>0.8</AnimScale>'), true, 'source EntTypes.xml must not drift from Login.swz');
}

function main(): void {
    testCraftTownAuthoredNeoNpcSpawnsAfterPlayerSpawn();
    testStaticServerAliasesVersionedManifestRequests();
    testLoginSwzIncludesHomeNeoEntType();
    testNeoScaleMatchesSourceEntTypes();
    testNeoPartsUseBookFootprints();
    testNeoPartPlacement();
    console.log('npc_home_neo_regression passed');
}

main();
