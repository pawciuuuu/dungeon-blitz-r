/**
 * Regression test for the Forge Charm follow-up: "Refused a Free Speed Up for
 * MaxMage: 0s left."
 *
 * When a charm finishes and the client misses the server's ready push (a lost
 * completion timer, a dropped result packet), the server still holds the
 * completed forge (primary set, ReadyTime reset to 0) awaiting collection. The
 * player's next Free Speed Up click must re-deliver the 0xCD result packet so
 * the claim screen appears — not refuse with "0s left", which left the client
 * stuck on the countdown and the charm uncollectable.
 */
import { ForgeHandler } from '../handlers/ForgeHandler';
import { BitReader } from '../network/protocol/bitReader';

interface FakeClient {
    userId: number;
    character: any;
    socket: any;
    authenticated: boolean;
    sentPackets: Array<{ opcode: number; data: Buffer }>;
    sendBitBuffer: (opcode: number, bb: any) => void;
    send: (opcode: number, data: Buffer) => void;
}

function makeClient(character: any): FakeClient {
    const client: FakeClient = {
        userId: 1,
        character,
        socket: {},
        authenticated: true,
        sentPackets: [],
        sendBitBuffer: (opcode, bb) => {
            client.sentPackets.push({ opcode, data: bb.toBuffer() });
        },
        send: (opcode, data) => {
            client.sentPackets.push({ opcode, data });
        }
    };
    return client;
}

function completedForgeState(): Record<string, unknown> {
    return {
        primary: 1,
        secondary: 0,
        secondary_tier: 0,
        usedlist: 0,
        ReadyTime: 0,
        forge_roll_a: 1234,
        forge_roll_b: 5678,
        is_extended_forge: false,
        free_speedup_reason: '',
        stats_by_building: {}
    };
}

// 6 zero bits: a method_9 encoding of cost 0 (the "Free" button).
const FREE_SPEEDUP_PACKET = Buffer.from([0x00]);

const nowSeconds = Math.floor(Date.now() / 1000);

const assertions: Array<[string, () => Promise<boolean>]> = [
    [
        'a completed forge (ReadyTime 0) delivers the 0xCD result on a Free click',
        async () => {
            const client = makeClient({ name: 'MaxMage', magicForge: completedForgeState(), mammothIdols: 0 });
            await ForgeHandler.handleForgeSpeedUpPacket(client as any, FREE_SPEEDUP_PACKET);
            return client.sentPackets.some((p) => p.opcode === 0xCD);
        }
    ],
    [
        'the delivered 0xCD carries the completed charm primary',
        async () => {
            const client = makeClient({ name: 'MaxMage', magicForge: completedForgeState(), mammothIdols: 0 });
            await ForgeHandler.handleForgeSpeedUpPacket(client as any, FREE_SPEEDUP_PACKET);
            const packet = client.sentPackets.find((p) => p.opcode === 0xCD);
            if (!packet) {
                return false;
            }
            const reader = new BitReader(packet.data);
            return reader.readMethod20(7) === 1;
        }
    ],
    [
        'a completed forge delivers 0xCD regardless of the declared cost',
        async () => {
            const client = makeClient({ name: 'MaxMage', magicForge: completedForgeState(), mammothIdols: 0 });
            // 0x0C decodes to a declared cost of 3; the result must not depend on it.
            await ForgeHandler.handleForgeSpeedUpPacket(client as any, Buffer.from([0x0c]));
            return client.sentPackets.some((p) => p.opcode === 0xCD);
        }
    ],
    [
        'an in-progress forge outside the free window is still refused (0xE3, not 0xCD)',
        async () => {
            const forge = completedForgeState();
            forge.ReadyTime = nowSeconds + 24 * 3600;
            const client = makeClient({ name: 'MaxMage', magicForge: forge, mammothIdols: 0 });
            await ForgeHandler.handleForgeSpeedUpPacket(client as any, FREE_SPEEDUP_PACKET);
            return (
                client.sentPackets.some((p) => p.opcode === 0xE3) &&
                !client.sentPackets.some((p) => p.opcode === 0xCD)
            );
        }
    ]
];

async function run(): Promise<void> {
    const failed: Array<[string, boolean]> = [];
    for (const [name, check] of assertions) {
        let ok = false;
        try {
            ok = await check();
        } catch (error) {
            console.error(`  threw: ${error instanceof Error ? error.message : String(error)}`);
        }
        if (!ok) {
            failed.push([name, ok]);
        }
        console.log(`  ${ok ? 'PASS' : 'FAIL'} ${name}`);
    }
    if (failed.length > 0) {
        console.error(`[forge_completed_speedup_regression] ${failed.length}/${assertions.length} assertions failed`);
        process.exit(1);
    }
    console.log(`[forge_completed_speedup_regression] ${assertions.length} assertions passed`);
}

void run();
