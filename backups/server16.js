const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const { GoogleGenerativeAI } = require('@google/generative-ai');

const myApp = express();
const myServer = http.createServer(myApp);
const myIo = new Server(myServer);

// { roomName: { apiKey, password, prompt, pool[], timer, admins[], users[], intervalId, logs[] } }
let myRooms = {};

// --- Logging Helper ---
function myLog(roomName, message) {
  const timestamp = new Date().toLocaleTimeString();
  const entry = `[${timestamp}] ${message}`;
  console.log(`[${roomName || 'GLOBAL'}] ${entry}`);
  if (roomName && myRooms[roomName]) {
    myRooms[roomName].logs.push(entry);
    // Keep last 200 log entries
    if (myRooms[roomName].logs.length > 200) myRooms[roomName].logs.shift();
    // Broadcast log to all admins in the room
    myRooms[roomName].admins.forEach(admin => {
      myIo.to(admin.id).emit('myServerLog', entry);
    });
  }
}

// --- Server-side room timer ---
// Reset the server-side countdown (reuse existing interval, just reset the counter)
function myResetRoomCountdown(roomName) {
  const myRoom = myRooms[roomName];
  if (!myRoom) return;
  // Signal the timer loop to reset by setting a flag
  myRoom.countdownReset = true;
  myLog(roomName, `Timer reset to ${myRoom.timer}s after manual trigger.`);
}

function myStartRoomTimer(roomName) {
  const myRoom = myRooms[roomName];
  if (!myRoom || myRoom.intervalId) return; // already running

  let countdown = myRoom.timer;
  myIo.to(roomName).emit('myTimerSync', countdown); // initial sync

  myRoom.intervalId = setInterval(async () => {
    // Check if a manual trigger reset the countdown
    if (myRoom.countdownReset) {
      myRoom.countdownReset = false;
      countdown = myRoom.timer;
    }

    countdown--;
    myIo.to(roomName).emit('myTimerSync', countdown);

    if (countdown <= 0) {
      countdown = myRoom.timer;
      myLog(roomName, `Auto-trigger fired. Pool size: ${myRoom.pool.length}`);
      await myHandleAISummary(roomName);
    }
  }, 1000);

  myLog(roomName, `Timer started (${myRoom.timer}s interval).`);
}

function myStopRoomTimer(roomName) {
  const myRoom = myRooms[roomName];
  if (myRoom && myRoom.intervalId) {
    clearInterval(myRoom.intervalId);
    myRoom.intervalId = null;
    myLog(roomName, 'Timer stopped.');
  }
}

myApp.get('/', (req, res) => {
  res.send(myGenerateHTML());
});

