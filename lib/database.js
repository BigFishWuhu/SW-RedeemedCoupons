const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const SERVERS = new Set(['global', 'korea', 'japan', 'china', 'asia', 'europe']);

class AppDatabase {
    constructor(filename) {
        fs.mkdirSync(path.dirname(filename), { recursive: true });
        this.db = new DatabaseSync(filename);
        this.db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
        this.migrate();
    }

    migrate() {
        this.db.exec(`
            CREATE TABLE IF NOT EXISTS users (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                username TEXT NOT NULL UNIQUE COLLATE NOCASE,
                password_hash TEXT NOT NULL,
                created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
                updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
            );

            CREATE TABLE IF NOT EXISTS sessions (
                token_hash TEXT PRIMARY KEY,
                user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                expires_at TEXT NOT NULL,
                created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
            );

            CREATE TABLE IF NOT EXISTS accounts (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                name TEXT NOT NULL DEFAULT '',
                hive_id TEXT NOT NULL,
                server TEXT NOT NULL,
                enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
                created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
                updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
                UNIQUE(hive_id, server)
            );

            CREATE TABLE IF NOT EXISTS jobs (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                trigger_type TEXT NOT NULL,
                status TEXT NOT NULL,
                account_id INTEGER REFERENCES accounts(id) ON DELETE SET NULL,
                fetched_count INTEGER NOT NULL DEFAULT 0,
                success_count INTEGER NOT NULL DEFAULT 0,
                skipped_count INTEGER NOT NULL DEFAULT 0,
                failed_count INTEGER NOT NULL DEFAULT 0,
                error_message TEXT,
                started_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
                finished_at TEXT
            );

            CREATE TABLE IF NOT EXISTS redemption_records (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                job_id INTEGER REFERENCES jobs(id) ON DELETE SET NULL,
                account_id INTEGER REFERENCES accounts(id) ON DELETE SET NULL,
                account_name TEXT NOT NULL DEFAULT '',
                hive_id TEXT NOT NULL,
                server TEXT NOT NULL,
                coupon_code TEXT NOT NULL,
                status TEXT NOT NULL,
                stage TEXT,
                hive_ret_code TEXT,
                message TEXT,
                created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
            );

            CREATE INDEX IF NOT EXISTS idx_sessions_expires_at ON sessions(expires_at);
            CREATE INDEX IF NOT EXISTS idx_records_created_at ON redemption_records(created_at DESC);
            CREATE INDEX IF NOT EXISTS idx_records_account_coupon ON redemption_records(account_id, coupon_code, status);
            CREATE INDEX IF NOT EXISTS idx_jobs_started_at ON jobs(started_at DESC);
        `);
        this.db.prepare(`
            UPDATE jobs SET status = 'failed', error_message = COALESCE(error_message, '服务重启，任务中断'),
                finished_at = COALESCE(finished_at, CURRENT_TIMESTAMP) WHERE status = 'running'
        `).run();
    }

    close() {
        this.db.close();
    }

    initializeAdmin(username, password) {
        const count = Number(this.db.prepare('SELECT COUNT(*) AS count FROM users').get().count);
        if (count > 0) return false;
        if (!username || !password) {
            throw new Error('No administrator exists. Set ADMIN_USERNAME and ADMIN_PASSWORD for the first start.');
        }
        if (String(password).length < 10) {
            throw new Error('ADMIN_PASSWORD must contain at least 10 characters.');
        }
        this.db.prepare('INSERT INTO users (username, password_hash) VALUES (?, ?)')
            .run(String(username).trim(), hashPassword(password));
        return true;
    }

    authenticate(username, password) {
        const user = this.db.prepare('SELECT id, username, password_hash FROM users WHERE username = ?').get(String(username || '').trim());
        return user && verifyPassword(password, user.password_hash) ? { id: user.id, username: user.username } : null;
    }

