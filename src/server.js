import { httpServer } from './http_server/index.js';
import { WebSocketServer } from 'ws';

// In-memory DBs
const players = new Map(); // name -> { password, wins, index }
const rooms = new Map(); // roomId -> { users: [playerIndex], ships: {}, gameId, ... }
const games = new Map(); // gameId -> { ...gameState }
let winners = [];

let playerIndexCounter = 1;
let roomIdCounter = 1;
let gameIdCounter = 1;

const wss = new WebSocketServer({ server: httpServer });

wss.on('connection', (ws) => {
  ws.on('message', (message) => {
    try {
      const strMsg = message.toString();
      const msg = JSON.parse(strMsg);
      if (msg?.data) {
        msg.data = JSON.parse(msg.data);
      }
      console.log('msg', msg)
      console.log(typeof msg)
      handleCommand(ws, msg);
      console.log('Received command:', msg.type, msg.data);
    } catch (e) {
      ws.send({ type: 'error', data: JSON.stringify({ error: true, errorText: 'Invalid JSON' }), id: 0 });
    }
  });

  ws.on('close', () => {
    for (const [roomId, room] of rooms.entries()) {
      if (room.users.includes(ws.playerIndex)) {
        room.users = room.users.filter(idx => idx !== ws.playerIndex);
        if (room.users.length === 0) rooms.delete(roomId);
      }
    }
    for (const [gameId, game] of games.entries()) {
      if (game.players.includes(ws.playerIndex)) {
        game.finished = true;
      }
    }
    sendUpdateRoom();
  });
});

function registerOrLogin(ws, msg) {
  const { name, password } = msg?.data;
  let error = false;
  let errorText = '';
  let index;
  if (!name || !password) {
    error = true;
    errorText = 'Name and password required';
  } else if (players.has(name)) {
    const user = players.get(name);
    if (user.password !== password) {
      error = true;
      errorText = 'Invalid password';
    } else {
      index = user.index;
    }
  } else {
    index = playerIndexCounter++;
    players.set(name, { password, wins: 0, index });
  }
  ws.playerName = name;
  ws.playerIndex = index;
  ws.send(JSON.stringify({
    type: 'reg',
    data: JSON.stringify({ name, index, error, errorText }),
    id: 0,
  }));
  sendUpdateRoom();
  sendUpdateWinners();
}

function sendUpdateRoom() {
  console.log('sendUpdateRoom', rooms)
  const roomList = Array.from(rooms.entries())
  .filter(([_, room]) => room.users.length === 1)
  .map(([roomId, room]) => ({
    roomId,
    roomUsers: room.users.map(idx => {
      const user = Array.from(players.values()).find(u => u.index === idx);
      return { name: user?.name || '', index: idx };
    })
  }));
  console.log('sendUpdateRoom', rooms)
  wss.clients.forEach(client => {
    if (client.readyState === 1) {
      client.send(JSON.stringify({ type: 'update_room', data: JSON.stringify(roomList), id: 0 }));
    }
  });
}

function sendUpdateWinners() {
  winners = Array.from(players.entries()).map(([name, { wins }]) => ({ name, wins }));
  wss.clients.forEach(client => {
    if (client.readyState === 1) {
      client.send(JSON.stringify({ type: 'update_winners', data: winners, id: 0 }));
    }
  });
}

// --- Room Creation ---
function createRoom(ws) {
  const roomId = roomIdCounter++;
  rooms.set(roomId, { users: [ws.playerIndex], ships: {}, gameId: null });
  sendUpdateRoom();
}

// --- Add User to Room ---
function addUserToRoom(ws, msg) {
  const { indexRoom } = msg.data;
  const room = rooms.get(Number(indexRoom));
  if (room && room.users.length === 1) {
    room.users.push(ws.playerIndex);
    // Create game session
    const gameId = gameIdCounter++;
    room.gameId = gameId;
    games.set(gameId, { players: [...room.users], ships: {}, turn: 0, finished: false });
    // Notify both players
    room.users.forEach((playerIdx, i) => {
      const client = Array.from(wss.clients).find(c => c.playerIndex === playerIdx);
      if (client && client.readyState === 1) {
        client.send(JSON.stringify({
          type: 'create_game',
          data: JSON.stringify({ idGame: gameId, idPlayer: playerIdx }),
          id: 0,
        }));
      }
    });
    // Remove room from available list
    sendUpdateRoom();
  }
}

// --- Add Ships ---
function addShips(ws, msg) {
  const { gameId, ships, indexPlayer } = msg.data;
  const game = games.get(Number(gameId));
  if (!game) return;
  if (!game.ships) game.ships = {};
  game.ships[indexPlayer] = ships;
  // Check if both players have sent ships
  if (Object.keys(game.ships).length === 2) {
    // Start game for both players
    game.turn = game.players[0];
    game.finished = false;
    game.hits = {};
    game.hits[game.players[0]] = [];
    game.hits[game.players[1]] = [];
    game.misses = {};
    game.misses[game.players[0]] = [];
    game.misses[game.players[1]] = [];
    game.players.forEach((playerIdx) => {
      const client = Array.from(wss.clients).find(c => c.playerIndex === playerIdx);
      if (client && client.readyState === 1) {
        client.send({
          type: 'start_game',
          data: JSON.stringify({
            ships: game.ships[playerIdx],
            currentPlayerIndex: game.turn,
          }),
          id: 0,
        });
        client.send(JSON.stringify({
          type: 'turn',
          data: JSON.stringify({ currentPlayer: game.turn }),
          id: 0,
        }));
      }
    });
  }
}

