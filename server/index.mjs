import { createServer } from 'node:http';
import { randomBytes, randomUUID, scryptSync, timingSafeEqual } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { extname, join, normalize, resolve } from 'node:path';
import { gzipSync } from 'node:zlib';

const PORT = Number(process.env.PORT ?? 8787);
const ROOT_DIR = process.cwd();
const DATA_DIR = join(ROOT_DIR, 'server', 'data');
const DB_FILE = join(DATA_DIR, 'db.json');
const MEDIA_DIR = join(DATA_DIR, 'media');
const MEDIA_ROUTE_PREFIX = '/api/media/';
const DIST_DIR = join(ROOT_DIR, 'dist');
const MYSQL_URL = String(process.env.MYSQL_URL ?? process.env.DATABASE_URL ?? '').trim();
const DB_PROVIDER =
  String(process.env.DB_PROVIDER ?? (MYSQL_URL ? 'mysql' : 'file'))
    .trim()
    .toLowerCase() === 'mysql'
    ? 'mysql'
    : 'file';
const MYSQL_USERS_TABLE = 'users';
const MYSQL_SESSIONS_TABLE = 'sessions';
const MYSQL_CARDS_TABLE = 'cards';
const MYSQL_COMMENTS_TABLE = 'card_comments';
const MYSQL_COMMENTS_ARCHIVE_TABLE = 'card_comments_archive';
const MYSQL_MEDIA_FILES_TABLE = 'media_files';
const MYSQL_MEDIA_LINKS_TABLE = 'media_links';
const MYSQL_COLUMNS_TABLE = 'board_columns';
const MYSQL_FLOATING_TABLE = 'floating_cards';
const MYSQL_HISTORY_TABLE = 'history_entries';
const MYSQL_BOARD_VERSIONS_TABLE = 'board_versions';

