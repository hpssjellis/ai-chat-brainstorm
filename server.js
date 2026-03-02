const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const myApp = express();
const myServer = http.createServer(myApp);
const myIo = new Server(myServer);

// { roomName: { password, prompt, pool[], timer, quietTimer, quietTimerEnabled, admins[], users[], intervalId, logs[] } }
let myRooms = {};

function myLog(roomName, message) {
  const timestamp = new Date().toLocaleTimeString();
  const entry = `[${timestamp}] ${message}`;
  console.log(`[${roomName || 'GLOBAL'}] ${entry}`);
  if (roomName && myRooms[roomName]) {
    myRooms[roomName].logs.push(entry);
    if (myRooms[roomName].logs.length > 200) myRooms[roomName].logs.shift();
    myRooms[roomName].admins.forEach(admin => {
      myIo.to(admin.id).emit('myServerLog', entry);
    });
  }
}

function myResetRoomCountdown(roomName) {
  const myRoom = myRooms[roomName];
  if (!myRoom) return;
  myRoom.countdownReset = true;
  myLog(roomName, `Timer reset to ${myRoom.timer}s.`);
}

function myStartRoomTimer(roomName) {
  const myRoom = myRooms[roomName];
  if (!myRoom || myRoom.intervalId) return;

  let countdown = myRoom.timer;
  myIo.to(roomName).emit('myTimerSync', countdown);

  myRoom.intervalId = setInterval(async () => {
    if (myRoom.countdownReset) {
      myRoom.countdownReset = false;
      countdown = myRoom.timer;
    }

    countdown--;
    myIo.to(roomName).emit('myTimerSync', countdown);

    if (countdown <= 0) {
      countdown = myRoom.timer;
      myLog(roomName, `Auto-trigger: Requesting AI summary from admins.`);
      myIo.to(roomName).emit('myRequestAdminSummary', { pool: myRoom.pool, prompt: myRoom.prompt, isAuto: true });
    }
  }, 1000);
  myLog(roomName, `Timer started (${myRoom.timer}s).`);
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
  mySocket.emit('myTopicList', Object.keys(myRooms));

  mySocket.on('myAdminLogin', (myData) => {
    const { topic, password, name, customPrompt, duration } = myData;
    const myRoomName = topic ? topic.trim() : '';
    if (!myRoomName || !name) return;

    if (!myRooms[myRoomName]) {
      if (!password) {
        mySocket.emit('myAuthError', 'New rooms require a password.');
        return;
      }
      myRooms[myRoomName] = {
        password: password,
        prompt: customPrompt || 'You are a professional facilitator summarizing a live brainstorming session. Your job is to silently discard any messages that are off-topic, silly, rude, repetitive, or unhelpful — do not mention or acknowledge them. From the remaining substantive ideas, identify the key themes and synthesize them into 3–5 clear, actionable insights. Write in a neutral, constructive tone suitable for a team working toward real solutions. Be concise but specific — avoid vague generalities. End with one bold "synthesis statement" that captures the most promising direction the group seems to be heading.',
        pool: [],
        timer: parseInt(duration) || 240,
        quietTimer: 5,           // FIX 3: quiet timer duration in seconds (0 = disabled)
        quietTimerEnabled: true, // FIX 3: can be toggled off
        admins: [],
        users: [],
        intervalId: null,
        quietTimerId: null,
        firstAdminId: null,
        logs: []
      };
      myIo.emit('myTopicList', Object.keys(myRooms));
    }

    const myRoom = myRooms[myRoomName];
    if (password !== myRoom.password) {
      mySocket.emit('myAuthError', 'Incorrect password.');
      return;
    }

    if (!myRoom.admins.some(a => a.id === mySocket.id)) {
      myRoom.admins.push({ id: mySocket.id, name });
    }
    mySocket.join(myRoomName);

    const myIsFirstAdmin = myRoom.admins.length === 1;
    if (myIsFirstAdmin) myRoom.firstAdminId = mySocket.id;

    mySocket.emit('myAdminAuthSuccess', {
      prompt: myRoom.prompt,
      topic: myRoomName,
      duration: myRoom.timer,
      quietTimer: myRoom.quietTimer,
      quietTimerEnabled: myRoom.quietTimerEnabled,
      name,
      logs: myRoom.logs,
      timerRunning: !!myRoom.intervalId,
      isFirstAdmin: myIsFirstAdmin
    });
    myIo.to(myRoomName).emit('myUserUpdate', myRoom.users);
    myIo.to(myRoomName).emit('myAdminUpdate', myRoom.admins.map(a => a.name));
    if (myIsFirstAdmin) myStartRoomTimer(myRoomName);
  });

  mySocket.on('myJoinRoom', (myData) => {
    const { topic, name } = myData;
    if (!name || !myRooms[topic]) return;
    if (!myRooms[topic].users.some(u => u.id === mySocket.id)) {
      myRooms[topic].users.push({ id: mySocket.id, name });
    }
    mySocket.join(topic);
    mySocket.emit('myJoinedSuccess', { topic, name });
    myIo.to(topic).emit('myUserUpdate', myRooms[topic].users);
  });

  mySocket.on('myUserChat', (myData) => {
    const { room, msg, name } = myData;
    if (!myRooms[room] || !msg) return;
    const myRoom = myRooms[room];

    // FIX 2: Store pool entries as objects so admins can identify and edit/delete them
    const entry = {
      id: Date.now() + '_' + Math.random().toString(36).slice(2, 7),
      name,
      msg,
      text: `${name}: ${msg}`
    };
    myRoom.pool.push(entry);

    mySocket.emit('myLocalEcho', msg);
    myIo.to(room).emit('myPoolUpdate', myRoom.pool.length);
    // FIX 2: Notify admins of the new pool entry so they can review it
    myRoom.admins.forEach(admin => {
      myIo.to(admin.id).emit('myPoolEntry', { id: entry.id, name: entry.name, msg: entry.msg });
    });
    myLog(room, `Idea from "${name}".`);

    // FIX 3: Only run quiet timer if enabled
    if (!myRoom.quietTimerEnabled || myRoom.quietTimer <= 0) return;

    if (myRoom.quietTimerId) clearTimeout(myRoom.quietTimerId);
    myRoom.quietTimerId = setTimeout(() => {
      myRoom.quietTimerId = null;
      if (myRoom.pool.length === 0) return;

      // FIX 3: Quiet timer ALWAYS just broadcasts all messages directly — never calls AI.
      // AI is only triggered by the main countdown timer or manual admin trigger.
      const texts = myRoom.pool.map(e => e.text).join('\n');
      myRoom.pool = [];
      myIo.to(room).emit('myBroadcastSummary', texts);
      myIo.to(room).emit('myPoolUpdate', 0);
      // FIX 2: Clear admin pool view too
      myRoom.admins.forEach(admin => {
        myIo.to(admin.id).emit('myPoolCleared');
      });
      myLog(room, `Quiet timer: broadcast ${myRoom.pool.length > 0 ? myRoom.pool.length : 'all'} idea(s) directly (no AI).`);
    }, myRoom.quietTimer * 1000);
  });

  mySocket.on('myManualTrigger', (myRoomName) => {
    const myRoom = myRooms[myRoomName];
    if (!myRoom) return;
    myResetRoomCountdown(myRoomName);
    myIo.to(mySocket.id).emit('myRequestAdminSummary', { pool: myRoom.pool.map(e => e.text), prompt: myRoom.prompt, isAuto: false });
  });

  // FIX 3: Admin can set quiet timer duration or toggle it on/off
  mySocket.on('myQuietTimerControl', (myData) => {
    const { room, enabled, duration } = myData;
    const myRoom = myRooms[room];
    if (!myRoom) return;
    if (!myRoom.admins.some(a => a.id === mySocket.id)) return;

    if (typeof enabled === 'boolean') {
      myRoom.quietTimerEnabled = enabled;
      myLog(room, `Quiet timer ${enabled ? 'enabled' : 'disabled'} by admin.`);
    }
    if (duration !== undefined) {
      const d = parseInt(duration);
      if (d >= 1 && d <= 300) {
        myRoom.quietTimer = d;
        myLog(room, `Quiet timer duration set to ${d}s by admin.`);
      }
    }
    // Broadcast updated quiet timer settings to all admins
    myRoom.admins.forEach(admin => {
      myIo.to(admin.id).emit('myQuietTimerState', {
        enabled: myRoom.quietTimerEnabled,
        duration: myRoom.quietTimer
      });
    });
  });

  // FIX 2: Admin edits a pool entry before it reaches the AI
  mySocket.on('myEditPoolEntry', (myData) => {
    const { room, id, newMsg } = myData;
    const myRoom = myRooms[room];
    if (!myRoom) return;
    if (!myRoom.admins.some(a => a.id === mySocket.id)) return;
    const entry = myRoom.pool.find(e => e.id === id);
    if (!entry) return;
    entry.msg = newMsg;
    entry.text = `${entry.name}: ${newMsg}`;
    myLog(room, `Admin edited a pool entry from "${entry.name}".`);
    // Confirm edit back to all admins
    myRoom.admins.forEach(admin => {
      myIo.to(admin.id).emit('myPoolEntryUpdated', { id, newMsg });
    });
  });

  // FIX 2: Admin deletes a pool entry before it reaches the AI
  mySocket.on('myDeletePoolEntry', (myData) => {
    const { room, id } = myData;
    const myRoom = myRooms[room];
    if (!myRoom) return;
    if (!myRoom.admins.some(a => a.id === mySocket.id)) return;
    const before = myRoom.pool.length;
    myRoom.pool = myRoom.pool.filter(e => e.id !== id);
    if (myRoom.pool.length < before) {
      myIo.to(room).emit('myPoolUpdate', myRoom.pool.length);
      myRoom.admins.forEach(admin => {
        myIo.to(admin.id).emit('myPoolEntryDeleted', { id });
      });
      myLog(room, `Admin deleted a pool entry.`);
    }
  });

  mySocket.on('myTimerControl', (myData) => {
    const { room, action, duration } = myData;
    const myRoom = myRooms[room];
    if (!myRoom) return;
    if (!myRoom.admins.some(a => a.id === mySocket.id)) return;

    if (action === 'stop') {
      if (mySocket.id !== myRoom.firstAdminId) {
        mySocket.emit('myTimerState', { running: !!myRoom.intervalId, duration: myRoom.timer, secondaryOnly: true });
        return;
      }
      myStopRoomTimer(room);
      myIo.to(room).emit('myTimerState', { running: false, duration: myRoom.timer });
    } else if (action === 'start') {
      if (mySocket.id !== myRoom.firstAdminId) {
        mySocket.emit('myTimerState', { running: !!myRoom.intervalId, duration: myRoom.timer, secondaryOnly: true });
        return;
      }
      myStartRoomTimer(room);
      myIo.to(room).emit('myTimerState', { running: true, duration: myRoom.timer });
    } else if (action === 'setDuration') {
      const newDur = parseInt(duration);
      if (!newDur || newDur < 10) return;
      myRoom.timer = newDur;
      myRoom.countdownReset = true;
      myLog(room, `Timer duration changed to ${newDur}s by admin.`);
      myIo.to(room).emit('myTimerState', { running: !!myRoom.intervalId, duration: newDur });
    }
  });

  // FIX 1: Admin kick — already worked, no change needed; included for completeness
  mySocket.on('myKickUser', (myData) => {
    const { room, userId } = myData;
    const myRoom = myRooms[room];
    if (!myRoom) return;
    if (!myRoom.admins.some(a => a.id === mySocket.id)) return;
    const kicked = myRoom.users.find(u => u.id === userId);
    myRoom.users = myRoom.users.filter(u => u.id !== userId);
    myIo.to(userId).emit('myRoomShutdown', 'You have been removed from the room by an admin.');
    myIo.sockets.sockets.get(userId)?.leave(room);
    myIo.to(room).emit('myUserUpdate', myRoom.users);
    myLog(room, `User "${kicked?.name || userId}" kicked by admin.`);
  });

  mySocket.on('myShutdownRoom', (room) => {
    const myRoom = myRooms[room];
    if (!myRoom) return;
    if (!myRoom.admins.some(a => a.id === mySocket.id)) return;
    myStopRoomTimer(room);
    myIo.to(room).emit('myRoomShutdown', 'The room has been closed by an admin.');
    myLog(room, 'Room shut down by admin.');
    delete myRooms[room];
    myIo.emit('myTopicList', Object.keys(myRooms));
  });

  mySocket.on('myLeaveRoom', (room) => {
    const myRoom = myRooms[room];
    if (!myRoom) return;
    myRoom.users = myRoom.users.filter(u => u.id !== mySocket.id);
    myRoom.admins = myRoom.admins.filter(a => a.id !== mySocket.id);
    mySocket.leave(room);
    if (myRoom.admins.length === 0) myStopRoomTimer(room);
    myIo.to(room).emit('myUserUpdate', myRoom.users);
    myIo.to(room).emit('myAdminUpdate', myRoom.admins.map(a => a.name));
    mySocket.emit('myLeftRoom');
  });

  mySocket.on('mySubmitFinishedSummary', (myData) => {
    const { room, text } = myData;
    if (!myRooms[room]) return;
    if (myRooms[room].quietTimerId) { clearTimeout(myRooms[room].quietTimerId); myRooms[room].quietTimerId = null; }
    myRooms[room].pool = [];
    myIo.to(room).emit('myBroadcastSummary', text);
    myIo.to(room).emit('myPoolUpdate', 0);
    // FIX 2: Clear admin pool panel after broadcast
    myRooms[room].admins.forEach(admin => {
      myIo.to(admin.id).emit('myPoolCleared');
    });
    myLog(room, `AI Summary broadcasted by admin.`);
  });

  mySocket.on('disconnect', () => {
    for (const roomName in myRooms) {
      const myRoom = myRooms[roomName];
      myRoom.admins = myRoom.admins.filter(a => a.id !== mySocket.id);
      myRoom.users = myRoom.users.filter(u => u.id !== mySocket.id);
      if (myRoom.admins.length === 0) myStopRoomTimer(roomName);
      myIo.to(roomName).emit('myAdminUpdate', myRoom.admins.map(a => a.name));
      myIo.to(roomName).emit('myUserUpdate', myRoom.users);
    }
  });
});

