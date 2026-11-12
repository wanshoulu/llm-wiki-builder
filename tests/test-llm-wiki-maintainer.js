'use strict';

/**
 * 测试Wiki维护引擎的新功能
 */

const path = require('path');
const fs = require('fs');
const { WikiEngine, WikiMaintainer, SearchEngine, GraphBuilder } = require('../tools/llm-wiki-engine');

const WIKI_DIR = path.join(__dirname, '..', 'wiki');
const TEST_WIKI_DIR = path.join(__dirname, 'test-wiki-temp');

// 准备测试环境
function setupTestWiki() {
  if (!fs.existsSync(TEST_WIKI_DIR)) {
    fs.mkdirSync(TEST_WIKI_DIR, { recursive: true });
  }

  // 复制几个wiki页面用于测试
  const testPages = [
    'adam.md',
    'sgd.md',
    'momentum.md',
    'rmsprop.md',
  ];

  testPages.forEach(pageName => {
    const src = path.join(WIKI_DIR, pageName);
    const dst = path.join(TEST_WIKI_DIR, pageName);
    if (fs.existsSync(src)) {
      fs.copyFileSync(src, dst);
    }
  });

  // 创建index.md
  let indexContent = `# 测试Wiki Index\n\n生成时间: ${new Date().toISOString()}\n\n## 页面列表\n\n`;
  testPages.forEach(pageName => {
    const pageId = pageName.replace('.md', '');
    indexContent += `- [[${pageId}]]\n`;
  });
  fs.writeFileSync(path.join(TEST_WIKI_DIR, 'index.md'), indexContent);
}

// 清理测试环境
function cleanupTestWiki() {
  if (fs.existsSync(TEST_WIKI_DIR)) {
    fs.rmSync(TEST_WIKI_DIR, { recursive: true, force: true });
  }
}

// 测试1: 查询并归档
async function testQueryAndArchive() {
  console.log('\n=== 测试1: 查询并归档 ===');

  const wikiEngine = new WikiEngine();
  const maintainer = new WikiMaintainer(wikiEngine);

  const query = 'Adam优化器和SGD有什么区别?';

  try {
    const result = await maintainer.queryAndArchive(query, TEST_WIKI_DIR, {
      llmApiKey: null, // 使用基础模式测试
    });

    console.log('查询:', query);
    console.log('归档结果:', result.archived ? '已归档' : '未归档');
    console.log('质量评分:', result.archiveScore);
    console.log('相关页面数:', result.relevantPages.length);

    if (result.archived) {
      console.log('归档ID:', result.archiveId);
      const archivePath = path.join(TEST_WIKI_DIR, 'explorations', `${result.archiveId}.md`);
      console.log('归档文件存在:', fs.existsSync(archivePath));

      if (fs.existsSync(archivePath)) {
        const archiveContent = fs.readFileSync(archivePath, 'utf-8');
        console.log('归档内容长度:', archiveContent.length);
        console.log('包含交叉引用:', archiveContent.includes('[['));
      }
    }

    console.log('✅ 测试1通过');
    return true;
  } catch (e) {
    console.error('❌ 测试1失败:', e.message);
    return false;
  }
}

// 测试2: Wiki健康检查
function testLint() {
  console.log('\n=== 测试2: Wiki健康检查 ===');

  const wikiEngine = new WikiEngine();
  const maintainer = new WikiMaintainer(wikiEngine);

  try {
    const issues = maintainer.lint(TEST_WIKI_DIR, {
      checkOrphans: true,
      checkContradictions: true,
      checkMissingRefs: true,
    });

    console.log('总页面数:', issues.summary.totalPages);
    console.log('孤儿页面数:', issues.summary.orphans);
    console.log('平均度数:', issues.summary.avgDegree.toFixed(2));
    console.log('矛盾检测:', issues.contradictions.length);
    console.log('缺失引用:', issues.missingReferences.length);
    console.log('过期页面:', issues.stalePages.length);

    if (issues.orphanPages.length > 0) {
      console.log('\n孤儿页面示例:');
      issues.orphanPages.slice(0, 3).forEach(p => {
        console.log(`  - ${p.id}: ${p.suggestion}`);
      });
    }

    console.log('✅ 测试2通过');
    return true;
  } catch (e) {
    console.error('❌ 测试2失败:', e.message);
    return false;
  }
}

