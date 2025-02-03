require('dotenv').config();
const TelegramBot = require('node-telegram-bot-api');
const schedule = require('node-schedule');
const db = require('./database');

// Initialize the bot with your token
const bot = new TelegramBot(process.env.TELEGRAM_BOT_TOKEN, { polling: true });

// Store user states (this stays in memory as it's temporary)
const userStates = new Map();

// Questions for the standup
const QUESTIONS = [
  'What did you work on yesterday? (press /skip if Monday)',
  'What will you work on today?',
  'Are there any blockers or impediments? (optional - press /skip if none)',
];

// Store standup responses (temporary, during the Q&A session)
const standupResponses = new Map();

// Update command regex patterns to support bot username suffix and improve validation
const botCommands = {
  start: /^\/start(?:@\w+)?$/,
  subscribe: /^\/subscribe(?:@\w+)?$/,
  unsubscribe: /^\/unsubscribe(?:@\w+)?$/,
  members: /^\/members(?:@\w+)?$/,
  replay: /^\/replay(?:@\w+)?$/,
  standup: /^\/standup(?:@\w+)?$/,
  skip: /^\/skip(?:@\w+)?$/,
  vacation: /^\/vacation(?:@\w+)?$/,
  // Strict date format dd/mm/yyyy, with bot username before or after
  vacationDate:
    /^\/vacation(?:@\w+)?\s+(\d{2}\/\d{2}\/\d{4})|^\/vacation\s+(\d{2}\/\d{2}\/\d{4})(?:@\w+)?$/,
  back: /^\/back(?:@\w+)?$/,
  // Time format HH:mm or HH, with bot username before or after
  setTime:
    /^\/set_time(?:@\w+)?\s+(\d{1,2}(?::\d{2})?)|^\/set_time\s+(\d{1,2}(?::\d{2})?)(?:@\w+)?$/,
  timezone: /^\/timezone(?:@\w+)?$/,
  // Timezone format Region/City, with bot username before or after
  timezoneSet:
    /^\/timezone(?:@\w+)?\s+([A-Za-z_]+\/[A-Za-z_]+)|^\/timezone\s+([A-Za-z_]+\/[A-Za-z_]+)(?:@\w+)?$/,
  // Late reminder on/off, with bot username before or after
  lateReminder:
    /^\/late_reminder(?:@\w+)?\s+(on|off)|^\/late_reminder\s+(on|off)(?:@\w+)?$/,
  // Late reminder hours (1-12), with bot username before or after
  lateReminderHours:
    /^\/late_reminder_hours(?:@\w+)?\s+(\d{1,2})|^\/late_reminder_hours\s+(\d{1,2})(?:@\w+)?$/,
  status: /^\/status(?:@\w+)?$/,
  // Summary with optional days parameter, with bot username before or after
  summary: /^\/summary(?:@\w+)?(?:\s+(\d+))?|^\/summary(?:\s+(\d+))?(?:@\w+)?$/,
};

/**
 * Initialize the bot and required services
 */
async function initialize() {
  try {
    // Initialize database first
    await db.initializeDatabase();

    // Verify channel access
    await verifyChannelAccess();

    // Schedule standups
    await scheduleStandups();

    console.log('Standup bot is running...');
  } catch (error) {
    console.error('Failed to initialize bot:', error);
    process.exit(1);
  }
}

// Start the bot
initialize().catch(console.error);

/**
 * Check if user is a member of the correct channel
 */
async function isChannelMember(userId) {
  try {
    const channelId = process.env.TELEGRAM_CHANNEL_ID;

    // First check if this is even the right channel
    if (!channelId) {
      console.error('TELEGRAM_CHANNEL_ID not set in environment variables');
      return false;
    }

    // Get bot's own info to check if it's in the channel
    const botInfo = await bot.getMe();
    try {
      const botMember = await bot.getChatMember(channelId, botInfo.id);
      if (!['administrator', 'member'].includes(botMember.status)) {
        console.error('Bot is not a member or admin of the specified channel');
        return false;
      }
    } catch (error) {
      console.error('Bot is not in the specified channel:', error.message);
      return false;
    }

    // Check user's membership
    const member = await bot.getChatMember(channelId, userId);
    return ['creator', 'administrator', 'member'].includes(member.status);
  } catch (error) {
    console.error('Error checking channel membership:', error);
    return false;
  }
}

