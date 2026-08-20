#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const TARGET_SWFS = [
    path.join('src', 'client', 'content', 'localhost', 'p', 'cbp', 'DungeonBlitz.swf')
];

/**
 * Show a player's guild name under their character name (#718).
 *
 * The server now appends a guild block to player entity payloads (0xF spawn
 * packets, see `Entity.serialize`): a 1-bit presence flag, then the guild name
 * and a 3-bit rank when present. Two client classes are patched at source level
 * via FFDec:
 *
 *  - LinkUpdater.method_1615  parses 0xF entity spawns. For player entities it
 *    reads the trailing guild block and feeds it to Entity.method_436, the
 *    stock renderer that draws the "<GuildName>" tag under the character's
 *    nameplate (and stores the guild name on the entity for the inspect
 *    window). Remote players' guild tags now appear above their heads.
 *  - class_68.OnRefreshScreen the inspect window that opens when you double
 *    click a player. It appends the entity's guild name (var_1931) to the
 *    class/level line, right under the character's name, so double-clicking any
 *    player - including yourself - shows their guild.
 *
 * The local player's own guild already flows to clientEnt.var_1931 through the
 * world-enter guild block (LinkUpdater.method_933), so the inspect window
 * covers your own character with no extra server work.
 */

function parseArgs(argv) {
    const args = {
        ffdec: '',
        verify: false,
        swfs: []
    };

    for (let index = 2; index < argv.length; index++) {
        const arg = argv[index];
        if (arg === '--ffdec' || arg === '-f') {
            args.ffdec = argv[++index] || '';
            continue;
        }
        if (arg === '--swf' || arg === '-s') {
            args.swfs.push(argv[++index] || '');
            continue;
        }
        if (arg === '--verify') {
            args.verify = true;
            continue;
        }
        if (arg === '--help' || arg === '-h') {
            printHelp();
            process.exit(0);
        }

        throw new Error(`Unknown argument: ${arg}`);
    }

    return args;
}

function printHelp() {
    console.log(
        [
            'Usage:',
            '  node src/server/scripts/patch-dungeonblitz-guild-name.js [--verify] [--swf <path>] [--ffdec <path>]',
            '',
            'Defaults:',
            '  patches LinkUpdater + class_68 in the served DungeonBlitz SWF so guild',
            '  names show under character nameplates and in the inspect window.'
        ].join('\n')
    );
}

function resolveRepoRoot() {
    return path.resolve(__dirname, '..', '..', '..');
}

function resolvePath(repoRoot, value) {
    if (!value) {
        return '';
    }
    if (path.isAbsolute(value)) {
        return value;
    }
    return path.join(repoRoot, value);
}

function detectFfdec(repoRoot, preferred) {
    const candidates = [];
    if (preferred) {
        candidates.push(resolvePath(repoRoot, preferred));
    }

    candidates.push(
        path.join(repoRoot, 'build', 'ffdec', 'ffdec.sh'),
        path.join(repoRoot, 'build', 'ffdec', 'ffdec.jar'),
        path.join(repoRoot, 'build', 'ffdec', 'ffdec-cli.jar'),
        path.join(repoRoot, 'build', 'tools', 'ffdec_25.1.3', 'ffdec.sh'),
        path.join(repoRoot, 'build', 'tools', 'ffdec_25.1.3', 'ffdec.jar'),
        path.join(repoRoot, 'build', 'tools', 'ffdec_25.1.3', 'ffdec-cli.jar'),
        '/Applications/FFDec.app/Contents/Resources/ffdec.sh',
        '/Applications/FFDec.app/Contents/Resources/ffdec.jar',
        '/Applications/FFDec.app/Contents/Resources/ffdec-cli.jar'
    );

    for (const candidate of candidates) {
        if (candidate && fs.existsSync(candidate)) {
            return candidate;
        }
    }

    return '';
}

function runFfdec(ffdecPath, args) {
    const resolved = path.resolve(ffdecPath);
    const basename = path.basename(resolved).toLowerCase();

    if (basename.endsWith('.jar')) {
        execFileSync('java', ['-jar', resolved, '-cli', ...args], {
            stdio: 'inherit'
        });
        return;
    }

    execFileSync(resolved, ['-cli', ...args], {
        stdio: 'inherit'
    });
}