myIo.on('connection', (mySocket) => {
  console.log(`[CONNECT] Socket: ${mySocket.id}`);
  mySocket.emit('myTopicList', Object.keys(myRooms));

  // ── ADMIN LOGIN / ROOM CREATION ──────────────────────────────────────────
  mySocket.on('myAdminLogin', (myData) => {
    const { topic, password, key, name, customPrompt, duration } = myData;
    const myRoomName = topic ? topic.trim() : '';
    if (!myRoomName || !name) return;

    if (!myRooms[myRoomName]) {
      // Creating a new room requires key + password
      if (!key || !password) {
        mySocket.emit('myAuthError', 'New rooms require an API key and password.');
        return;
      }
      myRooms[myRoomName] = {
        apiKey: key,
        password: password,
        prompt: customPrompt || 'Summarize these brainstorm ideas into clear themes.',
        pool: [],
        timer: parseInt(duration) || 240,
        admins: [],
        users: [],
        intervalId: null,
        logs: []
      };
      myIo.emit('myTopicList', Object.keys(myRooms));
      myLog(myRoomName, `Room created by "${name}".`);
    }

    const myRoom = myRooms[myRoomName];
    if (password !== myRoom.password) {
      mySocket.emit('myAuthError', 'Incorrect password.');
      return;
    }

    // Prevent duplicate admin entries for same socket
    if (!myRoom.admins.some(a => a.id === mySocket.id)) {
      myRoom.admins.push({ id: mySocket.id, name });
    }
    mySocket.join(myRoomName);

    mySocket.emit('myAdminAuthSuccess', {
      prompt: myRoom.prompt,
      topic: myRoomName,
      duration: myRoom.timer,
      name,
      logs: myRoom.logs  // send existing log history
    });

    myIo.to(myRoomName).emit('myUserUpdate', myRoom.users);
    myIo.to(myRoomName).emit('myAdminUpdate', myRoom.admins.map(a => a.name));

    myLog(myRoomName, `Admin "${name}" joined (${myRoom.admins.length} admin(s) online).`);

    // Start server-side timer if not already running
    myStartRoomTimer(myRoomName);
  });

  // ── USER JOINING ─────────────────────────────────────────────────────────
  mySocket.on('myJoinRoom', (myData) => {
    const { topic, name } = myData;
    if (!name) return;
    if (!myRooms[topic]) {
      mySocket.emit('myAuthError', 'Room not found.');
      return;
    }
    if (!myRooms[topic].users.some(u => u.id === mySocket.id)) {
      myRooms[topic].users.push({ id: mySocket.id, name });
    }
    mySocket.join(topic);
    mySocket.emit('myJoinedSuccess', { topic, name });
    myIo.to(topic).emit('myUserUpdate', myRooms[topic].users);
    myLog(topic, `User "${name}" joined. (${myRooms[topic].users.length} user(s))`);
  });

  // ── CHAT ─────────────────────────────────────────────────────────────────
  mySocket.on('myUserChat', (myData) => {
    const { room, msg, name } = myData;
    if (!myRooms[room] || !msg) return;

    myRooms[room].pool.push(`${name}: ${msg}`);
    mySocket.emit('myLocalEcho', msg);

    const poolSize = myRooms[room].pool.length;
    myRooms[room].admins.forEach(admin => {
      myIo.to(admin.id).emit('myAdminPreview', `${name}: ${msg}`);
      myIo.to(admin.id).emit('myPoolUpdate', poolSize);
    });

    myLog(room, `Idea #${poolSize} from "${name}".`);
  });

  // ── ADMIN: UPDATE SETTINGS ────────────────────────────────────────────────
  mySocket.on('myAdminUpdateSettings', (myData) => {
    const myRoom = myRooms[myData.room];
    if (!myRoom || !myRoom.admins.some(a => a.id === mySocket.id)) return;

    const newDuration = parseInt(myData.duration);
    const durationChanged = newDuration && newDuration !== myRoom.timer;

    myRoom.prompt = myData.prompt || myRoom.prompt;
    if (durationChanged) {
      myRoom.timer = newDuration;
      // Restart timer with new duration
      myStopRoomTimer(myData.room);
      myStartRoomTimer(myData.room);
    }
    myLog(myData.room, `Settings updated by admin. Prompt: "${myRoom.prompt.substring(0, 40)}..." Duration: ${myRoom.timer}s`);
  });

  // ── ADMIN: MANUAL AI TRIGGER ──────────────────────────────────────────────
  mySocket.on('myManualTrigger', async (myRoomName) => {
    if (!myRooms[myRoomName] || !myRooms[myRoomName].admins.some(a => a.id === mySocket.id)) return;
    myLog(myRoomName, `Manual AI trigger by admin.`);
    myResetRoomCountdown(myRoomName); // reset timer for ALL admins in room
    await myHandleAISummary(myRoomName);
  });

  // ── ADMIN: KICK USER ──────────────────────────────────────────────────────
  mySocket.on('myBanishUser', (myData) => {
    const myRoom = myRooms[myData.room];
    if (!myRoom || !myRoom.admins.some(a => a.id === mySocket.id)) return;

    const target = myRoom.users.find(u => u.id === myData.targetId);
    myIo.to(myData.targetId).emit('myForcedExit', 'You have been removed by an admin.');
    myRoom.users = myRoom.users.filter(u => u.id !== myData.targetId);
    myIo.to(myData.room).emit('myUserUpdate', myRoom.users);
    myLog(myData.room, `User "${target ? target.name : myData.targetId}" was kicked.`);
  });

  // ── ADMIN: SHUTDOWN ROOM ──────────────────────────────────────────────────
  mySocket.on('myShutdownRoom', (myRoomName) => {
    const myRoom = myRooms[myRoomName];
    if (!myRoom || !myRoom.admins.some(a => a.id === mySocket.id)) return;

    myLog(myRoomName, `Room shut down by admin.`);
    myStopRoomTimer(myRoomName);
    myIo.to(myRoomName).emit('myForcedExit', 'The session has been ended by an admin.');
    delete myRooms[myRoomName];
    myIo.emit('myTopicList', Object.keys(myRooms));
  });

  // ── DISCONNECT CLEANUP ────────────────────────────────────────────────────
  mySocket.on('disconnect', () => {
    console.log(`[DISCONNECT] Socket: ${mySocket.id}`);
    for (const roomName in myRooms) {
      const myRoom = myRooms[roomName];

      const adminEntry = myRoom.admins.find(a => a.id === mySocket.id);
      if (adminEntry) {
        myRoom.admins = myRoom.admins.filter(a => a.id !== mySocket.id);
        myLog(roomName, `Admin "${adminEntry.name}" disconnected. (${myRoom.admins.length} admin(s) remaining)`);
        myIo.to(roomName).emit('myAdminUpdate', myRoom.admins.map(a => a.name));
        // Stop timer if no admins left
        if (myRoom.admins.length === 0) {
          myStopRoomTimer(roomName);
          myLog(roomName, 'No admins left — timer paused.');
        }
      }

      const userEntry = myRoom.users.find(u => u.id === mySocket.id);
      if (userEntry) {
        myRoom.users = myRoom.users.filter(u => u.id !== mySocket.id);
        myLog(roomName, `User "${userEntry.name}" disconnected.`);
        myIo.to(roomName).emit('myUserUpdate', myRoom.users);
      }
    }
  });
});

