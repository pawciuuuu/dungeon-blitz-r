import * as fs from "fs";
import * as path from "path";
import { ensureBackup, parseSwz, SwzPatchError, writeSwz } from "./swzPatchUtils";

/**
 * Restores the three CraftTown (home) training dummies to their original decoy look.
 *
 * An earlier iteration of this patch rewrote HomeDummy1..3 into Dread boss look-alikes (Dread
 * Lotte / Dread Prince Friedrich Hocke / Dread Tanja) so the home garden read as an enemy lineup.
 * This iteration does the opposite: it rewrites the same three entries back to the plain
 * `a__TrainingDummyAnimation` decoys ("Ev Dummy 1/2/3") from Animation_Environmentals.swf.
 *
 * The dummies are placed by the home level SWF and referenced by EntName, so the placement is
 * kept: only the identity/appearance of HomeDummy1..3 is rewritten. Behavior (HomeDummy), hit
 * points, NoLoot and Speed 0 stay untouched so they still behave as immortal practice targets.
 *
 * The patch name (`patch:home-dummy-bosses`) is kept so the prebuild pipeline and
 * `verify:client-patches` keep running the same step; its effect is now "dummies stay decoys".
 */

type DummyBossDef = {
  entName: string;
  parent: string;
  displayName: string;
  width: string;
  height: string;
  gfx: string[];
};

const ORIGINAL_DUMMIES: DummyBossDef[] = [
  {
    entName: "HomeDummy1",
    parent: "Base",
    displayName: "Ev Dummy 1",
    width: "60",
    height: "200",
    gfx: [
      "<AnimClass>a__TrainingDummyAnimation</AnimClass>",
      "<AnimFile>Animation_Environmentals.swf</AnimFile>",
      "<FlipAnim>TRUE</FlipAnim>",
      "<AnimScale>0.8</AnimScale>",
      "<MoveAnimSpeed>1</MoveAnimSpeed>"
    ]
  },
  {
    entName: "HomeDummy2",
    parent: "Base",
    displayName: "Ev Dummy 2",
    width: "60",
    height: "200",
    gfx: [
      "<AnimClass>a__TrainingDummyAnimation</AnimClass>",
      "<AnimFile>Animation_Environmentals.swf</AnimFile>",
      "<FlipAnim>TRUE</FlipAnim>",
      "<AnimScale>0.8</AnimScale>",
      "<MoveAnimSpeed>1</MoveAnimSpeed>",
      "<CustomArt>Animation_Environmentals.swf/Alt1</CustomArt>"
    ]
  },
  {
    entName: "HomeDummy3",
    parent: "Base",
    displayName: "Ev Dummy 3",
    width: "60",
    height: "200",
    gfx: [
      "<AnimClass>a__TrainingDummyAnimation</AnimClass>",
      "<AnimFile>Animation_Environmentals.swf</AnimFile>",
      "<FlipAnim>TRUE</FlipAnim>",
      "<AnimScale>0.8</AnimScale>",
      "<MoveAnimSpeed>1</MoveAnimSpeed>",
      "<CustomArt>Animation_Environmentals.swf/Alt2</CustomArt>"
    ]
  }
];

const DUMMY_HIT_POINTS = "1000000";

type DummyBossStats = {
  updated: number;
  verified: number;
};

function buildEntTypeBlock(def: DummyBossDef): string {
  const lines: string[] = [];
  lines.push(`<EntType EntName="${def.entName}" parent="${def.parent}">`);
  lines.push(`\t\t<DisplayName>${def.displayName}</DisplayName>`);
  lines.push("\t\t<DevStatus>New House</DevStatus>");
  lines.push("\t\t<Level>1</Level>");
  lines.push("\t\t<GroupLevel>1</GroupLevel>");
  lines.push("\t\t<EntRank>Minion</EntRank>");
  lines.push("\t\t<MeleeDamage>0</MeleeDamage>");
  lines.push("\t\t<MagicDamage>1</MagicDamage>");
  lines.push("\t\t<ArmorClass>1</ArmorClass>");
  lines.push(`\t\t<HitPoints>${DUMMY_HIT_POINTS}</HitPoints>`);
  lines.push("\t\t<RewardClass>NoLoot</RewardClass>");
  lines.push("\t\t<Realm>Object</Realm>");
  lines.push("\t\t<Speed>0</Speed>");
  lines.push(`\t\t<Width>${def.width}</Width>`);
  lines.push(`\t\t<Height>${def.height}</Height>`);
  lines.push("\t\t<Behavior>HomeDummy</Behavior>");
  lines.push("\t\t<EquippedGear/>");
  lines.push("\t\t<GfxType>");
  for (const entry of def.gfx) {
    lines.push(`\t\t\t${entry}`);
  }
  lines.push("\t\t</GfxType>");
  lines.push("\t</EntType>");
  return lines.join("\n");
}