const SESSION_TTL_MS = 1000 * 60 * 60 * 24 * 30;
const MAX_JSON_BYTES = 12 * 1024 * 1024;
const HISTORY_MAX_PER_USER = 500;
const MAX_COMMENTS_PER_CARD = 200;
const MAX_COMMENT_TEXT_LEN = 4000;
const MAX_CHECKLIST_ITEMS_PER_CARD = 120;
const MAX_CHECKLIST_ITEM_TEXT_LEN = 220;
const MAX_COMMENT_AUTHOR_LEN = 64;
const MAX_ARCHIVED_COMMENTS_PER_USER = 5000;
const MAX_CARD_IMAGES = 8;
const MAX_CARD_IMAGE_BYTES = 900 * 1024;
const MAX_CARD_IMAGES_TOTAL_BYTES = 3 * 1024 * 1024;
const MAX_PROFILE_AVATAR_BYTES = 700 * 1024;
const MAX_PROFILE_FIRST_NAME_LEN = 96;
const MAX_PROFILE_LAST_NAME_LEN = 96;
const MAX_PROFILE_ROLE_LEN = 128;
const MAX_PROFILE_CITY_LEN = 128;
const MAX_PROFILE_ABOUT_LEN = 2000;
const MAX_PROFILE_ABOUT_EDIT_LEN = 150;
const MIN_PROFILE_AGE_YEARS = 16;
const PROFILE_NAME_RX = /^[A-Za-zА-Яа-яЁё][A-Za-zА-Яа-яЁё' -]{1,47}$/u;
const PROFILE_ROLE_RX = /^[A-Za-zА-Яа-яЁё0-9][A-Za-zА-Яа-яЁё0-9 .,#/&()+-]{1,63}$/u;
const PROFILE_CITY_RX = /^[A-Za-zА-Яа-яЁё0-9][A-Za-zА-Яа-яЁё0-9' .-]{1,63}$/u;
const MAX_MEDIA_BYTES_PER_USER = (() => {
  const fallback = 160 * 1024 * 1024;
  const raw = Number(process.env.MAX_MEDIA_BYTES_PER_USER ?? process.env.MEDIA_QUOTA_BYTES ?? fallback);
  if (!Number.isFinite(raw) || raw <= 0) return fallback;
  return Math.max(MAX_CARD_IMAGE_BYTES, Math.trunc(raw));
})();
const MAX_CARD_IMAGE_NAME_LEN = 128;
const MEDIA_GC_DEBOUNCE_MS = 1200;
const MEDIA_GC_INTERVAL_MS = 1000 * 60 * 15;
const MEDIA_GC_UPLOAD_GRACE_MS = (() => {
  const fallback = 1000 * 60 * 60; // 1h grace: user can attach image and save card later.
  const raw = Number(process.env.MEDIA_GC_UPLOAD_GRACE_MS ?? fallback);
  if (!Number.isFinite(raw) || raw <= 0) return fallback;
  return Math.max(30_000, Math.trunc(raw));
})();
const RATE_LIMIT_UPLOAD_MAX = (() => {
  const fallback = 24;
  const raw = Number(process.env.RATE_LIMIT_UPLOAD_MAX ?? fallback);
  if (!Number.isFinite(raw) || raw <= 0) return fallback;
  return Math.max(1, Math.trunc(raw));
})();
const RATE_LIMIT_UPLOAD_WINDOW_MS = (() => {
  const fallback = 60_000;
  const raw = Number(process.env.RATE_LIMIT_UPLOAD_WINDOW_MS ?? fallback);
  if (!Number.isFinite(raw) || raw <= 0) return fallback;
  return Math.max(1_000, Math.trunc(raw));
})();
const RATE_LIMIT_COMMENT_MUTATION_MAX = (() => {
  const fallback = 60;
  const raw = Number(process.env.RATE_LIMIT_COMMENT_MUTATION_MAX ?? fallback);
  if (!Number.isFinite(raw) || raw <= 0) return fallback;
  return Math.max(1, Math.trunc(raw));
})();
const RATE_LIMIT_COMMENT_MUTATION_WINDOW_MS = (() => {
  const fallback = 60_000;
  const raw = Number(process.env.RATE_LIMIT_COMMENT_MUTATION_WINDOW_MS ?? fallback);
  if (!Number.isFinite(raw) || raw <= 0) return fallback;
  return Math.max(1_000, Math.trunc(raw));
})();
const RATE_LIMIT_STATE_MAX_ENTRIES = (() => {
  const fallback = 20_000;
  const raw = Number(process.env.RATE_LIMIT_STATE_MAX_ENTRIES ?? fallback);
  if (!Number.isFinite(raw) || raw <= 0) return fallback;
  return Math.max(1_000, Math.trunc(raw));
})();
const RATE_LIMIT_STATE_TTL_MS = Math.max(
  RATE_LIMIT_UPLOAD_WINDOW_MS,
  RATE_LIMIT_COMMENT_MUTATION_WINDOW_MS
) * 3;
const JSON_GZIP_MIN_BYTES = (() => {
  const fallback = 1024;
  const raw = Number(process.env.JSON_GZIP_MIN_BYTES ?? fallback);
  if (!Number.isFinite(raw) || raw <= 0) return fallback;
  return Math.max(256, Math.trunc(raw));
})();
const JSON_GZIP_MIN_SAVINGS_BYTES = (() => {
  const fallback = 80;
  const raw = Number(process.env.JSON_GZIP_MIN_SAVINGS_BYTES ?? fallback);
  if (!Number.isFinite(raw) || raw < 0) return fallback;
  return Math.max(0, Math.trunc(raw));
})();
const JSON_GZIP_LEVEL = (() => {
  const fallback = 6;
  const raw = Number(process.env.JSON_GZIP_LEVEL ?? fallback);
  if (!Number.isFinite(raw)) return fallback;
  return Math.max(1, Math.min(9, Math.trunc(raw)));
})();
const ALLOWED_ORIGINS = new Set(['http://127.0.0.1:5173', 'http://localhost:5173']);
const CARD_IMAGE_MIME_SET = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif']);
const CARD_IMAGE_EXT_BY_MIME = {
  'image/png': '.png',
  'image/jpeg': '.jpg',
  'image/webp': '.webp',
  'image/gif': '.gif',
};
const RICH_COMMENT_ALLOWED_TAGS = new Set([
  'b',
  'strong',
  'i',
  'em',
  's',
  'strike',
  'u',
  'br',
  'div',
  'p',
  'ul',
  'ol',
  'li',
  'span',
]);
const RICH_COMMENT_COLOR_CLASSES = new Set([
  'rc-color-0',
  'rc-color-1',
  'rc-color-2',
  'rc-color-3',
  'rc-color-4',
  'rc-color-5',
  'rc-bg-0',
  'rc-bg-1',
  'rc-bg-2',
  'rc-bg-3',
  'rc-bg-4',
  'rc-bg-5',
]);

const MIME_BY_EXT = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
};

const URGENCY_SET = new Set(['white', 'yellow', 'pink', 'red']);
const COLUMN_IDS = ['queue', 'doing', 'review', 'done'];
const CARD_STATUS_SET = new Set([...COLUMN_IDS, 'freedom']);
const HISTORY_KIND_SET = new Set(['create', 'move', 'delete', 'restore']);
const COMMENT_ARCHIVE_REASON_SET = new Set(['overflow', 'delete', 'card-delete']);
const MEDIA_LINK_OWNER_KIND_SET = new Set(['card', 'comment', 'comment_archive']);
const REPEATED_DELETE_ERROR_TEXT = 'Ты реально пытаешься удалить удаленное второй раз?';

function defaultBoardState() {
  return {
    cardsById: {},
    columns: {
      queue: [],
      doing: [],
      review: [],
      done: [],
    },
    floatingById: {},
    history: [],
  };
}

function defaultDb() {
  return {
    users: [],
    sessions: [],
    boards: {},
    __scopeUserId: null,
  };
}

function normalizeDbShape(parsed) {
  if (!parsed || typeof parsed !== 'object') return defaultDb();
  const users = Array.isArray(parsed.users) ? parsed.users : [];
  const sessions = Array.isArray(parsed.sessions) ? parsed.sessions : [];
  const boards = parsed.boards && typeof parsed.boards === 'object' ? parsed.boards : {};
  const scopeUserId = typeof parsed.__scopeUserId === 'string' ? String(parsed.__scopeUserId).trim() : null;
  return { users, sessions, boards, __scopeUserId: scopeUserId || null };
}

function ensureDbFile() {
  mkdirSync(DATA_DIR, { recursive: true });
  if (!existsSync(DB_FILE)) {
    writeFileSync(DB_FILE, JSON.stringify(defaultDb(), null, 2), 'utf8');
  }
}

function ensureMediaDir() {
  mkdirSync(MEDIA_DIR, { recursive: true });
}

function readDbFromFile() {
  ensureDbFile();
  try {
    const raw = readFileSync(DB_FILE, 'utf8');
    return normalizeDbShape(JSON.parse(raw));
  } catch {
    return defaultDb();
  }
}

function writeDbToFile(db) {
  mkdirSync(DATA_DIR, { recursive: true });
  const tmp = `${DB_FILE}.tmp`;
  writeFileSync(tmp, JSON.stringify(db, null, 2), 'utf8');
  renameSync(tmp, DB_FILE);
}

let mysqlPoolPromise = null;
let mysqlSchemaReady = false;
let mysqlHistoryLimitEnsured = false;
let mysqlUsersColumnsReady = false;
let mysqlCardsColumnsReady = false;
let mysqlHistoryColumnsReady = false;
let mysqlCommentsBackfilled = false;
let mysqlCommentsSchemaReady = false;
let mysqlCommentsArchiveSchemaReady = false;
let mysqlLegacyCommentsColumnDropped = false;
let mysqlImagesMigrated = false;
let mysqlMediaSchemaReady = false;
let mysqlMediaBackfilled = false;
let mediaGcTimer = null;
let mediaGcRunning = false;
let mediaGcPending = false;
const mediaGcKeepUntilById = new Map();
const rateLimitState = new Map();
let rateLimitLastPruneAtMs = 0;

async function getMysqlPool() {
  if (!MYSQL_URL) {
    throw new Error('MYSQL_URL is required when DB_PROVIDER=mysql');
  }

  if (!mysqlPoolPromise) {
    mysqlPoolPromise = import('mysql2/promise')
      .then((mysql) => mysql.createPool(MYSQL_URL))
      .catch((err) => {
        mysqlPoolPromise = null;
        throw new Error(
          `[db] mysql2 is required for MySQL mode. Run "npm install mysql2". ${String(err?.message ?? err)}`
        );
      });
  }

  return mysqlPoolPromise;
}

async function ensureMysqlSchema() {
  if (mysqlSchemaReady) return;
  const pool = await getMysqlPool();

  await pool.query(
    `CREATE TABLE IF NOT EXISTS ${MYSQL_USERS_TABLE} (
      id VARCHAR(64) NOT NULL PRIMARY KEY,
      login VARCHAR(64) NOT NULL,
      login_key VARCHAR(64) NOT NULL,
      email VARCHAR(255) NOT NULL,
      password_salt VARCHAR(255) NOT NULL,
      password_hash VARCHAR(255) NOT NULL,
      created_at_ms BIGINT NOT NULL,
      UNIQUE KEY uq_users_login_key (login_key),
      UNIQUE KEY uq_users_email (email)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`
  );
  await ensureMysqlUsersColumns(pool);

  await pool.query(
    `CREATE TABLE IF NOT EXISTS ${MYSQL_SESSIONS_TABLE} (
      token VARCHAR(128) NOT NULL PRIMARY KEY,
      user_id VARCHAR(64) NOT NULL,
      created_at_ms BIGINT NOT NULL,
      expires_at_ms BIGINT NOT NULL,
      KEY idx_sessions_user_id (user_id),
      KEY idx_sessions_expires_at_ms (expires_at_ms)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`
  );

  await pool.query(
    `CREATE TABLE IF NOT EXISTS ${MYSQL_CARDS_TABLE} (
      user_id VARCHAR(64) NOT NULL,
      id VARCHAR(64) NOT NULL,
      title VARCHAR(512) NOT NULL,
      description TEXT NOT NULL,
      images_json LONGTEXT NULL,
      checklist_json LONGTEXT NULL,
      created_by VARCHAR(64) NULL,
      created_at_ms BIGINT NOT NULL,
      urgency VARCHAR(16) NOT NULL,
      is_favorite TINYINT(1) NOT NULL DEFAULT 0,
      doing_started_at_ms BIGINT NULL,
      doing_total_ms BIGINT NOT NULL,
      PRIMARY KEY (user_id, id),
      KEY idx_cards_user_id (user_id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`
  );
  await ensureMysqlCardsColumns(pool);

  await pool.query(
    `CREATE TABLE IF NOT EXISTS ${MYSQL_COMMENTS_TABLE} (
      user_id VARCHAR(64) NOT NULL,
      card_id VARCHAR(64) NOT NULL,
      id VARCHAR(128) NOT NULL,
      author VARCHAR(64) NULL,
      text TEXT NOT NULL,
      images_json LONGTEXT NULL,
      created_at_ms BIGINT NOT NULL,
      updated_at_ms BIGINT NOT NULL,
      PRIMARY KEY (user_id, card_id, id),
      KEY idx_comments_user_card_created (user_id, card_id, created_at_ms, id),
      KEY idx_comments_user_created (user_id, created_at_ms),
      KEY idx_comments_user_created_id (user_id, created_at_ms, id),
      CONSTRAINT fk_card_comments_card
        FOREIGN KEY (user_id, card_id)
        REFERENCES ${MYSQL_CARDS_TABLE} (user_id, id)
        ON DELETE CASCADE
        ON UPDATE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`
  );
  await ensureMysqlCommentsSchema(pool);
  await pool.query(
    `CREATE TABLE IF NOT EXISTS ${MYSQL_COMMENTS_ARCHIVE_TABLE} (
      archive_id BIGINT NOT NULL AUTO_INCREMENT PRIMARY KEY,
      user_id VARCHAR(64) NOT NULL,
      card_id VARCHAR(64) NOT NULL,
      id VARCHAR(128) NOT NULL,
      author VARCHAR(64) NULL,
      text TEXT NOT NULL,
      images_json LONGTEXT NULL,
      created_at_ms BIGINT NOT NULL,
      updated_at_ms BIGINT NOT NULL,
      archived_at_ms BIGINT NOT NULL,
      archive_reason VARCHAR(32) NOT NULL,
      KEY idx_comments_archive_user_card_archived (user_id, card_id, archived_at_ms, archive_id),
      KEY idx_comments_archive_user_card_reason_archived (user_id, card_id, archive_reason, archived_at_ms, archive_id),
      KEY idx_comments_archive_user_archived (user_id, archived_at_ms, archive_id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`
  );
  await ensureMysqlCommentsArchiveSchema(pool);

  await pool.query(
    `CREATE TABLE IF NOT EXISTS ${MYSQL_COLUMNS_TABLE} (
      user_id VARCHAR(64) NOT NULL,
      column_id VARCHAR(16) NOT NULL,
      card_id VARCHAR(64) NOT NULL,
      sort_index INT NOT NULL,
      PRIMARY KEY (user_id, column_id, sort_index),
      UNIQUE KEY uq_columns_user_card (user_id, card_id),
      KEY idx_columns_user_column (user_id, column_id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`
  );

  await pool.query(
    `CREATE TABLE IF NOT EXISTS ${MYSQL_FLOATING_TABLE} (
      user_id VARCHAR(64) NOT NULL,
      card_id VARCHAR(64) NOT NULL,
      x INT NOT NULL,
      y INT NOT NULL,
      sway_offset_ms INT NOT NULL DEFAULT 0,
      PRIMARY KEY (user_id, card_id),
      KEY idx_floating_user_id (user_id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`
  );

  await pool.query(
    `CREATE TABLE IF NOT EXISTS ${MYSQL_HISTORY_TABLE} (
      id VARCHAR(64) NOT NULL PRIMARY KEY,
      user_id VARCHAR(64) NOT NULL,
      at_ms BIGINT NOT NULL,
      text TEXT NOT NULL,
      card_id VARCHAR(64) NULL,
      kind VARCHAR(16) NULL,
      meta_json JSON NULL,
      KEY idx_history_user_at (user_id, at_ms)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`
  );
  await pool.query(
    `CREATE TABLE IF NOT EXISTS ${MYSQL_BOARD_VERSIONS_TABLE} (
      user_id VARCHAR(64) NOT NULL PRIMARY KEY,
      version BIGINT NOT NULL DEFAULT 0,
      updated_at_ms BIGINT NOT NULL DEFAULT 0,
      CONSTRAINT fk_board_versions_user
        FOREIGN KEY (user_id)
        REFERENCES ${MYSQL_USERS_TABLE} (id)
        ON DELETE CASCADE
        ON UPDATE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`
  );
  await ensureMysqlHistoryColumns(pool);
  await ensureMysqlCommentsBackfill(pool);
  await cleanupMysqlLegacyCommentsColumn(pool);
  await ensureMysqlImageStorageMigration(pool);
  await ensureMysqlMediaSchema(pool);
  await ensureMysqlMediaBackfill(pool);
  mysqlSchemaReady = true;
}

async function ensureMysqlUsersColumns(pool) {
  if (mysqlUsersColumnsReady) return;

  const ensureColumn = async (name, definitionSql) => {
    const [rows] = await pool.query(
      `SELECT COUNT(*) AS cnt
       FROM information_schema.COLUMNS
       WHERE TABLE_SCHEMA = DATABASE()
         AND TABLE_NAME = ?
         AND COLUMN_NAME = ?`,
      [MYSQL_USERS_TABLE, name]
    );
    const count = Array.isArray(rows) && rows.length > 0 ? Number(rows[0].cnt ?? 0) : 0;
    if (count > 0) return;
    await pool.query(`ALTER TABLE ${MYSQL_USERS_TABLE} ADD COLUMN ${name} ${definitionSql}`);
  };

  await ensureColumn('avatar_data_url', 'LONGTEXT NULL AFTER created_at_ms');
  await ensureColumn('first_name', 'VARCHAR(96) NULL AFTER avatar_data_url');
  await ensureColumn('last_name', 'VARCHAR(96) NULL AFTER first_name');
  await ensureColumn('birth_date', 'VARCHAR(10) NULL AFTER last_name');
  await ensureColumn('role_title', 'VARCHAR(128) NULL AFTER birth_date');
  await ensureColumn('city_title', 'VARCHAR(128) NULL AFTER role_title');
  await ensureColumn('bio', 'TEXT NULL AFTER city_title');

  mysqlUsersColumnsReady = true;
}

async function ensureMysqlCardsColumns(pool) {
  if (mysqlCardsColumnsReady) return;

  const ensureColumn = async (name, definitionSql) => {
    const [rows] = await pool.query(
      `SELECT COUNT(*) AS cnt
       FROM information_schema.COLUMNS
       WHERE TABLE_SCHEMA = DATABASE()
         AND TABLE_NAME = ?
         AND COLUMN_NAME = ?`,
      [MYSQL_CARDS_TABLE, name]
    );
    const count = Array.isArray(rows) && rows.length > 0 ? Number(rows[0].cnt ?? 0) : 0;
    if (count === 0) {
      await pool.query(`ALTER TABLE ${MYSQL_CARDS_TABLE} ADD COLUMN ${name} ${definitionSql}`);
    }
  };

  await ensureColumn('images_json', 'LONGTEXT NULL AFTER description');
  await ensureColumn('checklist_json', 'LONGTEXT NULL AFTER images_json');
  await ensureColumn('created_by', 'VARCHAR(64) NULL AFTER checklist_json');
  await ensureColumn('is_favorite', 'TINYINT(1) NOT NULL DEFAULT 0 AFTER urgency');

  mysqlCardsColumnsReady = true;
}

async function ensureMysqlHistoryColumns(pool) {
  if (mysqlHistoryColumnsReady) return;

  const ensureColumn = async (name, definitionSql) => {
    const [rows] = await pool.query(
      `SELECT COUNT(*) AS cnt
       FROM information_schema.COLUMNS
       WHERE TABLE_SCHEMA = DATABASE()
         AND TABLE_NAME = ?
         AND COLUMN_NAME = ?`,
      [MYSQL_HISTORY_TABLE, name]
    );
    const count = Array.isArray(rows) && rows.length > 0 ? Number(rows[0].cnt ?? 0) : 0;
    if (count > 0) return;

    await pool.query(`ALTER TABLE ${MYSQL_HISTORY_TABLE} ADD COLUMN ${name} ${definitionSql}`);
  };

  await ensureColumn('kind', 'VARCHAR(16) NULL AFTER card_id');
  await ensureColumn('meta_json', 'JSON NULL AFTER kind');
  mysqlHistoryColumnsReady = true;
}

async function ensureMysqlCommentsBackfill(pool) {
  if (mysqlCommentsBackfilled) return;

  const [legacyColumnRows] = await pool.query(
    `SELECT COUNT(*) AS cnt
     FROM information_schema.COLUMNS
     WHERE TABLE_SCHEMA = DATABASE()
       AND TABLE_NAME = ?
       AND COLUMN_NAME = 'comments_json'`,
    [MYSQL_CARDS_TABLE]
  );
  const hasLegacyCommentsColumn =
    Array.isArray(legacyColumnRows) && legacyColumnRows.length > 0
      ? Number(legacyColumnRows[0].cnt ?? 0) > 0
      : false;
  if (!hasLegacyCommentsColumn) {
    mysqlCommentsBackfilled = true;
    return;
  }

  const [rows] = await pool.query(
    `SELECT user_id, id AS card_id, comments_json
     FROM ${MYSQL_CARDS_TABLE}
     WHERE comments_json IS NOT NULL`
  );

  for (const row of Array.isArray(rows) ? rows : []) {
    const userId = String(row.user_id ?? '').trim();
    const cardId = String(row.card_id ?? '').trim();
    if (!userId || !cardId) continue;

    let parsedComments = [];
    try {
      if (row.comments_json == null) parsedComments = [];
      else if (Buffer.isBuffer(row.comments_json)) parsedComments = JSON.parse(row.comments_json.toString('utf8'));
      else if (typeof row.comments_json === 'string') parsedComments = JSON.parse(row.comments_json);
      else parsedComments = row.comments_json;
    } catch {
      parsedComments = [];
    }

    const comments = sanitizeComments(parsedComments);
    for (const comment of comments) {
      await pool.query(
        `INSERT INTO ${MYSQL_COMMENTS_TABLE}
          (user_id, card_id, id, author, text, images_json, created_at_ms, updated_at_ms)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON DUPLICATE KEY UPDATE
            id = id`,
        [
          userId,
          cardId,
          comment.id,
          sanitizeCommentAuthor(comment.author),
          comment.text,
          encodeCommentImagesForDb(comment.images),
          comment.createdAt,
          comment.updatedAt ?? comment.createdAt,
        ]
      );
    }
  }

  mysqlCommentsBackfilled = true;
}

async function cleanupMysqlLegacyCommentsColumn(pool) {
  if (mysqlLegacyCommentsColumnDropped) return;

  const [rows] = await pool.query(
    `SELECT COUNT(*) AS cnt
     FROM information_schema.COLUMNS
     WHERE TABLE_SCHEMA = DATABASE()
       AND TABLE_NAME = ?
       AND COLUMN_NAME = 'comments_json'`,
    [MYSQL_CARDS_TABLE]
  );
  const hasLegacyCommentsColumn =
    Array.isArray(rows) && rows.length > 0 ? Number(rows[0].cnt ?? 0) > 0 : false;
  if (hasLegacyCommentsColumn) {
    await pool.query(`ALTER TABLE ${MYSQL_CARDS_TABLE} DROP COLUMN comments_json`);
  }

  mysqlLegacyCommentsColumnDropped = true;
}

async function ensureMysqlCommentsSchema(pool) {
  if (mysqlCommentsSchemaReady) return;

  const ensureColumn = async (name, definitionSql) => {
    const [rows] = await pool.query(
      `SELECT COUNT(*) AS cnt
       FROM information_schema.COLUMNS
       WHERE TABLE_SCHEMA = DATABASE()
         AND TABLE_NAME = ?
         AND COLUMN_NAME = ?`,
      [MYSQL_COMMENTS_TABLE, name]
    );
    const count = Array.isArray(rows) && rows.length > 0 ? Number(rows[0].cnt ?? 0) : 0;
    if (count > 0) return;
    await pool.query(`ALTER TABLE ${MYSQL_COMMENTS_TABLE} ADD COLUMN ${name} ${definitionSql}`);
  };
  const ensureIndex = async (name, columnsSql) => {
    const [rows] = await pool.query(
      `SELECT COUNT(*) AS cnt
       FROM information_schema.STATISTICS
       WHERE TABLE_SCHEMA = DATABASE()
         AND TABLE_NAME = ?
         AND INDEX_NAME = ?`,
      [MYSQL_COMMENTS_TABLE, name]
    );
    const count = Array.isArray(rows) && rows.length > 0 ? Number(rows[0].cnt ?? 0) : 0;
    if (count > 0) return;
    await pool.query(`ALTER TABLE ${MYSQL_COMMENTS_TABLE} ADD KEY ${name} (${columnsSql})`);
  };

  await ensureColumn('updated_at_ms', 'BIGINT NOT NULL DEFAULT 0 AFTER created_at_ms');
  await ensureColumn('images_json', 'LONGTEXT NULL AFTER text');
  await pool.query(
    `UPDATE ${MYSQL_COMMENTS_TABLE}
     SET updated_at_ms = created_at_ms
     WHERE updated_at_ms IS NULL OR updated_at_ms <= 0`
  );

  await pool.query(
    `DELETE cc
     FROM ${MYSQL_COMMENTS_TABLE} cc
     LEFT JOIN ${MYSQL_CARDS_TABLE} c
       ON c.user_id = cc.user_id AND c.id = cc.card_id
     WHERE c.id IS NULL`
  );

  const [fkRows] = await pool.query(
    `SELECT COUNT(*) AS cnt
     FROM information_schema.REFERENTIAL_CONSTRAINTS
     WHERE CONSTRAINT_SCHEMA = DATABASE()
       AND CONSTRAINT_NAME = 'fk_card_comments_card'
       AND TABLE_NAME = ?`,
    [MYSQL_COMMENTS_TABLE]
  );
  const hasFk = Array.isArray(fkRows) && fkRows.length > 0 ? Number(fkRows[0].cnt ?? 0) > 0 : false;
  if (!hasFk) {
    await pool.query(
      `ALTER TABLE ${MYSQL_COMMENTS_TABLE}
       ADD CONSTRAINT fk_card_comments_card
       FOREIGN KEY (user_id, card_id)
       REFERENCES ${MYSQL_CARDS_TABLE} (user_id, id)
       ON DELETE CASCADE
       ON UPDATE CASCADE`
    );
  }
  await ensureIndex('idx_comments_user_created_id', 'user_id, created_at_ms, id');

  mysqlCommentsSchemaReady = true;
}

async function ensureMysqlCommentsArchiveSchema(pool) {
  if (mysqlCommentsArchiveSchemaReady) return;

  const ensureColumn = async (name, definitionSql) => {
    const [rows] = await pool.query(
      `SELECT COUNT(*) AS cnt
       FROM information_schema.COLUMNS
       WHERE TABLE_SCHEMA = DATABASE()
         AND TABLE_NAME = ?
         AND COLUMN_NAME = ?`,
      [MYSQL_COMMENTS_ARCHIVE_TABLE, name]
    );
    const count = Array.isArray(rows) && rows.length > 0 ? Number(rows[0].cnt ?? 0) : 0;
    if (count > 0) return;
    await pool.query(`ALTER TABLE ${MYSQL_COMMENTS_ARCHIVE_TABLE} ADD COLUMN ${name} ${definitionSql}`);
  };

  const ensureIndex = async (name, columnsSql) => {
    const [rows] = await pool.query(
      `SELECT COUNT(*) AS cnt
       FROM information_schema.STATISTICS
       WHERE TABLE_SCHEMA = DATABASE()
         AND TABLE_NAME = ?
         AND INDEX_NAME = ?`,
      [MYSQL_COMMENTS_ARCHIVE_TABLE, name]
    );
    const count = Array.isArray(rows) && rows.length > 0 ? Number(rows[0].cnt ?? 0) : 0;
    if (count > 0) return;
    await pool.query(`ALTER TABLE ${MYSQL_COMMENTS_ARCHIVE_TABLE} ADD KEY ${name} (${columnsSql})`);
  };

  await ensureColumn('images_json', 'LONGTEXT NULL AFTER text');
  await ensureColumn('created_at_ms', 'BIGINT NOT NULL DEFAULT 0 AFTER images_json');
  await ensureColumn('updated_at_ms', 'BIGINT NOT NULL DEFAULT 0 AFTER created_at_ms');
  await ensureColumn('archived_at_ms', 'BIGINT NOT NULL DEFAULT 0 AFTER updated_at_ms');
  await ensureColumn('archive_reason', "VARCHAR(32) NOT NULL DEFAULT 'unknown' AFTER archived_at_ms");

  await ensureIndex('idx_comments_archive_user_card_archived', 'user_id, card_id, archived_at_ms, archive_id');
  await ensureIndex(
    'idx_comments_archive_user_card_reason_archived',
    'user_id, card_id, archive_reason, archived_at_ms, archive_id'
  );
  await ensureIndex('idx_comments_archive_user_archived', 'user_id, archived_at_ms, archive_id');

  mysqlCommentsArchiveSchemaReady = true;
}

async function ensureMysqlImageStorageMigration(pool) {
  if (mysqlImagesMigrated) return;

  const migrateRows = async (selectSql, updateSql, buildParams) => {
    const [rows] = await pool.query(selectSql);
    for (const row of Array.isArray(rows) ? rows : []) {
      const rawJson = row?.images_json;
      if (rawJson == null) continue;
      const source =
        Buffer.isBuffer(rawJson)
          ? rawJson.toString('utf8')
          : typeof rawJson === 'string'
            ? rawJson
            : JSON.stringify(rawJson);
      if (!source) continue;
      if (!source.includes('data:image/') && !source.includes('"dataUrl"')) continue;

      const next = encodeCardImagesForDb(parseCardImagesFromDb(rawJson));
      await pool.query(updateSql, buildParams(row, next));
    }
  };

  await migrateRows(
    `SELECT user_id, id, images_json
     FROM ${MYSQL_CARDS_TABLE}
     WHERE images_json IS NOT NULL`,
    `UPDATE ${MYSQL_CARDS_TABLE}
     SET images_json = ?
     WHERE user_id = ? AND id = ?`,
    (row, next) => [next, String(row.user_id ?? '').trim(), String(row.id ?? '').trim()]
  );

  await migrateRows(
    `SELECT user_id, card_id, id, images_json
     FROM ${MYSQL_COMMENTS_TABLE}
     WHERE images_json IS NOT NULL`,
    `UPDATE ${MYSQL_COMMENTS_TABLE}
     SET images_json = ?
     WHERE user_id = ? AND card_id = ? AND id = ?`,
    (row, next) => [
      next,
      String(row.user_id ?? '').trim(),
      String(row.card_id ?? '').trim(),
      String(row.id ?? '').trim(),
    ]
  );

  mysqlImagesMigrated = true;
}

function normalizeMediaLinkOwnerKind(value) {
  const raw = String(value ?? '')
    .trim()
    .toLowerCase();
  return MEDIA_LINK_OWNER_KIND_SET.has(raw) ? raw : null;
}

function normalizeMediaLinkCommentRef(value, ownerKind = 'comment') {
  const kind = normalizeMediaLinkOwnerKind(ownerKind) ?? 'comment';
  if (kind === 'card') return '';
  const raw = String(value ?? '').trim();
  if (!raw) return '';
  return raw.slice(0, 128);
}

function mediaLinkRowsFromImages(ownerKind, cardId, commentRef, rawImages) {
  const kind = normalizeMediaLinkOwnerKind(ownerKind);
  const normalizedCardId = String(cardId ?? '').trim().slice(0, 64);
  const normalizedCommentRef = normalizeMediaLinkCommentRef(commentRef, kind);
  if (!kind || !normalizedCardId) return [];

  const images = sanitizeCardImages(rawImages);
  const rows = [];
  for (let i = 0; i < images.length; i += 1) {
    const image = images[i];
    const imageId = sanitizeText(image.id, 128);
    if (!imageId) continue;
    const fileId = normalizeMediaId(image.fileId ?? extractMediaIdFromUrl(image.dataUrl));
    if (!fileId) continue;
    const mime = normalizeCardImageMime(image.mime) ?? mediaMimeFromId(fileId, null);
    if (!mime) continue;
    const previewFileId = normalizeMediaId(image.previewFileId ?? extractMediaIdFromUrl(image.previewUrl));
    const previewMime = previewFileId
      ? normalizeCardImageMime(image.previewMime) ?? mediaMimeFromId(previewFileId, null)
      : null;
    rows.push({
      ownerKind: kind,
      cardId: normalizedCardId,
      commentRef: normalizedCommentRef,
      imageId,
      sortIndex: i,
      fileId,
      mime,
      size: normalizeCardImageSize(image.size, 1),
      name: sanitizeText(image.name, MAX_CARD_IMAGE_NAME_LEN) || null,
      createdAt: Number.isFinite(Number(image.createdAt)) ? Math.max(0, Math.trunc(Number(image.createdAt))) : Date.now(),
      previewFileId: previewFileId ?? null,
      previewMime: previewMime ?? null,
      previewSize: previewFileId ? normalizeCardImageSize(image.previewSize, 1) : null,
    });
  }
  return rows;
}

function collectMediaFileRowsFromLinks(userId, linkRows) {
  const normalizedUserId = String(userId ?? '').trim();
  const out = new Map();
  const upsert = (mediaId, mime, size, createdAt) => {
    const normalizedMediaId = normalizeMediaId(mediaId);
    const normalizedMime = normalizeCardImageMime(mime);
    if (!normalizedMediaId || !normalizedMime) return;
    const normalizedSize = normalizeCardImageSize(size, 1);
    const normalizedCreatedAt = Number.isFinite(Number(createdAt))
      ? Math.max(0, Math.trunc(Number(createdAt)))
      : Date.now();
    const prev = out.get(normalizedMediaId);
    if (prev) {
      prev.mime = normalizedMime || prev.mime;
      prev.size = Math.max(prev.size, normalizedSize);
      prev.updatedAt = Date.now();
      return;
    }
    out.set(normalizedMediaId, {
      userId: normalizedUserId,
      mediaId: normalizedMediaId,
      mime: normalizedMime,
      size: normalizedSize,
      createdAt: normalizedCreatedAt,
      updatedAt: Date.now(),
    });
  };

  for (const row of Array.isArray(linkRows) ? linkRows : []) {
    if (!row || typeof row !== 'object') continue;
    upsert(row.fileId, row.mime, row.size, row.createdAt);
    if (row.previewFileId) {
      upsert(row.previewFileId, row.previewMime ?? mediaMimeFromId(row.previewFileId, null), row.previewSize ?? 1, row.createdAt);
    }
  }

  return [...out.values()];
}

async function mysqlInsertMediaLinkRows(executor, userId, linkRows) {
  const normalizedUserId = String(userId ?? '').trim();
  if (!normalizedUserId) return 0;
  const rows = Array.isArray(linkRows) ? linkRows : [];
  if (rows.length === 0) return 0;

  let inserted = 0;
  const chunkSize = 200;
  for (let offset = 0; offset < rows.length; offset += chunkSize) {
    const chunk = rows.slice(offset, offset + chunkSize);
    if (chunk.length === 0) continue;
    const placeholders = chunk
      .map(
        () =>
          '(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
      )
      .join(', ');
    const params = [];
    for (const row of chunk) {
      params.push(
        normalizedUserId,
        row.ownerKind,
        row.cardId,
        row.commentRef,
        row.imageId,
        row.sortIndex,
        row.fileId,
        row.mime,
        row.size,
        row.name,
        row.createdAt,
        row.previewFileId,
        row.previewMime,
        row.previewSize
      );
    }
    await executor.query(
      `INSERT INTO ${MYSQL_MEDIA_LINKS_TABLE}
        (user_id, owner_kind, card_id, comment_id, image_id, sort_index, file_id, mime, size, name, created_at_ms, preview_file_id, preview_mime, preview_size)
       VALUES ${placeholders}
       ON DUPLICATE KEY UPDATE
         sort_index = VALUES(sort_index),
         file_id = VALUES(file_id),
         mime = VALUES(mime),
         size = VALUES(size),
         name = VALUES(name),
         created_at_ms = VALUES(created_at_ms),
         preview_file_id = VALUES(preview_file_id),
         preview_mime = VALUES(preview_mime),
         preview_size = VALUES(preview_size)`,
      params
    );
    inserted += chunk.length;
  }
  return inserted;
}

async function mysqlUpsertMediaFiles(executor, fileRows) {
  const rows = Array.isArray(fileRows) ? fileRows : [];
  if (rows.length === 0) return 0;
  let upserted = 0;
  const chunkSize = 200;
  for (let offset = 0; offset < rows.length; offset += chunkSize) {
    const chunk = rows.slice(offset, offset + chunkSize);
    if (chunk.length === 0) continue;
    const placeholders = chunk.map(() => '(?, ?, ?, ?, ?, ?)').join(', ');
    const params = [];
    for (const row of chunk) {
      params.push(row.userId, row.mediaId, row.mime, row.size, row.createdAt, row.updatedAt);
    }
    await executor.query(
      `INSERT INTO ${MYSQL_MEDIA_FILES_TABLE}
        (user_id, media_id, mime, size, created_at_ms, updated_at_ms)
       VALUES ${placeholders}
       ON DUPLICATE KEY UPDATE
         mime = VALUES(mime),
         size = VALUES(size),
         updated_at_ms = VALUES(updated_at_ms)`,
      params
    );
    upserted += chunk.length;
  }
  return upserted;
}

async function mysqlDeleteMediaLinksForOwner(executor, userId, ownerKind, cardId, commentRef = '') {
  const kind = normalizeMediaLinkOwnerKind(ownerKind);
  const normalizedUserId = String(userId ?? '').trim();
  const normalizedCardId = String(cardId ?? '').trim().slice(0, 64);
  const normalizedCommentRef = normalizeMediaLinkCommentRef(commentRef, kind);
  if (!kind || !normalizedUserId || !normalizedCardId) return 0;
  const [result] = await executor.query(
    `DELETE FROM ${MYSQL_MEDIA_LINKS_TABLE}
     WHERE user_id = ? AND owner_kind = ? AND card_id = ? AND comment_id = ?`,
    [normalizedUserId, kind, normalizedCardId, normalizedCommentRef]
  );
  return Number(result?.affectedRows ?? 0);
}

async function mysqlDeleteMediaLinksByCard(executor, userId, cardId, ownerKinds = ['card', 'comment']) {
  const normalizedUserId = String(userId ?? '').trim();
  const normalizedCardId = String(cardId ?? '').trim().slice(0, 64);
  const kinds = (Array.isArray(ownerKinds) ? ownerKinds : [ownerKinds])
    .map((k) => normalizeMediaLinkOwnerKind(k))
    .filter((k) => !!k);
  if (!normalizedUserId || !normalizedCardId || kinds.length === 0) return 0;
  const placeholders = kinds.map(() => '?').join(', ');
  const [result] = await executor.query(
    `DELETE FROM ${MYSQL_MEDIA_LINKS_TABLE}
     WHERE user_id = ? AND card_id = ? AND owner_kind IN (${placeholders})`,
    [normalizedUserId, normalizedCardId, ...kinds]
  );
  return Number(result?.affectedRows ?? 0);
}

async function mysqlReplaceMediaLinksForOwner(executor, userId, ownerKind, cardId, commentRef, rawImages) {
  const kind = normalizeMediaLinkOwnerKind(ownerKind);
  const normalizedUserId = String(userId ?? '').trim();
  const normalizedCardId = String(cardId ?? '').trim().slice(0, 64);
  if (!kind || !normalizedUserId || !normalizedCardId) return 0;

  const normalizedCommentRef = normalizeMediaLinkCommentRef(commentRef, kind);
  await mysqlDeleteMediaLinksForOwner(executor, normalizedUserId, kind, normalizedCardId, normalizedCommentRef);
  const linkRows = mediaLinkRowsFromImages(kind, normalizedCardId, normalizedCommentRef, rawImages);
  if (linkRows.length > 0) {
    await mysqlInsertMediaLinkRows(executor, normalizedUserId, linkRows);
    const fileRows = collectMediaFileRowsFromLinks(normalizedUserId, linkRows);
    if (fileRows.length > 0) {
      await mysqlUpsertMediaFiles(executor, fileRows);
    }
  }
  return linkRows.length;
}

async function mysqlDeleteOrphanArchivedMediaLinks(executor, userId = null) {
  const normalizedUserId = userId == null ? null : String(userId ?? '').trim();
  if (normalizedUserId) {
    const [result] = await executor.query(
      `DELETE ml
       FROM ${MYSQL_MEDIA_LINKS_TABLE} ml
       LEFT JOIN ${MYSQL_COMMENTS_ARCHIVE_TABLE} arc
         ON arc.user_id = ml.user_id
        AND arc.card_id = ml.card_id
        AND CONCAT('a:', CAST(arc.archive_id AS CHAR)) = ml.comment_id
       WHERE ml.owner_kind = 'comment_archive'
         AND ml.user_id = ?
         AND arc.archive_id IS NULL`,
      [normalizedUserId]
    );
    return Number(result?.affectedRows ?? 0);
  }

  const [result] = await executor.query(
    `DELETE ml
     FROM ${MYSQL_MEDIA_LINKS_TABLE} ml
     LEFT JOIN ${MYSQL_COMMENTS_ARCHIVE_TABLE} arc
       ON arc.user_id = ml.user_id
      AND arc.card_id = ml.card_id
      AND CONCAT('a:', CAST(arc.archive_id AS CHAR)) = ml.comment_id
     WHERE ml.owner_kind = 'comment_archive'
       AND arc.archive_id IS NULL`
  );
  return Number(result?.affectedRows ?? 0);
}

async function mysqlPruneUnlinkedMediaFiles(executor, userId = null) {
  const normalizedUserId = userId == null ? null : String(userId ?? '').trim();
  if (normalizedUserId) {
    const [result] = await executor.query(
      `DELETE mf
       FROM ${MYSQL_MEDIA_FILES_TABLE} mf
       LEFT JOIN (
         SELECT user_id, file_id AS media_id
         FROM ${MYSQL_MEDIA_LINKS_TABLE}
         WHERE user_id = ?
         UNION
         SELECT user_id, preview_file_id AS media_id
         FROM ${MYSQL_MEDIA_LINKS_TABLE}
         WHERE user_id = ? AND preview_file_id IS NOT NULL
       ) used
         ON used.user_id = mf.user_id
        AND used.media_id = mf.media_id
       WHERE mf.user_id = ?
         AND used.media_id IS NULL`,
      [normalizedUserId, normalizedUserId, normalizedUserId]
    );
    return Number(result?.affectedRows ?? 0);
  }

  const [result] = await executor.query(
    `DELETE mf
     FROM ${MYSQL_MEDIA_FILES_TABLE} mf
     LEFT JOIN (
       SELECT user_id, file_id AS media_id
       FROM ${MYSQL_MEDIA_LINKS_TABLE}
       UNION
       SELECT user_id, preview_file_id AS media_id
       FROM ${MYSQL_MEDIA_LINKS_TABLE}
       WHERE preview_file_id IS NOT NULL
     ) used
       ON used.user_id = mf.user_id
      AND used.media_id = mf.media_id
     WHERE used.media_id IS NULL`
  );
  return Number(result?.affectedRows ?? 0);
}

async function mysqlRebuildMediaIndexForUser(executor, userId) {
  const normalizedUserId = String(userId ?? '').trim();
  if (!normalizedUserId) return;

  await executor.query(`DELETE FROM ${MYSQL_MEDIA_LINKS_TABLE} WHERE user_id = ?`, [normalizedUserId]);

  const linkRows = [];
  const [cardRows] = await executor.query(
    `SELECT id, images_json
     FROM ${MYSQL_CARDS_TABLE}
     WHERE user_id = ? AND images_json IS NOT NULL`,
    [normalizedUserId]
  );
  for (const row of Array.isArray(cardRows) ? cardRows : []) {
    linkRows.push(...mediaLinkRowsFromImages('card', String(row?.id ?? '').trim(), '', parseCardImagesFromDb(row?.images_json)));
  }

  const [commentRows] = await executor.query(
    `SELECT card_id, id, images_json
     FROM ${MYSQL_COMMENTS_TABLE}
     WHERE user_id = ? AND images_json IS NOT NULL`,
    [normalizedUserId]
  );
  for (const row of Array.isArray(commentRows) ? commentRows : []) {
    linkRows.push(
      ...mediaLinkRowsFromImages(
        'comment',
        String(row?.card_id ?? '').trim(),
        String(row?.id ?? '').trim(),
        parseCommentImagesFromDb(row?.images_json)
      )
    );
  }

  const [archiveRows] = await executor.query(
    `SELECT archive_id, card_id, images_json
     FROM ${MYSQL_COMMENTS_ARCHIVE_TABLE}
     WHERE user_id = ? AND images_json IS NOT NULL`,
    [normalizedUserId]
  );
  for (const row of Array.isArray(archiveRows) ? archiveRows : []) {
    const archiveRef = `a:${Math.max(0, Math.trunc(Number(row?.archive_id) || 0))}`;
    linkRows.push(
      ...mediaLinkRowsFromImages(
        'comment_archive',
        String(row?.card_id ?? '').trim(),
        archiveRef,
        parseCommentImagesFromDb(row?.images_json)
      )
    );
  }

  if (linkRows.length > 0) {
    await mysqlInsertMediaLinkRows(executor, normalizedUserId, linkRows);
    const fileRows = collectMediaFileRowsFromLinks(normalizedUserId, linkRows);
    if (fileRows.length > 0) {
      await mysqlUpsertMediaFiles(executor, fileRows);
    }
  }

  await mysqlDeleteOrphanArchivedMediaLinks(executor, normalizedUserId);
  await mysqlPruneUnlinkedMediaFiles(executor, normalizedUserId);
}

async function ensureMysqlMediaSchema(pool) {
  if (mysqlMediaSchemaReady) return;

  await pool.query(
    `CREATE TABLE IF NOT EXISTS ${MYSQL_MEDIA_FILES_TABLE} (
      user_id VARCHAR(64) NOT NULL,
      media_id VARCHAR(160) NOT NULL,
      mime VARCHAR(64) NOT NULL,
      size INT NOT NULL,
      created_at_ms BIGINT NOT NULL,
      updated_at_ms BIGINT NOT NULL,
      PRIMARY KEY (user_id, media_id),
      KEY idx_media_files_user_id (user_id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`
  );

  await pool.query(
    `CREATE TABLE IF NOT EXISTS ${MYSQL_MEDIA_LINKS_TABLE} (
      user_id VARCHAR(64) NOT NULL,
      owner_kind VARCHAR(24) NOT NULL,
      card_id VARCHAR(64) NOT NULL,
      comment_id VARCHAR(128) NOT NULL DEFAULT '',
      image_id VARCHAR(128) NOT NULL,
      sort_index INT NOT NULL,
      file_id VARCHAR(160) NOT NULL,
      mime VARCHAR(64) NOT NULL,
      size INT NOT NULL,
      name VARCHAR(128) NULL,
      created_at_ms BIGINT NOT NULL,
      preview_file_id VARCHAR(160) NULL,
      preview_mime VARCHAR(64) NULL,
      preview_size INT NULL,
      PRIMARY KEY (user_id, owner_kind, card_id, comment_id, image_id),
      KEY idx_media_links_user_owner (user_id, owner_kind, card_id, comment_id, sort_index),
      KEY idx_media_links_user_file (user_id, file_id),
      KEY idx_media_links_user_preview_file (user_id, preview_file_id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`
  );

  mysqlMediaSchemaReady = true;
}

async function ensureMysqlMediaBackfill(pool) {
  if (mysqlMediaBackfilled) return;
  await ensureMysqlMediaSchema(pool);

  const [linkCountRows] = await pool.query(`SELECT COUNT(*) AS cnt FROM ${MYSQL_MEDIA_LINKS_TABLE}`);
  const linksCount = Array.isArray(linkCountRows) && linkCountRows.length > 0 ? Number(linkCountRows[0].cnt ?? 0) : 0;
  if (linksCount > 0) {
    mysqlMediaBackfilled = true;
    return;
  }

  const [sourceRows] = await pool.query(
    `SELECT (
       (SELECT COUNT(*) FROM ${MYSQL_CARDS_TABLE} WHERE images_json IS NOT NULL) +
       (SELECT COUNT(*) FROM ${MYSQL_COMMENTS_TABLE} WHERE images_json IS NOT NULL) +
       (SELECT COUNT(*) FROM ${MYSQL_COMMENTS_ARCHIVE_TABLE} WHERE images_json IS NOT NULL)
     ) AS cnt`
  );
  const sourceCount = Array.isArray(sourceRows) && sourceRows.length > 0 ? Number(sourceRows[0].cnt ?? 0) : 0;
  if (sourceCount <= 0) {
    mysqlMediaBackfilled = true;
    return;
  }

  const [userRows] = await pool.query(
    `SELECT DISTINCT user_id
     FROM (
       SELECT user_id FROM ${MYSQL_CARDS_TABLE} WHERE images_json IS NOT NULL
       UNION ALL
       SELECT user_id FROM ${MYSQL_COMMENTS_TABLE} WHERE images_json IS NOT NULL
       UNION ALL
       SELECT user_id FROM ${MYSQL_COMMENTS_ARCHIVE_TABLE} WHERE images_json IS NOT NULL
     ) src`
  );
  for (const row of Array.isArray(userRows) ? userRows : []) {
    const userId = String(row?.user_id ?? '').trim();
    if (!userId) continue;
    await mysqlRebuildMediaIndexForUser(pool, userId);
  }

  mysqlMediaBackfilled = true;
}

function normalizeUserEntity(raw) {
  const id = String(raw?.id ?? '').trim();
  if (!id) return null;
  return {
    id,
    login: normalizeLogin(raw.login),
    email: normalizeEmail(raw.email),
    passwordSalt: String(raw.passwordSalt ?? ''),
    passwordHash: String(raw.passwordHash ?? ''),
    createdAt: Number.isFinite(Number(raw.createdAt)) ? Number(raw.createdAt) : Date.now(),
    avatarUrl: sanitizeProfileAvatarUrl(raw.avatarUrl ?? raw.avatarDataUrl),
    firstName: sanitizeProfileName(raw.firstName, MAX_PROFILE_FIRST_NAME_LEN),
    lastName: sanitizeProfileName(raw.lastName, MAX_PROFILE_LAST_NAME_LEN),
    birthDate: sanitizeProfileBirthDate(raw.birthDate),
    role: sanitizeProfileRole(raw.role),
    city: sanitizeProfileCity(raw.city ?? raw.cityTitle),
    about: sanitizeProfileAbout(raw.about),
  };
}

function lettersOnly(input) {
  return String(input ?? '').replace(/[^A-Za-zА-Яа-яЁё]+/gu, '');
}

function fallbackLoginFromEmailOrId(email, userId) {
  const local = normalizeEmail(email).split('@')[0] || '';
  const merged = `${lettersOnly(local)}${lettersOnly(userId)}`;
  const base = merged || 'User';
  return base.slice(0, 32);
}

function alphaSuffix(index) {
  const alphabet = 'abcdefghijklmnopqrstuvwxyz';
  let n = Number(index);
  let out = '';
  while (n > 0) {
    n -= 1;
    out = `${alphabet[n % 26]}${out}`;
    n = Math.floor(n / 26);
  }
  return out || 'a';
}

function makeUniqueLogin(baseLogin, usedLoginKeys) {
  let base = normalizeLogin(baseLogin);
  if (!isValidLogin(base)) base = fallbackLoginFromEmailOrId('', '');
  base = base.slice(0, 32);
  if (!base) base = 'User';

  let attempt = 0;
  while (attempt < 10000) {
    const suffix = attempt === 0 ? '' : alphaSuffix(attempt);
    const maxBaseLen = Math.max(1, 32 - suffix.length);
    const candidate = `${base.slice(0, maxBaseLen)}${suffix}`;
    const key = loginKey(candidate);
    if (!usedLoginKeys.has(key)) {
      usedLoginKeys.add(key);
      return candidate;
    }
    attempt += 1;
  }
  const fallback = `User${randomUUID().replace(/[^A-Za-z]/g, '').slice(0, 8) || 'a'}`;
  const key = loginKey(fallback);
  usedLoginKeys.add(key);
  return fallback;
}

function fallbackEmailFromUserId(userId) {
  const base = String(userId ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '')
    .slice(0, 24);
  return `${base || randomUUID().replace(/-/g, '').slice(0, 12)}@local.invalid`;
}

function makeUniqueEmail(baseEmail, userId, usedEmails) {
  let email = normalizeEmail(baseEmail);
  if (!isValidEmail(email)) {
    email = fallbackEmailFromUserId(userId);
  }

  if (!usedEmails.has(email)) {
    usedEmails.add(email);
    return email;
  }

  const at = email.indexOf('@');
  const local = at > 0 ? email.slice(0, at) : fallbackEmailFromUserId(userId).split('@')[0];
  const domain = at > 0 ? email.slice(at) : '@local.invalid';

  let n = 1;
  while (n < 100000) {
    const candidate = `${local}+${n}${domain}`;
    if (!usedEmails.has(candidate)) {
      usedEmails.add(candidate);
      return candidate;
    }
    n += 1;
  }

  const fallback = `${fallbackEmailFromUserId(userId).split('@')[0]}+${Date.now()}@local.invalid`;
  usedEmails.add(fallback);
  return fallback;
}

function normalizeSessionEntity(raw, validUserIds) {
  const token = String(raw?.token ?? '').trim();
  const userId = String(raw?.userId ?? '').trim();
  if (!token || !userId || !validUserIds.has(userId)) return null;
  return {
    token,
    userId,
    createdAt: Number.isFinite(Number(raw.createdAt)) ? Number(raw.createdAt) : Date.now(),
    expiresAt: Number.isFinite(Number(raw.expiresAt)) ? Number(raw.expiresAt) : Date.now() + SESSION_TTL_MS,
  };
}

async function mysqlHasNormalizedData(pool) {
  const [rows] = await pool.query(
    `SELECT
      (SELECT COUNT(*) FROM ${MYSQL_USERS_TABLE}) AS users_count,
      (SELECT COUNT(*) FROM ${MYSQL_SESSIONS_TABLE}) AS sessions_count,
      (SELECT COUNT(*) FROM ${MYSQL_CARDS_TABLE}) AS cards_count,
      (SELECT COUNT(*) FROM ${MYSQL_COMMENTS_TABLE}) AS comments_count,
      (SELECT COUNT(*) FROM ${MYSQL_COMMENTS_ARCHIVE_TABLE}) AS comments_archive_count,
      (SELECT COUNT(*) FROM ${MYSQL_COLUMNS_TABLE}) AS columns_count,
      (SELECT COUNT(*) FROM ${MYSQL_FLOATING_TABLE}) AS floating_count,
      (SELECT COUNT(*) FROM ${MYSQL_HISTORY_TABLE}) AS history_count`
  );
  const row = Array.isArray(rows) && rows.length > 0 ? rows[0] : null;
  if (!row) return false;
  const total =
    Number(row.users_count || 0) +
    Number(row.sessions_count || 0) +
    Number(row.cards_count || 0) +
    Number(row.comments_count || 0) +
    Number(row.comments_archive_count || 0) +
    Number(row.columns_count || 0) +
    Number(row.floating_count || 0) +
    Number(row.history_count || 0);
  return total > 0;
}

async function ensureMysqlHistoryLimit(pool) {
  if (mysqlHistoryLimitEnsured) return;
  await pool.query(
    `DELETE h
     FROM ${MYSQL_HISTORY_TABLE} h
     INNER JOIN (
       SELECT id
       FROM (
         SELECT
           id,
           ROW_NUMBER() OVER (PARTITION BY user_id ORDER BY at_ms DESC, id DESC) AS rn
         FROM ${MYSQL_HISTORY_TABLE}
       ) ranked
       WHERE rn > ?
     ) extra ON extra.id = h.id`,
    [HISTORY_MAX_PER_USER]
  );
  mysqlHistoryLimitEnsured = true;
}

async function pruneMysqlHistoryForUser(conn, userId) {
  await conn.query(
    `DELETE FROM ${MYSQL_HISTORY_TABLE}
     WHERE user_id = ?
       AND id NOT IN (
         SELECT id
         FROM (
           SELECT id
           FROM ${MYSQL_HISTORY_TABLE}
           WHERE user_id = ?
           ORDER BY at_ms DESC, id DESC
           LIMIT ${HISTORY_MAX_PER_USER}
         ) keepers
       )`,
    [userId, userId]
  );
}

async function ensureMysqlBoardVersionRow(executor, userId) {
  await executor.query(
    `INSERT INTO ${MYSQL_BOARD_VERSIONS_TABLE} (user_id, version, updated_at_ms)
     VALUES (?, 0, 0)
     ON DUPLICATE KEY UPDATE user_id = user_id`,
    [userId]
  );
}

async function mysqlGetBoardVersion(executor, userId, { forUpdate = false } = {}) {
  await ensureMysqlBoardVersionRow(executor, userId);
  const [rows] = await executor.query(
    `SELECT version
     FROM ${MYSQL_BOARD_VERSIONS_TABLE}
     WHERE user_id = ?
     LIMIT 1${forUpdate ? ' FOR UPDATE' : ''}`,
    [userId]
  );
  return Array.isArray(rows) && rows.length > 0 ? Number(rows[0].version ?? 0) : 0;
}

async function mysqlBumpBoardVersion(executor, userId, now = Date.now()) {
  await ensureMysqlBoardVersionRow(executor, userId);
  await executor.query(
    `UPDATE ${MYSQL_BOARD_VERSIONS_TABLE}
     SET version = version + 1,
         updated_at_ms = ?
     WHERE user_id = ?`,
    [now, userId]
  );
  return mysqlGetBoardVersion(executor, userId);
}

async function readNormalizedDbFromMysql(pool) {
  const [usersRows] = await pool.query(
    `SELECT id, login, email, password_salt, password_hash, created_at_ms, avatar_data_url, first_name, last_name, birth_date, role_title, city_title, bio
     FROM ${MYSQL_USERS_TABLE}`
  );
  const users = (Array.isArray(usersRows) ? usersRows : [])
    .map((r) => ({
      id: String(r.id ?? ''),
      login: normalizeLogin(r.login),
      email: normalizeEmail(r.email),
      passwordSalt: String(r.password_salt ?? ''),
      passwordHash: String(r.password_hash ?? ''),
      createdAt: Number(r.created_at_ms) || Date.now(),
      avatarUrl: sanitizeProfileAvatarUrl(r.avatar_data_url),
      firstName: sanitizeProfileName(r.first_name, MAX_PROFILE_FIRST_NAME_LEN),
      lastName: sanitizeProfileName(r.last_name, MAX_PROFILE_LAST_NAME_LEN),
      birthDate: sanitizeProfileBirthDate(r.birth_date),
      role: sanitizeProfileRole(r.role_title),
      city: sanitizeProfileCity(r.city_title),
      about: sanitizeProfileAbout(r.bio),
    }))
    .filter((u) => u.id);

  const boards = {};
  for (const user of users) {
    boards[user.id] = defaultBoardState();
  }

  const [cardsRows] = await pool.query(
    `SELECT user_id, id, title, description, images_json, checklist_json, created_by, created_at_ms, urgency, is_favorite, doing_started_at_ms, doing_total_ms
     FROM ${MYSQL_CARDS_TABLE}`
  );
  for (const row of Array.isArray(cardsRows) ? cardsRows : []) {
    const userId = String(row.user_id ?? '').trim();
    const cardId = String(row.id ?? '').trim();
    if (!userId || !cardId) continue;
    if (!boards[userId]) boards[userId] = defaultBoardState();

    boards[userId].cardsById[cardId] = {
      id: cardId,
      title: sanitizeText(row.title, 512),
      description: sanitizeText(row.description, 5000),
      images: parseCardImagesFromDb(row.images_json),
      checklist: parseChecklistFromDb(row.checklist_json),
      createdBy: sanitizeCardCreator(row.created_by),
      isFavorite: sanitizeCardFavorite(row.is_favorite),
      comments: [],
      createdAt: Number(row.created_at_ms) || Date.now(),
      status: 'queue',
      urgency: URGENCY_SET.has(row.urgency) ? row.urgency : 'white',
      doingStartedAt:
        row.doing_started_at_ms == null || !Number.isFinite(Number(row.doing_started_at_ms))
          ? null
          : Number(row.doing_started_at_ms),
      doingTotalMs: Number.isFinite(Number(row.doing_total_ms)) ? Number(row.doing_total_ms) : 0,
    };
  }

  const [commentsRows] = await pool.query(
    `SELECT user_id, card_id, id, author, text, images_json, created_at_ms, updated_at_ms
     FROM ${MYSQL_COMMENTS_TABLE}
     ORDER BY user_id ASC, card_id ASC, created_at_ms ASC, id ASC`
  );
  for (const row of Array.isArray(commentsRows) ? commentsRows : []) {
    const userId = String(row.user_id ?? '').trim();
    const cardId = String(row.card_id ?? '').trim();
    const id = sanitizeText(row.id, 128);
    const text = sanitizeText(row.text, MAX_COMMENT_TEXT_LEN);
    const images = parseCommentImagesFromDb(row.images_json);
    if (!userId || !cardId || !id) continue;
    if (!text && images.length === 0) continue;
    if (!boards[userId]) boards[userId] = defaultBoardState();
    const card = boards[userId].cardsById[cardId];
    if (!card) continue;
    const createdAt = Number(row.created_at_ms);
    const updatedAt = Number(row.updated_at_ms);
    card.comments.push({
      id,
      text,
      images,
      createdAt: Number.isFinite(createdAt) ? Math.max(0, Math.trunc(createdAt)) : Date.now(),
      updatedAt: Number.isFinite(updatedAt) ? Math.max(0, Math.trunc(updatedAt)) : undefined,
      author: sanitizeCommentAuthor(row.author),
    });
  }

  for (const state of Object.values(boards)) {
    for (const card of Object.values(state.cardsById ?? {})) {
      card.comments = sanitizeComments(card.comments);
    }
  }

  const [columnsRows] = await pool.query(
    `SELECT user_id, column_id, card_id, sort_index
     FROM ${MYSQL_COLUMNS_TABLE}
     ORDER BY user_id ASC, column_id ASC, sort_index ASC`
  );
  for (const row of Array.isArray(columnsRows) ? columnsRows : []) {
    const userId = String(row.user_id ?? '').trim();
    const columnId = String(row.column_id ?? '').trim();
    const cardId = String(row.card_id ?? '').trim();
    if (!userId || !columnId || !cardId) continue;
    if (!COLUMN_IDS.includes(columnId)) continue;
    if (!boards[userId]) boards[userId] = defaultBoardState();
    if (!boards[userId].cardsById[cardId]) continue;
    boards[userId].columns[columnId].push(cardId);
  }

  const [floatingRows] = await pool.query(
    `SELECT user_id, card_id, x, y, sway_offset_ms
     FROM ${MYSQL_FLOATING_TABLE}`
  );
  for (const row of Array.isArray(floatingRows) ? floatingRows : []) {
    const userId = String(row.user_id ?? '').trim();
    const cardId = String(row.card_id ?? '').trim();
    if (!userId || !cardId) continue;
    if (!boards[userId]) boards[userId] = defaultBoardState();
    if (!boards[userId].cardsById[cardId]) continue;
    if (getCardPosition(boards[userId].columns, cardId).columnId) continue;

    const x = Number(row.x);
    const y = Number(row.y);
    const swayOffsetMs = Number(row.sway_offset_ms);
    boards[userId].floatingById[cardId] = {
      x: Number.isFinite(x) ? Math.trunc(x) : 24,
      y: Number.isFinite(y) ? Math.trunc(y) : 120,
      swayOffsetMs: Number.isFinite(swayOffsetMs) && swayOffsetMs >= 0 ? Math.trunc(swayOffsetMs) : 0,
    };
  }

  const [historyRows] = await pool.query(
    `SELECT user_id, id, at_ms, text, card_id, kind, meta_json
     FROM ${MYSQL_HISTORY_TABLE}
     ORDER BY user_id ASC, at_ms DESC`
  );
  for (const row of Array.isArray(historyRows) ? historyRows : []) {
    const userId = String(row.user_id ?? '').trim();
    if (!userId) continue;
    if (!boards[userId]) boards[userId] = defaultBoardState();
    const kind = sanitizeHistoryKind(row.kind);
    let parsedMeta = null;
    try {
      if (row.meta_json == null) parsedMeta = null;
      else if (Buffer.isBuffer(row.meta_json)) parsedMeta = JSON.parse(row.meta_json.toString('utf8'));
      else if (typeof row.meta_json === 'string') parsedMeta = JSON.parse(row.meta_json);
      else parsedMeta = row.meta_json;
    } catch {
      parsedMeta = null;
    }
    const meta = sanitizeHistoryMeta(parsedMeta);

    const entry = {
      id: String(row.id ?? randomUUID()),
      at: Number(row.at_ms) || Date.now(),
      text: sanitizeText(row.text, 1000),
      cardId: row.card_id == null ? null : String(row.card_id),
    };
    if (kind) entry.kind = kind;
    if (meta) entry.meta = meta;

    boards[userId].history.push(entry);
  }

  for (const [userId, rawState] of Object.entries(boards)) {
    boards[userId] = sanitizeBoardState(rawState) ?? defaultBoardState();
  }

  const [sessionsRows] = await pool.query(
    `SELECT token, user_id, created_at_ms, expires_at_ms
     FROM ${MYSQL_SESSIONS_TABLE}`
  );
  const userIdSet = new Set(users.map((u) => u.id));
  const sessions = (Array.isArray(sessionsRows) ? sessionsRows : [])
    .map((r) =>
      normalizeSessionEntity(
        {
          token: r.token,
          userId: r.user_id,
          createdAt: r.created_at_ms,
          expiresAt: r.expires_at_ms,
        },
        userIdSet
      )
    )
    .filter(Boolean);

  return { users, sessions, boards };
}

function shouldUseMysqlScopedDb(pathname) {
  if (DB_PROVIDER !== 'mysql') return false;
  if (!pathname.startsWith('/api/')) return false;
  if (pathname === '/api/health') return false;
  if (pathname === '/api/auth/register') return false;
  if (pathname === '/api/auth/login') return false;
  if (pathname === '/api/auth/logout') return false;
  return true;
}

async function readUserBoardStateFromMysql(pool, userId) {
  const state = defaultBoardState();

  const [cardsRows] = await pool.query(
    `SELECT id, title, description, images_json, checklist_json, created_by, created_at_ms, urgency, is_favorite, doing_started_at_ms, doing_total_ms
     FROM ${MYSQL_CARDS_TABLE}
     WHERE user_id = ?`,
    [userId]
  );

  for (const row of Array.isArray(cardsRows) ? cardsRows : []) {
    const cardId = String(row.id ?? '').trim();
    if (!cardId) continue;

    state.cardsById[cardId] = {
      id: cardId,
      title: sanitizeText(row.title, 512),
      description: sanitizeText(row.description, 5000),
      images: parseCardImagesFromDb(row.images_json),
      checklist: parseChecklistFromDb(row.checklist_json),
      createdBy: sanitizeCardCreator(row.created_by),
      isFavorite: sanitizeCardFavorite(row.is_favorite),
      comments: [],
      createdAt: Number(row.created_at_ms) || Date.now(),
      status: 'queue',
      urgency: URGENCY_SET.has(row.urgency) ? row.urgency : 'white',
      doingStartedAt:
        row.doing_started_at_ms == null || !Number.isFinite(Number(row.doing_started_at_ms))
          ? null
          : Number(row.doing_started_at_ms),
      doingTotalMs: Number.isFinite(Number(row.doing_total_ms)) ? Number(row.doing_total_ms) : 0,
    };
  }

  const [commentsRows] = await pool.query(
    `SELECT card_id, id, author, text, images_json, created_at_ms, updated_at_ms
     FROM ${MYSQL_COMMENTS_TABLE}
     WHERE user_id = ?
     ORDER BY card_id ASC, created_at_ms ASC, id ASC`,
    [userId]
  );
  for (const row of Array.isArray(commentsRows) ? commentsRows : []) {
    const cardId = String(row.card_id ?? '').trim();
    const id = sanitizeText(row.id, 128);
    const text = sanitizeCommentText(row.text);
    const images = parseCommentImagesFromDb(row.images_json);
    if (!cardId || !id) continue;
    if (!text && images.length === 0) continue;
    const card = state.cardsById[cardId];
    if (!card) continue;

    const createdAt = Number(row.created_at_ms);
    const updatedAt = Number(row.updated_at_ms);
    card.comments.push({
      id,
      text,
      images,
      createdAt: Number.isFinite(createdAt) ? Math.max(0, Math.trunc(createdAt)) : Date.now(),
      updatedAt: Number.isFinite(updatedAt) ? Math.max(0, Math.trunc(updatedAt)) : undefined,
      author: sanitizeCommentAuthor(row.author),
    });
  }
  for (const card of Object.values(state.cardsById)) {
    card.comments = sanitizeComments(card.comments);
  }

  const [columnsRows] = await pool.query(
    `SELECT column_id, card_id, sort_index
     FROM ${MYSQL_COLUMNS_TABLE}
     WHERE user_id = ?
     ORDER BY column_id ASC, sort_index ASC`,
    [userId]
  );
  for (const row of Array.isArray(columnsRows) ? columnsRows : []) {
    const columnId = String(row.column_id ?? '').trim();
    const cardId = String(row.card_id ?? '').trim();
    if (!COLUMN_IDS.includes(columnId) || !cardId || !state.cardsById[cardId]) continue;
    state.columns[columnId].push(cardId);
  }

  const [floatingRows] = await pool.query(
    `SELECT card_id, x, y, sway_offset_ms
     FROM ${MYSQL_FLOATING_TABLE}
     WHERE user_id = ?`,
    [userId]
  );
  for (const row of Array.isArray(floatingRows) ? floatingRows : []) {
    const cardId = String(row.card_id ?? '').trim();
    if (!cardId || !state.cardsById[cardId]) continue;
    if (getCardPosition(state.columns, cardId).columnId) continue;
    const x = Number(row.x);
    const y = Number(row.y);
    const swayOffsetMs = Number(row.sway_offset_ms);
    state.floatingById[cardId] = {
      x: Number.isFinite(x) ? Math.trunc(x) : 24,
      y: Number.isFinite(y) ? Math.trunc(y) : 120,
      swayOffsetMs: Number.isFinite(swayOffsetMs) && swayOffsetMs >= 0 ? Math.trunc(swayOffsetMs) : 0,
    };
  }

  const [historyRows] = await pool.query(
    `SELECT id, at_ms, text, card_id, kind, meta_json
     FROM ${MYSQL_HISTORY_TABLE}
     WHERE user_id = ?
     ORDER BY at_ms DESC`,
    [userId]
  );
  for (const row of Array.isArray(historyRows) ? historyRows : []) {
    const kind = sanitizeHistoryKind(row.kind);
    let parsedMeta = null;
    try {
      if (row.meta_json == null) parsedMeta = null;
      else if (Buffer.isBuffer(row.meta_json)) parsedMeta = JSON.parse(row.meta_json.toString('utf8'));
      else if (typeof row.meta_json === 'string') parsedMeta = JSON.parse(row.meta_json);
      else parsedMeta = row.meta_json;
    } catch {
      parsedMeta = null;
    }
    const meta = sanitizeHistoryMeta(parsedMeta);
    const entry = {
      id: String(row.id ?? '').trim() || randomUUID(),
      at: Number(row.at_ms) || Date.now(),
      text: sanitizeText(row.text, 4000),
      cardId: row.card_id == null ? null : String(row.card_id).trim() || null,
      kind,
      meta,
    };
    state.history.push(entry);
  }

  return sanitizeBoardState(state) ?? defaultBoardState();
}

async function readScopedDbFromMysqlByToken(token) {
  await ensureMysqlSchema();
  const pool = await getMysqlPool();

  if (!token) return defaultDb();

  const now = Date.now();
  await pool.query(`DELETE FROM ${MYSQL_SESSIONS_TABLE} WHERE token = ? AND expires_at_ms <= ?`, [token, now]);
  const [rows] = await pool.query(
    `SELECT
       s.token,
       s.user_id,
       s.created_at_ms,
       s.expires_at_ms,
       u.id,
       u.login,
       u.email,
       u.password_salt,
       u.password_hash,
       u.created_at_ms AS user_created_at_ms,
       u.avatar_data_url,
       u.first_name,
       u.last_name,
       u.birth_date,
       u.role_title,
       u.city_title,
       u.bio
     FROM ${MYSQL_SESSIONS_TABLE} s
     INNER JOIN ${MYSQL_USERS_TABLE} u ON u.id = s.user_id
     WHERE s.token = ?
       AND s.expires_at_ms > ?
     LIMIT 1`,
    [token, now]
  );

  if (!Array.isArray(rows) || rows.length === 0) return defaultDb();
  const row = rows[0];
  const userId = String(row.id ?? '').trim();
  if (!userId) return defaultDb();

  const user = {
    id: userId,
    login: normalizeLogin(row.login),
    email: normalizeEmail(row.email),
    passwordSalt: String(row.password_salt ?? ''),
    passwordHash: String(row.password_hash ?? ''),
    createdAt: Number(row.user_created_at_ms) || Date.now(),
    avatarUrl: sanitizeProfileAvatarUrl(row.avatar_data_url),
    firstName: sanitizeProfileName(row.first_name, MAX_PROFILE_FIRST_NAME_LEN),
    lastName: sanitizeProfileName(row.last_name, MAX_PROFILE_LAST_NAME_LEN),
    birthDate: sanitizeProfileBirthDate(row.birth_date),
    role: sanitizeProfileRole(row.role_title),
    city: sanitizeProfileCity(row.city_title),
    about: sanitizeProfileAbout(row.bio),
  };

  await ensureMysqlHistoryLimit(pool);
  const state = await readUserBoardStateFromMysql(pool, userId);

  return {
    users: [user],
    sessions: [
      {
        token: String(row.token ?? ''),
        userId,
        createdAt: Number(row.created_at_ms) || now,
        expiresAt: Number(row.expires_at_ms) || now + SESSION_TTL_MS,
      },
    ],
    boards: {
      [userId]: state,
    },
    __scopeUserId: userId,
  };
}

async function writeScopedUserBoardToMysql(pool, userId, state, options = {}) {
  const expectedVersion =
    options && Object.prototype.hasOwnProperty.call(options, 'expectedVersion')
      ? Number(options.expectedVersion)
      : null;
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const currentVersion = await mysqlGetBoardVersion(conn, userId, { forUpdate: true });
    if (Number.isFinite(expectedVersion) && Math.trunc(expectedVersion) !== currentVersion) {
      const conflict = new Error('BOARD_VERSION_CONFLICT');
      conflict.code = 'BOARD_VERSION_CONFLICT';
      conflict.currentVersion = currentVersion;
      throw conflict;
    }
    await conn.query(`DELETE FROM ${MYSQL_FLOATING_TABLE} WHERE user_id = ?`, [userId]);
    await conn.query(`DELETE FROM ${MYSQL_COLUMNS_TABLE} WHERE user_id = ?`, [userId]);
    await conn.query(`DELETE FROM ${MYSQL_COMMENTS_TABLE} WHERE user_id = ?`, [userId]);
    await conn.query(`DELETE FROM ${MYSQL_CARDS_TABLE} WHERE user_id = ?`, [userId]);
    await conn.query(`DELETE FROM ${MYSQL_HISTORY_TABLE} WHERE user_id = ?`, [userId]);

    for (const card of Object.values(state.cardsById)) {
      const comments = sanitizeComments(card.comments);
      await conn.query(
        `INSERT INTO ${MYSQL_CARDS_TABLE}
          (user_id, id, title, description, images_json, checklist_json, created_by, created_at_ms, urgency, is_favorite, doing_started_at_ms, doing_total_ms)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          userId,
          card.id,
          card.title,
          card.description,
          encodeCardImagesForDb(card.images),
          encodeChecklistForDb(card.checklist),
          sanitizeCardCreator(card.createdBy),
          card.createdAt,
          card.urgency,
          sanitizeCardFavorite(card.isFavorite) ? 1 : 0,
          card.doingStartedAt,
          card.doingTotalMs,
        ]
      );

      for (const comment of comments) {
        await conn.query(
          `INSERT INTO ${MYSQL_COMMENTS_TABLE}
            (user_id, card_id, id, author, text, images_json, created_at_ms, updated_at_ms)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            userId,
            card.id,
            comment.id,
            sanitizeCommentAuthor(comment.author),
            comment.text,
            encodeCommentImagesForDb(comment.images),
            comment.createdAt,
            Number.isFinite(Number(comment.updatedAt))
              ? Math.max(comment.createdAt, Math.trunc(Number(comment.updatedAt)))
              : comment.createdAt,
          ]
        );
      }
    }

    for (const columnId of COLUMN_IDS) {
      const cardIds = state.columns[columnId] ?? [];
      for (let i = 0; i < cardIds.length; i += 1) {
        await conn.query(
          `INSERT INTO ${MYSQL_COLUMNS_TABLE}
            (user_id, column_id, card_id, sort_index)
           VALUES (?, ?, ?, ?)`,
          [userId, columnId, cardIds[i], i]
        );
      }
    }

    for (const [cardId, pin] of Object.entries(state.floatingById ?? {})) {
      if (!state.cardsById[cardId]) continue;
      if (getCardPosition(state.columns, cardId).columnId) continue;
      await conn.query(
        `INSERT INTO ${MYSQL_FLOATING_TABLE}
          (user_id, card_id, x, y, sway_offset_ms)
         VALUES (?, ?, ?, ?, ?)`,
        [userId, cardId, Math.trunc(Number(pin.x) || 0), Math.trunc(Number(pin.y) || 0), Math.max(0, Math.trunc(Number(pin.swayOffsetMs) || 0))]
      );
    }

    const historyEntries = (state.history ?? []).slice(0, HISTORY_MAX_PER_USER);
    for (const h of historyEntries) {
      const kind = sanitizeHistoryKind(h.kind);
      const meta = sanitizeHistoryMeta(h.meta);
      await conn.query(
        `INSERT INTO ${MYSQL_HISTORY_TABLE}
          (id, user_id, at_ms, text, card_id, kind, meta_json)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [h.id, userId, h.at, h.text, h.cardId, kind, meta ? JSON.stringify(meta) : null]
      );
    }
    await mysqlRebuildMediaIndexForUser(conn, userId);
    await pruneMysqlHistoryForUser(conn, userId);
    const nextVersion = await mysqlBumpBoardVersion(conn, userId);

    await conn.commit();
    return nextVersion;
  } catch (err) {
    await conn.rollback();
    throw err;
  } finally {
    conn.release();
  }
}

async function readDbFromMysql() {
  await ensureMysqlSchema();
  const pool = await getMysqlPool();
  if (await mysqlHasNormalizedData(pool)) {
    await ensureMysqlHistoryLimit(pool);
    return readNormalizedDbFromMysql(pool);
  }

  if (existsSync(DB_FILE)) {
    const seed = readDbFromFile();
    await writeDbToMysql(seed);
    return readNormalizedDbFromMysql(pool);
  }

  return defaultDb();
}

async function writeDbToMysql(db) {
  await ensureMysqlSchema();
  const pool = await getMysqlPool();
  const normalizedDb = normalizeDbShape(db);
  const scopeUserId = typeof normalizedDb.__scopeUserId === 'string' ? normalizedDb.__scopeUserId.trim() : '';
  if (scopeUserId) {
    const scopedState = sanitizeBoardState(normalizedDb.boards?.[scopeUserId]) ?? defaultBoardState();
    await writeScopedUserBoardToMysql(pool, scopeUserId, scopedState);
    return;
  }

  const dedupUsers = [];
  const userIdSet = new Set();
  const usedLoginKeys = new Set();
  const usedEmails = new Set();
  for (const raw of normalizedDb.users) {
    const sourceUser = normalizeUserEntity(raw);
    if (!sourceUser || userIdSet.has(sourceUser.id)) continue;
    const baseLogin = isValidLogin(sourceUser.login)
      ? sourceUser.login
      : fallbackLoginFromEmailOrId(sourceUser.email, sourceUser.id);
    const login = makeUniqueLogin(baseLogin, usedLoginKeys);
    const email = makeUniqueEmail(sourceUser.email, sourceUser.id, usedEmails);
    const user = { ...sourceUser, login, email };
    userIdSet.add(user.id);
    dedupUsers.push(user);
  }

  const boards = {};
  for (const user of dedupUsers) {
    boards[user.id] = sanitizeBoardState(normalizedDb.boards?.[user.id]) ?? defaultBoardState();
  }

  const sessions = normalizedDb.sessions
    .map((raw) => normalizeSessionEntity(raw, userIdSet))
    .filter(Boolean);

  const existingDb = await readNormalizedDbFromMysql(pool);
  const existingUserMap = new Map(existingDb.users.map((u) => [u.id, u]));
  const incomingUserMap = new Map(dedupUsers.map((u) => [u.id, u]));

  const userIdsToReplaceCardsAndColumns = [];
  const userIdsWithHistoryChanges = [];
  const userIdsWithBoardMutations = new Set();
  const historyDiffByUser = new Map();
  for (const user of dedupUsers) {
    const prev = existingDb.boards?.[user.id] ?? defaultBoardState();
    const next = boards[user.id] ?? defaultBoardState();

    const cardsColumnsOrFloatingChanged =
      JSON.stringify(prev.cardsById) !== JSON.stringify(next.cardsById) ||
      JSON.stringify(prev.columns) !== JSON.stringify(next.columns) ||
      JSON.stringify(prev.floatingById) !== JSON.stringify(next.floatingById);
    if (cardsColumnsOrFloatingChanged) {
      userIdsToReplaceCardsAndColumns.push(user.id);
      userIdsWithBoardMutations.add(user.id);
    }

    const historyChanged = JSON.stringify(prev.history) !== JSON.stringify(next.history);
    if (historyChanged) {
      userIdsWithHistoryChanges.push(user.id);
      userIdsWithBoardMutations.add(user.id);

      const prevById = new Map((prev.history ?? []).map((h) => [h.id, h]));
      const nextById = new Map((next.history ?? []).map((h) => [h.id, h]));
      const removedIds = [];
      const upsertEntries = [];

      for (const prevItem of prev.history ?? []) {
        if (!nextById.has(prevItem.id)) {
          removedIds.push(prevItem.id);
        }
      }

      for (const nextItem of next.history ?? []) {
        const prevItem = prevById.get(nextItem.id);
        if (
          !prevItem ||
          prevItem.at !== nextItem.at ||
          prevItem.text !== nextItem.text ||
          prevItem.cardId !== nextItem.cardId ||
          prevItem.kind !== nextItem.kind ||
          JSON.stringify(prevItem.meta ?? null) !== JSON.stringify(nextItem.meta ?? null)
        ) {
          upsertEntries.push(nextItem);
        }
      }

      historyDiffByUser.set(user.id, { removedIds, upsertEntries });
    }
  }

  const sessionKey = (s) => `${s.token}::${s.userId}::${s.createdAt}::${s.expiresAt}`;
  const incomingSessionSet = new Set(sessions.map(sessionKey));
  const existingSessionSet = new Set((existingDb.sessions ?? []).map(sessionKey));
  const sessionsChanged =
    incomingSessionSet.size !== existingSessionSet.size ||
    [...incomingSessionSet].some((k) => !existingSessionSet.has(k));

  const usersChanged =
    incomingUserMap.size !== existingUserMap.size ||
    dedupUsers.some((u) => {
      const prev = existingUserMap.get(u.id);
      return !prev || JSON.stringify(prev) !== JSON.stringify(u);
    });

  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();

    if (usersChanged) {
      const existingIds = new Set(existingDb.users.map((u) => u.id));
      const incomingIds = new Set(dedupUsers.map((u) => u.id));
      const deletedIds = [...existingIds].filter((id) => !incomingIds.has(id));
      for (const userId of deletedIds) {
        await conn.query(`DELETE FROM ${MYSQL_MEDIA_LINKS_TABLE} WHERE user_id = ?`, [userId]);
        await conn.query(`DELETE FROM ${MYSQL_MEDIA_FILES_TABLE} WHERE user_id = ?`, [userId]);
        await conn.query(`DELETE FROM ${MYSQL_COMMENTS_ARCHIVE_TABLE} WHERE user_id = ?`, [userId]);
        await conn.query(`DELETE FROM ${MYSQL_HISTORY_TABLE} WHERE user_id = ?`, [userId]);
        await conn.query(`DELETE FROM ${MYSQL_COMMENTS_TABLE} WHERE user_id = ?`, [userId]);
        await conn.query(`DELETE FROM ${MYSQL_FLOATING_TABLE} WHERE user_id = ?`, [userId]);
        await conn.query(`DELETE FROM ${MYSQL_COLUMNS_TABLE} WHERE user_id = ?`, [userId]);
        await conn.query(`DELETE FROM ${MYSQL_CARDS_TABLE} WHERE user_id = ?`, [userId]);
        await conn.query(`DELETE FROM ${MYSQL_SESSIONS_TABLE} WHERE user_id = ?`, [userId]);
        await conn.query(`DELETE FROM ${MYSQL_USERS_TABLE} WHERE id = ?`, [userId]);
      }

      for (const user of dedupUsers) {
        await conn.query(
          `INSERT INTO ${MYSQL_USERS_TABLE}
            (id, login, login_key, email, password_salt, password_hash, created_at_ms, avatar_data_url, first_name, last_name, birth_date, role_title, city_title, bio)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON DUPLICATE KEY UPDATE
             login = VALUES(login),
             login_key = VALUES(login_key),
             email = VALUES(email),
             password_salt = VALUES(password_salt),
             password_hash = VALUES(password_hash),
             created_at_ms = VALUES(created_at_ms),
             avatar_data_url = VALUES(avatar_data_url),
             first_name = VALUES(first_name),
             last_name = VALUES(last_name),
             birth_date = VALUES(birth_date),
             role_title = VALUES(role_title),
             city_title = VALUES(city_title),
             bio = VALUES(bio)`,
          [
            user.id,
            user.login,
            loginKey(user.login),
            user.email,
            user.passwordSalt,
            user.passwordHash,
            user.createdAt,
            sanitizeProfileAvatarUrl(user.avatarUrl),
            sanitizeProfileName(user.firstName, MAX_PROFILE_FIRST_NAME_LEN),
            sanitizeProfileName(user.lastName, MAX_PROFILE_LAST_NAME_LEN),
            sanitizeProfileBirthDate(user.birthDate),
            sanitizeProfileRole(user.role),
            sanitizeProfileCity(user.city),
            sanitizeProfileAbout(user.about),
          ]
        );
      }
    }

    if (sessionsChanged) {
      await conn.query(`DELETE FROM ${MYSQL_SESSIONS_TABLE}`);
      for (const session of sessions) {
        await conn.query(
          `INSERT INTO ${MYSQL_SESSIONS_TABLE}
            (token, user_id, created_at_ms, expires_at_ms)
           VALUES (?, ?, ?, ?)`,
          [session.token, session.userId, session.createdAt, session.expiresAt]
        );
      }
    }

    for (const userId of userIdsToReplaceCardsAndColumns) {
      const state = boards[userId] ?? defaultBoardState();
      await conn.query(`DELETE FROM ${MYSQL_COMMENTS_TABLE} WHERE user_id = ?`, [userId]);
      await conn.query(`DELETE FROM ${MYSQL_FLOATING_TABLE} WHERE user_id = ?`, [userId]);
      await conn.query(`DELETE FROM ${MYSQL_COLUMNS_TABLE} WHERE user_id = ?`, [userId]);
      await conn.query(`DELETE FROM ${MYSQL_CARDS_TABLE} WHERE user_id = ?`, [userId]);

      for (const card of Object.values(state.cardsById)) {
        const comments = sanitizeComments(card.comments);
        await conn.query(
        `INSERT INTO ${MYSQL_CARDS_TABLE}
            (user_id, id, title, description, images_json, checklist_json, created_by, created_at_ms, urgency, is_favorite, doing_started_at_ms, doing_total_ms)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            userId,
            card.id,
            card.title,
            card.description,
            encodeCardImagesForDb(card.images),
            encodeChecklistForDb(card.checklist),
            sanitizeCardCreator(card.createdBy),
            card.createdAt,
            card.urgency,
            sanitizeCardFavorite(card.isFavorite) ? 1 : 0,
            card.doingStartedAt,
            card.doingTotalMs,
          ]
        );

        for (const comment of comments) {
          await conn.query(
            `INSERT INTO ${MYSQL_COMMENTS_TABLE}
              (user_id, card_id, id, author, text, images_json, created_at_ms, updated_at_ms)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
            [
              userId,
              card.id,
              comment.id,
              sanitizeCommentAuthor(comment.author),
              comment.text,
              encodeCommentImagesForDb(comment.images),
              comment.createdAt,
              Number.isFinite(Number(comment.updatedAt))
                ? Math.max(comment.createdAt, Math.trunc(Number(comment.updatedAt)))
                : comment.createdAt,
            ]
          );
        }
      }

      for (const columnId of COLUMN_IDS) {
        const cardIds = state.columns[columnId] ?? [];
        for (let i = 0; i < cardIds.length; i += 1) {
          await conn.query(
            `INSERT INTO ${MYSQL_COLUMNS_TABLE}
              (user_id, column_id, card_id, sort_index)
             VALUES (?, ?, ?, ?)`,
            [userId, columnId, cardIds[i], i]
          );
        }
      }

      for (const [cardId, pin] of Object.entries(state.floatingById ?? {})) {
        if (!state.cardsById[cardId]) continue;
        if (getCardPosition(state.columns, cardId).columnId) continue;
        await conn.query(
          `INSERT INTO ${MYSQL_FLOATING_TABLE}
            (user_id, card_id, x, y, sway_offset_ms)
           VALUES (?, ?, ?, ?, ?)`,
          [userId, cardId, Math.trunc(Number(pin.x) || 0), Math.trunc(Number(pin.y) || 0), Math.max(0, Math.trunc(Number(pin.swayOffsetMs) || 0))]
        );
      }

      await mysqlRebuildMediaIndexForUser(conn, userId);
    }

    for (const userId of userIdsWithHistoryChanges) {
      const diff = historyDiffByUser.get(userId) ?? { removedIds: [], upsertEntries: [] };

      if (diff.removedIds.length > 0) {
        const placeholders = diff.removedIds.map(() => '?').join(', ');
        await conn.query(
          `DELETE FROM ${MYSQL_HISTORY_TABLE}
           WHERE user_id = ? AND id IN (${placeholders})`,
          [userId, ...diff.removedIds]
        );
      }

      for (const h of diff.upsertEntries) {
        const kind = sanitizeHistoryKind(h.kind);
        const meta = sanitizeHistoryMeta(h.meta);
        await conn.query(
          `INSERT INTO ${MYSQL_HISTORY_TABLE}
            (id, user_id, at_ms, text, card_id, kind, meta_json)
           VALUES (?, ?, ?, ?, ?, ?, ?)
           ON DUPLICATE KEY UPDATE
             user_id = VALUES(user_id),
             at_ms = VALUES(at_ms),
             text = VALUES(text),
             card_id = VALUES(card_id),
             kind = VALUES(kind),
             meta_json = VALUES(meta_json)`,
          [h.id, userId, h.at, h.text, h.cardId, kind, meta ? JSON.stringify(meta) : null]
        );
      }

      await pruneMysqlHistoryForUser(conn, userId);
    }

    for (const userId of userIdsWithBoardMutations) {
      await mysqlBumpBoardVersion(conn, userId);
    }

    await conn.commit();
  } catch (err) {
    await conn.rollback();
    throw err;
  } finally {
    conn.release();
  }
}

async function readDb() {
  if (DB_PROVIDER === 'mysql') {
    return readDbFromMysql();
  }
  return readDbFromFile();
}

async function writeDb(db) {
  if (DB_PROVIDER === 'mysql') {
    await writeDbToMysql(db);
    return;
  }
  writeDbToFile(db);
}

function normalizeEmail(value) {
  return String(value ?? '')
    .trim()
    .toLowerCase();
}

function isValidEmail(value) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
}

function normalizeLogin(value) {
  return String(value ?? '').trim();
}

function sanitizeCardCreator(value) {
  const login = normalizeLogin(value);
  return login ? login.slice(0, 64) : null;
}

function sanitizeCardFavorite(value) {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return Number.isFinite(value) && value !== 0;
  const normalized = String(value ?? '')
    .trim()
    .toLowerCase();
  return normalized === '1' || normalized === 'true' || normalized === 'yes';
}

function sanitizeProfileName(value, maxLen) {
  const text = sanitizeText(value, maxLen);
  return text ? text : null;
}

function sanitizeProfileRole(value) {
  const text = sanitizeText(value, MAX_PROFILE_ROLE_LEN);
  return text ? text : null;
}

function sanitizeProfileCity(value) {
  const text = sanitizeText(value, MAX_PROFILE_CITY_LEN);
  return text ? text : null;
}

function sanitizeProfileAbout(value) {
  const text = sanitizeText(value, MAX_PROFILE_ABOUT_LEN);
  return text ? text : null;
}

function sanitizeProfileBirthDate(value) {
  const raw = String(value ?? '').trim();
  if (!raw) return null;
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(raw);
  if (!match) return null;
  const y = Number(match[1]);
  const m = Number(match[2]);
  const d = Number(match[3]);
  if (!Number.isFinite(y) || !Number.isFinite(m) || !Number.isFinite(d)) return null;
  if (y < 1900 || y > 2100) return null;
  const date = new Date(Date.UTC(y, m - 1, d));
  if (
    date.getUTCFullYear() !== y ||
    date.getUTCMonth() + 1 !== m ||
    date.getUTCDate() !== d
  ) {
    return null;
  }
  const today = new Date();
  const todayIso = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
  if (raw > todayIso) return null;
  return raw;
}

function isProfileBirthDateAtLeastAge(birthDateIso, minAgeYears = MIN_PROFILE_AGE_YEARS) {
  const raw = sanitizeProfileBirthDate(birthDateIso);
  if (!raw) return false;
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(raw);
  if (!match) return false;
  const y = Number(match[1]);
  const m = Number(match[2]);
  const d = Number(match[3]);
  if (!Number.isFinite(y) || !Number.isFinite(m) || !Number.isFinite(d)) return false;

  const now = new Date();
  let age = now.getFullYear() - y;
  const birthdayPassed = now.getMonth() + 1 > m || (now.getMonth() + 1 === m && now.getDate() >= d);
  if (!birthdayPassed) age -= 1;
  return age >= minAgeYears;
}

function validateProfileFirstName(value) {
  if (value == null) return true;
  return PROFILE_NAME_RX.test(String(value));
}

function validateProfileLastName(value) {
  if (value == null) return true;
  return PROFILE_NAME_RX.test(String(value));
}

function validateProfileRole(value) {
  if (value == null) return true;
  return PROFILE_ROLE_RX.test(String(value));
}

function validateProfileCity(value) {
  if (value == null) return true;
  return PROFILE_CITY_RX.test(String(value));
}

function validateProfileAbout(value) {
  if (value == null) return true;
  return String(value).length <= MAX_PROFILE_ABOUT_EDIT_LEN;
}

function sanitizeProfileAvatarUrl(value) {
  const raw = String(value ?? '').trim();
  if (!raw) return null;
  const normalized = sanitizeCardImageDataUrl(raw);
  if (!normalized) return null;
  if (normalized.bytes > MAX_PROFILE_AVATAR_BYTES) return null;
  return normalized.dataUrl;
}

function loginKey(value) {
  return normalizeLogin(value).toLowerCase();
}

function isValidLogin(value) {
  const login = normalizeLogin(value);
  if (login.length < 2 || login.length > 32) return false;
  return /^[A-Za-zА-Яа-яЁё]+$/u.test(login);
}

function passwordHash(password, salt) {
  return scryptSync(password, salt, 64);
}

function createPasswordData(password) {
  const salt = randomBytes(16).toString('hex');
  const hash = passwordHash(password, salt).toString('hex');
  return { salt, hash };
}

function verifyPassword(password, salt, expectedHexHash) {
  const computed = passwordHash(password, salt);
  const expected = Buffer.from(expectedHexHash, 'hex');
  if (computed.length !== expected.length) return false;
  return timingSafeEqual(computed, expected);
}

function issueSession(db, userId) {
  const token = randomBytes(32).toString('hex');
  const now = Date.now();
  const session = {
    token,
    userId,
    createdAt: now,
    expiresAt: now + SESSION_TTL_MS,
  };
  db.sessions.push(session);
  return token;
}

function cleanupSessions(db) {
  const now = Date.now();
  db.sessions = db.sessions.filter((s) => Number(s.expiresAt) > now);
}

function extractBearerToken(req) {
  const raw = req.headers.authorization;
  if (!raw || typeof raw !== 'string') return null;
  const m = /^Bearer\s+(.+)$/i.exec(raw.trim());
  return m ? m[1] : null;
}

function findUserByToken(db, token) {
  if (!token) return null;
  cleanupSessions(db);
  const session = db.sessions.find((s) => s.token === token);
  if (!session) return null;
  return db.users.find((u) => u.id === session.userId) ?? null;
}

function sanitizeText(input, maxLen) {
  return String(input ?? '')
    .trim()
    .slice(0, maxLen);
}

function sanitizeCommentAuthor(input) {
  const author = sanitizeText(input, MAX_COMMENT_AUTHOR_LEN);
  return author ? author : null;
}

function escapeHtml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function normalizeRichColor(rawValue) {
  const raw = String(rawValue ?? '')
    .trim()
    .toLowerCase()
    .replaceAll('"', '')
    .replaceAll("'", '');
  if (!raw) return null;

  const shortHex = /^#([0-9a-f]{3})$/i.exec(raw);
  if (shortHex) {
    const [r, g, b] = shortHex[1].split('');
    return `#${r}${r}${g}${g}${b}${b}`;
  }

  const fullHex = /^#([0-9a-f]{6})$/i.exec(raw);
  if (fullHex) return `#${fullHex[1].toLowerCase()}`;

  const rgb = /^rgba?\(\s*(\d{1,3})\s*[, ]\s*(\d{1,3})\s*[, ]\s*(\d{1,3})(?:\s*[,/]\s*[\d.]+\s*)?\)$/i.exec(raw);
  if (!rgb) return null;

  const toHex = (part) => {
    const num = Math.max(0, Math.min(255, Number(part)));
    return num.toString(16).padStart(2, '0');
  };
  return `#${toHex(rgb[1])}${toHex(rgb[2])}${toHex(rgb[3])}`;
}

function sanitizeRichSpanStyle(rawStyle) {
  const source = String(rawStyle ?? '').trim();
  if (!source) return null;

  let color = null;
  let bgColor = null;
  for (const chunk of source.split(';')) {
    const [propRaw, valueRaw] = chunk.split(':');
    if (!propRaw || !valueRaw) continue;
    const prop = propRaw.trim().toLowerCase();
    const normalizedColor = normalizeRichColor(valueRaw.trim());
    if (!normalizedColor) continue;
    if (prop === 'color') color = normalizedColor;
    if (prop === 'background' || prop === 'background-color') bgColor = normalizedColor;
  }

  const styleParts = [];
  if (color) styleParts.push(`color:${color}`);
  if (bgColor) styleParts.push(`background-color:${bgColor}`);
  return styleParts.length > 0 ? styleParts.join(';') : null;
}

function readHtmlAttrValue(attrsRaw, attrName) {
  const source = String(attrsRaw ?? '');
  const escaped = attrName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const rx = new RegExp(`${escaped}\\s*=\\s*(\"([^\"]*)\"|'([^']*)'|([^\\s\"'` + '`' + `=<>]+))`, 'i');
  const m = rx.exec(source);
  if (!m) return null;
  return m[2] ?? m[3] ?? m[4] ?? null;
}

function sanitizeRichCommentHtml(input) {
  const sourceRaw = String(input ?? '').replace(/\r\n?/g, '\n').trim();
  if (!sourceRaw) return '';

  const looksLikeHtml = /<\/?[a-z][\s\S]*>/i.test(sourceRaw);
  const source = looksLikeHtml ? sourceRaw : escapeHtml(sourceRaw).replace(/\n/g, '<br>');
  const withoutDangerous = source
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '');

  const tokens = withoutDangerous.match(/<[^>]*>|[^<]+/g) ?? [];
  const output = [];
  const openStack = [];

  for (const token of tokens) {
    if (!token.startsWith('<')) {
      output.push(escapeHtml(token));
      continue;
    }

    const closeMatch = /^<\s*\/\s*([a-z0-9]+)\s*>$/i.exec(token);
    if (closeMatch) {
      const tag = closeMatch[1].toLowerCase();
      if (!RICH_COMMENT_ALLOWED_TAGS.has(tag) || tag === 'br') continue;
      for (let i = openStack.length - 1; i >= 0; i -= 1) {
        const opened = openStack[i];
        openStack.pop();
        output.push(`</${opened}>`);
        if (opened === tag) break;
      }
      continue;
    }

    const openMatch = /^<\s*([a-z0-9]+)\b([^>]*)>$/i.exec(token);
    if (!openMatch) continue;

    const tag = openMatch[1].toLowerCase();
    if (!RICH_COMMENT_ALLOWED_TAGS.has(tag)) continue;

    if (tag === 'br') {
      output.push('<br>');
      continue;
    }

    const attrsRaw = openMatch[2] ?? '';
    if (tag === 'span') {
      const classTokens = String(readHtmlAttrValue(attrsRaw, 'class') ?? '')
        .split(/\s+/)
        .map((part) => part.trim())
        .filter((part) => part && RICH_COMMENT_COLOR_CLASSES.has(part));
      const style = sanitizeRichSpanStyle(readHtmlAttrValue(attrsRaw, 'style'));

      let attrChunk = '';
      if (classTokens.length > 0) attrChunk += ` class="${classTokens.join(' ')}"`;
      if (style) attrChunk += ` style="${style}"`;
      output.push(`<span${attrChunk}>`);
      openStack.push('span');
      continue;
    }

    output.push(`<${tag}>`);
    openStack.push(tag);
  }

  for (let i = openStack.length - 1; i >= 0; i -= 1) {
    output.push(`</${openStack[i]}>`);
  }

  return output.join('').trim();
}

