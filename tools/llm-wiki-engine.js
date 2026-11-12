/**
 * LLM Wiki Tool - 核心引擎
 * 支持项目扫描、Wiki化、图谱构建、混合检索
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// 配置 - 三层架构(Karpathy模式) + Obsidian-Wiki标准对齐
const CONFIG = {
  // Layer 1: Raw Sources (Immutable) - 原始文档,LLM只读不写,不可变
  // 按来源类型分目录 (对齐 obsidian-wiki raw/ 结构)
  sourcesRoot: path.join(__dirname, '../sources'),
  sourceTypes: ['articles', 'papers', 'transcripts', 'assets', 'general'],

  // Layer 2: Wiki (LLM-owned) - LLM维护的知识库,完全由LLM掌控
  // 按内容类型分目录 (对齐 obsidian-wiki wiki/ 结构)
  wikiRoot: path.join(__dirname, '../wiki'),
  wikiSubDirs: ['concepts', 'entities', 'sources', 'syntheses'],

  // Layer 3: Schema (Rules) - 规则文件,定义Wiki结构和维护流程
  schemaRoot: path.join(__dirname, '../schema'),

  // 旧配置保持兼容(但废弃)
  rawRoot: path.join(__dirname, '../wiki-raw'),

  indexPath: path.join(__dirname, '../wiki-index.json'),
  graphPath: path.join(__dirname, '../wiki-graph.json'),
  manifestPath: '.manifest.json', // Delta tracking manifest file (per-project)
  supportedExtensions: ['.md', '.txt', '.js', '.ts', '.py', '.json', '.yaml', '.yml', '.doc', '.docx', '.pdf', '.xls', '.xlsx', '.ppt', '.pptx', '.rst', '.go', '.java', '.toml'],
  excludeDirs: ['node_modules', '.git', 'dist', 'build', '__pycache__', '.next', 'coverage'],
  maxFileSize: 1024 * 1024 * 10, // 10MB(支持更大的文档)

  // 三层架构开关
  useThreeLayerArchitecture: true,

  // Provenance 溯源追踪
  provenanceTags: {
    extracted: '^[extracted]',
    inferred: '^[inferred]',
    ambiguous: '^[ambiguous]',
  },

  // 知识健康阈值
  healthThresholds: {
    minProvenanceExtracted: 0.4,
    maxProvenanceAmbiguous: 0.3,
    maxStaleDays: 30,
    minCrossRefDensity: 3,
  },
};

// 库级构建要求：与 ontomind-agent 端同构，统一从库目录 _meta/build-requirements.md 读取
function readBuildRequirements(wikiDir) {
  if (!wikiDir) return '';
  try {
    const file = path.join(wikiDir, '_meta', 'build-requirements.md');
    if (fs.existsSync(file)) {
      return fs.readFileSync(file, 'utf-8').replace(/\r\n/g, '\n').trim();
    }
  } catch (e) { /* 读取失败按未配置处理 */ }
  return '';
}

function appendBuildRequirements(prompt, requirements) {
  const req = String(requirements || '').trim();
  if (!req) return prompt;
  return prompt + '\n\n# 本库构建要求（用户自定义，优先级高于上述通用规则，必须严格遵循）\n' + req + '\n';
}

// 确保目录存在 - 三层架构模式(对齐 obsidian-wiki 标准)
function ensureDirs() {
  if (CONFIG.useThreeLayerArchitecture) {
    // 创建三层架构根目录
    [CONFIG.sourcesRoot, CONFIG.wikiRoot, CONFIG.schemaRoot].forEach(function(dir) {
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    });

    // Layer 1: 创建 sources/ 子目录 (按来源类型分类)
    CONFIG.sourceTypes.forEach(function(t) {
      var sub = path.join(CONFIG.sourcesRoot, t);
      if (!fs.existsSync(sub)) fs.mkdirSync(sub, { recursive: true });
    });

    // Layer 2: 创建 wiki/ 子目录 (按内容类型分类)
    CONFIG.wikiSubDirs.forEach(function(sub) {
      var subPath = path.join(CONFIG.wikiRoot, sub);
      if (!fs.existsSync(subPath)) fs.mkdirSync(subPath, { recursive: true });
    });

    // 创建Schema文件(如果不存在) — 对齐 obsidian-wiki .config/schema.md
    var schemaFile = path.join(CONFIG.schemaRoot, 'CLAUDE.md');
    if (!fs.existsSync(schemaFile)) {
      var defaultSchema =
`# LLM Wiki Schema — 对齐 obsidian-wiki 标准

## 三层架构

### Layer 1: sources/ (原始资料 · LLM 只读)
按照来源类型分目录，复制后不可修改:
- sources/articles/     — 网页剪藏、文章、博客
- sources/papers/       — 学术论文、技术文档、白皮书
- sources/transcripts/  — 播客转录、视频字幕、会议记录
- sources/assets/       — 图片、附件、非文本资料
- sources/general/      — 无法归类的文档

### Layer 2: wiki/ (结构化知识 · LLM 维护)
按内容类型分目录，\`[[wikilinks]]\` 跨目录互链:
- wiki/sources/       — 来源摘要页 (每篇原始文档的核心提炼)
- wiki/entities/      — 实体页 (人/组织/工具/产品)
- wiki/concepts/      — 概念页 (理论/模式/方法论)
- wiki/syntheses/     — 综合分析页 (多源整合、跨领域分析)
- wiki/comparisons/   — 对比分析页 (方案对比、技术选型)
- wiki/index.md       — 知识库索引 (汇总所有页面及摘要)
- wiki/log.md         — 操作日志 (append-only,记录所有操作)
- wiki/hot.md         — 最近活动快照 (活跃页面、最新更新)
- wiki/.manifest.json — Delta 追踪清单 (SHA-256 + 更新时间)

### Layer 3: schema/ (规则层 · 定义结构)
- schema/CLAUDE.md — 本文件 (核心规则)

## 页面格式标准 (YAML Frontmatter)
\`\`\`yaml
---
title: Page Title
type: source | entity | concept | synthesis | comparison
sources: [list of source files]
related: [[wikilinks]]
tags: [category tags]
created: YYYY-MM-DD
updated: YYYY-MM-DD
provenance:
  extracted: 60%
  inferred: 30%
  ambiguous: 10%
base_confidence: 0.0-1.0
lifecycle: draft | stable | archived
---
\`\`\`

## Provenance 溯源标记 (声明级)
- 直接提取的事实: 末尾加 ^[extracted]
- LLM推理/合成的结论: 末尾加 ^[inferred]
- 来源矛盾/不明确的信息: 末尾加 ^[ambiguous]

## 核心操作
- Ingest: sources/ → wiki/sources/ (编译新文档, Delta 增量)
- CrossLink: 自动发现未链接提及,织网[[wikilinks]]
- Synthesize: 多源整合 → wiki/syntheses/
- Query: wiki/ → answer → archive (知识复利)
- Lint: wiki/ health check (孤儿页/矛盾/溯源漂移/过期)

## 质量指标
- 实体完整度: >90% · 链接有效性: 100%
- 交叉引用密度: ≥3-5个 · Provenance 最低提取率: ≥40%
`;
      fs.writeFileSync(schemaFile, defaultSchema, 'utf-8');
    }
  } else {
    // 旧模式(兼容)
    [CONFIG.wikiRoot, CONFIG.rawRoot].forEach(function(dir) {
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    });
  }
}

/**
 * 项目扫描器
 */
class ProjectScanner {
  constructor(rootPath) {
    this.rootPath = rootPath;
    this.results = [];
  }

  /**
   * 扫描目录，返回项目结构
   */
  scan(dirPath = this.rootPath, depth = 0, maxDepth = 3) {
    if (depth > maxDepth) return [];

    const items = [];
    try {
      const entries = fs.readdirSync(dirPath, { withFileTypes: true });

      for (const entry of entries) {
        const fullPath = path.join(dirPath, entry.name);
        const relativePath = path.relative(this.rootPath, fullPath);

        if (entry.isDirectory()) {
          // 跳过排除目录
          if (CONFIG.excludeDirs.includes(entry.name)) continue;

          const children = this.scan(fullPath, depth + 1, maxDepth);
          const docCount = this.countDocuments(fullPath);
          const codeCount = this.countCodeFiles(fullPath);

          items.push({
            name: entry.name,
            path: relativePath,
            fullPath,
            type: 'directory',
            children: children.slice(0, 50), // 限制子项数量
            docCount,
            codeCount,
            totalFiles: docCount + codeCount,
            hasPackageJson: fs.existsSync(path.join(fullPath, 'package.json')),
            hasReadme: fs.existsSync(path.join(fullPath, 'README.md')),
            hasClaudeMd: fs.existsSync(path.join(fullPath, 'CLAUDE.md')),
          });
        } else if (entry.isFile()) {
          const ext = path.extname(entry.name).toLowerCase();
          if (CONFIG.supportedExtensions.includes(ext)) {
            const stat = fs.statSync(fullPath);
            if (stat.size <= CONFIG.maxFileSize) {
              items.push({
                name: entry.name,
                path: relativePath,
                fullPath,
                type: 'file',
                ext,
                size: stat.size,
                sizeFormatted: this.formatSize(stat.size),
              });
            }
          }
        }
      }
    } catch (e) {
      console.error(`扫描目录失败: ${dirPath}`, e.message);
    }

    return items.sort((a, b) => {
      // 目录优先，然后按文件数排序
      if (a.type !== b.type) return a.type === 'directory' ? -1 : 1;
      return (b.totalFiles || 0) - (a.totalFiles || 0);
    });
  }

  /**
   * 统计文档数量
   */
  countDocuments(dirPath) {
    let count = 0;
    try {
      const entries = fs.readdirSync(dirPath, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.isFile() && ['.md', '.txt', '.rst'].includes(path.extname(entry.name).toLowerCase())) {
          count++;
        }
      }
    } catch (e) {}
    return count;
  }

  /**
   * 统计代码文件数量
   */
  countCodeFiles(dirPath) {
    let count = 0;
    try {
      const entries = fs.readdirSync(dirPath, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.isFile() && ['.js', '.ts', '.py', '.go', '.java', '.cpp', '.c'].includes(path.extname(entry.name).toLowerCase())) {
          count++;
        }
      }
    } catch (e) {}
    return count;
  }

  /**
   * 格式化文件大小
   */
  formatSize(bytes) {
    if (bytes < 1024) return bytes + ' B';
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
    return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
  }

  /**
   * 获取项目摘要
   */
  getProjectSummary(projectPath) {
    const summary = {
      name: path.basename(projectPath),
      path: projectPath,
      documents: [],
      codeFiles: [],
      configs: [],
      hasWiki: false,
      wikiPages: 0,
    };

    try {
      // 检查是否有现有wiki
      const wikiPath = path.join(CONFIG.wikiRoot, this.slugify(path.basename(projectPath)));
      if (fs.existsSync(wikiPath)) {
        summary.hasWiki = true;
        summary.wikiPages = fs.readdirSync(wikiPath).filter(f => f.endsWith('.md')).length;
      }

      // 扫描文件
      const scanDir = (dir) => {
        const entries = fs.readdirSync(dir, { withFileTypes: true });
        for (const entry of entries) {
          if (CONFIG.excludeDirs.includes(entry.name)) continue;

          const fullPath = path.join(dir, entry.name);
          if (entry.isDirectory()) {
            scanDir(fullPath);
          } else if (entry.isFile()) {
            const ext = path.extname(entry.name).toLowerCase();
            const relativePath = path.relative(projectPath, fullPath);

            if (['.md', '.txt', '.rst'].includes(ext)) {
              summary.documents.push({ name: entry.name, path: relativePath, fullPath });
            } else if (['.js', '.ts', '.py', '.go', '.java'].includes(ext)) {
              summary.codeFiles.push({ name: entry.name, path: relativePath, fullPath });
            } else if (['.json', '.yaml', '.yml', '.toml'].includes(ext)) {
              summary.configs.push({ name: entry.name, path: relativePath, fullPath });
            }
          }
        }
      };

      scanDir(projectPath);
    } catch (e) {
      console.error('获取项目摘要失败:', e);
    }

    return summary;
  }

  /**
   * 路径转slug
   */
  slugify(text) {
    return text
      .toLowerCase()
      .replace(/[^a-z0-9\u4e00-\u9fa5]+/g, '-')
      .replace(/^-|-$/g, '');
  }
}
class WikiEngine {
  constructor(options = {}) {
    this.llmEndpoint = options.llmEndpoint || process.env.LLM_ENDPOINT || 'https://api.anthropic.com/v1/messages';
    this.llmApiKey = options.llmApiKey || process.env.ANTHROPIC_API_KEY;
    this.llmModel = options.llmModel || 'claude-sonnet-4-20250514';
    this.chatRoute = options.chatRoute || null;
    this.chatApiKey = options.chatApiKey || null;
    this.chatModel = options.chatModel || null;
  }

  /**
   * 计算文件的SHA-256哈希 (Delta tracking)
   */
  computeFileHash(filePath) {
    const content = fs.readFileSync(filePath);
    return crypto.createHash('sha256').update(content).digest('hex');
  }