/**
 * Guard middleware for commands
 */
async function commandGuard(msg, handler) {
  const userId = msg.from.id;
  const chatId = msg.chat.id;

  if (!(await isChannelMember(userId))) {
    bot.sendMessage(
      chatId,
      '⚠️ This bot is configured for a specific channel only. ' +
        'Please make sure you are a member of the correct channel.'
    );
    return false;
  }

  return handler(msg);
}

/**
 * Start command handler
 */
bot.onText(botCommands.start, (msg) =>
  commandGuard(msg, async (msg) => {
    const chatId = msg.chat.id;
    const userId = msg.from.id;
    const isAdmin = await db.isAdmin(userId);

    let message =
      '👋 Welcome to the Daily Standup Bot!\n\n' +
      '📋 Available commands:\n' +
      '• /subscribe - Start receiving daily standup questions\n' +
      '• /unsubscribe - Stop receiving daily standup questions\n' +
      '• /standup - Start a standup session now\n' +
      '• /replay - Show all standups submitted today\n' +
      '• /vacation dd/mm/yyyy - Set vacation mode until date\n' +
      '• /back - Return from vacation\n' +
      '• /members - List all subscribed members\n' +
      '• /timezone - Set your timezone\n' +
      "• /status - Show today's standup status\n" +
      '• /summary [days] - Show standup summary\n' +
      '• /skip - Skip the blockers question (only during standup)';

    if (isAdmin) {
      message +=
        '\n\n👑 Admin commands:\n' +
        '• /set_time HH:mm - Set daily standup time (24h format)\n' +
        '• /late_reminder on|off - Enable/disable late reminders\n' +
        '• /late_reminder_hours N - Set hours to wait before late reminder (1-12)';
    }

    bot.sendMessage(chatId, message);
  })
);

/**
 * Subscribe command handler
 */
bot.onText(botCommands.subscribe, (msg) =>
  commandGuard(msg, async (msg) => {
    const userId = msg.from.id;
    const username = msg.from.username || msg.from.first_name;

    try {
      if (await db.isSubscribed(userId)) {
        bot.sendMessage(
          msg.chat.id,
          '⚠️ You are already subscribed to daily standups!'
        );
        return;
      }

      await db.addSubscriber(userId, username);
      bot.sendMessage(
        msg.chat.id,
        '✅ You are now subscribed to daily standups!\n' +
          'You will receive questions at 9 AM Lisbon time (Monday-Friday).\n\n' +
          '💡 Tip: Use /standup to do a standup right now.'
      );
    } catch (error) {
      console.error('Error in subscribe handler:', error);
      bot.sendMessage(
        msg.chat.id,
        '❌ Sorry, there was an error processing your subscription. Please try again later.'
      );
    }
  })
);

/**
 * Unsubscribe command handler
 */
bot.onText(botCommands.unsubscribe, (msg) =>
  commandGuard(msg, async (msg) => {
    const userId = msg.from.id;

    try {
      if (!(await db.isSubscribed(userId))) {
        bot.sendMessage(
          msg.chat.id,
          'You are not subscribed to daily standups.'
        );
        return;
      }

      await db.removeSubscriber(userId);
      bot.sendMessage(
        msg.chat.id,
        'You have been unsubscribed from daily standups.'
      );
    } catch (error) {
      console.error('Error in unsubscribe handler:', error);
      bot.sendMessage(
        msg.chat.id,
        'Sorry, there was an error processing your unsubscription. Please try again later.'
      );
    }
  })
);

/**
 * List subscribed members command handler
 */
bot.onText(botCommands.members, (msg) =>
  commandGuard(msg, async (msg) => {
    try {
      const subscribers = await db.getAllSubscribers();

      if (subscribers.length === 0) {
        bot.sendMessage(msg.chat.id, '👥 No members are currently subscribed.');
        return;
      }

      const membersList =
        '👥 Subscribed Members:\n\n' +
        subscribers.map((sub) => `• @${sub.username}`).join('\n');

      bot.sendMessage(msg.chat.id, membersList);
    } catch (error) {
      console.error('Error in members handler:', error);
      bot.sendMessage(
        msg.chat.id,
        '❌ Sorry, there was an error retrieving the member list. Please try again later.'
      );
    }
  })
);