function richCommentToPlainText(input) {
  const html = String(input ?? '');
  if (!html) return '';

  return html
    .replace(/<\s*br\s*\/?\s*>/gi, '\n')
    .replace(/<\/\s*(div|p|li|ul|ol)\s*>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&amp;/gi, '&')
    .replace(/\s+/g, ' ')
    .trim();
}

function sanitizeCommentText(input) {
  const normalized = sanitizeRichCommentHtml(input);
  const plain = richCommentToPlainText(normalized);
  if (!plain) return '';

  if (normalized.length <= MAX_COMMENT_TEXT_LEN) return normalized;

  return escapeHtml(plain.slice(0, MAX_COMMENT_TEXT_LEN)).replace(/\n/g, '<br>');
}

function sanitizeCommentEntry(entry) {
  if (!entry || typeof entry !== 'object') return null;

  const id = sanitizeText(entry.id, 128);
  const text = sanitizeCommentText(entry.text);
  const images = sanitizeCardImages(entry.images);
  const createdAt = Number(entry.createdAt);
  const updatedAtRaw = Number(entry.updatedAt);
  if (!id) return null;
  if (!text && images.length === 0) return null;

  const normalizedCreatedAt = Number.isFinite(createdAt) ? Math.max(0, Math.trunc(createdAt)) : Date.now();
  const normalizedUpdatedAt = Number.isFinite(updatedAtRaw)
    ? Math.max(normalizedCreatedAt, Math.trunc(updatedAtRaw))
    : normalizedCreatedAt;

  return {
    id,
    text,
    images,
    createdAt: normalizedCreatedAt,
    updatedAt: normalizedUpdatedAt,
    author: sanitizeCommentAuthor(entry.author),
  };
}

function sanitizeComments(raw, options = {}) {
  if (!Array.isArray(raw)) return [];

  const keepInputOrder = options?.keepInputOrder === true;
  const enforceMax = options?.enforceMax !== false;
  const out = [];
  const seen = new Set();
  for (const entry of raw) {
    const normalized = sanitizeCommentEntry(entry);
    if (!normalized) continue;
    if (seen.has(normalized.id)) continue;
    seen.add(normalized.id);
    out.push(normalized);
  }

  if (!keepInputOrder) {
    out.sort((a, b) => {
      if (a.createdAt !== b.createdAt) return a.createdAt - b.createdAt;
      return a.id.localeCompare(b.id);
    });
  }

  if (!enforceMax) return out;
  return out.length > MAX_COMMENTS_PER_CARD ? out.slice(out.length - MAX_COMMENTS_PER_CARD) : out;
}

function sanitizeChecklistEntry(entry) {
  if (!entry || typeof entry !== 'object') return null;

  const id = sanitizeText(entry.id, 128);
  const text = sanitizeText(entry.text, MAX_CHECKLIST_ITEM_TEXT_LEN);
  const createdAt = Number(entry.createdAt);
  if (!id || !text) return null;

  return {
    id,
    text,
    done: entry.done === true,
    createdAt: Number.isFinite(createdAt) ? Math.max(0, Math.trunc(createdAt)) : Date.now(),
  };
}

function sanitizeChecklist(raw, options = {}) {
  if (!Array.isArray(raw)) return [];

  const keepInputOrder = options?.keepInputOrder === true;
  const enforceMax = options?.enforceMax !== false;
  const out = [];
  const seen = new Set();

  for (const entry of raw) {
    const normalized = sanitizeChecklistEntry(entry);
    if (!normalized) continue;
    if (seen.has(normalized.id)) continue;
    seen.add(normalized.id);
    out.push(normalized);
  }

  if (!keepInputOrder) {
    out.sort((a, b) => {
      if (a.createdAt !== b.createdAt) return a.createdAt - b.createdAt;
      return a.id.localeCompare(b.id);
    });
  }

  if (!enforceMax) return out;
  return out.length > MAX_CHECKLIST_ITEMS_PER_CARD ? out.slice(0, MAX_CHECKLIST_ITEMS_PER_CARD) : out;
}

function normalizeCardImageMime(value) {
  const mime = String(value ?? '')
    .trim()
    .toLowerCase();
  if (!mime) return null;
  if (mime === 'image/jpg') return 'image/jpeg';
  return CARD_IMAGE_MIME_SET.has(mime) ? mime : null;
}

function base64PayloadBytes(value) {
  const clean = String(value ?? '').replace(/\s+/g, '');
  if (!clean) return 0;
  const padding = clean.endsWith('==') ? 2 : clean.endsWith('=') ? 1 : 0;
  return Math.max(0, Math.floor((clean.length * 3) / 4) - padding);
}

function sanitizeCardImageBase64Payload(value) {
  const payload = String(value ?? '')
    .trim()
    .replace(/\s+/g, '');
  if (!payload) return null;
  if (!/^[a-z0-9+/]+={0,2}$/i.test(payload)) return null;
  const bytes = base64PayloadBytes(payload);
  if (!Number.isFinite(bytes) || bytes <= 0 || bytes > MAX_CARD_IMAGE_BYTES) return null;
  return { payload, bytes };
}

function sanitizeCardImageDataUrl(value, mimeHint = null) {
  const raw = String(value ?? '').trim();
  if (!raw) return null;
  const match = /^data:(image\/[a-z0-9.+-]+);base64,([a-z0-9+/=]+)$/i.exec(raw);
  if (!match) return null;
  const mime = normalizeCardImageMime(mimeHint ?? match[1]);
  if (!mime) return null;
  const payload = match[2];
  const bytes = base64PayloadBytes(payload);
  if (!Number.isFinite(bytes) || bytes <= 0 || bytes > MAX_CARD_IMAGE_BYTES) return null;
  return { dataUrl: `data:${mime};base64,${payload}`, mime, bytes, payload };
}

function normalizeMediaId(value) {
  const raw = String(value ?? '').trim();
  if (!raw || raw.length > 160) return null;
  if (raw.includes('/') || raw.includes('\\')) return null;
  if (!/^[a-z0-9][a-z0-9._-]*$/i.test(raw)) return null;
  return raw;
}

function mediaIdToPath(mediaId) {
  const normalized = normalizeMediaId(mediaId);
  if (!normalized) return null;
  const fullPath = resolve(MEDIA_DIR, normalized);
  if (!fullPath.startsWith(resolve(MEDIA_DIR))) return null;
  return fullPath;
}

function mediaPublicUrl(mediaId) {
  const normalized = normalizeMediaId(mediaId);
  if (!normalized) return null;
  return `${MEDIA_ROUTE_PREFIX}${encodeURIComponent(normalized)}`;
}

function mediaMimeFromId(mediaId, fallbackMime = null) {
  const fallback = normalizeCardImageMime(fallbackMime);
  const normalized = normalizeMediaId(mediaId);
  if (!normalized) return fallback;
  const ext = extname(normalized).toLowerCase();
  const byExt = MIME_BY_EXT[ext];
  const mime = byExt ? normalizeCardImageMime(byExt) : null;
  return mime ?? fallback;
}

function extractMediaIdFromUrl(value) {
  const raw = String(value ?? '').trim();
  if (!raw) return null;

  if (raw.startsWith(MEDIA_ROUTE_PREFIX)) {
    const candidate = raw.slice(MEDIA_ROUTE_PREFIX.length).split('?')[0];
    try {
      return normalizeMediaId(decodeURIComponent(candidate));
    } catch {
      return null;
    }
  }

  try {
    const parsed = new URL(raw, 'http://127.0.0.1');
    if (!parsed.pathname.startsWith(MEDIA_ROUTE_PREFIX)) return null;
    const candidate = parsed.pathname.slice(MEDIA_ROUTE_PREFIX.length);
    return normalizeMediaId(decodeURIComponent(candidate));
  } catch {
    return null;
  }
}

