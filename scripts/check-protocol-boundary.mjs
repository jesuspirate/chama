import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

export function inspectBoundary(root) {
  const doc = fs.readFileSync(path.join(root, 'docs/protocol-boundary.md'), 'utf8');
  const entries = [...doc.matchAll(/<!-- protocol-core-entry: ([^ ]+) -->/g)].map(m => m[1]);
  if (!entries.length) throw new Error('No core entry markers in docs/protocol-boundary.md');
  const options = { moduleResolution: ts.ModuleResolutionKind.Bundler, allowJs: true, baseUrl: root,
    paths: { '@engine/*': ['src/escrow-engine/*'], '@fedimint/*': ['src/fedimint/*'] } };
  const files = new Set(), findings = new Map(), edges = [];
  // The clock port is the one place the core may read the system clock.
  const allowed = new Set(['Date.now(:src/protocol/core/clock.ts']);
  const add = (rule, file, source, node) => {
    if (allowed.has(`${rule}:${file}`)) return;
    const line = source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1;
    findings.set(`${rule}:${file}:${line}`, { rule, file, line });
  };
  const walk = file => {
    if (files.has(file)) return;
    files.add(file);
    const absolute = path.join(root, file), text = fs.readFileSync(absolute, 'utf8');
    const source = ts.createSourceFile(absolute, text, ts.ScriptTarget.Latest, true);
    const importPath = (specifier, node) => {
      if (/^(react(?:\/|$)|@capacitor\/|@tauri-apps\/)/.test(specifier)) add('platform-import', file, source, node);
      if (/^nostr-tools\/.*(?:relay|pool)/.test(specifier)
        || (specifier === 'nostr-tools' && /\b(?:SimplePool|Relay)\b/.test(node.getText(source)))) add('relay-import', file, source, node);
      const resolved = ts.resolveModuleName(specifier, absolute, options, ts.sys).resolvedModule?.resolvedFileName;
      if (!resolved || resolved.includes('/node_modules/')) return;
      const target = path.relative(root, resolved).split(path.sep).join('/');
      if (!target.startsWith('src/')) return;
      edges.push({ from: file, to: target });
      if (/^src\/(ui|hooks|fedimint|payments)\//.test(target)) add('app-import', file, source, node);
      walk(target);
    };
    const visit = node => {
      if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) importPath(node.moduleSpecifier.text, node);
      if (ts.isCallExpression(node) && (node.expression.kind === ts.SyntaxKind.ImportKeyword || node.expression.getText(source) === 'require') && node.arguments[0] && ts.isStringLiteral(node.arguments[0])) importPath(node.arguments[0].text, node);
      if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument) && ts.isStringLiteral(node.argument.literal)) importPath(node.argument.literal.text, node);
      if (ts.isIdentifier(node) && ['localStorage','sessionStorage','indexedDB','WebSocket'].includes(node.text)) add(node.text, file, source, node);
      if (ts.isPropertyAccessExpression(node) && ['window','document','navigator'].includes(node.expression.getText(source))) add(`${node.expression.getText(source)}.`, file, source, node);
      if (ts.isCallExpression(node)) {
        const expression = node.expression.getText(source);
        if (expression === 'fetch' || /^(?:globalThis|window)\.fetch$/.test(expression)) add('fetch(', file, source, node);
        if (expression === 'Date.now') add('Date.now(', file, source, node);
        if (expression === 'Math.random') add('Math.random(', file, source, node);
      }
      if (ts.isNewExpression(node) && node.expression.getText(source) === 'Date' && !node.arguments?.length) add('new Date()', file, source, node);
      ts.forEachChild(node, visit);
    };
    visit(source);
  };
  entries.forEach(walk);
  return { entries, files: [...files].sort(), edges, findings: [...findings.values()].sort((a,b) => a.rule.localeCompare(b.rule) || a.file.localeCompare(b.file) || a.line-b.line) };
}
export function formatBoundary(report) {
  const rules = ['localStorage','sessionStorage','indexedDB','window.','document.','navigator.','fetch(','WebSocket','Date.now(','new Date()','Math.random(','platform-import','relay-import','app-import'];
  return ['Protocol boundary baseline (report only)', `Entries: ${report.entries.join(', ')}`, `Repository files walked: ${report.files.length}`, 'Counts (distinct rule/file/line; comments and string contents excluded):',
    ...rules.map(rule => `  ${rule}: ${report.findings.filter(f => f.rule === rule).length}`), `Total crossings: ${report.findings.length}`, '', 'Crossings:',
    ...report.findings.map(f => `  ${f.rule} ${f.file}:${f.line}`), '', 'Import closure:', ...report.files.map(f => `  ${f}`), ''].join('\n');
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  // --strict: the gate. Any crossing, or a failed inspection, fails the run.
  // Without it the check stays report-only and always exits zero.
  const strict = args.includes('--strict');
  const root = path.resolve(args.find(arg => !arg.startsWith('--')) ?? '.');
  try {
    const report = inspectBoundary(root);
    if (strict) {
      if (report.findings.length) {
        console.error(`Protocol boundary: ${report.findings.length} crossing(s) into platform code from the core:`);
        for (const f of report.findings) console.error(`  ${f.rule} ${f.file}:${f.line}`);
        process.exitCode = 1;
      } else console.log(`PASS protocol boundary (strict): ${report.files.length} core files, no crossings`);
    } else {
      process.stdout.write(formatBoundary(report));
      process.exitCode = 0;
    }
  } catch (error) {
    if (strict) { console.error(`Protocol boundary inspection error: ${error.message}`); process.exitCode = 1; }
    else { console.log(`Protocol boundary inspection error (report only): ${error.message}`); process.exitCode = 0; }
  }
}
