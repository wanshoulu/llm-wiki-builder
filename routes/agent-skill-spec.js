'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const YAML = require('yaml');

const PROFILE_STANDARD = 'STANDARD';
const PROFILE_HERMES = 'HERMES';
const RULE_VERSION = 'agent-skill-profile:2026-08-27';

const STANDARD_FIELDS = new Set([
  'name', 'description', 'license', 'compatibility', 'metadata', 'allowed-tools',
]);
const HERMES_FIELDS = new Set([
  ...STANDARD_FIELDS,
  'version', 'author', 'platforms', 'required_environment_variables',
  'required_credential_files', 'prerequisites',
]);
const HERMES_PLATFORMS = new Set(['macos', 'linux', 'windows']);

const SECTION_ALIASES = {
  scope: ['scope', 'when to use', 'use cases', '触发条件', '适用范围', '适用场景', '何时使用'],
  prerequisites: ['prerequisites', 'inputs', 'input', '前置条件', '输入', '准备工作'],
  procedure: ['procedure', 'workflow', 'steps', 'instructions', '执行流程', '操作步骤', '处理步骤', '工作流程'],
  verification: ['verification', 'completion', 'output', '完成标准', '验收标准', '验证', '输出要求', '输出'],
  error_handling: ['error handling', 'failure', 'safety', '异常处理', '错误处理', '安全边界', '失败处理'],
};

function normalizeProfile(value) {
  const profile = String(value || PROFILE_STANDARD).trim().toUpperCase();
  if (profile !== PROFILE_STANDARD && profile !== PROFILE_HERMES) {
    const error = new Error('Skill 检查配置只能是 STANDARD 或 HERMES');
    error.code = 'SKILL_PROFILE_INVALID';
    throw error;
  }
  return profile;
}

function finding(code, severity, blocking, message, extra) {
  return Object.assign({ code, severity, blocking, message }, extra || {});
}

function frontmatterRange(markdown) {
  const text = String(markdown || '').replace(/^\uFEFF/, '');
  if (!text.startsWith('---')) return null;
  const opening = text.match(/^---[ \t]*\r?\n/);
  if (!opening) return null;
  const bodyStart = opening[0].length;
  const closingPattern = /(?:^|\r?\n)---[ \t]*(?:\r?\n|$)/g;
  closingPattern.lastIndex = bodyStart;
  const closing = closingPattern.exec(text);
  if (!closing) return null;
  const markerOffset = closing[0].startsWith('\n') || closing[0].startsWith('\r')
    ? closing.index + closing[0].search(/---/)
    : closing.index;
  const end = closing.index + closing[0].length;
  return {
    text,
    yaml: text.slice(bodyStart, markerOffset).replace(/\r?\n$/, ''),
    body: text.slice(end),
  };
}

function parseSkillMarkdown(markdown) {
  const range = frontmatterRange(markdown);
  if (!range) {
    return {
      metadata: null,
      body: '',
      yaml: '',
      errors: ['SKILL.md 必须以完整的 YAML frontmatter 开始，并使用独立的 --- 行闭合。'],
    };
  }
  const document = YAML.parseDocument(range.yaml, {
    prettyErrors: true,
    strict: true,
    uniqueKeys: true,
  });
  const errors = document.errors.map((error) => String(error.message || error));
  if (errors.length) return { metadata: null, body: range.body, yaml: range.yaml, errors };
  let metadata;
  try {
    metadata = document.toJS({ mapAsMap: false });
  } catch (error) {
    errors.push(String(error.message || error));
  }
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) {
    errors.push('YAML frontmatter 必须是字段映射，不能是列表或单一值。');
  }
  return { metadata, body: range.body, yaml: range.yaml, errors };
}

function stableSkillName(title) {
  const normalizedTitle = String(title || '').trim().normalize('NFKC');
  if (!normalizedTitle) return 'untitled-skill';
  const asciiName = normalizedTitle.toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^-|-$/g, '');
  if (asciiName) return asciiName.slice(0, 64).replace(/-$/, '');
  const digest = crypto.createHash('sha256').update(normalizedTitle, 'utf8').digest('hex').slice(0, 12);
  return 'skill-' + digest;
}