// ── AI SUMMARY ────────────────────────────────────────────────────────────────

// Parse the "retry in Xs" delay from a Gemini 429 error message (kept for logging clarity)
function myParseRetryDelay(errMessage) {
  const match = errMessage.match(/retry[^0-9]*(\d+(?:\.\d+)?)\s*s/i);
  return match ? Math.ceil(parseFloat(match[1])) : null;
}

// Notify all admins in a room with a status message
function myNotifyAdmins(roomName, event, payload) {
  const room = myRooms[roomName];
  if (!room) return;
  room.admins.forEach(admin => myIo.to(admin.id).emit(event, payload));
}

async function myHandleAISummary(myRoomName) {
  const myRoom = myRooms[myRoomName];
  if (!myRoom) return;
  if (myRoom.pool.length === 0) {
    myLog(myRoomName, 'AI trigger skipped — pool is empty.');
    return;
  }

  // Guard: don't stack multiple in-flight requests for the same room
  if (myRoom.aiPending) {
    myLog(myRoomName, 'AI request already in progress — skipping duplicate trigger.');
    return;
  }
  myRoom.aiPending = true;

  myLog(myRoomName, `Sending ${myRoom.pool.length} idea(s) to Gemini...`);
  myNotifyAdmins(myRoomName, 'myAiStatus', '⏳ Generating summary...');

  try {
    const myGenAI = new GoogleGenerativeAI(myRoom.apiKey);
    const myModel = myGenAI.getGenerativeModel({ model: 'gemini-2.5-flash-lite' });
    const myInput = `System Prompt: ${myRoom.prompt}\n\nBrainstorm Data:\n${myRoom.pool.join('\n')}`;

    const myResult = await myModel.generateContent(myInput);
    const myText = myResult.response.text();

    myLog(myRoomName, `AI summary received (${myText.length} chars). Pool cleared.`);
    myRoom.pool = [];
    myRoom.aiPending = false;
    myIo.to(myRoomName).emit('myBroadcastSummary', myText);
    myNotifyAdmins(myRoomName, 'myPoolUpdate', 0);
    myNotifyAdmins(myRoomName, 'myAiStatus', '✅ Summary sent!');

  } catch (err) {
    myRoom.aiPending = false;
    const errMsg = err.message || String(err);
    const is429 = errMsg.includes('429') || errMsg.toLowerCase().includes('quota') || errMsg.toLowerCase().includes('rate');
    const retryIn = myParseRetryDelay(errMsg);

    if (is429) {
      const retryHint = retryIn ? ` Gemini suggests retrying in ${retryIn}s.` : '';
      myLog(myRoomName, `Rate limited / quota exceeded.${retryHint} Pool preserved (${myRoom.pool.length} ideas).`);
      myNotifyAdmins(myRoomName, 'myAiStatus', `❌ Quota exceeded — ideas preserved.${retryHint}`);
      myNotifyAdmins(myRoomName, 'myAiError', {
        type: 'quota',
        message: 'Your Gemini API key has exceeded its quota.',
        action: 'Enable billing at https://ai.google.dev/gemini-api/docs/billing or wait for daily reset (midnight PT).',
        retryIn,
        poolPreserved: true,
        poolSize: myRoom.pool.length
      });
    } else {
      myLog(myRoomName, `AI ERROR: ${errMsg.substring(0, 120)}`);
      myNotifyAdmins(myRoomName, 'myAiStatus', `❌ AI Error: ${errMsg.substring(0, 80)}`);
      myNotifyAdmins(myRoomName, 'myAiError', {
        type: 'error',
        message: errMsg.substring(0, 200),
        action: 'Check your API key and try again.',
        poolPreserved: true,
        poolSize: myRoom.pool.length
      });
    }
  }
}