    changePassword(userId, currentPassword, nextPassword) {
        const user = this.db.prepare('SELECT password_hash FROM users WHERE id = ?').get(userId);
        if (!user || !verifyPassword(currentPassword, user.password_hash)) return false;
        if (String(nextPassword || '').length < 10) throw new Error('新密码至少需要 10 个字符');
        this.db.prepare("UPDATE users SET password_hash = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?")
            .run(hashPassword(nextPassword), userId);
        this.db.prepare('DELETE FROM sessions WHERE user_id = ?').run(userId);
        return true;
    }

    createSession(userId, ttlHours = 168) {
        const token = crypto.randomBytes(32).toString('base64url');
        const expiresAt = new Date(Date.now() + ttlHours * 3600_000).toISOString();
        this.db.prepare('INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?, ?, ?)')
            .run(hashToken(token), userId, expiresAt);
        return { token, expiresAt };
    }

    getSession(token) {
        if (!token) return null;
        this.db.prepare('DELETE FROM sessions WHERE expires_at <= ?').run(new Date().toISOString());
        return this.db.prepare(`
            SELECT u.id, u.username, s.expires_at AS expiresAt
            FROM sessions s JOIN users u ON u.id = s.user_id
            WHERE s.token_hash = ? AND s.expires_at > ?
        `).get(hashToken(token), new Date().toISOString()) || null;
    }

    deleteSession(token) {
        if (token) this.db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(hashToken(token));
    }

    listAccounts(enabledOnly = false) {
        return this.db.prepare(`
            SELECT id, name, hive_id AS hiveId, server, enabled, created_at AS createdAt, updated_at AS updatedAt
            FROM accounts ${enabledOnly ? 'WHERE enabled = 1' : ''} ORDER BY id DESC
        `).all().map((row) => ({ ...row, enabled: Boolean(row.enabled) }));
    }

    getAccount(id) {
        const row = this.db.prepare('SELECT id, name, hive_id AS hiveId, server, enabled FROM accounts WHERE id = ?').get(id);
        return row ? { ...row, enabled: Boolean(row.enabled) } : null;
    }

    createAccount(input) {
        const account = normalizeAccount(input);
        const result = this.db.prepare('INSERT INTO accounts (name, hive_id, server, enabled) VALUES (?, ?, ?, ?)')
            .run(account.name, account.hiveId, account.server, account.enabled ? 1 : 0);
        return this.getAccount(Number(result.lastInsertRowid));
    }

    updateAccount(id, input) {
        if (!this.getAccount(id)) return null;
        const account = normalizeAccount(input);
        this.db.prepare(`
            UPDATE accounts SET name = ?, hive_id = ?, server = ?, enabled = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?
        `).run(account.name, account.hiveId, account.server, account.enabled ? 1 : 0, id);
        return this.getAccount(id);
    }

    deleteAccount(id) {
        return Number(this.db.prepare('DELETE FROM accounts WHERE id = ?').run(id).changes) > 0;
    }

    hasSuccessfulRecord(accountId, couponCode) {
        return Boolean(this.db.prepare(`
            SELECT 1 FROM redemption_records
            WHERE account_id = ? AND coupon_code = ? AND status IN ('redeemed', 'already-redeemed') LIMIT 1
        `).get(accountId, couponCode));
    }

    createJob(triggerType, accountId = null) {
        const result = this.db.prepare("INSERT INTO jobs (trigger_type, status, account_id) VALUES (?, 'running', ?)")
            .run(triggerType, accountId);
        return Number(result.lastInsertRowid);
    }

    finishJob(id, summary, errorMessage = null) {
        this.db.prepare(`
            UPDATE jobs SET status = ?, fetched_count = ?, success_count = ?, skipped_count = ?, failed_count = ?,
                error_message = ?, finished_at = CURRENT_TIMESTAMP WHERE id = ?
        `).run(errorMessage ? 'failed' : 'completed', summary.fetched, summary.success, summary.skipped, summary.failed, errorMessage, id);
    }

