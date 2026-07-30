import * as fs from 'fs';
import * as path from 'path';
import { resolveClientXmlDir } from '../utils/ClientXmlDir';

export interface CastRateState {
    /** Milliseconds of authored animation time the client has earned but not yet spent. */
    creditMs: number;
    creditUpdatedAtMs: number;
    violations: number;
    /** powerId -> earliest time its cooldown allows another cast. */
    cooldownReadyAtMs: Map<number, number>;
    /** powerId -> when hits for it stop being dropped, after a cast we refused. */
    blockedHitPowersUntilMs: Map<number, number>;
}

type PowerTiming = {
    /** Mean authored cast animation, which is what occupies the caster. */
    castMs: number;
    cooldownMs: number;
};

/**
 * How fast a player is allowed to cast, measured on the server's clock.
 *
 * The client gates its own casting on two things, and both run off getTimer(): a power
 * cannot start while another is mid-animation (CombatState:1666), and it cannot start
 * before its own cooldown expires (`var_114[powerID] = mTimeThisTick + coolDownTime`).
 * Inflate Flash's timer -- a Cheat Engine speedhack is the usual way -- and both gates
 * open early, so the same rotation arrives two to ten times faster. The server relayed
 * every one of them and applied the damage that followed, which is the whole payoff of the
 * hack once the Speed Up screens stopped paying out.
 *
 * Both gates are rebuilt here, and they have to stay separate. Animation time is a global
 * budget: one caster, one animation at a time, so the authored durations of what you cast
 * cannot add up to more than the time that actually passed. Cooldowns are per power and
 * run in parallel -- three abilities on ten-second cooldowns can legitimately all fire
 * inside a second -- so charging a cooldown to a shared budget would refuse honest play.
 */
export class CastRateAuthority {
    /**
     * Fraction of the authored time a cast actually has to cost.
     *
     * ponytail: one blunt constant instead of modelling haste. AttackSpeed buffs go up to
     * +25% and Haste stacks on top, so honest play already runs faster than the XML says;
     * half leaves room for that and for a stalled connection dumping packets in a bunch.
     * The price is that a 2x speedhack sits right at the line and only clearly faster ones
     * get caught. If that stops being enough, track the caster's active AttackSpeed/Haste
     * buffs and tighten this toward 0.9.
     */
    private static readonly TOLERANCE = 0.5;
    /** Nothing is free: plenty of powers author no cast animation at all. */
    private static readonly MIN_CAST_COST_MS = 40;
    /**
     * Burst headroom, so a network stall that bunches packets is not read as speed. It
     * refills while idle, which is deliberate -- the opening second of a fight is
     * unconstrained, sustained casting is not.
     */
    private static readonly MAX_CREDIT_MS = 1000;
    /**
     * How long hits for a refused power keep being dropped. Refusing the cast alone does
     * not stop the damage -- 0x0A carries its own damage number and the server applies it
     * -- so the hits have to go with it. A player who never trips the limit never has a
     * power blocked, so the only trailing projectile this can swallow belongs to someone
     * already casting faster than the game allows.
     */
    private static readonly HIT_BLOCK_MS = 1000;

    private static timingsByPowerId: Map<number, PowerTiming> | null = null;

    static createState(): CastRateState {
        return {
            creditMs: CastRateAuthority.MAX_CREDIT_MS,
            creditUpdatedAtMs: 0,
            violations: 0,
            cooldownReadyAtMs: new Map(),
            blockedHitPowersUntilMs: new Map()
        };
    }

    static nowMs(): number {
        return Date.now();
    }

    /**
     * CastTime is a comma list of combo steps, and what a cast costs on average is the mean
     * of them. Cleave is "400,100,100,100,100": the fast steps are only reachable after the
     * slow opener, so charging the 100 would leave room for three times the melee anyone
     * can actually swing, while charging the 400 would refuse the combo itself. 800ms of
     * animation buys five casts, so a cast is worth 160.
     */
    private static loadTimings(): Map<number, PowerTiming> {
        if (CastRateAuthority.timingsByPowerId) {
            return CastRateAuthority.timingsByPowerId;
        }

        const timings = new Map<number, PowerTiming>();
        CastRateAuthority.timingsByPowerId = timings;

        const xmlDir = resolveClientXmlDir(['PlayerPowerTypes.xml']);
        if (!xmlDir) {
            console.warn('[CastRateAuthority] PlayerPowerTypes.xml not found; cast rate limiting is disabled.');
            return timings;
        }

        try {
            const xml = fs.readFileSync(path.join(xmlDir, 'PlayerPowerTypes.xml'), 'utf8');
            for (const block of xml.match(/<Power PowerName="[^"]*">[\s\S]*?<\/Power>/g) ?? []) {
                const powerId = Math.round(Number(block.match(/<PowerID>([^<]*)<\/PowerID>/)?.[1] ?? 0));
                if (!Number.isFinite(powerId) || powerId <= 0) {
                    continue;
                }

                const castTimes = String(block.match(/<CastTime>([^<]*)<\/CastTime>/)?.[1] ?? '')
                    .split(',')
                    .map((value) => Number(value))
                    .filter((value) => Number.isFinite(value) && value >= 0);
                const cooldown = Number(block.match(/<CoolDownTime>([^<]*)<\/CoolDownTime>/)?.[1] ?? 0);

                timings.set(powerId, {
                    castMs: castTimes.length > 0
                        ? castTimes.reduce((total, value) => total + value, 0) / castTimes.length
                        : 0,
                    cooldownMs: Number.isFinite(cooldown) ? Math.max(0, cooldown) : 0
                });
            }
            console.log(`[CastRateAuthority] Loaded cast timings for ${timings.size} powers.`);
        } catch (err) {
            console.warn('[CastRateAuthority] Could not read PlayerPowerTypes.xml; cast rate limiting is disabled.', err);
        }

        return timings;
    }