// 测试3: 搜索引擎
function testSearchEngine() {
  console.log('\n=== 测试3: 搜索引擎 ===');

  const searchEngine = new SearchEngine();

  try {
    searchEngine.buildIndex(TEST_WIKI_DIR);
    console.log('索引文档数:', searchEngine.documents.length);

    const query = 'adam优化器';
    const results = searchEngine.search(query, { topK: 3 });

    console.log('搜索查询:', query);
    console.log('结果数:', results.length);

    results.forEach(r => {
      console.log(`  - ${r.title}: 分数=${r.score.toFixed(2)}`);
      console.log(`    摘要: ${r.snippet.slice(0, 100)}...`);
    });

    console.log('✅ 测试3通过');
    return true;
  } catch (e) {
    console.error('❌ 测试3失败:', e.message);
    return false;
  }
}

// 测试4: 知识图谱构建
function testGraphBuilder() {
  console.log('\n=== 测试4: 知识图谱构建 ===');

  const graphBuilder = new GraphBuilder();

  try {
    const graph = graphBuilder.buildFromWiki(TEST_WIKI_DIR);

    console.log('节点数:', graph.nodes.length);
    console.log('边数:', graph.edges.length);
    console.log('孤儿节点:', graph.stats.orphanNodes);
    console.log('平均度数:', graph.stats.avgDegree.toFixed(2));

    if (graph.nodes.length > 0) {
      console.log('\n节点示例:');
      graph.nodes.slice(0, 3).forEach(n => {
        console.log(`  - ${n.id}: ${n.title}`);
        console.log(`    入度=${n.inDegree}, 出度=${n.outDegree}, 层级=${n.level}`);
      });
    }

    if (graph.edges.length > 0) {
      console.log('\n边示例:');
      graph.edges.slice(0, 3).forEach(e => {
        console.log(`  - ${e.source} -> ${e.target}`);
      });
    }

    console.log('✅ 测试4通过');
    return true;
  } catch (e) {
    console.error('❌ 测试4失败:', e.message);
    return false;
  }
}

// 测试5: 交叉引用添加
function testAddCrossReference() {
  console.log('\n=== 测试5: 交叉引用添加 ===');

  const wikiEngine = new WikiEngine();
  const maintainer = new WikiMaintainer(wikiEngine);

  try {
    const adamPath = path.join(TEST_WIKI_DIR, 'adam.md');
    const originalContent = fs.readFileSync(adamPath, 'utf-8');

    maintainer.addCrossReference(adamPath, 'test-reference');

    const updatedContent = fs.readFileSync(adamPath, 'utf-8');
    console.log('原始内容长度:', originalContent.length);
    console.log('更新后内容长度:', updatedContent.length);
    console.log('添加了引用:', updatedContent.includes('[[test-reference]]'));

    // 验证不会重复添加
    maintainer.addCrossReference(adamPath, 'test-reference');
    const finalContent = fs.readFileSync(adamPath, 'utf-8');
    console.log('重复添加检查:', finalContent.length === updatedContent.length);

    console.log('✅ 测试5通过');
    return true;
  } catch (e) {
    console.error('❌ 测试5失败:', e.message);
    return false;
  }
}

// 主测试流程
async function runTests() {
  console.log('开始测试Wiki维护引擎...\n');

  setupTestWiki();

  const results = [];

  try {
    results.push(await testQueryAndArchive());
    results.push(testLint());
    results.push(testSearchEngine());
    results.push(testGraphBuilder());
    results.push(testAddCrossReference());
  } finally {
    cleanupTestWiki();
  }

  const passed = results.filter(r => r).length;
  const total = results.length;

  console.log('\n=== 测试总结 ===');
  console.log(`通过: ${passed}/${total}`);
  console.log(`失败: ${total - passed}/${total}`);

  if (passed === total) {
    console.log('\n🎉 所有测试通过!');
  } else {
    console.log('\n⚠️  有测试失败,请检查错误信息');
  }
}

// 执行测试
runTests().catch(e => {
  console.error('测试执行失败:', e);
  cleanupTestWiki();
  process.exit(1);
});