/**
 * Replay today's standups command handler
 */
bot.onText(botCommands.replay, (msg) =>
  commandGuard(msg, async (msg) => {
    try {
      const todayStandups = await db.getTodayStandups();

      if (todayStandups.length === 0) {
        bot.sendMessage(
          msg.chat.id,
          '📭 No standups have been submitted today.'
        );
        return;
      }

      const replayMessage =
        "📋 *Today's Standups:*\n\n" +
        todayStandups
          .map((standup) => {
            const submittedAt = new Date(standup.submitted_at);
            const timestamp = submittedAt.toLocaleString('en-GB', {
              timeZone: 'Europe/Lisbon',
              dateStyle: 'medium',
              timeStyle: 'short',
            });

            let message =
              `📊 *Daily Standup - @${standup.username}*\n\n` +
              `⏪ *Yesterday:*\n${standup.yesterday}\n\n` +
              `⏩ *Today:*\n${standup.today}`;

            if (standup.blockers && standup.blockers.trim()) {
              message += `\n\n🚧 *Blockers:*\n${standup.blockers}`;
            }

            message += `\n\n🕐 *Submitted:* ${timestamp}`;

            return message;
          })
          .join('\n\n──────────────\n\n');

      bot.sendMessage(msg.chat.id, replayMessage, { parse_mode: 'Markdown' });
    } catch (error) {
      console.error('Error in replay handler:', error);
      bot.sendMessage(
        msg.chat.id,
        "❌ Sorry, there was an error retrieving today's standups. Please try again later."
      );
    }
  })
);

/**
 * Manual standup trigger for testing
 */
bot.onText(botCommands.standup, (msg) =>
  commandGuard(msg, async (msg) => {
    const userId = msg.from.id;
    const chatId = msg.chat.id;

    try {
      if (userStates.has(userId)) {
        bot.sendMessage(
          chatId,
          'You already have an ongoing standup session. Please complete it first.'
        );
        return;
      }

      if (!(await db.isSubscribed(userId))) {
        bot.sendMessage(
          chatId,
          'You need to /subscribe first before you can submit standups.'
        );
        return;
      }

      startUserStandup(userId);
    } catch (error) {
      console.error('Error in standup handler:', error);
      bot.sendMessage(
        chatId,
        'Sorry, there was an error starting your standup. Please try again later.'
      );
    }
  })
);

/**
 * Handle user responses
 */
bot.on('message', async (msg) => {
  const userId = msg.from.id;
  const chatId = msg.chat.id;

  // Ignore commands
  if (msg.text?.startsWith('/')) return;

  // Check channel membership
  if (!(await isChannelMember(userId))) {
    return;
  }

  // Check if user is in the middle of a standup
  if (userStates.has(userId)) {
    try {
      const state = userStates.get(userId);
      const response = standupResponses.get(userId) || {
        username: msg.from.username || msg.from.first_name,
        answers: [],
      };

      // Save the answer
      response.answers[state.currentQuestion] = msg.text;
      standupResponses.set(userId, response);

      // Move to next question or finish
      if (state.currentQuestion < QUESTIONS.length - 1) {
        state.currentQuestion++;
        bot.sendMessage(chatId, QUESTIONS[state.currentQuestion]);
      } else {
        // Standup complete
        userStates.delete(userId);

        // Save to database
        await db.addStandup(
          userId,
          response.username,
          response.answers[0],
          response.answers[1],
          response.answers[2]
        );

        // Format response for channel
        const formattedResponse = formatStandupResponse(response);

        // Send to channel
        bot.sendMessage(process.env.TELEGRAM_CHANNEL_ID, formattedResponse, {
          parse_mode: 'Markdown',
        });

        // Confirm to user
        bot.sendMessage(chatId, 'Thank you! Your standup has been submitted.');

        // Clear the temporary response
        standupResponses.delete(userId);
      }
    } catch (error) {
      console.error('Error processing standup response:', error);
      bot.sendMessage(
        chatId,
        'Sorry, there was an error processing your response. Please try again later.'
      );
      userStates.delete(userId);
      standupResponses.delete(userId);
    }
  }
});

