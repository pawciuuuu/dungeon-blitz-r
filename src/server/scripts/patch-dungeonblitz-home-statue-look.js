const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

/**
 * Renders keep garden statues as grayscale, single-frame sculptures.
 *
 * A statue is a player-shaped entity whose `sleepAnim` (Rogue: "Point", Paladin: "Sharpen",
 * Mage: "Read") would otherwise loop forever through the Seq animator. This patch:
 *
 *   - `Seq.method_980()` (new): pins the Seq to frame 0 of the current clip and sets a "frozen"
 *     flag; `Seq.method_983` (the per-frame tick) early-returns while frozen, so the first frame
 *     of the pose stays up forever instead of advancing and looping.
 *   - `LinkUpdater.method_1615` (0xF entity spawn): when the entity's cue is `StatueName` (the
 *     keep statue cue, see src/server/core/HomeStatues.ts), it calls `method_980()` right after
 *     `BeginSleep()` and applies a luminance ColorMatrixFilter to the statue's display object, so
 *     it reads as a gray stone figure.
 *
 * Both classes are patched at source level (FFDec export -> edit -> reimport), the same way the
 * guild-name and offline-members patches touch LinkUpdater/class_68. Seq round-trips cleanly
 * (FFDec only drops one dead local on recompile), verified by export->import->re-export diff.
 *
 * Usage:
 *   node src/server/scripts/patch-dungeonblitz-home-statue-look.js [--verify] [--swf <path>] [--ffdec <path>]
 */

const GRAYSCALE_MATRIX = '0.299,0.587,0.114,0,0,0.299,0.587,0.114,0,0,0.299,0.587,0.114,0,0,0,0,0,1,0';

function resolveRepoRoot() {
    let candidate = path.resolve(__dirname);
    while (true) {
        if (fs.existsSync(path.join(candidate, 'src', 'server', 'package.json'))) {
            return candidate;
        }
        const parent = path.dirname(candidate);
        if (parent === candidate) {
            break;
        }
        candidate = parent;
    }
    throw new Error('Could not locate repo root.');
}

function parseArgs(argv) {
    const args = { swfs: [], verify: false, ffdec: '' };
    for (let index = 0; index < argv.length; index += 1) {
        const arg = argv[index];
        if (arg === '--verify') {
            args.verify = true;
        } else if (arg === '--swf') {
            args.swfs.push(argv[++index] || '');
        } else if (arg === '--ffdec' || arg === '-f') {
            args.ffdec = argv[++index] || '';
        }
    }
    return args;
}

function detectFfdec(repoRoot, explicit) {
    if (explicit && fs.existsSync(explicit)) {
        return explicit;
    }
    const candidates = [
        path.join(repoRoot, 'build', 'ffdec', 'ffdec.sh'),
        path.join(repoRoot, 'build', 'ffdec', 'ffdec.jar'),
        path.join(repoRoot, 'build', 'ffdec', 'ffdec-cli.jar'),
        '/Applications/FFDec.app/Contents/Resources/ffdec.sh',
        '/Applications/FFDec.app/Contents/Resources/ffdec.jar',
        '/Applications/FFDec.app/Contents/Resources/ffdec-cli.jar'
    ];
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
        execFileSync('java', ['-jar', resolved, '-cli', ...args], { stdio: 'inherit' });
        return;
    }
    execFileSync(resolved, ['-cli', ...args], { stdio: 'inherit' });
}

function exportScripts(ffdecPath, workRoot, swfPath) {
    fs.rmSync(workRoot, { recursive: true, force: true });
    fs.mkdirSync(workRoot, { recursive: true });
    runFfdec(ffdecPath, ['-selectclass', 'LinkUpdater,Seq', '-export', 'script', workRoot, swfPath]);

    const linkUpdaterPath = path.join(workRoot, 'scripts', 'LinkUpdater.as');
    const seqPath = path.join(workRoot, 'scripts', 'Seq.as');
    if (!fs.existsSync(linkUpdaterPath)) {
        throw new Error(`FFDec export did not produce ${linkUpdaterPath}`);
    }
    if (!fs.existsSync(seqPath)) {
        throw new Error(`FFDec export did not produce ${seqPath}`);
    }
    return { linkUpdaterPath, seqPath };
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

    let patched = source;

    // ColorMatrixFilter for the grayscale filter.
    patched = replaceBlock(
        patched,
        [join(['   import flash.filters.GlowFilter;'])],
        join(['   import flash.filters.ColorMatrixFilter;', '   import flash.filters.GlowFilter;']),
        'LinkUpdater ColorMatrixFilter import'
    );

    // method_1615 tail: right after the guild-name block, if the spawned entity is a keep statue
    // (cue "StatueName"), freeze the animation at its first frame and gray it out.
    const tailOriginal = join([
        '            _loc46_.method_436(_loc26_,_loc28_);',
        '         }',
        '         _loc46_.currHP -= _loc47_;'
    ]);
    const tailPatched = join([
        '            _loc46_.method_436(_loc26_,_loc28_);',
        '         }',
        '         if(_loc11_ == "StatueName")',
        '         {',
        '            _loc46_.gfx.m_Seq.method_980();',
        '            _loc46_.gfx.m_TheDO.filters = [new ColorMatrixFilter([' + GRAYSCALE_MATRIX + '])];',
        '         }',
        '         _loc46_.currHP -= _loc47_;'
    ]);

    patched = replaceBlock(patched, [tailOriginal], tailPatched, 'LinkUpdater statue freeze + grayscale block');

    return patched;
}