// ── HTML ──────────────────────────────────────────────────────────────────────
function myGenerateHTML() {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <title>Brainstorm Hub</title>
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <style>
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: 'Segoe UI', sans-serif; background: #f0f2f5; padding: 20px; }
    #myApp { max-width: 960px; margin: auto; }
    h2 { text-align: center; color: #1a73e8; padding: 16px 0; font-size: 1.4em; }

    .card { background: white; border-radius: 10px; box-shadow: 0 2px 8px rgba(0,0,0,0.1); padding: 20px; margin-bottom: 16px; }

    /* Auth Panel */
    #myAuthPanel { border-top: 4px solid #ffa726; }
    .auth-section { margin-bottom: 12px; }
    .auth-section label { font-size: 0.8em; color: #666; display: block; margin-bottom: 4px; }
    .auth-row { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; }
    input[type=text], input[type=password], select {
      padding: 9px 12px; border: 1px solid #ccc; border-radius: 6px; font-size: 0.9em;
    }
    button {
      padding: 9px 16px; border: none; border-radius: 6px; cursor: pointer;
      font-size: 0.9em; font-weight: 600; transition: opacity 0.2s;
    }
    button:hover { opacity: 0.85; }
    .btn-primary { background: #1a73e8; color: white; }
    .btn-success { background: #34a853; color: white; }
    .btn-warn { background: #e65100; color: white; }
    .btn-danger { background: #d32f2f; color: white; font-size: 0.8em; }
    #myAuthError { color: #d32f2f; font-size: 0.85em; margin-top: 8px; display: none; }

    /* Admin Dashboard */
    #myAdminDashboard { display: none; border-top: 4px solid #1a73e8; }
    .admin-header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 12px; }
    .timer-badge { background: #d32f2f; color: white; padding: 4px 10px; border-radius: 20px; font-weight: 700; font-size: 0.9em; }
    .admin-grid { display: grid; grid-template-columns: 1fr 160px; gap: 12px; margin-top: 12px; }
    .admin-grid-3 { display: grid; grid-template-columns: 1fr 1fr 1fr; gap: 12px; margin-top: 12px; }
    .panel-box { border: 1px solid #ddd; border-radius: 6px; padding: 8px; }
    .panel-box b { font-size: 0.8em; color: #555; display: block; margin-bottom: 4px; }
    .scroll-box { height: 110px; overflow-y: auto; font-size: 0.78em; line-height: 1.5; }
    #myPoolBadge { background: #1a73e8; color: white; padding: 2px 8px; border-radius: 10px; font-size: 0.8em; margin-left: 6px; }
    #myAiStatusBar { font-size: 0.8em; color: #555; margin-top: 8px; min-height: 1.2em; }

    /* Server Log Panel */
    #myLogPanel { border-top: 4px solid #7b1fa2; }
    #myLogPanel b { color: #7b1fa2; }
    #myServerLogBox { height: 130px; overflow-y: auto; font-size: 0.75em; font-family: monospace; line-height: 1.6; color: #333; }
    #myServerLogBox div { border-bottom: 1px solid #f0f0f0; padding: 1px 0; }

    /* Chat */
    #myChatBox { height: 360px; overflow-y: auto; border: 1px solid #e0e0e0; padding: 15px; background: #fafafa; border-radius: 8px; }
    .msg-ai { background: #e8f0fe; padding: 14px; border-left: 5px solid #1a73e8; margin: 10px 0; border-radius: 0 6px 6px 0; }
    .msg-ai b { color: #1a73e8; }
    .msg-sent { color: #aaa; font-size: 0.8em; margin: 5px 0; font-style: italic; }

    /* Input */
    #myInputArea { display: none; gap: 8px; margin-top: 10px; }
    #myMsg { flex-grow: 1; padding: 12px; border: 1px solid #ccc; border-radius: 6px; font-size: 0.95em; }

    /* Admin list */
    #myAdminList { font-size: 0.8em; color: #555; margin-top: 6px; }
    #myAdminList span { background: #e8f0fe; color: #1a73e8; border-radius: 10px; padding: 2px 8px; margin-right: 4px; display: inline-block; }

    .prompt-row { display: flex; gap: 8px; align-items: center; margin-top: 10px; }
    .prompt-row input { flex: 1; }

    hr { border: none; border-top: 1px solid #eee; margin: 12px 0; }
  </style>
</head>
<body>
<div id="myApp">
  <h2 id="myRoomTitle">🧠 Brainstorm Hub</h2>

  <!-- Auth Panel -->
  <div id="myAuthPanel" class="card">
    <div class="auth-section">
      <label>YOUR NAME</label>
      <input id="myName" type="text" placeholder="Enter your name" style="width:200px;">
    </div>
    <div class="auth-section">
      <label>JOIN EXISTING ROOM AS USER</label>
      <div class="auth-row">
        <select id="myTopicDropdown" style="width:200px;"></select>
        <button class="btn-success" onclick="myJoin()">Join Room</button>
      </div>
    </div>
    <hr>
    <div class="auth-section">
      <label>ADMIN: CREATE OR JOIN A ROOM</label>
      <div class="auth-row">
        <input id="myTop" type="text" placeholder="Room Name" style="width:130px;">
        <input id="myPass" type="password" placeholder="Password" style="width:120px;">
        <input id="myKey" type="password" placeholder="Gemini API Key (new room only)" style="width:200px;">
        <button class="btn-warn" onclick="myLogin()">Admin Login</button>
      </div>
    </div>
    <div id="myAuthError"></div>
  </div>

  <!-- Admin Dashboard -->
  <div id="myAdminDashboard" class="card">
    <div class="admin-header">
      <div>
        <b>ADMIN DASHBOARD</b> — <span id="myAdminName" style="color:#1a73e8;"></span>
        <div id="myAdminList"></div>
      </div>
      <div class="timer-badge">⏱ <span id="myAutoTimer">--</span>s</div>
    </div>

    <!-- Share URL -->
    <div style="background:#e8f5e9; border:1px solid #a5d6a7; border-radius:8px; padding:10px 14px; margin-bottom:12px; display:flex; align-items:center; gap:10px; flex-wrap:wrap;">
      <span style="font-size:0.8em; font-weight:700; color:#2e7d32;">🔗 SHARE WITH PARTICIPANTS</span>
      <code id="myShareUrl" style="flex:1; font-size:0.85em; color:#1b5e20; background:white; border:1px solid #c8e6c9; border-radius:4px; padding:5px 10px; min-width:220px;">https://ai-chat-brainstorm.onrender.com/</code>
      <button onclick="myCopyUrl()" id="myCopyBtn" style="background:#2e7d32; color:white; border:none; border-radius:6px; padding:6px 14px; cursor:pointer; font-size:0.82em; font-weight:700; white-space:nowrap;">📋 Copy Link</button>
    </div>

    <div class="prompt-row">
      <input id="myActivePrompt" type="text" placeholder="System prompt for AI..." onchange="myAdminUpdate()">
      <button class="btn-primary" onclick="myForceAI()">▶ Send to AI Now <span id="myPoolBadge">0</span></button>
      <button class="btn-danger" onclick="myKillRoom()">⛔ Shutdown</button>
    </div>
    <div id="myAiStatusBar"></div>
    <div class="admin-grid">
      <div class="panel-box">
        <b>💬 Live Idea Feed</b>
        <div id="myAdminFeed" class="scroll-box"></div>
      </div>
      <div class="panel-box">
        <b>👥 Users</b>
        <div id="myUserList" class="scroll-box"></div>
      </div>
    </div>
  </div>

  <!-- Server Log Panel (admin only) -->
  <div id="myLogPanel" class="card" style="display:none;">
    <b>🖥 SERVER LOGS</b>
    <div id="myServerLogBox" class="scroll-box" style="margin-top:8px;"></div>
  </div>

  <!-- Chat Box -->
  <div class="card" style="padding:0; overflow:hidden;">
    <div id="myChatBox"></div>
  </div>

  <!-- Input -->
  <div id="myInputArea" style="display:none; gap:8px; margin-top:8px;">
    <input id="myMsg" type="text" placeholder="Type your idea and press Enter..." onkeypress="if(event.key==='Enter') mySend()">
    <button class="btn-success" onclick="mySend()">Send 💡</button>
  </div>
</div>

<script src="/socket.io/socket.io.js"></script>
<script>
  const mySocket = io();
  let myCurrentRoom = null;
  let myIsAdmin = false;
  let myUserName = '';

  // ── TOPIC LIST ──────────────────────────────────────────────────────────
  mySocket.on('myTopicList', (list) => {
    const sel = document.getElementById('myTopicDropdown');
    sel.innerHTML = '<option value="">-- Select Room --</option>';
    list.forEach(t => sel.innerHTML += '<option value="'+t+'">'+t+'</option>');
  });

  // ── AUTH ACTIONS ────────────────────────────────────────────────────────
  function myLogin() {
    myUserName = document.getElementById('myName').value.trim();
    if (!myUserName) return myShowError('Please enter your name.');
    const topic = document.getElementById('myTop').value.trim() || document.getElementById('myTopicDropdown').value;
    if (!topic) return myShowError('Enter or select a room name.');
    mySocket.emit('myAdminLogin', {
      password: document.getElementById('myPass').value,
      key: document.getElementById('myKey').value,
      topic, name: myUserName, duration: 240
    });
  }

  function myJoin() {
    myUserName = document.getElementById('myName').value.trim();
    const t = document.getElementById('myTopicDropdown').value;
    if (!myUserName || !t) return myShowError('Enter your name and select a room.');
    mySocket.emit('myJoinRoom', { topic: t, name: myUserName });
  }

  mySocket.on('myAuthError', (msg) => myShowError(msg));

  function myShowError(msg) {
    const el = document.getElementById('myAuthError');
    el.textContent = '⚠ ' + msg;
    el.style.display = 'block';
    setTimeout(() => el.style.display = 'none', 4000);
  }

  // ── ADMIN AUTH SUCCESS ──────────────────────────────────────────────────
  mySocket.on('myAdminAuthSuccess', (data) => {
    myCurrentRoom = data.topic;
    myIsAdmin = true;
    document.getElementById('myAuthPanel').style.display = 'none';
    document.getElementById('myAdminDashboard').style.display = 'block';
    document.getElementById('myLogPanel').style.display = 'block';
    document.getElementById('myInputArea').style.display = 'flex';
    document.getElementById('myActivePrompt').value = data.prompt;
    document.getElementById('myAdminName').textContent = data.name;
    document.getElementById('myRoomTitle').textContent = '🔧 Admin: ' + myCurrentRoom;
    // Load existing logs
    if (data.logs && data.logs.length) {
      data.logs.forEach(l => myAppendLog(l));
    }
  });

  // ── USER JOIN SUCCESS ───────────────────────────────────────────────────
  mySocket.on('myJoinedSuccess', (data) => {
    myCurrentRoom = data.topic;
    document.getElementById('myAuthPanel').style.display = 'none';
    document.getElementById('myInputArea').style.display = 'flex';
    document.getElementById('myRoomTitle').textContent = '💡 Brainstorming: ' + data.topic;
  });

  // ── TIMER (server-driven) ───────────────────────────────────────────────
  mySocket.on('myTimerSync', (val) => {
    const el = document.getElementById('myAutoTimer');
    if (!el) return;
    const mins = Math.floor(val / 60);
    const secs = String(val % 60).padStart(2, '0');
    el.textContent = mins > 0 ? \`\${mins}:\${secs}\` : \`\${val}s\`;
  });

  // ── ADMIN UPDATES ───────────────────────────────────────────────────────
  mySocket.on('myAdminUpdate', (adminNames) => {
    const el = document.getElementById('myAdminList');
    if (!el) return;
    el.innerHTML = 'Admins online: ' + adminNames.map(n => '<span>'+n+'</span>').join('');
  });

  mySocket.on('myUserUpdate', (users) => {
    const ul = document.getElementById('myUserList');
    if (!ul) return;
    ul.innerHTML = '';
    users.forEach(u => {
      ul.innerHTML += '<div style="display:flex;justify-content:space-between;align-items:center;padding:2px 0;">'
        + u.name
        + (myIsAdmin ? ' <button onclick="myKick(\\'' + u.id + '\\')" style="font-size:0.6em;background:#d32f2f;color:white;border:none;border-radius:3px;padding:1px 4px;cursor:pointer;">kick</button>' : '')
        + '</div>';
    });
  });

  mySocket.on('myPoolUpdate', (count) => {
    document.getElementById('myPoolBadge').textContent = count;
  });

  mySocket.on('myAiStatus', (msg) => {
    document.getElementById('myAiStatusBar').textContent = msg;
  });

  // ── SERVER LOGS ─────────────────────────────────────────────────────────
  mySocket.on('myServerLog', (entry) => myAppendLog(entry));

  function myAppendLog(entry) {
    const box = document.getElementById('myServerLogBox');
    if (!box) return;
    const div = document.createElement('div');
    div.textContent = entry;
    box.appendChild(div);
    box.scrollTop = box.scrollHeight;
  }

  // ── ADMIN CONTROLS ──────────────────────────────────────────────────────
  function myAdminUpdate() {
    mySocket.emit('myAdminUpdateSettings', {
      room: myCurrentRoom,
      prompt: document.getElementById('myActivePrompt').value,
      duration: document.getElementById('myDuration') ? document.getElementById('myDuration').value : 60
    });
  }

  function myForceAI() { mySocket.emit('myManualTrigger', myCurrentRoom); }

  function myCopyUrl() {
    const url = document.getElementById('myShareUrl').textContent;
    navigator.clipboard.writeText(url).then(() => {
      const btn = document.getElementById('myCopyBtn');
      btn.textContent = '✅ Copied!';
      btn.style.background = '#388e3c';
      setTimeout(() => { btn.textContent = '📋 Copy Link'; btn.style.background = '#2e7d32'; }, 2000);
    }).catch(() => {
      // Fallback for older browsers
      const range = document.createRange();
      range.selectNode(document.getElementById('myShareUrl'));
      window.getSelection().removeAllRanges();
      window.getSelection().addRange(range);
      document.execCommand('copy');
      window.getSelection().removeAllRanges();
      document.getElementById('myCopyBtn').textContent = '✅ Copied!';
      setTimeout(() => { document.getElementById('myCopyBtn').textContent = '📋 Copy Link'; }, 2000);
    });
  }

  function myKillRoom() {
    if (confirm('Shut down this room for everyone?')) mySocket.emit('myShutdownRoom', myCurrentRoom);
  }

  window.myKick = (id) => mySocket.emit('myBanishUser', { room: myCurrentRoom, targetId: id });

  // ── CHAT ────────────────────────────────────────────────────────────────
  function mySend() {
    const inp = document.getElementById('myMsg');
    const txt = inp.value.trim();
    if (txt) {
      mySocket.emit('myUserChat', { room: myCurrentRoom, msg: txt, name: myUserName });
      inp.value = '';
    }
  }

  mySocket.on('myLocalEcho', () => {
    const box = document.getElementById('myChatBox');
    box.innerHTML += '<div class="msg-sent">✓ Idea submitted anonymously</div>';
    box.scrollTop = box.scrollHeight;
  });

  mySocket.on('myAdminPreview', (m) => {
    const feed = document.getElementById('myAdminFeed');
    if (!feed) return;
    feed.innerHTML += '<div>• ' + m + '</div>';
    feed.scrollTop = feed.scrollHeight;
  });

  mySocket.on('myBroadcastSummary', (txt) => {
    const box = document.getElementById('myChatBox');
    box.innerHTML += '<div class="msg-ai"><b>✨ AI Summary</b><br>' + txt.replace(/\\n/g,'<br>') + '</div>';
    box.scrollTop = box.scrollHeight;
  });

  mySocket.on('myForcedExit', (msg) => { alert(msg); location.reload(); });

  mySocket.on('myAiError', (data) => {
    const box = document.getElementById('myChatBox');
    const retryHint = data.retryIn ? \` Gemini suggests waiting \${data.retryIn}s before trying again.\` : '';
    box.innerHTML += \`<div style="background:#fff3e0;padding:14px;border-left:5px solid #e65100;margin:10px 0;border-radius:0 6px 6px 0;">
      <b style="color:#e65100;">⚠️ AI \${data.type === 'quota' ? 'Quota' : ''} Error</b><br>
      <span style="font-size:0.9em;">\${data.message}\${retryHint}</span><br>
      <span style="font-size:0.85em;color:#666;">\${data.action}</span>
      \${data.poolPreserved ? '<br><span style="font-size:0.8em;color:#388e3c;">✓ Your ' + data.poolSize + ' idea(s) are preserved — use ▶ Send to AI Now when ready.</span>' : ''}
    </div>\`;
    box.scrollTop = box.scrollHeight;
  });
</script>
</body>
</html>`;
}

myServer.listen(process.env.PORT || 3000, () => {
  console.log(`[SERVER] Running on port ${process.env.PORT || 3000}`);
});
