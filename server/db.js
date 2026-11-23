// Persistence layer on Node's built-in SQLite (no native build step needed).
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { randomBytes } from 'node:crypto';
import { DEFAULT_RATING, PROVISIONAL_RD } from './glicko2.js';

const SESSION_TTL_MS = 30 * 24 * 3600 * 1000;

export function openDatabase(file) {
  if (file !== ':memory:') mkdirSync(dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA foreign_keys = ON;
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT NOT NULL UNIQUE COLLATE NOCASE,
      password_hash TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS sessions (
      token TEXT PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      created_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS ratings (
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      category TEXT NOT NULL,
      rating REAL NOT NULL,
      rd REAL NOT NULL,
      vol REAL NOT NULL,
      games INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (user_id, category)
    );
    CREATE TABLE IF NOT EXISTS games (
      id TEXT PRIMARY KEY,
      white_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
      black_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
      white_name TEXT NOT NULL,
      black_name TEXT NOT NULL,
      white_rating INTEGER,
      black_rating INTEGER,
      white_diff INTEGER,
      black_diff INTEGER,
      rated INTEGER NOT NULL,
      minutes REAL NOT NULL,
      increment INTEGER NOT NULL,
      category TEXT NOT NULL,
      moves TEXT NOT NULL,
      status TEXT NOT NULL,
      winner TEXT,
      final_fen TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      ended_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS games_white ON games(white_id, ended_at DESC);
    CREATE INDEX IF NOT EXISTS games_black ON games(black_id, ended_at DESC);
    CREATE INDEX IF NOT EXISTS games_ended ON games(ended_at DESC);
  `);

  const stmt = {
    insertUser: db.prepare('INSERT INTO users (username, password_hash, created_at) VALUES (?, ?, ?)'),
    userByName: db.prepare('SELECT * FROM users WHERE username = ?'),
    userById: db.prepare('SELECT * FROM users WHERE id = ?'),
    insertSession: db.prepare('INSERT INTO sessions (token, user_id, created_at) VALUES (?, ?, ?)'),
    sessionUser: db.prepare(
      'SELECT u.* FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token = ? AND s.created_at > ?',
    ),
    deleteSession: db.prepare('DELETE FROM sessions WHERE token = ?'),
    purgeSessions: db.prepare('DELETE FROM sessions WHERE created_at <= ?'),
    getRating: db.prepare('SELECT rating, rd, vol, games FROM ratings WHERE user_id = ? AND category = ?'),
    allRatings: db.prepare('SELECT category, rating, rd, vol, games FROM ratings WHERE user_id = ?'),
    upsertRating: db.prepare(`
      INSERT INTO ratings (user_id, category, rating, rd, vol, games) VALUES (?, ?, ?, ?, ?, 1)
      ON CONFLICT(user_id, category) DO UPDATE SET
        rating = excluded.rating, rd = excluded.rd, vol = excluded.vol, games = ratings.games + 1
    `),
    insertGame: db.prepare(`
      INSERT INTO games (id, white_id, black_id, white_name, black_name, white_rating, black_rating,
        white_diff, black_diff, rated, minutes, increment, category, moves, status, winner, final_fen,
        created_at, ended_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `),
    gameById: db.prepare('SELECT * FROM games WHERE id = ?'),
    userGames: db.prepare(`
      SELECT * FROM games WHERE white_id = ? OR black_id = ?
      ORDER BY ended_at DESC LIMIT ? OFFSET ?
    `),
    recentGames: db.prepare("SELECT * FROM games WHERE status != 'aborted' ORDER BY ended_at DESC LIMIT ?"),
    userStats: db.prepare(`
      SELECT
        COUNT(*) AS total,
        SUM(CASE WHEN (winner = 'w' AND white_id = ?1) OR (winner = 'b' AND black_id = ?1) THEN 1 ELSE 0 END) AS wins,
        SUM(CASE WHEN (winner = 'b' AND white_id = ?1) OR (winner = 'w' AND black_id = ?1) THEN 1 ELSE 0 END) AS losses,
        SUM(CASE WHEN winner IS NULL AND status != 'aborted' THEN 1 ELSE 0 END) AS draws
      FROM games WHERE (white_id = ?1 OR black_id = ?1)
    `),
    leaderboard: db.prepare(`
      SELECT u.username, r.rating, r.rd, r.games FROM ratings r JOIN users u ON u.id = r.user_id
      WHERE r.category = ? AND r.games > 0
      ORDER BY (r.rd > ${PROVISIONAL_RD}) ASC, r.rating DESC LIMIT ?
    `),
    countUsers: db.prepare('SELECT COUNT(*) AS n FROM users'),
    countGames: db.prepare("SELECT COUNT(*) AS n FROM games WHERE status != 'aborted'"),
  };

  return {
    raw: db,
    close: () => db.close(),

    createUser(username, passwordHash) {
      const info = stmt.insertUser.run(username, passwordHash, Date.now());
      return Number(info.lastInsertRowid);
    },
    userByName: (name) => stmt.userByName.get(name),
    userById: (id) => stmt.userById.get(id),

    createSession(userId) {
      const token = randomBytes(32).toString('base64url');
      stmt.insertSession.run(token, userId, Date.now());
      return token;
    },
    sessionUser: (token) => (token ? stmt.sessionUser.get(token, Date.now() - SESSION_TTL_MS) : undefined),
    deleteSession: (token) => stmt.deleteSession.run(token),
    purgeSessions: () => stmt.purgeSessions.run(Date.now() - SESSION_TTL_MS),

    getRating(userId, category) {
      return stmt.getRating.get(userId, category) ?? { ...DEFAULT_RATING, games: 0 };
    },
    allRatings(userId) {
      const out = {};
      for (const row of stmt.allRatings.all(userId)) out[row.category] = row;
      return out;
    },
    setRating(userId, category, { rating, rd, vol }) {
      stmt.upsertRating.run(userId, category, rating, rd, vol);
    },

    saveGame(g) {
      stmt.insertGame.run(
        g.id, g.whiteId, g.blackId, g.whiteName, g.blackName, g.whiteRating, g.blackRating,
        g.whiteDiff, g.blackDiff, g.rated ? 1 : 0, g.minutes, g.increment, g.category,
        g.moves, g.status, g.winner, g.finalFen, g.createdAt, g.endedAt,
      );
    },
    gameById: (id) => stmt.gameById.get(id),
    userGames: (userId, limit, offset) => stmt.userGames.all(userId, userId, limit, offset),
    recentGames: (limit) => stmt.recentGames.all(limit),
    userStats(userId) {
      const r = stmt.userStats.get(userId);
      return { total: r.total ?? 0, wins: r.wins ?? 0, losses: r.losses ?? 0, draws: r.draws ?? 0 };
    },
    leaderboard: (category, limit) => stmt.leaderboard.all(category, limit),
    counts: () => ({ users: stmt.countUsers.get().n, games: stmt.countGames.get().n }),

    /** Run fn inside a transaction. */
    transaction(fn) {
      db.exec('BEGIN');
      try {
        const result = fn();
        db.exec('COMMIT');
        return result;
      } catch (err) {
        db.exec('ROLLBACK');
        throw err;
      }
    },
  };
}