export function patchHomeDummyBossXml(xml: string): { xml: string; stats: DummyBossStats } {
  let updated = 0;
  let verified = 0;
  let patchedXml = xml;

  for (const def of ORIGINAL_DUMMIES) {
    const blockPattern = new RegExp(`<EntType EntName="${def.entName}"[^>]*>[\\s\\S]*?<\\/EntType>`);
    const target = buildEntTypeBlock(def);
    let matched = false;
    patchedXml = patchedXml.replace(blockPattern, (block: string) => {
      matched = true;
      verified += 1;
      if (block !== target) {
        updated += 1;
      }
      return target;
    });
    if (!matched) {
      throw new SwzPatchError(`missing EntType ${def.entName}`);
    }
  }

  return { xml: patchedXml, stats: { updated, verified } };
}

function assertHomeDummyBossXml(xml: string, label: string): DummyBossStats {
  const patched = patchHomeDummyBossXml(xml);
  if (patched.stats.verified !== ORIGINAL_DUMMIES.length || patched.stats.updated !== 0) {
    throw new SwzPatchError(`${label} HomeDummy decoy appearances are not applied`);
  }
  return patched.stats;
}

function defaultSourceXmlPath(): string {
  return path.resolve(__dirname, "..", "..", "client", "content", "xml", "EntTypes.xml");
}

function defaultServerJsonPaths(): string[] {
  return [
    path.resolve(__dirname, "..", "data", "EntTypes.json"),
    path.resolve(__dirname, "..", "dist", "data", "EntTypes.json")
  ].filter((jsonPath) => fs.existsSync(jsonPath));
}

function defaultGameSwzPaths(): string[] {
  const cbqDir = path.resolve(__dirname, "..", "..", "client", "content", "localhost", "p", "cbq");
  return ["Login.swz", "Game.swz", "Game.en.swz", "Game.tr.swz"]
    .map((name) => path.join(cbqDir, name))
    .filter((swzPath) => fs.existsSync(swzPath))
    .filter((swzPath) => {
      try {
        return parseSwz(swzPath).chunks.some((entry) => entry.xml.includes("<EntTypes"));
      } catch {
        return false;
      }
    });
}

function resolveArgPaths(args: string[], flag: string, defaults: string[]): string[] {
  const resolved: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] !== flag) {
      continue;
    }
    const value = args[index + 1];
    if (!value) {
      throw new SwzPatchError(`Missing value for ${flag}`);
    }
    resolved.push(path.resolve(process.cwd(), value));
    index += 1;
  }
  return resolved.length > 0 ? resolved : defaults;
}

function resolveArgPath(args: string[], flag: string, defaultPath: string): string {
  const index = args.indexOf(flag);
  if (index < 0) {
    return defaultPath;
  }
  const value = args[index + 1];
  if (!value) {
    throw new SwzPatchError(`Missing value for ${flag}`);
  }
  return path.resolve(process.cwd(), value);
}

function patchSourceXml(xmlPath: string, verifyOnly: boolean): DummyBossStats {
  const original = fs.readFileSync(xmlPath, "utf8");
  const patched = patchHomeDummyBossXml(original);
  if (verifyOnly) {
    return assertHomeDummyBossXml(original, "source XML");
  }
  if (patched.xml !== original) {
    fs.writeFileSync(xmlPath, patched.xml, "utf8");
  }
  return assertHomeDummyBossXml(patched.xml, "source XML");
}