  /**
   * 读取项目的 .manifest.json (Delta tracking)
   */
  readManifest(wikiDir) {
    const manifestPath = path.join(wikiDir, CONFIG.manifestPath);
    if (!fs.existsSync(manifestPath)) return { files: {}, lastFullScan: null, version: 1 };
    try {
      return JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));
    } catch (e) {
      return { files: {}, lastFullScan: null, version: 1 };
    }
  }

  /**
   * 更新项目的 .manifest.json (Delta tracking)
   */
  updateManifest(wikiDir, sourceFileName, sourceFilePath, wikiOutputs) {
    const manifestPath = path.join(wikiDir, CONFIG.manifestPath);
    const manifest = this.readManifest(wikiDir);
    const hash = this.computeFileHash(sourceFilePath);
    const stat = fs.statSync(sourceFilePath);

    manifest.files[sourceFileName] = {
      hash,
      size: stat.size,
      mtime: stat.mtime.toISOString(),
      lastProcessed: new Date().toISOString(),
      outputs: wikiOutputs || [],
    };
    manifest.lastFullScan = manifest.lastFullScan || new Date().toISOString();
    manifest.version = (manifest.version || 1) + 0.1;

    fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), 'utf-8');
    return manifest;
  }

  /**
   * 检测文件是否需要重新处理 (Delta tracking)
   * @returns {{ needsUpdate: boolean, reason: string }}
   */
  checkDelta(sourceFileName, sourceFilePath, wikiDir) {
    if (!fs.existsSync(sourceFilePath)) {
      return { needsUpdate: true, reason: 'source_file_missing' };
    }
    const manifest = this.readManifest(wikiDir);
    const entry = manifest.files[sourceFileName];
    if (!entry) return { needsUpdate: true, reason: 'new_file' };

    const currentHash = this.computeFileHash(sourceFilePath);
    if (currentHash !== entry.hash) return { needsUpdate: true, reason: 'content_changed' };

    const currentSize = fs.statSync(sourceFilePath).size;
    if (currentSize !== entry.size) return { needsUpdate: true, reason: 'size_changed' };

    return { needsUpdate: false, reason: 'unchanged', hash: currentHash };
  }

  /**
   * 提取页面的Provenance统计数据
   */
  extractProvenance(pageContent) {
    const extracted = (pageContent.match(/\^\[extracted\]/g) || []).length;
    const inferred = (pageContent.match(/\^\[inferred\]/g) || []).length;
    const ambiguous = (pageContent.match(/\^\[ambiguous\]/g) || []).length;
    const total = extracted + inferred + ambiguous || 1;
    return {
      extracted: Math.round((extracted / total) * 100),
      inferred: Math.round((inferred / total) * 100),
      ambiguous: Math.round((ambiguous / total) * 100),
      totalClaims: total,
    };
  }

  /**
   * 更新页面的frontmatter provenance字段
   */
  injectProvenanceFrontmatter(pageContent) {
    const provenance = this.extractProvenance(pageContent);
    const baseConfidence = Math.min(1.0, Math.max(0, provenance.extracted / 100));

    // 如果已有provenance字段，替换；否则在updated后插入
    if (/^provenance:/m.test(pageContent)) {
      pageContent = pageContent.replace(
        /provenance:\n\s+extracted:.*\n\s+inferred:.*\n\s+ambiguous:.*/g,
        `provenance:\n  extracted: ${provenance.extracted}%\n  inferred: ${provenance.inferred}%\n  ambiguous: ${provenance.ambiguous}%`
      );
    } else {
      pageContent = pageContent.replace(
        /(updated:.*\n)/,
        `$1provenance:\n  extracted: ${provenance.extracted}%\n  inferred: ${provenance.inferred}%\n  ambiguous: ${provenance.ambiguous}%\nbase_confidence: ${baseConfidence.toFixed(2)}\n`
      );
    }
    return pageContent;
  }

  /**
   * 将文件/目录转换为Wiki页面 - 完整6步流程(Karpathy模式 + Delta + Provenance)
   * Step 1: Read Source(读取源文档)
   * Step 2: Generate Summary(生成摘要页)
   * Step 3: Update Entity Pages(更新实体页)
   * Step 4: Add Cross-References(添加交叉引用,≥3-5个)
   * Step 5: Flag Contradictions(标记矛盾)
   * Step 6: Append Log(追加操作日志)
   */
  async ingest(sourcePath, options = {}) {
    const {
      projectName = path.basename(sourcePath),
      recursive = true,
      fileFilter = null,
      onProgress = () => {},
    } = options;

    ensureDirs();

    const projectSlug = this.slugify(projectName);

    // 三层架构路径
    let sourcesDir, wikiDir;
    if (CONFIG.useThreeLayerArchitecture) {
      sourcesDir = path.join(CONFIG.sourcesRoot, projectSlug); // Layer 1: 不可变原始文档
      wikiDir = path.join(CONFIG.wikiRoot, projectSlug); // Layer 2: LLM编译的知识库
    } else {
      // 旧模式(兼容)
      wikiDir = path.join(CONFIG.wikiRoot, projectSlug);
      sourcesDir = path.join(CONFIG.rawRoot, projectSlug);
    }

    // 创建目录
    [wikiDir, sourcesDir].forEach(dir => {
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
    });

    // 创建wiki子目录(对齐 obsidian-wiki: sources/ entities/ concepts/ syntheses/ comparisons/)
    CONFIG.wikiSubDirs.forEach(function(subDir) {
      var subPath = path.join(wikiDir, subDir);
      if (!fs.existsSync(subPath)) fs.mkdirSync(subPath, { recursive: true });
    });

    // 库级构建要求：显式传入优先，否则读库目录 _meta/build-requirements.md 镜像（读取一次，全流程共用）
    // 库 ID 可能含下划线/大写而 slug 后目录名不同，因此按原始 ID 与 slug 两个路径查找
    const buildRequirements = String(options.buildRequirements || '').trim()
      || readBuildRequirements(path.join(CONFIG.wikiRoot, projectName))
      || readBuildRequirements(wikiDir);

    // 收集要处理的文件
    const files = this.collectFiles(sourcePath, { recursive, fileFilter });
    const results = {
      project: projectName,
      slug: projectSlug,
      totalFiles: files.length,
      processed: 0,
      failed: 0,
      pages: [],
      entities: [],
      contradictions: [],
      crossReferences: [],
      errors: [],
      steps: [], // 记录每一步的详细进度
    };

    onProgress({ stage: 'start', total: files.length, message: '🔄 开始Wiki化...' });

    for (let i = 0; i < files.length; i++) {
      const file = files[i];

      try {
        // ===== Step 1: Read Source + Delta Check =====
        onProgress({
          stage: 'step',
          step: 1,
          file: file.path,
          index: i,
          total: files.length,
          message: '✅ Step 1: Delta Check + Read Source'
        });

        // 🔴 Delta tracking: 检查文件是否已处理且未变更
        const sourceFileName = file.path.replace(/[\/\\]/g, '_');
        const sourceFilePath = path.join(sourcesDir, sourceFileName);
        const delta = this.checkDelta(sourceFileName, file.fullPath, wikiDir);

        if (!delta.needsUpdate) {
          onProgress({
            stage: 'skip',
            file: file.path,
            index: i,
            total: files.length,
            message: '⏭️ 跳过(未变更): ' + delta.reason + ' (hash: ' + delta.hash.slice(0,8) + '...)'
          });
          results.steps.push({
            step: 1, file: file.path, action: 'delta_skip',
            reason: delta.reason, hash: delta.hash
          });
          continue; // ⏭️ 跳过此文件
        }

        const content = fs.readFileSync(file.fullPath, 'utf-8');

        // ⭐ 关键:复制到sources目录(不可变存储),LLM不能修改
        fs.writeFileSync(sourceFilePath, content);

        results.steps.push({
          step: 1,
          file: file.path,
          action: delta.reason === 'new_file' ? 'new_ingest' : 're_ingest',
          reason: delta.reason,
          size: content.length,
          sourcePath: sourceFileName
        });

        // ===== Step 2: Generate Summary + Provenance =====
        onProgress({
          stage: 'step',
          step: 2,
          file: file.path,
          index: i,
          total: files.length,
          message: '✅ Step 2: Generate Summary + Provenance'
        });

        let summaryPage = await this.compileToWiki(content, {
          sourcePath: sourceFileName,
          projectName,
          type: 'source',
          buildRequirements,
        });

        // 🔴 注入Provenance统计到frontmatter
        summaryPage = this.injectProvenanceFrontmatter(summaryPage);

        const summaryFileName = this.getWikiFileName(file);
        const summaryFilePath = path.join(wikiDir, 'sources', summaryFileName);
        fs.writeFileSync(summaryFilePath, summaryPage);

        results.pages.push({
          source: sourceFileName,
          wiki: 'sources/' + summaryFileName,
          size: content.length,
          type: 'source',
          provenance: this.extractProvenance(summaryPage),
        });

        results.steps.push({
          step: 2,
          file: file.path,
          action: 'generate_summary',
          wikiPath: 'sources/' + summaryFileName
        });

        // ===== Step 3: Update Entity Pages(更新实体页) =====
        onProgress({
          stage: 'step',
          step: 3,
          file: file.path,
          index: i,
          total: files.length,
          message: '✅ Step 3: Update Entity Pages(更新实体页)'
        });

        const entities = this.extractEntities(summaryPage);
        for (const entity of entities) {
          await this.updateEntityPage(entity, wikiDir, sourceFileName, projectName);
          results.entities.push(entity);
        }

        results.steps.push({
          step: 3,
          file: file.path,
          action: 'update_entities',
          entities: entities.length
        });

        // ===== Step 4: Add Cross-References(添加交叉引用) =====
        onProgress({
          stage: 'step',
          step: 4,
          file: file.path,
          index: i,
          total: files.length,
          message: '✅ Step 4: Add Cross-References(添加交叉引用,强制≥3-5个)'
        });

        const crossRefs = await this.addCrossReferences(summaryPage, wikiDir, file.path);
        results.crossReferences.push(...crossRefs);

        results.steps.push({
          step: 4,
          file: file.path,
          action: 'add_cross_references',
          crossRefsCount: crossRefs.length
        });

        // ===== Step 5: Flag Contradictions(标记矛盾) =====
        onProgress({
          stage: 'step',
          step: 5,
          file: file.path,
          index: i,
          total: files.length,
          message: '✅ Step 5: Flag Contradictions(标记矛盾)'
        });

        const contradictions = await this.flagContradictions(summaryPage, wikiDir, sourceFileName);
        results.contradictions.push(...contradictions);

        results.steps.push({
          step: 5,
          file: file.path,
          action: 'flag_contradictions',
          contradictionsCount: contradictions.length
        });

        // 🔴 更新Delta Manifest (SHA-256 + 输出文件列表)
        this.updateManifest(wikiDir, sourceFileName, file.fullPath, [
          'sources/' + summaryFileName,
          ...results.entities.map(function(e) { return 'entities/' + e.slug + '.md'; }),
        ]);

        results.processed++;

      } catch (e) {
        results.failed++;
        results.errors.push({ file: file.path, error: e.message });
      }

      onProgress({
        stage: 'progress',
        processed: results.processed,
        failed: results.failed,
        total: files.length
      });
    }

    // ===== Step 6: Append Log + Update Manifest Timestamp =====
    onProgress({
      stage: 'step',
      step: 6,
      message: '✅ Step 6: Append Log + Manifest'
    });

    await this.appendLog(wikiDir, results);

    // 🔴 更新Manifest的lastFullScan时间戳
    var manifest = this.readManifest(wikiDir);
    manifest.lastFullScan = new Date().toISOString();
    var manifestPath = path.join(wikiDir, CONFIG.manifestPath);
    fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), 'utf-8');

    // 生成索引 + purpose + overview
    await this.generateIndex(wikiDir, results);
    await this.generatePurpose(wikiDir, results);
    await this.generateOverview(wikiDir, results);

    results.steps.push({
      step: 6,
      action: 'append_log_and_meta',
      logPath: 'log.md',
      purposePath: 'purpose.md',
      overviewPath: 'overview.md'
    });

    onProgress({ stage: 'complete', results });
    return results;
  }

  /**
   * 收集文件
   */
  collectFiles(sourcePath, options) {
    const files = [];
    const { recursive, fileFilter } = options;

    const scan = (dir) => {
      const entries = fs.readdirSync(dir, { withFileTypes: true });
      for (const entry of entries) {
        if (CONFIG.excludeDirs.includes(entry.name)) continue;

        const fullPath = path.join(dir, entry.name);
        if (entry.isDirectory() && recursive) {
          scan(fullPath);
        } else if (entry.isFile()) {
          const ext = path.extname(entry.name).toLowerCase();
          if (CONFIG.supportedExtensions.includes(ext)) {
            const stat = fs.statSync(fullPath);
            if (stat.size <= CONFIG.maxFileSize) {
              const fileInfo = {
                name: entry.name,
                path: path.relative(sourcePath, fullPath),
                fullPath,
                ext,
                size: stat.size,
              };
              if (!fileFilter || fileFilter(fileInfo)) {
                files.push(fileInfo);
              }
            }
          }
        }
      }
    };

    if (fs.statSync(sourcePath).isDirectory()) {
      scan(sourcePath);
    } else {
      files.push({
        name: path.basename(sourcePath),
        path: path.basename(sourcePath),
        fullPath: sourcePath,
        ext: path.extname(sourcePath),
        size: fs.statSync(sourcePath).size,
      });
    }

    return files;
  }

  /**
   * 使用LLM编译为Wiki
   */
  async compileToWiki(content, context) {
    const prompt = this.buildIngestPrompt(content, context);
    if (this.chatRoute && this.chatApiKey && this.chatModel) {
      try {
        const response = await fetch(`https://${this.chatRoute.host}${this.chatRoute.path}`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${this.chatApiKey}`,
          },
          body: JSON.stringify({
            model: this.chatRoute.model || this.chatModel,
            messages: [{ role: 'user', content: prompt }],
            max_tokens: 4096,
            temperature: 0.3,
          }),
        });
        const data = await response.json();
        return data.choices?.[0]?.message?.content || this.generateBasicWiki(content, context);
      } catch (e) {
        console.error('AI Harbor LLM编译失败:', e);
        return this.generateBasicWiki(content, context);
      }
    }

    // 如果没有API密钥，使用本地模式（生成基础wiki）
    if (!this.llmApiKey) {
      return this.generateBasicWiki(content, context);
    }

    try {
      const response = await fetch(this.llmEndpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': this.llmApiKey,
          'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify({
          model: this.llmModel,
          max_tokens: 4096,
          messages: [{
            role: 'user',
            content: prompt,
          }],
        }),
      });

      const data = await response.json();
      return data.content?.[0]?.text || this.generateBasicWiki(content, context);
    } catch (e) {
      console.error('LLM编译失败:', e);
      return this.generateBasicWiki(content, context);
    }
  }

  /**
   * 构建Ingest提示(优化版 - 符合Karpathy最佳实践)
   */
  buildIngestPrompt(content, context) {
    const timestamp = new Date().toISOString().split('T')[0];

    const prompt = `You are a knowledge-base curator. Your job is to compile this source material into a structured Wiki page that becomes part of a persistent, interlinked knowledge base.

## Source Material
File: ${context.sourcePath}
Project: ${context.projectName}

Content Preview (first 8000 chars):
\`\`\`
${content.slice(0, 8000)}
\`\`\`

## Your Task (Karpathy LLM Wiki Pattern + Provenance)
1. **Extract Core Knowledge**: Identify the most important concepts, definitions, formulas, and insights
2. **Create Entity Pages**: If you see important entities (people, tools, concepts), create dedicated sections for them
3. **Add Cross-References**: Use [[wikilinks]] aggressively - link to related concepts you know exist or should exist
4. **Flag Contradictions**: If this contradicts existing knowledge, note it explicitly
5. **Structure for Retrieval**: Organize content so it's easy to search and navigate

## 🔴 Provenance Tracking (CRITICAL - tag EVERY claim)
Tag the end of every factual claim/sentence with ONE of:
- ^[extracted] — facts directly verifiable from the source (verbatim or near-verbatim)
- ^[inferred] — logical conclusions, patterns, or synthesis NOT explicitly stated
- ^[ambiguous] — claims where sources disagree / information is unclear / speculative

Example:
"Acme uses Postgres for primary storage^[extracted]. This suggests a preference for relational DBs^[inferred]."

## Critical Requirements
- Use [[double bracket wikilinks]] for every important concept mentioned
- Add a "See Also" section with at least 3-5 cross-references
- Include "Sources" section citing the original file
- Add "Contradictions" section if this conflicts with other knowledge
- Keep it concise but comprehensive (aim for 500-1500 words)
- **Every factual claim MUST end with a provenance tag**

## Output Format (Strict YAML Frontmatter)
---
title: [Descriptive Title]
type: summary | entity | concept | comparison
sources: [[${context.sourcePath}]]
related: [[concept1]], [[concept2]], [[concept3]]
created: ${timestamp}
updated: ${timestamp}
provenance:
  extracted: [estimated % of ^[extracted] claims]
  inferred: [estimated % of ^[inferred] claims]
  ambiguous: [estimated % of ^[ambiguous] claims]
base_confidence: [0.0-1.0]
lifecycle: draft
---

# [Title]

## Overview
[One paragraph summary - what is this about?]

## Core Concepts
[List key concepts with [[wikilinks]]]

## Details
[Main content with sections — tag each claim with provenance]

## See Also (MANDATORY - at least 3 links)
- [[related-concept-1]]: brief reason for connection
- [[related-concept-2]]: brief reason for connection
- [[related-concept-3]]: brief reason for connection

## Sources
- [[${context.sourcePath}]] - original source

## Contradictions (if any)
- "This definition differs from [[existing-page]] because..."

---

Output ONLY the Markdown content above. Do not wrap it in code blocks. Do not add preamble. Start directly with the YAML frontmatter.`;

    // 库级构建要求：追加到 prompt 末尾（用户自定义要求优先级最高）
    return appendBuildRequirements(prompt, context.buildRequirements);
  }

  /**
   * 生成基础Wiki（无LLM时使用）
   */
  generateBasicWiki(content, context) {
    const title = path.basename(context.sourcePath, path.extname(context.sourcePath));
    const ext = path.extname(context.sourcePath).toLowerCase();

    let type = '文档';
    if (['.js', '.ts', '.py', '.go', '.java'].includes(ext)) type = '代码';
    else if (['.json', '.yaml', '.yml'].includes(ext)) type = '配置';

    // 提取关键词作为标签
    const tags = this.extractTags(content);

    return `---
title: ${title}
type: ${type}
tags: [${tags.join(', ')}]
source: ${context.sourcePath}
created: ${new Date().toISOString().split('T')[0]}
---

# ${title}

## 概述
来源: ${context.sourcePath}

## 内容

\`\`\`${ext.slice(1)}
${content.slice(0, 5000)}
\`\`\`

## 相关概念
${tags.map(t => `- [[${t}]]`).join('\n')}

## 来源
- ${context.sourcePath}
`;
  }

  /**
   * 提取标签
   */
  extractTags(content) {
    const tags = new Set();

    // 提取常见的编程关键词
    const patterns = [
      /\b(function|class|interface|type|const|let|var|import|export)\b/gi,
      /\b(async|await|Promise|fetch|request)\b/gi,
      /\b(React|Vue|Angular|Node|Express)\b/gi,
      /\b(API|HTTP|REST|GraphQL)\b/gi,
      /\b(database|sql|mongo|redis)\b/gi,
    ];

    patterns.forEach(p => {
      const matches = content.match(p);
      if (matches) {
        matches.slice(0, 5).forEach(m => tags.add(m.toLowerCase()));
      }
    });

    return Array.from(tags).slice(0, 10);
  }

  /**
   * 从Wiki页面提取实体(Karpathy模式)
   */
  extractEntities(content) {
    const entities = [];

    // 提取[[wikilinks]]中的实体
    const linkPattern = /\[\[([^\]|]+)(?:\|[^\]]+)?\]\]/g;
    let match;
    while ((match = linkPattern.exec(content)) !== null) {
      const entityName = match[1].trim();
      if (entityName.length > 2 && !entities.find(e => e.name === entityName)) {
        entities.push({
          name: entityName,
          slug: this.slugify(entityName),
          type: 'entity'
        });
      }
    }

    // 提取YAML frontmatter中的实体
    const fmMatch = content.match(/^---\n([\s\S]*?)\n---/);
    if (fmMatch) {
      const fm = fmMatch[1];
      // 提取related字段中的实体
      const relatedMatch = fm.match(/related:\s*\[([^\]]+)\]/);
      if (relatedMatch) {
        const relatedEntities = relatedMatch[1].split(',').map(e => e.trim().replace(/['"]/g, '').replace(/\[\[|\]\]/g, ''));
        relatedEntities.forEach(e => {
          if (e.length > 2 && !entities.find(ent => ent.name === e)) {
            entities.push({
              name: e,
              slug: this.slugify(e),
              type: 'concept'
            });
          }
        });
      }
    }

    return entities.slice(0, 15); // 限制实体数量,避免过多
  }

  /**
   * 更新实体页面(Karpathy模式)
   */
  async updateEntityPage(entity, wikiDir, sourceFileName, projectName) {
    const entityDir = path.join(wikiDir, 'entities');
    const entityPath = path.join(entityDir, `${entity.slug}.md`);

    // 如果实体页面已存在,追加新信息
    if (fs.existsSync(entityPath)) {
      let existingContent = fs.readFileSync(entityPath, 'utf-8');

      // 解析现有frontmatter
      const fmMatch = existingContent.match(/^---\n([\s\S]*?)\n---/);
      if (fmMatch) {
        let fm = fmMatch[1];
        // 更新sources列表
        if (fm.includes('sources:')) {
          const sourcesMatch = fm.match(/sources:\s*\[([^\]]+)\]/);
          if (sourcesMatch) {
            const existingSources = sourcesMatch[1].split(',').map(s => s.trim().replace(/['"]/g, ''));
            if (!existingSources.includes(sourceFileName)) {
              existingSources.push(sourceFileName);
              fm = fm.replace(/sources:\s*\[([^\]]+)\]/, `sources: [${existingSources.map(s => `'${s}'`).join(', ')}]`);
            }
          }
        }
        // 更新updated时间戳
        const timestamp = new Date().toISOString().split('T')[0];
        fm = fm.replace(/updated:\s*.+/, `updated: ${timestamp}`);

        // 替换frontmatter
        existingContent = existingContent.replace(/^---\n([\s\S]*?)\n---/, `---\n${fm}\n---`);

        // 添加新的交叉引用(如果有新的相关内容)
        if (!existingContent.includes(`[[${sourceFileName}]]`)) {
          existingContent += `\n\n## 新增来源\n- [[${sourceFileName}]] - ${new Date().toISOString().split('T')[0]}`;
        }

        fs.writeFileSync(entityPath, existingContent);
      }
    } else {
      // 创建新的实体页面
      const timestamp = new Date().toISOString().split('T')[0];
      const newEntityPage = `---
title: ${entity.name}
type: entity
sources: ['${sourceFileName}']
related: []
created: ${timestamp}
updated: ${timestamp}
---

# ${entity.name}

## 概述
${entity.name}是一个重要实体,出现在项目 ${projectName} 中。

## 来源
- [[${sourceFileName}]] - ${timestamp}

## See Also
- 请在后续编辑中添加相关实体和概念
`;
      fs.writeFileSync(entityPath, newEntityPage);
    }
  }

  /**
   * 添加交叉引用(Karpathy模式 - 强制≥3-5个)
   */
  async addCrossReferences(summaryPage, wikiDir, filePath) {
    const crossRefs = [];

    // 从summary页面提取交叉引用
    const entities = this.extractEntities(summaryPage);

    // 为每个摘要页面添加至少3-5个交叉引用
    const summaryPath = path.join(wikiDir, 'sources', this.getWikiFileName({ name: path.basename(filePath), ext: path.extname(filePath) }));
    if (fs.existsSync(summaryPath)) {
      let content = fs.readFileSync(summaryPath, 'utf-8');

      // 检查是否已经有See Also部分
      if (!content.includes('## See Also')) {
        content += '\n\n## See Also\n';
      }

      // 添加交叉引用(强制≥3-5个)
      const existingLinks = (content.match(/\[\[([^\]|]+)\]\]/g) || []).map(l => l.replace(/\[\[|\]\]/g, ''));

      let addedCount = 0;
      for (const entity of entities) {
        if (!existingLinks.includes(entity.name) && addedCount < 5) {
          // 在See Also部分添加
          if (content.includes('## See Also')) {
            const seeAlsoSection = content.split('## See Also')[1];
            if (!seeAlsoSection.includes(`[[${entity.name}]]`)) {
              content = content.replace('## See Also', `## See Also\n- [[${entity.name}]]: 相关实体`);
              crossRefs.push({
                source: path.basename(filePath),
                target: entity.name,
                reason: '自动检测的相关实体'
              });
              addedCount++;
            }
          }
        }
      }

      // 如果交叉引用少于3个,从已有wiki页面中补充
      if (addedCount < 3) {
        const allWikiPages = this.getAllWikiPages(wikiDir);
        for (const page of allWikiPages.slice(0, 5)) {
          if (!existingLinks.includes(page.title) && addedCount < 5) {
            content = content.replace('## See Also', `## See Also\n- [[${page.title}]]: 相关Wiki页面`);
            crossRefs.push({
              source: path.basename(filePath),
              target: page.title,
              reason: '补充的Wiki页面引用'
            });
            addedCount++;
          }
        }
      }

      fs.writeFileSync(summaryPath, content);
    }

    return crossRefs;
  }

  /**
   * 标记矛盾(Karpathy模式)
   */
  async flagContradictions(summaryPage, wikiDir, sourceFileName) {
    const contradictions = [];

    // 提取摘要页中的关键定义
    const definitions = this.extractDefinitions(summaryPage);

    // 检查是否有矛盾的定义
    for (const def of definitions) {
      const entityPath = path.join(wikiDir, 'entities', `${this.slugify(def.term)}.md`);
      if (fs.existsSync(entityPath)) {
        const existingEntity = fs.readFileSync(entityPath, 'utf-8');
        const existingDefs = this.extractDefinitions(existingEntity);

        // 检查定义是否有冲突
        for (const existingDef of existingDefs) {
          if (def.term === existingDef.term && def.definition !== existingDef.definition) {
            // 发现矛盾,添加到矛盾列表
            contradictions.push({
              term: def.term,
              source1: sourceFileName,
              definition1: def.definition,
              source2: 'existing',
              definition2: existingDef.definition,
              suggestion: `检查 "${def.term}" 的定义是否一致: "${def.definition}" vs "${existingDef.definition}"`
            });

            // 在实体页面标记矛盾
            let entityContent = fs.readFileSync(entityPath, 'utf-8');
            if (!entityContent.includes('## Contradictions')) {
              entityContent += '\n\n## Contradictions\n';
            }
            entityContent += `- [[${sourceFileName}]] 定义 "${def.term}" 为 "${def.definition}",与现有定义 "${existingDef.definition}" 可能冲突\n`;
            fs.writeFileSync(entityPath, entityContent);
          }
        }
      }
    }

    return contradictions;
  }

  /**
   * 提取定义(辅助方法)
   */
  extractDefinitions(content) {
    const definitions = [];

    // 从Markdown内容中提取定义模式
    const patterns = [
      /(\w+)\s+(?:是|指|定义|表示为)\s+(.+?)(?:\n|。)/g, // 中文定义
      /(\w+)\s+(?:is|refers to|defined as|means)\s+(.+?)(?:\n|\.)/gi, // 英文定义
    ];

    patterns.forEach(pattern => {
      let match;
      while ((match = pattern.exec(content)) !== null) {
        const term = match[1].trim();
        const definition = match[2].trim();
        if (term.length > 2 && definition.length > 10) {
          definitions.push({ term, definition });
        }
      }
    });

    return definitions.slice(0, 10);
  }

  /**
   * 获取所有Wiki页面(辅助方法)
   */
  getAllWikiPages(wikiDir) {
    const pages = [];

    const scanDir = (dir, type) => {
      if (!fs.existsSync(dir)) return;
      const files = fs.readdirSync(dir).filter(f => f.endsWith('.md'));
      files.forEach(f => {
        const filePath = path.join(dir, f);
        const content = fs.readFileSync(filePath, 'utf-8');
        const titleMatch = content.match(/^#\s+(.+)$/m);
        pages.push({
          title: titleMatch ? titleMatch[1].trim() : f.replace('.md', ''),
          path: `${type}/${f}`,
          type
        });
      });
    };

    scanDir(path.join(wikiDir, 'sources'), 'sources');
    scanDir(path.join(wikiDir, 'entities'), 'entities');
    scanDir(path.join(wikiDir, 'concepts'), 'concepts');
    scanDir(path.join(wikiDir, 'comparisons'), 'comparisons');

    return pages;
  }

  /**
   * 追加操作日志(Karpathy模式 - append-only)
   */
  async appendLog(wikiDir, results) {
    const logPath = path.join(wikiDir, 'log.md');

    // 日志格式(append-only,不覆盖)
    const timestamp = new Date().toISOString();
    const logEntry = `\n## [${timestamp}] Ingest Operation

### 操作概览
- 项目: ${results.project}
- 总文件: ${results.totalFiles}
- 成功: ${results.processed}
- 失败: ${results.failed}

### 详细步骤
${results.steps.map(step =>
  `- Step ${step.step}: ${step.action} (${step.file || 'global'})${step.entities ? ` - 提取${step.entities}个实体` : ''}${step.crossRefsCount ? ` - 添加${step.crossRefsCount}个交叉引用` : ''}${step.contradictionsCount ? ` - 发现${step.contradictionsCount}个矛盾` : ''}`
).join('\n')}

### 生成的Wiki页面
${results.pages.map(p => `- ${p.wiki} (来源: ${p.source})`).join('\n')}

### 检测到的实体
${results.entities.slice(0, 20).map(e => `- [[${e.name}]] (${e.type})`).join('\n')}

### 添加的交叉引用
${results.crossReferences.slice(0, 10).map(cr => `- [[${cr.source}]] → [[${cr.target}]] (${cr.reason})`).join('\n')}

### 检测到的矛盾
${results.contradictions.length > 0 ? results.contradictions.map(c => `- ${c.term}: ${c.suggestion}`).join('\n') : '无矛盾检测'}

### 错误记录
${results.errors.length > 0 ? results.errors.map(e => `- ${e.file}: ${e.error}`).join('\n') : '无错误'}

---
`;

    // 追加写入(append-only模式)
    if (fs.existsSync(logPath)) {
      fs.appendFileSync(logPath, logEntry);
    } else {
      // 创建新的log.md
      const header = `# Wiki Operations Log

此文件记录所有Wiki操作(Ingest/Query/Lint),采用append-only模式,永不删除历史记录。

---
`;
      fs.writeFileSync(logPath, header + logEntry);
    }
  }

  /**
   * 获取Wiki文件名
   */
  getWikiFileName(file) {
    const baseName = path.basename(file.name, file.ext);
    return `${this.slugify(baseName)}.md`;
  }

  /**
   * 生成索引
   */
  async generateIndex(wikiDir, results) {
    const indexPath = path.join(wikiDir, 'index.md');
    const logPath = path.join(wikiDir, 'log.md');

    // 生成index.md
    let indexContent = `# ${results.project} Wiki Index\n\n`;
    indexContent += `生成时间: ${new Date().toISOString()}\n`;
    indexContent += `总页面数: ${results.pages.length}\n\n`;
    indexContent += `## 页面列表\n\n`;

    results.pages.forEach(page => {
      indexContent += `- [[${page.wiki.replace('.md', '')}]] - 来源: ${page.source}\n`;
    });

    fs.writeFileSync(indexPath, indexContent);

    // 生成log.md
    let logContent = `# ${results.project} Wiki Log\n\n`;
    logContent += `## ${new Date().toISOString()}\n`;
    logContent += `- 操作: Ingest\n`;
    logContent += `- 总文件: ${results.totalFiles}\n`;
    logContent += `- 成功: ${results.processed}\n`;
    logContent += `- 失败: ${results.failed}\n`;

    if (results.errors.length > 0) {
      logContent += `\n### 错误\n`;
      results.errors.forEach(e => {
        logContent += `- ${e.file}: ${e.error}\n`;
      });
    }

    fs.writeFileSync(logPath, logContent);
  }

  /**
   * 生成 purpose.md — 定义知识库的目标、关键问题和研究范围
   * 首次 Ingest 时自动填充模板，后续 Ingest 保留用户编辑的内容
   */
  async generatePurpose(wikiDir, results) {
    const purposePath = path.join(wikiDir, 'purpose.md');

    // If purpose.md already exists and has user content (not a template), don't overwrite
    if (fs.existsSync(purposePath)) {
      const existing = fs.readFileSync(purposePath, 'utf-8');
      if (!existing.includes('_待定义_')) return; // User already filled it in
    }

    // Build auto-generated purpose
    const pageTitles = (results.pages || []).map(p => p.wiki || '').filter(Boolean);
    const entityCount = (results.entities || []).length;
    const conceptPages = pageTitles.filter(t => !t.includes('实体') && !t.includes('摘要'));
    const entityNames = (results.entities || []).slice(0, 10).join('、');

    let purposeContent = '# Purpose\n\n';
    purposeContent += '> 知识库的目标、关键问题与研究范围。由系统自动生成，可手动编辑。\n\n';
    purposeContent += '## 目标\n';
    purposeContent += '从以下原始文档中提取结构化知识，建立可检索、可推理的 Wiki 知识体系：\n';
    purposeContent += (results.pages || []).map(p => `- ${p.source || '未知来源'}`).join('\n');
    purposeContent += '\n\n';
    purposeContent += '## 关键问题\n';
    purposeContent += `- 该领域包含哪些核心实体？(已识别 ${entityCount} 个实体: ${entityNames || '暂无'})\n`;
    purposeContent += `- 这些实体之间存在什么关系？\n`;
    purposeContent += `- 有哪些关键概念和定义？(已生成 ${conceptPages.length} 个概念页)\n`;
    purposeContent += '- 知识体系中是否存在矛盾或空白？\n';
    purposeContent += '\n';
    purposeContent += '## 研究范围\n';
    purposeContent += `- 项目: ${results.project}\n`;
    purposeContent += `- 源文件数: ${results.totalFiles}\n`;
    purposeContent += `- Wiki 页面数: ${results.pages.length}\n`;
    purposeContent += `- 生成时间: ${new Date().toISOString().split('T')[0]}\n`;

    fs.writeFileSync(purposePath, purposeContent, 'utf-8');
  }

  /**
   * 生成/更新 overview.md — 全局知识库概览
   */
  async generateOverview(wikiDir, results) {
    const overviewPath = path.join(wikiDir, 'overview.md');

    // Collect all page data
    const allPages = this.getAllWikiPages ? this.getAllWikiPages(wikiDir) : [];
    const pageCount = allPages.length || results.pages.length;

    // Count by subdirectory
    const dirCounts = {};
    ['concepts', 'entities', 'sources', 'syntheses'].forEach(function(d) {
      const dp = path.join(wikiDir, d);
      if (fs.existsSync(dp)) {
        dirCounts[d] = fs.readdirSync(dp).filter(function(f) { return f.endsWith('.md'); }).length;
      }
    });

    let overviewContent = '# Wiki Overview\n\n';
    overviewContent += `> 全局知识库概览 — 最后更新: ${new Date().toISOString()}\n\n`;
    overviewContent += '## 知识库统计\n\n';
    overviewContent += '| 指标 | 数值 |\n|------|------|\n';
    overviewContent += `| 总页面数 | ${pageCount} |\n`;
    overviewContent += `| Concepts (概念) | ${dirCounts.concepts || 0} |\n`;
    overviewContent += `| Entities (实体) | ${dirCounts.entities || 0} |\n`;
    overviewContent += `| Sources (来源摘要) | ${dirCounts.sources || 0} |\n`;
    overviewContent += `| Syntheses (综合分析) | ${dirCounts.syntheses || 0} |\n`;
    overviewContent += `| 交叉引用 | ${(results.crossReferences || []).length} |\n`;
    overviewContent += `| 矛盾发现 | ${(results.contradictions || []).length} |\n`;
    overviewContent += '\n';
    overviewContent += '## 最近活动\n\n';
    overviewContent += `- Ingest: ${results.totalFiles} 个文件处理完成 (${results.processed} 成功, ${results.failed} 失败)\n`;
    overviewContent += '- 操作: LLM 编译知识库\n';

    // Append recent pages
    overviewContent += '\n## 最近生成页面\n\n';
    (results.pages || []).slice(0, 10).forEach(function(p) {
      overviewContent += `- [[${(p.wiki || '').replace('.md', '')}]] ← ${p.source || ''}\n`;
    });

    fs.writeFileSync(overviewPath, overviewContent, 'utf-8');
  }

  /**
   * 两步 CoT 摄入: Step 1 分析 → Step 2 生成
   * 提升 Wiki 质量: 先让 LLM 分析文档结构，再基于分析生成 Wiki 页面
   */
  async twoStepIngest(sourcePath, options) {
    const opts = options || {};
    const projectName = opts.projectName || path.basename(sourcePath);

    // Step 1: 分析阶段 — 识别文档结构、关键实体、主题
    const analysisPrompt = [
      '你是一位知识架构师。请分析以下文档，输出结构化 JSON 分析：',
      '',
      '文档内容:',
      fs.readFileSync(sourcePath, 'utf-8').slice(0, 8000),
      '',
      '请输出 JSON (不要包含 markdown 代码块标记):',
      '{',
      '  "docType": "文档类型 (technical/report/reference/guide)",',
      '  "mainTopic": "主要主题",',
      '  "keyEntities": [{"name":"实体名","type":"person/concept/tool/process","description":"简短描述"}],',
      '  "keyConcepts": ["概念1","概念2"],',
      '  "contradictions": [{"a":"主张A","b":"主张B","topic":"主题"}],',
      '  "structureSuggestions": ["结构建议1","结构建议2"],',
      '  "summary": "2-3句概述"',
      '}'
    ].join('\n');

    // Call LLM for analysis (use the existing compileToWiki infrastructure)
    let analysis;
    try {
      const chatRoute = this.options.chatRoute;
      const apiKey = this.options.chatApiKey;
      const model = this.options.chatModel || 'deepseek-chat';

      if (chatRoute && apiKey) {
        const postData = JSON.stringify({
          model: model,
          messages: [{ role: 'user', content: analysisPrompt }],
          max_tokens: 2048,
          temperature: 0.3,
        });

        const analysisResult = await new Promise(function(resolve, reject) {
          const opts = {
            hostname: chatRoute.host,
            port: 443,
            path: chatRoute.path,
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'Authorization': 'Bearer ' + apiKey,
              'Content-Length': Buffer.byteLength(postData),
            },
          };
          const r = require('https').request(opts, function(resp) {
            let d = '';
            resp.on('data', function(c) { d += c; });
            resp.on('end', function() {
              try {
                const json = JSON.parse(d);
                const content = json.choices && json.choices[0] && json.choices[0].message && json.choices[0].message.content;
                // Extract JSON from content (strip possible markdown code block)
                const jsonMatch = (content || '').match(/\{[\s\S]*\}/);
                resolve(jsonMatch ? JSON.parse(jsonMatch[0]) : { summary: content, keyEntities: [], keyConcepts: [], contradictions: [], structureSuggestions: [] });
              } catch(e) {
                resolve({ summary: '分析失败', keyEntities: [], keyConcepts: [], contradictions: [], structureSuggestions: [] });
              }
            });
          });
          r.on('error', reject);
          r.write(postData);
          r.end();
        });
        analysis = analysisResult;
      }
    } catch (e) {
      analysis = { summary: '分析阶段出错: ' + e.message, keyEntities: [], keyConcepts: [], contradictions: [], structureSuggestions: [] };
    }

    // Step 2: 基于分析生成 Wiki
    // Inject analysis context into options for the standard ingest pipeline
    const enhancedOpts = Object.assign({}, opts, {
      projectName: projectName,
      analysis: analysis, // Pass analysis to buildIngestPrompt
    });

    return this.ingest(sourcePath, enhancedOpts);
  }

  /**
   * 路径转slug
   */
  slugify(text) {
    return text
      .toLowerCase()
      .replace(/[^a-z0-9\u4e00-\u9fa5]+/g, '-')
      .replace(/^-|-$/g, '');
  }
}

/**
 * 知识图谱构建器
 */
class GraphBuilder {
  constructor() {
    this.nodes = [];
    this.edges = [];
    this.nodeMap = new Map();
  }

  /**
   * 从Wiki目录构建图谱
   */
  buildFromWiki(wikiDir) {
    this.nodes = [];
    this.edges = [];
    this.nodeMap.clear();
    this.unresolvedLinks = [];

    // 递归扫描整个 Wiki。相对路径是稳定身份，避免不同目录中的同名页面碰撞。
    const files = [];
    const visit = directory => {
      fs.readdirSync(directory, { withFileTypes: true })
        .sort((a, b) => a.name.localeCompare(b.name))
        .forEach(entry => {
          if (entry.name === '.git' || entry.name === 'node_modules' || entry.name === 'log.md') return;
          const absolute = path.join(directory, entry.name);
          if (entry.isDirectory()) visit(absolute);
          else if (entry.isFile() && entry.name.endsWith('.md')) {
            const relative = path.relative(wikiDir, absolute).split(path.sep).join('/');
            files.push({ absolute, relative, id: relative.replace(/\.md$/i, '') });
          }
        });
    };
    visit(wikiDir);

    const aliasMap = new Map();
    const addAlias = (alias, nodeId) => {
      const key = this.slugify(String(alias || '').replace(/\.md$/i, ''));
      if (!key) return;
      if (!aliasMap.has(key)) aliasMap.set(key, new Set());
      aliasMap.get(key).add(nodeId);
    };

    // 第一遍：创建覆盖内容页、实体页和来源页的节点与别名索引。
    files.forEach(file => {
      const content = fs.readFileSync(file.absolute, 'utf-8');
      const meta = this.parseFrontmatter(content);
      const nodeId = file.id;
      const directory = file.relative.includes('/') ? file.relative.split('/')[0] : '';
      const role = directory === 'entities' ? 'ENTITY_PAGE' : directory === 'sources' ? 'SOURCE_PAGE' : 'CONTENT_PAGE';
      const node = {
        id: nodeId,
        title: meta.title || nodeId,
        type: meta.type || (role === 'ENTITY_PAGE' ? 'entity' : role === 'SOURCE_PAGE' ? 'source' : 'document'),
        role,
        path: file.relative,
        tags: meta.tags || [],
        source: meta.source || '',
        created: meta.created || '',
        degree: 0,
        inDegree: 0,
        outDegree: 0,
        orphan: true,
        definition: this.extractDefinition(content),
        level: 0,
      };

      this.nodes.push(node);
      this.nodeMap.set(nodeId, node);
      addAlias(nodeId, nodeId);
      addAlias(path.posix.basename(nodeId), nodeId);
      addAlias(node.title, nodeId);
    });

    const resolveTarget = (rawTarget, sourceId) => {
      const cleaned = String(rawTarget || '').trim().split('#')[0].replace(/\\/g, '/').replace(/\.md$/i, '');
      if (!cleaned) return { reason: 'NOT_FOUND', candidates: [] };
      const explicit = path.posix.normalize(cleaned.replace(/^\.\//, ''));
      if (!explicit.startsWith('../') && this.nodeMap.has(explicit)) return { id: explicit };
      const relative = path.posix.normalize(path.posix.join(path.posix.dirname(sourceId), explicit));
      if (!relative.startsWith('../') && this.nodeMap.has(relative)) return { id: relative };
      const candidates = Array.from(aliasMap.get(this.slugify(cleaned)) || []);
      if (candidates.length === 1) return { id: candidates[0] };
      return { reason: candidates.length > 1 ? 'AMBIGUOUS' : 'NOT_FOUND', candidates: candidates.slice(0, 20) };
    };

    // 第二遍：从 wikilinks 创建关系。模糊别名绝不猜测，保留为可审阅的未解析关系。
    const edgeKeys = new Set();
    files.forEach(file => {
      const content = fs.readFileSync(file.absolute, 'utf-8');
      const sourceId = file.id;

      const linkPattern = /\[\[([^\]|]+)(?:\|[^\]]+)?\]\]/g;
      let match;
      while ((match = linkPattern.exec(content)) !== null) {
        const resolution = resolveTarget(match[1], sourceId);
        if (!resolution.id) {
          this.unresolvedLinks.push({ source: sourceId, target: match[1].trim(), reason: resolution.reason, candidates: resolution.candidates });
          continue;
        }
        const targetId = resolution.id;
        if (sourceId !== targetId) {
          const edgeKey = `${sourceId}->${targetId}`;
          if (!edgeKeys.has(edgeKey)) {
            edgeKeys.add(edgeKey);
            this.edges.push({ source: sourceId, target: targetId, type: 'wiki_link' });
            const sourceNode = this.nodeMap.get(sourceId);
            const targetNode = this.nodeMap.get(targetId);
            sourceNode.outDegree++;
            sourceNode.degree++;
            sourceNode.orphan = false;
            targetNode.inDegree++;
            targetNode.degree++;
            targetNode.orphan = false;
          }
        }
      }
    });

    // 计算层级（基于入度）
    this.calculateLevels();

    return {
      nodes: this.nodes,
      edges: this.edges,
      stats: {
        totalNodes: this.nodes.length,
        totalEdges: this.edges.length,
        orphanNodes: this.nodes.filter(n => n.orphan).length,
        avgDegree: this.nodes.reduce((sum, n) => sum + n.degree, 0) / this.nodes.length || 0,
      },
      unresolved_links: this.unresolvedLinks,
    };
  }

  /**
   * 解析YAML frontmatter
   */
  parseFrontmatter(content) {
    const match = content.match(/^---\n([\s\S]*?)\n---/);
    if (!match) return {};

    const frontmatter = match[1];
    const meta = {};

    frontmatter.split('\n').forEach(line => {
      const [key, ...valueParts] = line.split(':');
      if (key && valueParts.length) {
        let value = valueParts.join(':').trim();
        // 解析数组
        if (value.startsWith('[') && value.endsWith(']')) {
          value = value.slice(1, -1).split(',').map(s => s.trim().replace(/['"]/g, ''));
        }
        meta[key.trim()] = value;
      }
    });

    return meta;
  }

  /**
   * 提取定义
   */
  extractDefinition(content) {
    // 移除frontmatter
    const body = content.replace(/^---\n[\s\S]*?\n---\n/, '');

    // 提取第一个段落
    const paragraphs = body.split('\n\n').filter(p => p.trim() && !p.startsWith('#') && !p.startsWith('```'));
    if (paragraphs.length > 0) {
      return paragraphs[0].slice(0, 200);
    }

    return '';
  }

  /**
   * 计算节点层级
   */
  calculateLevels() {
    // BFS计算层级
    const visited = new Set();
    const queue = [];

    // 从入度为0的节点开始
    this.nodes.forEach(node => {
      if (node.inDegree === 0) {
        node.level = 0;
        queue.push(node.id);
        visited.add(node.id);
      }
    });

    while (queue.length > 0) {
      const nodeId = queue.shift();
      const node = this.nodeMap.get(nodeId);

      // 找到所有出边
      this.edges.filter(e => e.source === nodeId).forEach(edge => {
        const targetNode = this.nodeMap.get(edge.target);
        if (targetNode && !visited.has(targetNode.id)) {
          targetNode.level = (node.level || 0) + 1;
          visited.add(targetNode.id);
          queue.push(targetNode.id);
        }
      });
    }

    // 未访问的节点设为最大层级
    const maxLevel = Math.max(...this.nodes.map(n => n.level || 0));
    this.nodes.forEach(node => {
      if (!visited.has(node.id)) {
        node.level = maxLevel + 1;
      }
    });
  }

  /**
   * 保存图谱数据
   */
  save(graphData, outputPath) {
    fs.writeFileSync(outputPath, JSON.stringify(graphData, null, 2));
  }

  /**
   * 路径转slug
   */
  slugify(text) {
    return text
      .toLowerCase()
      .replace(/[^a-z0-9\u4e00-\u9fa5]+/g, '-')
      .replace(/^-|-$/g, '');
  }
/**
   * Build graph with four-signal edge weighting (direct links x3.0, source overlap x4.0, Adamic-Adar x1.5, type affinity x1.0)
   */
  buildWithSignals(wikiDir) {
    var base = this.buildFromWiki(wikiDir);
    var sourceMap = {};
    this.nodes.forEach(function(n) {
      if (n.source) {
        var src = n.source.replace(/[\/\\/]/g, "_");
        if (!sourceMap[src]) sourceMap[src] = [];
        sourceMap[src].push(n.id);
      }
    });
    var weightedEdges = {};
    function addEdge(s, t, weight, type) {
      if (s === t) return;
      var key = [s, t].sort().join("||");
      if (!weightedEdges[key]) weightedEdges[key] = { source: s, target: t, weight: 0, signals: [] };
      weightedEdges[key].weight += weight;
      weightedEdges[key].signals.push(type);
    }
    this.edges.forEach(function(e) { addEdge(e.source, e.target, 3.0, "direct_link"); });
    Object.values(sourceMap).forEach(function(pages) {
      for (var i = 0; i < pages.length; i++)
        for (var j = i + 1; j < pages.length; j++)
          addEdge(pages[i], pages[j], 4.0, "source_overlap");
    });
    // Adamic-Adar + Type affinity: skip for large graphs (>500 nodes) to avoid O(n^2) stack blowup
    if (this.nodes.length <= 500) {
      var adj = {};
      this.nodes.forEach(function(n) { adj[n.id] = new Set(); });
      this.edges.forEach(function(e) {
        if (adj[e.source]) adj[e.source].add(e.target);
        if (adj[e.target]) adj[e.target].add(e.source);
      });
      var self = this;
      this.nodes.forEach(function(a) {
        self.nodes.forEach(function(b) {
          if (a.id >= b.id) return;
          var shared = 0;
          adj[a.id].forEach(function(nb) { if (adj[b.id].has(nb)) shared++; });
          if (shared > 0) addEdge(a.id, b.id, (1.0 / Math.log(shared + 1)) * 1.5, "adamic_adar");
        });
      });
      var typeGroups = {};
      this.nodes.forEach(function(n) {
        if (!typeGroups[n.type]) typeGroups[n.type] = [];
        typeGroups[n.type].push(n.id);
      });
      Object.values(typeGroups).forEach(function(pages) {
        // 大类型组的全连接只会制造图谱毛球，不构成有意义的知识关系。
        if (pages.length > 25) return;
        for (var i = 0; i < pages.length; i++)
          for (var j = i + 1; j < pages.length; j++)
            addEdge(pages[i], pages[j], 1.0, "type_affinity");
      });
    }
    var edgeWeights = Object.values(weightedEdges).map(function(e) { return e.weight; });
    var maxW = 1;
    for (var wi = 0; wi < edgeWeights.length; wi++) { if (edgeWeights[wi] > maxW) maxW = edgeWeights[wi]; }
    var edges = Object.values(weightedEdges).map(function(e) {
      return { source: e.source, target: e.target, weight: Math.round(e.weight / maxW * 1000) / 100, signals: e.signals };
    });
    return {
      nodes: this.nodes, edges: edges, unresolved_links: this.unresolvedLinks || [],
      stats: {
        totalNodes: this.nodes.length, totalEdges: edges.length,
        orphanNodes: this.nodes.filter(function(n) { return n.orphan; }).length,
        avgWeight: edges.reduce(function(s, e) { return s + e.weight; }, 0) / (edges.length || 1),
      },
    };
  }

  /**
   * Louvain community detection. Returns { communities, modularity }
   */
  detectCommunities() {
    var adj = {};
    var nodeIds = this.nodes.map(function(n) { return n.id; });
    nodeIds.forEach(function(id) { adj[id] = {}; });
    var totalWeight = this.edges.reduce(function(s, e) { return s + (e.weight || 1); }, 0) || 1;
    this.edges.forEach(function(e) {
      var w = e.weight || 1;
      adj[e.source][e.target] = (adj[e.source][e.target] || 0) + w;
      adj[e.target][e.source] = (adj[e.target][e.source] || 0) + w;
    });
    var community = {};
    nodeIds.forEach(function(id) { community[id] = id; });
    var improved = true, iterations = 0;
    while (improved && iterations < 20) {
      improved = false; iterations++;
      nodeIds.forEach(function(node) {
        var currentComm = community[node];
        var commWeights = {};
        Object.keys(adj[node]).forEach(function(nb) {
          var nbComm = community[nb];
          commWeights[nbComm] = (commWeights[nbComm] || 0) + adj[node][nb];
        });
        var bestComm = currentComm, bestDeltaQ = 0;
        Object.keys(commWeights).forEach(function(comm) {
          var deltaQ = commWeights[comm] / totalWeight;
          if (deltaQ > bestDeltaQ) { bestDeltaQ = deltaQ; bestComm = comm; }
        });
        if (bestComm !== currentComm) { community[node] = bestComm; improved = true; }
      });
    }
    var commGroups = {};
    nodeIds.forEach(function(id) {
      var c = community[id];
      if (!commGroups[c]) commGroups[c] = [];
      commGroups[c].push(id);
    });
    var communities = Object.keys(commGroups).map(function(key) {
      var nodes = commGroups[key];
      var internalEdges = 0;
      for (var i = 0; i < nodes.length; i++)
        for (var j = i + 1; j < nodes.length; j++)
          internalEdges += (adj[nodes[i]][nodes[j]] || 0);
      var cohesion = nodes.length > 1 ? internalEdges / totalWeight : 1;
      return { id: key, nodes: nodes, size: nodes.length, cohesion: cohesion };
    });
    var modularity = communities.reduce(function(s, c) { return s + c.cohesion; }, 0) / (communities.length || 1);
    return { communities: communities, modularity: modularity };
  }

  /**
   * Compute graph insights: surprise connections, knowledge gaps, bridge nodes
   */
  computeInsights(communities) {
    var insights = { surpriseConnections: [], knowledgeGaps: [], bridgeNodes: [] };
    if (!communities || communities.length < 2) return insights;
    var nodeComm = {};
    communities.forEach(function(c) { c.nodes.forEach(function(n) { nodeComm[n] = c.id; }); });
    var self = this;
    this.nodes.forEach(function(n) {
      var neighborComms = new Set();
      self.edges.forEach(function(e) {
        if (e.source === n.id && nodeComm[e.target] !== nodeComm[n.id]) neighborComms.add(nodeComm[e.target]);
        if (e.target === n.id && nodeComm[e.source] !== nodeComm[n.id]) neighborComms.add(nodeComm[e.source]);
      });
      if (neighborComms.size >= 2) insights.bridgeNodes.push({ id: n.id, title: n.title, communities: Array.from(neighborComms) });
    });
    this.edges.forEach(function(e) {
      if (nodeComm[e.source] && nodeComm[e.target] && nodeComm[e.source] !== nodeComm[e.target])
        insights.surpriseConnections.push({ source: e.source, target: e.target, sourceComm: nodeComm[e.source], targetComm: nodeComm[e.target], weight: e.weight || 1 });
    });
    communities.forEach(function(c) {
      if (c.cohesion < 0.15 && c.size > 1)
        insights.knowledgeGaps.push({ communityId: c.id, size: c.size, cohesion: c.cohesion, warning: "Low cohesion - possible knowledge gap" });
    });
    return insights;
  }

  /**
   * Full analysis pipeline: signal fusion + community detection + insights
   */
  analyze(wikiDir) {
    var graph = this.buildWithSignals(wikiDir);
    var communities = this.detectCommunities();
    var commList = communities && communities.communities ? communities.communities : (Array.isArray(communities) ? communities : []);
    var insights = this.computeInsights(commList);
    return { graph: graph, communities: communities, insights: insights };
  }
}

/**
 * 交叉链接引擎 - 自动发现未链接的提及并织网[[wikilinks]]
 */
class CrossLinker {
  constructor(wikiDir) {
    this.wikiDir = wikiDir;
  }

  /**
   * 扫描整个Wiki，发现未链接的提及并建议链接
   * @returns {Array} 链接建议列表 [{from, to, confidence, context}]
   */
  discoverUnlinkedMentions() {
    var self = this;
    var allPages = this._loadAllPages();
    var suggestions = [];

    // 构建页面标题索引
    var titleIndex = {};
    var aliasIndex = {};
    allPages.forEach(function(p) {
      titleIndex[p.title.toLowerCase()] = p;
      // 同时索引文件名的slug作为别名
      var slug = p.id.replace(/\.md$/, '').replace(/-/g, ' ');
      if (slug !== p.title.toLowerCase()) {
        aliasIndex[slug] = p;
      }
    });

    // 扫描每页的非链接文本，检查是否提及了其他页面的标题
    allPages.forEach(function(sourcePage) {
      var bodyText = self._extractBodyText(sourcePage.content);
      // 提取所有已有的[[wikilinks]]
      var existingLinks = new Set();
      var linkRegex = /\[\[([^\]|]+)(?:\|[^\]]+)?\]\]/g;
      var m;
      while ((m = linkRegex.exec(sourcePage.content)) !== null) {
        existingLinks.add(m[1].trim().toLowerCase());
      }

      // 检查每个其他页面的标题是否在body中出现(未链接)
      allPages.forEach(function(targetPage) {
        if (targetPage.id === sourcePage.id) return;
        var targetTitle = targetPage.title.toLowerCase();
        if (existingLinks.has(targetTitle)) return;

        // 检查文本中是否提及此标题
        var idx = bodyText.toLowerCase().indexOf(targetTitle);
        if (idx >= 0) {
          var contextStart = Math.max(0, idx - 40);
          var contextEnd = Math.min(bodyText.length, idx + targetTitle.length + 40);
          var context = '...' + bodyText.slice(contextStart, contextEnd).trim() + '...';

          // 计算置信度: 标题越长越可信, 出现次数越多越可信
          var occurrences = (bodyText.toLowerCase().match(new RegExp(targetTitle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi')) || []).length;
          var confidence = Math.min(5, Math.ceil(targetTitle.length / 4) + Math.min(2, occurrences));

          suggestions.push({
            from: sourcePage.id,
            fromTitle: sourcePage.title,
            to: targetPage.id,
            toTitle: targetPage.title,
            confidence: confidence,
            context: context,
            applied: false,
          });
        }
      });
    });

    // 按confidence降序排列
    suggestions.sort(function(a, b) { return b.confidence - a.confidence; });
    return suggestions;
  }

  /**
   * 自动应用高置信度的链接建议 (confidence >= 3)
   * @returns {number} 应用的链接数
   */
  applyLinks(suggestions, minConfidence) {
    minConfidence = minConfidence || 3;
    var applied = 0;
    var self = this;

    suggestions.forEach(function(s) {
      if (s.confidence < minConfidence) return;
      var filePath = path.join(self.wikiDir, s.from);
      if (!fs.existsSync(filePath)) return;

      var content = fs.readFileSync(filePath, 'utf-8');
      // 在正文中找到标题文本并包裹[[wikilink]]
      var escapedTitle = s.toTitle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      var regex = new RegExp('(\\b' + escapedTitle + '\\b)(?!\\]\\])', 'i');
      if (regex.test(content)) {
        content = content.replace(regex, '[[' + s.toTitle + ']]');
        fs.writeFileSync(filePath, content, 'utf-8');
        s.applied = true;
        applied++;
      }
    });

    return applied;
  }

  /**
   * 加载Wiki中所有.md页面
   * @private
   */
  _loadAllPages() {
    var self = this;
    var pages = [];
    var scanDir = function(dir) {
      if (!fs.existsSync(dir)) return;
      var files = fs.readdirSync(dir);
      files.forEach(function(f) {
        if (!f.endsWith('.md')) return;
        var filePath = path.join(dir, f);
        var content = fs.readFileSync(filePath, 'utf-8');
        var title = self._extractTitle(content) || f.replace('.md', '');
        pages.push({ id: f, path: filePath, title: title, content: content, dir: path.basename(dir) });
      });
    };

    // 扫描所有Wiki子目录
    ['sources', 'entities', 'concepts', 'comparisons', 'syntheses'].forEach(function(sub) {
      scanDir(path.join(self.wikiDir, sub));
    });
    // 也扫描根目录
    scanDir(self.wikiDir);

    return pages;
  }

  /**
   * 提取页面的纯文本body(去掉frontmatter和markdown语法)
   * @private
   */
  _extractBodyText(content) {
    // 移除frontmatter
    var body = content.replace(/^---\n[\s\S]*?\n---\n/, '');
    // 移除已有的[[wikilinks]]标记但保留标题文本
    body = body.replace(/\[\[([^\]|]+)(?:\|[^\]]+)?\]\]/g, '$1');
    // 移除markdown语法
    body = body.replace(/#{1,6}\s*/g, '');
    body = body.replace(/\*\*([^*]+)\*\*/g, '$1');
    body = body.replace(/__([^_]+)__/g, '$1');
    body = body.replace(/`([^`]+)`/g, '$1');
    body = body.replace(/\[([^\]]+)\]\([^)]+\)/g, '$1');
    body = body.replace(/>\s*/g, '');
    body = body.replace(/^[-*+]\s/gm, '');
    body = body.replace(/\|/g, ' ');
    body = body.replace(/---+/g, '');
    return body;
  }

  /**
   * 从frontmatter提取标题
   * @private
   */
  _extractTitle(content) {
    var fmMatch = content.match(/^---\n([\s\S]*?)\n---/);
    if (fmMatch) {
      var titleMatch = fmMatch[1].match(/^title:\s*(.+)$/m);
      if (titleMatch) return titleMatch[1].trim();
    }
    // Fallback: 第一个#标题
    var h1Match = content.match(/^#\s+(.+)$/m);
    return h1Match ? h1Match[1].trim() : null;
  }
}

/**
 * Wiki维护引擎 - 核心功能模块(Karpathy模式)
 */
class WikiMaintainer {
  constructor(wikiEngine) {
    this.wikiEngine = wikiEngine;
  }

  /**
   * 查询并归档答案到Wiki (知识复利核心 - Karpathy模式)
   * 实现"用户查询 → Wiki回答 → 归档优质答案"循环
   */
  async queryAndArchive(query, wikiDir, options = {}) {
    const {
      archiveDir = path.join(wikiDir, 'syntheses'),
      maxArchives = 50,
      llmApiKey = this.wikiEngine.llmApiKey,
    } = options;

    ensureDirs();
    if (!fs.existsSync(archiveDir)) {
      fs.mkdirSync(archiveDir, { recursive: true });
    }

    // Step 1: Query(用户查询)
    // 读取index.md了解现有页面
    const indexPath = path.join(wikiDir, 'index.md');
    let existingPages = [];
    if (fs.existsSync(indexPath)) {
      existingPages = this.parsePageIndex(fs.readFileSync(indexPath, 'utf-8'));
    }

    // Step 2: Read Wiki(从Wiki读答案)
    // 使用SearchEngine检索相关页面
    const searchEngine = new SearchEngine();
    searchEngine.buildIndex(wikiDir);
    const relevantPages = searchEngine.search(query, { topK: 5 });

    // 构建查询上下文
    let context = '';
    relevantPages.forEach(page => {
      const pagePath = path.join(wikiDir, page.id);
      if (fs.existsSync(pagePath)) {
        const content = fs.readFileSync(pagePath, 'utf-8');
        context += `\n### ${page.title}\n${content.slice(0, 1000)}\n`;
      }
    });

    // Step 3: LLM生成答案(Karpathy高质量要求)
    let answer = '';
    if (llmApiKey) {
      answer = await this.generateAnswer(query, context, relevantPages, llmApiKey);
    } else {
      answer = this.generateBasicAnswer(query, relevantPages);
    }

    // Step 4: Archive Answer(优质答案归档回Wiki) - 知识复利核心
    // 判断是否值得归档(严格质量评分)
    const archiveScore = this.evaluateAnswerQuality(answer, query, relevantPages);

    if (archiveScore >= 0.6) { // Karpathy标准:仅高质量答案归档
      // Step 5: Become Permanent Knowledge(成为新的永久知识点)
      const archivePage = this.createArchivePage(query, answer, relevantPages, archiveScore);
      var archiveId = 'synthesis-' + Date.now();
      const archivePath = path.join(archiveDir, `${archiveId}.md`);
      fs.writeFileSync(archivePath, archivePage);

      // 更新index.md
      this.updateIndex(indexPath, {
        id: archiveId,
        title: `探索: ${query.slice(0, 50)}...`,
        type: 'synthesis',
        score: archiveScore,
      });

      // 添加交叉引用到相关页面(知识复利)
      relevantPages.forEach(page => {
        this.addCrossReference(path.join(wikiDir, page.id), archiveId);
      });

      // 追加操作日志(符合Karpathy标准)
      this.appendToLog(wikiDir, {
        operation: 'query_and_archive',
        query,
        archiveId,
        archiveScore,
        relevantPages: relevantPages.length,
        timestamp: new Date().toISOString()
      });

      return {
        query,
        answer,
        archived: true,
        archiveId,
        archiveScore,
        relevantPages,
        knowledgeCompound: true, // 知识复利成功
      };
    }

    return {
      query,
      answer,
      archived: false,
      archiveScore,
      relevantPages,
      knowledgeCompound: false,
    };
  }

  /**
   * Wiki健康检查 (Lint - Karpathy模式)
   * Step 1: Discover Orphan Pages(发现孤儿页)
   * Step 2: Detect Contradictions(检测矛盾)
   * Step 3: Find Missing References(发现缺失引用)
   * Step 4: Suggest Fixes(建议修复)
   */
  lintWiki(wikiDir, options = {}) {
    const {
      checkOrphans = true,
      checkContradictions = true,
      checkMissingRefs = true,
      maxResults = 100,
    } = options;

    const issues = {
      orphanPages: [],
      contradictions: [],
      missingReferences: [],
      stalePages: [],
      brokenLinks: [],
      summary: {
        totalPages: 0,
        linkedPages: 0,
        orphans: 0,
        avgDegree: 0,
        healthScore: 0,
      },
    };

    // 构建图谱(用于分析)
    const graphBuilder = new GraphBuilder();
    const graph = graphBuilder.buildFromWiki(wikiDir);

    issues.summary.totalPages = graph.nodes.length;
    issues.summary.orphans = graph.stats.orphanNodes;
    issues.summary.avgDegree = graph.stats.avgDegree;

    // ===== Step 1: Discover Orphan Pages(发现孤儿页) =====
    if (checkOrphans) {
      issues.orphanPages = graph.nodes
        .filter(n => n.orphan)
        .slice(0, maxResults)
        .map(n => ({
          id: n.id,
          title: n.title,
          type: n.type,
          definition: n.definition,
          suggestion: `添加到 [[index]] 或在相关页面添加 [[${n.id}]]`,
          severity: 'high',
        }));
    }

    // ===== Step 2: Detect Contradictions(检测矛盾) =====
    if (checkContradictions) {
      // 检查所有页面,寻找定义冲突
      const allPages = [];
      const scanDir = (dir, type) => {
        if (!fs.existsSync(dir)) return;
        const files = fs.readdirSync(dir).filter(f => f.endsWith('.md'));
        files.forEach(f => {
          const filePath = path.join(dir, f);
          const content = fs.readFileSync(filePath, 'utf-8');
          allPages.push({ path: filePath, content, type, name: f });
        });
      };

      scanDir(path.join(wikiDir, 'sources'), 'summary');
      scanDir(path.join(wikiDir, 'entities'), 'entity');
      scanDir(path.join(wikiDir, 'concepts'), 'concept');

      // 提取所有定义并检测冲突
      const allDefinitions = {};
      allPages.forEach(page => {
        const defs = this.extractDefinitionsFromPage(page.content);
        defs.forEach(def => {
          if (!allDefinitions[def.term]) {
            allDefinitions[def.term] = [];
          }
          allDefinitions[def.term].push({
            definition: def.definition,
            source: page.name,
            type: page.type
          });
        });
      });

      // 检查冲突的定义
      Object.keys(allDefinitions).forEach(term => {
        if (allDefinitions[term].length > 1) {
          const definitions = allDefinitions[term];
          // 检查定义是否不同
          for (let i = 0; i < definitions.length - 1; i++) {
            for (let j = i + 1; j < definitions.length; j++) {
              if (definitions[i].definition !== definitions[j].definition) {
                // 发现矛盾
                issues.contradictions.push({
                  term,
                  source1: definitions[i].source,
                  definition1: definitions[i].definition,
                  source2: definitions[j].source,
                  definition2: definitions[j].definition,
                  suggestion: `统一 "${term}" 的定义,或标注为不同的视角`,
                  severity: 'medium',
                });
              }
            }
          }
        }
      });
    }

    // ===== Step 3: Find Missing References(发现缺失引用) =====
    if (checkMissingRefs) {
      // 检查高频提及但无独立页面的概念
      const allWikilinks = new Set();
      const existingPages = new Set(graph.nodes.map(n => n.id));

      // 收集所有wikilinks
      graph.nodes.forEach(node => {
        const pagePath = path.join(wikiDir, `${node.id}.md`);
        if (fs.existsSync(pagePath)) {
          const content = fs.readFileSync(pagePath, 'utf-8');
          const linkMatches = content.match(/\[\[([^\]|]+)(?:\|[^\]]+)?\]\]/g) || [];
          linkMatches.forEach(link => {
            const linkId = this.slugify(link.replace(/\[\[|\]\]/g, '').split('|')[0]);
            allWikilinks.add(linkId);
          });
        }
      });

      // 检查缺失的页面
      allWikilinks.forEach(linkId => {
        if (!existingPages.has(linkId)) {
          issues.missingReferences.push({
            keyword: linkId,
            frequency: 1,
            suggestion: `创建缺失页面 [[${linkId}]]`,
            severity: 'low',
          });
        }
      });

      // 检查破损链接(wikilinks指向不存在的文件)
      issues.brokenLinks = issues.missingReferences.slice(0, 20);
    }

    // ===== Step 4: Check Stale Pages(检查过期页面) =====
    issues.stalePages = graph.nodes
      .filter(function(n) {
        const pagePath = path.join(wikiDir, n.id + '.md');
        if (!fs.existsSync(pagePath)) return false;
        const content = fs.readFileSync(pagePath, 'utf-8');
        const meta = graphBuilder.parseFrontmatter(content);
        if (!meta.updated && !meta.created) return true;
        const lastUpdate = new Date(meta.updated || meta.created);
        const daysSinceUpdate = (Date.now() - lastUpdate.getTime()) / (1000 * 60 * 60 * 24);
        return daysSinceUpdate > CONFIG.healthThresholds.maxStaleDays;
      })
      .slice(0, maxResults)
      .map(function(n) {
        return {
          id: n.id,
          title: n.title,
          lastUpdate: '超过' + CONFIG.healthThresholds.maxStaleDays + '天',
          suggestion: '检查内容是否需要更新',
          severity: 'low',
        };
      });

    // ===== Step 4.5: Provenance Drift Detection(溯源漂移检测) =====
    var provenanceDrift = [];
    var scanDirProvenance = function(dir) {
      if (!fs.existsSync(dir)) return;
      var files = fs.readdirSync(dir).filter(function(f) { return f.endsWith('.md'); });
      files.forEach(function(f) {
        var filePath = path.join(dir, f);
        var content = fs.readFileSync(filePath, 'utf-8');
        var meta = graphBuilder.parseFrontmatter(content);
        if (!meta.provenance) return;
        // 从frontmatter解析provenance比例
        var extMatch = (meta.provenance + '').match(/extracted:\s*(\d+)%/);
        var ambMatch = (meta.provenance + '').match(/ambiguous:\s*(\d+)%/);
        var extracted = extMatch ? parseInt(extMatch[1]) : 100;
        var ambiguous = ambMatch ? parseInt(ambMatch[1]) : 0;

        if (extracted < (CONFIG.healthThresholds.minProvenanceExtracted * 100)) {
          provenanceDrift.push({
            id: f, title: meta.title || f, type: 'speculation_drift',
            extracted: extracted, ambiguous: ambiguous,
            suggestion: '该页面过度依赖推理(' + (100-extracted) + '%推断), 需补充原始来源',
            severity: 'high',
          });
        } else if (ambiguous > (CONFIG.healthThresholds.maxProvenanceAmbiguous * 100)) {
          provenanceDrift.push({
            id: f, title: meta.title || f, type: 'ambiguity_drift',
            extracted: extracted, ambiguous: ambiguous,
            suggestion: '该页面有' + ambiguous + '%的歧义声明, 需要澄清或标注',
            severity: 'medium',
          });
        }
      });
    };

    ['sources', 'entities', 'concepts', 'comparisons', 'syntheses'].forEach(function(sub) {
      scanDirProvenance(path.join(wikiDir, sub));
    });
    scanDirProvenance(wikiDir);

    issues.provenanceDrift = provenanceDrift;

    // ===== Step 5: Calculate Health Score(计算健康度) =====
    var orphanRatio = issues.summary.orphans / Math.max(1, issues.summary.totalPages);
    var contradictionRatio = issues.contradictions.length / Math.max(1, issues.summary.totalPages);
    var missingRefRatio = issues.missingReferences.length / Math.max(1, issues.summary.totalPages);
    var driftRatio = provenanceDrift.length / Math.max(1, issues.summary.totalPages);

    issues.summary.healthScore = Math.max(0, Math.round(
      100 - (orphanRatio * 30 + contradictionRatio * 20 + missingRefRatio * 10 + driftRatio * 15)
    ));

    // 追加Lint日志
    this.appendToLog(wikiDir, {
      operation: 'lint',
      issuesFound: issues.orphanPages.length + issues.contradictions.length + issues.missingReferences.length + provenanceDrift.length,
      healthScore: issues.summary.healthScore,
      provenanceDriftCount: provenanceDrift.length,
      timestamp: new Date().toISOString()
    });

    return issues;
  }

  /**
   * 从页面提取定义(辅助方法)
   */
  extractDefinitionsFromPage(content) {
    const definitions = [];

    // 移除frontmatter
    const body = content.replace(/^---\n[\s\S]*?\n---\n/, '');

    // 提取定义模式
    const patterns = [
      /(\w+)\s+(?:是|指|定义|表示为)\s+(.+?)(?:\n|。)/g,
      /(\w+)\s+(?:is|refers to|defined as|means)\s+(.+?)(?:\n|\.)\./gi,
    ];

    patterns.forEach(pattern => {
      let match;
      while ((match = pattern.exec(body)) !== null) {
        const term = match[1].trim();
        const definition = match[2].trim();
        if (term.length > 2 && definition.length > 10) {
          definitions.push({ term, definition });
        }
      }
    });

    return definitions.slice(0, 10);
  }

  /**
   * 追加操作日志(简化版)
   */
  appendToLog(wikiDir, logData) {
    const logPath = path.join(wikiDir, 'log.md');

    const timestamp = logData.timestamp || new Date().toISOString();
    const logEntry = `\n## ${timestamp}] ${logData.operation}

${Object.keys(logData).filter(k => k !== 'operation' && k !== 'timestamp').map(k => `- ${k}: ${logData[k]}`).join('\n')}

---
`;

    if (fs.existsSync(logPath)) {
      fs.appendFileSync(logPath, logEntry);
    } else {
      const header = `# Wiki Operations Log

This file records all Wiki operations (Ingest/Query/Lint), using append-only mode. Never delete history.

---
`;
      fs.writeFileSync(logPath, header + logEntry);
    }
  }

  /**
   * 生成 hot.md - 最近活动快照 (对齐 obsidian-wiki)
   */
  generateHotMd(wikiDir) {
    var hotPath = path.join(wikiDir, 'hot.md');
    var now = new Date().toISOString();
    var allPages = [];

    var scanDirsFn = function(dir, type) {
      if (!fs.existsSync(dir)) return;
      fs.readdirSync(dir).filter(function(f) { return f.endsWith('.md'); }).forEach(function(f) {
        var fp = path.join(dir, f);
        var stat = fs.statSync(fp);
        var pageContent = fs.readFileSync(fp, 'utf-8');
        var fm = {};
        var fmMatch = pageContent.match(/^---\n([\s\S]*?)\n---/);
        if (fmMatch) {
          fmMatch[1].split('\n').forEach(function(line) {
            var m = line.match(/^(\w+):\s*(.+)$/);
            if (m) fm[m[1]] = m[2].trim();
          });
        }
        allPages.push({
          path: fp, name: f, type: type,
          title: fm.title || f.replace('.md', ''),
          updated: fm.updated || stat.mtime.toISOString().split('T')[0],
          lifecycle: fm.lifecycle || 'draft',
          mtime: stat.mtime.getTime(),
        });
      });
    }.bind(this);

    CONFIG.wikiSubDirs.forEach(function(sub) { scanDirsFn(path.join(wikiDir, sub), sub); });
    allPages.sort(function(a, b) { return b.mtime - a.mtime; });
    var activePages = allPages.filter(function(p) { return p.mtime > Date.now() - 604800000; });

    var logPath = path.join(wikiDir, 'log.md');
    var recentOps = [];
    if (fs.existsSync(logPath)) {
      recentOps = fs.readFileSync(logPath, 'utf-8').split('---').slice(-10).filter(function(e) { return e.trim(); }).slice(-5);
    }

    var lines = [];
    lines.push('# Activity Snapshot');
    lines.push('> ' + now);
    lines.push('');
    lines.push('## Recently Active (7d: ' + activePages.length + ')');
    activePages.slice(0,10).forEach(function(p) {
      lines.push('- [[' + p.title + ']] (' + p.type + ') ' + p.updated);
    });
    lines.push('');
    lines.push('## Recent (15)');
    allPages.slice(0,15).forEach(function(p) {
      lines.push('- [[' + p.title + ']] (' + p.type + ') ' + p.updated);
    });
    lines.push('');
    lines.push('## Stats');
    lines.push('- Total: ' + allPages.length + ' | Draft: ' + allPages.filter(function(p){return p.lifecycle==='draft';}).length + ' | Stable: ' + allPages.filter(function(p){return p.lifecycle==='stable';}).length);
    lines.push('');
    lines.push('## Ops');
    recentOps.forEach(function(op) {
      lines.push('- ' + op.trim().split('\n')[0].replace(/^##\s*/, ''));
    });

    fs.writeFileSync(hotPath, lines.join('\n'), 'utf-8');
    return hotPath;
  }

  /**
   * 路径转slug(辅助方法)
   */
  slugify(text) {
    return text
      .toLowerCase()
      .replace(/[^a-z0-9\u4e00-\u9fa5]+/g, '-')
      .replace(/^-|-$/g, '');
  }
}



/**
 * 混合检索引擎
 */
class SearchEngine {
  constructor() {
    this.index = new Map();
    this.documents = [];
  }

  /**
   * 构建索引
   */
  buildIndex(wikiDir, opts) {
    opts = opts || {};
    this.index.clear();
    this.documents = [];

    // Meta pages to skip in search index (navigation pages, not knowledge pages)
    var skipFiles = opts.skipFiles || ['index.md', 'overview.md', 'purpose.md', 'log.md'];

    // Recursively collect all .md files
    var self = this;
    function collectFiles(dir, relRoot) {
      relRoot = relRoot || '';
      var entries;
      try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch(e) { return; }
      entries.forEach(function(entry) {
        var fullPath = path.join(dir, entry.name);
        var relPath = relRoot ? relRoot + '/' + entry.name : entry.name;
        if (entry.isDirectory()) {
          if (entry.name.startsWith('.') || entry.name === 'node_modules') return;
          collectFiles(fullPath, relPath);
        } else if (entry.isFile() && entry.name.endsWith('.md')) {
          // Skip meta pages at root level
          if (!relRoot && skipFiles.indexOf(entry.name) >= 0) return;
          try {
            var content = fs.readFileSync(fullPath, 'utf-8');
            var text = self.extractText(content);
            var tokens = self.tokenize(text);

            // Deduplicate tokens per document to avoid inflated DF
            var seenTokens = new Set();
            tokens.forEach(function(token) {
              if (seenTokens.has(token)) return;
              seenTokens.add(token);
              if (!self.index.has(token)) self.index.set(token, []);
              self.index.get(token).push(relPath);
            });

            self.documents.push({
              id: relPath,
              path: fullPath,
              title: self.extractTitle(content) || entry.name.replace('.md', ''),
              content: text,
              tokens: tokens,
            });
          } catch(e) { /* skip unreadable files */ }
        }
      });
    }

    collectFiles(wikiDir);
  }

  /**
   * BM25搜索
   */
  search(query, options = {}) {
    const { topK = 10 } = options;
    const queryTokens = this.tokenize(query);

    // 计算BM25分数
    const scores = new Map();
    const avgDocLength = this.documents.reduce((sum, doc) => sum + doc.tokens.length, 0) / this.documents.length;
    const k1 = 1.2;
    const b = 0.75;

    queryTokens.forEach(token => {
      const postings = this.index.get(token) || [];
      const df = postings.length;
      const idf = Math.log((this.documents.length + 1) / (df + 0.5)); // BM25 IDF (Lucene-smooth: never zero for common terms)

      postings.forEach(docId => {
        const doc = this.documents.find(d => d.id === docId);
        if (!doc) return;

        const tf = doc.tokens.filter(t => t === token).length;
        const score = idf * (tf * (k1 + 1)) / (tf + k1 * (1 - b + b * (doc.tokens.length / avgDocLength)));

        scores.set(docId, (scores.get(docId) || 0) + score);
      });
    });

    // 排序并返回topK
    const results = Array.from(scores.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, topK)
      .map(([docId, score]) => {
        const doc = this.documents.find(d => d.id === docId);
        return {
          id: docId,
          title: doc?.title || docId,
          score,
          snippet: this.getSnippet(doc?.content || '', query),
        };
      });

    return results;
  }

  /**
   * 🔴 分层检索 (Tiered Retrieval — 对标 Obsidian-Wiki tiered approach)
   * Level 1: Index scan (titles + tags + summaries — 最廉价)
   * Level 2: Section grep (## heading 段落匹配 — 中等成本)
   * Level 3: Full BM25 (全文检索 — 最昂贵)
   *
   * 返回: { results, tierUsed, stats }
   */
  tieredSearch(query, wikiDir, options) {
    options = options || {};
    var topK = options.topK || 10;
    var resultThreshold = options.resultThreshold || 3; // Level 1查到≥此数量则停止

    // ===== Level 1: Index Scan (标题/标签/摘要) =====
    var indexResults = this._searchIndex(query, wikiDir, topK);
    if (indexResults.length >= resultThreshold) {
      return {
        results: indexResults.slice(0, topK),
        tierUsed: 1,
        tierName: 'index_scan',
        stats: { level1Count: indexResults.length, cost: 'cheap' }
      };
    }

    // ===== Level 2: Section Grep (段落匹配) =====
    if (options.skipSectionGrep !== true) {
      var sectionResults = this._searchSections(query, wikiDir, topK);
      // 合并Level 1和Level 2结果(去重)
      var seenIds = new Set(indexResults.map(function(r) { return r.id; }));
      var merged = indexResults.slice();
      sectionResults.forEach(function(r) {
        if (!seenIds.has(r.id)) {
          merged.push(r);
          seenIds.add(r.id);
        }
      });

      if (merged.length >= resultThreshold) {
        return {
          results: merged.slice(0, topK),
          tierUsed: 2,
          tierName: 'section_grep',
          stats: { level1Count: indexResults.length, level2Count: sectionResults.length, mergedCount: merged.length, cost: 'medium' }
        };
      }
    }

    // ===== Level 3: Full BM25 Fallback =====
    var bm25Results = this.search(query, { topK: topK });

    // 合并所有三层结果
    var allSeen = new Set(indexResults.map(function(r) { return r.id; }));
    var allMerged = indexResults.slice();
    bm25Results.forEach(function(r) {
      if (!allSeen.has(r.id)) {
        allMerged.push(r);
        allSeen.add(r.id);
      }
    });

    return {
      results: allMerged.slice(0, topK),
      tierUsed: 3,
      tierName: 'full_bm25',
      stats: { level1Count: indexResults.length, level3Count: bm25Results.length, mergedCount: allMerged.length, cost: 'expensive' }
    };
  }

  /**
   * Level 1: 搜索索引页和标题 (廉价)
   * @private
   */
  _searchIndex(query, wikiDir, topK) {
    var results = [];
    var q = query.toLowerCase();
    var qTokens = this.tokenize(query);

    // 读取index.md
    var indexPath = path.join(wikiDir, 'index.md');
    if (fs.existsSync(indexPath)) {
      var indexContent = fs.readFileSync(indexPath, 'utf-8');
      // 检查index.md中每行的标题匹配
      var lines = indexContent.split('\n');
      lines.forEach(function(line) {
        var l = line.toLowerCase();
        // 匹配: [[PageName]] 或 - [[PageName]]: description
        var linkMatch = line.match(/\[\[([^\]|]+)(?:\|[^\]]+)?\]\]/);
        if (linkMatch) {
          var title = linkMatch[1].trim();
          var descMatch = line.match(/: (.+)$/);
          var desc = descMatch ? descMatch[1].trim() : '';
          // 检查标题或描述是否匹配查询
          if (l.indexOf(q) >= 0 || qTokens.some(function(t) { return l.indexOf(t) >= 0; })) {
            results.push({
              id: title.replace(/\s+/g, '-') + '.md',
              title: title,
              score: 0.9,
              snippet: desc || '(来自索引)',
              tier: 1,
            });
          }
        }
      });
    }

    return results.slice(0, topK);
  }

  /**
   * Level 2: 按段落(## section)搜索 (中等成本)
   * @private
   */
  _searchSections(query, wikiDir, topK) {
    var results = [];
    var q = query.toLowerCase();
    var qTokens = this.tokenize(query);

    var scanFiles = function(dir) {
      if (!fs.existsSync(dir)) return;
      var files = fs.readdirSync(dir).filter(function(f) { return f.endsWith('.md'); });
      files.forEach(function(f) {
        var filePath = path.join(dir, f);
        var content = fs.readFileSync(filePath, 'utf-8');
        var title = '';
        var h1Match = content.match(/^#\s+(.+)$/m);
        if (h1Match) title = h1Match[1].trim();

        // 按##分段
        var sections = content.split(/^##\s+/gm);
        sections.forEach(function(section, idx) {
          if (idx === 0) return; // 跳过frontmatter/标题部分
          var sectionLower = section.toLowerCase();
          var matchCount = 0;
          qTokens.forEach(function(t) {
            if (sectionLower.indexOf(t) >= 0) matchCount++;
          });

          if (matchCount >= 1 || sectionLower.indexOf(q) >= 0) {
            var headingMatch = section.match(/^(.+)$/m);
            var heading = headingMatch ? headingMatch[1].trim() : '(段落)';
            results.push({
              id: f,
              path: filePath,
              title: title || f.replace('.md', ''),
              section: heading,
              score: 0.7 + (matchCount * 0.1),
              snippet: section.slice(0, 200).replace(/\n/g, ' '),
              tier: 2,
            });
          }
        });
      });
    };

    ['sources', 'entities', 'concepts', 'comparisons', 'syntheses'].forEach(function(sub) {
      scanFiles(path.join(wikiDir, sub));
    });
    scanFiles(wikiDir);

    // 按score降序
    results.sort(function(a, b) { return b.score - a.score; });
    return results.slice(0, topK);
  }

  /**
   * 提取纯文本
   */
  extractText(content) {
    // 移除frontmatter
    let text = content.replace(/^---\n[\s\S]*?\n---\n/, '');
    // 移除 See Also 交叉引用段（WikiEngine 在所有页面底部添加的全局链接会污染索引）
    text = text.replace(/## See Also[\s\S]*$/i, '');
    // 移除代码块
    text = text.replace(/```[\s\S]*?```/g, '');
    // 移除markdown语法
    text = text.replace(/[#*_`\[\]()>-]/g, ' ');
    // 移除wikilinks（保留链接文本，因为内联wikilink文本是文档内容的一部分）
    text = text.replace(/\[\[([^\]|]+)(?:\|[^\]]+)?\]\]/g, '$1');
    return text.toLowerCase();
  }

  /**
   * 分词
   */
  tokenize(text) {
    // Split on word boundaries: spaces/punctuation for English, bigram + char for CJK
    var cleaned = text.toLowerCase().replace(/[^\w\u4e00-\u9fa5]/g, ' ');
    var words = cleaned.split(/\s+/).filter(function(t) { return t.length > 0; });

    var tokens = [];
    words.forEach(function(w) {
      // Full word as token (works for English and exact CJK phrase match)
      if (w.length > 1) tokens.push(w);
      // For CJK text, generate bigrams + single chars for substring matching
      if (/^[\u4e00-\u9fa5]+$/.test(w)) {
        for (var i = 0; i < w.length - 1; i++) {
          tokens.push(w.slice(i, i + 2)); // bigram
        }
        for (var j = 0; j < w.length; j++) {
          tokens.push(w[j]); // single char
        }
      }
    });
    return tokens;
  }

  /**
   * 提取标题
   */
  extractTitle(content) {
    const match = content.match(/^#\s+(.+)$/m);
    return match ? match[1].trim() : null;
  }

  /**
   * 获取摘要片段
   */
  getSnippet(text, query, maxLength = 200) {
    const lowerText = text.toLowerCase();
    const lowerQuery = query.toLowerCase();

    const pos = lowerText.indexOf(lowerQuery);
    if (pos === -1) {
      return text.slice(0, maxLength) + '...';
    }

    const start = Math.max(0, pos - 50);
    const end = Math.min(text.length, pos + query.length + 150);
    return (start > 0 ? '...' : '') + text.slice(start, end) + (end < text.length ? '...' : '');
  }

  /**
   * 保存索引
   */
  saveIndex(outputPath) {
    const data = {
      documents: this.documents,
      index: Array.from(this.index.entries()),
      builtAt: new Date().toISOString(),
    };
    fs.writeFileSync(outputPath, JSON.stringify(data, null, 2));
  }

  /**
   * 加载索引
   */
  loadIndex(inputPath) {
    if (!fs.existsSync(inputPath)) return false;

    const data = JSON.parse(fs.readFileSync(inputPath, 'utf-8'));
    this.documents = data.documents || [];
    this.index = new Map(data.index || []);
    return true;
  }
}

// 导出
module.exports = {
  ProjectScanner,
  WikiEngine,
  GraphBuilder,
  CrossLinker,
  SearchEngine,
  WikiMaintainer,
  CONFIG,
  ensureDirs,
};
