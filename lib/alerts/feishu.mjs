// Feishu (Lark) Alerter — Multi-tier alerts via Feishu Bot Webhook
// Feishu docs: https://open.feishu.cn/document/client-docs/bot-v3/add-custom-bot

import { createHash } from 'crypto';

/** Feishu text content limit (characters). */
const FEISHU_MAX_TEXT = 4000;

// ─── Alert Tiers ────────────────────────────────────────────────────────────
const TIER_CONFIG = {
  FLASH:    { emoji: '🔴', label: 'FLASH',    cooldownMs: 5 * 60 * 1000,  maxPerHour: 6 },
  PRIORITY: { emoji: '🟡', label: 'PRIORITY', cooldownMs: 30 * 60 * 1000, maxPerHour: 4 },
  ROUTINE:  { emoji: '🔵', label: 'ROUTINE',  cooldownMs: 60 * 60 * 1000, maxPerHour: 2 },
};

export class FeishuAlerter {
  /**
   * @param {object} opts
   * @param {string} opts.webhookUrl  - Feishu custom bot webhook URL
   * @param {string} [opts.secret]    - Optional signing secret for request verification
   */
  constructor({ webhookUrl, secret } = {}) {
    this.webhookUrl = webhookUrl || null;
    this.secret = secret || null;
    this._alertHistory = [];
    this._contentHashes = {};
    this._muteUntil = null;
  }

  get isConfigured() {
    return !!this.webhookUrl;
  }

  // ─── Core Messaging ─────────────────────────────────────────────────────

  /**
   * Send a text message via Feishu webhook.
   * Long messages are split at FEISHU_MAX_TEXT to avoid truncation.
   * @param {string} text - plain text message
   * @returns {Promise<boolean>}
   */
  async sendMessage(text) {
    if (!this.isConfigured) return false;
    const chunks = this._chunkText(text, FEISHU_MAX_TEXT);

    let allOk = true;
    for (const chunk of chunks) {
      const ok = await this._post({ msg_type: 'text', content: { text: chunk } });
      if (!ok) allOk = false;
    }
    return allOk;
  }

  /**
   * Send a rich card (interactive message) via Feishu webhook.
   * @param {object} card - Feishu card content object
   * @returns {Promise<boolean>}
   */
  async sendCard(card) {
    if (!this.isConfigured) return false;
    return this._post({ msg_type: 'interactive', card });
  }

  // ─── Multi-Tier Alert Evaluation ────────────────────────────────────────

  /**
   * Evaluate delta signals with LLM and send tiered alert if warranted.
   * Mirrors the logic from TelegramAlerter for consistency.
   */
  async evaluateAndAlert(llmProvider, delta, memory) {
    if (!this.isConfigured) return false;
    if (!delta?.summary?.totalChanges) return false;
    if (this._isMuted()) {
      console.log('[Feishu] Alerts muted until', new Date(this._muteUntil).toLocaleTimeString());
      return false;
    }

    const allSignals = [
      ...(delta.signals?.new || []),
      ...(delta.signals?.escalated || []),
    ];

    const newSignals = allSignals.filter(s => {
      const key = this._signalKey(s);
      if (typeof memory.isSignalSuppressed === 'function') {
        if (memory.isSignalSuppressed(key)) return false;
      } else {
        const alerted = memory.getAlertedSignals();
        if (alerted[key]) return false;
      }
      if (this._isSemanticDuplicate(s)) return false;
      return true;
    });

    if (newSignals.length === 0) return false;

    // Try LLM evaluation, fall back to rule-based
    let evaluation = null;

    if (llmProvider?.isConfigured) {
      try {
        const systemPrompt = this._buildEvaluationPrompt();
        const userMessage = this._buildSignalContext(newSignals, delta);
        const result = await llmProvider.complete(systemPrompt, userMessage, {
          maxTokens: 800,
          timeout: 30000,
        });
        evaluation = parseJSON(result.text);
      } catch (err) {
        console.warn('[Feishu] LLM evaluation failed, falling back to rules:', err.message);
      }
    }

    if (!evaluation || typeof evaluation.shouldAlert !== 'boolean') {
      evaluation = this._ruleBasedEvaluation(newSignals, delta);
      if (evaluation) evaluation._source = 'rules';
    }

    if (!evaluation?.shouldAlert) {
      console.log('[Feishu] No alert —', evaluation?.reason || 'no qualifying signals');
      return false;
    }

    const tier = TIER_CONFIG[evaluation.tier] ? evaluation.tier : 'ROUTINE';
    if (!this._checkRateLimit(tier)) {
      console.log(`[Feishu] Rate limited for tier ${tier}`);
      return false;
    }

    const sent = await this._sendTieredAlert(evaluation, delta, tier);

    if (sent) {
      for (const s of newSignals) {
        const key = this._signalKey(s);
        memory.markAsAlerted(key, new Date().toISOString());
        this._recordContentHash(s);
      }
      this._recordAlert(tier);
      console.log(`[Feishu] ${tier} alert sent (${evaluation._source || 'llm'}): ${evaluation.headline}`);
    }

    return sent;
  }

