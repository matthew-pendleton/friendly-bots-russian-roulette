# unfriendly-roulette

Discord bot: Russian Roulette — part of the **Unfriendly** bot suite.

Gather 2–3 players and take turns pulling the trigger. One bullet. Six chambers. The loser gets timed out.

## Setup

1) Install dependencies

```bash
npm install
```

2) Create your `.env`

Copy `.env.example` to `.env` or fill in the included `.env`:

- `DISCORD_TOKEN`: your bot token
- `CLIENT_ID`: your application (bot) client ID

3) Run the bot

```bash
npm start
```

On startup it registers slash commands globally (may take a little time to propagate).

## Commands

- `/unfriendly-roulette play @player2 [@player3]`
- `/unfriendly-roulette stats [@user]`
- `/unfriendly-roulette leaderboard`
- `/unfriendly-roulette help`

## Notes / requirements

- Server-only (no DMs)
- Needs **Moderate Members** permission to time out the loser