function myGenerateHTML() {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <title>🧠 Brainstorm Hub</title>
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <link href="https://fonts.googleapis.com/css2?family=Space+Mono:wght@400;700&family=Syne:wght@400;600;800&display=swap" rel="stylesheet">
  <style>
    :root {
      --ink: #0d0d0d;
      --paper: #f5f2eb;
      --accent: #e84c1e;
      --accent2: #1a6cf5;
      --muted: #888;
      --border: #d0ccc2;
      --admin-bg: #0d1117;
      --admin-fg: #c9d1d9;
      --admin-accent: #58a6ff;
      --admin-warn: #f0883e;
      --admin-success: #3fb950;
      --card-shadow: 0 1px 3px rgba(0,0,0,0.12), 0 4px 12px rgba(0,0,0,0.08);
    }

    * { box-sizing: border-box; margin: 0; padding: 0; }

    body {
      font-family: 'Syne', sans-serif;
      background: var(--paper);
      color: var(--ink);
      min-height: 100vh;
    }

    #myHeader {
      background: var(--ink);
      color: white;
      padding: 16px 24px;
      display: flex;
      align-items: center;
      justify-content: space-between;
      position: sticky;
      top: 0;
      z-index: 100;
    }
    #myHeader h1 { font-size: 1.2rem; font-weight: 800; letter-spacing: -0.02em; }
    #myHeader h1 span { color: var(--accent); }
    #myRoomBadge {
      font-family: 'Space Mono', monospace;
      font-size: 0.75rem;
      background: rgba(255,255,255,0.1);
      padding: 4px 10px;
      border-radius: 20px;
      display: none;
    }
    #myAiReadyBadge {
      font-family: 'Space Mono', monospace;
      font-size: 0.7rem;
      padding: 3px 8px;
      border-radius: 20px;
      background: #333;
      color: #888;
      transition: all 0.3s;
    }
    #myAiReadyBadge.ready { background: rgba(63,185,80,0.2); color: var(--admin-success); }
    #myAiReadyBadge.loading { background: rgba(88,166,255,0.2); color: var(--admin-accent); }
    #myAiReadyBadge.error { background: rgba(248,81,73,0.2); color: #f85149; }

    #myMainLayout {
      display: grid;
      grid-template-columns: 1fr;
      gap: 0;
      max-width: 1100px;
      margin: 0 auto;
      padding: 24px 16px;
    }
    @media (min-width: 900px) {
      #myMainLayout { grid-template-columns: 1fr 360px; gap: 24px; }
    }

    .my-card {
      background: white;
      border: 1px solid var(--border);
      border-radius: 12px;
      padding: 20px;
      margin-bottom: 16px;
      box-shadow: var(--card-shadow);
    }
    .my-card-title {
      font-size: 0.7rem;
      font-weight: 700;
      letter-spacing: 0.1em;
      text-transform: uppercase;
      color: var(--muted);
      margin-bottom: 14px;
    }

    #myAuthPanel .my-tabs {
      display: flex;
      gap: 4px;
      margin-bottom: 16px;
      background: #f0ede6;
      border-radius: 8px;
      padding: 4px;
    }
    .my-tab {
      flex: 1;
      padding: 8px;
      border: none;
      border-radius: 6px;
      cursor: pointer;
      font-family: 'Syne', sans-serif;
      font-weight: 600;
      font-size: 0.85rem;
      background: transparent;
      color: var(--muted);
      transition: all 0.2s;
    }
    .my-tab.active { background: white; color: var(--ink); box-shadow: 0 1px 3px rgba(0,0,0,0.15); }
    #myJoinPanel, #myAdminSetupPanel { display: none; }
    #myJoinPanel.active, #myAdminSetupPanel.active { display: block; }

    .my-input {
      width: 100%;
      padding: 10px 14px;
      border: 1.5px solid var(--border);
      border-radius: 8px;
      font-family: 'Syne', sans-serif;
      font-size: 0.9rem;
      background: #fafaf8;
      color: var(--ink);
      transition: border-color 0.2s;
      margin-bottom: 10px;
    }
    .my-input:focus { outline: none; border-color: var(--accent2); background: white; }
    .my-input-row { display: flex; gap: 8px; }
    .my-input-row .my-input { margin-bottom: 0; }

    .my-btn {
      padding: 10px 18px;
      border: none;
      border-radius: 8px;
      font-family: 'Syne', sans-serif;
      font-weight: 700;
      font-size: 0.85rem;
      cursor: pointer;
      transition: all 0.15s;
      white-space: nowrap;
    }
    .my-btn:active { transform: scale(0.97); }
    .my-btn-primary { background: var(--accent2); color: white; }
    .my-btn-primary:hover { background: #0d5de6; }
    .my-btn-danger { background: var(--accent); color: white; }
    .my-btn-danger:hover { background: #c93d10; }
    .my-btn-dark { background: var(--ink); color: white; }
    .my-btn-dark:hover { background: #333; }
    .my-btn-ghost { background: transparent; color: var(--ink); border: 1.5px solid var(--border); }
    .my-btn-ghost:hover { border-color: var(--ink); }
    .my-btn-full { width: 100%; }
    .my-btn:disabled { opacity: 0.5; cursor: not-allowed; }

    #myTimerBar { display: none; margin-bottom: 16px; }
    #myTimerBarInner {
      height: 6px;
      background: var(--accent2);
      border-radius: 3px;
      transition: width 1s linear, background 0.5s;
      width: 100%;
    }
    #myTimerBarInner.urgent { background: var(--accent); }
    #myTimerText {
      font-family: 'Space Mono', monospace;
      font-size: 0.75rem;
      color: var(--muted);
      text-align: right;
      margin-top: 4px;
    }

    #myChatBox {
      height: 380px;
      overflow-y: auto;
      padding: 12px;
      display: flex;
      flex-direction: column;
      gap: 8px;
      scroll-behavior: smooth;
    }
    .my-msg-user {
      background: #f0f0f0;
      padding: 8px 12px;
      border-radius: 8px;
      font-size: 0.85rem;
      color: #555;
      font-family: 'Space Mono', monospace;
      border-left: 3px solid var(--border);
    }
    .my-msg-user .my-msg-label { font-size: 0.7rem; color: #aaa; margin-bottom: 2px; }
    .my-msg-ai {
      background: linear-gradient(135deg, #eef4ff 0%, #f0f7ff 100%);
      padding: 14px 16px;
      border-radius: 10px;
      border-left: 4px solid var(--accent2);
      animation: mySlideIn 0.4s ease;
    }
    .my-msg-ai-header {
      font-size: 0.7rem;
      font-weight: 700;
      letter-spacing: 0.08em;
      text-transform: uppercase;
      color: var(--accent2);
      margin-bottom: 8px;
      display: flex;
      align-items: center;
      gap: 6px;
    }
    .my-msg-ai-body { font-size: 0.88rem; line-height: 1.65; color: var(--ink); white-space: pre-wrap; }
    @keyframes mySlideIn {
      from { opacity: 0; transform: translateY(10px); }
      to { opacity: 1; transform: translateY(0); }
    }
    #myEmptyState {
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      height: 100%;
      color: var(--muted);
      gap: 8px;
      font-size: 0.85rem;
    }
    #myEmptyState .my-icon { font-size: 2.5rem; }

    #myInputArea { display: none; margin-top: 12px; }
    #myInputArea .my-input-row { align-items: center; }
    #myMsg { flex: 1; margin-bottom: 0; }

    #myAdminDashboard {
      display: none;
      background: var(--admin-bg);
      color: var(--admin-fg);
      border: 1px solid #30363d;
      border-radius: 12px;
      padding: 20px;
      margin-bottom: 16px;
      box-shadow: var(--card-shadow);
    }
    #myAdminDashboard .my-card-title { color: #586069; }
    #myAdminDashboard label { font-size: 0.85rem; color: var(--admin-fg); }

    .my-admin-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; margin-bottom: 14px; }
    .my-stat-box { background: #161b22; border: 1px solid #30363d; border-radius: 8px; padding: 12px; text-align: center; }
    .my-stat-num { font-family: 'Space Mono', monospace; font-size: 1.8rem; font-weight: 700; color: var(--admin-accent); line-height: 1; }
    .my-stat-label { font-size: 0.68rem; color: #586069; margin-top: 4px; text-transform: uppercase; letter-spacing: 0.06em; }

    .my-admin-input {
      width: 100%;
      padding: 9px 13px;
      border: 1px solid #30363d;
      border-radius: 8px;
      font-family: 'Space Mono', monospace;
      font-size: 0.8rem;
      background: #161b22;
      color: var(--admin-fg);
      margin-bottom: 10px;
      transition: border-color 0.2s;
    }
    .my-admin-input:focus { outline: none; border-color: var(--admin-accent); }

    .my-admin-btn {
      padding: 9px 16px;
      border: none;
      border-radius: 7px;
      font-family: 'Syne', sans-serif;
      font-weight: 700;
      font-size: 0.82rem;
      cursor: pointer;
      transition: all 0.15s;
    }
    .my-admin-btn:active { transform: scale(0.97); }
    .my-admin-btn-blue { background: var(--admin-accent); color: #0d1117; }
    .my-admin-btn-blue:hover { background: #79c0ff; }
    .my-admin-btn-orange { background: var(--admin-warn); color: #0d1117; }
    .my-admin-btn-orange:hover { background: #ffa657; }
    .my-admin-btn-green { background: var(--admin-success); color: #0d1117; }
    .my-admin-btn-green:hover { background: #56d364; }
    .my-admin-btn-full { width: 100%; }
    .my-admin-btn:disabled { opacity: 0.4; cursor: not-allowed; }

    #myAiStatus {
      font-family: 'Space Mono', monospace;
      font-size: 0.75rem;
      color: var(--admin-accent);
      min-height: 18px;
      margin: 8px 0;
      transition: color 0.3s;
    }
    #myAiStatus.error { color: #f85149; }
    #myAiStatus.success { color: var(--admin-success); }
    #myAiTimer { font-family: 'Space Mono', monospace; font-size: 0.75rem; color: #586069; }

    #myReviewArea {
      display: none;
      background: #161b22;
      border: 1px solid #f0883e55;
      border-radius: 8px;
      padding: 14px;
      margin: 12px 0;
      animation: mySlideIn 0.3s ease;
    }
    #myReviewArea .my-review-header {
      font-size: 0.7rem;
      font-weight: 700;
      letter-spacing: 0.08em;
      text-transform: uppercase;
      color: var(--admin-warn);
      margin-bottom: 10px;
      display: flex;
      align-items: center;
      gap: 6px;
    }
    #myAiReviewText {
      width: 100%;
      min-height: 120px;
      padding: 10px;
      border: 1px solid #30363d;
      border-radius: 6px;
      background: #0d1117;
      color: var(--admin-fg);
      font-family: 'Space Mono', monospace;
      font-size: 0.8rem;
      line-height: 1.5;
      resize: vertical;
      margin-bottom: 10px;
    }
    #myAiReviewText:focus { outline: none; border-color: var(--admin-warn); }

    /* ── FIX 2: Pool Management Panel ── */
    #myPoolPanel {
      display: none;
      background: #161b22;
      border: 1px solid #30363d;
      border-radius: 8px;
      padding: 12px;
      margin: 10px 0;
      max-height: 240px;
      overflow-y: auto;
    }
    .my-pool-entry {
      display: flex;
      align-items: flex-start;
      gap: 8px;
      padding: 7px 0;
      border-bottom: 1px solid #21262d;
    }
    .my-pool-entry:last-child { border-bottom: none; }
    .my-pool-entry-name {
      font-family: 'Space Mono', monospace;
      font-size: 0.7rem;
      color: var(--admin-accent);
      white-space: nowrap;
      padding-top: 2px;
      min-width: 60px;
    }
    .my-pool-entry-msg {
      flex: 1;
      font-family: 'Space Mono', monospace;
      font-size: 0.75rem;
      color: var(--admin-fg);
      background: transparent;
      border: 1px solid transparent;
      border-radius: 4px;
      padding: 2px 5px;
      resize: none;
      line-height: 1.4;
    }
    .my-pool-entry-msg:focus { outline: none; border-color: #30363d; background: #0d1117; }
    .my-pool-entry-actions { display: flex; gap: 4px; flex-shrink: 0; }
    .my-pool-save-btn, .my-pool-del-btn {
      padding: 2px 7px;
      font-size: 0.68rem;
      border: none;
      border-radius: 4px;
      cursor: pointer;
      font-family: 'Syne', sans-serif;
      font-weight: 700;
    }
    .my-pool-save-btn { background: #238636; color: white; display: none; }
    .my-pool-save-btn:hover { background: #2ea043; }
    .my-pool-del-btn { background: #6e2020; color: #f85149; }
    .my-pool-del-btn:hover { background: #8b2020; }
    #myPoolEmpty {
      font-family: 'Space Mono', monospace;
      font-size: 0.75rem;
      color: #586069;
      text-align: center;
      padding: 12px 0;
    }

    #myLogArea {
      display: none;
      background: #0d1117;
      border: 1px solid #30363d;
      border-radius: 8px;
      padding: 10px;
      max-height: 140px;
      overflow-y: auto;
      margin-top: 10px;
    }
    .my-log-entry {
      font-family: 'Space Mono', monospace;
      font-size: 0.7rem;
      color: #586069;
      padding: 2px 0;
      border-bottom: 1px solid #161b22;
    }
    .my-log-entry:last-child { border-bottom: none; }

    #mySidePanel { display: none; }

    .my-presence-list { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 8px; }
    .my-presence-chip {
      padding: 4px 10px;
      border-radius: 20px;
      font-size: 0.75rem;
      font-weight: 600;
      background: #f0ede6;
      color: var(--ink);
      border: 1px solid var(--border);
    }
    .my-presence-chip.admin { background: #fff3e0; border-color: #ffcc80; color: #e65100; }
    .my-presence-chip.kickable {
      cursor: pointer;
      display: flex;
      align-items: center;
      gap: 5px;
      transition: background 0.15s, border-color 0.15s;
    }
    .my-presence-chip.kickable:hover { background: #ffeaea; border-color: #ffcdd2; color: #b71c1c; }
    .my-presence-chip.kickable .my-kick-x { font-size: 0.7rem; opacity: 0.5; }

    #myAiNotice {
      background: #fff8e1;
      border: 1px solid #ffe082;
      border-radius: 8px;
      padding: 12px 14px;
      font-size: 0.8rem;
      color: #795548;
      margin-bottom: 10px;
      display: none;
    }
    #myAiNotice a { color: var(--accent2); }

    .my-toggle-row { display: flex; align-items: center; gap: 10px; padding: 8px 0; }
    .my-toggle { position: relative; width: 36px; height: 20px; flex-shrink: 0; }
    .my-toggle input { opacity: 0; width: 0; height: 0; }
    .my-toggle-slider { position: absolute; inset: 0; background: #30363d; border-radius: 20px; transition: 0.2s; cursor: pointer; }
    .my-toggle-slider::before { content: ''; position: absolute; width: 14px; height: 14px; left: 3px; top: 3px; background: white; border-radius: 50%; transition: 0.2s; }
    .my-toggle input:checked + .my-toggle-slider { background: var(--admin-accent); }
    .my-toggle input:checked + .my-toggle-slider::before { transform: translateX(16px); }

    .my-error-msg {
      background: #ffeaea;
      border: 1px solid #ffcdd2;
      color: #b71c1c;
      padding: 10px 14px;
      border-radius: 8px;
      font-size: 0.85rem;
      margin-bottom: 10px;
      display: none;
    }

    .my-divider { border: none; border-top: 1px solid var(--border); margin: 14px 0; }

    #myTimerControls {
      display: flex;
      align-items: center;
      gap: 8px;
      flex-wrap: wrap;
      background: #161b22;
      border: 1px solid #30363d;
      border-radius: 8px;
      padding: 10px 12px;
      margin-bottom: 8px;
    }
    #myTimerControls .my-tc-label { font-size: 0.68rem; text-transform: uppercase; letter-spacing: 0.07em; color: #586069; }
    #myDurationInput {
      width: 72px;
      padding: 5px 8px;
      border: 1px solid #30363d;
      border-radius: 5px;
      font-family: 'Space Mono', monospace;
      font-size: 0.8rem;
      background: #0d1117;
      color: var(--admin-fg);
      text-align: center;
    }
    #myDurationInput:focus { outline: none; border-color: var(--admin-accent); }

    /* FIX 3: Quiet timer controls row */
    #myQuietTimerControls {
      display: flex;
      align-items: center;
      gap: 8px;
      flex-wrap: wrap;
      background: #161b22;
      border: 1px solid #30363d;
      border-radius: 8px;
      padding: 10px 12px;
      margin-bottom: 12px;
    }
    #myQuietTimerControls .my-tc-label { font-size: 0.68rem; text-transform: uppercase; letter-spacing: 0.07em; color: #586069; }
    #myQuietDurationInput {
      width: 60px;
      padding: 5px 8px;
      border: 1px solid #30363d;
      border-radius: 5px;
      font-family: 'Space Mono', monospace;
      font-size: 0.8rem;
      background: #0d1117;
      color: var(--admin-fg);
      text-align: center;
    }
    #myQuietDurationInput:focus { outline: none; border-color: var(--admin-accent); }
    #myQuietStatusDot {
      width: 8px; height: 8px;
      border-radius: 50%;
      background: #586069;
      flex-shrink: 0;
    }
    #myQuietStatusDot.on { background: var(--admin-success); box-shadow: 0 0 6px var(--admin-success); }

    #myTimerRunningDot {
      width: 8px; height: 8px;
      border-radius: 50%;
      background: #586069;
      flex-shrink: 0;
      transition: background 0.3s;
    }
    #myTimerRunningDot.running {
      background: var(--admin-success);
      box-shadow: 0 0 6px var(--admin-success);
      animation: myPulse 1.4s infinite;
    }
    @keyframes myPulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.4; } }

    #myDangerZone { border-top: 1px solid #30363d; margin-top: 12px; padding-top: 12px; }
    .my-admin-btn-red { background: #da3633; color: white; }
    .my-admin-btn-red:hover { background: #f85149; }

    #myLeaveBtn { display: none; margin-top: 10px; }

    #myAiReviewText { resize: vertical; }
    #myMsg { resize: none; }

    ::-webkit-scrollbar { width: 5px; }
    ::-webkit-scrollbar-track { background: transparent; }
    ::-webkit-scrollbar-thumb { background: var(--border); border-radius: 3px; }
  </style>
</head>
<body>

  <div id="myHeader">
    <h1>🧠 Brainstorm<span>Hub</span></h1>
    <div style="display:flex; align-items:center; gap:10px;">
      <div id="myAiReadyBadge">AI: checking…</div>
      <div id="myRoomBadge">—</div>
    </div>
  </div>

  <div id="myMainLayout">

    <div>

      <!-- Auth Panel -->
      <div id="myAuthPanel" class="my-card">
        <div class="my-card-title">Join a Session</div>
        <div class="my-tabs">
          <button class="my-tab active" id="myTabJoinBtn">Join as Participant</button>
          <button class="my-tab" id="myTabAdminBtn">Admin / Create Room</button>
        </div>
        <div id="myJoinPanel" class="active">
          <input id="myName" type="text" class="my-input" placeholder="Your name">
          <select id="myTopicDropdown" class="my-input"></select>
          <div id="myJoinError" class="my-error-msg"></div>
          <button class="my-btn my-btn-primary my-btn-full" id="myJoinBtn">Enter Room →</button>
        </div>
        <div id="myAdminSetupPanel">
          <input id="myAdminName" type="text" class="my-input" placeholder="Your name">
          <input id="myTop" type="text" class="my-input" placeholder="Room name (create or join existing)">
          <input id="myPass" type="password" class="my-input" placeholder="Room password">
          <input id="myCustomPrompt" type="text" class="my-input" placeholder="AI prompt (optional)">
          <div id="myAdminError" class="my-error-msg"></div>
          <button class="my-btn my-btn-dark my-btn-full" id="myAdminLoginBtn">Create / Enter Room →</button>
        </div>
      </div>

      <!-- Timer Bar -->
      <div id="myTimerBar">
        <div id="myTimerBarInner"></div>
        <div id="myTimerText">—</div>
      </div>

      <!-- Admin Dashboard -->
      <div id="myAdminDashboard">
        <div class="my-card-title">⚡ Admin Dashboard</div>

        <!-- Share URL Bar -->
        <div id="myShareBar" style="display:none; background:#161b22; border:1px solid #30363d; border-radius:8px; padding:10px 12px; margin-bottom:12px; align-items:center; gap:8px; flex-wrap:wrap;">
          <span style="font-size:0.68rem;text-transform:uppercase;letter-spacing:0.08em;color:#586069;white-space:nowrap;">Share URL</span>
          <input id="myShareUrl" type="text" readonly style="flex:1; min-width:120px; font-family:'Space Mono',monospace; font-size:0.75rem; color:#58a6ff; background:#0d1117; border:1px solid #30363d; border-radius:5px; padding:5px 9px; cursor:text;">
          <button id="myCopyUrlBtn" style="padding:5px 12px; background:#30363d; border:none; border-radius:5px; color:#c9d1d9; font-family:'Syne',sans-serif; font-size:0.75rem; font-weight:700; cursor:pointer; white-space:nowrap;">Copy</button>
        </div>

        <div class="my-admin-grid">
          <div class="my-stat-box">
            <div class="my-stat-num" id="myIdeasCount">0</div>
            <div class="my-stat-label">Ideas in Pool</div>
          </div>
          <div class="my-stat-box">
            <div class="my-stat-num" id="myTimerDisplay">—</div>
            <div class="my-stat-label">Seconds Left</div>
          </div>
        </div>

        <!-- Main Timer Controls -->
        <div id="myTimerControls">
          <div id="myTimerRunningDot"></div>
          <span class="my-tc-label" id="myMainTimerLabel">Main Timer</span>
          <button id="myTimerToggleBtn" class="my-admin-btn my-admin-btn-blue" style="padding:5px 12px; font-size:0.78rem;">▶ Start</button>
          <input id="myDurationInput" type="number" min="10" max="3600" placeholder="sec" style="width:72px; padding:5px 8px; border:1px solid #30363d; border-radius:5px; font-family:'Space Mono',monospace; font-size:0.8rem; background:#0d1117; color:#c9d1d9; text-align:center;">
          <button id="mySetDurationBtn" class="my-admin-btn" style="background:#30363d; color:#c9d1d9; padding:5px 12px; font-size:0.78rem;">Set</button>
        </div>

        <!-- FIX 3: Quiet Timer Controls -->
        <div id="myQuietTimerControls">
          <div id="myQuietStatusDot"></div>
          <span class="my-tc-label">Quiet Timer</span>
          <label class="my-toggle" title="Toggle quiet timer on/off">
            <input type="checkbox" id="myQuietTimerToggle" checked>
            <span class="my-toggle-slider"></span>
          </label>
          <input id="myQuietDurationInput" type="number" min="1" max="300" placeholder="sec" title="Seconds of silence before auto-broadcast (no AI)" style="width:60px;">
          <button id="mySetQuietDurationBtn" class="my-admin-btn" style="background:#30363d; color:#c9d1d9; padding:5px 10px; font-size:0.75rem;">Set</button>
          <span style="font-size:0.68rem; color:#586069; flex:1;">broadcasts ideas directly (no AI)</span>
        </div>

        <!-- AI Notice -->
        <div id="myAiNotice">
          ⚠️ Chrome Built-in AI not detected. Enable it via
          <a href="javascript:void(0)" id="myFlagsLink">chrome://flags/#prompt-api-for-gemini-nano</a>
          then restart Chrome. <strong>Auto-summaries will not work.</strong>
        </div>

        <!-- Prompt -->
        <input id="myPrompt" type="text" class="my-admin-input" placeholder="AI System Prompt…">

        <!-- Controls Row -->
        <div style="display:flex; gap:8px; flex-wrap:wrap; margin-bottom:10px;">
          <button id="myTriggerBtn" class="my-admin-btn my-admin-btn-orange">▶ Run AI Now</button>
          <button id="myInitAiBtn" class="my-admin-btn my-admin-btn-blue">↺ Init AI</button>
        </div>

        <div style="display:flex; align-items:center; justify-content:space-between;">
          <div id="myAiStatus">Ready.</div>
          <div id="myAiTimer"></div>
        </div>

        <!-- Review Toggle -->
        <div class="my-toggle-row" style="margin-top:8px;">
          <label class="my-toggle">
            <input type="checkbox" id="myReviewToggle" checked>
            <span class="my-toggle-slider"></span>
          </label>
          <label for="myReviewToggle" style="font-size:0.82rem;">Review AI output before broadcasting</label>
        </div>

        <!-- Review Area -->
        <div id="myReviewArea">
          <div class="my-review-header">✏️ Review &amp; Edit Output</div>
          <textarea id="myAiReviewText" placeholder="AI output will appear here…"></textarea>
          <div style="display:flex; gap:8px;">
            <button id="myApproveBtn" class="my-admin-btn my-admin-btn-green my-admin-btn-full">📢 Broadcast to Room</button>
            <button id="myDiscardBtn" class="my-admin-btn" style="background:#30363d; color:#c9d1d9;">Discard</button>
          </div>
        </div>

        <!-- FIX 2: Pool Management Panel -->
        <hr style="border-color:#30363d; margin:12px 0;">
        <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:6px;">
          <span style="font-size:0.72rem; color:#586069; text-transform:uppercase; letter-spacing:0.06em;">Pool (edit before AI)</span>
          <button id="myTogglePoolBtn" class="my-admin-btn" style="background:#161b22; color:#586069; padding:4px 10px; font-size:0.72rem;">Show</button>
        </div>
        <div id="myPoolPanel">
          <div id="myPoolEmpty">No ideas in pool yet.</div>
        </div>

        <!-- Log -->
        <hr style="border-color:#30363d; margin:12px 0;">
        <div style="display:flex; justify-content:space-between; align-items:center;">
          <span style="font-size:0.72rem; color:#586069; text-transform:uppercase; letter-spacing:0.06em;">Server Log</span>
          <button id="myToggleLogBtn" class="my-admin-btn" style="background:#161b22; color:#586069; padding:4px 10px; font-size:0.72rem;">Toggle</button>
        </div>
        <div id="myLogArea"></div>

        <div id="myDangerZone">
          <button id="myShutdownBtn" class="my-admin-btn my-admin-btn-red my-admin-btn-full">⏻ Shutdown Room &amp; Disconnect Everyone</button>
        </div>
      </div>

      <!-- Chat Box -->
      <div class="my-card" style="padding:0; overflow:hidden;">
        <div id="myChatBox">
          <div id="myEmptyState">
            <div class="my-icon">💬</div>
            <div>Join or create a room to start brainstorming</div>
          </div>
        </div>
      </div>

      <!-- Chat Input -->
      <div id="myInputArea">
        <div class="my-input-row">
          <input id="myMsg" type="text" class="my-input" placeholder="Share your idea… (Enter to send)">
          <button id="mySendBtn" class="my-btn my-btn-primary">Send 💡</button>
        </div>
      </div>

      <!-- Leave Button -->
      <div id="myLeaveBtn">
        <button id="myLeaveBtnInner" class="my-btn my-btn-ghost my-btn-full" style="color:#b71c1c; border-color:#ffcdd2;">← Leave Room</button>
      </div>

    </div>

    <!-- Right Column -->
    <div id="mySidePanel">
      <div class="my-card">
        <div class="my-card-title">Participants</div>
        <div style="font-size:0.78rem; color:var(--muted); margin-bottom:6px;">Admins</div>
        <div id="myAdminList" class="my-presence-list"></div>
        <hr class="my-divider">
        <div style="font-size:0.78rem; color:var(--muted); margin-bottom:6px;">Participants</div>
        <div id="myUserList" class="my-presence-list"></div>
      </div>

      <div class="my-card">
        <div class="my-card-title">How It Works</div>
        <div style="font-size:0.82rem; line-height:1.7; color:#555;">
          <p>1. Everyone submits ideas simultaneously.</p>
          <p style="margin-top:6px;">2. The AI synthesizes ideas when the main timer fires or admin triggers manually.</p>
          <p style="margin-top:6px;">3. The quiet timer just broadcasts ideas directly during low traffic — no AI.</p>
          <p style="margin-top:6px;">4. The admin can edit or delete ideas before they reach the AI.</p>
        </div>
      </div>
    </div>

  </div>

  <script src="/socket.io/socket.io.js"></script>
  <script>
    const mySocket = io();
    let myLanguageModelSession = null;
    let myCurrentRoom = '';
    let myUserName = '';
    let myIsAdmin = false;
    let myTimerMax = 240;
    let myTimerCurrent = 240;
    let myIsFirstAdmin = false;
    let myTimerRunning = false;
    let myLocalTimerInterval = null;
    let myLocalTimerRunning = false;
    let myLocalTimerCountdown = 0;
    let myAiTimerInterval = null;
    let myAiTimerSeconds = 0;
    let myPoolPanelVisible = false;

    // ── TAB SWITCHING ──
    function myShowTab(tab) {
      document.getElementById('myJoinPanel').classList.toggle('active', tab === 'join');
      document.getElementById('myAdminSetupPanel').classList.toggle('active', tab === 'admin');
      document.querySelectorAll('.my-tab').forEach((b, i) => b.classList.toggle('active', (tab === 'join') === (i === 0)));
    }

    // ── AI INIT ──
    async function myInitAI() {
      const badge = document.getElementById('myAiReadyBadge');
      badge.textContent = 'AI: loading…';
      badge.className = 'loading';
      mySetAiStatus('Initializing AI session…', 'normal');
      const myApiAvailable = (typeof LanguageModel !== 'undefined') || (window.ai && window.ai.languageModel);
      if (!myApiAvailable) {
        badge.textContent = 'AI: unavailable';
        badge.className = 'error';
        document.getElementById('myAiNotice').style.display = 'block';
        mySetAiStatus('Chrome Built-in AI not found.', 'error');
        return false;
      }
      try {
        const myApiRoot = (typeof LanguageModel !== 'undefined') ? LanguageModel : window.ai.languageModel;
        myLanguageModelSession = await myApiRoot.create({ outputLanguage: 'en' });
        badge.textContent = 'AI: ready ✓';
        badge.className = 'ready';
        mySetAiStatus('AI session ready.', 'success');
        document.getElementById('myAiNotice').style.display = 'none';
        return true;
      } catch (e) {
        badge.textContent = 'AI: error';
        badge.className = 'error';
        mySetAiStatus('AI init failed: ' + e.message, 'error');
        return false;
      }
    }

    function mySetAiStatus(msg, type) {
      const el = document.getElementById('myAiStatus');
      el.textContent = msg;
      el.className = type === 'error' ? 'error' : (type === 'success' ? 'success' : '');
    }

    function myStartAiTimer() {
      myAiTimerSeconds = 0;
      document.getElementById('myAiTimer').textContent = '0s';
      myAiTimerInterval = setInterval(() => {
        myAiTimerSeconds++;
        document.getElementById('myAiTimer').textContent = myAiTimerSeconds + 's';
      }, 1000);
    }

    function myStopAiTimer() {
      if (myAiTimerInterval) { clearInterval(myAiTimerInterval); myAiTimerInterval = null; }
    }

    // ── RUN LOCAL AI ──
    async function myRunLocalAI(pool, systemPrompt, isAuto) {
      if (pool.length === 0) { mySetAiStatus('Pool is empty — nothing to summarize.', 'normal'); return; }
      mySetAiStatus('🤖 AI working…', 'normal');
      myStartAiTimer();
      const btn = document.getElementById('myTriggerBtn');
      btn.disabled = true;
      if (!myLanguageModelSession) {
        const ok = await myInitAI();
        if (!ok) { myStopAiTimer(); btn.disabled = false; return; }
      }
      const fullPrompt =
        'System Instructions: ' + systemPrompt +
        '\\n\\nIdeas submitted by participants:\\n' +
        pool.map((idea, i) => (i + 1) + '. ' + idea).join('\\n');
      try {
        const result = await myLanguageModelSession.prompt(fullPrompt);
        myStopAiTimer();
        mySetAiStatus('✅ AI complete (' + myAiTimerSeconds + 's).', 'success');
        btn.disabled = false;
        const needsReview = document.getElementById('myReviewToggle').checked;
        if (needsReview || !isAuto) {
          document.getElementById('myAiReviewText').value = result;
          document.getElementById('myReviewArea').style.display = 'block';
          document.getElementById('myAiReviewText').focus();
        } else {
          myBroadcastResult(result);
        }
      } catch (err) {
        myStopAiTimer();
        btn.disabled = false;
        mySetAiStatus('❌ AI Error: ' + err.message, 'error');
        myLanguageModelSession = null;
        const badge = document.getElementById('myAiReadyBadge');
        badge.textContent = 'AI: error';
        badge.className = 'error';
      }
    }

    function myApproveSummary() {
      const text = document.getElementById('myAiReviewText').value.trim();
      if (!text) return;
      myBroadcastResult(text);
      myDismissReview();
    }

    function myDismissReview() {
      document.getElementById('myReviewArea').style.display = 'none';
      document.getElementById('myAiReviewText').value = '';
    }

    function myBroadcastResult(text) {
      mySocket.emit('mySubmitFinishedSummary', { room: myCurrentRoom, text });
    }

    // ── AUTH ──
    function myLogin() {
      myUserName = document.getElementById('myAdminName').value.trim();
      const topic = document.getElementById('myTop').value.trim();
      const password = document.getElementById('myPass').value;
      const customPrompt = document.getElementById('myCustomPrompt').value.trim();
      if (!myUserName || !topic) { myShowError('myAdminError', 'Name and room name are required.'); return; }
      mySocket.emit('myAdminLogin', { topic, password, name: myUserName, customPrompt, duration: 240 });
    }

    function myJoin() {
      myUserName = document.getElementById('myName').value.trim();
      const topic = document.getElementById('myTopicDropdown').value;
      if (!myUserName) { myShowError('myJoinError', 'Please enter your name.'); return; }
      if (!topic) { myShowError('myJoinError', 'No rooms available yet.'); return; }
      mySocket.emit('myJoinRoom', { topic, name: myUserName });
    }

    function myShowError(id, msg) {
      const el = document.getElementById(id);
      el.textContent = msg;
      el.style.display = 'block';
      setTimeout(() => { el.style.display = 'none'; }, 4000);
    }

    function mySend() {
      const inp = document.getElementById('myMsg');
      if (inp.value.trim()) {
        mySocket.emit('myUserChat', { room: myCurrentRoom, msg: inp.value.trim(), name: myUserName });
        inp.value = '';
      }
    }

    function myToggleLocalTimer() {
      if (myLocalTimerRunning) {
        clearInterval(myLocalTimerInterval);
        myLocalTimerInterval = null;
        myLocalTimerRunning = false;
        myUpdateTimerRunningUI(false);
      } else {
        myLocalTimerCountdown = myTimerMax;
        myLocalTimerRunning = true;
        myUpdateTimerRunningUI(true);
        myLocalTimerInterval = setInterval(() => {
          myLocalTimerCountdown--;
          const disp = document.getElementById('myTimerDisplay');
          if (disp) disp.textContent = myLocalTimerCountdown;
          myUpdateTimerBar(myLocalTimerCountdown);
          if (myLocalTimerCountdown <= 0) {
            myLocalTimerCountdown = myTimerMax;
            mySocket.emit('myManualTrigger', myCurrentRoom);
          }
        }, 1000);
      }
    }

    function myToggleTimer() {
      if (myTimerRunning) {
        mySocket.emit('myTimerControl', { room: myCurrentRoom, action: 'stop' });
      } else {
        mySocket.emit('myTimerControl', { room: myCurrentRoom, action: 'start' });
      }
    }

    function mySetDuration() {
      const val = parseInt(document.getElementById('myDurationInput').value);
      if (!val || val < 10) { alert('Duration must be at least 10 seconds.'); return; }
      mySocket.emit('myTimerControl', { room: myCurrentRoom, action: 'setDuration', duration: val });
    }

    // FIX 3: Quiet timer controls
    function myToggleQuietTimer(enabled) {
      mySocket.emit('myQuietTimerControl', { room: myCurrentRoom, enabled });
    }

    function mySetQuietDuration() {
      const val = parseInt(document.getElementById('myQuietDurationInput').value);
      if (!val || val < 1) { alert('Quiet timer must be at least 1 second.'); return; }
      mySocket.emit('myQuietTimerControl', { room: myCurrentRoom, duration: val });
    }

    function myUpdateTimerRunningUI(running) {
      myTimerRunning = running;
      const dot = document.getElementById('myTimerRunningDot');
      const btn = document.getElementById('myTimerToggleBtn');
      if (dot) dot.className = running ? 'running' : '';
      if (btn) { btn.textContent = running ? '⏸ Stop' : '▶ Start'; btn.className = 'my-admin-btn ' + (running ? 'my-admin-btn-orange' : 'my-admin-btn-blue'); }
    }

    function myCopyRoomUrl() {
      const url = document.getElementById('myShareUrl').value;
      navigator.clipboard.writeText(url).catch(() => {
        const inp = document.createElement('input'); inp.value = url;
        document.body.appendChild(inp); inp.select(); document.execCommand('copy'); document.body.removeChild(inp);
      });
      const btn = document.getElementById('myCopyUrlBtn');
      btn.textContent = '✓ Copied!'; btn.style.background = '#238636'; btn.style.color = 'white';
      setTimeout(() => { btn.textContent = 'Copy'; btn.style.background = ''; btn.style.color = ''; }, 2000);
    }

    function myShutdownRoom() {
      if (!confirm('Shut down "' + myCurrentRoom + '"? This will disconnect all participants.')) return;
      mySocket.emit('myShutdownRoom', myCurrentRoom);
    }

    function myLeaveRoom() {
      if (!confirm('Leave the room?')) return;
      mySocket.emit('myLeaveRoom', myCurrentRoom);
    }

    function myResetToLobby() {
      myCurrentRoom = '';
      myIsAdmin = false;
      myTimerRunning = false;
      document.getElementById('myAuthPanel').style.display = 'block';
      document.getElementById('myAdminDashboard').style.display = 'none';
      document.getElementById('myInputArea').style.display = 'none';
      document.getElementById('myTimerBar').style.display = 'none';
      document.getElementById('mySidePanel').style.display = 'none';
      document.getElementById('myLeaveBtn').style.display = 'none';
      document.getElementById('myRoomBadge').style.display = 'none';
      document.getElementById('myChatBox').innerHTML = '<div id="myEmptyState"><div class="my-icon">💬</div><div>Join or create a room to start brainstorming</div></div>';
      document.getElementById('myShareBar').style.display = 'none';
    }

    function myManualAI() {
      mySocket.emit('myManualTrigger', myCurrentRoom);
    }

    function myToggleLog() {
      const la = document.getElementById('myLogArea');
      la.style.display = la.style.display === 'block' ? 'none' : 'block';
    }

    // FIX 2: Pool panel toggle
    function myTogglePool() {
      myPoolPanelVisible = !myPoolPanelVisible;
      document.getElementById('myPoolPanel').style.display = myPoolPanelVisible ? 'block' : 'none';
      document.getElementById('myTogglePoolBtn').textContent = myPoolPanelVisible ? 'Hide' : 'Show';
    }

    // FIX 2: Add entry to pool panel
    function myAddPoolEntry(id, name, msg) {
      const panel = document.getElementById('myPoolPanel');
      const empty = document.getElementById('myPoolEmpty');
      if (empty) empty.remove();

      const row = document.createElement('div');
      row.className = 'my-pool-entry';
      row.dataset.entryId = id;
      row.innerHTML =
        '<div class="my-pool-entry-name">' + myEscape(name) + '</div>' +
        '<textarea class="my-pool-entry-msg" rows="1">' + myEscape(msg) + '</textarea>' +
        '<div class="my-pool-entry-actions">' +
          '<button class="my-pool-save-btn">Save</button>' +
          '<button class="my-pool-del-btn">✕</button>' +
        '</div>';

      const textarea = row.querySelector('.my-pool-entry-msg');
      const saveBtn = row.querySelector('.my-pool-save-btn');
      const delBtn = row.querySelector('.my-pool-del-btn');

      // Auto-resize textarea
      textarea.style.height = 'auto';
      textarea.style.height = textarea.scrollHeight + 'px';
      textarea.addEventListener('input', () => {
        textarea.style.height = 'auto';
        textarea.style.height = textarea.scrollHeight + 'px';
        saveBtn.style.display = 'inline-block';
      });

      saveBtn.addEventListener('click', () => {
        mySocket.emit('myEditPoolEntry', { room: myCurrentRoom, id, newMsg: textarea.value });
        saveBtn.style.display = 'none';
      });

      delBtn.addEventListener('click', () => {
        if (confirm('Delete this idea from the pool?')) {
          mySocket.emit('myDeletePoolEntry', { room: myCurrentRoom, id });
        }
      });

      panel.appendChild(row);
    }

    function myRemovePoolEntry(id) {
      const row = document.querySelector('.my-pool-entry[data-entry-id="' + id + '"]');
      if (row) row.remove();
      // Show empty state if no entries left
      const panel = document.getElementById('myPoolPanel');
      if (panel && !panel.querySelector('.my-pool-entry')) {
        const empty = document.createElement('div');
        empty.id = 'myPoolEmpty';
        empty.className = '';
        empty.style.cssText = 'font-family:Space Mono,monospace;font-size:0.75rem;color:#586069;text-align:center;padding:12px 0;';
        empty.textContent = 'No ideas in pool yet.';
        panel.appendChild(empty);
      }
    }

    function myClearPoolPanel() {
      const panel = document.getElementById('myPoolPanel');
      panel.innerHTML = '<div id="myPoolEmpty" style="font-family:Space Mono,monospace;font-size:0.75rem;color:#586069;text-align:center;padding:12px 0;">No ideas in pool yet.</div>';
    }

    function myUpdateTimerBar(val) {
      const bar = document.getElementById('myTimerBarInner');
      const pct = Math.max(0, (val / myTimerMax) * 100);
      bar.style.width = pct + '%';
      bar.classList.toggle('urgent', val <= 30);
      document.getElementById('myTimerText').textContent = val + 's remaining';
    }

    function myAppendAiSummary(text) {
      const box = document.getElementById('myChatBox');
      const empty = document.getElementById('myEmptyState');
      if (empty) empty.remove();
      const div = document.createElement('div');
      div.className = 'my-msg-ai';
      div.innerHTML = '<div class="my-msg-ai-header">✨ AI Summary</div><div class="my-msg-ai-body">' + myEscape(text) + '</div>';
      box.appendChild(div);
      box.scrollTop = box.scrollHeight;
    }

    function myAppendEcho(msg) {
      const box = document.getElementById('myChatBox');
      const empty = document.getElementById('myEmptyState');
      if (empty) empty.remove();
      const div = document.createElement('div');
      div.className = 'my-msg-user';
      div.innerHTML = '<div class="my-msg-label">✓ Submitted</div>' + myEscape(msg);
      box.appendChild(div);
      box.scrollTop = box.scrollHeight;
    }

    function myEscape(str) {
      return (str || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/\\n/g,'<br>');
    }

    let myCurrentUsers = [];

    function myRenderPresence(listId, items, isAdmin) {
      const el = document.getElementById(listId);
      if (!items || items.length === 0) {
        el.innerHTML = '<span style="font-size:0.75rem;color:var(--muted);">None</span>';
        return;
      }
      if (isAdmin) {
        el.innerHTML = items.map(u => '<div class="my-presence-chip admin">' + myEscape(u.name || u) + '</div>').join('');
      } else {
        el.innerHTML = items.map(u => {
          if (myIsAdmin) {
            const safeId = (u.id || '').replace(/"/g, '');
            const safeName = myEscape(u.name || u);
            return '<div class="my-presence-chip kickable" data-kick-id="' + safeId + '" data-kick-name="' + safeName + '" title="Click to remove">' + safeName + '<span class="my-kick-x">&#x2715;</span></div>';
          }
          return '<div class="my-presence-chip">' + myEscape(u.name || u) + '</div>';
        }).join('');
        el.querySelectorAll('.kickable').forEach(chip => {
          chip.addEventListener('click', () => {
            const uid = chip.dataset.kickId;
            const uname = chip.dataset.kickName;
            if (!uid) return;
            if (!confirm('Remove ' + uname + ' from the room?')) return;
            mySocket.emit('myKickUser', { room: myCurrentRoom, userId: uid });
          });
        });
      }
    }

    function myCopyFlagsLink() {
      const url = 'chrome://flags/#prompt-api-for-gemini-nano';
      try { navigator.clipboard.writeText(url); } catch (e) {
        const inp = document.createElement('input'); inp.value = url;
        document.body.appendChild(inp); inp.select(); document.execCommand('copy'); document.body.removeChild(inp);
      }
      window.open('about:blank', '_blank');
    }

    // ── SOCKET EVENTS ──
    mySocket.on('myTopicList', (list) => {
      const sel = document.getElementById('myTopicDropdown');
      sel.innerHTML = list.length === 0
        ? '<option value="">No rooms yet</option>'
        : list.map(t => '<option value="' + t + '">' + t + '</option>').join('');
    });

    mySocket.on('myAuthError', (msg) => myShowError('myAdminError', '⚠ ' + msg));

    mySocket.on('myAdminAuthSuccess', async (data) => {
      myIsAdmin = true;
      myIsFirstAdmin = data.isFirstAdmin;
      myCurrentRoom = data.topic;
      myTimerMax = data.duration;
      myTimerCurrent = data.duration;

      document.getElementById('myAuthPanel').style.display = 'none';
      document.getElementById('myAdminDashboard').style.display = 'block';
      document.getElementById('myInputArea').style.display = 'block';
      document.getElementById('myTimerBar').style.display = 'block';
      document.getElementById('mySidePanel').style.display = 'block';
      document.getElementById('myRoomBadge').textContent = '# ' + data.topic;
      document.getElementById('myRoomBadge').style.display = 'block';
      document.getElementById('myPrompt').value = data.prompt;
      document.getElementById('myDurationInput').value = data.duration;

      // FIX 3: Set quiet timer UI from server state
      document.getElementById('myQuietDurationInput').value = data.quietTimer || 5;
      document.getElementById('myQuietTimerToggle').checked = data.quietTimerEnabled !== false;
      document.getElementById('myQuietStatusDot').className = data.quietTimerEnabled !== false ? 'on' : '';

      if (!data.isFirstAdmin) {
        const tcLabel = document.getElementById('myMainTimerLabel');
        if (tcLabel) tcLabel.textContent = 'My Local Timer';
        const btn = document.getElementById('myTimerToggleBtn');
        if (btn) btn.title = 'Controls your own independent countdown';
      }

      const shareBar = document.getElementById('myShareBar');
      shareBar.style.display = 'flex';
      document.getElementById('myShareUrl').value = 'https://ai-chat-brainstorm.onrender.com/';

      myUpdateTimerRunningUI(data.timerRunning);

      if (data.logs && data.logs.length > 0) {
        const la = document.getElementById('myLogArea');
        data.logs.forEach(l => {
          const d = document.createElement('div');
          d.className = 'my-log-entry';
          d.textContent = l;
          la.appendChild(d);
        });
      }

      await myInitAI();
    });

    mySocket.on('myJoinedSuccess', (data) => {
      myCurrentRoom = data.topic;
      document.getElementById('myAuthPanel').style.display = 'none';
      document.getElementById('myInputArea').style.display = 'block';
      document.getElementById('myTimerBar').style.display = 'block';
      document.getElementById('mySidePanel').style.display = 'block';
      document.getElementById('myLeaveBtn').style.display = 'block';
      document.getElementById('myRoomBadge').textContent = '# ' + data.topic;
      document.getElementById('myRoomBadge').style.display = 'block';
      const empty = document.getElementById('myEmptyState');
      if (empty) empty.remove();
    });

    mySocket.on('myTimerSync', (val) => {
      myTimerCurrent = val;
      if (document.getElementById('myTimerDisplay')) document.getElementById('myTimerDisplay').textContent = val;
      myUpdateTimerBar(val);
    });

    mySocket.on('myPoolUpdate', (count) => {
      const el = document.getElementById('myIdeasCount');
      if (el) el.textContent = count;
    });

    // FIX 2: New pool entry arrives — add to admin panel
    mySocket.on('myPoolEntry', (data) => {
      if (myIsAdmin) myAddPoolEntry(data.id, data.name, data.msg);
    });

    // FIX 2: Pool entry was edited by another admin tab
    mySocket.on('myPoolEntryUpdated', (data) => {
      const row = document.querySelector('.my-pool-entry[data-entry-id="' + data.id + '"]');
      if (row) {
        const ta = row.querySelector('.my-pool-entry-msg');
        if (ta) { ta.value = data.newMsg; ta.style.height = 'auto'; ta.style.height = ta.scrollHeight + 'px'; }
        const saveBtn = row.querySelector('.my-pool-save-btn');
        if (saveBtn) saveBtn.style.display = 'none';
      }
    });

    // FIX 2: Pool entry deleted
    mySocket.on('myPoolEntryDeleted', (data) => {
      myRemovePoolEntry(data.id);
    });

    // FIX 2: Pool cleared after broadcast
    mySocket.on('myPoolCleared', () => {
      myClearPoolPanel();
    });

    mySocket.on('myRequestAdminSummary', (data) => {
      if (myIsAdmin) {
        const currentPrompt = document.getElementById('myPrompt').value || data.prompt;
        myRunLocalAI(data.pool, currentPrompt, data.isAuto);
      }
    });

    mySocket.on('myBroadcastSummary', (text) => myAppendAiSummary(text));
    mySocket.on('myLocalEcho', (m) => myAppendEcho(m));

    mySocket.on('myUserUpdate', (users) => {
      myCurrentUsers = users;
      myRenderPresence('myUserList', users, false);
    });

    mySocket.on('myAdminUpdate', (admins) => {
      myRenderPresence('myAdminList', admins.map(n => ({ name: n })), true);
    });

    mySocket.on('myTimerState', (data) => {
      myTimerMax = data.duration;
      const durInput = document.getElementById('myDurationInput');
      if (durInput) durInput.value = data.duration;
      if (data.secondaryOnly) { myToggleLocalTimer(); return; }
      myUpdateTimerRunningUI(data.running);
    });

    // FIX 3: Quiet timer state update from server
    mySocket.on('myQuietTimerState', (data) => {
      document.getElementById('myQuietTimerToggle').checked = data.enabled;
      document.getElementById('myQuietStatusDot').className = data.enabled ? 'on' : '';
      if (data.duration) document.getElementById('myQuietDurationInput').value = data.duration;
    });

    mySocket.on('myRoomShutdown', (msg) => { alert('⚠️ ' + msg); myResetToLobby(); });
    mySocket.on('myLeftRoom', () => myResetToLobby());

    mySocket.on('myServerLog', (entry) => {
      const la = document.getElementById('myLogArea');
      const d = document.createElement('div');
      d.className = 'my-log-entry';
      d.textContent = entry;
      la.appendChild(d);
      la.scrollTop = la.scrollHeight;
    });

    // ── WIRE UP EVENT LISTENERS ──
    window.addEventListener('DOMContentLoaded', () => {
      document.getElementById('myTabJoinBtn').addEventListener('click', () => myShowTab('join'));
      document.getElementById('myTabAdminBtn').addEventListener('click', () => myShowTab('admin'));
      document.getElementById('myJoinBtn').addEventListener('click', myJoin);
      document.getElementById('myAdminLoginBtn').addEventListener('click', myLogin);
      document.getElementById('myName').addEventListener('keydown', e => { if (e.key === 'Enter') myJoin(); });
      document.getElementById('myAdminName').addEventListener('keydown', e => { if (e.key === 'Enter') myLogin(); });
      document.getElementById('myPass').addEventListener('keydown', e => { if (e.key === 'Enter') myLogin(); });
      document.getElementById('mySendBtn').addEventListener('click', mySend);
      document.getElementById('myMsg').addEventListener('keydown', e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); mySend(); } });
      document.getElementById('myLeaveBtnInner').addEventListener('click', myLeaveRoom);
      document.getElementById('myCopyUrlBtn').addEventListener('click', myCopyRoomUrl);
      document.getElementById('myTimerToggleBtn').addEventListener('click', myToggleTimer);
      document.getElementById('mySetDurationBtn').addEventListener('click', mySetDuration);
      document.getElementById('myDurationInput').addEventListener('keydown', e => { if (e.key === 'Enter') mySetDuration(); });
      document.getElementById('myFlagsLink').addEventListener('click', myCopyFlagsLink);
      document.getElementById('myTriggerBtn').addEventListener('click', myManualAI);
      document.getElementById('myInitAiBtn').addEventListener('click', myInitAI);
      document.getElementById('myApproveBtn').addEventListener('click', myApproveSummary);
      document.getElementById('myDiscardBtn').addEventListener('click', myDismissReview);
      document.getElementById('myToggleLogBtn').addEventListener('click', myToggleLog);
      document.getElementById('myShutdownBtn').addEventListener('click', myShutdownRoom);
      document.getElementById('myTogglePoolBtn').addEventListener('click', myTogglePool);

      // FIX 3: Quiet timer controls
      document.getElementById('myQuietTimerToggle').addEventListener('change', e => myToggleQuietTimer(e.target.checked));
      document.getElementById('mySetQuietDurationBtn').addEventListener('click', mySetQuietDuration);
      document.getElementById('myQuietDurationInput').addEventListener('keydown', e => { if (e.key === 'Enter') mySetQuietDuration(); });

      const myApiAvailable = (typeof LanguageModel !== 'undefined') || (window.ai && window.ai.languageModel);
      const badge = document.getElementById('myAiReadyBadge');
      badge.textContent = myApiAvailable ? 'AI: available' : 'AI: unavailable';
      badge.className = myApiAvailable ? 'loading' : 'error';
    });
  </script>
</body>
</html>`;
}

myServer.listen(process.env.PORT || 3000, () => {
  console.log('Server running on port 3000');
});