function normalizeMediaOwnerUserId(value) {
  const raw = String(value ?? '').trim();
  return raw ? raw.slice(0, 64) : null;
}

function markMediaForGcGrace(mediaId, ttlMs = MEDIA_GC_UPLOAD_GRACE_MS, options = null) {
  const normalized = normalizeMediaId(mediaId);
  if (!normalized) return;
  const ttl = Number.isFinite(Number(ttlMs)) ? Math.max(1000, Math.trunc(Number(ttlMs))) : MEDIA_GC_UPLOAD_GRACE_MS;
  const ownerUserId = normalizeMediaOwnerUserId(options?.ownerUserId);
  const bytesRaw = Number(options?.bytes);
  const bytes = Number.isFinite(bytesRaw) && bytesRaw > 0 ? Math.trunc(bytesRaw) : null;
  mediaGcKeepUntilById.set(normalized, { untilMs: Date.now() + ttl, ownerUserId, bytes });
}

function purgeExpiredMediaGcGrace(now = Date.now()) {
  for (const [mediaId, value] of mediaGcKeepUntilById.entries()) {
    const untilMs = Number(value?.untilMs);
    if (!Number.isFinite(untilMs) || untilMs <= now) {
      mediaGcKeepUntilById.delete(mediaId);
    }
  }
}

function getPendingMediaBytesForUser(userId, referencedIds = null, now = Date.now()) {
  const normalizedUserId = normalizeMediaOwnerUserId(userId);
  if (!normalizedUserId) return 0;
  const referenced = referencedIds instanceof Map || referencedIds instanceof Set ? referencedIds : null;
  purgeExpiredMediaGcGrace(now);
  let total = 0;
  for (const [mediaId, value] of mediaGcKeepUntilById.entries()) {
    if (!value || value.ownerUserId !== normalizedUserId) continue;
    if (referenced?.has?.(mediaId)) continue;
    const bytes = Number(value.bytes);
    if (!Number.isFinite(bytes) || bytes <= 0) continue;
    total += Math.trunc(bytes);
  }
  return total;
}

function collectReferencedMediaIdsFromImages(rawImages, outSet) {
  const target = outSet instanceof Set ? outSet : new Set();
  const images = sanitizeCardImages(rawImages);
  for (const image of images) {
    const mediaId = normalizeMediaId(image.fileId ?? extractMediaIdFromUrl(image.dataUrl));
    if (mediaId) target.add(mediaId);
    const previewMediaId = normalizeMediaId(image.previewFileId ?? extractMediaIdFromUrl(image.previewUrl));
    if (previewMediaId) target.add(previewMediaId);
  }
  return target;
}

function collectReferencedMediaIdsFromCard(rawCard, outSet) {
  const target = outSet instanceof Set ? outSet : new Set();
  if (!rawCard || typeof rawCard !== 'object') return target;
  collectReferencedMediaIdsFromImages(rawCard.images, target);
  const comments = sanitizeComments(rawCard.comments, { keepInputOrder: true, enforceMax: false });
  for (const comment of comments) {
    collectReferencedMediaIdsFromImages(comment.images, target);
  }
  return target;
}

function releaseMediaGcGraceForRemovedIds(previousIds, nextIds, reason = 'media-detached') {
  const prevSet = previousIds instanceof Set ? previousIds : new Set();
  const nextSet = nextIds instanceof Set ? nextIds : new Set();
  let removedCount = 0;
  for (const mediaId of prevSet) {
    if (nextSet.has(mediaId)) continue;
    mediaGcKeepUntilById.delete(mediaId);
    removedCount += 1;
  }
  if (removedCount > 0) {
    scheduleMediaGc(reason, 0);
  }
  return removedCount;
}

function releaseMediaGcGraceForRemovedImages(previousImages, nextImages, reason = 'media-detached') {
  const previousIds = collectReferencedMediaIdsFromImages(previousImages, new Set());
  const nextIds = collectReferencedMediaIdsFromImages(nextImages, new Set());
  return releaseMediaGcGraceForRemovedIds(previousIds, nextIds, reason);
}

function releaseMediaGcGraceForRemovedCard(previousCard, nextCard, reason = 'media-detached') {
  const previousIds = collectReferencedMediaIdsFromCard(previousCard, new Set());
  const nextIds = collectReferencedMediaIdsFromCard(nextCard, new Set());
  return releaseMediaGcGraceForRemovedIds(previousIds, nextIds, reason);
}

function collectReferencedMediaIdsFromBoardState(rawState, outSet) {
  const target = outSet instanceof Set ? outSet : new Set();
  const state = sanitizeBoardState(rawState) ?? defaultBoardState();
  for (const card of Object.values(state.cardsById ?? {})) {
    collectReferencedMediaIdsFromCard(card, target);
  }
  return target;
}

function addMediaUsageEntry(usageById, mediaId, bytes) {
  if (!(usageById instanceof Map)) return;
  const normalizedId = normalizeMediaId(mediaId);
  if (!normalizedId || usageById.has(normalizedId)) return;
  usageById.set(normalizedId, normalizeCardImageSize(bytes, 1));
}

function collectMediaUsageFromImages(rawImages, usageById) {
  const target = usageById instanceof Map ? usageById : new Map();
  const images = sanitizeCardImages(rawImages);
  for (const image of images) {
    addMediaUsageEntry(target, image.fileId ?? extractMediaIdFromUrl(image.dataUrl), image.size);
    addMediaUsageEntry(
      target,
      image.previewFileId ?? extractMediaIdFromUrl(image.previewUrl),
      image.previewSize ?? 1
    );
  }
  return target;
}

function collectMediaUsageFromCard(rawCard, usageById) {
  const target = usageById instanceof Map ? usageById : new Map();
  if (!rawCard || typeof rawCard !== 'object') return target;
  collectMediaUsageFromImages(rawCard.images, target);
  const comments = sanitizeComments(rawCard.comments, { keepInputOrder: true, enforceMax: false });
  for (const comment of comments) {
    collectMediaUsageFromImages(comment.images, target);
  }
  return target;
}

function collectMediaUsageFromBoardState(rawState, usageById) {
  const target = usageById instanceof Map ? usageById : new Map();
  const state = sanitizeBoardState(rawState) ?? defaultBoardState();
  for (const card of Object.values(state.cardsById ?? {})) {
    collectMediaUsageFromCard(card, target);
  }
  return target;
}

function sumMediaUsageBytes(usageById) {
  if (!(usageById instanceof Map)) return 0;
  let total = 0;
  for (const bytes of usageById.values()) {
    const n = Number(bytes);
    if (!Number.isFinite(n) || n <= 0) continue;
    total += Math.trunc(n);
  }
  return total;
}

function getFileUserMediaUsageMap(db, userId) {
  const state = sanitizeBoardState(db?.boards?.[userId]) ?? defaultBoardState();
  return collectMediaUsageFromBoardState(state, new Map());
}

async function getMysqlUserMediaUsageMap(pool, userId) {
  const usageById = new Map();
  await ensureMysqlMediaSchema(pool);

  const [linkRows] = await pool.query(
    `SELECT file_id, size, preview_file_id, preview_size
     FROM ${MYSQL_MEDIA_LINKS_TABLE}
     WHERE user_id = ?`,
    [userId]
  );
  for (const row of Array.isArray(linkRows) ? linkRows : []) {
    addMediaUsageEntry(usageById, row?.file_id, row?.size);
    addMediaUsageEntry(usageById, row?.preview_file_id, row?.preview_size ?? 1);
  }
  if (usageById.size > 0) return usageById;

  const appendRows = (rows) => {
    for (const row of Array.isArray(rows) ? rows : []) {
      collectMediaUsageFromImages(parseCardImagesFromDb(row?.images_json), usageById);
    }
  };

  const [cardRows] = await pool.query(
    `SELECT images_json
     FROM ${MYSQL_CARDS_TABLE}
     WHERE user_id = ? AND images_json IS NOT NULL`,
    [userId]
  );
  appendRows(cardRows);
  const [commentRows] = await pool.query(
    `SELECT images_json
     FROM ${MYSQL_COMMENTS_TABLE}
     WHERE user_id = ? AND images_json IS NOT NULL`,
    [userId]
  );
  appendRows(commentRows);
  const [archiveRows] = await pool.query(
    `SELECT images_json
     FROM ${MYSQL_COMMENTS_ARCHIVE_TABLE}
     WHERE user_id = ? AND images_json IS NOT NULL`,
    [userId]
  );
  appendRows(archiveRows);
  return usageById;
}

async function getUserMediaUsageSummary({ provider, userId, db, pool }) {
  const normalizedUserId = String(userId ?? '').trim();
  if (!normalizedUserId) {
    return {
      limitBytes: MAX_MEDIA_BYTES_PER_USER,
      referencedBytes: 0,
      pendingBytes: 0,
      usedBytes: 0,
    };
  }

  const usageById =
    provider === 'mysql'
      ? await getMysqlUserMediaUsageMap(pool, normalizedUserId)
      : getFileUserMediaUsageMap(db, normalizedUserId);
  const referencedBytes = sumMediaUsageBytes(usageById);
  const pendingBytes = getPendingMediaBytesForUser(normalizedUserId, usageById);
  return {
    limitBytes: MAX_MEDIA_BYTES_PER_USER,
    referencedBytes,
    pendingBytes,
    usedBytes: referencedBytes + pendingBytes,
  };
}

function releaseMediaGcGraceForRemovedBoardState(previousState, nextState, reason = 'media-detached') {
  const previousIds = collectReferencedMediaIdsFromBoardState(previousState, new Set());
  const nextIds = collectReferencedMediaIdsFromBoardState(nextState, new Set());
  return releaseMediaGcGraceForRemovedIds(previousIds, nextIds, reason);
}

function collectReferencedMediaIdsFromFileDb() {
  const out = new Set();
  const db = readDbFromFile();
  const boards = db?.boards && typeof db.boards === 'object' ? db.boards : {};
  for (const rawBoard of Object.values(boards)) {
    const state = sanitizeBoardState(rawBoard) ?? defaultBoardState();
    for (const card of Object.values(state.cardsById ?? {})) {
      if (!card || typeof card !== 'object') continue;
      collectReferencedMediaIdsFromImages(card.images, out);
      const comments = sanitizeComments(card.comments, { keepInputOrder: true, enforceMax: false });
      for (const comment of comments) {
        collectReferencedMediaIdsFromImages(comment.images, out);
      }
    }
  }
  return out;
}

async function collectReferencedMediaIdsFromMysqlDb() {
  if (!mysqlSchemaReady) return null;
  const pool = await getMysqlPool();
  await ensureMysqlMediaSchema(pool);

  const out = new Set();
  const [linkRows] = await pool.query(
    `SELECT file_id, preview_file_id
     FROM ${MYSQL_MEDIA_LINKS_TABLE}`
  );
  for (const row of Array.isArray(linkRows) ? linkRows : []) {
    const fileId = normalizeMediaId(row?.file_id);
    if (fileId) out.add(fileId);
    const previewFileId = normalizeMediaId(row?.preview_file_id);
    if (previewFileId) out.add(previewFileId);
  }
  if (out.size > 0) return out;

  const appendRows = (rows) => {
    for (const row of Array.isArray(rows) ? rows : []) {
      collectReferencedMediaIdsFromImages(parseCardImagesFromDb(row?.images_json), out);
    }
  };
  const [cardRows] = await pool.query(
    `SELECT images_json
     FROM ${MYSQL_CARDS_TABLE}
     WHERE images_json IS NOT NULL`
  );
  appendRows(cardRows);
  const [commentRows] = await pool.query(
    `SELECT images_json
     FROM ${MYSQL_COMMENTS_TABLE}
     WHERE images_json IS NOT NULL`
  );
  appendRows(commentRows);
  const [archiveRows] = await pool.query(
    `SELECT images_json
     FROM ${MYSQL_COMMENTS_ARCHIVE_TABLE}
     WHERE images_json IS NOT NULL`
  );
  appendRows(archiveRows);
  return out;
}

async function collectReferencedMediaIds() {
  if (DB_PROVIDER === 'mysql') {
    return collectReferencedMediaIdsFromMysqlDb();
  }
  return collectReferencedMediaIdsFromFileDb();
}

function listStoredMediaIds() {
  ensureMediaDir();
  const out = [];
  const entries = readdirSync(MEDIA_DIR, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry?.isFile?.()) continue;
    const mediaId = normalizeMediaId(entry.name);
    if (!mediaId) continue;
    if (!mediaMimeFromId(mediaId, null)) continue;
    out.push(mediaId);
  }
  return out;
}

async function runMediaGarbageCollector() {
  ensureMediaDir();

  const referencedFromStore = await collectReferencedMediaIds();
  if (!referencedFromStore) {
    return { removed: 0, scanned: 0, skipped: 'schema-not-ready' };
  }

  const now = Date.now();
  purgeExpiredMediaGcGrace(now);
  for (const mediaId of mediaGcKeepUntilById.keys()) {
    if (referencedFromStore.has(mediaId)) {
      mediaGcKeepUntilById.delete(mediaId);
    }
  }
  const referenced = new Set(referencedFromStore);
  for (const mediaId of mediaGcKeepUntilById.keys()) {
    referenced.add(mediaId);
  }

  const stored = listStoredMediaIds();
  let removed = 0;
  for (const mediaId of stored) {
    if (referenced.has(mediaId)) continue;
    const fullPath = mediaIdToPath(mediaId);
    if (!fullPath) continue;
    try {
      unlinkSync(fullPath);
      removed += 1;
    } catch (err) {
      if (String(err?.code ?? '') !== 'ENOENT') {
        console.error('[media-gc] failed to remove file', mediaId, err);
      }
    }
  }

  return { removed, scanned: stored.length };
}

async function runMediaGarbageCollectorSafely() {
  if (mediaGcRunning) {
    mediaGcPending = true;
    return;
  }
  mediaGcRunning = true;
  try {
    const result = await runMediaGarbageCollector();
    if (result.removed > 0) {
      console.log(`[media-gc] removed ${result.removed} orphan file(s)`);
    }
  } catch (err) {
    console.error('[media-gc] unhandled error', err);
  } finally {
    mediaGcRunning = false;
    if (mediaGcPending) {
      mediaGcPending = false;
      scheduleMediaGc('pending');
    }
  }
}

function scheduleMediaGc(_reason = 'mutation', delayMs = MEDIA_GC_DEBOUNCE_MS) {
  const delay = Number.isFinite(Number(delayMs)) ? Math.max(0, Math.trunc(Number(delayMs))) : MEDIA_GC_DEBOUNCE_MS;
  if (mediaGcTimer) return;
  mediaGcTimer = setTimeout(() => {
    mediaGcTimer = null;
    runMediaGarbageCollectorSafely().catch((err) => {
      console.error('[media-gc] scheduler error', err);
    });
  }, delay);
}

function persistCardImagePayload(payloadBase64, mime, options = null) {
  const normalizedMime = normalizeCardImageMime(mime);
  if (!normalizedMime) return null;
  const ext = CARD_IMAGE_EXT_BY_MIME[normalizedMime] ?? '.bin';
  const mediaId = `${randomUUID()}${ext}`;
  const fullPath = mediaIdToPath(mediaId);
  if (!fullPath) return null;
  const buffer = Buffer.from(String(payloadBase64 ?? ''), 'base64');
  if (!buffer.length || buffer.length > MAX_CARD_IMAGE_BYTES) return null;
  ensureMediaDir();
  const tmpPath = `${fullPath}.tmp`;
  writeFileSync(tmpPath, buffer);
  renameSync(tmpPath, fullPath);
  markMediaForGcGrace(mediaId, options?.ttlMs, {
    ownerUserId: options?.ownerUserId,
    bytes: buffer.length,
  });
  return { mediaId, bytes: buffer.length, mime: normalizedMime };
}

function normalizeCardImageSize(value, fallbackBytes = 1) {
  const raw = Number(value);
  if (Number.isFinite(raw) && raw > 0) {
    return Math.min(Math.trunc(raw), MAX_CARD_IMAGE_BYTES);
  }
  const fallback = Number(fallbackBytes);
  if (!Number.isFinite(fallback) || fallback <= 0) return 1;
  return Math.min(Math.trunc(fallback), MAX_CARD_IMAGE_BYTES);
}

function sanitizeCardImages(raw, options = {}) {
  if (!Array.isArray(raw)) return [];
  const persistDataUrls = options?.persistDataUrls === true;

  const out = [];
  const seen = new Set();
  let totalBytes = 0;

  for (const entry of raw) {
    if (!entry || typeof entry !== 'object') continue;
    const id = sanitizeText(entry.id, 128);
    if (!id || seen.has(id)) continue;

    const mediaIdFromField = normalizeMediaId(entry.fileId);
    const mediaIdFromUrl = extractMediaIdFromUrl(entry.dataUrl);
    let mediaId = mediaIdFromField ?? mediaIdFromUrl;
    let mime = mediaMimeFromId(mediaId, entry.mime);
    let payloadBytes = 0;
    let dataUrl = null;
    let previewMediaId = normalizeMediaId(entry.previewFileId ?? null) ?? extractMediaIdFromUrl(entry.previewUrl);
    let previewMime = mediaMimeFromId(previewMediaId, entry.previewMime);
    let previewPayloadBytes = 0;
    let previewUrl = null;

    if (!mediaId) {
      const normalized = sanitizeCardImageDataUrl(entry.dataUrl, entry.mime);
      if (!normalized) continue;
      payloadBytes = normalized.bytes;
      if (persistDataUrls) {
        const persisted = persistCardImagePayload(normalized.payload, normalized.mime);
        if (!persisted) continue;
        mediaId = persisted.mediaId;
        mime = persisted.mime;
        payloadBytes = persisted.bytes;
        dataUrl = mediaPublicUrl(persisted.mediaId);
      } else {
        mime = normalized.mime;
        dataUrl = normalized.dataUrl;
      }
    } else {
      const mediaPath = mediaIdToPath(mediaId);
      if (!mediaPath || !existsSync(mediaPath)) continue;
      dataUrl = mediaPublicUrl(mediaId);
      if (!dataUrl) continue;
      if (!mime) mime = normalizeCardImageMime(entry.mime);
    }

    if (!previewMediaId) {
      const previewNormalized = sanitizeCardImageDataUrl(entry.previewUrl, entry.previewMime);
      if (previewNormalized) {
        previewPayloadBytes = previewNormalized.bytes;
        if (persistDataUrls) {
          const persistedPreview = persistCardImagePayload(previewNormalized.payload, previewNormalized.mime);
          if (persistedPreview) {
            previewMediaId = persistedPreview.mediaId;
            previewMime = persistedPreview.mime;
            previewPayloadBytes = persistedPreview.bytes;
            previewUrl = mediaPublicUrl(persistedPreview.mediaId);
          }
        } else {
          previewMime = previewNormalized.mime;
          previewUrl = previewNormalized.dataUrl;
        }
      }
    } else {
      const previewPath = mediaIdToPath(previewMediaId);
      if (previewPath && existsSync(previewPath)) {
        previewUrl = mediaPublicUrl(previewMediaId);
        if (previewUrl && !previewMime) {
          previewMime = normalizeCardImageMime(entry.previewMime);
        }
      } else {
        previewMediaId = null;
        previewMime = null;
        previewUrl = null;
      }
    }

    if (!mime || !dataUrl || !mediaId && persistDataUrls) continue;

    const createdAtRaw = Number(entry.createdAt);
    const createdAt = Number.isFinite(createdAtRaw) ? Math.max(0, Math.trunc(createdAtRaw)) : Date.now();
    const size = normalizeCardImageSize(entry.size, payloadBytes || 1);
    const previewSize = previewUrl ? normalizeCardImageSize(entry.previewSize, previewPayloadBytes || 1) : null;
    const name = sanitizeText(entry.name, MAX_CARD_IMAGE_NAME_LEN);
    if (totalBytes + size > MAX_CARD_IMAGES_TOTAL_BYTES) continue;

    seen.add(id);
    totalBytes += size;
    out.push({
      id,
      fileId: mediaId ?? null,
      dataUrl,
      mime,
      size,
      name,
      createdAt,
      previewFileId: previewMediaId ?? null,
      previewUrl: previewUrl ?? null,
      previewMime: previewMime ?? null,
      previewSize: previewSize ?? null,
    });

    if (out.length >= MAX_CARD_IMAGES) break;
  }

  out.sort((a, b) => {
    if (a.createdAt !== b.createdAt) return a.createdAt - b.createdAt;
    return a.id.localeCompare(b.id);
  });

  return out;
}

function parseCardImagesFromDb(raw) {
  if (raw == null) return [];
  let parsed = [];
  try {
    if (Buffer.isBuffer(raw)) parsed = JSON.parse(raw.toString('utf8'));
    else if (typeof raw === 'string') parsed = JSON.parse(raw);
    else parsed = raw;
  } catch {
    parsed = [];
  }
  return sanitizeCardImages(parsed);
}

function toDbCardImages(raw) {
  const images = sanitizeCardImages(raw, { persistDataUrls: true });
  const out = [];
  for (const image of images) {
    const fileId = normalizeMediaId(image.fileId ?? extractMediaIdFromUrl(image.dataUrl));
    if (!fileId) continue;
    const previewFileId = normalizeMediaId(image.previewFileId ?? extractMediaIdFromUrl(image.previewUrl));
    out.push({
      id: sanitizeText(image.id, 128),
      fileId,
      mime: normalizeCardImageMime(image.mime) ?? mediaMimeFromId(fileId, null),
      size: normalizeCardImageSize(image.size, 1),
      name: sanitizeText(image.name, MAX_CARD_IMAGE_NAME_LEN),
      createdAt: Number.isFinite(Number(image.createdAt)) ? Math.max(0, Math.trunc(Number(image.createdAt))) : Date.now(),
      previewFileId: previewFileId ?? null,
      previewMime: previewFileId
        ? (normalizeCardImageMime(image.previewMime) ?? mediaMimeFromId(previewFileId, null))
        : null,
      previewSize: previewFileId ? normalizeCardImageSize(image.previewSize, 1) : null,
    });
  }
  return out;
}

function encodeCardImagesForDb(raw) {
  const images = toDbCardImages(raw);
  return images.length > 0 ? JSON.stringify(images) : null;
}

function parseCommentImagesFromDb(raw) {
  return parseCardImagesFromDb(raw);
}

function encodeCommentImagesForDb(raw) {
  return encodeCardImagesForDb(raw);
}

function parseChecklistFromDb(raw) {
  if (raw == null) return [];
  let parsed = [];
  try {
    if (Buffer.isBuffer(raw)) parsed = JSON.parse(raw.toString('utf8'));
    else if (typeof raw === 'string') parsed = JSON.parse(raw);
    else parsed = raw;
  } catch {
    parsed = [];
  }
  return sanitizeChecklist(parsed);
}

function encodeChecklistForDb(raw) {
  const checklist = sanitizeChecklist(raw);
  return checklist.length > 0 ? JSON.stringify(checklist) : null;
}

function sanitizeHistoryKind(value) {
  const kind = String(value ?? '')
    .trim()
    .toLowerCase();
  return HISTORY_KIND_SET.has(kind) ? kind : null;
}

function sanitizeHistoryColumn(value) {
  if (value == null) return null;
  const col = String(value).trim();
  return COLUMN_IDS.includes(col) ? col : null;
}

function sanitizeHistoryMeta(raw) {
  if (!raw || typeof raw !== 'object') return null;

  const has = (key) => Object.prototype.hasOwnProperty.call(raw, key);
  const out = {};

  const title = sanitizeText(raw.title, 512);
  if (title) out.title = title;

  if (has('fromCol')) out.fromCol = sanitizeHistoryColumn(raw.fromCol);
  if (has('toCol')) out.toCol = sanitizeHistoryColumn(raw.toCol);

  if (has('doingDeltaMs')) {
    const ms = Number(raw.doingDeltaMs);
    out.doingDeltaMs = Number.isFinite(ms) && ms > 0 ? Math.trunc(ms) : 0;
  }

  return Object.keys(out).length > 0 ? out : null;
}

function displayCardTitle(title) {
  const clean = sanitizeText(title, 512);
  return clean || 'Без названия';
}

function fallbackFloatingPin(index) {
  const col = index % 3;
  const row = Math.floor(index / 3);
  return {
    x: 24 + col * 268,
    y: 124 + row * 146,
    swayOffsetMs: (index * 187) % 2400,
  };
}

function deriveCardStatus(cardId, columns, floatingById) {
  const pos = getCardPosition(columns, cardId);
  if (pos.columnId) return pos.columnId;
  if (floatingById && Object.prototype.hasOwnProperty.call(floatingById, cardId)) return 'freedom';
  return 'queue';
}

function syncCardStatuses(cardsById, columns, floatingById) {
  const next = {};
  for (const [id, card] of Object.entries(cardsById || {})) {
    const status = deriveCardStatus(id, columns, floatingById);
    next[id] = card?.status === status ? card : { ...card, status };
  }
  return next;
}

function sanitizeBoardState(raw) {
  if (!raw || typeof raw !== 'object') return null;

  const sourceCards = raw.cardsById;
  const sourceColumns = raw.columns;
  const sourceFloating = raw.floatingById;
  const sourceHistory = raw.history;

  if (!sourceCards || typeof sourceCards !== 'object') return null;
  if (!sourceColumns || typeof sourceColumns !== 'object') return null;

  const cardsById = {};

  for (const [key, value] of Object.entries(sourceCards)) {
    if (!value || typeof value !== 'object') continue;

    const id = String(key).trim();
    if (!id) continue;

    const createdAt = Number(value.createdAt);
    const doingTotalMs = Number(value.doingTotalMs);
    const startedRaw = value.doingStartedAt;
    const doingStartedAt = startedRaw == null ? null : Number(startedRaw);
    const rawStatus = String(value.status ?? '')
      .trim()
      .toLowerCase();

    const urgency = URGENCY_SET.has(value.urgency) ? value.urgency : 'white';
    const status = CARD_STATUS_SET.has(rawStatus) ? rawStatus : 'queue';

    cardsById[id] = {
      id,
      title: sanitizeText(value.title, 512),
      description: sanitizeText(value.description, 5000),
      images: sanitizeCardImages(value.images),
      checklist: sanitizeChecklist(value.checklist),
      createdBy: sanitizeCardCreator(value.createdBy),
      isFavorite: sanitizeCardFavorite(value.isFavorite),
      comments: sanitizeComments(value.comments),
      createdAt: Number.isFinite(createdAt) ? createdAt : Date.now(),
      status,
      urgency,
      doingStartedAt: Number.isFinite(doingStartedAt) ? doingStartedAt : null,
      doingTotalMs: Number.isFinite(doingTotalMs) && doingTotalMs > 0 ? doingTotalMs : 0,
    };
  }

  const used = new Set();
  const columns = {
    queue: [],
    doing: [],
    review: [],
    done: [],
  };

  for (const col of COLUMN_IDS) {
    const arr = Array.isArray(sourceColumns[col]) ? sourceColumns[col] : [];
    for (const rawId of arr) {
      const id = String(rawId ?? '').trim();
      if (!id || !cardsById[id] || used.has(id)) continue;
      used.add(id);
      columns[col].push(id);
    }
  }

  const floatingById = {};
  let floatingIndex = 0;
  if (sourceFloating && typeof sourceFloating === 'object') {
    for (const [rawId, rawPos] of Object.entries(sourceFloating)) {
      if (!rawPos || typeof rawPos !== 'object') continue;
      const id = String(rawId ?? '').trim();
      if (!id || !cardsById[id] || used.has(id)) continue;

      const x = Number(rawPos.x);
      const y = Number(rawPos.y);
      const swayOffsetMs = Number(rawPos.swayOffsetMs);

      floatingById[id] = {
        x: Number.isFinite(x) ? Math.trunc(x) : 24,
        y: Number.isFinite(y) ? Math.trunc(y) : 120,
        swayOffsetMs: Number.isFinite(swayOffsetMs) && swayOffsetMs >= 0 ? Math.trunc(swayOffsetMs) : 0,
      };
      used.add(id);
      floatingIndex += 1;
    }
  }

  for (const id of Object.keys(cardsById)) {
    if (used.has(id)) continue;
    floatingById[id] = fallbackFloatingPin(floatingIndex);
    used.add(id);
    floatingIndex += 1;
  }

  const history = [];
  const srcHistory = Array.isArray(sourceHistory) ? sourceHistory : [];

  for (const h of srcHistory.slice(0, HISTORY_MAX_PER_USER)) {
    if (!h || typeof h !== 'object') continue;

    const id = String(h.id ?? randomUUID());
    const at = Number(h.at);
    const text = sanitizeText(h.text, 1000);
    const kind = sanitizeHistoryKind(h.kind);
    const meta = sanitizeHistoryMeta(h.meta);

    let cardId = null;
    if (typeof h.cardId === 'string' && h.cardId.trim()) {
      cardId = h.cardId.trim();
    }

    const entry = {
      id,
      at: Number.isFinite(at) ? at : Date.now(),
      text,
      cardId,
    };
    if (kind) entry.kind = kind;
    if (meta) entry.meta = meta;

    history.push(entry);
  }

  const normalizedCardsById = syncCardStatuses(cardsById, columns, floatingById);
  return { cardsById: normalizedCardsById, columns, floatingById, history };
}

function getCardPosition(columns, cardId) {
  for (const col of COLUMN_IDS) {
    const index = columns[col].indexOf(cardId);
    if (index >= 0) return { columnId: col, index };
  }
  return { columnId: null, index: -1 };
}

function extractMediaIdFromPath(pathname) {
  const m = /^\/api\/media\/([^/]+)$/.exec(pathname);
  if (!m) return null;
  try {
    return normalizeMediaId(decodeURIComponent(m[1]).trim());
  } catch {
    return null;
  }
}

function extractCardIdFromPath(pathname) {
  const m = /^\/api\/cards\/([^/]+)$/.exec(pathname);
  if (!m) return null;
  try {
    const id = decodeURIComponent(m[1]).trim();
    return id || null;
  } catch {
    return null;
  }
}

function nextSequentialCardId(cardsById) {
  let max = 0;
  for (const rawId of Object.keys(cardsById || {})) {
    const m = /^P-(\d+)$/i.exec(String(rawId).trim());
    if (!m) continue;
    const n = Number(m[1]);
    if (Number.isInteger(n) && n > max) max = n;
  }
  return `P-${max + 1}`;
}

function clampIndex(value, min, max) {
  if (!Number.isFinite(value)) return min;
  const n = Math.trunc(value);
  if (n < min) return min;
  if (n > max) return max;
  return n;
}

function columnTitle(columnId) {
  switch (columnId) {
    case 'queue':
      return 'Очередь';
    case 'doing':
      return 'Делаем';
    case 'review':
      return 'Проверка';
    case 'done':
      return 'Сделано';
    default:
      return 'Очередь';
  }
}

function formatElapsedHms(ms) {
  const totalSec = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

function extractCardMoveIdFromPath(pathname) {
  const m = /^\/api\/cards\/([^/]+)\/move$/.exec(pathname);
  if (!m) return null;
  try {
    const id = decodeURIComponent(m[1]).trim();
    return id || null;
  } catch {
    return null;
  }
}

function extractCardCommentsIdFromPath(pathname) {
  const m = /^\/api\/cards\/([^/]+)\/comments$/.exec(pathname);
  if (!m) return null;
  try {
    const cardId = decodeURIComponent(m[1]).trim();
    return cardId || null;
  } catch {
    return null;
  }
}

function extractCardCommentsArchiveIdFromPath(pathname) {
  const m = /^\/api\/cards\/([^/]+)\/comments\/archive$/.exec(pathname);
  if (!m) return null;
  try {
    const cardId = decodeURIComponent(m[1]).trim();
    return cardId || null;
  } catch {
    return null;
  }
}

function extractCardCommentArchiveRestorePath(pathname) {
  const m = /^\/api\/cards\/([^/]+)\/comments\/archive\/([^/]+)\/restore$/.exec(pathname);
  if (!m) return null;
  try {
    const cardId = decodeURIComponent(m[1]).trim();
    const archiveIdRaw = decodeURIComponent(m[2]).trim();
    const archiveId = Number(archiveIdRaw);
    if (!cardId || !Number.isFinite(archiveId) || archiveId <= 0) return null;
    return { cardId, archiveId: Math.trunc(archiveId) };
  } catch {
    return null;
  }
}

function extractCardCommentPath(pathname) {
  const m = /^\/api\/cards\/([^/]+)\/comments\/([^/]+)$/.exec(pathname);
  if (!m) return null;
  try {
    const cardId = decodeURIComponent(m[1]).trim();
    const commentId = decodeURIComponent(m[2]).trim();
    if (!cardId || !commentId) return null;
    return { cardId, commentId };
  } catch {
    return null;
  }
}

function extractHistoryEntryIdFromPath(pathname) {
  const m = /^\/api\/history\/([^/]+)$/.exec(pathname);
  if (!m) return null;
  try {
    const id = decodeURIComponent(m[1]).trim();
    return id || null;
  } catch {
    return null;
  }
}

function parseNonNegativeInt(value, fallback, max = Number.MAX_SAFE_INTEGER) {
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) return fallback;
  return Math.min(Math.trunc(n), max);
}

function parsePositiveInt(value, fallback, min = 1, max = Number.MAX_SAFE_INTEGER) {
  const n = Number(value);
  if (!Number.isFinite(n) || n < min) return fallback;
  return Math.min(Math.trunc(n), max);
}

async function requireMysqlUser(req, res, pool) {
  const token = extractBearerToken(req);
  if (!token) {
    sendJson(res, 401, { error: 'UNAUTHORIZED' }, req);
    return null;
  }

  const now = Date.now();
  await pool.query(`DELETE FROM ${MYSQL_SESSIONS_TABLE} WHERE token = ? AND expires_at_ms <= ?`, [token, now]);
  const [rows] = await pool.query(
    `SELECT u.id, u.login, u.email
     FROM ${MYSQL_SESSIONS_TABLE} s
     INNER JOIN ${MYSQL_USERS_TABLE} u ON u.id = s.user_id
     WHERE s.token = ? AND s.expires_at_ms > ?
     LIMIT 1`,
    [token, now]
  );

  if (!Array.isArray(rows) || rows.length === 0) {
    sendJson(res, 401, { error: 'UNAUTHORIZED' }, req);
    return null;
  }

  return {
    id: String(rows[0].id ?? ''),
    login: normalizeLogin(rows[0].login),
    email: normalizeEmail(rows[0].email),
  };
}

function mysqlRowToUser(row) {
  if (!row || typeof row !== 'object') return null;
  const id = String(row.id ?? '').trim();
  if (!id) return null;
  return {
    id,
    login: normalizeLogin(row.login),
    email: normalizeEmail(row.email),
    passwordSalt: String(row.password_salt ?? ''),
    passwordHash: String(row.password_hash ?? ''),
    createdAt: Number(row.created_at_ms) || Date.now(),
    avatarUrl: sanitizeProfileAvatarUrl(row.avatar_data_url),
    firstName: sanitizeProfileName(row.first_name, MAX_PROFILE_FIRST_NAME_LEN),
    lastName: sanitizeProfileName(row.last_name, MAX_PROFILE_LAST_NAME_LEN),
    birthDate: sanitizeProfileBirthDate(row.birth_date),
    role: sanitizeProfileRole(row.role_title),
    city: sanitizeProfileCity(row.city_title),
    about: sanitizeProfileAbout(row.bio),
  };
}

async function mysqlGetUserById(executor, userId) {
  const [rows] = await executor.query(
    `SELECT id, login, email, password_salt, password_hash, created_at_ms, avatar_data_url, first_name, last_name, birth_date, role_title, city_title, bio
     FROM ${MYSQL_USERS_TABLE}
     WHERE id = ?
     LIMIT 1`,
    [userId]
  );
  if (!Array.isArray(rows) || rows.length === 0) return null;
  return mysqlRowToUser(rows[0]);
}

async function mysqlCardExists(pool, userId, cardId) {
  const [rows] = await pool.query(
    `SELECT 1
     FROM ${MYSQL_CARDS_TABLE}
     WHERE user_id = ? AND id = ?
     LIMIT 1`,
    [userId, cardId]
  );
  return Array.isArray(rows) && rows.length > 0;
}

async function mysqlCountComments(pool, userId, cardId) {
  const [rows] = await pool.query(
    `SELECT COUNT(*) AS cnt
     FROM ${MYSQL_COMMENTS_TABLE} FORCE INDEX (idx_comments_user_card_created)
     WHERE user_id = ? AND card_id = ?`,
    [userId, cardId]
  );
  return Array.isArray(rows) && rows.length > 0 ? Number(rows[0].cnt ?? 0) : 0;
}

function sanitizeCommentArchiveReason(value) {
  const reason = String(value ?? '')
    .trim()
    .toLowerCase();
  if (COMMENT_ARCHIVE_REASON_SET.has(reason)) return reason;
  return 'unknown';
}

function parseCommentArchiveReasonFilter(value) {
  if (value == null) return { ok: true, reason: null };
  const raw = String(value)
    .trim()
    .toLowerCase();
  if (!raw || raw === 'all') return { ok: true, reason: null };
  if (!COMMENT_ARCHIVE_REASON_SET.has(raw)) return { ok: false, reason: null };
  return { ok: true, reason: raw };
}

function parseHistoryKindFilter(value) {
  if (value == null) return { ok: true, kind: null };
  const raw = String(value)
    .trim()
    .toLowerCase();
  if (!raw || raw === 'all') return { ok: true, kind: null };
  const kind = sanitizeHistoryKind(raw);
  if (!kind) return { ok: false, kind: null };
  return { ok: true, kind };
}

