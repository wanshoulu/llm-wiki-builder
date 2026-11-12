/**
 * Review System — Async human-in-the-loop review for Wiki ingest
 *
 * LLM flags items during ingest, human reviews later.
 * Predefined actions: create_page | deep_research | skip | merge | flag
 * LLM pre-generates search queries for deep_research items.
 *
 * Usage:
 *   const { ReviewSystem } = require('./tools/review-system');
 *   const rs = new ReviewSystem(wikiDir);
 *   rs.flag({ type: 'create_page', page: 'xxx', reason: '...', searchQueries: [...] });
 */

'use strict';

const fs = require('fs');
const path = require('path');

const VALID_ACTIONS = ['create_page', 'deep_research', 'skip', 'merge', 'flag'];

class ReviewSystem {
  constructor(wikiDir) {
    this.wikiDir = wikiDir;
    this.reviewPath = path.join(wikiDir, '.reviews.json');
    this.items = [];
    this._load();
  }

  // ── Flag items ──

  flag(item) {
    if (!item || !item.type) return null;
    if (!VALID_ACTIONS.includes(item.type)) {
      throw new Error('Invalid review action: ' + item.type + '. Valid: ' + VALID_ACTIONS.join(', '));
    }
    const entry = {
      id: 'rv_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6),
      type: item.type,
      page: item.page || '',
      reason: item.reason || '',
      searchQueries: item.searchQueries || [],
      context: item.context || '',
      source: item.source || '',
      status: 'pending', // pending | approved | rejected | skipped
      createdAt: new Date().toISOString(),
      resolvedAt: null,
      resolvedBy: null,
    };
    this.items.push(entry);
    this._save();
    return entry;
  }

  // ── Query ──

  getPending() { return this.items.filter(function(i) { return i.status === 'pending'; }); }
  getByType(type) { return this.items.filter(function(i) { return i.type === type; }); }
  getAll() { return this.items.slice(); }
  getStats() {
    const total = this.items.length;
    const pending = this.getPending().length;
    const approved = this.items.filter(function(i) { return i.status === 'approved'; }).length;
    return { total, pending, approved };
  }

  // ── Actions ──

  approve(id, metadata) {
    const item = this.items.find(function(i) { return i.id === id; });
    if (!item) return false;
    item.status = 'approved';
    item.resolvedAt = new Date().toISOString();
    item.resolvedBy = metadata && metadata.user ? metadata.user : 'system';
    if (metadata && metadata.notes) item.notes = metadata.notes;
    this._save();
    return true;
  }

  reject(id, reason) {
    const item = this.items.find(function(i) { return i.id === id; });
    if (!item) return false;
    item.status = 'rejected';
    item.resolvedAt = new Date().toISOString();
    if (reason) item.rejectReason = reason;
    this._save();
    return true;
  }

  skip(id) {
    const item = this.items.find(function(i) { return i.id === id; });
    if (!item) return false;
    item.status = 'skipped';
    item.resolvedAt = new Date().toISOString();
    this._save();
    return true;
  }

  // ── Persistence ──

  _save() {
    try {
      fs.writeFileSync(this.reviewPath, JSON.stringify({ items: this.items, updatedAt: new Date().toISOString() }, null, 2), 'utf-8');
    } catch (e) { /* ignore */ }
  }

  _load() {
    try {
      if (fs.existsSync(this.reviewPath)) {
        const data = JSON.parse(fs.readFileSync(this.reviewPath, 'utf-8'));
        this.items = data.items || [];
      }
    } catch (e) { this.items = []; }
  }
}

module.exports = { ReviewSystem };
