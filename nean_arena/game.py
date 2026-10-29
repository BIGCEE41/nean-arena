"""Authoritative game rules for NEAN-ARENA."""

from dataclasses import dataclass, field

WORLD_WIDTH = 960
WORLD_HEIGHT = 540
FLOOR_Y = 490
PLAYER_WIDTH = 28
PLAYER_HEIGHT = 38
TICK_RATE = 30
MAX_PLAYERS = 4
STARTING_LIVES = 3
MAX_LIVES = 5
POWER_UP_DURATION = 180
DOUBLE_JUMP_VELOCITY = -9.5

LEVELS = (
    {
        "name": "Glowcap Grove",
        "platforms": (
            (130, 430, 130, 16),
            (330, 370, 135, 16),
            (550, 420, 150, 16),
            (755, 355, 130, 16),
        ),
        "coins": ((155, 402), (225, 402), (370, 342), (425, 342), (595, 392), (805, 327), (890, 452)),
        "powerups": ((195, 402, "shield"), (610, 392, "boost"), (860, 452, "heart")),
        "hazards": ((285, 468, 54, 22), (690, 468, 58, 22)),
        "enemy": (465, 535, 458, 2.0),
    },
    {
        "name": "Crystal Caves",
        "platforms": (
            (100, 435, 115, 16),
            (290, 380, 125, 16),
            (485, 325, 135, 16),
            (685, 385, 125, 16),
            (820, 330, 100, 16),
        ),
        "coins": ((120, 407), (185, 407), (325, 352), (385, 352), (520, 297), (585, 297), (715, 357), (850, 302), (900, 452)),
        "powerups": ((155, 407, "shield"), (550, 297, "boost"), (880, 452, "heart")),
        "hazards": ((240, 468, 62, 22), (435, 468, 60, 22), (640, 468, 58, 22)),
        "enemy": (490, 595, 458, 2.5),
    },
    {
        "name": "Starfall Summit",
        "platforms": (
            (95, 430, 120, 16),
            (270, 365, 120, 16),
            (445, 305, 125, 16),
            (630, 365, 120, 16),
            (790, 310, 120, 16),
        ),
        "coins": ((120, 402), (180, 402), (300, 337), (360, 337), (475, 277), (535, 277), (665, 337), (720, 337), (820, 282), (900, 452)),
        "powerups": ((150, 402, "shield"), (500, 277, "boost"), (865, 452, "heart")),
        "hazards": ((220, 468, 54, 22), (405, 468, 62, 22), (595, 468, 58, 22), (760, 468, 60, 22)),
        "enemy": (355, 630, 458, 3.0),
    },
)


@dataclass
class Player:
    player_id: str
    name: str
    x: float = 54
    spawn_x: float = 54
    y: float = FLOOR_Y - PLAYER_HEIGHT
    vx: float = 0
    vy: float = 0
    grounded: bool = True
    connected: bool = False
    invulnerable_ticks: int = 0
    shield_ticks: int = 0
    boost_ticks: int = 0
    dash_ticks: int = 0
    dash_cooldown: int = 0
    jump_count: int = 0
    facing: int = 1
    score: int = 0
    combo: int = 0
    combo_ticks: int = 0
    controls: dict = field(
        default_factory=lambda: {
            "left": False,
            "right": False,
            "jump": False,
            "dash": False,
        }
    )


