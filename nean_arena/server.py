"""WebSocket server and room management for NEAN-ARENA."""

import asyncio
import logging
import re
import secrets
import time
from pathlib import Path

from fastapi import FastAPI, HTTPException, WebSocket, WebSocketDisconnect
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field, field_validator
from starlette.websockets import WebSocketDisconnected, WebSocketState

from nean_arena.game import Game, MAX_PLAYERS, TICK_RATE

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger("nean_arena")

STATIC_DIR = Path(__file__).parent / "static"
ROOM_CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"
ROOM_CODE_PATTERN = re.compile(r"^[A-HJ-NP-Z2-9]{6}$")
ROOM_IDLE_SECONDS = 60 * 60


class PlayerName(BaseModel):
    name: str = Field(min_length=1, max_length=18)

    @field_validator("name")
    @classmethod
    def validate_name(cls, value):
        name = " ".join(value.split())
        if not name or len(name) > 18:
            raise ValueError("Choose a name between 1 and 18 characters.")
        if any(not (character.isalnum() or character in " -_") for character in name):
            raise ValueError("Names can contain letters, numbers, spaces, - and _.")
        return name


class Room:
    def __init__(self, code, host_id, host_token, name):
        self.code = code
        self.host_id = host_id
        self.game = Game()
        self.game.add_player(host_id, name)
        self.tokens = {host_id: host_token}
        self.connections = {}
        self.last_activity = time.monotonic()
        self.broadcast_task = None


class RoomManager:
    def __init__(self):
        self.rooms = {}

    def create(self, name):
        code = self._new_code()
        player_id = secrets.token_urlsafe(8)
        token = secrets.token_urlsafe(24)
        room = Room(code, player_id, token, name)
        self.rooms[code] = room
        return self.credentials(room, player_id)

    def join(self, code, name):
        room = self.rooms.get(code)
        if room is None:
            raise HTTPException(status_code=404, detail="Room not found. Check the code and try again.")
        if room.game.phase != "lobby":
            raise HTTPException(status_code=409, detail="This adventure has already started.")
        if len(room.game.players) >= MAX_PLAYERS:
            raise HTTPException(status_code=409, detail="This room is full (maximum 4 players).")
        if any(player.name.casefold() == name.casefold() for player in room.game.players.values()):
            raise HTTPException(status_code=409, detail="That player name is already in this room.")

        player_id = secrets.token_urlsafe(8)
        token = secrets.token_urlsafe(24)
        room.game.add_player(player_id, name)
        room.tokens[player_id] = token
        room.last_activity = time.monotonic()
        return self.credentials(room, player_id)

    def authenticate(self, code, player_id, token):
        room = self.rooms.get(code)
        if room is None or player_id not in room.tokens:
            return None
        if not secrets.compare_digest(room.tokens[player_id], token):
            return None
        return room

    @staticmethod
    def credentials(room, player_id):
        return {
            "room_code": room.code,
            "player_id": player_id,
            "token": room.tokens[player_id],
            "is_host": player_id == room.host_id,
        }

    def _new_code(self):
        while True:
            code = "".join(secrets.choice(ROOM_CODE_ALPHABET) for _ in range(6))
            if code not in self.rooms:
                return code


rooms = RoomManager()
app = FastAPI(title="NEAN-ARENA", description="A real-time co-op adventure")
app.mount("/static", StaticFiles(directory=STATIC_DIR), name="static")


@app.get("/")
async def home():
    return FileResponse(STATIC_DIR / "index.html")


@app.get("/healthz")
async def health():
    return {"status": "ok"}


@app.post("/api/rooms")
async def create_room(request: PlayerName):
    return rooms.create(request.name)


@app.post("/api/rooms/{room_code}/join")
async def join_room(room_code: str, request: PlayerName):
    code = room_code.upper()
    if not ROOM_CODE_PATTERN.fullmatch(code):
        raise HTTPException(status_code=404, detail="Room not found. Check the code and try again.")
    return rooms.join(code, request.name)


async def _broadcast_room(room):
    tick_delay = 1 / TICK_RATE
    while True:
        room.game.step()
        state = room.game.snapshot()
        disconnected = []
        for player_id, socket in tuple(room.connections.items()):
            try:
                await socket.send_json(state)
            except (WebSocketDisconnect, RuntimeError):
                disconnected.append((player_id, socket))

        for player_id, socket in disconnected:
            if room.connections.get(player_id) is socket:
                room.connections.pop(player_id, None)
                room.game.set_connected(player_id, False)

        if not room.connections and time.monotonic() - room.last_activity > ROOM_IDLE_SECONDS:
            rooms.rooms.pop(room.code, None)
            return
        await asyncio.sleep(tick_delay)


@app.websocket("/ws/{room_code}")
async def room_socket(websocket: WebSocket, room_code: str):
    code = room_code.upper()
    if not ROOM_CODE_PATTERN.fullmatch(code):
        await websocket.close(code=1008, reason="Invalid room code")
        return

    await websocket.accept()
    try:
        credentials = await asyncio.wait_for(websocket.receive_json(), timeout=10)
    except asyncio.TimeoutError:
        await websocket.close(code=1008, reason="Join message required")
        return
    except (WebSocketDisconnect, WebSocketDisconnected):
        return
    except ValueError:
        await websocket.close(code=1008, reason="Invalid join message")
        return

    if not isinstance(credentials, dict) or credentials.get("type") != "join":
        await websocket.close(code=1008, reason="Join message required")
        return

    player_id = credentials.get("player_id")
    token = credentials.get("token")
    if not isinstance(player_id, str) or not isinstance(token, str):
        await websocket.close(code=1008, reason="Invalid player credentials")
        return

    room = rooms.authenticate(code, player_id, token)
    if room is None:
        await websocket.close(code=1008, reason="Room or player session not found")
        return

    previous_socket = room.connections.get(player_id)
    if previous_socket and previous_socket.application_state == WebSocketState.CONNECTED:
        try:
            await previous_socket.close(code=1000, reason="Player reconnected")
        except (WebSocketDisconnect, WebSocketDisconnected):
            pass
    room.connections[player_id] = websocket
    room.game.set_connected(player_id, True)
    room.last_activity = time.monotonic()
    if room.broadcast_task is None or room.broadcast_task.done():
        room.broadcast_task = asyncio.create_task(_broadcast_room(room))

    try:
        while True:
            try:
                message = await websocket.receive_json()
            except ValueError:
                await websocket.send_json({"type": "error", "message": "Invalid game message."})
                continue

            if not isinstance(message, dict):
                continue
            room.last_activity = time.monotonic()
            if message.get("type") == "input":
                controls = message.get("controls")
                if isinstance(controls, dict):
                    room.game.set_input(player_id, controls)
            elif message.get("type") == "start" and player_id == room.host_id:
                if room.game.phase in {"lobby", "won", "lost"}:
                    room.game.start()
                else:
                    await websocket.send_json({"type": "error", "message": "The adventure is already in progress."})
            elif message.get("type") == "start":
                await websocket.send_json({"type": "error", "message": "Only the room host can start the adventure."})
    except (WebSocketDisconnect, WebSocketDisconnected):
        pass
    finally:
        if room.connections.get(player_id) is websocket:
            room.connections.pop(player_id, None)
            room.game.set_connected(player_id, False)
            room.last_activity = time.monotonic()
        logger.info("Player disconnected from room %s", room.code)