function replaceBlock(source, candidates, replacement, label) {
    if (source.includes(replacement)) {
        return source;
    }

    for (const candidate of candidates) {
        if (candidate && source.includes(candidate)) {
            return source.replace(candidate, replacement);
        }
    }

    throw new Error(`Could not find patch marker: ${label}`);
}

function patchLinkUpdater(source) {
    const eol = source.includes('\r\n') ? '\r\n' : '\n';
    const join = (lines) => lines.join(eol);

    // method_1615 parses 0xF entity spawns. The server appends a guild block
    // (presence flag + guild name + 3-bit rank) at the END of the player
    // payload, after the buffs section, so older clients that never read it are
    // unaffected. For player entities we read it here and hand it to
    // Entity.method_436, the stock "<GuildName>" tag renderer; that both draws
    // the tag under the character's nameplate and stores the guild name on the
    // entity (var_1931) for the inspect window.
    const loopEndOriginal = join([
        '            _loc49_++;',
        '         }',
        '         _loc46_.currHP -= _loc47_;'
    ]);
    const loopEndPatched = join([
        '            _loc49_++;',
        '         }',
        '         if(_loc12_ == Entity.PLAYER && param1.method_11())',
        '         {',
        '            _loc26_ = param1.method_13();',
        '            _loc28_ = param1.method_6(Entity.const_172);',
        '            _loc46_.method_436(_loc26_,_loc28_);',
        '         }',
        '         _loc46_.currHP -= _loc47_;'
    ]);

    let patched = source;
    patched = replaceBlock(
        patched,
        [loopEndOriginal],
        loopEndPatched,
        'LinkUpdater entity spawn guild block read'
    );

    return patched;
}

function verifyLinkUpdater(source, swfPath) {
    if (!source.includes('_loc46_.method_436(_loc26_,_loc28_);')) {
        throw new Error(`${path.basename(swfPath)} LinkUpdater is missing the entity guild-name render call.`);
    }
    if (!source.includes('_loc12_ == Entity.PLAYER && param1.method_11()')) {
        throw new Error(`${path.basename(swfPath)} LinkUpdater is missing the entity guild presence-flag check.`);
    }
    if (/^\s*_loc49_\+\+;\s*}\s*_loc46\.currHP -= _loc47_;/m.test(source)) {
        throw new Error(`${path.basename(swfPath)} LinkUpdater still has the unpatched entity spawn tail.`);
    }
}

function patchClass68(source) {
    const eol = source.includes('\r\n') ? '\r\n' : '\n';
    const join = (lines) => lines.join(eol);

    // OnRefreshScreen fills the inspect window (opened by double-clicking a
    // player, including yourself). After the character name (am_Header) and the
    // "Class, Level N" line (am_Class), append the entity's guild name
    // (var_1931, stored by method_436) in the same "<Guild>" style the nameplate
    // tag uses, so the guild shows right under the character's name.
    const classLineOriginal = join([
        '         MathUtil.method_2(var_2.am_Class,(_loc1_.mMasterClass ? _loc1_.mMasterClass : _loc2_) + ", Level " + _loc1_.mExpLevel);'
    ]);
    const classLinePatched = join([
        '         MathUtil.method_2(var_2.am_Class,(_loc1_.mMasterClass ? _loc1_.mMasterClass : _loc2_) + ", Level " + _loc1_.mExpLevel + (_loc1_.var_1931 ? "  <" + _loc1_.var_1931 + ">" : ""));'
    ]);

    let patched = source;
    patched = replaceBlock(
        patched,
        [classLineOriginal],
        classLinePatched,
        'class_68 inspect window guild line'
    );

    return patched;
}

function verifyClass68(source, swfPath) {
    if (!source.includes('(_loc1_.var_1931 ? "  <" + _loc1_.var_1931 + ">" : "")')) {
        throw new Error(`${path.basename(swfPath)} class_68 is missing the inspect-window guild name.`);
    }
    if (source.includes(', " Level " + _loc1_.mExpLevel);')) {
        throw new Error(`${path.basename(swfPath)} class_68 still has the unpatched inspect-window class line.`);
    }
}