function verifyLinkUpdater(source, swfPath) {
    if (!source.includes('_loc46_.gfx.m_Seq.method_980();')) {
        throw new Error(`${path.basename(swfPath)} LinkUpdater is missing the statue freeze call.`);
    }
    if (!source.includes('if(_loc11_ == "StatueName")')) {
        throw new Error(`${path.basename(swfPath)} LinkUpdater is missing the StatueName guard.`);
    }
    if (!source.includes('import flash.filters.ColorMatrixFilter;')) {
        throw new Error(`${path.basename(swfPath)} LinkUpdater is missing the ColorMatrixFilter import.`);
    }
    if (source.includes('import flash.filters.GlowFilter;') && !source.includes('import flash.filters.ColorMatrixFilter;\r\n   import flash.filters.GlowFilter;') && !source.includes('import flash.filters.ColorMatrixFilter;\n   import flash.filters.GlowFilter;')) {
        throw new Error(`${path.basename(swfPath)} LinkUpdater has an unpatched import block.`);
    }
}

function patchSeq(source) {
    const eol = source.includes('\r\n') ? '\r\n' : '\n';
    const join = (lines) => lines.join(eol);

    let patched = source;

    // Frozen flag next to the other clip-state fields.
    patched = replaceBlock(
        patched,
        [join(['      internal var var_1026:uint;'])],
        join([
            '      internal var var_1026:uint;',
            '',
            '      internal var var_2377:Boolean = false;'
        ]),
        'Seq frozen flag field'
    );

    // Tick early-return while frozen: the frame pinned by method_980 never advances.
    patched = replaceBlock(
        patched,
        [join([
            '         var _loc21_:int = 0;',
            '         if(this.var_30.var_153 == this.var_463 || this.var_30.var_153 == this.var_218 || this.var_30.var_153 == this.var_348 || this.var_30.var_153 == this.var_384)'
        ])],
        join([
            '         var _loc21_:int = 0;',
            '         if(this.var_2377)',
            '         {',
            '            return false;',
            '         }',
            '         if(this.var_30.var_153 == this.var_463 || this.var_30.var_153 == this.var_218 || this.var_30.var_153 == this.var_348 || this.var_30.var_153 == this.var_384)'
        ]),
        'Seq.method_983 frozen early-return'
    );

    // method_980: pin the pending clip to frame 0 and freeze.
    const method34 = join([
        '      public function method_34(param1:uint, param2:String, param3:Boolean) : void',
        '      {',
        '         var _loc4_:class_26 = this.var_71.var_69[param2];',
        '         if(!_loc4_)',
        '         {',
        '            return;',
        '         }',
        '         this.var_1026 = param1;',
        '         this.var_2378 = _loc4_;',
        '         this.var_735 = param3;',
        '      }'
    ]);
    const method34PlusFreeze = join([
        '      public function method_34(param1:uint, param2:String, param3:Boolean) : void',
        '      {',
        '         var _loc4_:class_26 = this.var_71.var_69[param2];',
        '         if(!_loc4_)',
        '         {',
        '            return;',
        '         }',
        '         this.var_1026 = param1;',
        '         this.var_2378 = _loc4_;',
        '         this.var_735 = param3;',
        '      }',
        '',
        '      /** Pins the current clip to its first frame and stops the tick from advancing it. */',
        '      public function method_980() : void',
        '      {',
        '         var _loc1_:class_26 = this.var_2378 ? this.var_2378 : this.var_30;',
        '         if(!_loc1_)',
        '         {',
        '            return;',
        '         }',
        '         this.var_2377 = true;',
        '         this.var_30 = _loc1_;',
        '         this.var_317 = 0;',
        '         this.var_324 = 0;',
        '         this.var_735 = false;',
        '         this.var_1673 = false;',
        '         this.var_796 = false;',
        '         this.var_314 = _loc1_.var_604[0];',
        '         if(!this.var_314)',
        '         {',
        '            this.var_314 = _loc1_.method_242(0);',
        '         }',
        '      }'
    ]);

    patched = replaceBlock(patched, [method34], method34PlusFreeze, 'Seq.method_980 freeze method');

    return patched;
}

