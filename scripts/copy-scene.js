#!/usr/bin/env node
import { spawnSync } from 'child_process';
import fs from 'fs';
import madge from 'madge';
import os from 'os';
import path from 'path';

const entryFile = path.resolve('src/lib/sceneSetup.js');
const libDir = path.dirname(entryFile);

async function main() {
    console.log('🔍 Analyzing dependencies from:', entryFile);
    const result = await madge(entryFile, {
        baseDir: libDir
    });
    const deps = result.obj();

    // --- Build tree string for display & embedding ---
    let treeOutput = 'Directory structure (babylon parts only):\n';
    treeOutput += '\n──────────────────────────────────────────────\n';
    const visited = new Set();

    function printTree(file, prefix = '') {
        if (visited.has(file)) return '';
        visited.add(file);

        let out = prefix + file + '\n'; // already relative to libDir from madge
        const sub = deps[file] || [];
        sub.forEach((s, i) => {
            const isLast = i === sub.length - 1;
            const branch = isLast ? '└─ ' : '├─ ';
            out += printTree(s, prefix + branch);
        });
        return out;
    }

    const rootRel = path.relative(libDir, entryFile).replace(/\\/g, '/');
    treeOutput += printTree(rootRel);
    treeOutput += '\n──────────────────────────────────────────────\n';

    console.log('\n' + treeOutput);

    // --- Topological ordering ---
    const ordered = [];
    const topoVisited = new Set();

    function visit(file) {
        if (topoVisited.has(file)) return;
        topoVisited.add(file);
        (deps[file] || []).forEach(visit);
        ordered.push(file);
    }

    visit(rootRel);

    const localFiles = ordered.filter((f) => !f.includes('node_modules')).map((f) => path.resolve(libDir, f));

    console.log('🧠 Files to include (in dependency order):');
    localFiles.forEach((f, i) => console.log(`   ${i + 1}. ${path.relative(libDir, f).replace(/\\/g, '/')}`));
    console.log('\n──────────────────────────────────────────────\n');

    // --- Combine all content with headers ---
    let combined = treeOutput + '\n\n';
    for (const file of localFiles) {
        const relPath = path.relative(libDir, file).replace(/\\/g, '/');
        combined += `\n// ===== ${relPath} =====\n`;
        combined += fs.readFileSync(file, 'utf8') + '\n';
    }

    // --- Write temp UTF-16 file ---
    const tmpFile = path.join(os.tmpdir(), '_clip_utf16.txt');
    fs.writeFileSync(tmpFile, '\uFEFF' + combined, 'utf16le');
    console.log(`🧪 [DEBUG] Temp UTF-16 file: ${tmpFile}`);

    // --- Use PowerShell to copy reliably ---
    const ps = spawnSync('powershell.exe', ['-NoProfile', '-Command', `Get-Content -Raw -Encoding Unicode '${tmpFile}' | Set-Clipboard; Write-Host '✅ Clipboard write succeeded'`], { encoding: 'utf8' });

    console.log('🧪 [DEBUG] PowerShell exit code:', ps.status);
    if (ps.stdout?.length) console.log('🧪 [DEBUG] STDOUT:', ps.stdout.trim());
    if (ps.stderr?.length) console.log('🧪 [DEBUG] STDERR:', ps.stderr.trim());

    if (ps.status === 0) {
        console.log('✅ Successfully copied to clipboard (UTF-16 via temp file).');
    } else {
        console.error('❌ PowerShell failed to set clipboard. See logs above.');
    }

    // --- Cleanup temp file ---
    try {
        fs.unlinkSync(tmpFile);
        console.log('🧹 Deleted temp file.');
    } catch (err) {
        console.warn('⚠️ Could not delete temp file:', err.message);
    }
}

main().catch((err) => {
    console.error('❌ Error:', err);
    process.exit(1);
});