function exportScripts(ffdecPath, workRoot, swfPath) {
    fs.rmSync(workRoot, { recursive: true, force: true });
    fs.mkdirSync(workRoot, { recursive: true });
    runFfdec(ffdecPath, ['-selectclass', 'LinkUpdater,class_68', '-export', 'script', workRoot, swfPath]);

    const linkUpdaterPath = path.join(workRoot, 'scripts', 'LinkUpdater.as');
    const class68Path = path.join(workRoot, 'scripts', 'class_68.as');
    if (!fs.existsSync(linkUpdaterPath)) {
        throw new Error(`FFDec export did not produce ${linkUpdaterPath}`);
    }
    if (!fs.existsSync(class68Path)) {
        throw new Error(`FFDec export did not produce ${class68Path}`);
    }

    return { linkUpdaterPath, class68Path };
}

function patchSwf(repoRoot, ffdecPath, swfPath) {
    const workRoot = path.join(
        repoRoot,
        'build',
        'ffdec-dungeonblitz-guild-name',
        path.basename(swfPath, path.extname(swfPath))
    );
    const patchedSwfPath = path.join(workRoot, `${path.basename(swfPath, path.extname(swfPath))}.patched.swf`);
    const { linkUpdaterPath, class68Path } = exportScripts(ffdecPath, workRoot, swfPath);

    const linkUpdaterOriginal = fs.readFileSync(linkUpdaterPath, 'utf8');
    const linkUpdaterPatched = patchLinkUpdater(linkUpdaterOriginal);
    const class68Original = fs.readFileSync(class68Path, 'utf8');
    const class68Patched = patchClass68(class68Original);

    if (linkUpdaterPatched === linkUpdaterOriginal && class68Patched === class68Original) {
        verifyLinkUpdater(linkUpdaterOriginal, swfPath);
        verifyClass68(class68Original, swfPath);
        console.log(`SWF already contains the guild name patch: ${swfPath}`);
        return;
    }

    fs.writeFileSync(linkUpdaterPath, linkUpdaterPatched, 'utf8');
    fs.writeFileSync(class68Path, class68Patched, 'utf8');
    runFfdec(ffdecPath, ['-importScript', swfPath, patchedSwfPath, path.dirname(linkUpdaterPath)]);
    fs.copyFileSync(patchedSwfPath, swfPath);
    console.log(`Patched guild names in ${swfPath}`);
}

function verifySwf(repoRoot, ffdecPath, swfPath) {
    const workRoot = path.join(
        repoRoot,
        'build',
        'ffdec-dungeonblitz-guild-name-verify',
        path.basename(swfPath, path.extname(swfPath))
    );
    const { linkUpdaterPath, class68Path } = exportScripts(ffdecPath, workRoot, swfPath);
    verifyLinkUpdater(fs.readFileSync(linkUpdaterPath, 'utf8'), swfPath);
    verifyClass68(fs.readFileSync(class68Path, 'utf8'), swfPath);
    console.log(`Verified guild name patch in ${swfPath}`);
}

function main() {
    const repoRoot = resolveRepoRoot();
    const args = parseArgs(process.argv);
    const ffdecPath = detectFfdec(repoRoot, args.ffdec);

    if (!ffdecPath) {
        throw new Error('FFDec not found. Pass --ffdec or install JPEXS FFDec.');
    }

    const swfs = (args.swfs.length ? args.swfs : TARGET_SWFS).map((entry) => resolvePath(repoRoot, entry));
    for (const swfPath of swfs) {
        if (!fs.existsSync(swfPath)) {
            throw new Error(`SWF not found: ${swfPath}`);
        }
    }

    if (args.verify) {
        for (const swfPath of swfs) {
            verifySwf(repoRoot, ffdecPath, swfPath);
        }
        return;
    }

    for (const swfPath of swfs) {
        patchSwf(repoRoot, ffdecPath, swfPath);
    }
}

try {
    main();
} catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
}
