#!/usr/bin/env node
// Fails the build on Bootstrap 4 badge class names (yourphr#486).
//
// WHY THIS EXISTS. Bootstrap 5 removed `.badge-primary` and friends, and `.badge` on its own sets
// `color: var(--bs-badge-color)` — WHITE — with NO background. So a stale `class="badge
// badge-secondary"` renders white text on the page background: invisible in light mode, and fine
// in dark mode, which is exactly how it shipped twice. The visible symptom depends on the theme
// the reviewer happens to be using, so eyes are not a reliable check for this. A grep is.
//
// The replacement is `text-bg-*`, which sets a background AND a foreground Bootstrap computes per
// variant, taking every variant in this theme's palette to WCAG AA.
//
// Not caught by badge.contrast.spec.ts: that renders the shared <fhir-ui-badge> component, while
// these classes are hand-written in page templates and in stateBadgeClass() helpers.
//
// Runs from `make lint-frontend`, so CI enforces it with no workflow change.

import {readdirSync, readFileSync} from 'node:fs';
import {join, relative, resolve} from 'node:path';

const root = resolve(import.meta.dirname, '..');

// Bootstrap 4 contextual badge classes. Every one of these is undefined in Bootstrap 5 except
// where this repo's own SCSS happens to define it — and `.badge-light` IS defined here, with a
// background and no foreground, which makes it one of the broken cases rather than an exception.
const REMOVED = ['primary', 'secondary', 'success', 'danger', 'warning', 'info', 'light', 'dark'];

// `badge-pill` is defined in src/assets/scss/bootstrap/_badge.scss and is purely geometry, so it
// is fine. Anything matching a removed contextual name is not.
const PATTERN = new RegExp(`\\bbadge-(${REMOVED.join('|')})\\b`, 'g');

// Hand-rolled walk rather than fs.globSync: package.json still allows Node 20 for contributors,
// and globSync landed in 22. CI pins 24 (frontend/.nvmrc), so this would have passed there and
// crashed for someone running `make lint-frontend` locally.
function walk(dir) {
  const out = [];
  for (const entry of readdirSync(resolve(root, dir), {withFileTypes: true})) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...walk(path));
    } else if (/\.(html|ts)$/.test(entry.name) && !entry.name.endsWith('.d.ts')) {
      out.push(path);
    }
  }
  return out;
}

const files = walk('src');

const findings = [];
for (const file of files) {
  const text = readFileSync(resolve(root, file), 'utf8');
  text.split('\n').forEach((line, index) => {
    for (const match of line.matchAll(PATTERN)) {
      findings.push({file, line: index + 1, found: match[0], text: line.trim()});
    }
  });
}

if (findings.length > 0) {
  console.error(`\n✖ ${findings.length} Bootstrap 4 badge class${findings.length === 1 ? '' : 'es'} found (yourphr#486).\n`);
  for (const f of findings) {
    console.error(`  ${relative('.', f.file)}:${f.line}  ${f.found}  →  text-bg-${f.found.slice('badge-'.length)}`);
    console.error(`      ${f.text}`);
  }
  console.error(
    '\nBootstrap 5 removed these. `.badge` alone is white text with no background, so these render\n' +
    'invisible in light mode and look correct in dark mode. Replace badge-X with text-bg-X, which\n' +
    'sets both colours and meets WCAG AA for every variant in this palette.\n'
  );
  process.exit(1);
}

console.log(`✔ no Bootstrap 4 badge classes (${files.length} files scanned)`);
