'use strict';
// Shared sanitization patterns for the release audit (used by check-sanitized.cjs).
//
// This file ships with the open-source kit, so it carries ONLY generic
// credential *shapes*. It deliberately contains no company- or project-
// specific word list -- not even in escaped or encoded form, because any
// decodable list would itself disclose the private vocabulary it is meant
// to protect. Keep proprietary terms (company names, internal system names,
// partner names, domain jargon) in a PRIVATE denylist file stored OUTSIDE
// the repository and pass it via:
//
//   node bin/check-sanitized.cjs --extra-banned /secure/path/denylist.txt
//
// One term or regex per line, '#' for comments. See docs/security-baseline.md
// and docs/private-denylist.example.txt for the format.

// Project-specific banned terms are intentionally empty in the shipped kit;
// they come exclusively from --extra-banned (kept outside the repo).
const bannedPatterns = [];

// Generic credential shapes. These match *forms*, not any specific value.
// This is the single source of truth for both the working-tree sanitizer and
// the packed release scanner. Keep fixtures split/constructed so the scanner
// source never embeds a credential-shaped value itself.
const SECRET_PATTERN_SOURCES = [
  { name: 'private-key', re: '-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----', flags: 'g' },
  { name: 'provider-key', re: '\\b(?:sk|rk)[_-](?:live|prod)[_-][A-Za-z0-9_-]{16,}\\b', flags: 'g' },
  {
    name: 'provider-token',
    re: '\\b(?:sk-(?:ant-api\\d{2}-|proj-|svcacct-)?[A-Za-z0-9_-]{20,}|xox[baprs]-[A-Za-z0-9-]{20,}|AIza[A-Za-z0-9_-]{30,})\\b',
    flags: 'g'
  },
  { name: 'github-token', re: '\\b(?:gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{50,})\\b', flags: 'g' },
  { name: 'aws-access-key-id', re: '\\b(?:AKIA|ASIA)[A-Z0-9]{16}\\b', flags: 'g' },
  { name: 'jwt', re: '\\beyJ[A-Za-z0-9_-]{12,}\\.[A-Za-z0-9_-]{12,}\\.[A-Za-z0-9_-]{12,}\\b', flags: 'g' },
  {
    name: 'credential-assignment',
    re: '\\b(?:api[_-]?key|secret|password|token)\\s*[:=]\\s*[\'"]([^\'"\\s]{12,})[\'"]',
    flags: 'gi',
    valueGroup: 1
  },
  {
    name: 'credential-assignment-unquoted',
    re: '^[ \\t]*(?:export[ \\t]+)?[A-Z0-9_]*(?:API_?KEY|TOKEN|PASSWORD|SECRET|PRIVATE_?KEY|ACCESS_?KEY)[A-Z0-9_]*[ \\t]*=[ \\t]*([A-Za-z0-9_./+=:@-]{12,})[ \\t]*(?:#.*)?$',
    flags: 'gi',
    valueGroup: 1
  }
];

const secretPatterns = SECRET_PATTERN_SOURCES.map((p) => ({
  name: p.name,
  regex: new RegExp(p.re, p.flags),
  valueGroup: p.valueGroup
}));

// Values that look like credentials but are clearly placeholders / indirections.
const PLACEHOLDER_VALUE = new RegExp(
  [
    '^\\$\\{[^}]*\\}$', // ${ENV_VAR}
    '^process\\.env', // process.env.X
    '^env\\(', // env(X)
    '^<[^>]+>$', // <YOUR-KEY-HERE>
    '^\\{\\{[^}]*\\}\\}$', // {{ template }}
    '^(x{4,}|\\*{4,}|\\.{4,}|_{4,}|-{4,})$', // masked filler
    '(placeholder|example|synthetic|sample|smoke|fixture|test|redacted|dummy|changeme|change-me|your[-_])',
    '^(todo|tbd|fixme)\\b'
  ].join('|'),
  'i'
);

function isPlaceholderValue(value) {
  return PLACEHOLDER_VALUE.test(String(value).trim());
}

/** Mask a matched snippet: keep first/last 3 chars, hide the middle. */
function maskValue(value) {
  const v = String(value);
  if (v.length <= 8) return `${v.slice(0, 1)}***`;
  return `${v.slice(0, 3)}***${v.slice(-3)}`;
}

/**
 * Compile extra denylist lines (one term or regex per line, '#' comments).
 * Invalid regex lines fall back to escaped literal matching.
 */
function compileExtraPatterns(lines) {
  const out = [];
  (lines || []).forEach((rawLine, idx) => {
    const line = String(rawLine).trim();
    if (!line || line.startsWith('#')) return;
    let regex;
    try {
      regex = new RegExp(line, 'gi');
    } catch (err) {
      regex = new RegExp(line.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi');
    }
    out.push({ name: `extra-${idx + 1}`, regex });
  });
  return out;
}

/**
 * Scan a text blob with banned + secret (+ extra) patterns.
 * Returns hits: [{ line, name, masked }]. Never echoes the full match.
 */
function scanText(text, extraPatterns) {
  const hits = [];
  const patterns = bannedPatterns.concat(secretPatterns, extraPatterns || []);
  const lines = String(text).split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const lineText = lines[i];
    for (const pattern of patterns) {
      pattern.regex.lastIndex = 0;
      let match;
      while ((match = pattern.regex.exec(lineText)) !== null) {
        const value = pattern.valueGroup ? match[pattern.valueGroup] : match[0];
        if (pattern.valueGroup && isPlaceholderValue(value)) {
          if (match[0] === '') pattern.regex.lastIndex++;
          continue;
        }
        hits.push({ line: i + 1, name: pattern.name, masked: maskValue(value) });
        if (match[0] === '') pattern.regex.lastIndex++; // avoid infinite loop
      }
    }
  }
  return hits;
}

module.exports = {
  bannedPatterns,
  secretPatterns,
  scanText,
  maskValue,
  compileExtraPatterns,
  isPlaceholderValue
};