    addRecord(jobId, account, couponCode, result) {
        this.db.prepare(`
            INSERT INTO redemption_records
                (job_id, account_id, account_name, hive_id, server, coupon_code, status, stage, hive_ret_code, message)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(jobId, account.id, account.name, account.hiveId, account.server, couponCode,
            result.status, result.stage || null, result.retCode == null ? null : String(result.retCode),
            result.message ? String(result.message).slice(0, 1000) : null);
    }

    listRecords({ page = 1, pageSize = 25, accountId, status, query } = {}) {
        page = Math.max(1, Number(page) || 1);
        pageSize = Math.min(100, Math.max(1, Number(pageSize) || 25));
        const where = [];
        const params = [];
        if (accountId) { where.push('account_id = ?'); params.push(Number(accountId)); }
        if (status) { where.push('status = ?'); params.push(String(status)); }
        if (query) {
            where.push('(coupon_code LIKE ? OR hive_id LIKE ? OR account_name LIKE ?)');
            const value = `%${String(query).slice(0, 100)}%`;
            params.push(value, value, value);
        }
        const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
        const total = Number(this.db.prepare(`SELECT COUNT(*) AS count FROM redemption_records ${clause}`).get(...params).count);
        const items = this.db.prepare(`
            SELECT id, job_id AS jobId, account_id AS accountId, account_name AS accountName, hive_id AS hiveId,
                server, coupon_code AS couponCode, status, stage, hive_ret_code AS retCode, message, created_at AS createdAt
            FROM redemption_records ${clause} ORDER BY id DESC LIMIT ? OFFSET ?
        `).all(...params, pageSize, (page - 1) * pageSize);
        return { items, total, page, pageSize, pages: Math.max(1, Math.ceil(total / pageSize)) };
    }

    dashboard() {
        const totals = this.db.prepare(`
            SELECT COUNT(*) AS total,
                SUM(CASE WHEN status = 'redeemed' THEN 1 ELSE 0 END) AS redeemed,
                SUM(CASE WHEN status = 'already-redeemed' THEN 1 ELSE 0 END) AS alreadyRedeemed,
                SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) AS failed
            FROM redemption_records
        `).get();
        const latestJob = this.db.prepare(`
            SELECT id, trigger_type AS triggerType, status, fetched_count AS fetched, success_count AS success,
                skipped_count AS skipped, failed_count AS failed, error_message AS errorMessage,
                started_at AS startedAt, finished_at AS finishedAt FROM jobs ORDER BY id DESC LIMIT 1
        `).get() || null;
        return {
            accountCount: Number(this.db.prepare('SELECT COUNT(*) AS count FROM accounts').get().count),
            enabledAccountCount: Number(this.db.prepare('SELECT COUNT(*) AS count FROM accounts WHERE enabled = 1').get().count),
            totalRecords: Number(totals.total || 0),
            redeemedCount: Number(totals.redeemed || 0) + Number(totals.alreadyRedeemed || 0),
            failedCount: Number(totals.failed || 0),
            latestJob
        };
    }
}

function normalizeAccount(input) {
    const hiveId = String(input.hiveId || '').trim();
    const server = String(input.server || '').trim().toLowerCase();
    if (!hiveId || hiveId.length > 100) throw new Error('Hive ID 必填，且不能超过 100 个字符');
    if (!SERVERS.has(server)) throw new Error('服务器选项无效');
    return { name: String(input.name || '').trim().slice(0, 100), hiveId, server, enabled: input.enabled === undefined ? true : input.enabled === true };
}

function hashPassword(password) {
    const salt = crypto.randomBytes(16);
    const hash = crypto.scryptSync(String(password), salt, 64);
    return `scrypt:${salt.toString('base64')}:${hash.toString('base64')}`;
}

function verifyPassword(password, stored) {
    try {
        const [, salt, hash] = String(stored).split(':');
        const expected = Buffer.from(hash, 'base64');
        const actual = crypto.scryptSync(String(password || ''), Buffer.from(salt, 'base64'), expected.length);
        return crypto.timingSafeEqual(actual, expected);
    } catch {
        return false;
    }
}

function hashToken(token) {
    return crypto.createHash('sha256').update(String(token)).digest('hex');
}

module.exports = { AppDatabase, SERVERS, hashPassword, verifyPassword };