function findEntTypeArray(data: any): any[] {
  const direct = data?.EntTypes?.EntType;
  if (Array.isArray(direct)) {
    return direct;
  }
  const nested = data?.EntTypes?.EntTypes?.EntType;
  if (Array.isArray(nested)) {
    return nested;
  }
  throw new SwzPatchError("server JSON has no EntTypes.EntType array");
}

function patchServerJson(jsonPath: string, verifyOnly: boolean): DummyBossStats {
  const original = fs.readFileSync(jsonPath, "utf8");
  const hasBom = original.charCodeAt(0) === 0xfeff;
  const data = JSON.parse(hasBom ? original.slice(1) : original);
  const entTypes = findEntTypeArray(data);
  let updated = 0;
  let verified = 0;

  for (const def of ORIGINAL_DUMMIES) {
    const entry = entTypes.find((candidate: { EntName?: string }) => candidate.EntName === def.entName);
    if (!entry) {
      throw new SwzPatchError(`server JSON missing ${def.entName}`);
    }
    verified += 1;

    const desired: Record<string, string> = {
      parent: def.parent,
      DisplayName: "Training Dummy",
      Width: def.width,
      Height: def.height
    };

    for (const [key, value] of Object.entries(desired)) {
      if (entry[key] !== value) {
        updated += 1;
        entry[key] = value;
      }
    }

    // Drop the boss-look fields the previous iteration added (gender fix, sounds); the original
    // decoys carry none of them.
    for (const key of ["GenderFix", "SoundDeathRattle", "SoundHitGrunt", "SoundBloodied"]) {
      if (key in entry) {
        updated += 1;
        delete entry[key];
      }
    }

    if (entry.HitPoints !== DUMMY_HIT_POINTS || entry.Behavior !== "HomeDummy") {
      throw new SwzPatchError(`server JSON ${def.entName} lost its dummy behavior`);
    }
  }

  if (verifyOnly && updated !== 0) {
    throw new SwzPatchError("server JSON HomeDummy decoy appearances are not applied");
  }
  if (!verifyOnly && updated !== 0) {
    fs.writeFileSync(jsonPath, `${hasBom ? "\ufeff" : ""}${JSON.stringify(data, null, 2)}\n`, "utf8");
  }
  return { updated: verifyOnly ? 0 : updated, verified };
}

function patchGameSwz(swzPath: string, verifyOnly: boolean): DummyBossStats {
  const ctx = parseSwz(swzPath);
  const chunk = ctx.chunks.find((entry) => entry.xml.includes("<EntTypes"));
  if (!chunk) {
    throw new SwzPatchError(`${path.basename(swzPath)} missing EntTypes`);
  }

  const original = chunk.xml;
  if (verifyOnly) {
    return assertHomeDummyBossXml(original, path.basename(swzPath));
  }

  const patched = patchHomeDummyBossXml(original);
  if (patched.xml !== original) {
    ensureBackup(swzPath);
    chunk.xml = patched.xml;
    writeSwz(ctx);
  }
  return assertHomeDummyBossXml(patched.xml, path.basename(swzPath));
}

function main(): void {
  const args = process.argv.slice(2);
  const verifyOnly = args.includes("--verify");
  const xmlPath = resolveArgPath(args, "--xml-path", defaultSourceXmlPath());
  const jsonPaths = resolveArgPaths(args, "--json-path", defaultServerJsonPaths());
  const swzPaths = resolveArgPaths(args, "--swz-path", defaultGameSwzPaths());

  console.log(`XML: ${xmlPath}`);
  console.log(JSON.stringify(patchSourceXml(xmlPath, verifyOnly)));

  for (const jsonPath of jsonPaths) {
    console.log(`JSON: ${jsonPath}`);
    console.log(JSON.stringify(patchServerJson(jsonPath, verifyOnly)));
  }

  for (const swzPath of swzPaths) {
    console.log(`SWZ: ${swzPath}`);
    console.log(JSON.stringify(patchGameSwz(swzPath, verifyOnly)));
  }
}

if (require.main === module) {
  try {
    main();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[patch_gameswz_home_dummy_bosses] ${message}`);
    process.exitCode = 1;
  }
}
