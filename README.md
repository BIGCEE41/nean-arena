# NEAN-ARENA

NEAN-ARENA is a real-time, browser-based co-op platform adventure for 2–4 friends. Create a room, share its six-character code or invite link, and play together from phones or computers—no accounts, downloads, or game API keys needed.

## How to play

1. Enter a player name and create a room, or enter a friend's room code to join.
2. The room host starts the adventure when the crew is ready.
3. Move with **← / →** or **A / D**. Jump twice with **Space**, **↑**, or **W**; dash with **Shift** or **X**. On a phone, use the touch controls.
4. Collect coins to build your combo and crew score. Grab shields, speed boosts, and extra lives along the way.
5. Dodge the enemy and spikes. When the crew has all the coins, bring every connected player to the portal.
6. Your crew shares three lives. Clear three themed levels to win; beating a level adds a team bonus.

Coin sounds, synthesized in the browser with the Web Audio API, are optional. A personal high score is saved on your device.

## Run locally

Requires Python 3.10 or later.

```powershell
python -m venv .venv
.\.venv\Scripts\Activate.ps1
python -m pip install -r requirements.txt
python -m uvicorn nean_arena.server:app --host 0.0.0.0 --port 8000 --reload
```

Open [http://localhost:8000](http://localhost:8000). To play with someone else on the same network, share the host computer's local network address and room code.

## Publish a room link

The included `render.yaml` is a Render Blueprint for a single-instance web service. Push this repository to GitHub, create a new Blueprint from it in Render, and use the generated HTTPS service URL as the public game link. The game uses WebSockets; keep it on **one server worker** so all players in a room share the same in-memory game state. Room state is temporary and resets when the server restarts.

## Project structure

```text
nean_arena/
  game.py             Server-authoritative movement, power-ups, score, and levels
  server.py           Room codes, HTTP endpoints, and real-time WebSocket sync
  static/
    index.html        Game lobby and canvas
    styles.css        Responsive desktop and touch layouts
    game.js           Canvas rendering and player controls
tests/
  test_nean_arena.py  Game-rule tests
render.yaml           Single-instance Render deployment
```

## Run tests

```powershell
python -m unittest discover -s tests -p test_nean_arena.py
```
