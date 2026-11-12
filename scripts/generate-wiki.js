'use strict';

/**
 * Generate wiki .md files from structured node/edge data.
 * Each file = one node, with frontmatter + [[wikilinks]] in body.
 */
const fs = require('fs');
const path = require('path');

// Helper: serialize a value to YAML
function toYaml(val, indent) {
  indent = indent || 0;
  const pad = '  '.repeat(indent);
  const pad1 = '  '.repeat(indent + 1);

  if (val === null || val === undefined) return 'null';
  if (typeof val === 'string') {
    // Block scalar for multi-line strings
    if (val.includes('\n')) {
      const contentIndent = '  '.repeat(indent + 1);
      return '|\n' + val.split('\n').map(line => contentIndent + line).join('\n');
    }
    // JSON.stringify for strings with special YAML chars (properly escapes quotes)
    if (/[:\{\}\[\],&\*#\?\|\-<>=!%@`'"]/.test(val) || val === '') {
      return JSON.stringify(val);
    }
    return val;
  }
  if (typeof val === 'number' || typeof val === 'boolean') return String(val);
  if (Array.isArray(val)) {
    if (val.length === 0) return '[]';
    const items = val.map(v => {
      if (typeof v === 'object' && !Array.isArray(v) && v !== null) {
        const keys = Object.keys(v).filter(k => v[k] !== null && v[k] !== undefined && !(Array.isArray(v[k]) && v[k].length === 0));
        if (keys.length === 0) return `${pad}- {}`;
        let str = `${pad}- ${keys[0]}: ${toYaml(v[keys[0]], indent + 1)}`;
        for (let i = 1; i < keys.length; i++) {
          const sv = toYaml(v[keys[i]], indent + 1);
          str += `\n${pad1}${keys[i]}:${sv.startsWith('\n') ? sv : ' ' + sv}`;
        }
        return str;
      }
      return `${pad}- ${toYaml(v, indent + 1).trimStart()}`;
    });
    return '\n' + items.join('\n');
  }
  if (typeof val === 'object') {
    const keys = Object.keys(val);
    if (keys.length === 0) return '{}';
    const items = keys.map(k => {
      const v = val[k];
      if (v === null || v === undefined || (Array.isArray(v) && v.length === 0)) return null;
      const sv = toYaml(v, indent + 1);
      return `${pad1}${k}:${sv.startsWith('\n') ? sv : ' ' + sv}`;
    }).filter(Boolean);
    return '\n' + items.join('\n');
  }
  return String(val);
}

const levelNames = ['核心基础', '主要范式', '具体算法', '技术细节'];

/**
 * Generate wiki .md files from structured node/edge data.
 * @param {Array} nodes - Node objects with id, label, level, parent, definition, etc.
 * @param {Array} edges - Edge objects with s, t
 * @param {string} outputDir - Directory to write .md files into
 * @returns {number} Number of files written
 */
function generateWikiFiles(nodes, edges, outputDir) {
  if (!fs.existsSync(outputDir)) fs.mkdirSync(outputDir, { recursive: true });

  const outgoingEdges = {};
  for (const e of edges) {
    const src = e.source || e.s;
    const tgt = e.target || e.t;
    if (!outgoingEdges[src]) outgoingEdges[src] = new Set();
    outgoingEdges[src].add(tgt);
  }

  let count = 0;
  for (const node of nodes) {
    const id = node.id;
    const links = outgoingEdges[id] || new Set();

    // Build frontmatter
    const fm = {
      title: node.label,
      id: node.id,
      level: node.level,
      color: node.color || undefined,
      type: levelNames[node.level] || undefined,
      parent: node.parent || undefined,
      definition: node.definition || undefined,
      concepts: node.concepts && node.concepts.length ? node.concepts : undefined,
      keyPoints: node.keyPoints && node.keyPoints.length ? node.keyPoints : undefined,
      formulas: node.formulas && node.formulas.length ? node.formulas.map(f => ({
        title: f.title,
        latex: f.latex,
        explanation: f.explanation || undefined,
      })) : undefined,
      problems: node.problems && node.problems.length ? node.problems.map(p => ({
        q: p.q,
        a: p.a,
        type: p.type,
        options: p.options || undefined,
      })) : undefined,
      questions: node.questions && node.questions.length ? node.questions.map(q => ({
        q: q.q,
        a: q.a,
      })) : undefined,
    };

    // Build YAML frontmatter string
    let yaml = '---\n';
    for (const [k, v] of Object.entries(fm)) {
      if (v === undefined || v === null) continue;
      const sv = toYaml(v);
      if (sv === 'null' || sv === 'undefined') continue;
      yaml += `${k}:${sv.startsWith('\n') ? sv : ' ' + sv}\n`;
    }
    yaml += '---\n\n';

    // Body: definition + wikilinks
    if (node.definition) {
      yaml += node.definition + '\n\n';
    }

    // [[wikilinks]] for outgoing edges
    if (links.size > 0) {
      yaml += [...links].map(t => `[[${t}]]`).join(' ') + '\n';
    }

    // Write file
    fs.writeFileSync(path.join(outputDir, `${id}.md`), yaml, 'utf8');
    count++;
  }

  return count;
}

// ── CLI entry point (run directly) ──
if (require.main === module) {
  const { nodes, edges } = require('./data/wiki-data.js');
  const wikiDir = path.join(__dirname, '..', 'wiki');
  const count = generateWikiFiles(nodes, edges, wikiDir);
  console.log(`✅ Generated ${count} wiki pages in ${wikiDir}`);
  console.log(`📝 ${edges.length} edges encoded as [[wikilinks]]`);
}

module.exports = { generateWikiFiles, toYaml };