/**
 * Format standup response for channel posting
 */
function formatStandupResponse(response) {
  const now = new Date();
  const timestamp = now.toLocaleString('en-GB', {
    timeZone: 'Europe/Lisbon',
    dateStyle: 'medium',
    timeStyle: 'short',
  });

  let message = `📊 *Daily Standup - @${response.username}*\n\n`;

  // Only add yesterday section if it's not empty (not skipped)
  if (response.answers[0] && response.answers[0].trim()) {
    message += `⏪ *Yesterday:*\n${response.answers[0]}\n\n`;
  }

  message += `⏩ *Today:*\n${response.answers[1]}`;

  // Only add blockers section if there are blockers
  if (response.answers[2] && response.answers[2].trim()) {
    message += `\n\n🚧 *Blockers:*\n${response.answers[2]}`;
  }

  // Add timestamp at the end
  message += `\n\n🕐 *Submitted:* ${timestamp}`;

  return message;
}

/**
 * Start daily standup for a user
 */
function startUserStandup(userId) {
  const user = bot.getChat(userId);
  user
    .then((chat) => {
      userStates.set(userId, { currentQuestion: 0 });
      bot.sendMessage(chat.id, '📋 Starting your daily standup...').then(() => {
        bot.sendMessage(chat.id, QUESTIONS[0]);
      });
    })
    .catch((error) => {
      console.error(`Failed to start standup for user ${userId}:`, error);
    });
}

/**
 * Clean up old standups weekly
 */
schedule.scheduleJob('0 0 * * 0', () => {
  console.log('Cleaning up old standups...');
  db.cleanupOldStandups();
});

/**
 * Send reminder to a specific user
 */
async function sendReminder(userId, isLateReminder = false) {
  try {
    const chat = await bot.getChat(userId);
    const message = isLateReminder
      ? "⚠️ *Reminder:* You haven't submitted your standup today yet!\n" +
        'Use /standup to start your daily standup.'
      : '⏰ Time for your daily standup!\n' +
        'Use /standup to start when you are ready.';

    bot.sendMessage(chat.id, message, { parse_mode: 'Markdown' });
  } catch (error) {
    console.error(`Failed to send reminder to user ${userId}:`, error);
  }
}

/**
 * Schedule late reminders for users who haven't submitted standup
 */
async function scheduleLateReminders(hour, minute) {
  try {
    // Get late reminder settings
    const settings = await db.getLateReminderSettings();

    // If late reminders are disabled, don't schedule anything
    if (!settings.enabled) {
      return;
    }

    const reminderTime = new Date();
    reminderTime.setHours(hour);
    reminderTime.setMinutes(minute);
    reminderTime.setSeconds(0);
    reminderTime.setMilliseconds(0);

    // Add configured hours for the late reminder
    const lateReminderTime = new Date(
      reminderTime.getTime() + settings.hours * 60 * 60 * 1000
    );

    // Only schedule if it's in the future
    if (lateReminderTime > new Date()) {
      schedule.scheduleJob(lateReminderTime, async () => {
        console.log('Checking for missing standups...');

        // Clean up old late reminders first
        await db.cleanupOldLateReminders();

        const status = await db.getStandupStatus();
        const missing = status.filter(
          (s) => !s.hasSubmitted && !s.isOnVacation
        );

        // Send reminders to users who haven't submitted
        for (const user of missing) {
          const subscriber = await db.getSubscriberByUsername(user.username);
          if (subscriber) {
            // Check if user has already received a reminder today
            const hasReceivedReminder = await db.hasReceivedLateReminderToday(
              subscriber.user_id
            );
            if (!hasReceivedReminder) {
              await sendReminder(subscriber.user_id, true);
              await db.recordLateReminder(subscriber.user_id);
              console.log(`Sent late reminder to @${user.username}`);
            } else {
              console.log(
                `Skipped late reminder for @${user.username} (already sent today)`
              );
            }
          }
        }
      });
    }
  } catch (error) {
    console.error('Error scheduling late reminders:', error);
  }
}