function verifySeq(source, swfPath) {
    if (!source.includes('internal var var_2377:Boolean')) {
        throw new Error(`${path.basename(swfPath)} Seq is missing the frozen flag field.`);
    }
    if (!source.includes('public function method_980()')) {
        throw new Error(`${path.basename(swfPath)} Seq is missing method_980.`);
    }
    if (!source.includes('if(this.var_2377)') || !source.includes('return false;')) {
        throw new Error(`${path.basename(swfPath)} Seq.method_983 is missing the frozen early-return.`);
    }
    if (/if\(this\.var_30\.var_153 == this\.var_463[\s\S]*?this\.var_324 \+= param1;/.test(source) && !source.includes('if(this.var_2377)')) {
        throw new Error(`${path.basename(swfPath)} Seq.method_983 still has an unpatched tick head.`);
    }
}

function patchSwf(repoRoot, ffdecPath, swfPath) {
    const workRoot = path.join(
        repoRoot,
        'build',
        'ffdec-dungeonblitz-home-statue-look',
        path.basename(swfPath, path.extname(swfPath))
    );
    const patchedSwfPath = path.join(workRoot, `${path.basename(swfPath, path.extname(swfPath))}.patched.swf`);
    const { linkUpdaterPath, seqPath } = exportScripts(ffdecPath, workRoot, swfPath);

    const linkUpdaterOriginal = fs.readFileSync(linkUpdaterPath, 'utf8');
    const linkUpdaterPatched = patchLinkUpdater(linkUpdaterOriginal);
    const seqOriginal = fs.readFileSync(seqPath, 'utf8');
    const seqPatched = patchSeq(seqOriginal);

    if (linkUpdaterPatched === linkUpdaterOriginal && seqPatched === seqOriginal) {
        verifyLinkUpdater(linkUpdaterOriginal, swfPath);
        verifySeq(seqOriginal, swfPath);
        console.log(`SWF already contains the home statue look patch: ${swfPath}`);
        return;
    }

    fs.writeFileSync(linkUpdaterPath, linkUpdaterPatched, 'utf8');
    fs.writeFileSync(seqPath, seqPatched, 'utf8');
    runFfdec(ffdecPath, ['-importScript', swfPath, patchedSwfPath, path.dirname(linkUpdaterPath)]);
    fs.copyFileSync(patchedSwfPath, swfPath);
    console.log(`Patched home statue look in ${swfPath}`);
}

function verifySwf(repoRoot, ffdecPath, swfPath) {
    const workRoot = path.join(
        repoRoot,
        'build',
        'ffdec-dungeonblitz-home-statue-look-verify',
        path.basename(swfPath, path.extname(swfPath))
    );
    const { linkUpdaterPath, seqPath } = exportScripts(ffdecPath, workRoot, swfPath);
    verifyLinkUpdater(fs.readFileSync(linkUpdaterPath, 'utf8'), swfPath);
    verifySeq(fs.readFileSync(seqPath, 'utf8'), swfPath);
    console.log(`Verified home statue look patch in ${swfPath}`);
}

function main() {
    const repoRoot = resolveRepoRoot();
    const args = parseArgs(process.argv);
    const ffdecPath = detectFfdec(repoRoot, args.ffdec);
    if (!ffdecPath) {
        throw new Error('FFDec not found. Pass --ffdec or install JPEXS FFDec.');
    }

    const defaultSwf = path.resolve(repoRoot, 'src', 'client', 'content', 'localhost', 'p', 'cbp', 'DungeonBlitz.swf');
    const swfs = (args.swfs.length ? args.swfs : [defaultSwf]).map((entry) => path.resolve(repoRoot, entry));
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

if (require.main === module) {
    try {
        main();
    } catch (error) {
        console.error(`[patch-dungeonblitz-home-statue-look] ${error instanceof Error ? error.message : String(error)}`);
        process.exitCode = 1;
    }
}
