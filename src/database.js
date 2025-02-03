const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const { promisify } = require('util');

// Create database connection
const db = new sqlite3.Database(path.join(__dirname, '..', 'standup.db'));

// Promisify database operations
const dbRun = promisify(db.run.bind(db));
const dbAll = promisify(db.all.bind(db));
const dbGet = promisify(db.get.bind(db));

// Get admin usernames from environment
const ADMIN_USERNAMES = (process.env.ADMIN_USERNAMES || '')
  .split(',')
  .map((username) => username.trim());

// Initialize database tables
async function initializeDatabase() {
  // Create subscriptions table with timezone
  await dbRun(`
    CREATE TABLE IF NOT EXISTS subscriptions (
      user_id INTEGER PRIMARY KEY,
      username TEXT NOT NULL,
      timezone TEXT DEFAULT 'Europe/Lisbon',
      is_on_vacation BOOLEAN DEFAULT 0,
      vacation_until DATE,
      subscribed_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
  `);

  // Create standups table with submission_date column
  await dbRun(`
    CREATE TABLE IF NOT EXISTS standups (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      username TEXT NOT NULL,
      yesterday TEXT NOT NULL,
      today TEXT NOT NULL,
      blockers TEXT,
      submitted_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (user_id) REFERENCES subscriptions(user_id)
    )
  `);

  // Create settings table
  await dbRun(`
    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    )
  `);

  // Create late reminders table
  await dbRun(`
    CREATE TABLE IF NOT EXISTS late_reminders (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      sent_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (user_id) REFERENCES subscriptions(user_id)
    )
  `);

  // Initialize default settings if they don't exist
  await dbRun(`
    INSERT OR IGNORE INTO settings (key, value)
    VALUES
      ('standup_hour', '9'),
      ('standup_minute', '0'),
      ('late_reminder_enabled', '1'),
      ('late_reminder_hours', '4')
  `);
}

// Initialize database on module load
initializeDatabase().catch(console.error);

// Add method to get subscriber by username
async function getSubscriberByUsername(username) {
  return dbGet('SELECT * FROM subscriptions WHERE username = ?', [username]);
}