/**
 * Schedule daily standups with timezone support
 */
async function scheduleStandups() {
  // Cancel existing job if any
  if (global.standupJob) {
    global.standupJob.cancel();
  }

  const { hour, minute } = await db.getStandupTime();
  const cronExpression = `${minute} ${hour} * * 1-5`;

  global.standupJob = schedule.scheduleJob(cronExpression, async () => {
    console.log('Starting daily standups...');
    try {
      const subscribers = await db.getActiveSubscribers();

      // Schedule late reminders
      await scheduleLateReminders(hour, minute);

      // Start standups for users whose local time matches the standup time
      for (const subscriber of subscribers) {
        const userTime = new Date().toLocaleString('en-US', {
          timeZone: subscriber.timezone || 'Europe/Lisbon',
          hour: 'numeric',
          minute: 'numeric',
          hour12: false,
        });

        const [userHour, userMinute] = userTime.split(':').map(Number);

        if (userHour === hour && userMinute === minute) {
          startUserStandup(subscriber.user_id);
          sendReminder(subscriber.user_id);
        }
      }
    } catch (error) {
      console.error('Error starting daily standups:', error);
    }
  });

  console.log(
    `Daily standups scheduled for ${hour.toString().padStart(2, '0')}:${minute.toString().padStart(2, '0')} (Lisbon time)`
  );
}

/**
 * Skip command handler for optional questions
 */
bot.onText(botCommands.skip, (msg) =>
  commandGuard(msg, async (msg) => {
    const userId = msg.from.id;
    const chatId = msg.chat.id;

    if (!userStates.has(userId)) {
      return;
    }

    const state = userStates.get(userId);
    // Allow skipping the first question (yesterday) and the last question (blockers)
    if (state.currentQuestion === 0 || state.currentQuestion === 2) {
      // Initialize response object if it doesn't exist
      let response = standupResponses.get(userId);
      if (!response) {
        response = {
          username: msg.from.username || msg.from.first_name,
          answers: ['', '', ''],
        };
      }

      response.answers[state.currentQuestion] = '';
      standupResponses.set(userId, response);

      // Move to next question or finish
      if (state.currentQuestion < QUESTIONS.length - 1) {
        state.currentQuestion++;
        bot.sendMessage(chatId, QUESTIONS[state.currentQuestion]);
      } else {
        // Complete the standup
        userStates.delete(userId);

        // Save to database
        await db.addStandup(
          userId,
          response.username,
          response.answers[0],
          response.answers[1],
          response.answers[2]
        );

        // Format response for channel
        const formattedResponse = formatStandupResponse(response);

        // Send to channel
        bot.sendMessage(process.env.TELEGRAM_CHANNEL_ID, formattedResponse, {
          parse_mode: 'Markdown',
        });

        // Confirm to user
        bot.sendMessage(chatId, 'Thank you! Your standup has been submitted.');

        // Clear the temporary response
        standupResponses.delete(userId);
      }
    } else {
      bot.sendMessage(
        chatId,
        '⚠️ This question cannot be skipped. Please provide an answer.'
      );
    }
  })
);

/**
 * Vacation mode command handler
 * Usage: /vacation dd/mm/yyyy
 */