function parseFavoritesStatusFilter(value) {
  if (value == null) return { ok: true, status: null };
  const raw = String(value)
    .trim()
    .toLowerCase();
  if (!raw || raw === 'all') return { ok: true, status: null };
  if (!CARD_STATUS_SET.has(raw)) return { ok: false, status: null };
  return { ok: true, status: raw };
}

function buildFavoritesEntriesFromState(rawState, options = {}) {
  const state = sanitizeBoardState(rawState) ?? defaultBoardState();
  const order = String(options?.order ?? 'desc').trim().toLowerCase() === 'asc' ? 'asc' : 'desc';
  const parsedStatus = parseFavoritesStatusFilter(options?.status);
  const statusFilter = parsedStatus.ok ? parsedStatus.status : null;

  const entries = [];
  const seen = new Set();

  for (const columnId of COLUMN_IDS) {
    const ids = Array.isArray(state.columns?.[columnId]) ? state.columns[columnId] : [];
    for (let index = 0; index < ids.length; index += 1) {
      const cardId = String(ids[index] ?? '').trim();
      if (!cardId || seen.has(cardId)) continue;
      const card = state.cardsById?.[cardId];
      if (!card || !card.isFavorite) continue;
      const status = columnId;
      if (statusFilter && status !== statusFilter) {
        seen.add(cardId);
        continue;
      }
      entries.push({
        card,
        columnId,
        index,
        status,
        floating: null,
      });
      seen.add(cardId);
    }
  }

  const floatingRows = Object.entries(state.floatingById ?? {})
    .map(([cardId, pos]) => ({
      cardId: String(cardId ?? '').trim(),
      pos,
    }))
    .filter(({ cardId, pos }) => cardId && pos && typeof pos === 'object')
    .sort((a, b) => {
      const ay = Number(a.pos.y);
      const by = Number(b.pos.y);
      if (ay !== by) return ay - by;
      const ax = Number(a.pos.x);
      const bx = Number(b.pos.x);
      if (ax !== bx) return ax - bx;
      return a.cardId.localeCompare(b.cardId);
    });

  for (const row of floatingRows) {
    const cardId = row.cardId;
    if (!cardId || seen.has(cardId)) continue;
    const card = state.cardsById?.[cardId];
    if (!card || !card.isFavorite) continue;
    const status = 'freedom';
    if (statusFilter && status !== statusFilter) {
      seen.add(cardId);
      continue;
    }
    entries.push({
      card,
      columnId: null,
      index: -1,
      status,
      floating: {
        x: Number.isFinite(Number(row.pos.x)) ? Math.trunc(Number(row.pos.x)) : 24,
        y: Number.isFinite(Number(row.pos.y)) ? Math.trunc(Number(row.pos.y)) : 120,
        swayOffsetMs: Number.isFinite(Number(row.pos.swayOffsetMs)) ? Math.max(0, Math.trunc(Number(row.pos.swayOffsetMs))) : 0,
      },
    });
    seen.add(cardId);
  }

  const extraCards = Object.values(state.cardsById ?? {})
    .filter((card) => card && card.isFavorite && !seen.has(card.id))
    .sort((a, b) => {
      const atA = Number(a.createdAt) || 0;
      const atB = Number(b.createdAt) || 0;
      if (atA !== atB) return atA - atB;
      return String(a.id ?? '').localeCompare(String(b.id ?? ''));
    });

  for (const card of extraCards) {
    const status = deriveCardStatus(card.id, state.columns, state.floatingById);
    if (statusFilter && status !== statusFilter) continue;
    const pos = getCardPosition(state.columns, card.id);
    entries.push({
      card,
      columnId: pos.columnId,
      index: pos.index,
      status,
      floating:
        status === 'freedom' && state.floatingById?.[card.id]
          ? {
              x: Number.isFinite(Number(state.floatingById[card.id].x)) ? Math.trunc(Number(state.floatingById[card.id].x)) : 24,
              y: Number.isFinite(Number(state.floatingById[card.id].y)) ? Math.trunc(Number(state.floatingById[card.id].y)) : 120,
              swayOffsetMs: Number.isFinite(Number(state.floatingById[card.id].swayOffsetMs))
                ? Math.max(0, Math.trunc(Number(state.floatingById[card.id].swayOffsetMs)))
                : 0,
            }
          : null,
    });
  }

  if (order === 'desc') entries.reverse();
  return entries;
}

async function pruneMysqlCommentsArchiveForUser(executor, userId) {
  const [result] = await executor.query(
    `DELETE FROM ${MYSQL_COMMENTS_ARCHIVE_TABLE}
     WHERE user_id = ?
       AND archive_id NOT IN (
         SELECT archive_id
         FROM (
           SELECT archive_id
           FROM ${MYSQL_COMMENTS_ARCHIVE_TABLE}
           WHERE user_id = ?
           ORDER BY archived_at_ms DESC, archive_id DESC
           LIMIT ${MAX_ARCHIVED_COMMENTS_PER_USER}
         ) keepers
       )`,
    [userId, userId]
  );
  const deleted = Number(result?.affectedRows ?? 0);
  if (deleted > 0) {
    await mysqlDeleteOrphanArchivedMediaLinks(executor, userId);
    await mysqlPruneUnlinkedMediaFiles(executor, userId);
  }
}

async function mysqlArchiveCommentsByIds(executor, userId, cardId, commentIds, reason, archivedAt = Date.now()) {
  const ids = Array.isArray(commentIds)
    ? commentIds
        .map((id) => String(id ?? '').trim())
        .filter((id) => !!id)
    : [];
  if (ids.length === 0) return 0;
  const placeholders = ids.map(() => '?').join(', ');
  const archiveReason = sanitizeCommentArchiveReason(reason);
  const [result] = await executor.query(
    `INSERT INTO ${MYSQL_COMMENTS_ARCHIVE_TABLE}
      (user_id, card_id, id, author, text, images_json, created_at_ms, updated_at_ms, archived_at_ms, archive_reason)
     SELECT user_id, card_id, id, author, text, images_json, created_at_ms, updated_at_ms, ?, ?
     FROM ${MYSQL_COMMENTS_TABLE}
     WHERE user_id = ? AND card_id = ? AND id IN (${placeholders})`,
    [archivedAt, archiveReason, userId, cardId, ...ids]
  );
  const archived = Number(result?.affectedRows ?? 0);
  if (archived > 0) {
    const firstArchiveId = Number(result?.insertId ?? 0);
    if (Number.isFinite(firstArchiveId) && firstArchiveId > 0) {
      const lastArchiveId = firstArchiveId + archived - 1;
      const [archiveRows] = await executor.query(
        `SELECT archive_id, card_id, images_json
         FROM ${MYSQL_COMMENTS_ARCHIVE_TABLE}
         WHERE user_id = ? AND archive_id BETWEEN ? AND ?`,
        [userId, firstArchiveId, lastArchiveId]
      );
      for (const row of Array.isArray(archiveRows) ? archiveRows : []) {
        const archiveRef = `a:${Math.max(0, Math.trunc(Number(row?.archive_id) || 0))}`;
        await mysqlReplaceMediaLinksForOwner(
          executor,
          userId,
          'comment_archive',
          String(row?.card_id ?? '').trim(),
          archiveRef,
          parseCommentImagesFromDb(row?.images_json)
        );
      }
    } else {
      await mysqlRebuildMediaIndexForUser(executor, userId);
    }
  }
  if (archived > 0) {
    await pruneMysqlCommentsArchiveForUser(executor, userId);
  }
  return archived;
}

async function mysqlArchiveCommentsByCard(executor, userId, cardId, reason, archivedAt = Date.now()) {
  const archiveReason = sanitizeCommentArchiveReason(reason);
  const [result] = await executor.query(
    `INSERT INTO ${MYSQL_COMMENTS_ARCHIVE_TABLE}
      (user_id, card_id, id, author, text, images_json, created_at_ms, updated_at_ms, archived_at_ms, archive_reason)
     SELECT user_id, card_id, id, author, text, images_json, created_at_ms, updated_at_ms, ?, ?
     FROM ${MYSQL_COMMENTS_TABLE}
     WHERE user_id = ? AND card_id = ?`,
    [archivedAt, archiveReason, userId, cardId]
  );
  const archived = Number(result?.affectedRows ?? 0);
  if (archived > 0) {
    const firstArchiveId = Number(result?.insertId ?? 0);
    if (Number.isFinite(firstArchiveId) && firstArchiveId > 0) {
      const lastArchiveId = firstArchiveId + archived - 1;
      const [archiveRows] = await executor.query(
        `SELECT archive_id, card_id, images_json
         FROM ${MYSQL_COMMENTS_ARCHIVE_TABLE}
         WHERE user_id = ? AND archive_id BETWEEN ? AND ?`,
        [userId, firstArchiveId, lastArchiveId]
      );
      for (const row of Array.isArray(archiveRows) ? archiveRows : []) {
        const archiveRef = `a:${Math.max(0, Math.trunc(Number(row?.archive_id) || 0))}`;
        await mysqlReplaceMediaLinksForOwner(
          executor,
          userId,
          'comment_archive',
          String(row?.card_id ?? '').trim(),
          archiveRef,
          parseCommentImagesFromDb(row?.images_json)
        );
      }
    } else {
      await mysqlRebuildMediaIndexForUser(executor, userId);
    }
  }
  if (archived > 0) {
    await pruneMysqlCommentsArchiveForUser(executor, userId);
  }
  return archived;
}

async function mysqlPruneComments(pool, userId, cardId) {
  const currentCount = await mysqlCountComments(pool, userId, cardId);
  const overflow = currentCount - MAX_COMMENTS_PER_CARD;
  if (overflow <= 0) return currentCount;

  const [idRows] = await pool.query(
    `SELECT id
     FROM ${MYSQL_COMMENTS_TABLE} FORCE INDEX (idx_comments_user_card_created)
     WHERE user_id = ? AND card_id = ?
     ORDER BY created_at_ms ASC, id ASC
     LIMIT ?`,
    [userId, cardId, overflow]
  );
  const pruneIds = (Array.isArray(idRows) ? idRows : [])
    .map((row) => String(row?.id ?? '').trim())
    .filter((id) => !!id);
  if (pruneIds.length === 0) return currentCount;

  await mysqlArchiveCommentsByIds(pool, userId, cardId, pruneIds, 'overflow');

  const placeholders = pruneIds.map(() => '?').join(', ');
  const [result] = await pool.query(
    `DELETE FROM ${MYSQL_COMMENTS_TABLE}
     WHERE user_id = ? AND card_id = ? AND id IN (${placeholders})`,
    [userId, cardId, ...pruneIds]
  );
  const deleted = Number(result?.affectedRows ?? 0);
  if (deleted > 0) {
    for (const prunedCommentId of pruneIds) {
      await mysqlDeleteMediaLinksForOwner(pool, userId, 'comment', cardId, prunedCommentId);
    }
    await mysqlPruneUnlinkedMediaFiles(pool, userId);
  }
  return Math.max(0, currentCount - Math.max(0, deleted));
}

async function mysqlSelectComment(pool, userId, cardId, commentId) {
  const [rows] = await pool.query(
    `SELECT id, author, text, images_json, created_at_ms, updated_at_ms
     FROM ${MYSQL_COMMENTS_TABLE}
     WHERE user_id = ? AND card_id = ? AND id = ?
     LIMIT 1`,
    [userId, cardId, commentId]
  );
  if (!Array.isArray(rows) || rows.length === 0) return null;

  const sanitized = sanitizeComments([
    {
      id: rows[0].id,
      author: rows[0].author,
      text: rows[0].text,
      images: parseCommentImagesFromDb(rows[0].images_json),
      createdAt: rows[0].created_at_ms,
      updatedAt: rows[0].updated_at_ms,
    },
  ]);
  return sanitized[0] ?? null;
}

async function mysqlListComments(pool, userId, cardId, offset, limit, orderDirection) {
  const orderSql = orderDirection === 'asc' ? 'ASC' : 'DESC';
  const [rows] = await pool.query(
    `SELECT id, author, text, images_json, created_at_ms, updated_at_ms
     FROM ${MYSQL_COMMENTS_TABLE}
     WHERE user_id = ? AND card_id = ?
     ORDER BY created_at_ms ${orderSql}, id ${orderSql}
     LIMIT ? OFFSET ?`,
    [userId, cardId, limit, offset]
  );

  const raw = [];
  for (const row of Array.isArray(rows) ? rows : []) {
    raw.push({
      id: row.id,
      author: row.author,
      text: row.text,
      images: parseCommentImagesFromDb(row.images_json),
      createdAt: row.created_at_ms,
      updatedAt: row.updated_at_ms,
    });
  }
  return sanitizeComments(raw, { keepInputOrder: true, enforceMax: false });
}

function sanitizeArchivedCommentRow(row) {
  const base = sanitizeCommentEntry({
    id: row?.id,
    author: row?.author,
    text: row?.text,
    images: parseCommentImagesFromDb(row?.images_json),
    createdAt: row?.created_at_ms,
    updatedAt: row?.updated_at_ms,
  });
  if (!base) return null;
  const archiveIdRaw = Number(row?.archive_id);
  const archivedAtRaw = Number(row?.archived_at_ms);
  return {
    archiveId: Number.isFinite(archiveIdRaw) ? Math.max(0, Math.trunc(archiveIdRaw)) : 0,
    cardId: String(row?.card_id ?? '').trim(),
    archiveReason: sanitizeCommentArchiveReason(row?.archive_reason),
    archivedAt: Number.isFinite(archivedAtRaw) ? Math.max(0, Math.trunc(archivedAtRaw)) : Date.now(),
    ...base,
  };
}

async function mysqlCountArchivedComments(pool, userId, cardId, reason = null) {
  if (reason) {
    const [rows] = await pool.query(
      `SELECT COUNT(*) AS cnt
       FROM ${MYSQL_COMMENTS_ARCHIVE_TABLE} FORCE INDEX (idx_comments_archive_user_card_reason_archived)
       WHERE user_id = ? AND card_id = ? AND archive_reason = ?`,
      [userId, cardId, reason]
    );
    return Array.isArray(rows) && rows.length > 0 ? Number(rows[0].cnt ?? 0) : 0;
  }

  const [rows] = await pool.query(
    `SELECT COUNT(*) AS cnt
     FROM ${MYSQL_COMMENTS_ARCHIVE_TABLE} FORCE INDEX (idx_comments_archive_user_card_archived)
     WHERE user_id = ? AND card_id = ?`,
    [userId, cardId]
  );
  return Array.isArray(rows) && rows.length > 0 ? Number(rows[0].cnt ?? 0) : 0;
}

async function mysqlListArchivedComments(pool, userId, cardId, offset, limit, orderDirection, reason = null) {
  const orderSql = orderDirection === 'asc' ? 'ASC' : 'DESC';
  const params = [userId, cardId];
  let reasonSql = '';
  let indexHintSql = 'FORCE INDEX (idx_comments_archive_user_card_archived)';
  if (reason) {
    reasonSql = ' AND archive_reason = ?';
    indexHintSql = 'FORCE INDEX (idx_comments_archive_user_card_reason_archived)';
    params.push(reason);
  }
  params.push(limit, offset);
  const [rows] = await pool.query(
    `SELECT archive_id, card_id, id, author, text, images_json, created_at_ms, updated_at_ms, archived_at_ms, archive_reason
     FROM ${MYSQL_COMMENTS_ARCHIVE_TABLE} ${indexHintSql}
     WHERE user_id = ? AND card_id = ?${reasonSql}
     ORDER BY archived_at_ms ${orderSql}, archive_id ${orderSql}
     LIMIT ? OFFSET ?`,
    params
  );

  const out = [];
  for (const row of Array.isArray(rows) ? rows : []) {
    const archived = sanitizeArchivedCommentRow(row);
    if (archived) out.push(archived);
  }
  return out;
}

async function mysqlSelectArchivedCommentByArchiveId(executor, userId, cardId, archiveId, { forUpdate = false } = {}) {
  const [rows] = await executor.query(
    `SELECT archive_id, card_id, id, author, text, images_json, created_at_ms, updated_at_ms, archived_at_ms, archive_reason
     FROM ${MYSQL_COMMENTS_ARCHIVE_TABLE}
     WHERE user_id = ? AND card_id = ? AND archive_id = ?
     LIMIT 1${forUpdate ? ' FOR UPDATE' : ''}`,
    [userId, cardId, archiveId]
  );
  if (!Array.isArray(rows) || rows.length === 0) return null;
  return sanitizeArchivedCommentRow(rows[0]);
}

async function mysqlCommentIdExists(executor, userId, cardId, commentId) {
  const [rows] = await executor.query(
    `SELECT 1
     FROM ${MYSQL_COMMENTS_TABLE}
     WHERE user_id = ? AND card_id = ? AND id = ?
     LIMIT 1`,
    [userId, cardId, commentId]
  );
  return Array.isArray(rows) && rows.length > 0;
}

async function mysqlPickRestoredCommentId(executor, userId, cardId, preferredId) {
  const normalizedPreferred = String(preferredId ?? '').trim();
  const first = normalizedPreferred || randomUUID();
  if (!(await mysqlCommentIdExists(executor, userId, cardId, first))) return first;
  for (let i = 0; i < 5; i += 1) {
    const candidate = randomUUID();
    if (!(await mysqlCommentIdExists(executor, userId, cardId, candidate))) return candidate;
  }
  return randomUUID();
}

async function mysqlRestoreArchivedComment(pool, userId, cardId, archiveId) {
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();

    const card = await mysqlGetCardRow(conn, userId, cardId, { forUpdate: true });
    if (!card) throw makeMysqlHttpError(404, { error: 'CARD_NOT_FOUND' });

    const archived = await mysqlSelectArchivedCommentByArchiveId(conn, userId, cardId, archiveId, { forUpdate: true });
    if (!archived) throw makeMysqlHttpError(404, { error: 'ARCHIVED_COMMENT_NOT_FOUND' });

    const restoredId = await mysqlPickRestoredCommentId(conn, userId, cardId, archived.id);
    const now = Date.now();
    const commentText = sanitizeCommentText(archived.text);
    const commentImages = sanitizeCardImages(archived.images);
    if (!commentText && commentImages.length === 0) {
      throw makeMysqlHttpError(422, { error: 'ARCHIVED_COMMENT_INVALID' });
    }

    await conn.query(
      `INSERT INTO ${MYSQL_COMMENTS_TABLE}
        (user_id, card_id, id, author, text, images_json, created_at_ms, updated_at_ms)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        userId,
        cardId,
        restoredId,
        sanitizeCommentAuthor(archived.author),
        commentText,
        encodeCommentImagesForDb(commentImages),
        now,
        now,
      ]
    );
    await mysqlReplaceMediaLinksForOwner(conn, userId, 'comment', cardId, restoredId, commentImages);

    await conn.query(
      `DELETE FROM ${MYSQL_COMMENTS_ARCHIVE_TABLE}
       WHERE user_id = ? AND card_id = ? AND archive_id = ?`,
      [userId, cardId, archiveId]
    );
    await mysqlDeleteMediaLinksForOwner(conn, userId, 'comment_archive', cardId, `a:${archiveId}`);

    const commentsCount = await mysqlPruneComments(conn, userId, cardId);
    await mysqlDeleteOrphanArchivedMediaLinks(conn, userId);
    await mysqlPruneUnlinkedMediaFiles(conn, userId);
    const version = await mysqlBumpBoardVersion(conn, userId, now);
    await conn.commit();

    const restored = await mysqlSelectComment(pool, userId, cardId, restoredId);
    if (!restored) {
      throw makeMysqlHttpError(500, { error: 'COMMENT_RESTORE_FAILED' });
    }
    return { comment: restored, commentsCount, updatedAt: now, version };
  } catch (err) {
    await conn.rollback();
    throw err;
  } finally {
    conn.release();
  }
}

function mysqlRowToCard(row, status = 'queue', comments = []) {
  return {
    id: String(row.id ?? '').trim(),
    title: sanitizeText(row.title, 512),
    description: sanitizeText(row.description, 5000),
    images: parseCardImagesFromDb(row.images_json),
    checklist: parseChecklistFromDb(row.checklist_json),
    createdBy: sanitizeCardCreator(row.created_by),
    isFavorite: sanitizeCardFavorite(row.is_favorite),
    comments: sanitizeComments(comments),
    createdAt: Number(row.created_at_ms) || Date.now(),
    status,
    urgency: URGENCY_SET.has(row.urgency) ? row.urgency : 'white',
    doingStartedAt:
      row.doing_started_at_ms == null || !Number.isFinite(Number(row.doing_started_at_ms))
        ? null
        : Number(row.doing_started_at_ms),
    doingTotalMs: Number.isFinite(Number(row.doing_total_ms)) ? Number(row.doing_total_ms) : 0,
  };
}

async function mysqlGetCardRow(executor, userId, cardId, { forUpdate = false } = {}) {
  const [rows] = await executor.query(
    `SELECT id, title, description, images_json, checklist_json, created_by, created_at_ms, urgency, is_favorite, doing_started_at_ms, doing_total_ms
     FROM ${MYSQL_CARDS_TABLE}
     WHERE user_id = ? AND id = ?
     LIMIT 1${forUpdate ? ' FOR UPDATE' : ''}`,
    [userId, cardId]
  );
  return Array.isArray(rows) && rows.length > 0 ? rows[0] : null;
}

async function mysqlGetCardColumnPosition(executor, userId, cardId, { forUpdate = false } = {}) {
  const [rows] = await executor.query(
    `SELECT column_id, sort_index
     FROM ${MYSQL_COLUMNS_TABLE}
     WHERE user_id = ? AND card_id = ?
     LIMIT 1${forUpdate ? ' FOR UPDATE' : ''}`,
    [userId, cardId]
  );
  if (!Array.isArray(rows) || rows.length === 0) return { columnId: null, index: null };
  return {
    columnId: String(rows[0].column_id ?? '').trim() || null,
    index: Number.isFinite(Number(rows[0].sort_index)) ? Number(rows[0].sort_index) : null,
  };
}

async function mysqlCardIsFloating(executor, userId, cardId, { forUpdate = false } = {}) {
  const [rows] = await executor.query(
    `SELECT 1
     FROM ${MYSQL_FLOATING_TABLE}
     WHERE user_id = ? AND card_id = ?
     LIMIT 1${forUpdate ? ' FOR UPDATE' : ''}`,
    [userId, cardId]
  );
  return Array.isArray(rows) && rows.length > 0;
}

async function mysqlShiftColumnIndexes(conn, userId, columnId, fromIndex, delta, direction = 'asc') {
  if (!Number.isFinite(Number(fromIndex))) return;
  if (!delta) return;
  const orderSql = String(direction).toLowerCase() === 'desc' ? 'DESC' : 'ASC';
  const sign = delta > 0 ? '+' : '-';
  const absDelta = Math.abs(Math.trunc(delta));
  await conn.query(
    `UPDATE ${MYSQL_COLUMNS_TABLE}
     SET sort_index = sort_index ${sign} ${absDelta}
     WHERE user_id = ? AND column_id = ? AND sort_index >= ?
     ORDER BY sort_index ${orderSql}`,
    [userId, columnId, Math.trunc(fromIndex)]
  );
}

async function mysqlCountColumnCards(executor, userId, columnId, { forUpdate = false } = {}) {
  const [rows] = await executor.query(
    `SELECT COUNT(*) AS cnt
     FROM ${MYSQL_COLUMNS_TABLE}
     WHERE user_id = ? AND column_id = ?${forUpdate ? ' FOR UPDATE' : ''}`,
    [userId, columnId]
  );
  return Array.isArray(rows) && rows.length > 0 ? Number(rows[0].cnt ?? 0) : 0;
}

async function mysqlNextSequentialCardId(executor, userId) {
  const [rows] = await executor.query(
    `SELECT id
     FROM ${MYSQL_CARDS_TABLE}
     WHERE user_id = ? AND id LIKE 'P-%'`,
    [userId]
  );
  let max = 0;
  for (const row of Array.isArray(rows) ? rows : []) {
    const id = String(row.id ?? '').trim();
    const m = /^P-(\d+)$/i.exec(id);
    if (!m) continue;
    const n = Number(m[1]);
    if (Number.isFinite(n) && n > max) max = n;
  }
  return `P-${max + 1}`;
}

async function mysqlLoadCardComments(executor, userId, cardId) {
  const [rows] = await executor.query(
    `SELECT id, author, text, images_json, created_at_ms, updated_at_ms
     FROM ${MYSQL_COMMENTS_TABLE}
     WHERE user_id = ? AND card_id = ?
     ORDER BY created_at_ms ASC, id ASC`,
    [userId, cardId]
  );
  return sanitizeComments(
    (Array.isArray(rows) ? rows : []).map((r) => ({
      id: r.id,
      text: r.text,
      images: parseCommentImagesFromDb(r.images_json),
      createdAt: r.created_at_ms,
      updatedAt: r.updated_at_ms,
      author: r.author,
    }))
  );
}

async function mysqlInsertHistoryEntry(conn, userId, entry) {
  const kind = sanitizeHistoryKind(entry.kind);
  const meta = sanitizeHistoryMeta(entry.meta);
  await conn.query(
    `INSERT INTO ${MYSQL_HISTORY_TABLE}
      (id, user_id, at_ms, text, card_id, kind, meta_json)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [entry.id, userId, entry.at, entry.text, entry.cardId, kind, meta ? JSON.stringify(meta) : null]
  );
  await pruneMysqlHistoryForUser(conn, userId);
}

function isMysqlDuplicateError(err) {
  return String(err?.code ?? '').toUpperCase() === 'ER_DUP_ENTRY';
}

function mysqlDuplicateTarget(err) {
  const msg = String(err?.message ?? '').toLowerCase();
  if (msg.includes('uq_users_login_key')) return 'login';
  if (msg.includes('uq_users_email')) return 'email';
  return null;
}

function makeMysqlHttpError(status, payload) {
  const error = new Error(String(payload?.error ?? `HTTP_${status}`));
  error.httpStatus = status;
  error.httpPayload = payload;
  return error;
}

function isMysqlHttpError(err) {
  return Number.isFinite(Number(err?.httpStatus)) && err?.httpPayload && typeof err.httpPayload === 'object';
}

function parseOptionalBoardVersion(raw) {
  if (raw == null || raw === '') return null;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) return Number.NaN;
  return Math.trunc(n);
}