module.exports = {
  initializeDatabase,
  getSubscriberByUsername,

  // Subscription methods
  addSubscriber: async (userId, username) => {
    return dbRun(
      'INSERT OR REPLACE INTO subscriptions (user_id, username) VALUES (?, ?)',
      [userId, username]
    );
  },

  removeSubscriber: async (userId) => {
    return dbRun('DELETE FROM subscriptions WHERE user_id = ?', [userId]);
  },

  isSubscribed: async (userId) => {
    const result = await dbGet(
      'SELECT COUNT(*) as count FROM subscriptions WHERE user_id = ?',
      [userId]
    );
    return result.count > 0;
  },

  getAllSubscribers: async () => {
    return dbAll('SELECT * FROM subscriptions ORDER BY username');
  },

  // Standup methods
  addStandup: async (userId, username, yesterday, today, blockers) => {
    const today_start = new Date();
    today_start.setHours(0, 0, 0, 0);
    const today_end = new Date();
    today_end.setHours(23, 59, 59, 999);

    // First, delete any existing standup for this user today
    await dbRun(
      `DELETE FROM standups
       WHERE user_id = ?
       AND datetime(submitted_at) BETWEEN datetime(?) AND datetime(?)`,
      [userId, today_start.toISOString(), today_end.toISOString()]
    );

    // Then insert the new standup with explicit timestamp
    return dbRun(
      `INSERT INTO standups (user_id, username, yesterday, today, blockers, submitted_at)
       VALUES (?, ?, ?, ?, ?, datetime('now', 'localtime'))`,
      [userId, username, yesterday, today, blockers]
    );
  },

  getTodayStandups: async () => {
    return dbAll(
      `SELECT * FROM standups
       WHERE date(submitted_at, 'localtime') = date('now', 'localtime')
       ORDER BY submitted_at DESC`
    );
  },

  getUserTodayStandup: async (username) => {
    return dbGet(
      `SELECT * FROM standups
       WHERE username = ?
       AND date(submitted_at, 'localtime') = date('now', 'localtime')
       ORDER BY submitted_at DESC
       LIMIT 1`,
      [username]
    );
  },

  // Maintenance
  cleanupOldStandups: async () => {
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - 7);

    return dbRun(
      `DELETE FROM standups
       WHERE submitted_at < ?`,
      [cutoff.toISOString()]
    );
  },

  // Close database connection
  close: () => {
    return new Promise((resolve, reject) => {
      db.close((err) => {
        if (err) reject(err);
        else resolve();
      });
    });
  },

  setVacationMode: async (userId, endDate) => {
    return dbRun(
      `UPDATE subscriptions
       SET is_on_vacation = 1, vacation_until = ?
       WHERE user_id = ?`,
      [endDate, userId]
    );
  },

  disableVacationMode: async (userId) => {
    return dbRun(
      `UPDATE subscriptions
       SET is_on_vacation = 0, vacation_until = NULL
       WHERE user_id = ?`,
      [userId]
    );
  },

  getActiveSubscribers: async () => {
    return dbAll(
      `SELECT * FROM subscriptions
       WHERE is_on_vacation = 0
       OR (is_on_vacation = 1 AND vacation_until < date('now', 'localtime'))
       ORDER BY username`
    );
  },

  getVacationStatus: async (userId) => {
    return dbGet(
      `SELECT is_on_vacation, vacation_until
       FROM subscriptions
       WHERE user_id = ?`,
      [userId]
    );
  },

  isAdmin: async (userId) => {
    const user = await dbGet(
      'SELECT username FROM subscriptions WHERE user_id = ?',
      [userId]
    );
    return user && ADMIN_USERNAMES.includes(user.username);
  },

  getStandupTime: async () => {
    const [hourResult, minuteResult] = await Promise.all([
      dbGet('SELECT value FROM settings WHERE key = ?', ['standup_hour']),
      dbGet('SELECT value FROM settings WHERE key = ?', ['standup_minute']),
    ]);
    return {
      hour: parseInt(hourResult?.value || '9', 10),
      minute: parseInt(minuteResult?.value || '0', 10),
    };
  },

  setStandupTime: async (hour, minute) => {
    await dbRun('UPDATE settings SET value = ? WHERE key = ?', [
      hour.toString(),
      'standup_hour',
    ]);
    await dbRun('UPDATE settings SET value = ? WHERE key = ?', [
      minute.toString(),
      'standup_minute',
    ]);
  },

  setUserTimezone: async (userId, timezone) => {
    return dbRun('UPDATE subscriptions SET timezone = ? WHERE user_id = ?', [
      timezone,
      userId,
    ]);
  },

  getUserTimezone: async (userId) => {
    const result = await dbGet(
      'SELECT timezone FROM subscriptions WHERE user_id = ?',
      [userId]
    );
    return result?.timezone || 'Europe/Lisbon';
  },

  getStandupStatus: async () => {
    // Get all subscribers
    const subscribers = await dbAll(
      'SELECT * FROM subscriptions ORDER BY username'
    );

    // Get today's standups using SQLite's date functions
    const todayStandups = await dbAll(
      `SELECT * FROM standups
       WHERE date(submitted_at, 'localtime') = date('now', 'localtime')
       ORDER BY submitted_at DESC`
    );

    const standupMap = new Map(todayStandups.map((s) => [s.user_id, s]));

    return subscribers.map((sub) => ({
      username: sub.username,
      hasSubmitted: standupMap.has(sub.user_id),
      isOnVacation: sub.is_on_vacation,
      vacationUntil: sub.vacation_until,
      submittedAt: standupMap.get(sub.user_id)?.submitted_at,
    }));
  },

  getStandupSummary: async (startDate, endDate) => {
    return dbAll(
      `SELECT s.*
       FROM standups s
       WHERE date(s.submitted_at) BETWEEN date(?) AND date(?)
       ORDER BY s.submitted_at DESC`,
      [startDate, endDate]
    );
  },

  getLateReminderSettings: async () => {
    const [enabledResult, hoursResult] = await Promise.all([
      dbGet('SELECT value FROM settings WHERE key = ?', [
        'late_reminder_enabled',
      ]),
      dbGet('SELECT value FROM settings WHERE key = ?', [
        'late_reminder_hours',
      ]),
    ]);
    return {
      enabled: enabledResult?.value === '1',
      hours: parseInt(hoursResult?.value || '4', 10),
    };
  },

  setLateReminderEnabled: async (enabled) => {
    return dbRun('UPDATE settings SET value = ? WHERE key = ?', [
      enabled ? '1' : '0',
      'late_reminder_enabled',
    ]);
  },

  setLateReminderHours: async (hours) => {
    return dbRun('UPDATE settings SET value = ? WHERE key = ?', [
      hours.toString(),
      'late_reminder_hours',
    ]);
  },

  hasReceivedLateReminderToday: async (userId) => {
    const result = await dbGet(
      `SELECT COUNT(*) as count
       FROM late_reminders
       WHERE user_id = ?
       AND date(sent_at, 'localtime') = date('now', 'localtime')`,
      [userId]
    );
    return result.count > 0;
  },

  recordLateReminder: async (userId) => {
    return dbRun('INSERT INTO late_reminders (user_id) VALUES (?)', [userId]);
  },

  cleanupOldLateReminders: async () => {
    return dbRun(
      `DELETE FROM late_reminders
       WHERE date(sent_at, 'localtime') < date('now', 'localtime')`
    );
  },
};