// --- Attack Logic ---
function attack(ws, msg) {
  const { gameId, x, y, indexPlayer } = msg.data;
  const game = games.get(Number(gameId));
  if (!game || game.finished) return;
  if (game.turn !== indexPlayer) return; // Not this player's turn
  const enemyIdx = game.players.find(idx => idx !== indexPlayer);
  const enemyShips = game.ships[enemyIdx];
  let status = 'miss';
  // Check if hit any ship
  let hitShip = null;
  for (const ship of enemyShips) {
    const { position, direction, length } = ship;
    for (let i = 0; i < length; i++) {
      const sx = direction ? position.x + i : position.x;
      const sy = direction ? position.y : position.y + i;
      if (sx === x && sy === y) {
        hitShip = ship;
        break;
      }
    }
    if (hitShip) break;
  }
  if (hitShip) {
    status = 'shot';
    if (!game.hits[enemyIdx]) game.hits[enemyIdx] = [];
    game.hits[enemyIdx].push({ x, y });
    // Check if ship is killed
    const shipCells = [];
    for (let i = 0; i < hitShip.length; i++) {
      shipCells.push({
        x: hitShip.direction ? hitShip.position.x + i : hitShip.position.x,
        y: hitShip.direction ? hitShip.position.y : hitShip.position.y + i,
      });
    }
    const allHit = shipCells.every(cell => game.hits[enemyIdx].some(h => h.x === cell.x && h.y === cell.y));
    if (allHit) {
      status = 'killed';
    }
  } else {
    if (!game.misses[indexPlayer]) game.misses[indexPlayer] = [];
    game.misses[indexPlayer].push({ x, y });
  }
  // Send attack result to both players
  game.players.forEach((playerIdx) => {
    const client = Array.from(wss.clients).find(c => c.playerIndex === playerIdx);
    if (client && client.readyState === 1) {
      client.send(JSON.stringify({
        type: 'attack',
        data: JSON.stringify({ position: { x, y }, currentPlayer: indexPlayer, status }),
        id: 0,
      }));
    }
  });
  // If killed all ships
  const allEnemyCells = enemyShips.flatMap(ship => {
    const cells = [];
    for (let i = 0; i < ship.length; i++) {
      cells.push({
        x: ship.direction ? ship.position.x + i : ship.position.x,
        y: ship.direction ? ship.position.y : ship.position.y + i,
      });
    }
    return cells;
  });
  const allHit = allEnemyCells.every(cell => game.hits[enemyIdx]?.some(h => h.x === cell.x && h.y === cell.y));
  if (allHit) {
    game.finished = true;
    // Update winner
    const winner = players.get(ws.playerName);
    if (winner) winner.wins++;
    // Send finish and update_winners
    game.players.forEach((playerIdx) => {
      const client = Array.from(wss.clients).find(c => c.playerIndex === playerIdx);
      if (client && client.readyState === 1) {
        client.send(JSON.stringify({
          type: 'finish',
          data: JSON.stringify({ winPlayer: indexPlayer }),
          id: 0,
        }));
      }
    });
    sendUpdateWinners();
    return;
  }
  // Next turn logic
  if (status === 'miss') {
    game.turn = enemyIdx;
  }
  // Send turn info
  game.players.forEach((playerIdx) => {
    const client = Array.from(wss.clients).find(c => c.playerIndex === playerIdx);
    if (client && client.readyState === 1) {
      client.send(JSON.stringify({
        type: 'turn',
        data: JSON.stringify({ currentPlayer: game.turn }),
        id: 0,
      }));
    }
  });
}

// --- Random Attack Logic ---
function randomAttack(ws, msg) {
  const { gameId, indexPlayer } = msg.data;
  const game = games.get(Number(gameId));
  if (!game || game.finished) return;
  if (game.turn !== indexPlayer) return; // Not this player's turn
  // Find all possible cells to attack
  const enemyIdx = game.players.find(idx => idx !== indexPlayer);
  const enemyShips = game.ships[enemyIdx];
  const allCells = [];
  for (let x = 0; x < 10; x++) {
    for (let y = 0; y < 10; y++) {
      allCells.push({ x, y });
    }
  }
  const alreadyAttacked = [
    ...(game.hits[enemyIdx] || []),
    ...(game.misses[indexPlayer] || [])
  ];
  const availableCells = allCells.filter(cell => !alreadyAttacked.some(a => a.x === cell.x && a.y === cell.y));
  if (availableCells.length === 0) return;
  const randomCell = availableCells[Math.floor(Math.random() * availableCells.length)];
  // Reuse attack logic
  attack(ws, { data: { gameId, x: randomCell.x, y: randomCell.y, indexPlayer } });
}

// Command handler for websocket messages
function handleCommand(ws, msg) {
  switch (msg.type) {
    case 'reg':
      registerOrLogin(ws, msg);
      break;
    case 'create_room':
      createRoom(ws);
      break;
    case 'add_user_to_room':
      addUserToRoom(ws, msg);
      break;
    case 'add_ships':
      addShips(ws, msg);
      break;
    case 'attack':
      attack(ws, msg);
      break;
    case 'randomAttack':
      randomAttack(ws, msg);
      break;
    default:
      ws.send(JSON.stringify({ type: 'error', data: JSON.stringify({ error: true, errorText: 'Unknown command' }), id: 0 }));
  }
}

// TODO: Implement player registration, room management, ship placement, game logic, and responses as per assignment requirements.

const PORT = process.env.PORT || 3000;
httpServer.listen(PORT, () => {
  console.log(`HTTP server listening on http://localhost:${PORT}`);
  console.log(`WebSocket server running on ws://localhost:${PORT}`);
});

// Export for testing
export { wss, players, rooms, games, winners };