  // ─── Alert Formatting ───────────────────────────────────────────────────

  async _sendTieredAlert(evaluation, delta, tier) {
    const tc = TIER_CONFIG[tier];
    const confidenceEmoji = { HIGH: '🟢', MEDIUM: '🟡', LOW: '⚪' }[evaluation.confidence] || '⚪';

    // Build Feishu interactive card for rich formatting
    const card = {
      schema: '2.0',
      config: { wide_screen_mode: true },
      header: {
        title: {
          tag: 'plain_text',
          content: `${tc.emoji} CRUCIX ${tc.label} — ${evaluation.headline}`,
        },
        template: tier === 'FLASH' ? 'red' : tier === 'PRIORITY' ? 'yellow' : 'blue',
      },
      body: {
        elements: [
          {
            tag: 'markdown',
            content: [
              evaluation.reason,
              '',
              `**置信度：** ${confidenceEmoji} ${evaluation.confidence || 'MEDIUM'}`,
              `**方向：** ${delta.summary.direction.toUpperCase()}`,
              evaluation.crossCorrelation ? `**交叉关联：** ${evaluation.crossCorrelation}` : null,
              evaluation.actionable && evaluation.actionable !== 'Monitor'
                ? `\n💡 **操作建议：** ${evaluation.actionable}` : null,
            ].filter(Boolean).join('\n'),
          },
        ],
      },
    };

    // Add signals list
    if (evaluation.signals?.length) {
      card.body.elements.push({
        tag: 'markdown',
        content: '**信号：**\n' + evaluation.signals.map(s => `• ${s}`).join('\n'),
      });
    }

    // Timestamp note
    card.body.elements.push({
      tag: 'note',
      elements: [{
        tag: 'plain_text',
        content: `${new Date().toISOString().replace('T', ' ').substring(0, 19)} UTC`,
      }],
    });

    const sent = await this.sendCard(card);

    // Fallback to plain text if card fails
    if (!sent) {
      const lines = [
        `${tc.emoji} CRUCIX ${tc.label}`,
        '',
        evaluation.headline,
        '',
        evaluation.reason,
        '',
        `置信度: ${confidenceEmoji} ${evaluation.confidence || 'MEDIUM'}`,
        `方向: ${delta.summary.direction.toUpperCase()}`,
        evaluation.crossCorrelation ? `交叉关联: ${evaluation.crossCorrelation}` : null,
        evaluation.actionable && evaluation.actionable !== 'Monitor'
          ? `\n💡 操作建议: ${evaluation.actionable}` : null,
        evaluation.signals?.length ? '\n信号:\n' + evaluation.signals.map(s => `• ${s}`).join('\n') : null,
        '',
        `${new Date().toISOString().replace('T', ' ').substring(0, 19)} UTC`,
      ].filter(Boolean).join('\n');
      return this.sendMessage(lines);
    }

    return sent;
  }

  // ─── Rule-Based Fallback ─────────────────────────────────────────────────
  // Mirrors TelegramAlerter._ruleBasedEvaluation for identical alert logic