bot.onText(botCommands.vacationDate, (msg, match) =>
  commandGuard(msg, async (msg) => {
    const userId = msg.from.id;
    const chatId = msg.chat.id;
    const dateStr = match[1] || match[2];

    try {
      // Check if user is subscribed
      if (!(await db.isSubscribed(userId))) {
        bot.sendMessage(
          chatId,
          '⚠️ You need to /subscribe first before you can set vacation mode.'
        );
        return;
      }

      // Parse the date
      const [day, month, year] = dateStr.split('/').map(Number);
      const endDate = new Date(year, month - 1, day); // month is 0-based
      const today = new Date();
      today.setHours(0, 0, 0, 0); // Set to start of day for comparison

      // Validate date
      if (isNaN(endDate.getTime())) {
        bot.sendMessage(
          chatId,
          '⚠️ Please provide a valid date in format dd/mm/yyyy.\n' +
            'Example: `/vacation 31/12/2024`',
          { parse_mode: 'Markdown' }
        );
        return;
      }

      // Check if date is in the past
      if (endDate < today) {
        bot.sendMessage(
          chatId,
          '⚠️ The vacation end date cannot be in the past.\n' +
            'Please provide a future date in format dd/mm/yyyy.\n' +
            'Example: `/vacation 31/12/2024`',
          { parse_mode: 'Markdown' }
        );
        return;
      }

      // Set vacation mode
      await db.setVacationMode(userId, endDate.toISOString().split('T')[0]);

      bot.sendMessage(
        chatId,
        `🏖 Vacation mode enabled until ${endDate.toLocaleDateString('en-GB')}.\n` +
          "You won't receive standup requests until then.\n" +
          'Use /back when you return!'
      );
    } catch (error) {
      console.error('Error in vacation handler:', error);
      bot.sendMessage(
        chatId,
        '❌ Sorry, there was an error setting your vacation mode. Please try again later.'
      );
    }
  })
);

/**
 * Return from vacation command handler
 */
bot.onText(botCommands.back, async (msg) => {
  const userId = msg.from.id;
  const chatId = msg.chat.id;

  try {
    const status = await db.getVacationStatus(userId);

    if (!status || !status.is_on_vacation) {
      bot.sendMessage(chatId, '⚠️ You are not on vacation mode.');
      return;
    }

    await db.disableVacationMode(userId);
    bot.sendMessage(
      chatId,
      '👋 Welcome back! You will start receiving standup requests again.'
    );
  } catch (error) {
    console.error('Error in back from vacation handler:', error);
    bot.sendMessage(
      chatId,
      '❌ Sorry, there was an error processing your request. Please try again later.'
    );
  }
});

// Add a handler for incorrect vacation command usage
bot.onText(botCommands.vacation, (msg) =>
  commandGuard(msg, async (msg) => {
    bot.sendMessage(
      msg.chat.id,
      '⚠️ Please provide an end date for your vacation.\n' +
        'Usage: `/vacation dd/mm/yyyy`\n' +
        'Example: `/vacation 31/12/2024`',
      { parse_mode: 'Markdown' }
    );
  })
);

/**
 * Set standup time command handler (admin only)
 * Usage: /set_time HH:mm
 */
bot.onText(botCommands.setTime, (msg, match) =>
  commandGuard(msg, async (msg) => {
    const userId = msg.from.id;
    const chatId = msg.chat.id;
    const timeStr = match[1] || match[2];

    try {
      // Debug logging
      console.log('User attempting admin command:', {
        userId,
        username: msg.from.username,
        firstName: msg.from.first_name,
        lastName: msg.from.last_name,
      });

      // Check if user is admin
      if (!(await db.isAdmin(userId))) {
        bot.sendMessage(
          chatId,
          '⚠️ This command is only available to administrators.'
        );
        return;
      }

      // Parse time format HH:mm or HH
      let hour,
        minute = 0;
      if (timeStr.includes(':')) {
        [hour, minute] = timeStr.split(':').map((num) => parseInt(num, 10));
      } else {
        hour = parseInt(timeStr, 10);
      }

      // Validate time format
      if (
        isNaN(hour) ||
        isNaN(minute) ||
        hour < 0 ||
        hour > 23 ||
        minute < 0 ||
        minute > 59
      ) {
        bot.sendMessage(
          chatId,
          '⚠️ Please provide a valid time in 24h format.\n' +
            'Usage: `/set_time HH:mm` or `/set_time HH`\n' +
            'Examples:\n' +
            '• `/set_time 9:30` for 9:30 AM\n' +
            '• `/set_time 14:15` for 2:15 PM\n' +
            '• `/set_time 9` for 9:00 AM',
          { parse_mode: 'Markdown' }
        );
        return;
      }

      // Update standup time
      await db.setStandupTime(hour, minute);

      // Reschedule daily standups
      scheduleStandups();

      bot.sendMessage(
        chatId,
        `✅ Daily standup time has been set to ${hour.toString().padStart(2, '0')}:${minute.toString().padStart(2, '0')} (Lisbon time).`
      );
    } catch (error) {
      console.error('Error in set_time handler:', error);
      bot.sendMessage(
        chatId,
        '❌ Sorry, there was an error setting the standup time. Please try again later.'
      );
    }
  })
);