class Game:
    """Mutable room state; the server advances it at a fixed tick rate."""

    def __init__(self):
        self.players = {}
        self.phase = "lobby"
        self.level = 1
        self.lives = STARTING_LIVES
        self.coins = set()
        self.powerups = set()
        self.coins_collected = 0
        self.bonus_score = 0
        self.enemy_x = 0
        self.enemy_direction = 1
        self._load_level()

    @property
    def level_data(self):
        return LEVELS[self.level - 1]

    def add_player(self, player_id, name):
        player = Player(player_id=player_id, name=name)
        player.spawn_x = 54 + len(self.players) * 36
        self.players[player_id] = player

    def set_connected(self, player_id, connected):
        player = self.players.get(player_id)
        if player:
            player.connected = connected

    def start(self):
        self.level = 1
        self.lives = STARTING_LIVES
        self.coins_collected = 0
        self.bonus_score = 0
        self.phase = "playing"
        for player in self.players.values():
            player.score = 0
            player.combo = 0
            player.combo_ticks = 0
        self._reset_players()
        self._load_level()

    def set_input(self, player_id, controls):
        player = self.players.get(player_id)
        if not player or not player.connected or self.phase != "playing":
            return

        updated = {
            key: controls.get(key) is True
            for key in ("left", "right", "jump", "dash")
        }
        if updated["jump"] and not player.controls["jump"] and player.jump_count < 2:
            player.vy = -11.2 if player.jump_count == 0 else DOUBLE_JUMP_VELOCITY
            player.jump_count += 1
            player.grounded = False
        if updated["dash"] and not player.controls["dash"] and player.dash_cooldown == 0:
            direction = int(updated["right"]) - int(updated["left"]) or player.facing
            player.facing = direction
            player.vx = direction * 11
            player.vy = 0
            player.dash_ticks = 9
            player.dash_cooldown = 60
        player.controls = updated

    def step(self):
        if self.phase != "playing":
            return

        self.enemy_x += self.enemy_direction * self.level_data["enemy"][3]
        enemy_min, enemy_max = self.level_data["enemy"][:2]
        if self.enemy_x < enemy_min or self.enemy_x > enemy_max:
            self.enemy_x = max(enemy_min, min(self.enemy_x, enemy_max))
            self.enemy_direction *= -1

        for player in self.players.values():
            if not player.connected:
                continue
            player.invulnerable_ticks = max(0, player.invulnerable_ticks - 1)
            player.shield_ticks = max(0, player.shield_ticks - 1)
            player.boost_ticks = max(0, player.boost_ticks - 1)
            player.dash_cooldown = max(0, player.dash_cooldown - 1)
            player.combo_ticks = max(0, player.combo_ticks - 1)
            if not player.combo_ticks:
                player.combo = 0
            was_dashing = player.dash_ticks > 0
            self._move_player(player)
            self._collect_coins(player)
            self._collect_powerups(player)
            if self._touches_danger(player, was_dashing):
                self._lose_life(player)
                if self.phase == "lost":
                    return

        active_players = [
            player for player in self.players.values() if player.connected
        ]
        if (
            active_players
            and not self.coins
            and all(self._at_exit(player) for player in active_players)
        ):
            self.bonus_score += self.level * 250
            if self.level == len(LEVELS):
                self.phase = "won"
            else:
                self.level += 1
                self._reset_players()
                self._load_level()

    def snapshot(self):
        enemy_min, enemy_max, enemy_y, _ = self.level_data["enemy"]
        return {
            "phase": self.phase,
            "level": self.level,
            "level_count": len(LEVELS),
            "level_name": self.level_data["name"],
            "lives": self.lives,
            "score": self.bonus_score + sum(player.score for player in self.players.values()),
            "coins_collected": self.coins_collected,
            "total_coins": sum(len(level["coins"]) for level in LEVELS),
            "coins_left": len(self.coins),
            "coins": [{"x": x, "y": y} for x, y in sorted(self.coins)],
            "platforms": [list(platform) for platform in self.level_data["platforms"]],
            "hazards": [list(hazard) for hazard in self.level_data["hazards"]],
            "powerups": [
                {"x": x, "y": y, "type": kind}
                for x, y, kind in sorted(self.powerups)
            ],
            "enemy": {
                "x": self.enemy_x,
                "y": enemy_y,
                "min_x": enemy_min,
                "max_x": enemy_max,
            },
            "exit_active": not self.coins,
            "exit": {"x": 900, "y": FLOOR_Y - 58, "width": 40, "height": 58},
            "players": [
                {
                    "id": player.player_id,
                    "name": player.name,
                    "x": round(player.x, 1),
                    "y": round(player.y, 1),
                    "connected": player.connected,
                    "invulnerable": player.invulnerable_ticks > 0,
                    "shield_ticks": player.shield_ticks,
                    "boost_ticks": player.boost_ticks,
                    "dash_ticks": player.dash_ticks,
                    "dash_cooldown": player.dash_cooldown,
                    "facing": player.facing,
                    "score": player.score,
                    "combo": player.combo,
                }
                for player in self.players.values()
            ],
        }

    def _load_level(self):
        level = self.level_data
        self.coins = set(level["coins"])
        self.powerups = set(level["powerups"])
        self.enemy_x = float(level["enemy"][0])
        self.enemy_direction = 1

    def _reset_players(self):
        for index, player in enumerate(self.players.values()):
            player.x = player.spawn_x
            player.y = FLOOR_Y - PLAYER_HEIGHT
            player.vx = 0
            player.vy = 0
            player.grounded = True
            player.invulnerable_ticks = 0
            player.shield_ticks = 0
            player.boost_ticks = 0
            player.dash_ticks = 0
            player.dash_cooldown = 0
            player.jump_count = 0
            player.facing = 1
            player.combo = 0
            player.combo_ticks = 0
            player.controls = {
                "left": False,
                "right": False,
                "jump": False,
                "dash": False,
            }

    def _move_player(self, player):
        if player.dash_ticks:
            player.x = max(0, min(WORLD_WIDTH - PLAYER_WIDTH, player.x + player.vx))
            player.dash_ticks -= 1
            if not player.dash_ticks:
                player.vx *= 0.55
            return

        direction = int(player.controls["right"]) - int(player.controls["left"])
        if direction:
            player.facing = direction
            acceleration = 0.9 if player.boost_ticks else 0.72
            max_speed = 5.8 if player.boost_ticks else 4.2
            player.vx = max(-max_speed, min(max_speed, player.vx + direction * acceleration))
        else:
            player.vx *= 0.72
            if abs(player.vx) < 0.15:
                player.vx = 0

        player.x = max(0, min(WORLD_WIDTH - PLAYER_WIDTH, player.x + player.vx))
        old_y = player.y
        old_bottom = old_y + PLAYER_HEIGHT
        player.vy = min(12, player.vy + 0.58)
        player.y += player.vy
        player.grounded = False

        surfaces = (
            *self.level_data["platforms"],
            (0, FLOOR_Y, WORLD_WIDTH, WORLD_HEIGHT - FLOOR_Y),
        )
        if player.vy >= 0:
            landings = [
                surface
                for surface in surfaces
                if old_bottom <= surface[1]
                and player.y + PLAYER_HEIGHT >= surface[1]
                and player.x + PLAYER_WIDTH > surface[0]
                and player.x < surface[0] + surface[2]
            ]
            if landings:
                surface = min(landings, key=lambda item: item[1])
                player.y = surface[1] - PLAYER_HEIGHT
                player.vy = 0
                player.grounded = True
                player.jump_count = 0
        else:
            ceilings = [
                surface
                for surface in self.level_data["platforms"]
                if old_y >= surface[1] + surface[3]
                and player.y <= surface[1] + surface[3]
                and player.x + PLAYER_WIDTH > surface[0]
                and player.x < surface[0] + surface[2]
            ]
            if ceilings:
                surface = max(ceilings, key=lambda item: item[1] + item[3])
                player.y = surface[1] + surface[3]
                player.vy = 0

    def _collect_coins(self, player):
        player_right = player.x + PLAYER_WIDTH
        player_bottom = player.y + PLAYER_HEIGHT
        for coin in tuple(self.coins):
            x, y = coin
            if (
                player.x < x + 12
                and player_right > x - 12
                and player.y < y + 12
                and player_bottom > y - 12
            ):
                self.coins.remove(coin)
                self.coins_collected += 1
                player.combo = player.combo + 1 if player.combo_ticks else 1
                player.combo_ticks = 75
                player.score += 100 * min(5, 1 + player.combo // 3)

    def _collect_powerups(self, player):
        player_rect = (player.x, player.y, PLAYER_WIDTH, PLAYER_HEIGHT)
        for powerup in tuple(self.powerups):
            x, y, kind = powerup
            if not self._overlaps(player_rect, (x - 12, y - 12, 24, 24)):
                continue
            self.powerups.remove(powerup)
            if kind == "shield":
                player.shield_ticks = POWER_UP_DURATION
            elif kind == "boost":
                player.boost_ticks = POWER_UP_DURATION
            elif kind == "heart":
                self.lives = min(MAX_LIVES, self.lives + 1)

    def _touches_danger(self, player, was_dashing=False):
        if player.invulnerable_ticks or player.shield_ticks or player.dash_ticks or was_dashing:
            return False
        player_rect = (
            player.x,
            player.y,
            PLAYER_WIDTH,
            PLAYER_HEIGHT,
        )
        dangers = [
            *self.level_data["hazards"],
            (self.enemy_x, self.level_data["enemy"][2], 34, 34),
        ]
        return any(self._overlaps(player_rect, danger) for danger in dangers)

    @staticmethod
    def _overlaps(first, second):
        x, y, width, height = first
        other_x, other_y, other_width, other_height = second
        return (
            x < other_x + other_width
            and x + width > other_x
            and y < other_y + other_height
            and y + height > other_y
        )

    def _lose_life(self, player):
        self.lives -= 1
        player.x = player.spawn_x
        player.y = FLOOR_Y - PLAYER_HEIGHT
        player.vx = 0
        player.vy = 0
        player.grounded = True
        player.invulnerable_ticks = 45
        player.shield_ticks = 0
        player.dash_ticks = 0
        player.dash_cooldown = 0
        player.jump_count = 0
        if self.lives <= 0:
            self.lives = 0
            self.phase = "lost"

    @staticmethod
    def _at_exit(player):
        return Game._overlaps(
            (player.x, player.y, PLAYER_WIDTH, PLAYER_HEIGHT),
            (900, FLOOR_Y - 58, 40, 58),
        )