    /**
     * True when everything is allowed, as it was before this existed: the power data never
     * loaded, or someone turned it off.
     *
     * This is a heuristic pointed at live players, so it gets a kill switch that does not
     * need a code change to reach -- `DB_DISABLE_CAST_RATE_LIMIT=1` plus the
     * `pm2 restart dungeon-mp --update-env` a deploy runs anyway.
     */
    static isDisabled(): boolean {
        if (String(process.env.DB_DISABLE_CAST_RATE_LIMIT ?? '').trim() === '1') {
            return true;
        }
        return CastRateAuthority.loadTimings().size === 0;
    }

    /**
     * Charge one cast. False means it arrived faster than the game allows and must not be
     * relayed.
     */
    static chargeCast(
        client: { castRate: CastRateState; userId?: number | null; character?: { name?: string } | null; currentLevel?: string },
        powerId: number,
        nowMs: number = CastRateAuthority.nowMs()
    ): boolean {
        if (CastRateAuthority.isDisabled()) {
            return true;
        }

        const state = client.castRate ?? CastRateAuthority.createState();
        client.castRate = state;

        const id = Math.round(Number(powerId) || 0);
        const now = Math.max(0, Math.round(Number(nowMs) || 0));
        const timing = CastRateAuthority.loadTimings().get(id) ?? { castMs: 0, cooldownMs: 0 };

        const elapsedMs = state.creditUpdatedAtMs > 0 ? Math.max(0, now - state.creditUpdatedAtMs) : 0;
        state.creditMs = Math.min(CastRateAuthority.MAX_CREDIT_MS, state.creditMs + elapsedMs);
        state.creditUpdatedAtMs = now;

        const cost = Math.max(
            CastRateAuthority.MIN_CAST_COST_MS,
            Math.round(timing.castMs * CastRateAuthority.TOLERANCE)
        );
        const cooldownReadyAt = Number(state.cooldownReadyAtMs.get(id) ?? 0);

        if (state.creditMs < cost) {
            return CastRateAuthority.refuse(client, state, id, now, `animation cost=${cost}ms credit=${Math.round(state.creditMs)}ms`);
        }
        if (cooldownReadyAt > now) {
            return CastRateAuthority.refuse(client, state, id, now, `cooldown ${cooldownReadyAt - now}ms early`);
        }

        state.creditMs -= cost;
        if (timing.cooldownMs > 0) {
            state.cooldownReadyAtMs.set(id, now + Math.round(timing.cooldownMs * CastRateAuthority.TOLERANCE));
        }
        state.violations = Math.max(0, state.violations - 1);
        return true;
    }

    private static refuse(
        client: { userId?: number | null; character?: { name?: string } | null; currentLevel?: string },
        state: CastRateState,
        powerId: number,
        nowMs: number,
        detail: string
    ): boolean {
        state.violations += 1;
        state.blockedHitPowersUntilMs.set(powerId, nowMs + CastRateAuthority.HIT_BLOCK_MS);
        console.warn(
            `[CastRateAuthority] refused cast userId=${client.userId ?? 0} ` +
            `character=${String(client.character?.name ?? 'unknown').replace(/\s+/g, '_')} ` +
            `level=${client.currentLevel || '(unknown)'} power=${powerId} ${detail} ` +
            `violations=${state.violations}`
        );
        return false;
    }

    /** True while hits for this power belong to a cast we already refused. */
    static isHitBlocked(
        client: { castRate: CastRateState },
        powerId: number,
        nowMs: number = CastRateAuthority.nowMs()
    ): boolean {
        const blocked = client.castRate?.blockedHitPowersUntilMs;
        if (!blocked || blocked.size === 0) {
            return false;
        }

        const id = Math.round(Number(powerId) || 0);
        const until = Number(blocked.get(id) ?? 0);
        if (until <= 0) {
            return false;
        }
        if (nowMs >= until) {
            blocked.delete(id);
            return false;
        }

        return true;
    }
}