  _ruleBasedEvaluation(signals, delta) {
    const criticals = signals.filter(s => s.severity === 'critical');
    const highs = signals.filter(s => s.severity === 'high');
    const nukeSignal = signals.find(s => s.key === 'nuke_anomaly');
    const osintNew = signals.filter(s => s.key?.startsWith('tg_urgent'));
    const marketSignals = signals.filter(s =>
      ['vix', 'hy_spread', 'wti', 'brent', 'natgas', 'gold', 'silver', '10y2y'].includes(s.key)
    );
    const conflictSignals = signals.filter(s =>
      ['conflict_events', 'conflict_fatalities', 'thermal_total'].includes(s.key)
    );

    if (nukeSignal) {
      return {
        shouldAlert: true, tier: 'FLASH', confidence: 'HIGH',
        headline: '检测到核异常',
        reason: 'Safecast 辐射监测仪已标记异常。需要立即关注。',
        actionable: '查看仪表板以了解受影响站点。监控二次来源确认。',
        signals: ['nuke_anomaly'],
        crossCorrelation: '辐射监测',
      };
    }

    const hasCriticalMarket = criticals.some(s => marketSignals.includes(s));
    const hasCriticalConflict = criticals.some(s => conflictSignals.includes(s) || osintNew.includes(s));
    if (criticals.length >= 2 && hasCriticalMarket && hasCriticalConflict) {
      return {
        shouldAlert: true, tier: 'FLASH', confidence: 'HIGH',
        headline: `${criticals.length} 个严重跨域信号`,
        reason: `跨市场和冲突领域检测到 ${criticals.length} 个严重信号。多域关联表明系统性事件。`,
        actionable: '立即查看仪表板。评估组合敞口。',
        signals: criticals.map(s => s.label || s.key).slice(0, 5),
        crossCorrelation: '市场 + 冲突',
      };
    }

    const escalatedHighs = [...criticals, ...highs].filter(s => s.direction === 'up');
    if (escalatedHighs.length >= 2) {
      return {
        shouldAlert: true, tier: 'PRIORITY', confidence: 'MEDIUM',
        headline: `${escalatedHighs.length} 个升级信号`,
        reason: `多个指标同步升级：${escalatedHighs.map(s => s.label || s.key).slice(0, 3).join('、')}。`,
        actionable: '监控持续情况。检查下次扫描是否延续趋势。',
        signals: escalatedHighs.map(s => s.label || s.key).slice(0, 5),
        crossCorrelation: '多指标',
      };
    }

    if (osintNew.length >= 5) {
      return {
        shouldAlert: true, tier: 'PRIORITY', confidence: 'MEDIUM',
        headline: `OSINT 激增：${osintNew.length} 条新紧急帖子`,
        reason: `检测到 ${osintNew.length} 条新 OSINT 紧急信号，冲突报道频率升高。`,
        actionable: '检查 OSINT 数据流规律。与卫星和 ACLED 数据交叉核验。',
        signals: osintNew.map(s => s.text || s.label || s.key).slice(0, 5),
        crossCorrelation: 'Telegram OSINT',
      };
    }

    if (criticals.length >= 1 || highs.length >= 3) {
      const topSignal = criticals[0] || highs[0];
      return {
        shouldAlert: true, tier: 'ROUTINE', confidence: 'LOW',
        headline: topSignal.label || topSignal.reason || '检测到信号变化',
        reason: `${criticals.length} 个严重信号，${highs.length} 个高严重性信号。${delta.summary.direction} 偏向。`,
        actionable: '监控',
        signals: [...criticals, ...highs].map(s => s.label || s.key).slice(0, 4),
        crossCorrelation: '单域',
      };
    }

    return {
      shouldAlert: false,
      reason: `${signals.length} 个信号，但均未达到警报阈值（${criticals.length} 严重，${highs.length} 高）。`,
    };
  }

  // ─── Semantic Dedup (mirrors TelegramAlerter) ───────────────────────────

  _contentHash(signal) {
    let content = '';
    if (signal.text) {
      content = signal.text.toLowerCase()
        .replace(/\d{1,2}:\d{2}/g, '')
        .replace(/\d+\.\d+%?/g, 'NUM')
        .replace(/\s+/g, ' ')
        .trim()
        .substring(0, 120);
    } else if (signal.label) {
      content = `${signal.label}:${signal.direction || 'none'}`;
    } else {
      content = signal.key || JSON.stringify(signal).substring(0, 80);
    }
    return createHash('sha256').update(content).digest('hex').substring(0, 16);
  }

