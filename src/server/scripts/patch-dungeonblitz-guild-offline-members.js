#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const TARGET_SWFS = [
    path.join('src', 'client', 'content', 'localhost', 'p', 'cbp', 'DungeonBlitz.swf')
];

/**
 * Guild page should show offline members (#717).
 *
 * The server used to send only *online* guild members in the guild-update packet
 * (0x56) and the world-enter guild block, and the client hardcoded every member
 * it parsed as online. This patch teaches the client to read the per-member
 * online flag the server now sends, so offline guildmates show up on the guild
 * page (grayed out with an "Offline" tag, matching the friends list) instead of
 * disappearing entirely. It also makes the panel header count only the members
 * who are actually online ("2 of 5 members online.").
 *
 * Two client classes are patched at source level via FFDec:
 *  - LinkUpdater.method_933  parses both the guild-update packet and the guild
 *    block embedded in the world-enter packet (the WELCOME handler delegates to
 *    it), so one edit covers both.
 *  - class_56.method_159     refreshes the guild tab and writes the member count.
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
            '  node src/server/scripts/patch-dungeonblitz-guild-offline-members.js [--verify] [--swf <path>] [--ffdec <path>]',
            '',
            'Defaults:',
            '  patches LinkUpdater + class_56 in the served DungeonBlitz SWF so the',
            '  guild page lists offline members (marked Offline) instead of only online ones.'
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

function replaceExact(source, needle, replacement, label) {
    if (!source.includes(needle)) {
        throw new Error(`Could not find patch marker: ${label}`);
    }
    return source.replace(needle, replacement);
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

    // method_933 reads one guild member per iteration: name, class, level, rank.
    // The server now leads each member with a 1-bit online flag (written with
    // writeMethod11(value, 1) / read here with method_11()). We stash it in a new
    // local and hand it to the Friend constructor as bOnline. The name is also
    // passed as var_207 so the shared offline row renderer in the social window
    // has a display name to show alongside the "Offline" tag.
    const loopStartOriginal = join([
        '            while(_loc9_ < _loc8_)',
        '            {',
        '               _loc10_ = param1.method_13();'
    ]);
    const loopStartPatched = join([
        '            while(_loc9_ < _loc8_)',
        '            {',
        '               _loc14_ = param1.method_11();',
        '               _loc10_ = param1.method_13();'
    ]);

    // Note the double closing paren: FFDec renders the constructor call inside
    // push() with an extra wrapping pair, i.e. push((new Friend(...))).
    const friendPushOriginal = join([
        '                  _loc6_.push(new Friend(_loc10_,null,true,_loc12_,_loc11_,false,_loc13_));'
    ]);
    const friendPushPatched = join([
        '                  _loc6_.push(new Friend(_loc10_,_loc10_,_loc14_,_loc12_,_loc11_,false,_loc13_));'
    ]);

    let patched = source;
    patched = replaceBlock(
        patched,
        [loopStartOriginal],
        loopStartPatched,
        'LinkUpdater guild member online flag read'
    );
    patched = replaceBlock(
        patched,
        [friendPushOriginal],
        friendPushPatched,
        'LinkUpdater guild member Friend construction'
    );

    return patched;
}

function verifyLinkUpdater(source, swfPath) {
    if (!source.includes('_loc14_ = param1.method_11();')) {
        throw new Error(`${path.basename(swfPath)} LinkUpdater is missing the guild online-flag read.`);
    }
    // Paren counts vary between FFDec renderings of the nested constructor call, so
    // compare the argument list without trailing parentheses.
    if (!source.includes('new Friend(_loc10_,_loc10_,_loc14_,_loc12_,_loc11_,false,_loc13_')) {
        throw new Error(`${path.basename(swfPath)} LinkUpdater still constructs guild members as always-online.`);
    }
    if (source.includes('new Friend(_loc10_,null,true,_loc12_,_loc11_,false,_loc13_')) {
        throw new Error(`${path.basename(swfPath)} LinkUpdater still contains the always-online guild member construction.`);
    }
}

function patchClass56(source) {
    const eol = source.includes('\r\n') ? '\r\n' : '\n';
    const join = (lines) => lines.join(eol);

    // method_145 renders one list row. Offline guild members previously showed
    // only their name (var_207) with an "Offline" tag; give them the same
    // "[rank] Name, Level X Class" treatment as online rows, wrapped in the gray
    // const_992 font so the whole row reads as offline. Friends/zone/ignore lists
    // keep their existing offline rendering (param4 != const_530).
    const offlineRowOriginal = join([
        '               else if(!_loc10_.bOnline)',
        '               {',
        '                  MathUtil.method_2(_loc11_.am_Name,_loc10_.var_207,true);',
        '                  if(_loc10_.var_276)',
        '                  {',
        '                     MathUtil.method_2(_loc11_.am_Zone,const_539 + "Pending" + class_127.var_121,true);',
        '                  }',
        '                  else',
        '                  {',
        '                     MathUtil.method_2(_loc11_.am_Zone,const_992 + "Offline" + class_127.var_121,true);',
        '                  }',
        '               }'
    ]);
    const offlineRowPatched = join([
        '               else if(!_loc10_.bOnline)',
        '               {',
        '                  if(param4 == const_530)',
        '                  {',
        '                     _loc7_ = _loc10_.charName + ", Level " + _loc10_.var_2100 + " " + _loc10_.className;',
        '                     if(_loc10_.var_289 == Entity.const_236)',
        '                     {',
        '                        _loc13_ = "[L]";',
        '                     }',
        '                     else if(_loc10_.var_289 == Entity.const_139)',
        '                     {',
        '                        _loc13_ = "[O]";',
        '                     }',
        '                     else if(_loc10_.var_289 == Entity.const_309)',
        '                     {',
        '                        _loc13_ = "[M]";',
        '                     }',
        '                     else if(_loc10_.var_289 == Entity.const_308)',
        '                     {',
        '                        _loc13_ = "[I]";',
        '                     }',
        '                     else if(_loc10_.var_289 == Entity.const_470)',
        '                     {',
        '                        _loc13_ = "[S]";',
        '                     }',
        '                     _loc7_ = _loc13_ + " " + _loc7_;',
        '                     MathUtil.method_2(_loc11_.am_Name,const_992 + _loc7_ + class_127.var_121,true);',
        '                     MathUtil.method_2(_loc11_.am_Zone,const_992 + "Offline" + class_127.var_121,true);',
        '                  }',
        '                  else',
        '                  {',
        '                     MathUtil.method_2(_loc11_.am_Name,_loc10_.var_207,true);',
        '                     if(_loc10_.var_276)',
        '                     {',
        '                        MathUtil.method_2(_loc11_.am_Zone,const_539 + "Pending" + class_127.var_121,true);',
        '                     }',
        '                     else',
        '                     {',
        '                        MathUtil.method_2(_loc11_.am_Zone,const_992 + "Offline" + class_127.var_121,true);',
        '                     }',
        '                  }',
        '               }'
    ]);

    // method_159 counts every entry in the guild list as the "members online"
    // number, which was fine when the server only sent online members. With the
    // full roster now present, count only bOnline entries and report both counts,
    // mirroring the friends tab's "X of Y friends online." phrasing.
    const countOriginal = join([
        '         var _loc2_:uint = param1.length;',
        '         if(!this.var_1.clientEnt || !this.var_1.clientEnt.var_1931)',
        '         {',
        '            MathUtil.method_2(this.var_26.am_GuildPanel.am_Count,"");',
        '         }',
        '         else if(!_loc2_)',
        '         {',
        '            MathUtil.method_2(this.var_26.am_GuildPanel.am_Count,"No members online.");',
        '         }',
        '         else if(_loc2_ == 1)',
        '         {',
        '            MathUtil.method_2(this.var_26.am_GuildPanel.am_Count,"1 member online.");',
        '         }',
        '         else',
        '         {',
        '            MathUtil.method_2(this.var_26.am_GuildPanel.am_Count,_loc2_ + " members online.");',
        '         }'
    ]);
    const countPatched = join([
        '         var _loc2_:uint = 0;',
        '         var _loc3_:Friend = null;',
        '         for each(_loc3_ in param1)',
        '         {',
        '            if(_loc3_.bOnline)',
        '            {',
        '               _loc2_++;',
        '            }',
        '         }',
        '         if(!this.var_1.clientEnt || !this.var_1.clientEnt.var_1931)',
        '         {',
        '            MathUtil.method_2(this.var_26.am_GuildPanel.am_Count,"");',
        '         }',
        '         else if(!param1.length)',
        '         {',
        '            MathUtil.method_2(this.var_26.am_GuildPanel.am_Count,"No members online.");',
        '         }',
        '         else',
        '         {',
        '            MathUtil.method_2(this.var_26.am_GuildPanel.am_Count,_loc2_ + " of " + param1.length + " members online.");',
        '         }'
    ]);

    let patched = source;
    patched = replaceBlock(
        patched,
        [offlineRowOriginal],
        offlineRowPatched,
        'class_56 offline guild row rank/level/class'
    );
    patched = replaceBlock(
        patched,
        [countOriginal],
        countPatched,
        'class_56 guild member online count'
    );

    return patched;
}

function verifyClass56(source, swfPath) {
    if (!source.includes('for each(_loc3_ in param1)')) {
        throw new Error(`${path.basename(swfPath)} class_56 is missing the guild online-count loop.`);
    }
    if (!source.includes('_loc2_ + " of " + param1.length + " members online."')) {
        throw new Error(`${path.basename(swfPath)} class_56 is missing the guild online-of-total count text.`);
    }
    if (source.includes('"1 member online."')) {
        throw new Error(`${path.basename(swfPath)} class_56 still contains the stale single-online count branch.`);
    }
    if (!source.includes('MathUtil.method_2(_loc11_.am_Name,const_992 + _loc7_ + class_127.var_121,true);')) {
        throw new Error(`${path.basename(swfPath)} class_56 is missing the gray offline guild row name.`);
    }
    if (!source.includes('MathUtil.method_2(_loc11_.am_Name,_loc10_.var_207,true);')) {
        throw new Error(`${path.basename(swfPath)} class_56 is missing the non-guild offline row branch.`);
    }
}

function exportScripts(ffdecPath, workRoot, swfPath) {
    fs.rmSync(workRoot, { recursive: true, force: true });
    fs.mkdirSync(workRoot, { recursive: true });
    runFfdec(ffdecPath, ['-selectclass', 'LinkUpdater,class_56', '-export', 'script', workRoot, swfPath]);

    const linkUpdaterPath = path.join(workRoot, 'scripts', 'LinkUpdater.as');
    const class56Path = path.join(workRoot, 'scripts', 'class_56.as');
    if (!fs.existsSync(linkUpdaterPath)) {
        throw new Error(`FFDec export did not produce ${linkUpdaterPath}`);
    }
    if (!fs.existsSync(class56Path)) {
        throw new Error(`FFDec export did not produce ${class56Path}`);
    }

    return { linkUpdaterPath, class56Path };
}

function patchSwf(repoRoot, ffdecPath, swfPath) {
    const workRoot = path.join(
        repoRoot,
        'build',
        'ffdec-dungeonblitz-guild-offline-members',
        path.basename(swfPath, path.extname(swfPath))
    );
    const patchedSwfPath = path.join(workRoot, `${path.basename(swfPath, path.extname(swfPath))}.patched.swf`);
    const { linkUpdaterPath, class56Path } = exportScripts(ffdecPath, workRoot, swfPath);

    const linkUpdaterOriginal = fs.readFileSync(linkUpdaterPath, 'utf8');
    const linkUpdaterPatched = patchLinkUpdater(linkUpdaterOriginal);
    const class56Original = fs.readFileSync(class56Path, 'utf8');
    const class56Patched = patchClass56(class56Original);

    if (linkUpdaterPatched === linkUpdaterOriginal && class56Patched === class56Original) {
        verifyLinkUpdater(linkUpdaterOriginal, swfPath);
        verifyClass56(class56Original, swfPath);
        console.log(`SWF already contains the guild offline members patch: ${swfPath}`);
        return;
    }

    fs.writeFileSync(linkUpdaterPath, linkUpdaterPatched, 'utf8');
    fs.writeFileSync(class56Path, class56Patched, 'utf8');
    runFfdec(ffdecPath, ['-importScript', swfPath, patchedSwfPath, path.dirname(linkUpdaterPath)]);
    fs.copyFileSync(patchedSwfPath, swfPath);
    console.log(`Patched guild offline members in ${swfPath}`);
}

function verifySwf(repoRoot, ffdecPath, swfPath) {
    const workRoot = path.join(
        repoRoot,
        'build',
        'ffdec-dungeonblitz-guild-offline-members-verify',
        path.basename(swfPath, path.extname(swfPath))
    );
    const { linkUpdaterPath, class56Path } = exportScripts(ffdecPath, workRoot, swfPath);
    verifyLinkUpdater(fs.readFileSync(linkUpdaterPath, 'utf8'), swfPath);
    verifyClass56(fs.readFileSync(class56Path, 'utf8'), swfPath);
    console.log(`Verified guild offline members patch in ${swfPath}`);
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
