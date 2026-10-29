import unittest

from fastapi import WebSocketDisconnect
from fastapi.testclient import TestClient

from nean_arena.game import (
    DOUBLE_JUMP_VELOCITY,
    FLOOR_Y,
    Game,
    PLAYER_HEIGHT,
)
from nean_arena.server import app, rooms


class GameRulesTests(unittest.TestCase):
    def setUp(self):
        self.game = Game()
        self.game.add_player("p1", "Nova")
        self.player = self.game.players["p1"]
        self.player.connected = True
        self.game.start()

    def test_player_moves_and_jumps(self):
        start_x = self.player.x
        self.game.set_input("p1", {"right": True})
        for _ in range(4):
            self.game.step()
        self.assertGreater(self.player.x, start_x)

        self.game.set_input("p1", {"right": False, "jump": True})
        start_y = self.player.y
        self.game.step()
        self.assertLess(self.player.y, start_y)

    def test_player_gets_one_double_jump_in_the_air(self):
        self.game.set_input("p1", {"jump": True})
        self.game.set_input("p1", {"jump": False})
        self.game.set_input("p1", {"jump": True})
        self.assertEqual(self.player.jump_count, 2)
        self.assertEqual(self.player.vy, DOUBLE_JUMP_VELOCITY)

        self.game.set_input("p1", {"jump": False})
        self.game.set_input("p1", {"jump": True})
        self.assertEqual(self.player.jump_count, 2)
        self.assertEqual(self.player.vy, DOUBLE_JUMP_VELOCITY)

    def test_dash_crosses_hazard_without_spending_a_life(self):
        self.player.x = 280
        self.player.y = FLOOR_Y - PLAYER_HEIGHT
        self.game.set_input("p1", {"right": True, "dash": True})
        self.game.step()
        self.assertEqual(self.game.lives, 3)
        self.assertGreater(self.player.x, 280)
        self.assertGreater(self.player.dash_ticks, 0)

    def test_shield_powerup_protects_player_from_hazards(self):
        self.player.x = 183
        self.player.y = 390
        self.game.step()
        self.assertGreater(self.player.shield_ticks, 0)
        self.player.x = 290
        self.player.y = FLOOR_Y - PLAYER_HEIGHT
        self.game.step()
        self.assertEqual(self.game.lives, 3)

    def test_heart_powerup_restores_a_shared_life_up_to_five(self):
        self.game.lives = 2
        self.player.x = 846
        self.player.y = FLOOR_Y - PLAYER_HEIGHT
        self.game.step()
        self.assertEqual(self.game.lives, 3)
        self.assertEqual(len([powerup for powerup in self.game.powerups if powerup[2] == "heart"]), 0)

        self.game.lives = 5
        self.game.level = 2
        self.game._load_level()
        self.player.x = 876
        self.player.y = FLOOR_Y - PLAYER_HEIGHT
        self.game.step()
        self.assertEqual(self.game.lives, 5)

    def test_collecting_coins_builds_a_combo_and_score(self):
        for x, y in ((155, 402), (225, 402), (370, 342)):
            self.player.x = x - 14
            self.player.y = y - PLAYER_HEIGHT // 2
            self.game._collect_coins(self.player)

        self.assertEqual(self.player.combo, 3)
        self.assertEqual(self.player.score, 400)
        self.assertEqual(self.game.coins_collected, 3)

    def test_hazard_costs_one_shared_life_and_respawns_player(self):
        self.player.x = 290
        self.player.y = FLOOR_Y - PLAYER_HEIGHT
        self.game.step()
        self.assertEqual(self.game.lives, 2)
        self.assertEqual(self.player.x, 54)
        self.assertGreater(self.player.invulnerable_ticks, 0)

    def test_portal_opens_only_after_collecting_every_coin(self):
        snapshot = self.game.snapshot()
        self.assertFalse(snapshot["exit_active"])

        self.game.coins.clear()
        self.player.x = 900
        self.player.y = FLOOR_Y - PLAYER_HEIGHT
        self.game.step()

        self.assertEqual(self.game.level, 2)
        self.assertEqual(self.game.bonus_score, 250)
        self.assertEqual(self.game.phase, "playing")
        self.assertGreater(self.game.snapshot()["coins_left"], 0)

    def test_finishing_final_level_wins_the_run(self):
        self.game.level = 3
        self.game._load_level()
        self.game.coins.clear()
        self.player.x = 900
        self.player.y = FLOOR_Y - PLAYER_HEIGHT
        self.game.step()
        self.assertEqual(self.game.phase, "won")

    def test_all_connected_players_must_reach_exit(self):
        self.game.add_player("p2", "Moss")
        second = self.game.players["p2"]
        second.connected = True
        self.game.coins.clear()
        self.player.x = 900
        self.player.y = FLOOR_Y - PLAYER_HEIGHT

        self.game.step()
        self.assertEqual(self.game.level, 1)

        second.x = 900
        second.y = FLOOR_Y - PLAYER_HEIGHT
        self.game.step()
        self.assertEqual(self.game.level, 2)

    def test_players_receive_distinct_spawn_positions(self):
        self.game.add_player("p2", "Moss")
        self.game.add_player("p3", "Pip")
        self.game.add_player("p4", "Echo")
        self.game._reset_players()
        positions = [player.x for player in self.game.players.values()]
        self.assertEqual(len(positions), len(set(positions)))


class MultiplayerConnectionTests(unittest.TestCase):
    def test_reconnecting_player_replaces_old_socket_without_breaking_room(self):
        rooms.rooms.clear()
        with TestClient(app) as client:
            credentials = client.post("/api/rooms", json={"name": "Nova"}).json()
            path = f"/ws/{credentials['room_code']}"

            with client.websocket_connect(path) as first_socket:
                first_socket.send_json({
                    "type": "join",
                    "player_id": credentials["player_id"],
                    "token": credentials["token"],
                })
                self.assertEqual(first_socket.receive_json()["phase"], "lobby")

                with client.websocket_connect(path) as replacement_socket:
                    replacement_socket.send_json({
                        "type": "join",
                        "player_id": credentials["player_id"],
                        "token": credentials["token"],
                    })
                    self.assertEqual(replacement_socket.receive_json()["phase"], "lobby")
                    with self.assertRaises(WebSocketDisconnect):
                        first_socket.receive_json()

                    replacement_socket.send_json({
                        "type": "start",
                    })
                    for _ in range(10):
                        state = replacement_socket.receive_json()
                        if state["phase"] == "playing":
                            break
                    self.assertEqual(state["phase"], "playing")
                    replacement_socket.send_json({"type": "start"})
                    response = replacement_socket.receive_json()
                    self.assertEqual(response["type"], "error")
                    self.assertEqual(response["message"], "The adventure is already in progress.")


if __name__ == "__main__":
    unittest.main()