/**
 * Timezone command handler
 * Lists available timezones when used without parameters
 */
bot.onText(botCommands.timezone, (msg) =>
  commandGuard(msg, async (msg) => {
    const chatId = msg.chat.id;
    const userId = msg.from.id;

    try {
      // Check if user is subscribed
      if (!(await db.isSubscribed(userId))) {
        bot.sendMessage(
          chatId,
          '⚠️ You need to /subscribe first before you can set your timezone.'
        );
        return;
      }

      const currentTimezone = await db.getUserTimezone(userId);
      const message = [
        '🌍 Set your timezone using `/timezone Region/City`',
        '',
        `Your current timezone is: \`${currentTimezone}\``,
        '',
        'Common timezones:',
        '• `Europe/London`',
        '• `Europe/Lisbon`',
        '• `Europe/Paris`',
        '• `America/New_York`',
        '• `America/Los_Angeles`',
        '• `Asia/Tokyo`',
        '',
        '[View all available timezones](https://en.wikipedia.org/wiki/List_of_tz_database_time_zones)',
      ].join('\n');

      bot.sendMessage(chatId, message, {
        parse_mode: 'Markdown',
        disable_web_page_preview: true,
      });
    } catch (error) {
      console.error('Error in timezone handler:', error);
      bot.sendMessage(
        chatId,
        '❌ Sorry, there was an error processing your request.'
      );
    }
  })
);

/**
 * Timezone setter command handler
 * Usage: /timezone Europe/London
 */
bot.onText(botCommands.timezoneSet, (msg, match) =>
  commandGuard(msg, async (msg) => {
    const chatId = msg.chat.id;
    const userId = msg.from.id;
    const timezone = match[1] || match[2];

    try {
      // Check if user is subscribed
      if (!(await db.isSubscribed(userId))) {
        bot.sendMessage(
          chatId,
          '⚠️ You need to /subscribe first before you can set your timezone.'
        );
        return;
      }

      // Validate timezone
      try {
        Intl.DateTimeFormat(undefined, { timeZone: timezone });
      } catch (e) {
        bot.sendMessage(
          chatId,
          '⚠️ Invalid timezone. Use `/timezone` to see the list of valid timezones.',
          { parse_mode: 'Markdown' }
        );
        return;
      }

      await db.setUserTimezone(userId, timezone);
      const now = new Date();
      const time = now.toLocaleTimeString('en-US', { timeZone: timezone });

      bot.sendMessage(
        chatId,
        `✅ Your timezone has been set to ${timezone}\n` +
          `Current time in your timezone: ${time}`
      );
    } catch (error) {
      console.error('Error in timezone handler:', error);
      bot.sendMessage(
        chatId,
        '❌ Sorry, there was an error processing your request.'
      );
    }
  })
);

/**
 * Late reminder control command handler (admin only)
 * Usage: /late_reminder on|off
 */
bot.onText(botCommands.lateReminder, (msg, match) =>
  commandGuard(msg, async (msg) => {
    const userId = msg.from.id;
    const chatId = msg.chat.id;
    const enabled = (match[1] || match[2]) === 'on';

    try {
      // Check if user is admin
      if (!(await db.isAdmin(userId))) {
        bot.sendMessage(
          chatId,
          '⚠️ This command is only available to administrators.'
        );
        return;
      }

      await db.setLateReminderEnabled(enabled);
      const settings = await db.getLateReminderSettings();

      bot.sendMessage(
        chatId,
        `✅ Late reminders have been turned ${enabled ? 'on' : 'off'}.\n` +
          `Current settings:\n` +
          `• Enabled: ${enabled ? 'Yes' : 'No'}\n` +
          `• Hours to wait: ${settings.hours}`
      );
    } catch (error) {
      console.error('Error in late reminder control:', error);
      bot.sendMessage(
        chatId,
        '❌ Sorry, there was an error updating the late reminder settings.'
      );
    }
  })
);