async function handleMysqlAuthApi(req, res, pathname) {
  if (DB_PROVIDER !== 'mysql') return false;
  await ensureMysqlSchema();

  if (pathname === '/api/auth/register' && req.method === 'POST') {
    let body;
    try {
      body = await readJsonBody(req);
    } catch (err) {
      sendJson(res, 400, { error: 'BAD_JSON', message: String(err?.message ?? 'Bad JSON') }, req);
      return true;
    }

    const login = normalizeLogin(body.login);
    const email = normalizeEmail(body.email);
    const password = String(body.password ?? '');

    if (!isValidLogin(login)) {
      sendJson(
        res,
        400,
        {
          error: 'INVALID_LOGIN',
          message: 'Логин: только буквы латиницы/кириллицы, длина 2-32 символа',
        },
        req
      );
      return true;
    }

    if (!isValidEmail(email)) {
      sendJson(res, 400, { error: 'INVALID_EMAIL' }, req);
      return true;
    }

    if (password.length < 6) {
      sendJson(res, 400, { error: 'WEAK_PASSWORD', message: 'Минимум 6 символов' }, req);
      return true;
    }

    const { salt, hash } = createPasswordData(password);
    const now = Date.now();
    const userId = randomUUID();
    const token = randomBytes(32).toString('hex');
    const expiresAt = now + SESSION_TTL_MS;

    const pool = await getMysqlPool();
    const conn = await pool.getConnection();
    try {
      await conn.beginTransaction();
      await conn.query(
        `INSERT INTO ${MYSQL_USERS_TABLE}
          (id, login, login_key, email, password_salt, password_hash, created_at_ms)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [userId, login, loginKey(login), email, salt, hash, now]
      );
      await conn.query(
        `INSERT INTO ${MYSQL_SESSIONS_TABLE}
          (token, user_id, created_at_ms, expires_at_ms)
         VALUES (?, ?, ?, ?)`,
        [token, userId, now, expiresAt]
      );
      await ensureMysqlBoardVersionRow(conn, userId);
      await conn.commit();
    } catch (err) {
      await conn.rollback();
      if (isMysqlDuplicateError(err)) {
        const dup = mysqlDuplicateTarget(err);
        if (dup === 'login') sendJson(res, 409, { error: 'LOGIN_TAKEN' }, req);
        else if (dup === 'email') sendJson(res, 409, { error: 'EMAIL_TAKEN' }, req);
        else sendJson(res, 409, { error: 'DUPLICATE_USER' }, req);
        return true;
      }
      throw err;
    } finally {
      conn.release();
    }

    sendJson(
      res,
      201,
      {
        token,
        user: userPayload({ id: userId, login, email }),
      },
      req
    );
    return true;
  }

  if (pathname === '/api/auth/login' && req.method === 'POST') {
    let body;
    try {
      body = await readJsonBody(req);
    } catch (err) {
      sendJson(res, 400, { error: 'BAD_JSON', message: String(err?.message ?? 'Bad JSON') }, req);
      return true;
    }

    const login = normalizeLogin(body.login);
    const password = String(body.password ?? '');

    const pool = await getMysqlPool();
    const [rows] = await pool.query(
      `SELECT id, login, email, password_salt, password_hash, created_at_ms, avatar_data_url, first_name, last_name, birth_date, role_title, city_title, bio
       FROM ${MYSQL_USERS_TABLE}
       WHERE login_key = ?
       LIMIT 1`,
      [loginKey(login)]
    );
    const user = Array.isArray(rows) && rows.length > 0 ? rows[0] : null;
    if (!user) {
      sendJson(res, 401, { error: 'INVALID_CREDENTIALS' }, req);
      return true;
    }

    const ok = verifyPassword(password, String(user.password_salt ?? ''), String(user.password_hash ?? ''));
    if (!ok) {
      sendJson(res, 401, { error: 'INVALID_CREDENTIALS' }, req);
      return true;
    }

    const now = Date.now();
    const token = randomBytes(32).toString('hex');
    const expiresAt = now + SESSION_TTL_MS;
    await pool.query(
      `INSERT INTO ${MYSQL_SESSIONS_TABLE}
        (token, user_id, created_at_ms, expires_at_ms)
       VALUES (?, ?, ?, ?)`,
      [token, String(user.id), now, expiresAt]
    );

    const normalizedUser = mysqlRowToUser(user);
    if (!normalizedUser) {
      sendJson(res, 401, { error: 'INVALID_CREDENTIALS' }, req);
      return true;
    }

    sendJson(
      res,
      200,
      {
        token,
        user: userPayload(normalizedUser),
      },
      req
    );
    return true;
  }

  if (pathname === '/api/auth/profile' && req.method === 'GET') {
    const pool = await getMysqlPool();
    const authUser = await requireMysqlUser(req, res, pool);
    if (!authUser) return true;
    const user = await mysqlGetUserById(pool, authUser.id);
    if (!user) {
      sendJson(res, 404, { error: 'USER_NOT_FOUND' }, req);
      return true;
    }
    sendJson(res, 200, { user: userPayload(user) }, req);
    return true;
  }

  if (pathname === '/api/auth/profile' && req.method === 'PATCH') {
    const pool = await getMysqlPool();
    const authUser = await requireMysqlUser(req, res, pool);
    if (!authUser) return true;

    let body;
    try {
      body = await readJsonBody(req);
    } catch (err) {
      sendJson(res, 400, { error: 'BAD_JSON', message: String(err?.message ?? 'Bad JSON') }, req);
      return true;
    }

    const hasLogin = Object.prototype.hasOwnProperty.call(body ?? {}, 'login');
    const hasAvatarUrl = Object.prototype.hasOwnProperty.call(body ?? {}, 'avatarUrl');
    const hasFirstName = Object.prototype.hasOwnProperty.call(body ?? {}, 'firstName');
    const hasLastName = Object.prototype.hasOwnProperty.call(body ?? {}, 'lastName');
    const hasBirthDate = Object.prototype.hasOwnProperty.call(body ?? {}, 'birthDate');
    const hasRole = Object.prototype.hasOwnProperty.call(body ?? {}, 'role');
    const hasCity = Object.prototype.hasOwnProperty.call(body ?? {}, 'city');
    const hasAbout = Object.prototype.hasOwnProperty.call(body ?? {}, 'about');

    if (!(hasLogin || hasAvatarUrl || hasFirstName || hasLastName || hasBirthDate || hasRole || hasCity || hasAbout)) {
      const user = await mysqlGetUserById(pool, authUser.id);
      if (!user) {
        sendJson(res, 404, { error: 'USER_NOT_FOUND' }, req);
        return true;
      }
      sendJson(res, 200, { user: userPayload(user) }, req);
      return true;
    }

    let nextLogin = null;
    if (hasLogin) {
      const login = normalizeLogin(body?.login);
      if (!isValidLogin(login)) {
        sendJson(
          res,
          400,
          {
            error: 'INVALID_LOGIN',
            message: 'Логин: только буквы латиницы/кириллицы, длина 2-32 символа',
          },
          req
        );
        return true;
      }
      nextLogin = login;
    }

    let nextAvatarUrl = null;
    if (hasAvatarUrl) {
      const rawAvatar = String(body?.avatarUrl ?? '').trim();
      if (!rawAvatar) nextAvatarUrl = null;
      else {
        nextAvatarUrl = sanitizeProfileAvatarUrl(rawAvatar);
        if (!nextAvatarUrl) {
          sendJson(res, 400, { error: 'INVALID_PROFILE_AVATAR' }, req);
          return true;
        }
      }
    }

    let nextBirthDate = null;
    if (hasBirthDate) {
      const rawBirthDate = String(body?.birthDate ?? '').trim();
      if (!rawBirthDate) nextBirthDate = null;
      else {
        nextBirthDate = sanitizeProfileBirthDate(rawBirthDate);
        if (!nextBirthDate) {
          sendJson(res, 400, { error: 'INVALID_PROFILE_BIRTH_DATE' }, req);
          return true;
        }
      }
    }

    const nextFirstName = hasFirstName ? sanitizeProfileName(body?.firstName, MAX_PROFILE_FIRST_NAME_LEN) : null;
    const nextLastName = hasLastName ? sanitizeProfileName(body?.lastName, MAX_PROFILE_LAST_NAME_LEN) : null;
    const nextRole = hasRole ? sanitizeProfileRole(body?.role) : null;
    const nextCity = hasCity ? sanitizeProfileCity(body?.city) : null;
    const nextAbout = hasAbout ? sanitizeProfileAbout(body?.about) : null;

    if (hasFirstName && !validateProfileFirstName(nextFirstName)) {
      sendJson(res, 400, { error: 'INVALID_PROFILE_FIRST_NAME' }, req);
      return true;
    }
    if (hasLastName && !validateProfileLastName(nextLastName)) {
      sendJson(res, 400, { error: 'INVALID_PROFILE_LAST_NAME' }, req);
      return true;
    }
    if (hasRole && !validateProfileRole(nextRole)) {
      sendJson(res, 400, { error: 'INVALID_PROFILE_ROLE' }, req);
      return true;
    }
    if (hasCity && !validateProfileCity(nextCity)) {
      sendJson(res, 400, { error: 'INVALID_PROFILE_CITY' }, req);
      return true;
    }
    if (hasAbout && !validateProfileAbout(nextAbout)) {
      sendJson(res, 400, { error: 'INVALID_PROFILE_ABOUT' }, req);
      return true;
    }
    if (hasBirthDate && nextBirthDate && !isProfileBirthDateAtLeastAge(nextBirthDate, MIN_PROFILE_AGE_YEARS)) {
      sendJson(res, 400, { error: 'INVALID_PROFILE_BIRTH_DATE' }, req);
      return true;
    }

    try {
      const params = [];
      const sets = [];
      if (hasLogin) {
        sets.push('login = ?');
        params.push(nextLogin);
        sets.push('login_key = ?');
        params.push(loginKey(nextLogin));
      }
      if (hasAvatarUrl) {
        sets.push('avatar_data_url = ?');
        params.push(nextAvatarUrl);
      }
      if (hasFirstName) {
        sets.push('first_name = ?');
        params.push(nextFirstName);
      }
      if (hasLastName) {
        sets.push('last_name = ?');
        params.push(nextLastName);
      }
      if (hasBirthDate) {
        sets.push('birth_date = ?');
        params.push(nextBirthDate);
      }
      if (hasRole) {
        sets.push('role_title = ?');
        params.push(nextRole);
      }
      if (hasCity) {
        sets.push('city_title = ?');
        params.push(nextCity);
      }
      if (hasAbout) {
        sets.push('bio = ?');
        params.push(nextAbout);
      }

      if (sets.length > 0) {
        params.push(authUser.id);
        await pool.query(`UPDATE ${MYSQL_USERS_TABLE} SET ${sets.join(', ')} WHERE id = ?`, params);
      }
    } catch (err) {
      if (isMysqlDuplicateError(err) && mysqlDuplicateTarget(err) === 'login') {
        sendJson(res, 409, { error: 'LOGIN_TAKEN' }, req);
        return true;
      }
      throw err;
    }

    const user = await mysqlGetUserById(pool, authUser.id);
    if (!user) {
      sendJson(res, 404, { error: 'USER_NOT_FOUND' }, req);
      return true;
    }
    sendJson(res, 200, { user: userPayload(user) }, req);
    return true;
  }

  if (pathname === '/api/auth/me' && req.method === 'GET') {
    const pool = await getMysqlPool();
    const authUser = await requireMysqlUser(req, res, pool);
    if (!authUser) return true;
    const user = await mysqlGetUserById(pool, authUser.id);
    if (!user) {
      sendJson(res, 404, { error: 'USER_NOT_FOUND' }, req);
      return true;
    }
    sendJson(res, 200, { user: userPayload(user) }, req);
    return true;
  }

  if (pathname === '/api/auth/logout' && req.method === 'POST') {
    const token = extractBearerToken(req);
    if (!token) {
      sendJson(res, 200, { ok: true }, req);
      return true;
    }
    const pool = await getMysqlPool();
    await pool.query(`DELETE FROM ${MYSQL_SESSIONS_TABLE} WHERE token = ?`, [token]);
    sendJson(res, 200, { ok: true }, req);
    return true;
  }

  return false;
}

async function handleMysqlBoardAndCardsApi(req, res, pathname) {
  if (DB_PROVIDER !== 'mysql') return false;
  await ensureMysqlSchema();

  const isBoardPath = pathname === '/api/board';
  const isCardsCreatePath = pathname === '/api/cards';
  const moveCardId = extractCardMoveIdFromPath(pathname);
  const cardId = extractCardIdFromPath(pathname);

  const isSupportedPath = isBoardPath || isCardsCreatePath || Boolean(moveCardId) || Boolean(cardId);
  if (!isSupportedPath) return false;

  const pool = await getMysqlPool();
  const user = await requireMysqlUser(req, res, pool);
  if (!user) return true;

  if (isBoardPath && req.method === 'GET') {
    const version = await mysqlGetBoardVersion(pool, user.id);
    const etag = boardVersionEtag(version);
    const headers = {
      ETag: etag,
      'Cache-Control': 'no-cache',
    };
    if (requestHasMatchingEtag(req, etag)) {
      setCors(res, req);
      const vary = res.getHeader('Vary');
      res.writeHead(304, {
        ...headers,
        ...(vary != null ? { Vary: String(vary) } : {}),
      });
      res.end();
      return true;
    }
    const state = await readUserBoardStateFromMysql(pool, user.id);
    sendJson(res, 200, { state, version }, req, headers);
    return true;
  }

  if (isBoardPath && req.method === 'PUT') {
    let body;
    try {
      body = await readJsonBody(req);
    } catch (err) {
      sendJson(res, 400, { error: 'BAD_JSON', message: String(err?.message ?? 'Bad JSON') }, req);
      return true;
    }

    const state = sanitizeBoardState(body.state);
    if (!state) {
      sendJson(res, 400, { error: 'INVALID_BOARD_STATE' }, req);
      return true;
    }

    const hasBaseVersion = Object.prototype.hasOwnProperty.call(body ?? {}, 'baseVersion');
    const hasExpectedVersion = Object.prototype.hasOwnProperty.call(body ?? {}, 'expectedVersion');
    const rawExpectedVersion = hasBaseVersion ? body.baseVersion : hasExpectedVersion ? body.expectedVersion : null;
    const parsedExpectedVersion = parseOptionalBoardVersion(rawExpectedVersion);
    if (Number.isNaN(parsedExpectedVersion)) {
      sendJson(res, 400, { error: 'INVALID_BOARD_VERSION' }, req);
      return true;
    }

    try {
      const writeOptions = Number.isFinite(parsedExpectedVersion) ? { expectedVersion: parsedExpectedVersion } : {};
      const nextVersion = await writeScopedUserBoardToMysql(pool, user.id, state, {
        ...writeOptions,
      });
      scheduleMediaGc('mysql-board-put');
      sendJson(res, 200, { ok: true, updatedAt: Date.now(), version: nextVersion }, req);
      return true;
    } catch (err) {
      if (String(err?.code ?? '').toUpperCase() === 'BOARD_VERSION_CONFLICT') {
        sendJson(
          res,
          409,
          {
            error: 'BOARD_VERSION_CONFLICT',
            currentVersion: Number.isFinite(Number(err.currentVersion)) ? Number(err.currentVersion) : null,
          },
          req
        );
        return true;
      }
      throw err;
    }
  }

  if (isCardsCreatePath && req.method === 'POST') {
    let body;
    try {
      body = await readJsonBody(req);
    } catch (err) {
      sendJson(res, 400, { error: 'BAD_JSON', message: String(err?.message ?? 'Bad JSON') }, req);
      return true;
    }

    const now = Date.now();
    const title = sanitizeText(body.title, 512);
    const description = sanitizeText(body.description, 5000);
    const images = sanitizeCardImages(body.images, { persistDataUrls: true });
    const checklist = Object.prototype.hasOwnProperty.call(body, 'checklist')
      ? sanitizeChecklist(body.checklist)
      : [];
    const createdBy = sanitizeCardCreator(user.login);

    let urgency = 'white';
    if (Object.prototype.hasOwnProperty.call(body, 'urgency')) {
      if (!URGENCY_SET.has(body.urgency)) {
        sendJson(res, 400, { error: 'INVALID_URGENCY' }, req);
        return true;
      }
      urgency = body.urgency;
    }

    let targetColumn = 'queue';
    if (Object.prototype.hasOwnProperty.call(body, 'columnId')) {
      const candidate = String(body.columnId ?? '').trim();
      if (!COLUMN_IDS.includes(candidate)) {
        sendJson(res, 400, { error: 'INVALID_COLUMN' }, req);
        return true;
      }
      targetColumn = candidate;
    }

    const conn = await pool.getConnection();
    try {
      await conn.beginTransaction();

      const cardId = await mysqlNextSequentialCardId(conn, user.id);
      const columnLength = await mysqlCountColumnCards(conn, user.id, targetColumn, { forUpdate: true });
      const insertIndex = Object.prototype.hasOwnProperty.call(body, 'index')
        ? clampIndex(Number(body.index), 0, columnLength)
        : 0;

      const doingStartedAt = targetColumn === 'doing' ? now : null;
      const doingTotalMs = 0;

      await conn.query(
        `INSERT INTO ${MYSQL_CARDS_TABLE}
          (user_id, id, title, description, images_json, checklist_json, created_by, created_at_ms, urgency, is_favorite, doing_started_at_ms, doing_total_ms)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          user.id,
          cardId,
          title,
          description,
          encodeCardImagesForDb(images),
          encodeChecklistForDb(checklist),
          createdBy,
          now,
          urgency,
          0,
          doingStartedAt,
          doingTotalMs,
        ]
      );
      await mysqlReplaceMediaLinksForOwner(conn, user.id, 'card', cardId, '', images);

      await mysqlShiftColumnIndexes(conn, user.id, targetColumn, insertIndex, 1, 'desc');
      await conn.query(
        `INSERT INTO ${MYSQL_COLUMNS_TABLE}
          (user_id, column_id, card_id, sort_index)
         VALUES (?, ?, ?, ?)`,
        [user.id, targetColumn, cardId, insertIndex]
      );

      await mysqlInsertHistoryEntry(conn, user.id, {
        id: randomUUID(),
        at: now,
        text: `Карточка "${displayCardTitle(title)}" создана в "${columnTitle(targetColumn)}"`,
        cardId,
        kind: 'create',
        meta: {
          title: sanitizeText(title, 512),
          fromCol: null,
          toCol: targetColumn,
          doingDeltaMs: 0,
        },
      });

      const version = await mysqlBumpBoardVersion(conn, user.id, now);
      await conn.commit();

      const card = {
        id: cardId,
        title,
        description,
        images,
        checklist,
        createdBy,
        comments: [],
        createdAt: now,
        status: targetColumn,
        urgency,
        isFavorite: false,
        doingStartedAt,
        doingTotalMs,
      };

      sendJson(res, 201, { ok: true, card, columnId: targetColumn, index: insertIndex, updatedAt: now, version }, req);
      return true;
    } catch (err) {
      await conn.rollback();
      throw err;
    } finally {
      conn.release();
    }
  }

  if (moveCardId && (req.method === 'POST' || req.method === 'PATCH')) {
    let body;
    try {
      body = await readJsonBody(req);
    } catch (err) {
      sendJson(res, 400, { error: 'BAD_JSON', message: String(err?.message ?? 'Bad JSON') }, req);
      return true;
    }

    const toColumnId = String(body?.toColumnId ?? '').trim();
    if (!COLUMN_IDS.includes(toColumnId)) {
      sendJson(res, 400, { error: 'INVALID_COLUMN' }, req);
      return true;
    }

    const hasToIndex = Object.prototype.hasOwnProperty.call(body ?? {}, 'toIndex');
    if (hasToIndex && !Number.isFinite(Number(body.toIndex))) {
      sendJson(res, 400, { error: 'INVALID_INDEX' }, req);
      return true;
    }

    const now = Date.now();
    const conn = await pool.getConnection();
    try {
      await conn.beginTransaction();

      const currentRow = await mysqlGetCardRow(conn, user.id, moveCardId, { forUpdate: true });
      if (!currentRow) throw makeMysqlHttpError(404, { error: 'CARD_NOT_FOUND' });

      const fromPos = await mysqlGetCardColumnPosition(conn, user.id, moveCardId, { forUpdate: true });
      const fromColumnId = fromPos.columnId;
      const fromIndex = fromPos.index;

      if (fromColumnId && Number.isFinite(Number(fromIndex))) {
        await conn.query(
          `DELETE FROM ${MYSQL_COLUMNS_TABLE}
           WHERE user_id = ? AND column_id = ? AND card_id = ?`,
          [user.id, fromColumnId, moveCardId]
        );
        await mysqlShiftColumnIndexes(conn, user.id, fromColumnId, Number(fromIndex) + 1, -1, 'asc');
      } else {
        await conn.query(
          `DELETE FROM ${MYSQL_FLOATING_TABLE}
           WHERE user_id = ? AND card_id = ?`,
          [user.id, moveCardId]
        );
      }

      const targetColumnLength = await mysqlCountColumnCards(conn, user.id, toColumnId, { forUpdate: true });
      const rawToIndex = hasToIndex ? Number(body.toIndex) : targetColumnLength;
      const safeToIndex = clampIndex(rawToIndex, 0, targetColumnLength);
      await mysqlShiftColumnIndexes(conn, user.id, toColumnId, safeToIndex, 1, 'desc');
      await conn.query(
        `INSERT INTO ${MYSQL_COLUMNS_TABLE}
          (user_id, column_id, card_id, sort_index)
         VALUES (?, ?, ?, ?)`,
        [user.id, toColumnId, moveCardId, safeToIndex]
      );

      const prevDoingStartedAt =
        currentRow.doing_started_at_ms == null || !Number.isFinite(Number(currentRow.doing_started_at_ms))
          ? null
          : Number(currentRow.doing_started_at_ms);
      const prevDoingTotalMs = Number.isFinite(Number(currentRow.doing_total_ms)) ? Number(currentRow.doing_total_ms) : 0;

      let nextDoingStartedAt = prevDoingStartedAt;
      let nextDoingTotalMs = prevDoingTotalMs;
      let doingDeltaMs = 0;

      if (fromColumnId === 'doing' && toColumnId !== 'doing') {
        if (prevDoingStartedAt != null) {
          doingDeltaMs = Math.max(0, now - prevDoingStartedAt);
        }
        nextDoingTotalMs += doingDeltaMs;
        nextDoingStartedAt = null;
      }

      if (toColumnId === 'doing' && fromColumnId !== 'doing') {
        nextDoingStartedAt = now;
      }
      if (toColumnId !== 'doing') {
        nextDoingStartedAt = null;
      }

      await conn.query(
        `UPDATE ${MYSQL_CARDS_TABLE}
         SET doing_started_at_ms = ?, doing_total_ms = ?
         WHERE user_id = ? AND id = ?`,
        [nextDoingStartedAt, nextDoingTotalMs, user.id, moveCardId]
      );

      let text = `Карточка "${displayCardTitle(currentRow.title)}" перемещена: "${columnTitle(fromColumnId || 'queue')}" → "${columnTitle(toColumnId)}"`;
      if (toColumnId === 'doing' && fromColumnId !== 'doing') {
        text += ' (таймер запущен)';
      }
      if (fromColumnId === 'doing' && toColumnId !== 'doing') {
        text += doingDeltaMs > 0 ? ` (таймер +${formatElapsedHms(doingDeltaMs)})` : ' (таймер остановлен)';
      }

      await mysqlInsertHistoryEntry(conn, user.id, {
        id: randomUUID(),
        at: now,
        text,
        cardId: moveCardId,
        kind: 'move',
        meta: {
          title: sanitizeText(currentRow.title, 512),
          fromCol: fromColumnId,
          toCol: toColumnId,
          doingDeltaMs,
        },
      });

      const comments = await mysqlLoadCardComments(conn, user.id, moveCardId);
      const version = await mysqlBumpBoardVersion(conn, user.id, now);
      await conn.commit();

      const card = mysqlRowToCard(
        {
          ...currentRow,
          doing_started_at_ms: nextDoingStartedAt,
          doing_total_ms: nextDoingTotalMs,
        },
        toColumnId,
        comments
      );

      sendJson(
        res,
        200,
        {
          ok: true,
          card,
          fromColumnId,
          toColumnId,
          toIndex: safeToIndex,
          updatedAt: now,
          version,
        },
        req
      );
      return true;
    } catch (err) {
      await conn.rollback();
      if (isMysqlHttpError(err)) {
        sendJson(res, Number(err.httpStatus), err.httpPayload, req);
        return true;
      }
      throw err;
    } finally {
      conn.release();
    }
  }

  if (cardId && req.method === 'GET') {
    const row = await mysqlGetCardRow(pool, user.id, cardId);
    if (!row) {
      sendJson(res, 404, { error: 'CARD_NOT_FOUND' }, req);
      return true;
    }

    const position = await mysqlGetCardColumnPosition(pool, user.id, cardId);
    const isFloating = !position.columnId && (await mysqlCardIsFloating(pool, user.id, cardId));
    const status = position.columnId || (isFloating ? 'freedom' : 'queue');
    const comments = await mysqlLoadCardComments(pool, user.id, cardId);
    const card = mysqlRowToCard(row, status, comments);

    sendJson(
      res,
      200,
      {
        card,
        columnId: position.columnId,
        index: Number.isFinite(Number(position.index)) ? Number(position.index) : -1,
      },
      req
    );
    return true;
  }

  if (cardId && req.method === 'PATCH') {
    let body;
    try {
      body = await readJsonBody(req);
    } catch (err) {
      sendJson(res, 400, { error: 'BAD_JSON', message: String(err?.message ?? 'Bad JSON') }, req);
      return true;
    }

    const patch = {};
    if (Object.prototype.hasOwnProperty.call(body, 'title')) {
      patch.title = sanitizeText(body.title, 512);
    }
    if (Object.prototype.hasOwnProperty.call(body, 'description')) {
      patch.description = sanitizeText(body.description, 5000);
    }
    if (Object.prototype.hasOwnProperty.call(body, 'images')) {
      patch.images = sanitizeCardImages(body.images, { persistDataUrls: true });
    }
    if (Object.prototype.hasOwnProperty.call(body, 'checklist')) {
      patch.checklist = sanitizeChecklist(body.checklist);
    }
    if (Object.prototype.hasOwnProperty.call(body, 'urgency')) {
      if (!URGENCY_SET.has(body.urgency)) {
        sendJson(res, 400, { error: 'INVALID_URGENCY' }, req);
        return true;
      }
      patch.urgency = body.urgency;
    }
    if (Object.prototype.hasOwnProperty.call(body, 'isFavorite')) {
      patch.isFavorite = sanitizeCardFavorite(body.isFavorite);
    }

    if (Object.keys(patch).length === 0) {
      sendJson(res, 400, { error: 'EMPTY_PATCH' }, req);
      return true;
    }

    const now = Date.now();
    const conn = await pool.getConnection();
    try {
      await conn.beginTransaction();

      const row = await mysqlGetCardRow(conn, user.id, cardId, { forUpdate: true });
      if (!row) throw makeMysqlHttpError(404, { error: REPEATED_DELETE_ERROR_TEXT });
      const prevImages = parseCardImagesFromDb(row.images_json);

      const nextTitle = Object.prototype.hasOwnProperty.call(patch, 'title') ? patch.title : sanitizeText(row.title, 512);
      const nextDescription = Object.prototype.hasOwnProperty.call(patch, 'description')
        ? patch.description
        : sanitizeText(row.description, 5000);
      const nextImages = Object.prototype.hasOwnProperty.call(patch, 'images')
        ? patch.images
        : parseCardImagesFromDb(row.images_json);
      const nextChecklist = Object.prototype.hasOwnProperty.call(patch, 'checklist')
        ? sanitizeChecklist(patch.checklist)
        : parseChecklistFromDb(row.checklist_json);
      const nextUrgency = Object.prototype.hasOwnProperty.call(patch, 'urgency')
        ? patch.urgency
        : URGENCY_SET.has(row.urgency)
          ? row.urgency
          : 'white';
      const nextIsFavorite = Object.prototype.hasOwnProperty.call(patch, 'isFavorite')
        ? sanitizeCardFavorite(patch.isFavorite)
        : sanitizeCardFavorite(row.is_favorite);

      await conn.query(
        `UPDATE ${MYSQL_CARDS_TABLE}
         SET title = ?, description = ?, images_json = ?, checklist_json = ?, urgency = ?, is_favorite = ?
         WHERE user_id = ? AND id = ?`,
        [
          nextTitle,
          nextDescription,
          encodeCardImagesForDb(nextImages),
          encodeChecklistForDb(nextChecklist),
          nextUrgency,
          nextIsFavorite ? 1 : 0,
          user.id,
          cardId,
        ]
      );
      await mysqlReplaceMediaLinksForOwner(conn, user.id, 'card', cardId, '', nextImages);

      const position = await mysqlGetCardColumnPosition(conn, user.id, cardId, { forUpdate: true });
      const isFloating = !position.columnId && (await mysqlCardIsFloating(conn, user.id, cardId, { forUpdate: true }));
      const status = position.columnId || (isFloating ? 'freedom' : 'queue');
      const comments = await mysqlLoadCardComments(conn, user.id, cardId);
      const version = await mysqlBumpBoardVersion(conn, user.id, now);
      await conn.commit();

      const card = mysqlRowToCard(
        {
          ...row,
          title: nextTitle,
          description: nextDescription,
          images_json: encodeCardImagesForDb(nextImages),
          checklist_json: encodeChecklistForDb(nextChecklist),
          urgency: nextUrgency,
          is_favorite: nextIsFavorite ? 1 : 0,
        },
        status,
        comments
      );

      releaseMediaGcGraceForRemovedImages(prevImages, nextImages, 'mysql-card-patch-detached');
      scheduleMediaGc('mysql-card-patch');
      sendJson(
        res,
        200,
        {
          ok: true,
          card,
          columnId: position.columnId,
          index: Number.isFinite(Number(position.index)) ? Number(position.index) : -1,
          updatedAt: now,
          version,
        },
        req
      );
      return true;
    } catch (err) {
      await conn.rollback();
      if (isMysqlHttpError(err)) {
        sendJson(res, Number(err.httpStatus), err.httpPayload, req);
        return true;
      }
      throw err;
    } finally {
      conn.release();
    }
  }

  if (cardId && req.method === 'DELETE') {
    const now = Date.now();
    const conn = await pool.getConnection();
    try {
      await conn.beginTransaction();

      const row = await mysqlGetCardRow(conn, user.id, cardId, { forUpdate: true });
      if (!row) throw makeMysqlHttpError(404, { error: REPEATED_DELETE_ERROR_TEXT });
      const prevCardForMedia = {
        images: parseCardImagesFromDb(row.images_json),
        comments: await mysqlLoadCardComments(conn, user.id, cardId),
      };

      const fromPos = await mysqlGetCardColumnPosition(conn, user.id, cardId, { forUpdate: true });
      const fromColumnId = fromPos.columnId;
      const fromIndex = fromPos.index;

      let doingDeltaMs = 0;
      if (fromColumnId === 'doing' && row.doing_started_at_ms != null && Number.isFinite(Number(row.doing_started_at_ms))) {
        doingDeltaMs = Math.max(0, now - Number(row.doing_started_at_ms));
      }

      if (fromColumnId && Number.isFinite(Number(fromIndex))) {
        await conn.query(
          `DELETE FROM ${MYSQL_COLUMNS_TABLE}
           WHERE user_id = ? AND column_id = ? AND card_id = ?`,
          [user.id, fromColumnId, cardId]
        );
        await mysqlShiftColumnIndexes(conn, user.id, fromColumnId, Number(fromIndex) + 1, -1, 'asc');
      } else {
        await conn.query(
          `DELETE FROM ${MYSQL_FLOATING_TABLE}
           WHERE user_id = ? AND card_id = ?`,
          [user.id, cardId]
        );
      }

      await mysqlArchiveCommentsByCard(conn, user.id, cardId, 'card-delete', now);
      await conn.query(
        `DELETE FROM ${MYSQL_CARDS_TABLE}
         WHERE user_id = ? AND id = ?`,
        [user.id, cardId]
      );
      await mysqlDeleteMediaLinksByCard(conn, user.id, cardId, ['card', 'comment']);
      await mysqlPruneUnlinkedMediaFiles(conn, user.id);

      let text = `Карточка "${displayCardTitle(row.title)}" удалена из "${columnTitle(fromColumnId || 'queue')}"`;
      if (fromColumnId === 'doing') {
        text += doingDeltaMs > 0 ? ` (таймер +${formatElapsedHms(doingDeltaMs)})` : ' (таймер остановлен)';
      }

      await mysqlInsertHistoryEntry(conn, user.id, {
        id: randomUUID(),
        at: now,
        text,
        cardId: null,
        kind: 'delete',
        meta: {
          title: sanitizeText(row.title, 512),
          fromCol: fromColumnId,
          toCol: null,
          doingDeltaMs,
        },
      });

      const version = await mysqlBumpBoardVersion(conn, user.id, now);
      await conn.commit();

      releaseMediaGcGraceForRemovedCard(prevCardForMedia, null, 'mysql-card-delete-detached');
      scheduleMediaGc('mysql-card-delete');
      sendJson(res, 200, { ok: true, deletedId: cardId, fromColumnId, updatedAt: now, version }, req);
      return true;
    } catch (err) {
      await conn.rollback();
      if (isMysqlHttpError(err)) {
        sendJson(res, Number(err.httpStatus), err.httpPayload, req);
        return true;
      }
      throw err;
    } finally {
      conn.release();
    }
  }

  if (isBoardPath || isCardsCreatePath || moveCardId || cardId) {
    sendJson(res, 405, { error: 'METHOD_NOT_ALLOWED' }, req);
    return true;
  }

  return false;
}

async function handleMysqlHistoryApi(req, res, pathname, searchParams) {
  if (DB_PROVIDER !== 'mysql') return false;
  await ensureMysqlSchema();

  const isHistoryPath = pathname === '/api/history';
  const historyEntryId = extractHistoryEntryIdFromPath(pathname);
  if (!isHistoryPath && !historyEntryId) return false;

  const pool = await getMysqlPool();
  const user = await requireMysqlUser(req, res, pool);
  if (!user) return true;

  if (isHistoryPath && req.method === 'GET') {
    const limit = parsePositiveInt(searchParams?.get('limit'), 100, 1, 500);
    const offset = parseNonNegativeInt(searchParams?.get('offset'), 0, 1_000_000);
    const order = String(searchParams?.get('order') ?? 'desc').trim().toLowerCase() === 'asc' ? 'asc' : 'desc';
    const kindFilter = parseHistoryKindFilter(searchParams?.get('kind'));
    if (!kindFilter.ok) {
      sendJson(res, 400, { error: 'INVALID_HISTORY_KIND' }, req);
      return true;
    }

    const orderSql = order === 'asc' ? 'ASC' : 'DESC';
    const whereKind = kindFilter.kind ? ' AND kind = ?' : '';
    const listParams = kindFilter.kind
      ? [user.id, kindFilter.kind, limit, offset]
      : [user.id, limit, offset];
    const [rows] = await pool.query(
      `SELECT id, at_ms, text, card_id, kind, meta_json
       FROM ${MYSQL_HISTORY_TABLE}
       WHERE user_id = ?${whereKind}
       ORDER BY at_ms ${orderSql}, id ${orderSql}
       LIMIT ? OFFSET ?`,
      listParams
    );
    const countParams = kindFilter.kind ? [user.id, kindFilter.kind] : [user.id];
    const [countRows] = await pool.query(
      `SELECT COUNT(*) AS cnt
       FROM ${MYSQL_HISTORY_TABLE}
       WHERE user_id = ?${whereKind}`,
      countParams
    );
    const historyCount = Array.isArray(countRows) && countRows.length > 0 ? Number(countRows[0].cnt ?? 0) : 0;

    const entries = [];
    for (const row of Array.isArray(rows) ? rows : []) {
      const kind = sanitizeHistoryKind(row.kind);
      let parsedMeta = null;
      try {
        if (row.meta_json == null) parsedMeta = null;
        else if (Buffer.isBuffer(row.meta_json)) parsedMeta = JSON.parse(row.meta_json.toString('utf8'));
        else if (typeof row.meta_json === 'string') parsedMeta = JSON.parse(row.meta_json);
        else parsedMeta = row.meta_json;
      } catch {
        parsedMeta = null;
      }
      const meta = sanitizeHistoryMeta(parsedMeta);
      const entry = {
        id: String(row.id ?? '').trim() || randomUUID(),
        at: Number(row.at_ms) || Date.now(),
        text: sanitizeText(row.text, 4000),
        cardId: row.card_id == null ? null : String(row.card_id).trim() || null,
      };
      if (kind) entry.kind = kind;
      if (meta) entry.meta = meta;
      entries.push(entry);
    }

    sendJson(
      res,
      200,
      {
        ok: true,
        entries,
        historyCount,
        pagination: {
          limit,
          offset,
          returned: entries.length,
          hasMore: offset + entries.length < historyCount,
          nextOffset: offset + entries.length < historyCount ? offset + entries.length : null,
          order,
        },
        filters: {
          kind: kindFilter.kind,
        },
      },
      req
    );
    return true;
  }

  if (isHistoryPath && req.method === 'DELETE') {
    const now = Date.now();
    const conn = await pool.getConnection();
    try {
      await conn.beginTransaction();
      const [countRows] = await conn.query(
        `SELECT COUNT(*) AS cnt
         FROM ${MYSQL_HISTORY_TABLE}
         WHERE user_id = ?`,
        [user.id]
      );
      const deletedCount = Array.isArray(countRows) && countRows.length > 0 ? Number(countRows[0].cnt ?? 0) : 0;
      await conn.query(
        `DELETE FROM ${MYSQL_HISTORY_TABLE}
         WHERE user_id = ?`,
        [user.id]
      );
      const version = await mysqlBumpBoardVersion(conn, user.id, now);
      await conn.commit();
      sendJson(res, 200, { ok: true, deletedCount, updatedAt: now, version }, req);
      return true;
    } catch (err) {
      await conn.rollback();
      throw err;
    } finally {
      conn.release();
    }
  }

  if (historyEntryId && req.method === 'DELETE') {
    const now = Date.now();
    const conn = await pool.getConnection();
    try {
      await conn.beginTransaction();
      const [rows] = await conn.query(
        `SELECT id
         FROM ${MYSQL_HISTORY_TABLE}
         WHERE user_id = ? AND id = ?
         LIMIT 1`,
        [user.id, historyEntryId]
      );
      if (!Array.isArray(rows) || rows.length === 0) {
        await conn.rollback();
        sendJson(res, 404, { error: REPEATED_DELETE_ERROR_TEXT }, req);
        return true;
      }
      await conn.query(
        `DELETE FROM ${MYSQL_HISTORY_TABLE}
         WHERE user_id = ? AND id = ?`,
        [user.id, historyEntryId]
      );
      const version = await mysqlBumpBoardVersion(conn, user.id, now);
      await conn.commit();
      sendJson(res, 200, { ok: true, deletedId: historyEntryId, updatedAt: now, version }, req);
      return true;
    } catch (err) {
      await conn.rollback();
      throw err;
    } finally {
      conn.release();
    }
  }

  sendJson(res, 405, { error: 'METHOD_NOT_ALLOWED' }, req);
  return true;
}

async function handleMysqlFavoritesApi(req, res, pathname, searchParams) {
  if (DB_PROVIDER !== 'mysql') return false;
  if (pathname !== '/api/favorites') return false;
  await ensureMysqlSchema();

  const pool = await getMysqlPool();
  const user = await requireMysqlUser(req, res, pool);
  if (!user) return true;

  if (req.method !== 'GET') {
    sendJson(res, 405, { error: 'METHOD_NOT_ALLOWED' }, req);
    return true;
  }

  const limit = parsePositiveInt(searchParams?.get('limit'), 100, 1, 500);
  const offset = parseNonNegativeInt(searchParams?.get('offset'), 0, 1_000_000);
  const order = String(searchParams?.get('order') ?? 'desc').trim().toLowerCase() === 'asc' ? 'asc' : 'desc';
  const statusFilter = parseFavoritesStatusFilter(searchParams?.get('status'));
  if (!statusFilter.ok) {
    sendJson(res, 400, { error: 'INVALID_FAVORITES_STATUS' }, req);
    return true;
  }

  const state = await readUserBoardStateFromMysql(pool, user.id);
  const allFavorites = buildFavoritesEntriesFromState(state, {
    order,
    status: statusFilter.status,
  });
  const favoritesCount = allFavorites.length;
  const favorites = allFavorites.slice(offset, offset + limit);
  const version = await mysqlGetBoardVersion(pool, user.id);

  sendJson(
    res,
    200,
    {
      ok: true,
      favorites,
      favoritesCount,
      version,
      pagination: {
        limit,
        offset,
        returned: favorites.length,
        hasMore: offset + favorites.length < favoritesCount,
        nextOffset: offset + favorites.length < favoritesCount ? offset + favorites.length : null,
        order,
      },
      filters: {
        status: statusFilter.status,
      },
    },
    req
  );
  return true;
}

