/**
 * Ingest Queue — Persistent queue manager for Wiki ingest jobs
 *
 * Features:
 *   - Serial processing (one file at a time)
 *   - Crash recovery (queue persisted to disk as JSON)
 *   - Auto-retry (up to 3 attempts per file)
 *   - Progress tracking (queued/processing/done/failed)
 *   - Pause/Resume/Cancel
 *
 * Usage:
 *   const { IngestQueue } = require('./tools/ingest-queue');
 *   const queue = new IngestQueue('/path/to/wiki');
 *   queue.enqueue(files);  // Add files
 *   queue.start(engine);    // Start processing
 *   queue.on('progress', fn); // Listen for updates
 */

'use strict';

const fs = require('fs');
const path = require('path');
const EventEmitter = require('events');

class IngestQueue extends EventEmitter {
  constructor(wikiDir, options) {
    super();
    this.wikiDir = wikiDir;
    this.options = options || {};
    this.maxRetries = this.options.maxRetries || 3;
    this.concurrency = 1; // Serial only
    this.items = [];
    this.active = null;
    this.paused = false;
    this.running = false;
    this.queuePath = path.join(wikiDir, '.ingest-queue.json');
    this._load();
  }

  // ── Queue Management ──

  enqueue(files, context) {
    const added = [];
    for (const file of files) {
      // Dedup
      if (this.items.find(function(i) { return i.filePath === file.fullPath && i.status !== 'done'; })) continue;
      const item = {
        id: 'iq_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8),
        filePath: file.fullPath || file,
        fileName: file.name || path.basename(file.fullPath || file),
        sourcePath: context && context.sourcePath ? context.sourcePath : '',
        projectName: context && context.projectName ? context.projectName : '',
        status: 'queued', // queued | processing | done | failed | cancelled
        retries: 0,
        error: null,
        addedAt: new Date().toISOString(),
        startedAt: null,
        completedAt: null,
        result: null,
      };
      this.items.push(item);
      added.push(item);
    }
    this._save();
    this.emit('enqueued', added);
    return added;
  }

  remove(id) {
    const idx = this.items.findIndex(function(i) { return i.id === id; });
    if (idx >= 0) {
      if (this.items[idx].status === 'processing') return false; // Can't remove active
      this.items.splice(idx, 1);
      this._save();
      this.emit('removed', id);
      return true;
    }
    return false;
  }

  clear() {
    this.items = this.items.filter(function(i) { return i.status === 'processing'; });
    this._save();
    this.emit('cleared');
  }

  pause() { this.paused = true; this.emit('paused'); }
  resume() { this.paused = false; this.emit('resumed'); if (this.running) this._processNext(); }

  // ── Processing ──

  async start(engine, options) {
    if (this.running) return;
    this.running = true;
    this.engine = engine;
    this.processOptions = options || {};
    this.emit('started');
    await this._processNext();
  }

  async stop() {
    this.running = false;
    if (this.active) this.active.status = 'queued'; // Re-queue active
    this.active = null;
    this._save();
    this.emit('stopped');
  }

  async _processNext() {
    if (!this.running || this.paused) return;

    // Find next queued item
    const next = this.items.find(function(i) { return i.status === 'queued'; });
    if (!next) {
      this.running = false;
      this.emit('drained');
      return;
    }

    this.active = next;
    next.status = 'processing';
    next.startedAt = new Date().toISOString();
    this._save();
    this.emit('progress', this.getProgress());

    try {
      const sourcePath = next.sourcePath || next.filePath;
      const result = await this.engine.ingest(sourcePath, {
        projectName: next.projectName || path.basename(sourcePath),
        recursive: true,
        fileFilter: next.fileName ? function(f) { return f.fullPath === next.filePath; } : null,
        onProgress: this.processOptions.onProgress || (function() {}),
      });

      next.status = 'done';
      next.completedAt = new Date().toISOString();
      next.result = result;
      this.emit('itemDone', next);
    } catch (e) {
      next.error = e.message;
      next.retries++;

      if (next.retries < this.maxRetries) {
        next.status = 'queued'; // Re-queue for retry
        this.emit('retry', next);
      } else {
        next.status = 'failed';
        next.completedAt = new Date().toISOString();
        this.emit('itemFailed', next);
      }
    }

    this.active = null;
    this._save();
    this.emit('progress', this.getProgress());

    // Process next (small delay to avoid tight loop)
    setTimeout(this._processNext.bind(this), 100);
  }

  // ── Status ──

  getProgress() {
    const total = this.items.length;
    const done = this.items.filter(function(i) { return i.status === 'done'; }).length;
    const failed = this.items.filter(function(i) { return i.status === 'failed'; }).length;
    const processing = this.items.filter(function(i) { return i.status === 'processing'; }).length;
    const queued = this.items.filter(function(i) { return i.status === 'queued'; }).length;
    return { total, done, failed, processing, queued, percent: total ? Math.round((done + failed) / total * 100) : 0 };
  }

  getItems() { return this.items.slice(); }

  // ── Persistence ──

  _save() {
    try {
      fs.writeFileSync(this.queuePath, JSON.stringify({
        items: this.items,
        savedAt: new Date().toISOString(),
      }, null, 2), 'utf-8');
    } catch (e) { /* ignore write errors */ }
  }

  _load() {
    try {
      if (fs.existsSync(this.queuePath)) {
        const data = JSON.parse(fs.readFileSync(this.queuePath, 'utf-8'));
        this.items = (data.items || []).map(function(i) {
          // Reset 'processing' items to 'queued' (crash recovery)
          if (i.status === 'processing') { i.status = 'queued'; i.retries++; }
          return i;
        });
      }
    } catch (e) { this.items = []; }
  }
}

module.exports = { IngestQueue };