/**
 * Late reminder hours command handler (admin only)
 * Usage: /late_reminder_hours N
 */
bot.onText(botCommands.lateReminderHours, (msg, match) =>
  commandGuard(msg, async (msg) => {
    const userId = msg.from.id;
    const chatId = msg.chat.id;
    const hours = parseInt(match[1] || match[2], 10);

    try {
      // Check if user is admin
      if (!(await db.isAdmin(userId))) {
        bot.sendMessage(
          chatId,
          '⚠️ This command is only available to administrators.'
        );
        return;
      }

      // Validate hours
      if (hours < 1 || hours > 12) {
        bot.sendMessage(
          chatId,
          '⚠️ Please specify a number of hours between 1 and 12.'
        );
        return;
      }

      await db.setLateReminderHours(hours);
      const settings = await db.getLateReminderSettings();

      bot.sendMessage(
        chatId,
        `✅ Late reminder delay has been set to ${hours} hours.\n` +
          `Current settings:\n` +
          `• Enabled: ${settings.enabled ? 'Yes' : 'No'}\n` +
          `• Hours to wait: ${hours}`
      );
    } catch (error) {
      console.error('Error in late reminder hours:', error);
      bot.sendMessage(
        chatId,
        '❌ Sorry, there was an error updating the late reminder settings.'
      );
    }
  })
);

// Add startup channel verification
async function verifyChannelAccess() {
  const channelId = process.env.TELEGRAM_CHANNEL_ID;
  if (!channelId) {
    throw new Error('TELEGRAM_CHANNEL_ID not set in environment variables');
  }

  try {
    // Get bot's own info
    const botInfo = await bot.getMe();

    // Check bot's access to the channel
    const botMember = await bot.getChatMember(channelId, botInfo.id);
    if (botMember.status !== 'administrator') {
      throw new Error('Bot must be an administrator of the specified channel');
    }

    // Get channel info
    const chat = await bot.getChat(channelId);
    console.log(`Bot configured for channel: ${chat.title}`);
  } catch (error) {
    throw new Error(`Channel access verification failed: ${error.message}`);
  }
}

/**
 * Status command handler
 * Shows who has/hasn't submitted standup today
 */
bot.onText(botCommands.status, (msg) =>
  commandGuard(msg, async (msg) => {
    const chatId = msg.chat.id;

    try {
      const status = await db.getStandupStatus();

      if (status.length === 0) {
        bot.sendMessage(chatId, '👥 No members are currently subscribed.');
        return;
      }

      const now = new Date();
      const submitted = status.filter((s) => s.hasSubmitted);
      const notSubmitted = status.filter(
        (s) => !s.hasSubmitted && !s.isOnVacation
      );
      const onVacation = status.filter((s) => s.isOnVacation);

      let message = '📊 Standup Status Report\n\n';

      if (submitted.length > 0) {
        message +=
          '✅ Submitted:\n' +
          submitted
            .map((s) => {
              const time = new Date(s.submittedAt).toLocaleTimeString('en-US', {
                hour: '2-digit',
                minute: '2-digit',
              });
              return `• @${s.username} (${time})`;
            })
            .join('\n') +
          '\n\n';
      }

      if (notSubmitted.length > 0) {
        message +=
          '⏳ Pending:\n' +
          notSubmitted.map((s) => `• @${s.username}`).join('\n') +
          '\n\n';
      }

      if (onVacation.length > 0) {
        message +=
          '🏖 On Vacation:\n' +
          onVacation
            .map((s) => {
              const until = s.vacationUntil
                ? ` (until ${new Date(s.vacationUntil).toLocaleDateString()})`
                : '';
              return `• @${s.username}${until}`;
            })
            .join('\n') +
          '\n\n';
      }

      message += `📈 Participation: ${submitted.length}/${
        status.length - onVacation.length
      } members`;

      bot.sendMessage(chatId, message);
    } catch (error) {
      console.error('Error in status handler:', error);
      bot.sendMessage(
        chatId,
        '❌ Sorry, there was an error getting the status.'
      );
    }
  })
);