async function handleMysqlCommentsApi(req, res, pathname, searchParams) {
  if (DB_PROVIDER !== 'mysql') return false;
  await ensureMysqlSchema();

  const archiveRestorePath = extractCardCommentArchiveRestorePath(pathname);
  if (archiveRestorePath) {
    const pool = await getMysqlPool();
    const user = await requireMysqlUser(req, res, pool);
    if (!user) return true;

    if (req.method === 'POST') {
      if (
        applyRateLimit(req, res, {
          scope: 'comment_mutation',
          userId: user.id,
          limit: RATE_LIMIT_COMMENT_MUTATION_MAX,
          windowMs: RATE_LIMIT_COMMENT_MUTATION_WINDOW_MS,
        })
      ) {
        return true;
      }
      try {
        const restored = await mysqlRestoreArchivedComment(
          pool,
          user.id,
          archiveRestorePath.cardId,
          archiveRestorePath.archiveId
        );
        sendJson(
          res,
          200,
          {
            ok: true,
            cardId: archiveRestorePath.cardId,
            comment: restored.comment,
            commentsCount: restored.commentsCount,
            updatedAt: restored.updatedAt,
            version: restored.version,
          },
          req
        );
        return true;
      } catch (err) {
        if (isMysqlHttpError(err)) {
          sendJson(res, Number(err.httpStatus), err.httpPayload, req);
          return true;
        }
        throw err;
      }
    }

    sendJson(res, 405, { error: 'METHOD_NOT_ALLOWED' }, req);
    return true;
  }

  const commentsArchiveCardId = extractCardCommentsArchiveIdFromPath(pathname);
  if (commentsArchiveCardId) {
    const pool = await getMysqlPool();
    const user = await requireMysqlUser(req, res, pool);
    if (!user) return true;

    if (req.method === 'GET') {
      const limit = parsePositiveInt(searchParams?.get('limit'), 100, 1, 500);
      const offset = parseNonNegativeInt(searchParams?.get('offset'), 0, 1_000_000);
      const order = String(searchParams?.get('order') ?? 'desc').trim().toLowerCase() === 'asc' ? 'asc' : 'desc';
      const reasonFilter = parseCommentArchiveReasonFilter(searchParams?.get('reason'));
      if (!reasonFilter.ok) {
        sendJson(res, 400, { error: 'INVALID_ARCHIVE_REASON' }, req);
        return true;
      }
      const version = await mysqlGetBoardVersion(pool, user.id);
      const etag = archiveCommentsPageEtag({
        cardId: commentsArchiveCardId,
        reason: reasonFilter.reason ?? 'all',
        order,
        offset,
        limit,
        version,
      });
      const headers = {
        ETag: etag,
        'Cache-Control': 'private, no-cache',
      };
      if (requestHasMatchingEtag(req, etag)) {
        setCors(res, req);
        const vary = res.getHeader('Vary');
        res.writeHead(304, {
          ...headers,
          ...(vary != null ? { Vary: String(vary) } : {}),
        });
        res.end();
        return true;
      }

      const archivedComments = await mysqlListArchivedComments(
        pool,
        user.id,
        commentsArchiveCardId,
        offset,
        limit,
        order,
        reasonFilter.reason
      );
      const totalCount =
        offset === 0 && archivedComments.length < limit
          ? archivedComments.length
          : await mysqlCountArchivedComments(pool, user.id, commentsArchiveCardId, reasonFilter.reason);

      sendJson(
        res,
        200,
        {
          ok: true,
          cardId: commentsArchiveCardId,
          archivedComments,
          archivedCount: totalCount,
          pagination: {
            limit,
            offset,
            returned: archivedComments.length,
            hasMore: offset + archivedComments.length < totalCount,
            nextOffset: offset + archivedComments.length < totalCount ? offset + archivedComments.length : null,
            order,
          },
          filters: {
            reason: reasonFilter.reason,
          },
        },
        req,
        headers
      );
      return true;
    }

    sendJson(res, 405, { error: 'METHOD_NOT_ALLOWED' }, req);
    return true;
  }

  const commentsCardId = extractCardCommentsIdFromPath(pathname);
  if (commentsCardId) {
    const pool = await getMysqlPool();
    const user = await requireMysqlUser(req, res, pool);
    if (!user) return true;

    const cardExists = await mysqlCardExists(pool, user.id, commentsCardId);
    if (!cardExists) {
      sendJson(res, 404, { error: 'CARD_NOT_FOUND' }, req);
      return true;
    }

    if (req.method === 'GET') {
      const limit = parsePositiveInt(searchParams?.get('limit'), MAX_COMMENTS_PER_CARD, 1, MAX_COMMENTS_PER_CARD);
      const offset = parseNonNegativeInt(searchParams?.get('offset'), 0, 1_000_000);
      const order = String(searchParams?.get('order') ?? 'asc').trim().toLowerCase() === 'desc' ? 'desc' : 'asc';
      const version = await mysqlGetBoardVersion(pool, user.id);
      const etag = commentsPageEtag({
        cardId: commentsCardId,
        order,
        offset,
        limit,
        version,
      });
      const headers = {
        ETag: etag,
        'Cache-Control': 'private, no-cache',
      };
      if (requestHasMatchingEtag(req, etag)) {
        setCors(res, req);
        const vary = res.getHeader('Vary');
        res.writeHead(304, {
          ...headers,
          ...(vary != null ? { Vary: String(vary) } : {}),
        });
        res.end();
        return true;
      }

      const comments = await mysqlListComments(pool, user.id, commentsCardId, offset, limit, order);
      const commentsCount =
        offset === 0 && comments.length < limit
          ? comments.length
          : await mysqlCountComments(pool, user.id, commentsCardId);

      sendJson(
        res,
        200,
        {
          ok: true,
          cardId: commentsCardId,
          comments,
          commentsCount,
          version,
          pagination: {
            limit,
            offset,
            returned: comments.length,
            hasMore: offset + comments.length < commentsCount,
            nextOffset: offset + comments.length < commentsCount ? offset + comments.length : null,
            order,
          },
        },
        req,
        headers
      );
      return true;
    }

    if (req.method === 'POST') {
      if (
        applyRateLimit(req, res, {
          scope: 'comment_mutation',
          userId: user.id,
          limit: RATE_LIMIT_COMMENT_MUTATION_MAX,
          windowMs: RATE_LIMIT_COMMENT_MUTATION_WINDOW_MS,
        })
      ) {
        return true;
      }
      let body;
      try {
        body = await readJsonBody(req);
      } catch (err) {
        sendJson(res, 400, { error: 'BAD_JSON', message: String(err?.message ?? 'Bad JSON') }, req);
        return true;
      }

      const text = sanitizeCommentText(body?.text);
      const images = sanitizeCardImages(body?.images, { persistDataUrls: true });
      const hasText = !!text && !!richCommentToPlainText(text);
      if (!hasText && images.length === 0) {
        sendJson(res, 400, { error: 'INVALID_COMMENT_TEXT' }, req);
        return true;
      }

      const now = Date.now();
      const comment = {
        id: randomUUID(),
        text: hasText ? text : '',
        images,
        createdAt: now,
        updatedAt: now,
        author: sanitizeCommentAuthor(user.login),
      };

      await pool.query(
        `INSERT INTO ${MYSQL_COMMENTS_TABLE}
          (user_id, card_id, id, author, text, images_json, created_at_ms, updated_at_ms)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          user.id,
          commentsCardId,
          comment.id,
          comment.author,
          comment.text,
          encodeCommentImagesForDb(comment.images),
          comment.createdAt,
          comment.updatedAt,
        ]
      );
      await mysqlReplaceMediaLinksForOwner(pool, user.id, 'comment', commentsCardId, comment.id, comment.images);
      const commentsCount = await mysqlPruneComments(pool, user.id, commentsCardId);
      const version = await mysqlBumpBoardVersion(pool, user.id, now);

      scheduleMediaGc('mysql-comment-post');
      sendJson(
        res,
        201,
        {
          ok: true,
          cardId: commentsCardId,
          comment,
          commentsCount,
          updatedAt: now,
          version,
        },
        req
      );
      return true;
    }

    sendJson(res, 405, { error: 'METHOD_NOT_ALLOWED' }, req);
    return true;
  }

  const commentPath = extractCardCommentPath(pathname);
  if (commentPath) {
    const pool = await getMysqlPool();
    const user = await requireMysqlUser(req, res, pool);
    if (!user) return true;

    const cardExists = await mysqlCardExists(pool, user.id, commentPath.cardId);
    if (!cardExists) {
      sendJson(res, 404, { error: req.method === 'DELETE' ? REPEATED_DELETE_ERROR_TEXT : 'CARD_NOT_FOUND' }, req);
      return true;
    }

    const existing = await mysqlSelectComment(pool, user.id, commentPath.cardId, commentPath.commentId);
    if (!existing) {
      sendJson(res, 404, { error: req.method === 'DELETE' ? REPEATED_DELETE_ERROR_TEXT : 'COMMENT_NOT_FOUND' }, req);
      return true;
    }

    const actorKey = loginKey(user.login);
    const commentAuthorKey = existing.author ? loginKey(existing.author) : '';
    if (!commentAuthorKey || commentAuthorKey !== actorKey) {
      sendJson(res, 403, { error: 'COMMENT_FORBIDDEN' }, req);
      return true;
    }

    if (req.method === 'PATCH') {
      if (
        applyRateLimit(req, res, {
          scope: 'comment_mutation',
          userId: user.id,
          limit: RATE_LIMIT_COMMENT_MUTATION_MAX,
          windowMs: RATE_LIMIT_COMMENT_MUTATION_WINDOW_MS,
        })
      ) {
        return true;
      }
      let body;
      try {
        body = await readJsonBody(req);
      } catch (err) {
        sendJson(res, 400, { error: 'BAD_JSON', message: String(err?.message ?? 'Bad JSON') }, req);
        return true;
      }

      const text = sanitizeCommentText(body?.text);
      const previousImages = sanitizeCardImages(existing.images);
      const nextImages = Object.prototype.hasOwnProperty.call(body ?? {}, 'images')
        ? sanitizeCardImages(body?.images, { persistDataUrls: true })
        : sanitizeCardImages(existing.images);
      const hasText = !!text && !!richCommentToPlainText(text);
      if (!hasText && nextImages.length === 0) {
        sendJson(res, 400, { error: 'INVALID_COMMENT_TEXT' }, req);
        return true;
      }

      const now = Date.now();
      await pool.query(
        `UPDATE ${MYSQL_COMMENTS_TABLE}
         SET text = ?, images_json = ?, updated_at_ms = ?
         WHERE user_id = ? AND card_id = ? AND id = ?`,
        [hasText ? text : '', encodeCommentImagesForDb(nextImages), now, user.id, commentPath.cardId, commentPath.commentId]
      );
      await mysqlReplaceMediaLinksForOwner(pool, user.id, 'comment', commentPath.cardId, commentPath.commentId, nextImages);
      await mysqlPruneUnlinkedMediaFiles(pool, user.id);

      const updatedComment = await mysqlSelectComment(pool, user.id, commentPath.cardId, commentPath.commentId);
      if (!updatedComment) {
        sendJson(res, 500, { error: 'COMMENT_UPDATE_FAILED' }, req);
        return true;
      }
      const commentsCount = await mysqlCountComments(pool, user.id, commentPath.cardId);
      const version = await mysqlBumpBoardVersion(pool, user.id, now);

      releaseMediaGcGraceForRemovedImages(previousImages, nextImages, 'mysql-comment-patch-detached');
      scheduleMediaGc('mysql-comment-patch');
      sendJson(
        res,
        200,
        {
          ok: true,
          cardId: commentPath.cardId,
          comment: updatedComment,
          commentsCount,
          updatedAt: now,
          version,
        },
        req
      );
      return true;
    }

    if (req.method === 'DELETE') {
      if (
        applyRateLimit(req, res, {
          scope: 'comment_mutation',
          userId: user.id,
          limit: RATE_LIMIT_COMMENT_MUTATION_MAX,
          windowMs: RATE_LIMIT_COMMENT_MUTATION_WINDOW_MS,
        })
      ) {
        return true;
      }
      const previousImages = sanitizeCardImages(existing.images);
      const now = Date.now();
      await mysqlArchiveCommentsByIds(pool, user.id, commentPath.cardId, [commentPath.commentId], 'delete', now);
      await pool.query(
        `DELETE FROM ${MYSQL_COMMENTS_TABLE}
         WHERE user_id = ? AND card_id = ? AND id = ?`,
        [user.id, commentPath.cardId, commentPath.commentId]
      );
      await mysqlDeleteMediaLinksForOwner(pool, user.id, 'comment', commentPath.cardId, commentPath.commentId);
      await mysqlPruneUnlinkedMediaFiles(pool, user.id);

      const commentsCount = await mysqlCountComments(pool, user.id, commentPath.cardId);
      const version = await mysqlBumpBoardVersion(pool, user.id, now);
      releaseMediaGcGraceForRemovedImages(previousImages, [], 'mysql-comment-delete-detached');
      scheduleMediaGc('mysql-comment-delete');
      sendJson(
        res,
        200,
        {
          ok: true,
          cardId: commentPath.cardId,
          commentsCount,
          updatedAt: now,
          version,
        },
        req
      );
      return true;
    }

    sendJson(res, 405, { error: 'METHOD_NOT_ALLOWED' }, req);
    return true;
  }

  return false;
}

function setCors(res, req) {
  const origin = req.headers.origin;
  if (typeof origin === 'string' && ALLOWED_ORIGINS.has(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
  }
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, PATCH, DELETE, OPTIONS');
}

function sendJson(res, status, payload, req, extraHeaders = null) {
  if (req) setCors(res, req);
  const body = Buffer.from(JSON.stringify(payload), 'utf8');
  let encodedBody = body;
  let contentEncoding = null;
  if (req && acceptsGzip(req) && body.length >= JSON_GZIP_MIN_BYTES) {
    const gzipped = gzipSync(body, { level: JSON_GZIP_LEVEL });
    if (gzipped.length + JSON_GZIP_MIN_SAVINGS_BYTES < body.length) {
      encodedBody = gzipped;
      contentEncoding = 'gzip';
    }
  }

  const existingVary = res.getHeader('Vary');
  const headers = {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': encodedBody.length,
    ...(contentEncoding ? { 'Content-Encoding': contentEncoding } : {}),
    ...(contentEncoding ? { Vary: mergeVaryHeader(existingVary, 'Accept-Encoding') } : {}),
  };
  const extras = extraHeaders && typeof extraHeaders === 'object' ? { ...extraHeaders } : null;
  if (extras && Object.prototype.hasOwnProperty.call(extras, 'Vary')) {
    headers.Vary = mergeVaryHeader(headers.Vary ?? existingVary, extras.Vary);
    delete extras.Vary;
  } else if (!headers.Vary && existingVary != null) {
    headers.Vary = String(existingVary);
  }
  res.writeHead(status, {
    ...headers,
    ...(extras ?? {}),
  });
  res.end(encodedBody);
}

function sendText(res, status, text) {
  const body = String(text);
  res.writeHead(status, {
    'Content-Type': 'text/plain; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
  });
  res.end(body);
}

function sendBuffer(res, status, body, contentType, req, extraHeaders = null) {
  if (req) setCors(res, req);
  const headers = {
    'Content-Type': contentType,
    'Content-Length': body.length,
    ...(extraHeaders && typeof extraHeaders === 'object' ? extraHeaders : {}),
  };
  res.writeHead(status, headers);
  res.end(body);
}

function weakEtagFromSizeMtime(size, mtimeMs) {
  const normalizedSize = Number.isFinite(Number(size)) && Number(size) >= 0 ? Math.trunc(Number(size)) : 0;
  const normalizedMtime = Number.isFinite(Number(mtimeMs)) && Number(mtimeMs) >= 0 ? Math.trunc(Number(mtimeMs)) : 0;
  return `W/"${normalizedSize.toString(16)}-${normalizedMtime.toString(16)}"`;
}

function boardVersionEtag(version) {
  const normalized = Number.isFinite(Number(version)) ? Math.max(0, Math.trunc(Number(version))) : 0;
  return `W/"board-v${normalized}"`;
}

function sanitizeEtagPart(value, fallback = 'x') {
  const token = String(value ?? '')
    .trim()
    .replace(/[^a-z0-9_-]+/gi, '_')
    .slice(0, 64);
  return token || fallback;
}

function archiveCommentsPageEtag({ cardId, reason, order, offset, limit, version }) {
  const normalizedVersion = Number.isFinite(Number(version)) ? Math.max(0, Math.trunc(Number(version))) : 0;
  const normalizedOffset = Number.isFinite(Number(offset)) ? Math.max(0, Math.trunc(Number(offset))) : 0;
  const normalizedLimit = Number.isFinite(Number(limit)) ? Math.max(1, Math.trunc(Number(limit))) : 100;
  return `W/"arch-${sanitizeEtagPart(cardId, 'card')}-${sanitizeEtagPart(reason ?? 'all', 'all')}-${sanitizeEtagPart(
    order ?? 'desc',
    'desc'
  )}-${normalizedOffset}-${normalizedLimit}-v${normalizedVersion}"`;
}

function commentsPageEtag({ cardId, order, offset, limit, version }) {
  const normalizedOffset = Number.isFinite(Number(offset)) ? Math.max(0, Math.trunc(Number(offset))) : 0;
  const normalizedLimit = Number.isFinite(Number(limit)) ? Math.max(1, Math.trunc(Number(limit))) : 100;
  const normalizedVersion = Number.isFinite(Number(version))
    ? `v${Math.max(0, Math.trunc(Number(version)))}`
    : sanitizeEtagPart(version ?? 'v0', 'v0');
  return `W/"com-${sanitizeEtagPart(cardId, 'card')}-${sanitizeEtagPart(order ?? 'asc', 'asc')}-${normalizedOffset}-${normalizedLimit}-${normalizedVersion}"`;
}

function fileDbEtag() {
  ensureDbFile();
  try {
    const stats = statSync(DB_FILE);
    return weakEtagFromSizeMtime(stats.size, stats.mtimeMs);
  } catch {
    return null;
  }
}

function normalizeEtagToken(value) {
  return String(value ?? '')
    .trim()
    .replace(/^W\//i, '');
}

function requestHasMatchingEtag(req, etag) {
  const raw = String(req?.headers?.['if-none-match'] ?? '').trim();
  if (!raw) return false;
  if (raw === '*') return true;
  const target = normalizeEtagToken(etag);
  for (const token of raw.split(',')) {
    if (normalizeEtagToken(token) === target) return true;
  }
  return false;
}

function requestNotModifiedSince(req, mtimeMs) {
  const raw = String(req?.headers?.['if-modified-since'] ?? '').trim();
  if (!raw) return false;
  const since = Date.parse(raw);
  if (!Number.isFinite(since)) return false;
  return Math.trunc(Number(mtimeMs) || 0) <= Math.trunc(since);
}

function isImmutableDistAsset(filePath) {
  const value = String(filePath ?? '');
  return /[\\/]+assets[\\/].+-[a-z0-9_-]{8,}\.[a-z0-9]+$/i.test(value);
}

function acceptsGzip(req) {
  const raw = String(req?.headers?.['accept-encoding'] ?? '')
    .trim()
    .toLowerCase();
  if (!raw) return false;
  const variants = raw.split(',');
  for (const variantRaw of variants) {
    const variant = variantRaw.trim();
    if (!variant) continue;
    const [nameRaw, ...params] = variant.split(';');
    const name = String(nameRaw ?? '')
      .trim()
      .toLowerCase();
    if (name !== 'gzip' && name !== '*') continue;
    let q = 1;
    for (const p of params) {
      const part = p.trim().toLowerCase();
      if (!part.startsWith('q=')) continue;
      const parsed = Number(part.slice(2));
      if (Number.isFinite(parsed)) q = parsed;
      break;
    }
    if (q > 0) return true;
  }
  return false;
}

function mergeVaryHeader(baseValue, addValue) {
  const tokenSet = new Set();
  const append = (value) => {
    if (Array.isArray(value)) {
      for (const item of value) append(item);
      return;
    }
    const raw = String(value ?? '').trim();
    if (!raw) return;
    for (const part of raw.split(',')) {
      const token = part.trim();
      if (!token) continue;
      tokenSet.add(token.toLowerCase());
    }
  };
  append(baseValue);
  append(addValue);
  if (tokenSet.size === 0) return undefined;
  return [...tokenSet].join(', ');
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;

    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_JSON_BYTES) {
        reject(new Error('Payload too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });

    req.on('end', () => {
      try {
        const text = Buffer.concat(chunks).toString('utf8').trim();
        if (!text) return resolve({});
        resolve(JSON.parse(text));
      } catch {
        reject(new Error('Invalid JSON'));
      }
    });

    req.on('error', reject);
  });
}

function clientAddressFromReq(req) {
  const xff = String(req?.headers?.['x-forwarded-for'] ?? '').trim();
  if (xff) {
    const first = xff.split(',')[0]?.trim();
    if (first) return first.slice(0, 128);
  }
  const xrip = String(req?.headers?.['x-real-ip'] ?? '').trim();
  if (xrip) return xrip.slice(0, 128);
  const socketIp = String(req?.socket?.remoteAddress ?? '').trim();
  if (socketIp) return socketIp.slice(0, 128);
  return 'unknown';
}

function pruneRateLimitState(now = Date.now()) {
  if (rateLimitState.size === 0) {
    rateLimitLastPruneAtMs = now;
    return;
  }
  if (
    rateLimitState.size < RATE_LIMIT_STATE_MAX_ENTRIES &&
    now - rateLimitLastPruneAtMs < 20_000
  ) {
    return;
  }
  for (const [key, bucket] of rateLimitState.entries()) {
    const lastSeenAt = Number(bucket?.lastSeenAt ?? 0);
    if (!Number.isFinite(lastSeenAt) || now - lastSeenAt > RATE_LIMIT_STATE_TTL_MS) {
      rateLimitState.delete(key);
    }
  }
  if (rateLimitState.size > RATE_LIMIT_STATE_MAX_ENTRIES) {
    const entries = [...rateLimitState.entries()].sort(
      (a, b) => Number(a?.[1]?.lastSeenAt ?? 0) - Number(b?.[1]?.lastSeenAt ?? 0)
    );
    const dropCount = Math.max(0, entries.length - RATE_LIMIT_STATE_MAX_ENTRIES);
    for (let i = 0; i < dropCount; i += 1) {
      rateLimitState.delete(entries[i][0]);
    }
  }
  rateLimitLastPruneAtMs = now;
}

function buildRateLimitKey(scope, userId, req) {
  const normalizedScope = String(scope ?? '')
    .trim()
    .toLowerCase()
    .slice(0, 64) || 'global';
  const normalizedUserId = String(userId ?? '')
    .trim()
    .slice(0, 64) || '-';
  const ip = clientAddressFromReq(req);
  return `${normalizedScope}|${normalizedUserId}|${ip}`;
}

function applyRateLimit(req, res, options = {}) {
  const scope = String(options.scope ?? 'global')
    .trim()
    .toLowerCase()
    .slice(0, 64) || 'global';
  const limitRaw = Number(options.limit);
  const windowRaw = Number(options.windowMs);
  const limit = Number.isFinite(limitRaw) && limitRaw > 0 ? Math.trunc(limitRaw) : 1;
  const windowMs = Number.isFinite(windowRaw) && windowRaw > 0 ? Math.trunc(windowRaw) : 1000;
  const userId = String(options.userId ?? '').trim();
  const key = buildRateLimitKey(scope, userId, req);
  const now = Date.now();
  pruneRateLimitState(now);

  const prev = rateLimitState.get(key);
  const prevWindowStart = Number(prev?.windowStartAt ?? 0);
  const isSameWindow = Number.isFinite(prevWindowStart) && now - prevWindowStart < windowMs;
  const nextCount = isSameWindow ? Number(prev?.count ?? 0) + 1 : 1;
  const windowStartAt = isSameWindow ? prevWindowStart : now;

  rateLimitState.set(key, {
    windowStartAt,
    count: nextCount,
    lastSeenAt: now,
  });

  if (nextCount <= limit) return false;

  const retryAfterMs = Math.max(1, windowStartAt + windowMs - now);
  const retryAfterSec = Math.max(1, Math.ceil(retryAfterMs / 1000));
  sendJson(
    res,
    429,
    {
      error: 'RATE_LIMITED',
      scope,
      limit,
      windowMs,
      retryAfterMs,
    },
    req,
    { 'Retry-After': String(retryAfterSec) }
  );
  return true;
}

function requireUser(req, res, db) {
  const token = extractBearerToken(req);
  const user = findUserByToken(db, token);
  if (!user) {
    sendJson(res, 401, { error: 'UNAUTHORIZED' }, req);
    return null;
  }
  return user;
}

function userPayload(user) {
  const login = normalizeLogin(user?.login);
  const fallbackLogin = normalizeEmail(user?.email).split('@')[0] || 'user';
  return {
    id: user.id,
    login: login || fallbackLogin,
    email: normalizeEmail(user?.email),
    avatarUrl: sanitizeProfileAvatarUrl(user?.avatarUrl ?? user?.avatarDataUrl),
    firstName: sanitizeProfileName(user?.firstName, MAX_PROFILE_FIRST_NAME_LEN),
    lastName: sanitizeProfileName(user?.lastName, MAX_PROFILE_LAST_NAME_LEN),
    birthDate: sanitizeProfileBirthDate(user?.birthDate),
    role: sanitizeProfileRole(user?.role),
    city: sanitizeProfileCity(user?.city),
    about: sanitizeProfileAbout(user?.about),
  };
}

async function handleApi(req, res, pathname) {
  if (req.method === 'OPTIONS') {
    setCors(res, req);
    res.writeHead(204);
    res.end();
    return;
  }

  const mediaId = extractMediaIdFromPath(pathname);
  if (mediaId && (req.method === 'GET' || req.method === 'HEAD')) {
    const mediaPath = mediaIdToPath(mediaId);
    if (!mediaPath || !existsSync(mediaPath)) {
      sendJson(res, 404, { error: 'MEDIA_NOT_FOUND' }, req);
      return;
    }
    const stats = statSync(mediaPath);
    const ext = extname(mediaPath).toLowerCase();
    const mime = MIME_BY_EXT[ext] ?? 'application/octet-stream';
    const etag = weakEtagFromSizeMtime(stats.size, stats.mtimeMs);
    const headers = {
      'Cache-Control': 'public, max-age=31536000, immutable',
      ETag: etag,
      'Last-Modified': new Date(stats.mtimeMs).toUTCString(),
    };
    const hasIfNoneMatch = String(req?.headers?.['if-none-match'] ?? '').trim().length > 0;
    if (requestHasMatchingEtag(req, etag) || (!hasIfNoneMatch && requestNotModifiedSince(req, stats.mtimeMs))) {
      setCors(res, req);
      res.writeHead(304, headers);
      res.end();
      return;
    }
    if (req.method === 'HEAD') {
      setCors(res, req);
      res.writeHead(200, {
        'Content-Type': mime,
        'Content-Length': stats.size,
        ...headers,
      });
      res.end();
      return;
    }
    const body = readFileSync(mediaPath);
    sendBuffer(res, 200, body, mime, req, headers);
    return;
  }

  if (pathname === '/api/media/upload' && req.method === 'POST') {
    let body;
    try {
      body = await readJsonBody(req);
    } catch (err) {
      sendJson(res, 400, { error: 'BAD_JSON', message: String(err?.message ?? 'Bad JSON') }, req);
      return;
    }

    let uploadUser = null;
    let uploadPool = null;
    let uploadDb = null;
    if (DB_PROVIDER === 'mysql') {
      uploadPool = await getMysqlPool();
      uploadUser = await requireMysqlUser(req, res, uploadPool);
      if (!uploadUser) return;
    } else {
      uploadDb = await readDb();
      cleanupSessions(uploadDb);
      uploadUser = requireUser(req, res, uploadDb);
      if (!uploadUser) return;
    }

    const mime = normalizeCardImageMime(body?.mime);
    const payload = sanitizeCardImageBase64Payload(body?.dataBase64);
    if (!mime || !payload) {
      sendJson(res, 400, { error: 'INVALID_MEDIA_PAYLOAD' }, req);
      return;
    }
    if (
      applyRateLimit(req, res, {
        scope: 'media_upload',
        userId: uploadUser.id,
        limit: RATE_LIMIT_UPLOAD_MAX,
        windowMs: RATE_LIMIT_UPLOAD_WINDOW_MS,
      })
    ) {
      return;
    }

    const usage = await getUserMediaUsageSummary({
      provider: DB_PROVIDER,
      userId: uploadUser.id,
      db: uploadDb,
      pool: uploadPool,
    });
    if (usage.usedBytes + payload.bytes > usage.limitBytes) {
      sendJson(
        res,
        413,
        {
          error: 'MEDIA_QUOTA_EXCEEDED',
          limitBytes: usage.limitBytes,
          usedBytes: usage.usedBytes,
          referencedBytes: usage.referencedBytes,
          pendingBytes: usage.pendingBytes,
          requestedBytes: payload.bytes,
        },
        req
      );
      return;
    }

    const persisted = persistCardImagePayload(payload.payload, mime, {
      ownerUserId: uploadUser.id,
      ttlMs: MEDIA_GC_UPLOAD_GRACE_MS,
    });
    if (!persisted) {
      sendJson(res, 400, { error: 'INVALID_MEDIA_PAYLOAD' }, req);
      return;
    }

    const createdAtRaw = Number(body?.createdAt);
    const createdAt = Number.isFinite(createdAtRaw) ? Math.max(0, Math.trunc(createdAtRaw)) : Date.now();
    if (DB_PROVIDER === 'mysql' && uploadPool && uploadUser?.id) {
      await ensureMysqlMediaSchema(uploadPool);
      await mysqlUpsertMediaFiles(uploadPool, [
        {
          userId: String(uploadUser.id ?? '').trim(),
          mediaId: persisted.mediaId,
          mime: persisted.mime,
          size: persisted.bytes,
          createdAt,
          updatedAt: createdAt,
        },
      ]);
    }
    const image = {
      id: sanitizeText(body?.id, 128) || randomUUID(),
      fileId: persisted.mediaId,
      dataUrl: mediaPublicUrl(persisted.mediaId),
      mime: persisted.mime,
      size: persisted.bytes,
      name: sanitizeText(body?.name, MAX_CARD_IMAGE_NAME_LEN),
      createdAt,
    };

    scheduleMediaGc('upload', MEDIA_GC_UPLOAD_GRACE_MS + MEDIA_GC_DEBOUNCE_MS);
    sendJson(res, 201, { ok: true, image }, req);
    return;
  }

  const reqUrl = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
  if (await handleMysqlAuthApi(req, res, pathname)) {
    return;
  }
  if (await handleMysqlCommentsApi(req, res, pathname, reqUrl.searchParams)) {
    return;
  }
  if (await handleMysqlHistoryApi(req, res, pathname, reqUrl.searchParams)) {
    return;
  }
  if (await handleMysqlFavoritesApi(req, res, pathname, reqUrl.searchParams)) {
    return;
  }
  if (await handleMysqlBoardAndCardsApi(req, res, pathname)) {
    return;
  }

  const db = shouldUseMysqlScopedDb(pathname)
    ? await readScopedDbFromMysqlByToken(extractBearerToken(req))
    : await readDb();
  cleanupSessions(db);

  if (pathname === '/api/health' && req.method === 'GET') {
    sendJson(res, 200, { ok: true }, req);
    return;
  }

  if (pathname === '/api/auth/register' && req.method === 'POST') {
    let body;
    try {
      body = await readJsonBody(req);
    } catch (err) {
      sendJson(res, 400, { error: 'BAD_JSON', message: String(err?.message ?? 'Bad JSON') }, req);
      return;
    }

    const login = normalizeLogin(body.login);
    const email = normalizeEmail(body.email);
    const password = String(body.password ?? '');

    if (!isValidLogin(login)) {
      sendJson(
        res,
        400,
        {
          error: 'INVALID_LOGIN',
          message: 'Логин: только буквы латиницы/кириллицы, длина 2-32 символа',
        },
        req
      );
      return;
    }

    if (!isValidEmail(email)) {
      sendJson(res, 400, { error: 'INVALID_EMAIL' }, req);
      return;
    }

    if (password.length < 6) {
      sendJson(res, 400, { error: 'WEAK_PASSWORD', message: 'Минимум 6 символов' }, req);
      return;
    }

    const loginExists = db.users.some((u) => loginKey(u.login) === loginKey(login));
    if (loginExists) {
      sendJson(res, 409, { error: 'LOGIN_TAKEN' }, req);
      return;
    }

    const emailExists = db.users.some((u) => normalizeEmail(u.email) === email);
    if (emailExists) {
      sendJson(res, 409, { error: 'EMAIL_TAKEN' }, req);
      return;
    }

    const pass = createPasswordData(password);
    const user = {
      id: randomUUID(),
      login,
      email,
      passwordSalt: pass.salt,
      passwordHash: pass.hash,
      createdAt: Date.now(),
      avatarUrl: null,
      firstName: null,
      lastName: null,
      birthDate: null,
      role: null,
      city: null,
      about: null,
    };

    db.users.push(user);
    if (!db.boards[user.id]) db.boards[user.id] = defaultBoardState();

    const token = issueSession(db, user.id);
    await writeDb(db);

    sendJson(
      res,
      201,
      {
        token,
        user: userPayload(user),
      },
      req
    );
    return;
  }

  if (pathname === '/api/auth/login' && req.method === 'POST') {
    let body;
    try {
      body = await readJsonBody(req);
    } catch (err) {
      sendJson(res, 400, { error: 'BAD_JSON', message: String(err?.message ?? 'Bad JSON') }, req);
      return;
    }

    const login = normalizeLogin(body.login);
    const password = String(body.password ?? '');

    const user = db.users.find((u) => loginKey(u.login) === loginKey(login));
    if (!user) {
      sendJson(res, 401, { error: 'INVALID_CREDENTIALS' }, req);
      return;
    }

    const ok = verifyPassword(password, user.passwordSalt, user.passwordHash);
    if (!ok) {
      sendJson(res, 401, { error: 'INVALID_CREDENTIALS' }, req);
      return;
    }

    const token = issueSession(db, user.id);
    await writeDb(db);

    sendJson(
      res,
      200,
      {
        token,
        user: userPayload(user),
      },
      req
    );
    return;
  }

  if (pathname === '/api/auth/me' && req.method === 'GET') {
    const user = requireUser(req, res, db);
    if (!user) return;

    sendJson(res, 200, { user: userPayload(user) }, req);
    if (DB_PROVIDER !== 'mysql') {
      await writeDb(db);
    }
    return;
  }

  if (pathname === '/api/auth/profile' && req.method === 'GET') {
    const user = requireUser(req, res, db);
    if (!user) return;

    sendJson(res, 200, { user: userPayload(user) }, req);
    await writeDb(db);
    return;
  }

  if (pathname === '/api/auth/profile' && req.method === 'PATCH') {
    const user = requireUser(req, res, db);
    if (!user) return;

    let body;
    try {
      body = await readJsonBody(req);
    } catch (err) {
      sendJson(res, 400, { error: 'BAD_JSON', message: String(err?.message ?? 'Bad JSON') }, req);
      return;
    }

    const hasLogin = Object.prototype.hasOwnProperty.call(body ?? {}, 'login');
    const hasAvatarUrl = Object.prototype.hasOwnProperty.call(body ?? {}, 'avatarUrl');
    const hasFirstName = Object.prototype.hasOwnProperty.call(body ?? {}, 'firstName');
    const hasLastName = Object.prototype.hasOwnProperty.call(body ?? {}, 'lastName');
    const hasBirthDate = Object.prototype.hasOwnProperty.call(body ?? {}, 'birthDate');
    const hasRole = Object.prototype.hasOwnProperty.call(body ?? {}, 'role');
    const hasCity = Object.prototype.hasOwnProperty.call(body ?? {}, 'city');
    const hasAbout = Object.prototype.hasOwnProperty.call(body ?? {}, 'about');

    if (!(hasLogin || hasAvatarUrl || hasFirstName || hasLastName || hasBirthDate || hasRole || hasCity || hasAbout)) {
      sendJson(res, 200, { user: userPayload(user) }, req);
      await writeDb(db);
      return;
    }

    if (hasLogin) {
      const nextLogin = normalizeLogin(body?.login);
      if (!isValidLogin(nextLogin)) {
        sendJson(
          res,
          400,
          {
            error: 'INVALID_LOGIN',
            message: 'Логин: только буквы латиницы/кириллицы, длина 2-32 символа',
          },
          req
        );
        return;
      }
      const loginTaken = db.users.some((entry) => entry.id !== user.id && loginKey(entry.login) === loginKey(nextLogin));
      if (loginTaken) {
        sendJson(res, 409, { error: 'LOGIN_TAKEN' }, req);
        return;
      }
      user.login = nextLogin;
    }

    if (hasAvatarUrl) {
      const rawAvatar = String(body?.avatarUrl ?? '').trim();
      if (!rawAvatar) user.avatarUrl = null;
      else {
        const normalizedAvatar = sanitizeProfileAvatarUrl(rawAvatar);
        if (!normalizedAvatar) {
          sendJson(res, 400, { error: 'INVALID_PROFILE_AVATAR' }, req);
          return;
        }
        user.avatarUrl = normalizedAvatar;
      }
    }

    const nextFirstName = hasFirstName ? sanitizeProfileName(body?.firstName, MAX_PROFILE_FIRST_NAME_LEN) : null;
    const nextLastName = hasLastName ? sanitizeProfileName(body?.lastName, MAX_PROFILE_LAST_NAME_LEN) : null;
    const nextRole = hasRole ? sanitizeProfileRole(body?.role) : null;
    const nextCity = hasCity ? sanitizeProfileCity(body?.city) : null;
    const nextAbout = hasAbout ? sanitizeProfileAbout(body?.about) : null;

    if (hasFirstName && !validateProfileFirstName(nextFirstName)) {
      sendJson(res, 400, { error: 'INVALID_PROFILE_FIRST_NAME' }, req);
      return;
    }
    if (hasLastName && !validateProfileLastName(nextLastName)) {
      sendJson(res, 400, { error: 'INVALID_PROFILE_LAST_NAME' }, req);
      return;
    }
    if (hasRole && !validateProfileRole(nextRole)) {
      sendJson(res, 400, { error: 'INVALID_PROFILE_ROLE' }, req);
      return;
    }
    if (hasCity && !validateProfileCity(nextCity)) {
      sendJson(res, 400, { error: 'INVALID_PROFILE_CITY' }, req);
      return;
    }
    if (hasAbout && !validateProfileAbout(nextAbout)) {
      sendJson(res, 400, { error: 'INVALID_PROFILE_ABOUT' }, req);
      return;
    }

    if (hasFirstName) user.firstName = nextFirstName;
    if (hasLastName) user.lastName = nextLastName;
    if (hasRole) user.role = nextRole;
    if (hasCity) user.city = nextCity;
    if (hasAbout) user.about = nextAbout;
    if (hasBirthDate) {
      const rawBirthDate = String(body?.birthDate ?? '').trim();
      if (!rawBirthDate) user.birthDate = null;
      else {
        const normalizedBirthDate = sanitizeProfileBirthDate(rawBirthDate);
        if (!normalizedBirthDate) {
          sendJson(res, 400, { error: 'INVALID_PROFILE_BIRTH_DATE' }, req);
          return;
        }
        if (!isProfileBirthDateAtLeastAge(normalizedBirthDate, MIN_PROFILE_AGE_YEARS)) {
          sendJson(res, 400, { error: 'INVALID_PROFILE_BIRTH_DATE' }, req);
          return;
        }
        user.birthDate = normalizedBirthDate;
      }
    }

    await writeDb(db);
    sendJson(res, 200, { user: userPayload(user) }, req);
    return;
  }

  if (pathname === '/api/auth/logout' && req.method === 'POST') {
    const token = extractBearerToken(req);
    if (!token) {
      sendJson(res, 200, { ok: true }, req);
      return;
    }

    db.sessions = db.sessions.filter((s) => s.token !== token);
    await writeDb(db);
    sendJson(res, 200, { ok: true }, req);
    return;
  }

  if (pathname === '/api/favorites' && req.method === 'GET') {
    const user = requireUser(req, res, db);
    if (!user) return;

    const state = sanitizeBoardState(db.boards[user.id]) ?? defaultBoardState();
    if (!db.boards[user.id]) {
      db.boards[user.id] = state;
      await writeDb(db);
    }

    const limit = parsePositiveInt(reqUrl.searchParams.get('limit'), 100, 1, 500);
    const offset = parseNonNegativeInt(reqUrl.searchParams.get('offset'), 0, 1_000_000);
    const order = String(reqUrl.searchParams.get('order') ?? 'desc').trim().toLowerCase() === 'asc' ? 'asc' : 'desc';
    const statusFilter = parseFavoritesStatusFilter(reqUrl.searchParams.get('status'));
    if (!statusFilter.ok) {
      sendJson(res, 400, { error: 'INVALID_FAVORITES_STATUS' }, req);
      return;
    }

    const allFavorites = buildFavoritesEntriesFromState(state, {
      order,
      status: statusFilter.status,
    });
    const favoritesCount = allFavorites.length;
    const favorites = allFavorites.slice(offset, offset + limit);

    sendJson(
      res,
      200,
      {
        ok: true,
        favorites,
        favoritesCount,
        pagination: {
          limit,
          offset,
          returned: favorites.length,
          hasMore: offset + favorites.length < favoritesCount,
          nextOffset: offset + favorites.length < favoritesCount ? offset + favorites.length : null,
          order,
        },
        filters: {
          status: statusFilter.status,
        },
      },
      req
    );
    return;
  }
  if (pathname === '/api/favorites') {
    sendJson(res, 405, { error: 'METHOD_NOT_ALLOWED' }, req);
    return;
  }

  if (pathname === '/api/history' && req.method === 'GET') {
    const user = requireUser(req, res, db);
    if (!user) return;

    const state = sanitizeBoardState(db.boards[user.id]) ?? defaultBoardState();
    if (!db.boards[user.id]) {
      db.boards[user.id] = state;
      await writeDb(db);
    }

    const limit = parsePositiveInt(reqUrl.searchParams.get('limit'), 100, 1, 500);
    const offset = parseNonNegativeInt(reqUrl.searchParams.get('offset'), 0, 1_000_000);
    const order = String(reqUrl.searchParams.get('order') ?? 'desc').trim().toLowerCase() === 'asc' ? 'asc' : 'desc';
    const kindFilter = parseHistoryKindFilter(reqUrl.searchParams.get('kind'));
    if (!kindFilter.ok) {
      sendJson(res, 400, { error: 'INVALID_HISTORY_KIND' }, req);
      return;
    }

    const source = Array.isArray(state.history) ? state.history : [];
    const filtered = kindFilter.kind ? source.filter((entry) => sanitizeHistoryKind(entry?.kind) === kindFilter.kind) : source.slice();
    filtered.sort((a, b) => {
      const atA = Number(a?.at) || 0;
      const atB = Number(b?.at) || 0;
      if (atA !== atB) return order === 'asc' ? atA - atB : atB - atA;
      const idA = String(a?.id ?? '');
      const idB = String(b?.id ?? '');
      return order === 'asc' ? idA.localeCompare(idB) : idB.localeCompare(idA);
    });

    const historyCount = filtered.length;
    const entries = filtered.slice(offset, offset + limit);

    sendJson(
      res,
      200,
      {
        ok: true,
        entries,
        historyCount,
        pagination: {
          limit,
          offset,
          returned: entries.length,
          hasMore: offset + entries.length < historyCount,
          nextOffset: offset + entries.length < historyCount ? offset + entries.length : null,
          order,
        },
        filters: {
          kind: kindFilter.kind,
        },
      },
      req
    );
    return;
  }

  if (pathname === '/api/history' && req.method === 'DELETE') {
    const user = requireUser(req, res, db);
    if (!user) return;

    const state = sanitizeBoardState(db.boards[user.id]) ?? defaultBoardState();
    const deletedCount = Array.isArray(state.history) ? state.history.length : 0;
    state.history = [];
    db.boards[user.id] = state;
    await writeDb(db);

    sendJson(res, 200, { ok: true, deletedCount, updatedAt: Date.now() }, req);
    return;
  }

  const historyEntryId = extractHistoryEntryIdFromPath(pathname);
  if (historyEntryId && req.method === 'DELETE') {
    const user = requireUser(req, res, db);
    if (!user) return;

    const state = sanitizeBoardState(db.boards[user.id]) ?? defaultBoardState();
    const source = Array.isArray(state.history) ? state.history : [];
    const next = source.filter((entry) => String(entry?.id ?? '') !== historyEntryId);
    if (next.length === source.length) {
      sendJson(res, 404, { error: REPEATED_DELETE_ERROR_TEXT }, req);
      return;
    }
    state.history = next;
    db.boards[user.id] = state;
    await writeDb(db);

    sendJson(res, 200, { ok: true, deletedId: historyEntryId, updatedAt: Date.now() }, req);
    return;
  }

  if (pathname === '/api/board' && req.method === 'GET') {
    const user = requireUser(req, res, db);
    if (!user) return;

    const state = sanitizeBoardState(db.boards[user.id]) ?? defaultBoardState();
    if (!db.boards[user.id]) {
      db.boards[user.id] = state;
      await writeDb(db);
    }
    const etag = fileDbEtag();
    const headers = {
      'Cache-Control': 'no-cache',
      ...(etag ? { ETag: etag } : {}),
    };
    if (etag && requestHasMatchingEtag(req, etag)) {
      setCors(res, req);
      const vary = res.getHeader('Vary');
      res.writeHead(304, {
        ...headers,
        ...(vary != null ? { Vary: String(vary) } : {}),
      });
      res.end();
      return;
    }

    sendJson(res, 200, { state }, req, headers);
    return;
  }

  if (pathname === '/api/board' && req.method === 'PUT') {
    const user = requireUser(req, res, db);
    if (!user) return;
    const prevState = sanitizeBoardState(db.boards[user.id]) ?? defaultBoardState();

    let body;
    try {
      body = await readJsonBody(req);
    } catch (err) {
      sendJson(res, 400, { error: 'BAD_JSON', message: String(err?.message ?? 'Bad JSON') }, req);
      return;
    }

    const state = sanitizeBoardState(body.state);
    if (!state) {
      sendJson(res, 400, { error: 'INVALID_BOARD_STATE' }, req);
      return;
    }

    db.boards[user.id] = state;
    await writeDb(db);

    releaseMediaGcGraceForRemovedBoardState(prevState, state, 'file-board-put-detached');
    scheduleMediaGc('file-board-put');
    sendJson(res, 200, { ok: true, updatedAt: Date.now() }, req);
    return;
  }

  if (pathname === '/api/cards' && req.method === 'POST') {
    const user = requireUser(req, res, db);
    if (!user) return;

    let body;
    try {
      body = await readJsonBody(req);
    } catch (err) {
      sendJson(res, 400, { error: 'BAD_JSON', message: String(err?.message ?? 'Bad JSON') }, req);
      return;
    }

    const state = sanitizeBoardState(db.boards[user.id]) ?? defaultBoardState();
    const now = Date.now();

    const title = sanitizeText(body.title, 512);
    const description = sanitizeText(body.description, 5000);
    const images = sanitizeCardImages(body.images, { persistDataUrls: true });
    const checklist = Object.prototype.hasOwnProperty.call(body, 'checklist')
      ? sanitizeChecklist(body.checklist)
      : [];

    let urgency = 'white';
    if (Object.prototype.hasOwnProperty.call(body, 'urgency')) {
      if (!URGENCY_SET.has(body.urgency)) {
        sendJson(res, 400, { error: 'INVALID_URGENCY' }, req);
        return;
      }
      urgency = body.urgency;
    }

    let targetColumn = 'queue';
    if (Object.prototype.hasOwnProperty.call(body, 'columnId')) {
      const candidate = String(body.columnId ?? '').trim();
      if (!COLUMN_IDS.includes(candidate)) {
        sendJson(res, 400, { error: 'INVALID_COLUMN' }, req);
        return;
      }
      targetColumn = candidate;
    }

    const columnItems = state.columns[targetColumn];
    const insertIndex = Object.prototype.hasOwnProperty.call(body, 'index')
      ? clampIndex(Number(body.index), 0, columnItems.length)
      : 0;

    const cardId = nextSequentialCardId(state.cardsById);
    const card = {
      id: cardId,
      title,
      description,
      images,
      checklist,
      createdBy: sanitizeCardCreator(user.login),
      isFavorite: false,
      comments: [],
      createdAt: now,
      status: targetColumn,
      urgency,
      doingStartedAt: targetColumn === 'doing' ? now : null,
      doingTotalMs: 0,
    };

    state.cardsById[cardId] = card;
    columnItems.splice(insertIndex, 0, cardId);

    const historyEntry = {
      id: randomUUID(),
      at: now,
      text: `Карточка "${displayCardTitle(title)}" создана в "${columnTitle(targetColumn)}"`,
      cardId,
      kind: 'create',
      meta: {
        title: sanitizeText(title, 512),
        fromCol: null,
        toCol: targetColumn,
        doingDeltaMs: 0,
      },
    };
    state.history = [historyEntry, ...(state.history ?? [])].slice(0, HISTORY_MAX_PER_USER);

    db.boards[user.id] = state;
    await writeDb(db);

    sendJson(res, 201, { ok: true, card, columnId: targetColumn, index: insertIndex, updatedAt: now }, req);
    return;
  }

  if (pathname === '/api/cards/bulk/move' && req.method === 'POST') {
    const user = requireUser(req, res, db);
    if (!user) return;

    let body;
    try {
      body = await readJsonBody(req);
    } catch (err) {
      sendJson(res, 400, { error: 'BAD_JSON', message: String(err?.message ?? 'Bad JSON') }, req);
      return;
    }

    const continueOnError = body?.continueOnError === true;
    const moves = Array.isArray(body?.moves) ? body.moves : null;
    if (!moves || moves.length === 0) {
      sendJson(res, 400, { error: 'INVALID_MOVES', message: '`moves` must be a non-empty array' }, req);
      return;
    }
    if (moves.length > 200) {
      sendJson(res, 400, { error: 'TOO_MANY_OPERATIONS', message: 'Maximum 200 moves per request' }, req);
      return;
    }

    const state = sanitizeBoardState(db.boards[user.id]) ?? defaultBoardState();
    const moved = [];
    const errors = [];

    for (let i = 0; i < moves.length; i += 1) {
      const op = moves[i];
      if (!op || typeof op !== 'object') {
        if (!continueOnError) {
          sendJson(res, 400, { error: 'INVALID_MOVE_ITEM', index: i }, req);
          return;
        }
        errors.push({ index: i, error: 'INVALID_MOVE_ITEM' });
        continue;
      }

      const cardId = String(op.cardId ?? '').trim();
      if (!cardId) {
        if (!continueOnError) {
          sendJson(res, 400, { error: 'INVALID_CARD_ID', index: i }, req);
          return;
        }
        errors.push({ index: i, error: 'INVALID_CARD_ID' });
        continue;
      }

      const card = state.cardsById[cardId];
      if (!card) {
        if (!continueOnError) {
          sendJson(res, 404, { error: 'CARD_NOT_FOUND', cardId, index: i }, req);
          return;
        }
        errors.push({ index: i, error: 'CARD_NOT_FOUND', cardId });
        continue;
      }

      const toColumnId = String(op.toColumnId ?? '').trim();
      if (!COLUMN_IDS.includes(toColumnId)) {
        if (!continueOnError) {
          sendJson(res, 400, { error: 'INVALID_COLUMN', index: i }, req);
          return;
        }
        errors.push({ index: i, error: 'INVALID_COLUMN', cardId });
        continue;
      }

      const hasToIndex = Object.prototype.hasOwnProperty.call(op, 'toIndex');
      if (hasToIndex && !Number.isFinite(Number(op.toIndex))) {
        if (!continueOnError) {
          sendJson(res, 400, { error: 'INVALID_INDEX', index: i }, req);
          return;
        }
        errors.push({ index: i, error: 'INVALID_INDEX', cardId });
        continue;
      }

      const fromPos = getCardPosition(state.columns, cardId);
      const fromColumnId = fromPos.columnId;

      for (const col of COLUMN_IDS) {
        const idx = state.columns[col].indexOf(cardId);
        if (idx >= 0) state.columns[col].splice(idx, 1);
      }
      if (state.floatingById && Object.prototype.hasOwnProperty.call(state.floatingById, cardId)) {
        delete state.floatingById[cardId];
      }

      const targetItems = state.columns[toColumnId];
      const rawToIndex = hasToIndex ? Number(op.toIndex) : targetItems.length;
      const safeToIndex = clampIndex(rawToIndex, 0, targetItems.length);
      targetItems.splice(safeToIndex, 0, cardId);

      const now = Date.now();
      let doingDeltaMs = 0;
      const updatedCard = { ...card };

      if (fromColumnId === 'doing' && toColumnId !== 'doing') {
        if (updatedCard.doingStartedAt != null && Number.isFinite(updatedCard.doingStartedAt)) {
          doingDeltaMs = Math.max(0, now - Number(updatedCard.doingStartedAt));
        }
        updatedCard.doingTotalMs = Number(updatedCard.doingTotalMs || 0) + doingDeltaMs;
        updatedCard.doingStartedAt = null;
      }

      if (toColumnId === 'doing' && fromColumnId !== 'doing') {
        updatedCard.doingStartedAt = now;
      }

      if (toColumnId !== 'doing') {
        updatedCard.doingStartedAt = null;
      }

      updatedCard.status = toColumnId;
      state.cardsById[cardId] = updatedCard;

      let text = `Карточка "${displayCardTitle(updatedCard.title)}" перемещена: "${columnTitle(fromColumnId || 'queue')}" → "${columnTitle(toColumnId)}"`;
      if (toColumnId === 'doing' && fromColumnId !== 'doing') {
        text += ' (таймер запущен)';
      }
      if (fromColumnId === 'doing' && toColumnId !== 'doing') {
        text += doingDeltaMs > 0 ? ` (таймер +${formatElapsedHms(doingDeltaMs)})` : ' (таймер остановлен)';
      }

      state.history = [
        {
          id: randomUUID(),
          at: now,
          text,
          cardId,
          kind: 'move',
          meta: {
            title: sanitizeText(updatedCard.title, 512),
            fromCol: fromColumnId,
            toCol: toColumnId,
            doingDeltaMs,
          },
        },
        ...(state.history ?? []),
      ].slice(0, HISTORY_MAX_PER_USER);

      moved.push({ cardId, fromColumnId, toColumnId, toIndex: safeToIndex });
    }

    if (moved.length > 0) {
      db.boards[user.id] = state;
      await writeDb(db);
    }

    sendJson(
      res,
      200,
      {
        ok: errors.length === 0,
        partial: errors.length > 0,
        moved,
        errors,
        updatedAt: Date.now(),
      },
      req
    );
    return;
  }

  if (pathname === '/api/cards/bulk/delete' && req.method === 'POST') {
    const user = requireUser(req, res, db);
    if (!user) return;

    let body;
    try {
      body = await readJsonBody(req);
    } catch (err) {
      sendJson(res, 400, { error: 'BAD_JSON', message: String(err?.message ?? 'Bad JSON') }, req);
      return;
    }

    const continueOnError = body?.continueOnError === true;
    const rawIds = Array.isArray(body?.cardIds) ? body.cardIds : null;
    if (!rawIds || rawIds.length === 0) {
      sendJson(res, 400, { error: 'INVALID_CARD_IDS', message: '`cardIds` must be a non-empty array' }, req);
      return;
    }
    if (rawIds.length > 200) {
      sendJson(res, 400, { error: 'TOO_MANY_OPERATIONS', message: 'Maximum 200 deletes per request' }, req);
      return;
    }

    const cardIds = [];
    const seen = new Set();
    const errors = [];
    for (let i = 0; i < rawIds.length; i += 1) {
      const id = String(rawIds[i] ?? '').trim();
      if (!id) {
        if (!continueOnError) {
          sendJson(res, 400, { error: 'INVALID_CARD_ID', index: i }, req);
          return;
        }
        errors.push({ index: i, error: 'INVALID_CARD_ID' });
        continue;
      }
      if (seen.has(id)) continue;
      seen.add(id);
      cardIds.push(id);
    }

    const state = sanitizeBoardState(db.boards[user.id]) ?? defaultBoardState();

    if (!continueOnError) {
      for (let i = 0; i < cardIds.length; i += 1) {
        const id = cardIds[i];
        if (!state.cardsById[id]) {
          sendJson(res, 404, { error: 'CARD_NOT_FOUND', cardId: id, index: i }, req);
          return;
        }
      }
    }

    const deleted = [];
    for (let i = 0; i < cardIds.length; i += 1) {
      const id = cardIds[i];
      const card = state.cardsById[id];
      if (!card) {
        errors.push({ index: i, error: 'CARD_NOT_FOUND', cardId: id });
        continue;
      }

      const fromPos = getCardPosition(state.columns, id);
      const fromColumnId = fromPos.columnId;
      const now = Date.now();

      let doingDeltaMs = 0;
      if (fromColumnId === 'doing' && card.doingStartedAt != null && Number.isFinite(card.doingStartedAt)) {
        doingDeltaMs = Math.max(0, now - Number(card.doingStartedAt));
      }

      delete state.cardsById[id];
      for (const col of COLUMN_IDS) {
        const idx = state.columns[col].indexOf(id);
        if (idx >= 0) state.columns[col].splice(idx, 1);
      }
      if (state.floatingById && Object.prototype.hasOwnProperty.call(state.floatingById, id)) {
        delete state.floatingById[id];
      }

      let text = `Карточка "${displayCardTitle(card.title)}" удалена из "${columnTitle(fromColumnId || 'queue')}"`;
      if (fromColumnId === 'doing') {
        text += doingDeltaMs > 0 ? ` (таймер +${formatElapsedHms(doingDeltaMs)})` : ' (таймер остановлен)';
      }

      state.history = [
        {
          id: randomUUID(),
          at: now,
          text,
          cardId: null,
          kind: 'delete',
          meta: {
            title: sanitizeText(card.title, 512),
            fromCol: fromColumnId,
            toCol: null,
            doingDeltaMs,
          },
        },
        ...(state.history ?? []),
      ].slice(0, HISTORY_MAX_PER_USER);

      deleted.push({ cardId: id, fromColumnId });
    }

    if (deleted.length > 0) {
      db.boards[user.id] = state;
      await writeDb(db);
      scheduleMediaGc('file-bulk-delete');
    }

    sendJson(
      res,
      200,
      {
        ok: errors.length === 0,
        partial: errors.length > 0,
        deleted,
        errors,
        updatedAt: Date.now(),
      },
      req
    );
    return;
  }

  const moveCardId = extractCardMoveIdFromPath(pathname);
  if (moveCardId && (req.method === 'POST' || req.method === 'PATCH')) {
    const user = requireUser(req, res, db);
    if (!user) return;

    let body;
    try {
      body = await readJsonBody(req);
    } catch (err) {
      sendJson(res, 400, { error: 'BAD_JSON', message: String(err?.message ?? 'Bad JSON') }, req);
      return;
    }

    const state = sanitizeBoardState(db.boards[user.id]) ?? defaultBoardState();
    const card = state.cardsById[moveCardId];
    if (!card) {
      sendJson(res, 404, { error: 'CARD_NOT_FOUND' }, req);
      return;
    }

    const toColumnId = String(body?.toColumnId ?? '').trim();
    if (!COLUMN_IDS.includes(toColumnId)) {
      sendJson(res, 400, { error: 'INVALID_COLUMN' }, req);
      return;
    }

    const hasToIndex = Object.prototype.hasOwnProperty.call(body ?? {}, 'toIndex');
    if (hasToIndex && !Number.isFinite(Number(body.toIndex))) {
      sendJson(res, 400, { error: 'INVALID_INDEX' }, req);
      return;
    }

    const fromPos = getCardPosition(state.columns, moveCardId);
    const fromColumnId = fromPos.columnId;

    for (const col of COLUMN_IDS) {
      const idx = state.columns[col].indexOf(moveCardId);
      if (idx >= 0) state.columns[col].splice(idx, 1);
    }
    if (state.floatingById && Object.prototype.hasOwnProperty.call(state.floatingById, moveCardId)) {
      delete state.floatingById[moveCardId];
    }

    const targetItems = state.columns[toColumnId];
    const rawToIndex = hasToIndex ? Number(body.toIndex) : targetItems.length;
    const safeToIndex = clampIndex(rawToIndex, 0, targetItems.length);
    targetItems.splice(safeToIndex, 0, moveCardId);

    const now = Date.now();
    let doingDeltaMs = 0;
    const updatedCard = { ...card };

    if (fromColumnId === 'doing' && toColumnId !== 'doing') {
      if (updatedCard.doingStartedAt != null && Number.isFinite(updatedCard.doingStartedAt)) {
        doingDeltaMs = Math.max(0, now - Number(updatedCard.doingStartedAt));
      }
      updatedCard.doingTotalMs = Number(updatedCard.doingTotalMs || 0) + doingDeltaMs;
      updatedCard.doingStartedAt = null;
    }

    if (toColumnId === 'doing' && fromColumnId !== 'doing') {
      updatedCard.doingStartedAt = now;
    }

    if (toColumnId !== 'doing') {
      updatedCard.doingStartedAt = null;
    }

    updatedCard.status = toColumnId;
    state.cardsById[moveCardId] = updatedCard;

    let text = `Карточка "${displayCardTitle(updatedCard.title)}" перемещена: "${columnTitle(fromColumnId || 'queue')}" → "${columnTitle(toColumnId)}"`;
    if (toColumnId === 'doing' && fromColumnId !== 'doing') {
      text += ' (таймер запущен)';
    }
    if (fromColumnId === 'doing' && toColumnId !== 'doing') {
      text += doingDeltaMs > 0 ? ` (таймер +${formatElapsedHms(doingDeltaMs)})` : ' (таймер остановлен)';
    }

    const historyEntry = {
      id: randomUUID(),
      at: now,
      text,
      cardId: moveCardId,
      kind: 'move',
      meta: {
        title: sanitizeText(updatedCard.title, 512),
        fromCol: fromColumnId,
        toCol: toColumnId,
        doingDeltaMs,
      },
    };
    state.history = [historyEntry, ...(state.history ?? [])].slice(0, HISTORY_MAX_PER_USER);

    db.boards[user.id] = state;
    await writeDb(db);

    sendJson(
      res,
      200,
      {
        ok: true,
        card: updatedCard,
        fromColumnId,
        toColumnId,
        toIndex: safeToIndex,
        updatedAt: now,
      },
      req
    );
    return;
  }

  const commentsCardId = extractCardCommentsIdFromPath(pathname);
  if (commentsCardId && req.method === 'GET') {
    const user = requireUser(req, res, db);
    if (!user) return;

    const state = sanitizeBoardState(db.boards[user.id]) ?? defaultBoardState();
    const card = state.cardsById[commentsCardId];
    if (!card) {
      sendJson(res, 404, { error: 'CARD_NOT_FOUND' }, req);
      return;
    }

    const allComments = sanitizeComments(card.comments);
    const baseVersionTag = fileDbEtag() ?? 'file-comments';
    const hasPaginationRequest =
      reqUrl.searchParams.has('limit') || reqUrl.searchParams.has('offset') || reqUrl.searchParams.has('order');
    if (!hasPaginationRequest) {
      const etag = commentsPageEtag({
        cardId: commentsCardId,
        order: 'all',
        offset: 0,
        limit: Math.max(1, allComments.length),
        version: baseVersionTag,
      });
      const headers = {
        ETag: etag,
        'Cache-Control': 'private, no-cache',
      };
      if (requestHasMatchingEtag(req, etag)) {
        setCors(res, req);
        const vary = res.getHeader('Vary');
        res.writeHead(304, {
          ...headers,
          ...(vary != null ? { Vary: String(vary) } : {}),
        });
        res.end();
        return;
      }

      sendJson(
        res,
        200,
        { ok: true, cardId: commentsCardId, comments: allComments, commentsCount: allComments.length },
        req,
        headers
      );
      return;
    }

    const limit = parsePositiveInt(reqUrl.searchParams.get('limit'), MAX_COMMENTS_PER_CARD, 1, MAX_COMMENTS_PER_CARD);
    const offset = parseNonNegativeInt(reqUrl.searchParams.get('offset'), 0, 1_000_000);
    const order = String(reqUrl.searchParams.get('order') ?? 'asc').trim().toLowerCase() === 'desc' ? 'desc' : 'asc';
    const etag = commentsPageEtag({
      cardId: commentsCardId,
      order,
      offset,
      limit,
      version: baseVersionTag,
    });
    const headers = {
      ETag: etag,
      'Cache-Control': 'private, no-cache',
    };
    if (requestHasMatchingEtag(req, etag)) {
      setCors(res, req);
      const vary = res.getHeader('Vary');
      res.writeHead(304, {
        ...headers,
        ...(vary != null ? { Vary: String(vary) } : {}),
      });
      res.end();
      return;
    }
    const ordered =
      order === 'desc'
        ? allComments
            .slice()
            .sort((a, b) => (a.createdAt !== b.createdAt ? b.createdAt - a.createdAt : b.id.localeCompare(a.id)))
        : allComments;
    const comments = ordered.slice(offset, offset + limit);
    const commentsCount = allComments.length;
    sendJson(
      res,
      200,
      {
        ok: true,
        cardId: commentsCardId,
        comments,
        commentsCount,
        pagination: {
          limit,
          offset,
          returned: comments.length,
          hasMore: offset + comments.length < commentsCount,
          nextOffset: offset + comments.length < commentsCount ? offset + comments.length : null,
          order,
        },
      },
      req,
      headers
    );
    return;
  }

  if (commentsCardId && req.method === 'POST') {
    const user = requireUser(req, res, db);
    if (!user) return;
    if (
      applyRateLimit(req, res, {
        scope: 'comment_mutation',
        userId: user.id,
        limit: RATE_LIMIT_COMMENT_MUTATION_MAX,
        windowMs: RATE_LIMIT_COMMENT_MUTATION_WINDOW_MS,
      })
    ) {
      return;
    }

    let body;
    try {
      body = await readJsonBody(req);
    } catch (err) {
      sendJson(res, 400, { error: 'BAD_JSON', message: String(err?.message ?? 'Bad JSON') }, req);
      return;
    }

    const state = sanitizeBoardState(db.boards[user.id]) ?? defaultBoardState();
    const card = state.cardsById[commentsCardId];
    if (!card) {
      sendJson(res, 404, { error: 'CARD_NOT_FOUND' }, req);
      return;
    }

    const text = sanitizeCommentText(body?.text);
    const images = sanitizeCardImages(body?.images, { persistDataUrls: true });
    const hasText = !!text && !!richCommentToPlainText(text);
    if (!hasText && images.length === 0) {
      sendJson(res, 400, { error: 'INVALID_COMMENT_TEXT' }, req);
      return;
    }

    const now = Date.now();
    const comment = {
      id: randomUUID(),
      text: hasText ? text : '',
      images,
      createdAt: now,
      updatedAt: now,
      author: sanitizeCommentAuthor(user.login),
    };

    const comments = sanitizeComments((card.comments ?? []).concat(comment));
    state.cardsById[commentsCardId] = {
      ...card,
      comments,
    };

    db.boards[user.id] = state;
    await writeDb(db);

    scheduleMediaGc('file-comment-post');
    sendJson(
      res,
      201,
      {
        ok: true,
        cardId: commentsCardId,
        comment,
        commentsCount: comments.length,
        updatedAt: now,
      },
      req
    );
    return;
  }

  const commentPath = extractCardCommentPath(pathname);
  if (commentPath && req.method === 'PATCH') {
    const user = requireUser(req, res, db);
    if (!user) return;
    if (
      applyRateLimit(req, res, {
        scope: 'comment_mutation',
        userId: user.id,
        limit: RATE_LIMIT_COMMENT_MUTATION_MAX,
        windowMs: RATE_LIMIT_COMMENT_MUTATION_WINDOW_MS,
      })
    ) {
      return;
    }

    let body;
    try {
      body = await readJsonBody(req);
    } catch (err) {
      sendJson(res, 400, { error: 'BAD_JSON', message: String(err?.message ?? 'Bad JSON') }, req);
      return;
    }

    const state = sanitizeBoardState(db.boards[user.id]) ?? defaultBoardState();
    const card = state.cardsById[commentPath.cardId];
    if (!card) {
      sendJson(res, 404, { error: 'CARD_NOT_FOUND' }, req);
      return;
    }

    const text = sanitizeCommentText(body?.text);
    const comments = sanitizeComments(card.comments);
    const targetIndex = comments.findIndex((entry) => entry.id === commentPath.commentId);
    if (targetIndex < 0) {
      sendJson(res, 404, { error: 'COMMENT_NOT_FOUND' }, req);
      return;
    }
    const nextImages = Object.prototype.hasOwnProperty.call(body ?? {}, 'images')
      ? sanitizeCardImages(body?.images, { persistDataUrls: true })
      : sanitizeCardImages(comments[targetIndex].images);
    const previousImages = sanitizeCardImages(comments[targetIndex].images);
    const hasText = !!text && !!richCommentToPlainText(text);
    if (!hasText && nextImages.length === 0) {
      sendJson(res, 400, { error: 'INVALID_COMMENT_TEXT' }, req);
      return;
    }

    const actorKey = loginKey(user.login);
    const commentAuthorKey = comments[targetIndex].author ? loginKey(comments[targetIndex].author) : '';
    if (!commentAuthorKey || commentAuthorKey !== actorKey) {
      sendJson(res, 403, { error: 'COMMENT_FORBIDDEN' }, req);
      return;
    }

    const now = Date.now();
    comments[targetIndex] = {
      ...comments[targetIndex],
      text: hasText ? text : '',
      images: nextImages,
      updatedAt: now,
    };
    const nextComments = sanitizeComments(comments);
    const updatedComment = nextComments.find((entry) => entry.id === commentPath.commentId);
    if (!updatedComment) {
      sendJson(res, 500, { error: 'COMMENT_UPDATE_FAILED' }, req);
      return;
    }

    state.cardsById[commentPath.cardId] = {
      ...card,
      comments: nextComments,
    };

    db.boards[user.id] = state;
    await writeDb(db);

    releaseMediaGcGraceForRemovedImages(previousImages, nextImages, 'file-comment-patch-detached');
    scheduleMediaGc('file-comment-patch');
    sendJson(
      res,
      200,
      {
        ok: true,
        cardId: commentPath.cardId,
        comment: updatedComment,
        commentsCount: nextComments.length,
        updatedAt: now,
      },
      req
    );
    return;
  }

  if (commentPath && req.method === 'DELETE') {
    const user = requireUser(req, res, db);
    if (!user) return;
    if (
      applyRateLimit(req, res, {
        scope: 'comment_mutation',
        userId: user.id,
        limit: RATE_LIMIT_COMMENT_MUTATION_MAX,
        windowMs: RATE_LIMIT_COMMENT_MUTATION_WINDOW_MS,
      })
    ) {
      return;
    }

    const state = sanitizeBoardState(db.boards[user.id]) ?? defaultBoardState();
    const card = state.cardsById[commentPath.cardId];
    if (!card) {
      sendJson(res, 404, { error: REPEATED_DELETE_ERROR_TEXT }, req);
      return;
    }

    const comments = sanitizeComments(card.comments);
    const targetIndex = comments.findIndex((entry) => entry.id === commentPath.commentId);
    if (targetIndex < 0) {
      sendJson(res, 404, { error: REPEATED_DELETE_ERROR_TEXT }, req);
      return;
    }

    const actorKey = loginKey(user.login);
    const commentAuthorKey = comments[targetIndex].author ? loginKey(comments[targetIndex].author) : '';
    if (!commentAuthorKey || commentAuthorKey !== actorKey) {
      sendJson(res, 403, { error: 'COMMENT_FORBIDDEN' }, req);
      return;
    }
    const previousImages = sanitizeCardImages(comments[targetIndex].images);

    const nextComments = comments.filter((entry) => entry.id !== commentPath.commentId);
    state.cardsById[commentPath.cardId] = {
      ...card,
      comments: nextComments,
    };

    db.boards[user.id] = state;
    await writeDb(db);

    releaseMediaGcGraceForRemovedImages(previousImages, [], 'file-comment-delete-detached');
    scheduleMediaGc('file-comment-delete');
    sendJson(
      res,
      200,
      {
        ok: true,
        cardId: commentPath.cardId,
        commentsCount: nextComments.length,
        updatedAt: Date.now(),
      },
      req
    );
    return;
  }

  const cardId = extractCardIdFromPath(pathname);
  if (cardId && req.method === 'DELETE') {
    const user = requireUser(req, res, db);
    if (!user) return;

    const state = sanitizeBoardState(db.boards[user.id]) ?? defaultBoardState();
    const card = state.cardsById[cardId];
    if (!card) {
      sendJson(res, 404, { error: REPEATED_DELETE_ERROR_TEXT }, req);
      return;
    }
    const previousCardForMedia = {
      images: sanitizeCardImages(card.images),
      comments: sanitizeComments(card.comments, { keepInputOrder: true, enforceMax: false }),
    };

    const fromPos = getCardPosition(state.columns, cardId);
    const fromColumnId = fromPos.columnId;
    const now = Date.now();

    let doingDeltaMs = 0;
    if (fromColumnId === 'doing' && card.doingStartedAt != null && Number.isFinite(card.doingStartedAt)) {
      doingDeltaMs = Math.max(0, now - Number(card.doingStartedAt));
    }

    delete state.cardsById[cardId];
    for (const col of COLUMN_IDS) {
      const idx = state.columns[col].indexOf(cardId);
      if (idx >= 0) state.columns[col].splice(idx, 1);
    }
    if (state.floatingById && Object.prototype.hasOwnProperty.call(state.floatingById, cardId)) {
      delete state.floatingById[cardId];
    }

    let text = `Карточка "${displayCardTitle(card.title)}" удалена из "${columnTitle(fromColumnId || 'queue')}"`;
    if (fromColumnId === 'doing') {
      text += doingDeltaMs > 0 ? ` (таймер +${formatElapsedHms(doingDeltaMs)})` : ' (таймер остановлен)';
    }

    const historyEntry = {
      id: randomUUID(),
      at: now,
      text,
      cardId: null,
      kind: 'delete',
      meta: {
        title: sanitizeText(card.title, 512),
        fromCol: fromColumnId,
        toCol: null,
        doingDeltaMs,
      },
    };
    state.history = [historyEntry, ...(state.history ?? [])].slice(0, HISTORY_MAX_PER_USER);

    db.boards[user.id] = state;
    await writeDb(db);

    releaseMediaGcGraceForRemovedCard(previousCardForMedia, null, 'file-card-delete-detached');
    scheduleMediaGc('file-card-delete');
    sendJson(res, 200, { ok: true, deletedId: cardId, fromColumnId, updatedAt: now }, req);
    return;
  }

  if (cardId && req.method === 'GET') {
    const user = requireUser(req, res, db);
    if (!user) return;

    const state = sanitizeBoardState(db.boards[user.id]) ?? defaultBoardState();
    const card = state.cardsById[cardId];
    if (!card) {
      sendJson(res, 404, { error: 'CARD_NOT_FOUND' }, req);
      return;
    }

    const position = getCardPosition(state.columns, cardId);
    sendJson(res, 200, { card, ...position }, req);
    return;
  }

  if (cardId && req.method === 'PATCH') {
    const user = requireUser(req, res, db);
    if (!user) return;

    const state = sanitizeBoardState(db.boards[user.id]) ?? defaultBoardState();
    const current = state.cardsById[cardId];
    if (!current) {
      sendJson(res, 404, { error: 'CARD_NOT_FOUND' }, req);
      return;
    }

    let body;
    try {
      body = await readJsonBody(req);
    } catch (err) {
      sendJson(res, 400, { error: 'BAD_JSON', message: String(err?.message ?? 'Bad JSON') }, req);
      return;
    }

    const patch = {};

    if (Object.prototype.hasOwnProperty.call(body, 'title')) {
      patch.title = sanitizeText(body.title, 512);
    }

    if (Object.prototype.hasOwnProperty.call(body, 'description')) {
      patch.description = sanitizeText(body.description, 5000);
    }

    if (Object.prototype.hasOwnProperty.call(body, 'images')) {
      patch.images = sanitizeCardImages(body.images, { persistDataUrls: true });
    }
    if (Object.prototype.hasOwnProperty.call(body, 'checklist')) {
      patch.checklist = sanitizeChecklist(body.checklist);
    }
    const previousImages = sanitizeCardImages(current.images);

    if (Object.prototype.hasOwnProperty.call(body, 'urgency')) {
      if (!URGENCY_SET.has(body.urgency)) {
        sendJson(res, 400, { error: 'INVALID_URGENCY' }, req);
        return;
      }
      patch.urgency = body.urgency;
    }
    if (Object.prototype.hasOwnProperty.call(body, 'isFavorite')) {
      patch.isFavorite = sanitizeCardFavorite(body.isFavorite);
    }

    if (Object.keys(patch).length === 0) {
      sendJson(res, 400, { error: 'EMPTY_PATCH' }, req);
      return;
    }

    const updated = {
      ...current,
      ...patch,
      id: current.id,
      isFavorite: sanitizeCardFavorite(patch.isFavorite ?? current.isFavorite),
      checklist: sanitizeChecklist(patch.checklist ?? current.checklist),
    };
    state.cardsById[cardId] = updated;

    db.boards[user.id] = state;
    await writeDb(db);

    releaseMediaGcGraceForRemovedImages(previousImages, sanitizeCardImages(updated.images), 'file-card-patch-detached');
    scheduleMediaGc('file-card-patch');
    const position = getCardPosition(state.columns, cardId);
    sendJson(res, 200, { ok: true, card: updated, ...position, updatedAt: Date.now() }, req);
    return;
  }

  sendJson(res, 404, { error: 'NOT_FOUND' }, req);
}

function safeJoinDist(pathname) {
  const decoded = decodeURIComponent(pathname || '/');
  const target = decoded === '/' ? '/index.html' : decoded;
  const clean = normalize(target).replace(/^([.][.][/\\])+/, '');
  const abs = resolve(DIST_DIR, `.${clean}`);
  if (!abs.startsWith(resolve(DIST_DIR))) return null;
  return abs;
}

function serveStatic(req, res, pathname) {
  if (!existsSync(DIST_DIR)) {
    sendText(res, 404, 'Build not found. Run `npm run build` first.');
    return;
  }

  const filePath = safeJoinDist(pathname);
  if (filePath && existsSync(filePath)) {
    const stats = statSync(filePath);
    const ext = extname(filePath).toLowerCase();
    const mime = MIME_BY_EXT[ext] ?? 'application/octet-stream';
    const etag = weakEtagFromSizeMtime(stats.size, stats.mtimeMs);
    const cacheControl =
      ext === '.html'
        ? 'no-cache'
        : isImmutableDistAsset(filePath)
        ? 'public, max-age=31536000, immutable'
        : 'public, max-age=600';
    const headers = {
      'Content-Type': mime,
      'Cache-Control': cacheControl,
      ETag: etag,
      'Last-Modified': new Date(stats.mtimeMs).toUTCString(),
    };
    const hasIfNoneMatch = String(req?.headers?.['if-none-match'] ?? '').trim().length > 0;
    if (requestHasMatchingEtag(req, etag) || (!hasIfNoneMatch && requestNotModifiedSince(req, stats.mtimeMs))) {
      res.writeHead(304, headers);
      res.end();
      return;
    }
    if (req.method === 'HEAD') {
      res.writeHead(200, {
        ...headers,
        'Content-Length': stats.size,
      });
      res.end();
      return;
    }
    const body = readFileSync(filePath);
    res.writeHead(200, { ...headers, 'Content-Length': body.length });
    res.end(body);
    return;
  }

  const indexPath = join(DIST_DIR, 'index.html');
  if (!existsSync(indexPath)) {
    sendText(res, 404, 'index.html not found in dist');
    return;
  }

  const stats = statSync(indexPath);
  const etag = weakEtagFromSizeMtime(stats.size, stats.mtimeMs);
  const headers = {
    'Content-Type': 'text/html; charset=utf-8',
    'Cache-Control': 'no-cache',
    ETag: etag,
    'Last-Modified': new Date(stats.mtimeMs).toUTCString(),
  };
  const hasIfNoneMatch = String(req?.headers?.['if-none-match'] ?? '').trim().length > 0;
  if (requestHasMatchingEtag(req, etag) || (!hasIfNoneMatch && requestNotModifiedSince(req, stats.mtimeMs))) {
    res.writeHead(304, headers);
    res.end();
    return;
  }
  if (req.method === 'HEAD') {
    res.writeHead(200, {
      ...headers,
      'Content-Length': stats.size,
    });
    res.end();
    return;
  }
  const body = readFileSync(indexPath);
  res.writeHead(200, { ...headers, 'Content-Length': body.length });
  res.end(body);
}

async function handleRequest(req, res) {
  const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
  const pathname = url.pathname;

  if (pathname.startsWith('/api/')) {
    await handleApi(req, res, pathname);
    return;
  }

  if (req.method !== 'GET' && req.method !== 'HEAD') {
    sendText(res, 405, 'Method Not Allowed');
    return;
  }

  serveStatic(req, res, pathname);
}

const server = createServer((req, res) => {
  handleRequest(req, res).catch((err) => {
    console.error('[server] unhandled error', err);
    sendJson(res, 500, { error: 'INTERNAL_ERROR' }, req);
  });
});

server.listen(PORT, '0.0.0.0', () => {
  const target = DB_PROVIDER === 'mysql' ? `mysql (${MYSQL_URL})` : `file (${DB_FILE})`;
  console.log(`[server] API listening on http://127.0.0.1:${PORT} | db: ${target}`);
  scheduleMediaGc('startup', 2500);
  const periodicGc = setInterval(() => {
    scheduleMediaGc('periodic', 0);
  }, MEDIA_GC_INTERVAL_MS);
  periodicGc.unref?.();
});