function topLevelHeadings(body) {
  return String(body || '').split(/\r?\n/)
    .map((line) => line.match(/^#{2,3}\s+(.+?)\s*$/))
    .filter(Boolean)
    .map((match) => match[1].toLowerCase().replace(/[：:]/g, '').trim());
}

function hasSemanticSection(headings, key) {
  return SECTION_ALIASES[key].some((alias) => headings.some((heading) => heading.includes(alias)));
}

function isScalarString(value) {
  return typeof value === 'string';
}

function resolveReference(root, reference) {
  const clean = decodeURIComponent(reference.split('#')[0]).replace(/\\/g, '/');
  if (!clean) return null;
  if (clean.startsWith('/') || /^[a-zA-Z]:/.test(clean)) return { unsafe: true };
  const resolvedRoot = path.resolve(root);
  const resolved = path.resolve(resolvedRoot, clean);
  if (resolved !== resolvedRoot && !resolved.startsWith(resolvedRoot + path.sep)) return { unsafe: true };
  return { unsafe: false, resolved };
}

function fieldMigrationMessage(field) {
  if (field === 'version') return '头部字段 `version` 不属于 Standard 配置；请移动到 `metadata.version`，或改用 Hermes 导出。';
  if (field === 'author') return '头部字段 `author` 不属于 Standard 配置；请移动到 `metadata.author`，或改用 Hermes 导出。';
  if (field === 'platforms') return '头部字段 `platforms` 不属于 Standard 配置；平台信息应由导出适配器生成，请改用 Hermes 导出。';
  return `头部字段 \`${field}\` 不属于当前 ${PROFILE_STANDARD} 配置，请删除该字段或选择对应的平台导出。`;
}

function validateMetadata(metadata, profile, findings) {
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) return;
  const allowedFields = profile === PROFILE_HERMES ? HERMES_FIELDS : STANDARD_FIELDS;
  Object.keys(metadata).forEach((field) => {
    if (!allowedFields.has(field)) {
      findings.push(finding('SKILL_FIELD_NOT_ALLOWED', 'HIGH', true,
        profile === PROFILE_STANDARD ? fieldMigrationMessage(field) : `头部字段 \`${field}\` 不属于 Hermes 配置。`,
        { field }));
    }
  });

  const name = metadata.name;
  if (!isScalarString(name) || !name.trim()) {
    findings.push(finding('SKILL_NAME_REQUIRED', 'HIGH', true, '头部缺少有效的 `name`。', { field: 'name' }));
  } else if (name.length > 64 || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name)) {
    findings.push(finding('SKILL_NAME_INVALID', 'HIGH', true,
      'Skill 标识必须是 1 至 64 个字符，只能使用小写字母、数字和单连字符。', { field: 'name' }));
  }

  const description = metadata.description;
  if (!isScalarString(description) || !description.trim()) {
    findings.push(finding('SKILL_DESCRIPTION_REQUIRED', 'HIGH', true,
      '头部缺少有效的 `description`，需要说明 Skill 做什么以及什么时候使用。', { field: 'description' }));
  } else {
    if (description.length > 1024) {
      findings.push(finding('SKILL_DESCRIPTION_TOO_LONG', 'HIGH', true,
        '`description` 超过 1024 个字符，请保留用途和触发条件并移除正文细节。', { field: 'description' }));
    }
    if (!/(when|whenever|use (?:this )?skill|用户|当.+时|用于|适用|请求|需要)/i.test(description)) {
      findings.push(finding('SKILL_TRIGGER_CONDITION_MISSING', 'MEDIUM', false,
        '`description` 已说明用途，但没有清楚说明什么时候应加载这个 Skill。', { field: 'description' }));
    }
  }

  if (metadata.compatibility !== undefined) {
    if (!isScalarString(metadata.compatibility) || !metadata.compatibility.trim()) {
      findings.push(finding('SKILL_COMPATIBILITY_INVALID', 'HIGH', true,
        '`compatibility` 如果填写，必须是非空字符串。', { field: 'compatibility' }));
    } else if (metadata.compatibility.length > 500) {
      findings.push(finding('SKILL_COMPATIBILITY_TOO_LONG', 'HIGH', true,
        '`compatibility` 不能超过 500 个字符，请只保留实际运行环境要求。', { field: 'compatibility' }));
    }
  }
  if (metadata['allowed-tools'] !== undefined
      && (!isScalarString(metadata['allowed-tools']) || !metadata['allowed-tools'].trim())) {
    findings.push(finding('SKILL_ALLOWED_TOOLS_INVALID', 'HIGH', true,
      '`allowed-tools` 必须是以空格分隔的工具名称字符串；该字段仍是实验能力。', { field: 'allowed-tools' }));
  }
  if (profile === PROFILE_STANDARD && metadata.metadata !== undefined) {
    if (!metadata.metadata || typeof metadata.metadata !== 'object' || Array.isArray(metadata.metadata)) {
      findings.push(finding('SKILL_METADATA_INVALID', 'HIGH', true,
        'Standard 配置中的 `metadata` 必须是字符串键值映射。', { field: 'metadata' }));
    } else {
      Object.entries(metadata.metadata).forEach(([key, value]) => {
        if (!isScalarString(value)) {
          findings.push(finding('SKILL_METADATA_VALUE_INVALID', 'HIGH', true,
            `Standard 配置中的 \`metadata.${key}\` 必须是字符串。`, { field: `metadata.${key}` }));
        }
      });
    }
  }
  if (profile === PROFILE_HERMES) {
    if (metadata.version !== undefined && (!isScalarString(metadata.version) || !metadata.version.trim())) {
      findings.push(finding('SKILL_HERMES_VERSION_INVALID', 'HIGH', true,
        'Hermes 的 `version` 必须是非空字符串。', { field: 'version' }));
    }
    if (metadata.author !== undefined && (!isScalarString(metadata.author) || !metadata.author.trim())) {
      findings.push(finding('SKILL_HERMES_AUTHOR_INVALID', 'HIGH', true,
        'Hermes 的 `author` 必须是非空字符串。', { field: 'author' }));
    }
    if (metadata.platforms !== undefined) {
      const invalidPlatforms = !Array.isArray(metadata.platforms)
        ? ['not-an-array']
        : metadata.platforms.filter((item) => !HERMES_PLATFORMS.has(item));
      if (invalidPlatforms.length) {
        findings.push(finding('SKILL_HERMES_PLATFORM_INVALID', 'HIGH', true,
          'Hermes 的 `platforms` 只能包含 macos、linux、windows；不限制平台时请省略或留空。',
          { field: 'platforms' }));
      }
    }
    validateHermesRequirementList(metadata.required_environment_variables, 'required_environment_variables', 'name', findings);
    validateHermesRequirementList(metadata.required_credential_files, 'required_credential_files', 'path', findings);
  }
}

