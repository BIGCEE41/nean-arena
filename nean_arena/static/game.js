(() => {
  const $ = (selector) => document.querySelector(selector);
  const homeScreen = $("#home-screen");
  const gameScreen = $("#game-screen");
  const nameInput = $("#player-name");
  const roomInput = $("#room-code");
  const canvas = $("#game-canvas");
  const context = canvas.getContext("2d");
  const colors = ["#83f0bc", "#ffd166", "#9aabff", "#ff8c82"];
  const storageKey = "nean-arena-player";
  const controls = { left: false, right: false, jump: false, dash: false };
  const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  const soundKey = "nean-arena-sound";

  let credentials = null;
  let socket = null;
  let state = null;
  let previousState = null;
  let snapshotAt = 0;
  let snapshotInterval = 1000 / 30;
  let isHost = false;
  let inputTimer = null;
  let reconnectTimer = null;
  let reconnectAttempt = 0;
  let closingIntentionally = false;
  let soundEnabled = localStorage.getItem(soundKey) === "true";
  let audioContext = null;
  let particles = [];
  let shakeUntil = 0;
  let playerRosterSignature = "";
  let playerScoreElements = new Map();
  let highScore = Number(localStorage.getItem("nean-arena-high-score")) || 0;

  const queryRoom = new URLSearchParams(window.location.search).get("room");
  if (queryRoom) roomInput.value = queryRoom.toUpperCase().slice(0, 6);

  function showError(element, message) {
    element.textContent = message || "";
  }

  function validName() {
    const name = nameInput.value.trim().replace(/\s+/g, " ");
    if (!name || name.length > 18 || !/^[\p{L}\p{N} _-]+$/u.test(name)) {
      showError($("#home-error"), "Enter a name (1–18 characters; letters, numbers, spaces, - and _).");
      nameInput.focus();
      return "";
    }
    return name;
  }

  async function createRoom() {
    const name = validName();
    if (!name) return;
    setEntryButtonsDisabled(true);
    showError($("#home-error"), "");
    try {
      const response = await fetch("/api/rooms", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.detail || "Could not create a room.");
      isHost = true;
      enterRoom(data);
    } catch (error) {
      showError($("#home-error"), error.message);
    } finally {
      setEntryButtonsDisabled(false);
    }
  }

  async function joinRoom() {
    const name = validName();
    if (!name) return;
    const code = roomInput.value.trim().toUpperCase();
    if (!/^[A-HJ-NP-Z2-9]{6}$/.test(code)) {
      showError($("#home-error"), "Enter the six-character room code your friend shared.");
      roomInput.focus();
      return;
    }
    setEntryButtonsDisabled(true);
    showError($("#home-error"), "");
    try {
      const response = await fetch(`/api/rooms/${encodeURIComponent(code)}/join`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.detail || "Could not join that room.");
      isHost = false;
      enterRoom(data);
    } catch (error) {
      showError($("#home-error"), error.message);
    } finally {
      setEntryButtonsDisabled(false);
    }
  }

  function setEntryButtonsDisabled(disabled) {
    $("#create-room").disabled = disabled;
    $("#join-room").disabled = disabled;
  }

  function enterRoom(data) {
    credentials = data;
    localStorage.setItem(storageKey, JSON.stringify({ credentials, isHost }));
    history.replaceState(null, "", `/?room=${encodeURIComponent(credentials.room_code)}`);
    $("#room-code-display").textContent = credentials.room_code;
    homeScreen.classList.add("hidden");
    gameScreen.classList.remove("hidden");
    canvas.focus();
    connect();
  }

  function connect() {
    if (!credentials) return;
    closingIntentionally = false;
    clearTimeout(reconnectTimer);
    setConnectionStatus("Connecting to room…", false);
    const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
    socket = new WebSocket(`${protocol}//${window.location.host}/ws/${credentials.room_code}`);

    socket.addEventListener("open", () => {
      reconnectAttempt = 0;
      socket.send(JSON.stringify({
        type: "join",
        player_id: credentials.player_id,
        token: credentials.token,
      }));
      setConnectionStatus("Connected · live sync on", false);
      inputTimer = window.setInterval(sendInput, 50);
    });

    socket.addEventListener("message", (event) => {
      let message;
      try {
        message = JSON.parse(event.data);
      } catch {
        setConnectionStatus("Received invalid game data.", true);
        return;
      }
      if (message.type === "error") {
        showError($("#game-error"), message.message);
        return;
      }
      receiveState(message);
      showError($("#game-error"), "");
      renderState();
    });

    socket.addEventListener("close", (event) => {
      clearInterval(inputTimer);
      if (closingIntentionally) return;
      if (event.code === 1000 && event.reason === "Player reconnected") {
        closingIntentionally = true;
        setConnectionStatus("This player is active in another tab.", true);
        return;
      }
      setConnectionStatus("Connection lost · reconnecting…", true);
      reconnectAttempt += 1;
      reconnectTimer = window.setTimeout(connect, Math.min(800 * 2 ** reconnectAttempt, 8000));
    });

    socket.addEventListener("error", () => {
      setConnectionStatus("Could not connect · checking the room…", true);
    });
  }

  function sendInput() {
    if (socket?.readyState === WebSocket.OPEN) {
      socket.send(JSON.stringify({ type: "input", controls: { ...controls } }));
    }
  }

  function setConnectionStatus(text, error) {
    const status = $("#connection-status");
    status.classList.toggle("error", error);
    status.lastChild.textContent = ` ${text}`;
  }

  function receiveState(nextState) {
    const now = performance.now();
    if (state) {
      snapshotInterval = Math.max(16, Math.min(100, now - snapshotAt));
      previousState = state.level === nextState.level ? state : nextState;
      if (state.phase === "playing" && nextState.phase === "playing") {
        const sameLevel = state.level === nextState.level;
        const remaining = new Set((nextState.coins || []).map((coin) => `${coin.x},${coin.y}`));
        if (sameLevel) {
          for (const coin of state.coins || []) {
            if (!remaining.has(`${coin.x},${coin.y}`)) {
              burst(coin.x, coin.y, "#ffd166", 12);
              playSound("coin");
            }
          }
          const remainingPowerups = new Set((nextState.powerups || []).map((item) => `${item.x},${item.y},${item.type}`));
          for (const item of state.powerups || []) {
            if (!remainingPowerups.has(`${item.x},${item.y},${item.type}`)) {
              burst(item.x, item.y, powerupColor(item.type), 20);
              playSound("powerup");
            }
          }
        }
        if (nextState.lives < state.lives) {
          shakeUntil = reducedMotion ? 0 : now + 280;
          playSound("damage");
          if ("vibrate" in navigator) navigator.vibrate(90);
        }
        if (nextState.level > state.level) {
          burst(900, 450, "#aab9ff", 44);
          playSound("level");
        }
        if (nextState.phase !== state.phase) {
          playSound(nextState.phase === "won" ? "win" : "damage");
          if (nextState.phase === "won") burst(480, 270, "#ffd166", 90);
        }
      }
    } else {
      previousState = nextState;
    }
    state = nextState;
    snapshotAt = now;
  }

  function renderState() {
    if (!state) return;
    const players = state.players || [];
    $("#crew-count").textContent = `${players.length} / 4`;
    const rosterSignature = JSON.stringify(players.map((player) => [
      player.id,
      player.name,
      player.connected,
      player.id === credentials.player_id && isHost,
      Boolean(player.shield_ticks),
      Boolean(player.boost_ticks),
    ]));
    if (rosterSignature !== playerRosterSignature) {
      playerRosterSignature = rosterSignature;
      playerScoreElements = new Map();
      $("#player-list").replaceChildren(...players.map((player, index) => {
        const item = document.createElement("li");
        item.className = "player-row";
        const avatar = document.createElement("span");
        avatar.className = "player-avatar";
        avatar.style.background = colors[index % colors.length];
        avatar.textContent = player.name.slice(0, 1).toUpperCase();
        const name = document.createElement("span");
        name.className = "player-row-name";
        name.textContent = player.name;
        const role = document.createElement("span");
        role.className = "player-role";
        role.textContent = player.id === credentials.player_id && isHost ? "HOST" : "";
        if (player.id === credentials.player_id && !isHost) role.textContent = "YOU";
        if (player.shield_ticks || player.boost_ticks) {
          const ability = document.createElement("span");
          ability.className = "player-ability";
          ability.textContent = player.shield_ticks ? "🛡" : "⚡";
          ability.title = player.shield_ticks ? "Shield active" : "Speed boost active";
          item.append(avatar, name, role, ability);
        } else {
          item.append(avatar, name, role);
        }
        const score = document.createElement("span");
        score.className = "player-score";
        playerScoreElements.set(player.id, score);
        item.append(score);
        const online = document.createElement("span");
        online.className = `player-status${player.connected ? " online" : ""}`;
        online.setAttribute("aria-label", player.connected ? "online" : "connecting");
        item.append(online);
        return item;
      }));
    }
    for (const player of players) {
      const score = playerScoreElements.get(player.id);
      if (score) score.textContent = Number(player.score || 0).toLocaleString();
    }

    $("#level-display").textContent = `${state.level} / ${state.level_count}`;
    $("#coin-display").textContent = `${(state.coins || []).length} left`;
    $("#score-display").textContent = Number(state.score || 0).toLocaleString();
    if (state.phase === "won" && state.score > highScore) {
      highScore = state.score;
      localStorage.setItem("nean-arena-high-score", String(highScore));
      $("#overlay-kicker").textContent = "NEW CREW HIGH SCORE";
    }
    $("#record-score").textContent = highScore.toLocaleString();
    $("#score-display").title = `Your crew record: ${highScore.toLocaleString()}`;
    const localPlayer = players.find((player) => player.id === credentials.player_id);
    $("#combo-display").textContent = localPlayer?.combo >= 2 ? `×${localPlayer.combo}` : "";
    const abilities = [];
    if (localPlayer?.shield_ticks) abilities.push(`SHIELD ${Math.ceil(localPlayer.shield_ticks / 30)}s`);
    if (localPlayer?.boost_ticks) abilities.push(`BOOST ${Math.ceil(localPlayer.boost_ticks / 30)}s`);
    abilities.push(localPlayer?.dash_cooldown ? `DASH ${Math.ceil(localPlayer.dash_cooldown / 30)}s` : "DASH READY");
    abilities.push("DOUBLE JUMP");
    const abilityDisplay = $("#ability-display");
    abilityDisplay.textContent = abilities.join(" · ");
    abilityDisplay.classList.toggle("ready", !localPlayer?.dash_cooldown);
    abilityDisplay.classList.toggle("boosted", Boolean(localPlayer?.shield_ticks || localPlayer?.boost_ticks));
    $("#lives-display").textContent = "♥ ".repeat(state.lives).trim() || "—";
    $("#lives-display").setAttribute("aria-label", `${state.lives} shared lives`);
    $("#game-title").textContent = state.phase === "playing"
      ? state.level_name
      : state.phase === "won"
        ? "You did it, crew!"
        : state.phase === "lost"
          ? "The crew ran out of lives"
          : "Waiting for your crew";

    const overlay = $("#canvas-overlay");
    const startButton = $("#start-game");
    if (state.phase === "lobby") {
      overlay.classList.remove("hidden");
      $("#overlay-title").textContent = players.length > 1 ? "Your crew is ready" : "Gather your crew";
      $("#overlay-copy").textContent = players.length > 1
        ? "Double-jump, dash through danger, and grab every power-up. Collect every coin, then get everyone to the portal."
        : "Share your room code, then the host can start. Your crew has a double-jump, a dash, and special power-ups.";
      startButton.classList.toggle("hidden", !isHost);
      startButton.textContent = "Start the adventure →";
    } else if (state.phase === "won" || state.phase === "lost") {
      overlay.classList.remove("hidden");
      $("#overlay-title").textContent = state.phase === "won" ? "Level legends!" : "Run over";
      $("#overlay-copy").textContent = state.phase === "won"
        ? "Your crew cleared every level together."
        : "Stick together and watch out for the hazards next time.";
      startButton.classList.toggle("hidden", !isHost);
      startButton.textContent = "Play again →";
    } else {
      overlay.classList.add("hidden");
    }
  }

  function startGame() {
    if (socket?.readyState === WebSocket.OPEN && isHost) {
      socket.send(JSON.stringify({ type: "start" }));
      canvas.focus();
    }
  }

  function draw() {
    requestAnimationFrame(draw);
    if (!state) {
      drawBackdrop();
      return;
    }
    drawWorld(interpolatedState());
  }

  function interpolatedState() {
    if (!previousState || previousState === state || previousState.level !== state.level) return state;
    const alpha = Math.min(1, (performance.now() - snapshotAt) / snapshotInterval);
    const olderPlayers = new Map((previousState.players || []).map((player) => [player.id, player]));
    const players = state.players.map((player) => {
      const older = olderPlayers.get(player.id);
      if (!older) return player;
      return {
        ...player,
        x: older.x + (player.x - older.x) * alpha,
        y: older.y + (player.y - older.y) * alpha,
      };
    });
    const previousEnemy = previousState.enemy;
    const enemy = previousEnemy && state.enemy
      ? {
          ...state.enemy,
          x: previousEnemy.x + (state.enemy.x - previousEnemy.x) * alpha,
        }
      : state.enemy;
    return { ...state, players, enemy };
  }

  const palettes = [
    { sky: ["#25304e", "#44526b"], hills: ["#303c55", "#394862"], ground: "#394c55", grass: "#81db9e", platform: "#43506a", platformTop: "#89e0a1" },
    { sky: ["#191c3b", "#42345e"], hills: ["#2b3055", "#383b67"], ground: "#312a48", grass: "#bd85ff", platform: "#49416a", platformTop: "#c08bff" },
    { sky: ["#322548", "#715078"], hills: ["#4e3a58", "#65465e"], ground: "#45364b", grass: "#ffb077", platform: "#585066", platformTop: "#ffc27f" },
  ];

  function drawBackdrop(level = 1) {
    const palette = palettes[level - 1] || palettes[0];
    const gradient = context.createLinearGradient(0, 0, 0, canvas.height);
    gradient.addColorStop(0, palette.sky[0]);
    gradient.addColorStop(1, palette.sky[1]);
    context.fillStyle = gradient;
    context.fillRect(0, 0, canvas.width, canvas.height);
    drawStars();
    drawHills(palette);
  }

  function drawWorld(game) {
    const shaking = performance.now() < shakeUntil;
    context.save();
    if (shaking) {
      context.translate((Math.random() - 0.5) * 7, (Math.random() - 0.5) * 7);
    }
    drawBackdrop(game.level);
    drawPlatforms(game.platforms || [], game.level);
    drawGround(game.level);
    drawPortal(game.exit, game.exit_active);
    for (const hazard of game.hazards || []) drawHazard(hazard);
    for (const coin of game.coins || []) drawCoin(coin);
    for (const powerup of game.powerups || []) drawPowerup(powerup);
    if (game.enemy) drawEnemy(game.enemy);
    const players = game.players || [];
    players.forEach((player, index) => {
      if (player.connected) drawPlayer(player, index);
    });
    drawParticles();
    context.restore();
  }

  function drawStars() {
    context.save();
    for (let index = 0; index < 38; index += 1) {
      const x = (index * 173 + 31) % canvas.width;
      const y = (index * 83 + 19) % 310;
      context.globalAlpha = 0.28 + (index % 4) * 0.12;
      context.fillStyle = index % 3 === 0 ? "#ffd166" : "#e4e9ff";
      context.fillRect(x, y, index % 5 === 0 ? 3 : 2, index % 5 === 0 ? 3 : 2);
    }
    context.restore();
  }

  function drawHills(palette) {
    context.fillStyle = palette.hills[0];
    context.beginPath();
    context.moveTo(0, 390);
    context.quadraticCurveTo(150, 300, 305, 390);
    context.quadraticCurveTo(450, 320, 615, 385);
    context.quadraticCurveTo(790, 290, 960, 380);
    context.lineTo(960, 490);
    context.lineTo(0, 490);
    context.fill();
    context.fillStyle = palette.hills[1];
    context.beginPath();
    context.moveTo(0, 440);
    context.quadraticCurveTo(200, 360, 370, 440);
    context.quadraticCurveTo(590, 355, 760, 440);
    context.quadraticCurveTo(880, 400, 960, 435);
    context.lineTo(960, 490);
    context.lineTo(0, 490);
    context.fill();
  }

  function drawGround(level = 1) {
    const palette = palettes[level - 1] || palettes[0];
    context.fillStyle = palette.ground;
    context.fillRect(0, 490, 960, 50);
    context.fillStyle = palette.grass;
    context.fillRect(0, 490, 960, 5);
    for (let x = 10; x < 960; x += 38) {
      context.fillStyle = "#527166";
      context.fillRect(x, 512 + (x % 3) * 4, 17, 3);
    }
  }

  function drawPlatforms(platforms, level = 1) {
    const palette = palettes[level - 1] || palettes[0];
    for (const [x, y, width, height] of platforms) {
      context.fillStyle = palette.platform;
      context.fillRect(x, y, width, height);
      context.fillStyle = palette.platformTop;
      context.fillRect(x, y, width, 5);
      context.fillStyle = "rgba(10, 15, 27, .23)";
      context.fillRect(x + 8, y + height - 4, width - 12, 4);
    }
  }

  function drawCoin(coin) {
    const pulse = 1 + Math.sin(performance.now() / 170 + coin.x) * 0.08;
    context.save();
    context.translate(coin.x, coin.y);
    context.scale(pulse, 1);
    context.fillStyle = "rgba(255,209,102,.18)";
    context.beginPath();
    context.arc(0, 0, 17, 0, Math.PI * 2);
    context.fill();
    context.fillStyle = "#ffd166";
    context.beginPath();
    context.arc(0, 0, 10, 0, Math.PI * 2);
    context.fill();
    context.fillStyle = "#fff1bd";
    context.fillRect(-2, -6, 4, 12);
    context.restore();
  }

  function drawPowerup(powerup) {
    const color = powerupColor(powerup.type);
    const pulse = 1 + Math.sin(performance.now() / 210 + powerup.x) * 0.1;
    context.save();
    context.translate(powerup.x, powerup.y + Math.sin(performance.now() / 330 + powerup.y) * 3);
    context.scale(pulse, pulse);
    context.shadowBlur = 18;
    context.shadowColor = color;
    context.fillStyle = "rgba(25,30,47,.92)";
    context.beginPath();
    context.roundRect(-13, -13, 26, 26, 8);
    context.fill();
    context.shadowBlur = 0;
    context.strokeStyle = color;
    context.lineWidth = 2;
    context.stroke();
    context.fillStyle = color;
    context.textAlign = "center";
    context.textBaseline = "middle";
    context.font = "bold 15px system-ui";
    context.fillText(powerup.type === "shield" ? "S" : powerup.type === "boost" ? "⚡" : "+", 0, 1);
    context.restore();
  }

  function powerupColor(type) {
    return type === "shield" ? "#8de9ff" : type === "boost" ? "#ffd166" : "#ff8f9c";
  }

  function drawHazard([x, y, width, height]) {
    const count = Math.max(2, Math.floor(width / 18));
    context.fillStyle = "#ff7975";
    context.beginPath();
    context.moveTo(x, y + height);
    for (let index = 0; index < count; index += 1) {
      const left = x + index * width / count;
      context.lineTo(left + width / count / 2, y);
      context.lineTo(left + width / count, y + height);
    }
    context.closePath();
    context.fill();
    context.fillStyle = "#ffc0a7";
    context.fillRect(x + 2, y + height - 4, width - 4, 3);
  }

  function drawEnemy(enemy) {
    context.fillStyle = "#ff8a75";
    context.beginPath();
    context.roundRect(enemy.x, enemy.y + 6, 34, 28, 12);
    context.fill();
    context.fillStyle = "#ffe6ca";
    context.fillRect(enemy.x + 8, enemy.y + 13, 5, 6);
    context.fillRect(enemy.x + 21, enemy.y + 13, 5, 6);
    context.fillStyle = "#30334a";
    context.fillRect(enemy.x + 10, enemy.y + 15, 2, 3);
    context.fillRect(enemy.x + 23, enemy.y + 15, 2, 3);
  }

  function drawPortal(exit, active) {
    if (!exit) return;
    context.save();
    context.globalAlpha = active ? 1 : 0.38;
    context.fillStyle = active ? "rgba(154,171,255,.2)" : "rgba(135,143,169,.14)";
    context.beginPath();
    context.ellipse(exit.x + exit.width / 2, exit.y + exit.height - 2, 36, 12, 0, 0, Math.PI * 2);
    context.fill();
    context.strokeStyle = active ? "#a5b5ff" : "#82899f";
    context.lineWidth = 5;
    context.beginPath();
    context.roundRect(exit.x + 6, exit.y + 7, exit.width - 12, exit.height - 7, [20, 20, 4, 4]);
    context.stroke();
    context.fillStyle = active ? "#b9c6ff" : "#7f879e";
    context.beginPath();
    context.arc(exit.x + exit.width - 15, exit.y + 35, 2, 0, Math.PI * 2);
    context.fill();
    if (active) {
      context.fillStyle = "#f4f3ff";
      context.font = "bold 12px system-ui";
      context.textAlign = "center";
      context.fillText("EXIT", exit.x + exit.width / 2, exit.y - 7);
    }
    context.restore();
  }

  function drawPlayer(player, index) {
    const color = colors[index % colors.length];
    if (player.invulnerable && Math.floor(performance.now() / 100) % 2 === 0) return;
    if (player.shield_ticks) {
      context.strokeStyle = "rgba(141,233,255,.82)";
      context.lineWidth = 2;
      context.beginPath();
      context.ellipse(player.x + 14, player.y + 23, 23, 26, 0, 0, Math.PI * 2);
      context.stroke();
    }
    if (player.dash_ticks) {
      context.globalAlpha = 0.36;
      context.fillStyle = color;
      context.beginPath();
      context.roundRect(player.x - player.facing * 19, player.y + 12, 19, 24, 6);
      context.fill();
      context.globalAlpha = 1;
    }
    context.fillStyle = "rgba(10, 12, 22, .25)";
    context.beginPath();
    context.ellipse(player.x + 14, player.y + 38, 17, 4, 0, 0, Math.PI * 2);
    context.fill();
    context.fillStyle = color;
    context.beginPath();
    context.roundRect(player.x, player.y + 6, 28, 32, [8, 8, 5, 5]);
    context.fill();
    context.fillStyle = "#f8f2e7";
    context.fillRect(player.x + 6, player.y + 13, 5, 6);
    context.fillRect(player.x + 17, player.y + 13, 5, 6);
    context.fillStyle = "#262b3c";
    context.fillRect(player.x + 8, player.y + 15, 2, 3);
    context.fillRect(player.x + 19, player.y + 15, 2, 3);
    context.fillStyle = "#202437";
    context.fillRect(player.x + 5, player.y + 35, 7, 4);
    context.fillRect(player.x + 17, player.y + 35, 7, 4);
    context.font = "bold 10px system-ui";
    context.textAlign = "center";
    const labelWidth = Math.max(36, context.measureText(player.name).width + 12);
    context.fillStyle = "rgba(17,21,34,.82)";
    context.beginPath();
    context.roundRect(player.x + 14 - labelWidth / 2, player.y - 14, labelWidth, 16, 5);
    context.fill();
    context.fillStyle = color;
    context.fillText(player.name, player.x + 14, player.y - 3);
  }

  function burst(x, y, color, count) {
    if (reducedMotion) return;
    for (let index = 0; index < count && particles.length < 240; index += 1) {
      const angle = Math.random() * Math.PI * 2;
      const speed = 1 + Math.random() * 4;
      particles.push({
        x,
        y,
        vx: Math.cos(angle) * speed,
        vy: Math.sin(angle) * speed - 1.4,
        life: 22 + Math.random() * 22,
        maxLife: 44,
        size: 2 + Math.random() * 4,
        color,
      });
    }
  }

  function drawParticles() {
    for (let index = particles.length - 1; index >= 0; index -= 1) {
      const particle = particles[index];
      particle.x += particle.vx;
      particle.y += particle.vy;
      particle.vy += 0.1;
      particle.vx *= 0.98;
      particle.life -= 1;
      if (particle.life <= 0) {
        particles.splice(index, 1);
        continue;
      }
      context.globalAlpha = particle.life / particle.maxLife;
      context.fillStyle = particle.color;
      context.beginPath();
      context.arc(particle.x, particle.y, particle.size, 0, Math.PI * 2);
      context.fill();
    }
    context.globalAlpha = 1;
  }

  function playSound(effect) {
    if (!soundEnabled) return;
    const AudioContextConstructor = window.AudioContext || window.webkitAudioContext;
    if (!AudioContextConstructor) return;
    audioContext ||= new AudioContextConstructor();
    if (audioContext.state === "suspended") {
      audioContext.resume().catch(() => {
        soundEnabled = false;
        localStorage.setItem(soundKey, "false");
        $("#sound-toggle").textContent = "♫ Sound off";
        $("#sound-toggle").setAttribute("aria-pressed", "false");
      });
    }

    const notes = {
      coin: [[880, 0, 0.09], [1175, 0.055, 0.1]],
      powerup: [[523, 0, 0.12], [659, 0.08, 0.12], [784, 0.16, 0.18]],
      damage: [[170, 0, 0.18], [110, 0.1, 0.22]],
      level: [[523, 0, 0.16], [659, 0.11, 0.16], [784, 0.22, 0.22]],
      win: [[523, 0, 0.2], [659, 0.14, 0.2], [784, 0.28, 0.2], [1047, 0.42, 0.35]],
    }[effect] || [];

    for (const [frequency, delay, duration] of notes) {
      const oscillator = audioContext.createOscillator();
      const volume = audioContext.createGain();
      const start = audioContext.currentTime + delay;
      oscillator.type = "sine";
      oscillator.frequency.setValueAtTime(frequency, start);
      volume.gain.setValueAtTime(0.0001, start);
      volume.gain.exponentialRampToValueAtTime(effect === "damage" ? 0.08 : 0.055, start + 0.012);
      volume.gain.exponentialRampToValueAtTime(0.0001, start + duration);
      oscillator.connect(volume);
      volume.connect(audioContext.destination);
      oscillator.start(start);
      oscillator.stop(start + duration + 0.01);
    }
  }

  function updateKey(event, pressed) {
    const target = event.target;
    if (target instanceof HTMLElement
      && (target.isContentEditable || /^(INPUT|TEXTAREA|SELECT|BUTTON|A)$/.test(target.tagName))) {
      return;
    }
    const key = event.key.toLowerCase();
    const control = key === "arrowleft" || key === "a"
      ? "left"
      : key === "arrowright" || key === "d"
        ? "right"
        : key === "arrowup" || key === " " || key === "w"
          ? "jump"
          : key === "shift" || key === "x"
            ? "dash"
          : null;
    if (!control) return;
    event.preventDefault();
    controls[control] = pressed;
  }

  window.addEventListener("keydown", (event) => updateKey(event, true));
  window.addEventListener("keyup", (event) => updateKey(event, false));
  window.addEventListener("blur", () => {
    for (const key of Object.keys(controls)) controls[key] = false;
  });
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) {
      for (const key of Object.keys(controls)) controls[key] = false;
    }
  });

  document.querySelectorAll("[data-control]").forEach((button) => {
    const control = button.dataset.control;
    button.addEventListener("pointerdown", (event) => {
      event.preventDefault();
      controls[control] = true;
      button.classList.add("pressed");
      button.setPointerCapture(event.pointerId);
    });
    const release = () => {
      controls[control] = false;
      button.classList.remove("pressed");
    };
    button.addEventListener("pointerup", release);
    button.addEventListener("pointercancel", release);
    button.addEventListener("lostpointercapture", release);
  });

  $("#create-room").addEventListener("click", createRoom);
  $("#join-room").addEventListener("click", joinRoom);
  $("#start-game").addEventListener("click", startGame);
  $("#sound-toggle").addEventListener("click", () => {
    soundEnabled = !soundEnabled;
    localStorage.setItem(soundKey, String(soundEnabled));
    $("#sound-toggle").textContent = soundEnabled ? "♫ Sound on" : "♫ Sound off";
    $("#sound-toggle").setAttribute("aria-pressed", String(soundEnabled));
    if (soundEnabled) playSound("powerup");
  });
  $("#copy-invite").addEventListener("click", async () => {
    const button = $("#copy-invite");
    try {
      await navigator.clipboard.writeText(window.location.href);
      button.textContent = "Copied!";
      window.setTimeout(() => { button.textContent = "Copy invite"; }, 1600);
    } catch {
      showError($("#game-error"), "Copy failed. Share the room code instead.");
    }
  });

  $("#leave-room").addEventListener("click", () => {
    closingIntentionally = true;
    clearInterval(inputTimer);
    clearTimeout(reconnectTimer);
    socket?.close(1000, "Player left the room");
    localStorage.removeItem(storageKey);
    credentials = null;
    state = null;
    previousState = null;
    playerRosterSignature = "";
    gameScreen.classList.add("hidden");
    homeScreen.classList.remove("hidden");
    history.replaceState(null, "", "/");
  });

  nameInput.addEventListener("keydown", (event) => {
    if (event.key === "Enter") createRoom();
  });
  roomInput.addEventListener("input", () => {
    roomInput.value = roomInput.value.toUpperCase().replace(/[^A-HJ-NP-Z2-9]/g, "").slice(0, 6);
  });
  roomInput.addEventListener("keydown", (event) => {
    if (event.key === "Enter") joinRoom();
  });

  try {
    $("#sound-toggle").textContent = soundEnabled ? "♫ Sound on" : "♫ Sound off";
    $("#sound-toggle").setAttribute("aria-pressed", String(soundEnabled));
    const saved = JSON.parse(localStorage.getItem(storageKey) || "null");
    const roomInUrl = new URLSearchParams(window.location.search).get("room");
    if (saved?.credentials?.room_code && saved?.credentials?.player_id && saved?.credentials?.token
      && saved.credentials.room_code === roomInUrl?.toUpperCase()) {
      credentials = saved.credentials;
      isHost = saved.isHost === true;
      enterRoom(credentials);
    }
  } catch {
    localStorage.removeItem(storageKey);
  }
  draw();
})();
