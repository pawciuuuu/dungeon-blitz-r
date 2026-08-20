/// <reference types="node" />

/**
 * Seeds the local-only guild demo for the offline-members feature (#717):
 * Neodevils joins the guild "The Minesa Studios" as its leader, and Telahair
 * exists in the same guild without being logged in, so opening the guild page
 * as Neodevils shows Telahair as an offline member (grayed out, "Offline").
 *
 * Local only, deliberately, like seedTestAccount: it resets passwords to a
 * known value so anyone can log in, so it refuses to run against a multiplayer
 * server.
 *
 *   npx ts-node src/server/tools/seedGuildExample.ts
 *
 * It is idempotent: existing Neodevils / Telahair characters are reused (with
 * their passwords reset) instead of duplicated, and Telahair is created fresh
 * under tela@gmail.com when she does not exist yet.
 */

import * as path from 'path';
import { Config } from '../core/config';
import { CharacterTemplates } from '../core/CharacterTemplates';
import { JsonAdapter } from '../database/JsonAdapter';
import { Character, UserSaveData } from '../database/Database';
import { hashPlaintextPasswordForClient, PasswordRecord } from '../auth/PasswordAuth';
export const GUILD_NAME = 'The Minesa Studios';
const DEFAULT_PASSWORD = 'testtest';
const NEODEVILS_NAME = 'Neodevils';
const TELAHAIR_NAME = 'Telahair';
const TELAHAIR_EMAIL = 'tela@gmail.com';
const TELAHAIR_FALLBACK_CLASS = 'Rogue';
// GuildHandler rank constants: 0 = guild master, 1 = officer, 2 = member.
const RANK_GUILD_MASTER = 0;
const RANK_MEMBER = 2;

function normalizeCharName(value: string | null | undefined): string {
    return String(value ?? '').trim().toLowerCase();
}

function findCharacterByName(
    records: UserSaveData[],
    name: string
): { userId: number; character: Character; characters: Character[] } | null {
    const key = normalizeCharName(name);
    for (const record of records) {
        const characters = Array.isArray(record.characters) ? record.characters : [];
        for (const character of characters) {
            if (normalizeCharName(character?.name) === key) {
                return {
                    userId: Math.round(Number(record.user_id)),
                    character,
                    characters
                };
            }
        }
    }
    return null;
}

/**
 * Ensures a character with the given name exists and belongs to GUILD_NAME at
 * targetRank, returning the account user_id the character lives on. Existing
 * characters are reused; missing ones are created fresh under fallbackEmail.
 */
async function ensureGuildMember(
    db: JsonAdapter,
    name: string,
    targetRank: number,
    fallbackEmail: string,
    fallbackClass: string,
    passwordRecord: PasswordRecord
): Promise<{ userId: number; character: Character; created: boolean }> {
    const records = await db.loadAllCharacterRecords();
    const found = findCharacterByName(records, name);

    let userId: number;
    let character: Character;
    let characters: Character[];

    if (found) {
        userId = found.userId;
        character = found.character;
        characters = found.characters;
    } else {
        const template = CharacterTemplates.get(fallbackClass);
        if (!template) {
            throw new Error(`No character template for ${fallbackClass}.`);
        }
        character = template as Character;
        character.name = name;

        let account = await db.getAccount(fallbackEmail);
        if (!account) {
            account = await db.createAccount(fallbackEmail, passwordRecord);
            console.log(`[seed-guild-example] Created account ${fallbackEmail} (user_id ${account.user_id}).`);
        }
        userId = account.user_id;
        characters = await db.loadCharacters(userId);
    }

    // GuildHandler.setCharacterGuild shape: { name, rank }.
    character.guild = { name: GUILD_NAME, rank: targetRank };

    const index = characters.findIndex((entry) => normalizeCharName(entry?.name) === normalizeCharName(name));
    if (index >= 0) {
        characters[index] = character;
    } else {
        characters.push(character);
    }
    await db.saveCharacters(userId, characters);

    return { userId, character, created: !found };
}

async function main(): Promise<void> {
    if (Config.MULTIPLAYER_MODE) {
        console.error('[seed-guild-example] Refusing to run: MULTIPLAYER_MODE is on.');
        console.error('[seed-guild-example] This seeds known passwords into the local account/save files; it is for local play only.');
        process.exitCode = 1;
        return;
    }

    const dataDir = path.join(Config.DATA_DIR, 'data');
    CharacterTemplates.load(dataDir);

    const db = new JsonAdapter();
    const passwordRecord = await hashPlaintextPasswordForClient(DEFAULT_PASSWORD);

    const neodevils = await ensureGuildMember(
        db,
        NEODEVILS_NAME,
        RANK_GUILD_MASTER,
        'neodevils@theminesa.studio',
        'Mage',
        passwordRecord
    );

    // Logging in as Neodevils needs a known password on whatever account owns the
    // character, so reset it (the same deal seedTestAccount makes for its account).
    const neodevilsAccount = await db.getAccountById(neodevils.userId);
    if (!neodevilsAccount) {
        throw new Error(`No account found for user_id ${neodevils.userId} (owner of ${NEODEVILS_NAME}).`);
    }
    await db.updateAccountPassword(neodevilsAccount.email, passwordRecord);

    const telahair = await ensureGuildMember(
        db,
        TELAHAIR_NAME,
        RANK_MEMBER,
        TELAHAIR_EMAIL,
        TELAHAIR_FALLBACK_CLASS,
        passwordRecord
    );
    await db.updateAccountPassword(TELAHAIR_EMAIL, passwordRecord);

    const describe = (entry: { userId: number; character: Character; created: boolean }): string =>
        `${String(entry.character.name).padEnd(10)} ${String(entry.character.class).padEnd(8)} ` +
        `level ${String(entry.character.level).padStart(2)}  user_id ${entry.userId}  ` +
        `${entry.created ? 'created' : 'reused'}`;

    console.log(`[seed-guild-example] Guild "${GUILD_NAME}" ready:`);
    console.log(`  ${describe(neodevils)}  rank ${RANK_GUILD_MASTER} (leader)`);
    console.log(`  ${describe(telahair)}  rank ${RANK_MEMBER} (member)`);
    console.log('');
    console.log(`[seed-guild-example] Login as ${neodevilsAccount.email} / ${DEFAULT_PASSWORD} to see the guild page.`);
    console.log(`[seed-guild-example] ${TELAHAIR_NAME} is offline; her roster entry should show grayed out with "Offline".`);
}

main().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
});