  _isSemanticDuplicate(signal) {
    const hash = this._contentHash(signal);
    const lastSeen = this._contentHashes[hash];
    if (!lastSeen) return false;
    return new Date(lastSeen).getTime() > Date.now() - 4 * 60 * 60 * 1000;
  }

  _recordContentHash(signal) {
    const hash = this._contentHash(signal);
    this._contentHashes[hash] = new Date().toISOString();
    const cutoff = Date.now() - 24 * 60 * 60 * 1000;
    for (const [h, ts] of Object.entries(this._contentHashes)) {
      if (new Date(ts).getTime() < cutoff) delete this._contentHashes[h];
    }
  }

  _signalKey(signal) {
    if (signal.text) return `fs:${this._contentHash(signal)}`;
    return signal.key || signal.label || JSON.stringify(signal).substring(0, 60);
  }

  // ─── Rate Limiting (mirrors TelegramAlerter) ────────────────────────────

  _checkRateLimit(tier) {
    const config = TIER_CONFIG[tier];
    if (!config) return true;
    const now = Date.now();
    const oneHourAgo = now - 60 * 60 * 1000;
    const lastSameTier = this._alertHistory.filter(a => a.tier === tier).pop();
    if (lastSameTier && (now - lastSameTier.timestamp) < config.cooldownMs) return false;
    const recentCount = this._alertHistory.filter(a => a.tier === tier && a.timestamp > oneHourAgo).length;
    return recentCount < config.maxPerHour;
  }

  _recordAlert(tier) {
    this._alertHistory.push({ tier, timestamp: Date.now() });
    if (this._alertHistory.length > 50) this._alertHistory = this._alertHistory.slice(-50);
  }

  _isMuted() {
    if (!this._muteUntil) return false;
    if (Date.now() > this._muteUntil) { this._muteUntil = null; return false; }
    return true;
  }

  // ─── Prompt Engineering (mirrors TelegramAlerter) ───────────────────────

  _buildEvaluationPrompt() {
    return `You are Crucix, an elite intelligence alert evaluator for a personal OSINT monitoring system. Analyze signal deltas and decide if the user needs to be alerted via Feishu.

## Decision Framework

NO ALERT — suppress if:
- Routine scheduled data unless deviation is extreme (>2σ)
- Continuation of existing trends already flagged
- Low-confidence single-source signals without corroboration

🔴 FLASH — immediate, life-of-portfolio risk:
- Active military escalation between nuclear/NATO powers
- Flash crash (VIX >40%, major index down >3% intraday)
- Emergency central bank action
- Nuclear/radiological anomaly confirmed by multiple monitors
FLASH requires: ≥2 corroborating sources across different domains

🟡 PRIORITY — act within hours:
- Market dislocation (VIX >25 AND credit spreads widening)
- Geopolitical escalation with clear energy transmission
- Unexpected economic data (>1.5σ miss)
PRIORITY requires: ≥2 signals moving in same direction

🔵 ROUTINE — informational:
- Notable trend shifts worth tracking
- Single-source moderate signals

Output ONLY valid JSON:
{
  "shouldAlert": true/false,
  "tier": "FLASH" | "PRIORITY" | "ROUTINE",
  "headline": "10-word max headline",
  "reason": "2-3 sentences explaining what happened and why it matters.",
  "actionable": "Specific action or 'Monitor'",
  "signals": ["signal1", "signal2"],
  "confidence": "HIGH" | "MEDIUM" | "LOW",
  "crossCorrelation": "which domains confirm each other"
}`;
  }

