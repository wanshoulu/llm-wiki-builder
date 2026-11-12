'use strict';

(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.X6GraphTemplateValidator = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  const FIELD_TYPES = new Set(['string', 'multiline', 'number', 'boolean', 'date', 'enum', 'multi_enum', 'tags', 'url', 'scenes_array']);
  const FIELD_KEYS = new Set(['field_id', 'key', 'label', 'data_type', 'type', 'required', 'default', 'options', 'constraints', 'semantics', 'status', 'order', 'description', 'item_schema']);
  const CONSTRAINT_KEYS = new Set(['unique', 'pattern', 'min', 'max']);
  const SEMANTIC_KEYS = new Set(['primary_label', 'searchable', 'filterable', 'sensitive']);

  function isObject(value) { return Boolean(value) && typeof value === 'object' && !Array.isArray(value); }
  function has(object, key) { return Object.prototype.hasOwnProperty.call(object, key); }
  function text(value) { return typeof value === 'string' && value.trim() !== ''; }
  function result() { return { valid: true, errors: [], warnings: [] }; }
  function add(report, code, message, path) { report.errors.push({ code: code, message: message, path: path }); report.valid = false; }
  function warn(report, code, message, path) { report.warnings.push({ code: code, message: message, path: path }); }
  function strictDate(value) {
    if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
    const parts = value.split('-').map(Number);
    const date = new Date(Date.UTC(parts[0], parts[1] - 1, parts[2]));
    return date.getUTCFullYear() === parts[0] && date.getUTCMonth() === parts[1] - 1 && date.getUTCDate() === parts[2];
  }
  function requireText(report, object, key, code, path) {
    if (!isObject(object) || !text(object[key])) add(report, code, key + ' 为必填项', path);
  }
  function isMissing(value) { return value === undefined || value === null || value === ''; }
  function isMeaningful(value) { return !isMissing(value) && (!Array.isArray(value) || value.length > 0); }
  function isFilled(value) { return typeof value === 'string' ? text(value) : isMeaningful(value); }
  function isDense(array) {
    if (!Array.isArray(array)) return false;
    for (let index = 0; index < array.length; index += 1) if (!has(array, index)) return false;
    return true;
  }
  function fieldType(field) { return has(field, 'data_type') ? field.data_type : field.type; }
  function fieldIdentity(kind, typeId, field, index) {
    return text(field.field_id) ? field.field_id : 'legacy:' + kind + ':' + typeId + ':' + (text(field.key) ? field.key : index);
  }
  function pattern(field) {
    if (!isObject(field.constraints) || field.constraints.pattern === null || field.constraints.pattern === undefined || field.constraints.pattern === '') return null;
    try { return new RegExp(field.constraints.pattern); } catch (error) { return false; }
  }
  function validUrl(value) {
    if (typeof value !== 'string' || value.trim() === '' || value.trim() !== value) return false;
    try {
      const parsed = new URL(value);
      return parsed.protocol === 'http:' || parsed.protocol === 'https:';
    } catch (error) { return false; }
  }
  function validArrayForType(field, value, dataType) {
    if (!isDense(value)) return false;
    if (dataType === 'tags') return value.every(function (item) { return text(item); });
    return value.every(function (item) { return text(item) && Array.isArray(field.options) && field.options.includes(item); });
  }
  function rawValueValid(field, value) {
    const dataType = fieldType(field);
    if (isMissing(value)) return true;
    if (dataType === 'string' || dataType === 'multiline') {
      if (typeof value !== 'string') return false;
      const expression = pattern(field);
      return expression === null || (expression !== false && expression.test(value));
    }
    if (dataType === 'number') {
      if (typeof value !== 'number' || !Number.isFinite(value)) return false;
      const constraints = isObject(field.constraints) ? field.constraints : {};
      return !(Number.isFinite(constraints.min) && value < constraints.min) && !(Number.isFinite(constraints.max) && value > constraints.max);
    }
    if (dataType === 'boolean') return typeof value === 'boolean';
    if (dataType === 'date') return strictDate(value);
    if (dataType === 'enum') return Array.isArray(field.options) && field.options.includes(value);
    if (dataType === 'multi_enum' || dataType === 'tags') return validArrayForType(field, value, dataType);
    if (dataType === 'scenes_array') return typeof value === 'string' || Array.isArray(value);
    if (dataType === 'url') return validUrl(value);
    return false;
  }

  function validateOptions(report, field, dataType, path) {
    if (has(field, 'options') && (!Array.isArray(field.options) || !isDense(field.options))) {
      add(report, dataType === 'enum' || dataType === 'multi_enum' ? 'ENUM_OPTIONS_INVALID' : 'FIELD_OPTIONS_INVALID', '字段 options 必须是非稀疏数组', path + '.options');
      return;
    }
    if (dataType !== 'enum' && dataType !== 'multi_enum') return;
    if (!Array.isArray(field.options) || field.options.length === 0 || !isDense(field.options)) {
      add(report, 'ENUM_OPTIONS_INVALID', '枚举字段必须包含非空 options', path + '.options');
      return;
    }
    const seen = new Set();
    for (let index = 0; index < field.options.length; index += 1) {
      const option = field.options[index];
      if (!text(option) || seen.has(option)) add(report, 'ENUM_OPTIONS_INVALID', '枚举选项必须是非空且不重复的字符串', path + '.options[' + index + ']');
      else seen.add(option);
    }
  }

  function validateConstraints(report, field, path) {
    if (!has(field, 'constraints')) return;
    if (!isObject(field.constraints)) { add(report, 'FIELD_CONSTRAINTS_INVALID', 'constraints 必须是对象', path + '.constraints'); return; }
    Object.keys(field.constraints).forEach(function (key) {
      if (!CONSTRAINT_KEYS.has(key)) add(report, 'FIELD_CONSTRAINTS_INVALID', 'constraints 包含未知属性：' + key, path + '.constraints.' + key);
    });
    if (has(field.constraints, 'unique') && typeof field.constraints.unique !== 'boolean') add(report, 'FIELD_CONSTRAINTS_INVALID', 'unique 必须是布尔值', path + '.constraints.unique');
    ['min', 'max'].forEach(function (key) {
      const value = field.constraints[key];
      if (value !== undefined && value !== null && !Number.isFinite(value)) add(report, 'FIELD_CONSTRAINTS_INVALID', key + ' 必须是有限数字或 null', path + '.constraints.' + key);
    });
    if (Number.isFinite(field.constraints.min) && Number.isFinite(field.constraints.max) && field.constraints.min > field.constraints.max) add(report, 'FIELD_CONSTRAINTS_INVALID', 'min 不能大于 max', path + '.constraints');
    const value = field.constraints.pattern;
    if (value !== undefined && value !== null && typeof value !== 'string') add(report, 'FIELD_CONSTRAINTS_INVALID', 'pattern 必须是字符串或 null', path + '.constraints.pattern');
    else if (typeof value === 'string') {
      try { new RegExp(value); } catch (error) { add(report, 'FIELD_PATTERN_INVALID', 'pattern 不是有效的正则表达式', path + '.constraints.pattern'); }
    }
  }

  function validateSemantics(report, field, path) {
    if (!has(field, 'semantics')) return;
    if (!isObject(field.semantics)) { add(report, 'FIELD_SEMANTICS_INVALID', 'semantics 必须是对象', path + '.semantics'); return; }
    Object.keys(field.semantics).forEach(function (key) {
      if (!SEMANTIC_KEYS.has(key)) add(report, 'FIELD_SEMANTICS_INVALID', 'semantics 包含未知属性：' + key, path + '.semantics.' + key);
    });
    SEMANTIC_KEYS.forEach(function (key) {
      if (has(field.semantics, key) && typeof field.semantics[key] !== 'boolean') add(report, 'FIELD_SEMANTICS_INVALID', key + ' 必须是布尔值', path + '.semantics.' + key);
    });
  }

  function validateFields(report, fields, path) {
    if (!Array.isArray(fields)) { add(report, 'FIELDS_INVALID', 'fields 必须是数组', path); return; }
    const keys = new Set(); const ids = new Set(); let primaryLabels = 0;
    for (let index = 0; index < fields.length; index += 1) {
      const fieldPath = path + '[' + index + ']';
      if (!has(fields, index) || !isObject(fields[index])) { add(report, 'FIELD_INVALID', '字段必须是对象且数组不能有空洞', fieldPath); continue; }
      const field = fields[index];
      Object.keys(field).forEach(function (key) {
        if (!FIELD_KEYS.has(key)) add(report, 'FIELD_SCHEMA_PROPERTY_UNKNOWN', '字段定义包含未知属性：' + key, fieldPath + '.' + key);
      });
      if (!text(field.key)) add(report, 'FIELD_KEY_REQUIRED', '字段 key 为必填项', fieldPath + '.key');
      else if (keys.has(field.key)) add(report, 'FIELD_KEY_DUPLICATE', '字段 key 重复：' + field.key, fieldPath + '.key');
      else keys.add(field.key);
      requireText(report, field, 'label', 'FIELD_LABEL_REQUIRED', fieldPath + '.label');
      const modern = has(field, 'data_type');
      if (modern && !text(field.field_id)) add(report, 'FIELD_ID_REQUIRED', '新字段 field_id 为必填项', fieldPath + '.field_id');
      else if (text(field.field_id)) {
        if (ids.has(field.field_id)) add(report, 'FIELD_ID_DUPLICATE', '字段 field_id 重复：' + field.field_id, fieldPath + '.field_id');
        else ids.add(field.field_id);
      }
      if (modern && has(field, 'type') && field.data_type !== field.type) add(report, 'FIELD_DATA_TYPE_CONFLICT', 'data_type 与兼容 type 不一致', fieldPath + '.data_type');
      const dataType = fieldType(field);
      if (!FIELD_TYPES.has(dataType)) add(report, 'FIELD_TYPE_INVALID', '字段类型无效', fieldPath + (modern ? '.data_type' : '.type'));
      if (typeof field.required !== 'boolean') add(report, 'FIELD_REQUIRED_INVALID', 'required 必须是布尔值', fieldPath + '.required');
      if (!has(field, 'default')) add(report, 'FIELD_DEFAULT_REQUIRED', 'default 为必填项', fieldPath + '.default');
      validateOptions(report, field, dataType, fieldPath);
      validateConstraints(report, field, fieldPath);
      validateSemantics(report, field, fieldPath);
      if (has(field, 'default') && !isMissing(field.default) && !rawValueValid(field, field.default)) add(report, 'FIELD_DEFAULT_INVALID', '字段默认值不符合类型或约束', fieldPath + '.default');
      if (has(field, 'status') && field.status !== 'active' && field.status !== 'archived') add(report, 'FIELD_STATUS_INVALID', 'status 必须是 active 或 archived', fieldPath + '.status');
      if (has(field, 'order') && !Number.isFinite(field.order)) add(report, 'FIELD_ORDER_INVALID', 'order 必须是有限数字', fieldPath + '.order');
      if (field.status !== 'archived' && isObject(field.semantics) && field.semantics.primary_label === true) primaryLabels += 1;
    }
    if (primaryLabels > 1) add(report, 'PRIMARY_LABEL_DUPLICATE', '同一元素类型最多一个主标签字段', path);
  }

  function typeMaps(template) {
    const nodes = new Map(); const edges = new Map();
    const nodeTypes = Array.isArray(template && template.node_types) ? template.node_types : [];
    const edgeTypes = Array.isArray(template && template.edge_types) ? template.edge_types : [];
    for (let index = 0; index < nodeTypes.length; index += 1) if (has(nodeTypes, index) && isObject(nodeTypes[index]) && text(nodeTypes[index].type)) nodes.set(nodeTypes[index].type, nodeTypes[index]);
    for (let index = 0; index < edgeTypes.length; index += 1) if (has(edgeTypes, index) && isObject(edgeTypes[index]) && text(edgeTypes[index].type)) edges.set(edgeTypes[index].type, edgeTypes[index]);
    return { nodes: nodes, edges: edges };
  }

  function validateValue(report, field, value, path) {
    if (isMissing(value)) {
      if (field.status !== 'archived' && field.required) add(report, 'FIELD_REQUIRED', '必填字段缺失：' + field.key, path);
      return false;
    }
    const dataType = fieldType(field);
    if (dataType === 'string' || dataType === 'multiline') {
      if (typeof value !== 'string') { add(report, 'FIELD_TYPE_INVALID', '字段值类型无效：' + field.key, path); return false; }
      const expression = pattern(field);
      if (expression === false || (expression && !expression.test(value))) { add(report, 'FIELD_PATTERN_INVALID', '字段值不符合格式：' + field.key, path); return false; }
      return true;
    }
    if (dataType === 'number') {
      if (typeof value !== 'number' || !Number.isFinite(value)) { add(report, 'FIELD_TYPE_INVALID', '字段值类型无效：' + field.key, path); return false; }
      const constraints = isObject(field.constraints) ? field.constraints : {};
      if ((Number.isFinite(constraints.min) && value < constraints.min) || (Number.isFinite(constraints.max) && value > constraints.max)) { add(report, 'FIELD_RANGE_INVALID', '字段值超出范围：' + field.key, path); return false; }
      return true;
    }
    if (dataType === 'boolean') {
      if (typeof value !== 'boolean') { add(report, 'FIELD_TYPE_INVALID', '字段值类型无效：' + field.key, path); return false; }
      return true;
    }
    if (dataType === 'date') {
      if (!strictDate(value)) { add(report, 'FIELD_TYPE_INVALID', '字段值类型无效：' + field.key, path); return false; }
      return true;
    }
    if (dataType === 'enum') {
      if (!Array.isArray(field.options) || !field.options.includes(value)) { add(report, 'ENUM_VALUE_INVALID', '枚举字段值无效：' + field.key, path); return false; }
      return true;
    }
    if (dataType === 'multi_enum' || dataType === 'tags') {
      if (!validArrayForType(field, value, dataType)) { add(report, 'FIELD_ARRAY_INVALID', '数组字段值无效：' + field.key, path); return false; }
      return true;
    }
    if (dataType === 'scenes_array') {
      // scenes 为 V4.1 场景数组：存为 JSON 字符串（v4-graph-validator.parseScenes 解析）；default 为数组。结构校验由 v4-graph-validator 负责
      if (typeof value !== 'string' && !Array.isArray(value)) { add(report, 'FIELD_TYPE_INVALID', '字段值类型无效：' + field.key, path); return false; }
      return true;
    }
    if (dataType === 'url') {
      if (!validUrl(value)) { add(report, 'FIELD_URL_INVALID', 'URL 字段值无效：' + field.key, path); return false; }
      return true;
    }
    add(report, 'FIELD_TYPE_INVALID', '字段值类型无效：' + field.key, path);
    return false;
  }

  function canonicalValue(value) {
    if (Array.isArray(value)) return 'array:' + JSON.stringify(value);
    return typeof value + ':' + String(value);
  }
  function primaryField(definition) {
    const fields = Array.isArray(definition.fields) ? definition.fields : [];
    let hasSemantics = false;
    for (let index = 0; index < fields.length; index += 1) {
      if (!has(fields, index) || !isObject(fields[index]) || fields[index].status === 'archived') continue;
      if (has(fields[index], 'semantics')) hasSemantics = true;
      if (isObject(fields[index].semantics) && fields[index].semantics.primary_label === true) return fields[index];
    }
    if (hasSemantics) return null;
    for (let index = 0; index < fields.length; index += 1) {
      if (has(fields, index) && isObject(fields[index]) && fields[index].status !== 'archived' && (fieldType(fields[index]) === 'string' || fieldType(fields[index]) === 'multiline')) return fields[index];
    }
    return null;
  }

  function validateProperties(report, context, definition, properties, path, uniqueness, sensitiveFields) {
    if (!isObject(properties)) { add(report, context.kind === 'node' ? 'NODE_PROPERTIES_INVALID' : 'EDGE_PROPERTIES_INVALID', (context.kind === 'node' ? '节点' : '关系') + ' properties 必须是对象', path); return; }
    const fields = Array.isArray(definition.fields) ? definition.fields : [];
    const byKey = new Map();
    for (let index = 0; index < fields.length; index += 1) if (has(fields, index) && isObject(fields[index]) && text(fields[index].key)) byKey.set(fields[index].key, { field: fields[index], index: index });
    Object.keys(properties).forEach(function (key) {
      if (!byKey.has(key)) add(report, 'PROPERTY_NOT_IN_SCHEMA', '属性未在 Schema 中声明：' + key, path + '.' + key);
    });
    byKey.forEach(function (entry, key) {
      const field = entry.field; const valuePath = path + '.' + key; const value = properties[key];
      const valid = validateValue(report, field, value, valuePath);
      const identity = fieldIdentity(context.kind, context.type, field, entry.index);
      const scope = context.kind + '\u0000' + context.type + '\u0000' + identity;
      if (valid && !isMissing(value) && isObject(field.constraints) && field.constraints.unique === true) {
        if (!uniqueness.has(scope)) uniqueness.set(scope, new Map());
        const seen = uniqueness.get(scope); const canonical = canonicalValue(value);
        if (seen.has(canonical)) add(report, 'FIELD_UNIQUE_CONFLICT', '字段值违反唯一约束：' + key, valuePath);
        else seen.set(canonical, valuePath);
      }
      if (isMeaningful(value) && isObject(field.semantics) && field.semantics.sensitive === true && !sensitiveFields.has(scope)) {
        sensitiveFields.add(scope);
        warn(report, 'SENSITIVE_FIELD_PRESENT', '图中包含敏感字段值：' + key, valuePath);
      }
    });
    const primary = primaryField(definition);
    if (primary && !primary.required && isMissing(properties[primary.key])) warn(report, 'OPTIONAL_PRIMARY_LABEL_EMPTY', '可选主标签为空：' + primary.key, path + '.' + primary.key);
  }

  function validateConditionalRequirements(report, template, node, path) {
    const rules = isObject(template.metadata) && Array.isArray(template.metadata.conditional_requirements)
      ? template.metadata.conditional_requirements : [];
    if (!isObject(node.properties)) return;
    rules.forEach(function (rule) {
      if (!isObject(rule) || node.type !== rule.node_type || node.properties[rule.when_field] !== rule.when_value) return;
      (Array.isArray(rule.all_of) ? rule.all_of : []).forEach(function (key) {
        if (!isFilled(node.properties[key])) add(report, 'CONDITIONAL_FIELD_REQUIRED', '交付方式 ' + rule.when_value + ' 缺少必填配置：' + key, path + '.properties.' + key);
      });
      if (Array.isArray(rule.any_of) && rule.any_of.length && !rule.any_of.some(function (key) { return isFilled(node.properties[key]); })) {
        add(report, 'CONDITIONAL_ANY_REQUIRED', '交付方式 ' + rule.when_value + ' 至少需要配置：' + rule.any_of.join(' 或 '), path + '.properties');
      }
    });
  }

  function validateGraphAgainstMaps(template, graph, report, basePath) {
    const rules = isObject(template.validation_rules) ? template.validation_rules : {};
    if (!isObject(graph)) { add(report, 'GRAPH_INVALID', '图必须是对象', basePath); return; }
    if (!Array.isArray(graph.nodes)) add(report, 'GRAPH_NODES_INVALID', 'nodes 必须是数组', basePath + '.nodes');
    if (!Array.isArray(graph.edges)) add(report, 'GRAPH_EDGES_INVALID', 'edges 必须是数组', basePath + '.edges');
    if (!Array.isArray(graph.nodes) || !Array.isArray(graph.edges)) return;
    const maps = typeMaps(template); const ids = new Map(); const nodeById = new Map();
    const uniqueness = new Map(); const sensitiveFields = new Set();
    for (let index = 0; index < graph.nodes.length; index += 1) {
      const path = basePath + '.nodes[' + index + ']';
      if (!has(graph.nodes, index) || !isObject(graph.nodes[index])) { add(report, 'NODE_INVALID', '节点必须是对象且数组不能有空洞', path); continue; }
      const node = graph.nodes[index];
      if (!text(node.id)) add(report, 'NODE_ID_REQUIRED', '节点 ID 为必填项', path + '.id');
      else {
        if (rules.unique_node_ids !== false && nodeById.has(node.id)) add(report, 'NODE_ID_DUPLICATE', '节点 ID 重复：' + node.id, path + '.id');
        if (ids.has(node.id)) add(report, 'ELEMENT_ID_DUPLICATE', '元素 ID 重复：' + node.id, path + '.id');
        else ids.set(node.id, { kind: 'node', index: index });
        if (!nodeById.has(node.id)) nodeById.set(node.id, node);
      }
      const definition = maps.nodes.get(node.type);
      if (!definition) { add(report, 'NODE_TYPE_UNKNOWN', '未知节点类型', path + '.type'); continue; }
      validateProperties(report, { kind: 'node', type: node.type }, definition, node.properties, path + '.properties', uniqueness, sensitiveFields);
      validateConditionalRequirements(report, template, node, path);
    }
    if (template.template_id === 'intent-graph') {
      graph.nodes.forEach(function (node, index) {
        if (!isObject(node) || node.type !== 'INTENT' || !isObject(node.properties)) return;
        const answerRef = node.properties.answer_ref;
        if (node.properties.fulfillment_kind === 'answer' && isFilled(answerRef)) {
          const answer = nodeById.get(answerRef);
          if (!answer || answer.type !== 'KNOWLEDGE_ANSWER') add(report, 'FULFILLMENT_REFERENCE_INVALID', '知识答案引用必须指向当前图谱的 KNOWLEDGE_ANSWER 节点', basePath + '.nodes[' + index + '].properties.answer_ref');
          else if (!isFilled(node.properties.answer_text) && (!isObject(answer.properties) || !isFilled(answer.properties.answer_text))) {
            add(report, 'ANSWER_CONTENT_REQUIRED', '引用的知识答案缺少正文，且意图未配置直接回答', basePath + '.nodes[' + index + '].properties.answer_ref');
          } else if (isObject(answer.properties) && answer.properties.content_status === 'mock') {
            warn(report, 'MOCK_ANSWER_CONTENT', '引用的知识答案仍为演示内容', basePath + '.nodes[' + index + '].properties.answer_ref');
          }
        }
        const targetField = { query: 'query_ref', menu: 'menu_ref', skill: 'skill_ref', workflow: 'workflow_ref', agent: 'agent_ref' }[node.properties.fulfillment_kind];
        const targetRef = targetField && node.properties[targetField];
        if (typeof targetRef === 'string' && (/^mock:/.test(targetRef) || /^\/mock\//.test(targetRef))) {
          warn(report, 'MOCK_FULFILLMENT_REFERENCE', '交付目标仍为演示引用，运行前需替换为真实能力', basePath + '.nodes[' + index + '].properties.' + targetField);
        }
        if (Array.isArray(node.properties.required_slot_refs)) node.properties.required_slot_refs.forEach(function (slotId, slotIndex) {
          const slot = nodeById.get(slotId);
          if (!slot || slot.type !== 'SLOT') add(report, 'FULFILLMENT_REFERENCE_INVALID', '必需槽位引用必须指向当前图谱的 SLOT 节点', basePath + '.nodes[' + index + '].properties.required_slot_refs[' + slotIndex + ']');
        });
        const mappingText = node.properties.input_mapping_json;
        if (['query', 'skill', 'workflow', 'agent'].includes(node.properties.fulfillment_kind) && isFilled(mappingText)) {
          let mapping;
          try { mapping = JSON.parse(mappingText); } catch (error) { mapping = null; }
          if (!isObject(mapping) || !Object.keys(mapping).every(function (key) {
            const slot = nodeById.get(mapping[key]);
            return text(key) && text(mapping[key]) && slot && slot.type === 'SLOT';
          })) add(report, 'INPUT_MAPPING_INVALID', '输入参数映射必须是“参数名 → 当前图谱 SLOT 节点 ID”的 JSON 对象', basePath + '.nodes[' + index + '].properties.input_mapping_json');
        }
      });
    }
    for (let index = 0; index < graph.edges.length; index += 1) {
      const path = basePath + '.edges[' + index + ']';
      if (!has(graph.edges, index) || !isObject(graph.edges[index])) { add(report, 'EDGE_INVALID', '关系必须是对象且数组不能有空洞', path); continue; }
      const edge = graph.edges[index];
      if (!text(edge.id)) add(report, 'EDGE_ID_REQUIRED', '关系 ID 为必填项', path + '.id');
      else {
        if (rules.unique_edge_ids !== false && ids.has(edge.id) && ids.get(edge.id).kind === 'edge') add(report, 'EDGE_ID_DUPLICATE', '关系 ID 重复：' + edge.id, path + '.id');
        if (ids.has(edge.id)) add(report, 'ELEMENT_ID_DUPLICATE', '元素 ID 重复：' + edge.id, path + '.id');
        else ids.set(edge.id, { kind: 'edge', index: index });
      }
      const definition = maps.edges.get(edge.type);
      if (!definition) add(report, 'EDGE_TYPE_UNKNOWN', '未知关系类型', path + '.type');
      const hasSource = text(edge.source); const hasTarget = text(edge.target);
      if (!hasSource) add(report, 'GRAPH_IMPORT_INVALID', '关系源节点必须是非空字符串', path + '.source');
      if (!hasTarget) add(report, 'GRAPH_IMPORT_INVALID', '关系目标节点必须是非空字符串', path + '.target');
      const source = hasSource ? nodeById.get(edge.source) : undefined; const target = hasTarget ? nodeById.get(edge.target) : undefined;
      if (rules.no_orphan_edges !== false && hasSource && hasTarget && (!source || !target)) add(report, 'ORPHAN_EDGE', '关系端点不存在', path);
      if (hasSource && hasTarget && edge.source === edge.target && rules.allow_self_loop !== true) add(report, 'SELF_LOOP_NOT_ALLOWED', '不允许自环关系', path);
      if (definition) {
        if (source && !(Array.isArray(definition.source_types) ? definition.source_types : []).includes(source.type)) add(report, 'EDGE_ENDPOINT_TYPE_INVALID', '关系源节点类型不匹配', path + '.source');
        if (target && !(Array.isArray(definition.target_types) ? definition.target_types : []).includes(target.type)) add(report, 'EDGE_ENDPOINT_TYPE_INVALID', '关系目标节点类型不匹配', path + '.target');
        validateProperties(report, { kind: 'edge', type: edge.type }, definition, edge.properties, path + '.properties', uniqueness, sensitiveFields);
      }
    }
    if (graph.template_ref && isObject(graph.template_ref) && (graph.template_ref.template_id !== template.template_id || graph.template_ref.template_version !== template.template_version)) warn(report, 'TEMPLATE_VERSION_MISMATCH', '图文档模板引用与当前模板版本不一致', basePath + '.template_ref');
    const connected = new Set();
    for (let index = 0; index < graph.edges.length; index += 1) if (has(graph.edges, index) && isObject(graph.edges[index])) { connected.add(graph.edges[index].source); connected.add(graph.edges[index].target); }
    for (let index = 0; index < graph.nodes.length; index += 1) if (has(graph.nodes, index) && isObject(graph.nodes[index]) && text(graph.nodes[index].id) && !connected.has(graph.nodes[index].id)) warn(report, 'ISOLATED_NODE', '节点没有任何关系：' + graph.nodes[index].id, basePath + '.nodes[' + index + ']');
  }

  function validateEndpointTypes(report, template, edge, path, key) {
    const code = key === 'source_types' ? 'EDGE_SOURCE_TYPES_INVALID' : 'EDGE_TARGET_TYPES_INVALID';
    const unknownCode = key === 'source_types' ? 'EDGE_SOURCE_TYPE_UNKNOWN' : 'EDGE_TARGET_TYPE_UNKNOWN';
    if (!Array.isArray(edge[key]) || edge[key].length === 0) { add(report, code, key + ' 必须是非空数组', path + '.' + key); return; }
    for (let index = 0; index < edge[key].length; index += 1) {
      const value = has(edge[key], index) ? edge[key][index] : undefined;
      const known = Array.isArray(template.node_types) && template.node_types.some(function (node) { return isObject(node) && node.type === value; });
      if (!text(value) || !known) add(report, unknownCode, '关系端点引用了未知节点类型', path + '.' + key + '[' + index + ']');
    }
  }

  function validateTemplateInternal(template, report) {
    if (!isObject(template)) { add(report, 'TEMPLATE_INVALID', '模板必须是对象', ''); return; }
    requireText(report, template, 'template_id', 'TEMPLATE_ID_REQUIRED', 'template_id');
    requireText(report, template, 'template_version', 'TEMPLATE_VERSION_REQUIRED', 'template_version');
    requireText(report, template, 'name', 'TEMPLATE_NAME_REQUIRED', 'name');
    requireText(report, template, 'description', 'TEMPLATE_DESCRIPTION_REQUIRED', 'description');
    if (template.origin !== 'builtin' && template.origin !== 'custom') add(report, 'TEMPLATE_ORIGIN_INVALID', 'origin 必须是 builtin 或 custom', 'origin');
    if (!has(template, 'parent_template_id') || (template.parent_template_id !== null && !text(template.parent_template_id))) add(report, 'PARENT_TEMPLATE_ID_INVALID', 'parent_template_id 必须是字符串或 null', 'parent_template_id');
    if (!Array.isArray(template.node_types)) add(report, 'NODE_TYPES_INVALID', 'node_types 必须是数组', 'node_types');
    if (!Array.isArray(template.edge_types)) add(report, 'EDGE_TYPES_INVALID', 'edge_types 必须是数组', 'edge_types');
    const typeIds = new Set();
    const nodeTypes = Array.isArray(template.node_types) ? template.node_types : [];
    for (let index = 0; index < nodeTypes.length; index += 1) {
      const path = 'node_types[' + index + ']';
      if (!has(nodeTypes, index) || !isObject(nodeTypes[index])) { add(report, 'NODE_TYPE_INVALID', '节点类型必须是对象且数组不能有空洞', path); continue; }
      const node = nodeTypes[index];
      if (!text(node.type)) add(report, 'TYPE_ID_REQUIRED', '类型 ID 为必填项', path + '.type');
      else if (typeIds.has(node.type)) add(report, 'TYPE_ID_DUPLICATE', '类型 ID 重复：' + node.type, path + '.type');
      else typeIds.add(node.type);
      requireText(report, node, 'label', 'TYPE_LABEL_REQUIRED', path + '.label');
      if (!isObject(node.style) || !text(node.style.color) || !['rect', 'diamond'].includes(node.style.shape)) add(report, 'NODE_STYLE_INVALID', '节点 style 必须包含 color 和 rect/diamond shape', path + '.style');
      validateFields(report, node.fields, path + '.fields');
    }
    const edgeTypes = Array.isArray(template.edge_types) ? template.edge_types : [];
    for (let index = 0; index < edgeTypes.length; index += 1) {
      const path = 'edge_types[' + index + ']';
      if (!has(edgeTypes, index) || !isObject(edgeTypes[index])) { add(report, 'EDGE_TYPE_INVALID', '关系类型必须是对象且数组不能有空洞', path); continue; }
      const edge = edgeTypes[index];
      if (!text(edge.type)) add(report, 'TYPE_ID_REQUIRED', '类型 ID 为必填项', path + '.type');
      else if (typeIds.has(edge.type)) add(report, 'TYPE_ID_DUPLICATE', '类型 ID 重复：' + edge.type, path + '.type');
      else typeIds.add(edge.type);
      requireText(report, edge, 'label', 'TYPE_LABEL_REQUIRED', path + '.label');
      if (!isObject(edge.style) || !text(edge.style.color)) add(report, 'EDGE_STYLE_INVALID', '关系 style 必须包含 color', path + '.style');
      validateEndpointTypes(report, template, edge, path, 'source_types');
      validateEndpointTypes(report, template, edge, path, 'target_types');
      validateFields(report, edge.fields, path + '.fields');
    }
    if (!isObject(template.validation_rules)) add(report, 'VALIDATION_RULES_INVALID', 'validation_rules 必须是对象', 'validation_rules');
    else ['unique_node_ids', 'unique_edge_ids', 'no_orphan_edges', 'allow_self_loop'].forEach(function (key) { if (typeof template.validation_rules[key] !== 'boolean') add(report, 'VALIDATION_RULE_INVALID', key + ' 必须是布尔值', 'validation_rules.' + key); });
    if (!isObject(template.metadata)) add(report, 'METADATA_INVALID', 'metadata 必须是对象', 'metadata');
    else {
      requireText(report, template.metadata, 'created_at', 'METADATA_CREATED_AT_REQUIRED', 'metadata.created_at');
      requireText(report, template.metadata, 'updated_at', 'METADATA_UPDATED_AT_REQUIRED', 'metadata.updated_at');
      if (has(template.metadata, 'conditional_requirements')) {
        const requirements = template.metadata.conditional_requirements;
        if (!Array.isArray(requirements) || !isDense(requirements)) add(report, 'CONDITIONAL_RULES_INVALID', 'conditional_requirements 必须是非稀疏数组', 'metadata.conditional_requirements');
        else requirements.forEach(function (rule, index) {
          const path = 'metadata.conditional_requirements[' + index + ']';
          if (!isObject(rule)) { add(report, 'CONDITIONAL_RULE_INVALID', '条件规则必须是对象', path); return; }
          const definition = nodeTypes.find(function (node) { return node.type === rule.node_type; });
          const fields = definition && Array.isArray(definition.fields) ? definition.fields : [];
          const fieldKeys = new Set(fields.map(function (field) { return field.key; }));
          const whenField = fields.find(function (field) { return field.key === rule.when_field; });
          if (!definition || !whenField || !text(rule.when_value) || (fieldType(whenField) === 'enum' && (!Array.isArray(whenField.options) || !whenField.options.includes(rule.when_value)))) {
            add(report, 'CONDITIONAL_RULE_INVALID', '条件规则的节点类型或触发字段无效', path);
            return;
          }
          const allOf = Array.isArray(rule.all_of) ? rule.all_of : [];
          const anyOf = Array.isArray(rule.any_of) ? rule.any_of : [];
          if ((!allOf.length && !anyOf.length) || !allOf.concat(anyOf).every(function (key) { return text(key) && fieldKeys.has(key); })) {
            add(report, 'CONDITIONAL_RULE_INVALID', '条件规则必须引用已声明的必填字段', path);
          }
        });
      }
    }
    if (!isObject(template.starter_graph)) add(report, 'STARTER_GRAPH_INVALID', 'starter_graph 必须是对象', 'starter_graph');
    else validateGraphAgainstMaps(template, template.starter_graph, report, 'starter_graph');
  }

  function validateTemplate(template) {
    const report = result();
    try { validateTemplateInternal(template, report); } catch (error) { add(report, 'VALIDATION_INPUT_INVALID', '模板包含无法校验的畸形数据', ''); }
    return report;
  }

  function validateGraph(template, graph) {
    const templateReport = validateTemplate(template);
    if (!templateReport.valid) return { valid: false, errors: templateReport.errors, warnings: templateReport.warnings };
    const report = result();
    try { validateGraphAgainstMaps(template, graph, report, 'graph'); } catch (error) { add(report, 'VALIDATION_INPUT_INVALID', '图包含无法校验的畸形数据', 'graph'); }
    return report;
  }

  function assertTemplate(template) {
    const report = validateTemplate(template);
    if (!report.valid) { const error = new Error('模板校验失败'); error.code = 'TEMPLATE_VALIDATION_FAILED'; error.validation = report; throw error; }
    return template;
  }

  function assertGraph(template, graph) {
    const report = validateGraph(template, graph);
    if (!report.valid) { const error = new Error('图谱校验失败'); error.code = 'GRAPH_VALIDATION_FAILED'; error.validation = report; throw error; }
    return graph;
  }

  function describeField(kind, typeId, field, index) {
    return {
      field_id: fieldIdentity(kind, typeId, field, index),
      key: field.key,
      label: field.label,
      data_type: fieldType(field),
    };
  }

  function describeTypes(definitions, kind, aggregate) {
    return definitions.map(function (definition) {
      const descriptor = {
        type: definition.type, label: definition.label, element_kind: kind,
        primary_label: null, searchable: [], filterable: [], unique: [], sensitive: [],
      };
      definition.fields.forEach(function (field, index) {
        if (field.status === 'archived') return;
        const summary = describeField(kind, definition.type, field, index);
        aggregate.active_field_count += 1;
        if (isObject(field.semantics) && field.semantics.primary_label === true) descriptor.primary_label = summary;
        if (isObject(field.semantics) && field.semantics.searchable === true) { descriptor.searchable.push(summary); aggregate.searchable_count += 1; }
        if (isObject(field.semantics) && field.semantics.filterable === true) { descriptor.filterable.push(summary); aggregate.filterable_count += 1; }
        if (isObject(field.constraints) && field.constraints.unique === true) { descriptor.unique.push(summary); aggregate.unique_count += 1; }
        if (isObject(field.semantics) && field.semantics.sensitive === true) { descriptor.sensitive.push(summary); aggregate.sensitive_count += 1; }
      });
      if (descriptor.primary_label) aggregate.primary_label_count += 1;
      return descriptor;
    });
  }

  function describeConsumption(template) {
    const validation = validateTemplate(template);
    if (!validation.valid) {
      const error = new Error('模板校验失败');
      error.code = 'TEMPLATE_VALIDATION_FAILED'; error.validation = validation;
      throw error;
    }
    const aggregate = {
      type_count: template.node_types.length + template.edge_types.length,
      active_field_count: 0, primary_label_count: 0, searchable_count: 0,
      filterable_count: 0, unique_count: 0, sensitive_count: 0,
    };
    return {
      node_types: describeTypes(template.node_types, 'node', aggregate),
      edge_types: describeTypes(template.edge_types, 'edge', aggregate),
      aggregate: aggregate,
    };
  }

  return { validateTemplate: validateTemplate, validateGraph: validateGraph, assertTemplate: assertTemplate, assertGraph: assertGraph, describeConsumption: describeConsumption };
});
