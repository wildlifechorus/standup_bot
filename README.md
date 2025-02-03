# Telegram Standup Bot

A Telegram bot that automates daily standup meetings by collecting responses from team members and posting them to a channel.

## Features

- Automated daily standup questions at configurable time (Monday-Friday only)
- Timezone support for each team member
- Simple subscription system for team members
- Manual trigger for testing standups
- Daily standup replay functionality
- Subscribed members list
- Vacation mode support
- Late reminder system for missing standups
- Collects responses for:
  - Yesterday's work
  - Today's plans
  - Current blockers (optional)
- Posts compiled responses to a designated channel

## Setup

1. Create a new bot using [@BotFather](https://t.me/botfather) on Telegram and get the bot token

2. Create a channel where standup updates will be posted and add your bot as an administrator

3. Clone this repository and install dependencies:

   ```bash
   git clone <repository-url>
   cd standup_bot
   yarn install
   ```

4. Create a `.env` file based on `.env.example`:

   ```bash
   cp .env.example .env
   ```

5. Edit the `.env` file with your bot token, channel ID, and admin usernames:

   ```
   TELEGRAM_BOT_TOKEN=your_bot_token_here
   TELEGRAM_CHANNEL_ID=@your_channel_name
   ADMIN_USERNAMES=admin1,admin2
   TZ=Europe/Lisbon
   ```

6. Start the bot:
   ```bash
   yarn start
   ```

## Usage

1. Start a chat with your bot and send `/start` to see available commands

2. Use `/subscribe` to start receiving daily standup questions

3. Set your timezone using `/timezone` if you're not in Lisbon time

4. The bot will automatically send you questions at the configured standup time on weekdays (Monday-Friday)

5. Answer each question when prompted

6. Use `/unsubscribe` to stop receiving daily standup questions

## Commands

### User Commands

- `/start` - Initialize the bot and see available commands
- `/subscribe` - Subscribe to daily standups
- `/unsubscribe` - Unsubscribe from daily standups
- `/standup` - Manually trigger a standup session
- `/replay` - Show all standups submitted today
- `/members` - List all subscribed members
- `/timezone` - Set your timezone
- `/status` - Show today's standup status
- `/summary [days]` - Show standup summary for specified days
- `/vacation dd/mm/yyyy` - Set vacation mode until date
- `/back` - Return from vacation
- `/skip` - Skip the blockers question (only during standup)

### Admin Commands

- `/set_time HH:mm` - Set daily standup time (24h format)
- `/late_reminder on|off` - Enable/disable late reminders
- `/late_reminder_hours N` - Set hours to wait before late reminder (1-12)

## Late Reminder System

The bot includes a configurable late reminder system for users who haven't submitted their standup:

- Admins can enable/disable late reminders using `/late_reminder on` or `/late_reminder off`
- The delay before sending late reminders can be set using `/late_reminder_hours N` (1-12 hours)
- Each user receives at most one late reminder per day
- Late reminders are only sent to users who:
  - Are subscribed
  - Haven't submitted their standup yet
  - Aren't on vacation

## Testing

You can test the bot's functionality without waiting for the scheduled time:

1. Start a chat with the bot
2. Use `/subscribe` to register yourself
3. Use `/standup` to immediately start a standup session
4. Answer the questions as they come
5. Check your channel to see the formatted response
6. Use `/replay` to see all standups submitted today

This is particularly useful for testing the bot's functionality during development or when setting up the bot for the first time.

## License

MIT