function validateHermesRequirementList(value, field, requiredKey, findings) {
  if (value === undefined) return;
  if (!Array.isArray(value)) {
    findings.push(finding('SKILL_HERMES_REQUIREMENT_INVALID', 'HIGH', true,
      `Hermes 的 \`${field}\` 必须是列表。`, { field }));
    return;
  }
  value.forEach((item, index) => {
    const requiredValue = item && typeof item === 'object' && !Array.isArray(item) ? item[requiredKey] : undefined;
    if (!isScalarString(requiredValue) || !requiredValue.trim()) {
      findings.push(finding('SKILL_HERMES_REQUIREMENT_INVALID', 'HIGH', true,
        `Hermes 的 \`${field}[${index}].${requiredKey}\` 必须是非空字符串。`,
        { field: `${field}[${index}].${requiredKey}` }));
    }
  });
}

function validateSkillPackage(skillPackage, options) {
  const source = skillPackage || {};
  const profile = normalizeProfile(options && options.profile);
  const markdown = String(source.markdown || '');
  const parsed = parseSkillMarkdown(markdown);
  const findings = [];
  if (parsed.errors.length) {
    parsed.errors.forEach((message) => findings.push(finding('SKILL_YAML_INVALID', 'HIGH', true,
      `SKILL.md 头部无法解析：${message}`)));
  } else {
    validateMetadata(parsed.metadata, profile, findings);
    const folderName = String(source.folderName || '').trim();
    if (folderName && parsed.metadata.name && parsed.metadata.name !== folderName) {
      findings.push(finding('SKILL_NAME_FOLDER_MISMATCH', 'HIGH', true,
        `Skill 标识 \`${parsed.metadata.name}\` 与目录 \`${folderName}\` 不一致，请统一后再发布。`,
        { field: 'name' }));
    }
  }

  const headings = topLevelHeadings(parsed.body);
  ['scope', 'procedure', 'verification', 'error_handling'].forEach((key) => {
    if (!hasSemanticSection(headings, key)) {
      const labels = { scope: '适用场景', procedure: '执行步骤', verification: '完成标准', error_handling: '异常处理与安全边界' };
      findings.push(finding('SKILL_SECTION_MISSING', 'HIGH', true,
        `正文缺少“${labels[key]}”内容，Agent 无法可靠执行或判断完成。`, { section: key }));
    }
  });
  if (!hasSemanticSection(headings, 'prerequisites')) {
    findings.push(finding('SKILL_PREREQUISITES_MISSING', 'LOW', false,
      '建议补充“输入与前置条件”，让 Agent 在执行前判断材料和依赖是否齐全。'));
  }

  const lineCount = markdown.split(/\r?\n/).length;
  if (lineCount > 500) {
    findings.push(finding('SKILL_BODY_TOO_LONG', 'LOW', false,
      `SKILL.md 当前有 ${lineCount} 行，建议把长规则移入 references/，保持按需加载。`));
  }

  const links = Array.from(markdown.matchAll(/\[[^\]]*\]\(([^)]+)\)/g))
    .map((match) => match[1].trim())
    .filter((value) => value && !/^(?:https?:|mailto:|#)/i.test(value));
  links.forEach((reference) => {
    let target;
    try {
      target = resolveReference(source.root || process.cwd(), reference);
    } catch (error) {
      findings.push(finding('SKILL_REFERENCE_INVALID', 'HIGH', true,
        `引用路径无法解析：${reference}`));
      return;
    }
    if (target && target.unsafe) {
      findings.push(finding('SKILL_REFERENCE_PATH_INVALID', 'HIGH', true,
        `引用路径越出 Skill 包：${reference}`));
    } else if (target && !fs.existsSync(target.resolved)) {
      findings.push(finding('SKILL_REFERENCE_MISSING', 'HIGH', true,
        `引用文件不存在：${reference}`));
    }
  });

  const mentionsRuntimeDependency = /(?:\bMCP\b|\bAPI\b|https?:\/\/|\bcurl\b|\bpython\b|\bnode(?:\.js)?\b|命令行|外部服务|网络访问)/i.test(parsed.body);
  const compatibility = parsed.metadata && parsed.metadata.compatibility;
  if (mentionsRuntimeDependency && (!isScalarString(compatibility) || !compatibility.trim())) {
    findings.push(finding('SKILL_DEPENDENCY_UNDECLARED', 'MEDIUM', false,
      '步骤使用了外部工具、MCP、网络或运行时，但兼容性说明未声明依赖，其他 Agent 无法判断能否运行。'));
  }

  const blockingCount = findings.filter((item) => item.blocking).length;
  return {
    profile,
    rule_version: RULE_VERSION,
    metadata: parsed.metadata,
    findings,
    finding_count: findings.length,
    blocking_count: blockingCount,
    exportable: parsed.errors.length === 0,
    spec_passed: blockingCount === 0,
    runtime_verified: false,
  };
}

function cloneMetadata(value) {
  return value && typeof value === 'object' ? JSON.parse(JSON.stringify(value)) : {};
}

function exportSkillMarkdown(markdown, requestedProfile) {
  const profile = normalizeProfile(requestedProfile);
  const parsed = parseSkillMarkdown(markdown);
  if (parsed.errors.length) {
    const error = new Error('SKILL.md 头部无法解析，不能导出：' + parsed.errors.join('；'));
    error.code = 'SKILL_YAML_INVALID';
    throw error;
  }
  const original = cloneMetadata(parsed.metadata);
  const projected = {};
  if (profile === PROFILE_STANDARD) {
    Object.keys(original).forEach((key) => {
      if (STANDARD_FIELDS.has(key)) projected[key] = original[key];
    });
    const nested = cloneMetadata(projected.metadata);
    if (original.author !== undefined && nested.author === undefined) nested.author = String(original.author);
    if (original.version !== undefined && nested.version === undefined) nested.version = String(original.version);
    if (Object.keys(nested).length) projected.metadata = nested;
  } else {
    Object.keys(original).forEach((key) => {
      if (HERMES_FIELDS.has(key) && key !== 'metadata') projected[key] = original[key];
    });
    const nested = cloneMetadata(original.metadata);
    if (original.version !== undefined || nested.version !== undefined) {
      projected.version = String(original.version || nested.version);
    }
    if (original.author !== undefined || nested.author !== undefined) {
      projected.author = String(original.author || nested.author);
    }
    if (Array.isArray(original.platforms)) projected.platforms = original.platforms;
    delete nested.version;
    delete nested.author;
    if (Object.keys(nested).length) projected.metadata = nested;
  }
  const yaml = YAML.stringify(projected, { lineWidth: 0 }).trimEnd();
  return `---\n${yaml}\n---\n${parsed.body.replace(/^\r?\n/, '')}`;
}

function metadataPaths(metadata) {
  const values = {};
  Object.entries(metadata || {}).forEach(([key, value]) => {
    if (key === 'metadata' && value && typeof value === 'object' && !Array.isArray(value)) {
      Object.entries(value).forEach(([nestedKey, nestedValue]) => { values[`metadata.${nestedKey}`] = nestedValue; });
    } else values[key] = value;
  });
  return values;
}

function sameValue(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function planSkillExport(markdown, requestedProfile) {
  const profile = normalizeProfile(requestedProfile);
  const parsed = parseSkillMarkdown(markdown);
  if (parsed.errors.length) {
    const error = new Error('SKILL.md 头部无法解析，不能生成导出差异：' + parsed.errors.join('；'));
    error.code = 'SKILL_YAML_INVALID';
    throw error;
  }
  const projectedMarkdown = exportSkillMarkdown(markdown, profile);
  const projected = parseSkillMarkdown(projectedMarkdown);
  const before = metadataPaths(parsed.metadata);
  const after = metadataPaths(projected.metadata);
  const changes = [];
  const consumedAfter = new Set();
  const moves = profile === PROFILE_STANDARD
    ? { author: 'metadata.author', version: 'metadata.version' }
    : { 'metadata.author': 'author', 'metadata.version': 'version' };

  Object.entries(before).forEach(([field, value]) => {
    if (Object.prototype.hasOwnProperty.call(after, field) && sameValue(value, after[field])) {
      consumedAfter.add(field);
      changes.push({ kind: 'PRESERVED', from: field, to: field, message: `保留字段 ${field}` });
      return;
    }
    const target = moves[field];
    if (target && Object.prototype.hasOwnProperty.call(after, target) && String(after[target]) === String(value)) {
      consumedAfter.add(target);
      changes.push({ kind: 'MOVED', from: field, to: target, message: `字段 ${field} 将移动到 ${target}` });
      return;
    }
    if (Object.prototype.hasOwnProperty.call(after, field)) {
      consumedAfter.add(field);
      changes.push({ kind: 'REWRITTEN', from: field, to: field, message: `字段 ${field} 的格式将被改写` });
      return;
    }
    changes.push({ kind: 'DROPPED', from: field, to: null, message: `目标平台不接收字段 ${field}，导出包中会删除` });
  });
  Object.keys(after).forEach((field) => {
    if (!consumedAfter.has(field) && !Object.prototype.hasOwnProperty.call(before, field)) {
      changes.push({ kind: 'ADDED', from: null, to: field, message: `导出适配器将增加字段 ${field}` });
    }
  });
  const lossCount = changes.filter((item) => item.kind === 'DROPPED').length;
  return {
    profile,
    markdown: projectedMarkdown,
    changes,
    loss_count: lossCount,
    has_loss: lossCount > 0,
  };
}

/**
 * 自动修复 SKILL.md 中的常见规范性问题
 * 基于 validateSkillPackage 的 findings 进行针对性修复
 * @param {string} markdown - 原始 SKILL.md 内容
 * @returns {{ fixed: boolean, markdown: string, fixes: Array<{code: string, message: string}>, remaining: Array }}
 */
function fixSkillMarkdown(markdown, options) {
  const fixes = [];
  let current = String(markdown || '');
  const range = frontmatterRange(current);

  /* ---- 阶段 1：修复 YAML frontmatter 解析错误 ---- */
  if (range) {
    const document = YAML.parseDocument(range.yaml, { prettyErrors: true, strict: true, uniqueKeys: true });
    if (document.errors.length > 0) {
      // YAML 解析失败，尝试从原始文本中提取 name 和 description
      const lines = range.yaml.split(/\r?\n/);
      let extractedName = '';
      let extractedDesc = '';

      for (const line of lines) {
        const nameMatch = line.match(/^name:\s*(.+)$/);
        if (nameMatch) {
          extractedName = nameMatch[1].trim()
            .replace(/^["']|["']$/g, '')
            .replace(/^["']?:["']?\s*/, ''); // 移除可能的杂散冒号
        }
        const descMatch = line.match(/^description:\s*(.+)$/);
        if (descMatch) {
          let raw = descMatch[1].trim();
          // 处理 `":" "实际内容"` 或 `":" '实际内容'` 这种杂散冒号引号模式
          raw = raw.replace(/^["']?\s*:\s*["']?\s*/, '');
          // 如果剩余文本以引号开头，提取引号内的内容
          if (raw.startsWith('"')) {
            // 找到配对的结束引号（处理转义引号）
            let endIdx = -1;
            for (let j = 1; j < raw.length; j++) {
              if (raw[j] === '"' && raw[j - 1] !== '\\') { endIdx = j; break; }
            }
            if (endIdx > 0) {
              extractedDesc = raw.slice(1, endIdx);
            } else {
              extractedDesc = raw.replace(/^"/, '');
            }
          } else if (raw.startsWith("'")) {
            const endIdx = raw.lastIndexOf("'");
            if (endIdx > 0) {
              extractedDesc = raw.slice(1, endIdx);
            } else {
              extractedDesc = raw.replace(/^'/, '');
            }
          } else {
            extractedDesc = raw.split(/\s+#/)[0].trim();
          }
        }
      }

      if (extractedName || extractedDesc) {
        // 重建干净的 YAML frontmatter
        const yamlLines = [];
        // 保留非 name/description 的字段（尝试解析成功的字段）
        if (extractedName) yamlLines.push(`name: "${extractedName.replace(/"/g, '\\"')}"`);
        if (extractedDesc) yamlLines.push(`description: "${extractedDesc.replace(/"/g, '\\"')}"`);
        const fixedYaml = yamlLines.join('\n');
        current = `---\n${fixedYaml}\n---\n${range.body.replace(/^\r?\n/, '')}`;
        fixes.push({
          code: 'SKILL_YAML_INVALID',
          message: '修复了 YAML frontmatter 格式错误（description 字段多余的冒号和引号已清除）',
        });
      }
    }
  }

  /* ---- 阶段 2：重新解析并修复字段级问题 ---- */
  const reparsed = parseSkillMarkdown(current);
  if (reparsed.errors.length === 0 && reparsed.metadata) {
    // 修复 name 格式
    if (reparsed.metadata.name) {
      const name = String(reparsed.metadata.name);
      if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name) || name.length > 64) {
        const fixedName = stableSkillName(name);
        if (fixedName !== name) {
          const yaml = YAML.stringify(
            Object.assign({}, reparsed.metadata, { name: fixedName }),
            { lineWidth: 0 }
          ).trimEnd();
          current = `---\n${yaml}\n---\n${reparsed.body.replace(/^\r?\n/, '')}`;
          fixes.push({
            code: 'SKILL_NAME_INVALID',
            message: `修复了 name 格式：${name} → ${fixedName}`,
          });
        }
      }
    }

    // 修复 description 缺少触发关键词
    if (reparsed.metadata.description) {
      const desc = String(reparsed.metadata.description);
      if (!/(when|whenever|use (?:this )?skill|用户|当.+时|用于|适用|请求|需要)/i.test(desc)) {
        const enhancedDesc = desc.replace(/[。.]?\s*$/, '') + '。当用户需要相关功能时触发加载。';
        const reparsed2 = parseSkillMarkdown(current);
        if (reparsed2.errors.length === 0 && reparsed2.metadata) {
          const yaml = YAML.stringify(
            Object.assign({}, reparsed2.metadata, { description: enhancedDesc }),
            { lineWidth: 0 }
          ).trimEnd();
          current = `---\n${yaml}\n---\n${reparsed2.body.replace(/^\r?\n/, '')}`;
          fixes.push({
            code: 'SKILL_TRIGGER_CONDITION_MISSING',
            message: '在 description 末尾补充了触发条件关键词',
          });
        }
      }
    }
  }

  /* ---- 阶段 3：补充缺失的必选章节 ---- */
  const finalParsed = parseSkillMarkdown(current);
  if (finalParsed.errors.length === 0) {
    const headings = topLevelHeadings(finalParsed.body);
    const sectionLabels = {
      scope: '适用场景与触发条件',
      prerequisites: '输入与前置条件',
      procedure: '执行流程',
      verification: '完成标准',
      error_handling: '异常处理与安全边界',
    };
    const sectionPlaceholders = {
      scope: '**适用：**\n- （请补充适用场景）\n\n**不适用：**\n- （请补充不适用场景）',
      prerequisites: '**必需输入：**\n- （请补充必需输入）\n\n**权限与工具：**\n- （请补充所需权限和工具）',
      procedure: '1. （请补充执行步骤）\n2. ...\n3. 输出结果',
      verification: '- （请补充完成标准，说明如何确认任务真正完成）',
      error_handling: '- （请补充异常处理规则和安全边界）',
    };

    (options && options.includePlaceholders === false ? [] : ['scope', 'procedure', 'verification', 'error_handling']).forEach((key) => {
      if (!hasSemanticSection(headings, key)) {
        current = current.replace(/\s*$/, '') + `\n\n## ${sectionLabels[key]}\n\n${sectionPlaceholders[key]}\n`;
        fixes.push({
          code: 'SKILL_SECTION_MISSING',
          message: `添加了缺失的"${sectionLabels[key]}"章节占位`,
        });
      }
    });
  }

  /* ---- 阶段 4：验证修复结果，收集剩余问题 ---- */
  const validation = validateSkillPackage({ markdown: current }, { profile: PROFILE_STANDARD });
  const remaining = validation.findings.filter((f) => f.blocking);

  return {
    fixed: fixes.length > 0,
    markdown: current,
    fixes,
    remaining: validation.findings,
    spec_passed: validation.spec_passed,
  };
}

module.exports = {
  PROFILE_STANDARD,
  PROFILE_HERMES,
  RULE_VERSION,
  parseSkillMarkdown,
  validateSkillPackage,
  exportSkillMarkdown,
  planSkillExport,
  stableSkillName,
  fixSkillMarkdown,
};