  _buildSignalContext(signals, delta) {
    const sections = [];
    const marketSignals = signals.filter(s =>
      ['vix', 'hy_spread', 'wti', 'brent', 'natgas', 'gold', 'silver', '10y2y', 'fed_funds', '10y_yield', 'usd_index'].includes(s.key)
    );
    const osintSignals = signals.filter(s => s.key === 'tg_urgent' || s.item?.channel);
    const conflictSignals = signals.filter(s =>
      ['conflict_events', 'conflict_fatalities', 'thermal_total'].includes(s.key)
    );
    const otherSignals = signals.filter(s =>
      !marketSignals.includes(s) && !osintSignals.includes(s) && !conflictSignals.includes(s)
    );

    if (marketSignals.length > 0) {
      sections.push('📊 MARKET SIGNALS:\n' + marketSignals.map(s =>
        `  ${s.label}: ${s.from} → ${s.to} (${s.pctChange > 0 ? '+' : ''}${s.pctChange?.toFixed(1) || s.change}${s.pctChange !== undefined ? '%' : ''})`
      ).join('\n'));
    }
    if (osintSignals.length > 0) {
      sections.push('📡 OSINT SIGNALS:\n' + osintSignals.map(s => {
        const post = s.item || s;
        return `  [${post.channel || 'UNKNOWN'}] ${post.text || s.reason || ''}`;
      }).join('\n'));
    }
    if (conflictSignals.length > 0) {
      sections.push('⚔️ CONFLICT:\n' + conflictSignals.map(s =>
        `  ${s.label}: ${s.from} → ${s.to} (${s.direction})`
      ).join('\n'));
    }
    if (otherSignals.length > 0) {
      sections.push('📌 OTHER:\n' + otherSignals.map(s =>
        `  ${s.label || s.key || s.reason}: ${s.from !== undefined ? `${s.from} → ${s.to}` : 'new signal'}`
      ).join('\n'));
    }
    sections.push(`\n📈 DELTA: direction=${delta.summary.direction}, total=${delta.summary.totalChanges}, critical=${delta.summary.criticalChanges}`);
    return sections.join('\n\n');
  }

  // ─── Helpers ────────────────────────────────────────────────────────────

  _chunkText(text, maxLen) {
    if (!text || text.length <= maxLen) return text ? [text] : [];
    const chunks = [];
    let start = 0;
    while (start < text.length) {
      let end = Math.min(start + maxLen, text.length);
      if (end < text.length) {
        const lastNewline = text.lastIndexOf('\n', end - 1);
        if (lastNewline > start) end = lastNewline + 1;
      }
      chunks.push(text.slice(start, end));
      start = end;
    }
    return chunks;
  }

  /**
   * POST a message payload to the Feishu webhook.
   * Optionally signs the request with HMAC-SHA256 if a secret is configured.
   * @param {object} payload
   * @returns {Promise<boolean>}
   */
  async _post(payload) {
    try {
      const body = { ...payload };

      // Add HMAC-SHA256 signature if secret is configured
      if (this.secret) {
        const timestamp = Math.floor(Date.now() / 1000);
        const sign = await this._sign(timestamp, this.secret);
        body.timestamp = String(timestamp);
        body.sign = sign;
      }

      const res = await fetch(this.webhookUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(15000),
      });

      if (!res.ok) {
        const err = await res.text().catch(() => '');
        console.error(`[Feishu] Send failed (${res.status}): ${err.substring(0, 200)}`);
        return false;
      }

      const data = await res.json();
      if (data.code !== 0) {
        console.error(`[Feishu] API error (${data.code}): ${data.msg}`);
        return false;
      }

      return true;
    } catch (err) {
      console.error('[Feishu] Send error:', err.message);
      return false;
    }
  }

  /**
   * Generate Feishu webhook HMAC-SHA256 signature.
   * Algorithm: base64(HMAC-SHA256(timestamp + '\n' + secret))
   */
  async _sign(timestamp, secret) {
    const { createHmac } = await import('crypto');
    const str = `${timestamp}\n${secret}`;
    return createHmac('sha256', str).update('').digest('base64');
  }
}

// ─── Helpers ──────────────────────────────────────────────────────────────

function parseJSON(text) {
  if (!text) return null;
  let cleaned = text.trim();
  if (cleaned.startsWith('```')) {
    cleaned = cleaned.replace(/^```(?:json)?\n?/, '').replace(/\n?```$/, '');
  }
  try {
    return JSON.parse(cleaned);
  } catch {
    const match = cleaned.match(/\{[\s\S]*\}/);
    if (match) {
      try { return JSON.parse(match[0]); } catch { /* give up */ }
    }
    return null;
  }
}
