'use strict';

(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else if (root) root.KnowledgeBuilderDataImport = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  function fail(code, message) {
    const error = new Error(message);
    error.code = code;
    throw error;
  }

  function isPlainObject(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
    const prototype = Object.getPrototypeOf(value);
    return prototype === Object.prototype || prototype === null;
  }

  function setOwn(target, key, value) {
    Object.defineProperty(target, key, {
      value, enumerable: true, configurable: true, writable: true,
    });
  }

  function copy(value) {
    if (Array.isArray(value)) return value.map(copy);
    if (isPlainObject(value)) {
      const result = {};
      Object.keys(value).forEach(function (key) {
        setOwn(result, key, copy(value[key]));
      });
      return result;
    }
    if (value instanceof Date) return new Date(value.getTime());
    return value;
  }

  function parseCsv(text) {
    if (typeof text !== 'string') fail('DATA_PARSE_INVALID', 'CSV 内容必须是文本');
    const source = text.charCodeAt(0) === 0xFEFF ? text.slice(1) : text;
    const records = [];
    let row = [];
    let cell = '';
    let quoted = false;
    let closedQuote = false;

    function finishRow() {
      row.push(cell);
      records.push(row);
      row = [];
      cell = '';
      closedQuote = false;
    }

    for (let index = 0; index < source.length; index += 1) {
      const character = source[index];
      if (quoted) {
        if (character === '"') {
          if (source[index + 1] === '"') {
            cell += '"';
            index += 1;
          } else {
            quoted = false;
            closedQuote = true;
          }
        } else {
          cell += character;
        }
        continue;
      }
      if (closedQuote && character !== ',' && character !== '\r' && character !== '\n') {
        fail('DATA_PARSE_INVALID', 'CSV 引号字段结束后只能跟随分隔符');
      }
      if (character === '"') {
        if (cell !== '') fail('DATA_PARSE_INVALID', 'CSV 引号只能包裹完整字段');
        quoted = true;
        closedQuote = false;
      } else if (character === ',') {
        row.push(cell);
        cell = '';
        closedQuote = false;
      } else if (character === '\r' || character === '\n') {
        if (character === '\r' && source[index + 1] === '\n') index += 1;
        finishRow();
      } else {
        cell += character;
      }
    }
    if (quoted) fail('DATA_PARSE_INVALID', 'CSV 存在未闭合的引号');
    if (cell !== '' || row.length > 0 || records.length === 0) finishRow();

    const headers = records.shift().map(function (header) { return header.trim(); });
    if (headers.length === 0 || headers.some(function (header) { return header === ''; })) fail('DATA_PARSE_INVALID', 'CSV 表头不能为空');
    if (new Set(headers).size !== headers.length) fail('DATA_PARSE_INVALID', 'CSV 表头必须唯一');
    return records.map(function (values, rowIndex) {
      if (values.length !== headers.length) fail('DATA_PARSE_INVALID', 'CSV 第 ' + (rowIndex + 2) + ' 行列数与表头不一致');
      const result = {};
      headers.forEach(function (header, columnIndex) { setOwn(result, header, values[columnIndex]); });
      return result;
    });
  }

  function parseJsonRows(input) {
    let parsed;
    try {
      parsed = typeof input === 'string' ? JSON.parse(input) : copy(input);
    } catch (error) {
      fail('DATA_PARSE_INVALID', 'JSON 内容无效');
    }
    if (!Array.isArray(parsed) || !parsed.every(isPlainObject)) fail('DATA_PARSE_INVALID', 'JSON 必须是对象数组');
    return copy(parsed);
  }

  function isEmpty(value) {
    return value === null || value === undefined || value === '';
  }

  function isNumberValue(value) {
    if (typeof value === 'number') return Number.isFinite(value);
    return typeof value === 'string' && value.trim() !== '' && /^[-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?$/.test(value.trim()) && Number.isFinite(Number(value));
  }

  function isBooleanValue(value) {
    return typeof value === 'boolean' || (typeof value === 'string' && /^(true|false)$/i.test(value.trim()));
  }

  function isDateValue(value) {
    if (value instanceof Date) return Number.isFinite(value.getTime());
    if (typeof value !== 'string') return false;
    const valueText = value.trim();
    const match = /^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2})(?::(\d{2})(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:?\d{2})?)?$/.exec(valueText);
    if (!match || !Number.isFinite(Date.parse(valueText))) return false;
    const year = Number(match[1]);
    const month = Number(match[2]);
    const day = Number(match[3]);
    const daysInMonth = [31, (year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0)) ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
    if (month < 1 || month > 12 || day < 1 || day > daysInMonth[month - 1]) return false;
    if (match[4] && (Number(match[4]) > 23 || Number(match[5]) > 59 || (match[6] && Number(match[6]) > 59))) return false;
    return true;
  }

  function inferFieldType(values) {
    const populated = (Array.isArray(values) ? values : []).filter(function (value) { return !isEmpty(value); });
    if (populated.length === 0) return 'string';
    if (populated.every(isBooleanValue)) return 'boolean';
    if (populated.every(isNumberValue)) return 'number';
    if (populated.every(isDateValue)) return 'date';
    return 'string';
  }

  function ensureRows(rows) {
    if (!Array.isArray(rows) || !rows.every(isPlainObject)) fail('DATA_PARSE_INVALID', '行数据必须是对象数组');
  }

  function createPreview(rows) {
    ensureRows(rows);
    const fields = [];
    rows.forEach(function (row) {
      Object.keys(row).forEach(function (field) {
        if (fields.indexOf(field) === -1) fields.push(field);
      });
    });
    const allRows = copy(rows);
    const fieldStats = {};
    fields.forEach(function (field) {
      const values = rows.map(function (row) { return row[field]; });
      setOwn(fieldStats, field, {
        inferredType: inferFieldType(values),
        nullCount: values.filter(isEmpty).length,
      });
    });
    return { fields, rows: allRows, preview: copy(allRows.slice(0, 10)), fieldStats };
  }

  function text(value) {
    return value === null || value === undefined ? '' : String(value).trim();
  }

  function mappingProperties(row, propertyMappings) {
    const properties = {};
    const mappings = isPlainObject(propertyMappings) ? propertyMappings : {};
    Object.keys(mappings).forEach(function (targetProperty) {
      setOwn(properties, targetProperty, copy(row[mappings[targetProperty]]));
    });
    return properties;
  }

  function mapNodeRows(rows, options) {
    ensureRows(rows);
    const config = options || {};
    const nodeType = config.nodeType;
    const ids = new Set();
    const errors = [];
    const nodes = [];
    rows.forEach(function (row, rowIndex) {
      const id = text(row[config.idField]);
      if (id === '') {
        errors.push({ code: 'ELEMENT_ID_INVALID', message: '节点 ID 不能为空', rowIndex });
        return;
      }
      if (ids.has(id)) {
        errors.push({ code: 'DUPLICATE_ELEMENT_ID', message: '节点 ID 重复：' + id, rowIndex, id });
        return;
      }
      ids.add(id);
      nodes.push({ id, type: nodeType, properties: mappingProperties(row, config.propertyMappings) });
    });
    return errors.length ? { nodes: [], errors } : { nodes, errors: [] };
  }

  function mapEdgeRows(rows, options, existingNodeIds) {
    ensureRows(rows);
    const config = options || {};
    const nodeIds = existingNodeIds instanceof Set ? existingNodeIds : new Set();
    const ids = new Set();
    const errors = [];
    const edges = [];
    rows.forEach(function (row, rowIndex) {
      const id = text(row[config.idField]);
      const source = text(row[config.sourceField]);
      const target = text(row[config.targetField]);
      let valid = true;
      if (id === '') {
        errors.push({ code: 'ELEMENT_ID_INVALID', message: '关系 ID 不能为空', rowIndex });
        valid = false;
      } else if (ids.has(id)) {
        errors.push({ code: 'DUPLICATE_ELEMENT_ID', message: '关系 ID 重复：' + id, rowIndex, id });
        valid = false;
      } else {
        ids.add(id);
      }
      if (source === '' || target === '' || !nodeIds.has(source) || !nodeIds.has(target)) {
        errors.push({ code: 'ORPHAN_EDGE', message: '关系端点为空或不存在', rowIndex, source, target });
        valid = false;
      }
      if (!valid) return;
      edges.push({ id, type: config.edgeType, source, target, properties: mappingProperties(row, config.propertyMappings) });
    });
    return errors.length ? { edges: [], errors } : { edges, errors: [] };
  }

  return { parseCsv, parseJsonRows, createPreview, inferFieldType, mapNodeRows, mapEdgeRows };
});
