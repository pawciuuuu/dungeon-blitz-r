# 𝐃𝐮𝐧𝐠𝐞𝐨𝐧 𝐁𝐥𝐢𝐭𝐳: 𝐑

Open-source fan revival project of Dungeon Blitz developed by The Minesa Studios.

## About

Dungeon Blitz: R aims to preserve and modernize the Dungeon Blitz experience while improving stability, maintainability, and multiplayer functionality.

The project focuses on:

* Multiplayer support
* Bug fixes and stability improvements
* Localization
* Gameplay balancing
* Quality-of-life improvements
* Community-driven development

## Project Status

Active Development

Current priorities:

* Multiplayer implementation
* Region completion
* Gameplay balancing
* Performance improvements

## Playtest account

For local testing there is a seeder that creates `test@theminesa.studio` with six
characters — one fully-completed and one brand new for each of the three classes:

```bash
cd src/server && npm run seed:test-account
```

| Character | Class | State |
| --- | --- | --- |
| `MaxMage` / `MaxPaladin` / `MaxRogue` | Mage / Paladin / Rogue | Level 50, all 293 missions claimed, all 39 class abilities at rank 10, maxed talents and buildings, every mount, pet, charm, dye and material |
| `NewMage` / `NewPaladin` / `NewRogue` | Mage / Paladin / Rogue | Level 1, zero of everything |

The password defaults to `testtest`; override it with `TEST_ACCOUNT_PASSWORD`. Re-running
the seeder is safe — it reuses the account and rewrites the six characters.

The seeder **refuses to run when `MULTIPLAYER_MODE` is set**. It writes a known password
and a character holding every unlock in the game, which is local-play-only by nature.

It writes to `src/server/data/Accounts.json`, which is tracked by git. Leave that change
out of your commits: the matching save file lives in the untracked `saves/` directory, so
a committed account row would be an empty account plus a published password hash.

## Documentation

Project documentation can be found in the Wiki.

## Disclaimer

Dungeon Blitz: R is a fan-made revival project.

Dungeon Blitz and all original assets, trademarks, artwork, audio, characters, and intellectual property belong to their respective owners.

This repository only licenses original code and modifications created by The Minesa Studios and project contributors.
