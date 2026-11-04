import os
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "python"))
from meldiq_bot import MeldiqBot, MeldiqBotError

bot = MeldiqBot(os.environ["MELDIQ_API_ORIGIN"], os.environ["MELDIQ_BOT_TOKEN"])
try:
    bot.set_commands([{"name": "hello", "description": "A private greeting from this bot", "options": []}])
    while True:
        for interaction in bot.interactions(wait=20)["interactions"]:
            bot.reply(interaction["id"], "Hello from your Meldiq bot.", ephemeral=True)
except KeyboardInterrupt:
    pass
except MeldiqBotError as error:
    print("Bot stopped:", error.code, "(" + str(error.status) + ")", file=sys.stderr)
    sys.exit(1)
