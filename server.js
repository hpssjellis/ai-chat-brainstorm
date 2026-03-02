const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const myApp = express();
const myServer = http.createServer(myApp);
const myIo = new Server(myServer);

// { roomName: { password, prompt, pool[], timer, admins[], users[], intervalId, logs[] } }
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
}

function myStartRoomTimer(roomName) {
  const myRoom = myRooms[roomName];
  if (!myRoom || myRoom.intervalId) return;
  let countdown = myRoom.timer;
  myIo.to(roomName).emit('myTimerSync', countdown);
  myRoom.intervalId = setInterval(() => {
    if (myRoom.countdownReset) { myRoom.countdownReset = false; countdown = myRoom.timer; }
    countdown--;
    myIo.to(roomName).emit('myTimerSync', countdown);
    if (countdown <= 0) {
      countdown = myRoom.timer;
      myLog(roomName, 'Auto-trigger: Requesting AI summary from admins.');
      myIo.to(roomName).emit('myRequestAdminSummary', {
        pool: myRoom.pool.map(e => e.text),
        prompt: myRoom.prompt,
        isAuto: true
      });
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

myApp.get('/', (req, res) => res.send(myGenerateHTML()));

myIo.on('connection', (mySocket) => {
  mySocket.emit('myTopicList', Object.keys(myRooms));

  // ── Admin login / room creation ──
  mySocket.on('myAdminLogin', (myData) => {
    const { topic, password, name, customPrompt, duration } = myData;
    const myRoomName = topic ? topic.trim() : '';
    if (!myRoomName || !name) return;

    if (!myRooms[myRoomName]) {
      if (!password) { mySocket.emit('myAuthError', 'New rooms require a password.'); return; }
      myRooms[myRoomName] = {
        password,
        prompt: customPrompt || 'You are a professional facilitator summarizing a live brainstorming session. Silently discard off-topic, silly, rude, repetitive, or unhelpful messages. From the remaining substantive ideas, identify key themes and synthesize into 3-5 clear actionable insights. Write in a neutral, constructive tone. Be concise but specific. End with one bold synthesis statement capturing the most promising direction.',
        pool: [],
        timer: parseInt(duration) || 240,
        admins: [],
        users: [],
        intervalId: null,
        firstAdminId: null,
        logs: []
      };
      myIo.emit('myTopicList', Object.keys(myRooms));
    }

    const myRoom = myRooms[myRoomName];
    if (password !== myRoom.password) { mySocket.emit('myAuthError', 'Incorrect password.'); return; }
    if (!myRoom.admins.some(a => a.id === mySocket.id)) myRoom.admins.push({ id: mySocket.id, name });
    mySocket.join(myRoomName);
    const myIsFirstAdmin = myRoom.admins.length === 1;
    if (myIsFirstAdmin) myRoom.firstAdminId = mySocket.id;

    mySocket.emit('myAdminAuthSuccess', {
      prompt: myRoom.prompt, topic: myRoomName, duration: myRoom.timer, name,
      logs: myRoom.logs, timerRunning: !!myRoom.intervalId,
      isFirstAdmin: myIsFirstAdmin, pool: myRoom.pool
    });
    myIo.to(myRoomName).emit('myUserUpdate', myRoom.users);
    myIo.to(myRoomName).emit('myAdminUpdate', myRoom.admins.map(a => a.name));
    if (myIsFirstAdmin) myStartRoomTimer(myRoomName);
  });

  // ── Participant join ──
  mySocket.on('myJoinRoom', (myData) => {
    const { topic, name } = myData;
    if (!name || !myRooms[topic]) return;
    if (!myRooms[topic].users.some(u => u.id === mySocket.id)) myRooms[topic].users.push({ id: mySocket.id, name });
    mySocket.join(topic);
    mySocket.emit('myJoinedSuccess', { topic, name });
    myIo.to(topic).emit('myUserUpdate', myRooms[topic].users);
  });

  // ── Participant sends a message ──
  mySocket.on('myUserChat', (myData) => {
    const { room, msg, name } = myData;
    if (!myRooms[room] || !msg) return;
    const myRoom = myRooms[room];
    const entry = {
      id: Date.now() + '_' + Math.random().toString(36).slice(2, 7),
      name, msg, text: `${name}: ${msg}`
    };
    myRoom.pool.push(entry);
    mySocket.emit('myLocalEcho', msg);
    myIo.to(room).emit('myPoolUpdate', myRoom.pool.length);
    // Send live to all admin moderation queues
    myRoom.admins.forEach(admin => myIo.to(admin.id).emit('myPoolEntry', { id: entry.id, name: entry.name, msg: entry.msg }));
    myLog(room, `Idea from "${name}".`);
  });

  // ── Manual AI trigger ──
  mySocket.on('myManualTrigger', (myRoomName) => {
    const myRoom = myRooms[myRoomName];
    if (!myRoom) return;
    myResetRoomCountdown(myRoomName);
    myIo.to(mySocket.id).emit('myRequestAdminSummary', { pool: myRoom.pool.map(e => e.text), prompt: myRoom.prompt, isAuto: false });
  });

  // ── Admin: edit a pool entry ──
  mySocket.on('myEditPoolEntry', (myData) => {
    const { room, id, newMsg } = myData;
    const myRoom = myRooms[room];
    if (!myRoom || !myRoom.admins.some(a => a.id === mySocket.id)) return;
    const entry = myRoom.pool.find(e => e.id === id);
    if (!entry) return;
    entry.msg = newMsg;
    entry.text = `${entry.name}: ${newMsg}`;
    // Sync to other admin tabs
    myRoom.admins.forEach(admin => {
      if (admin.id !== mySocket.id) myIo.to(admin.id).emit('myPoolEntryUpdated', { id, newMsg });
    });
  });

  // ── Admin: delete a pool entry ──
  mySocket.on('myDeletePoolEntry', (myData) => {
    const { room, id } = myData;
    const myRoom = myRooms[room];
    if (!myRoom || !myRoom.admins.some(a => a.id === mySocket.id)) return;
    myRoom.pool = myRoom.pool.filter(e => e.id !== id);
    myIo.to(room).emit('myPoolUpdate', myRoom.pool.length);
    myRoom.admins.forEach(admin => {
      if (admin.id !== mySocket.id) myIo.to(admin.id).emit('myPoolEntryDeleted', { id });
    });
    myLog(room, 'Admin deleted a pool entry.');
  });

  // ── Admin: broadcast a single entry directly (no AI) ──
  mySocket.on('mySendPoolEntry', (myData) => {
    const { room, id } = myData;
    const myRoom = myRooms[room];
    if (!myRoom || !myRoom.admins.some(a => a.id === mySocket.id)) return;
    const entry = myRoom.pool.find(e => e.id === id);
    if (!entry) return;
    myRoom.pool = myRoom.pool.filter(e => e.id !== id);
    myIo.to(room).emit('myBroadcastSummary', entry.text);
    myIo.to(room).emit('myPoolUpdate', myRoom.pool.length);
    myRoom.admins.forEach(admin => myIo.to(admin.id).emit('myPoolEntryDeleted', { id }));
    myLog(room, `Admin broadcast entry from "${entry.name}" directly.`);
  });

  // ── Admin: send single entry to AI ──
  mySocket.on('myAiPoolEntry', (myData) => {
    const { room, id } = myData;
    const myRoom = myRooms[room];
    if (!myRoom || !myRoom.admins.some(a => a.id === mySocket.id)) return;
    const entry = myRoom.pool.find(e => e.id === id);
    if (!entry) return;
    myIo.to(mySocket.id).emit('myRequestAdminSummary', { pool: [entry.text], prompt: myRoom.prompt, isAuto: false });
    myLog(room, `Admin sent single entry to AI from "${entry.name}".`);
  });

  // ── Admin: broadcast all pool entries directly ──
  mySocket.on('mySendAllPool', (room) => {
    const myRoom = myRooms[room];
    if (!myRoom || !myRoom.admins.some(a => a.id === mySocket.id) || myRoom.pool.length === 0) return;
    const text = myRoom.pool.map(e => e.text).join('\n');
    const count = myRoom.pool.length;
    myRoom.pool = [];
    myIo.to(room).emit('myBroadcastSummary', text);
    myIo.to(room).emit('myPoolUpdate', 0);
    myRoom.admins.forEach(admin => myIo.to(admin.id).emit('myPoolCleared'));
    myLog(room, `Admin broadcast all ${count} pool entries directly.`);
  });

  // ── Admin: clear pool without broadcasting ──
  mySocket.on('myClearPool', (room) => {
    const myRoom = myRooms[room];
    if (!myRoom || !myRoom.admins.some(a => a.id === mySocket.id)) return;
    myRoom.pool = [];
    myIo.to(room).emit('myPoolUpdate', 0);
    myRoom.admins.forEach(admin => myIo.to(admin.id).emit('myPoolCleared'));
    myLog(room, 'Admin cleared the pool.');
  });

  // ── Timer control ──
  mySocket.on('myTimerControl', (myData) => {
    const { room, action, duration } = myData;
    const myRoom = myRooms[room];
    if (!myRoom || !myRoom.admins.some(a => a.id === mySocket.id)) return;
    if (action === 'stop') {
      if (mySocket.id !== myRoom.firstAdminId) { mySocket.emit('myTimerState', { running: !!myRoom.intervalId, duration: myRoom.timer, secondaryOnly: true }); return; }
      myStopRoomTimer(room);
      myIo.to(room).emit('myTimerState', { running: false, duration: myRoom.timer });
    } else if (action === 'start') {
      if (mySocket.id !== myRoom.firstAdminId) { mySocket.emit('myTimerState', { running: !!myRoom.intervalId, duration: myRoom.timer, secondaryOnly: true }); return; }
      myStartRoomTimer(room);
      myIo.to(room).emit('myTimerState', { running: true, duration: myRoom.timer });
    } else if (action === 'setDuration') {
      const newDur = parseInt(duration);
      if (!newDur || newDur < 10) return;
      myRoom.timer = newDur;
      myRoom.countdownReset = true;
      myLog(room, `Timer duration changed to ${newDur}s.`);
      myIo.to(room).emit('myTimerState', { running: !!myRoom.intervalId, duration: newDur });
    }
  });

  // ── Admin: kick a participant ──
  mySocket.on('myKickUser', (myData) => {
    const { room, userId } = myData;
    const myRoom = myRooms[room];
    if (!myRoom || !myRoom.admins.some(a => a.id === mySocket.id)) return;
    const kicked = myRoom.users.find(u => u.id === userId);
    myRoom.users = myRoom.users.filter(u => u.id !== userId);
    myIo.to(userId).emit('myRoomShutdown', 'You have been removed from the room by an admin.');
    myIo.sockets.sockets.get(userId)?.leave(room);
    myIo.to(room).emit('myUserUpdate', myRoom.users);
    myLog(room, `User "${kicked?.name || userId}" kicked by admin.`);
  });

  // ── Admin: shutdown room ──
  mySocket.on('myShutdownRoom', (room) => {
    const myRoom = myRooms[room];
    if (!myRoom || !myRoom.admins.some(a => a.id === mySocket.id)) return;
    myStopRoomTimer(room);
    myIo.to(room).emit('myRoomShutdown', 'The room has been closed by an admin.');
    myLog(room, 'Room shut down by admin.');
    delete myRooms[room];
    myIo.emit('myTopicList', Object.keys(myRooms));
  });

  // ── Voluntarily leave ──
  mySocket.on('myLeaveRoom', (room) => {
    const myRoom = myRooms[room];
    if (!myRoom) return;
    myRoom.users  = myRoom.users.filter(u => u.id !== mySocket.id);
    myRoom.admins = myRoom.admins.filter(a => a.id !== mySocket.id);
    mySocket.leave(room);
    if (myRoom.admins.length === 0) myStopRoomTimer(room);
    myIo.to(room).emit('myUserUpdate', myRoom.users);
    myIo.to(room).emit('myAdminUpdate', myRoom.admins.map(a => a.name));
    mySocket.emit('myLeftRoom');
  });

  // ── Admin submits finished AI summary ──
  mySocket.on('mySubmitFinishedSummary', (myData) => {
    const { room, text } = myData;
    if (!myRooms[room]) return;
    myRooms[room].pool = [];
    myIo.to(room).emit('myBroadcastSummary', text);
    myIo.to(room).emit('myPoolUpdate', 0);
    myRooms[room].admins.forEach(admin => myIo.to(admin.id).emit('myPoolCleared'));
    myLog(room, 'AI Summary broadcasted by admin.');
  });

  mySocket.on('disconnect', () => {
    for (const roomName in myRooms) {
      const myRoom = myRooms[roomName];
      myRoom.admins = myRoom.admins.filter(a => a.id !== mySocket.id);
      myRoom.users  = myRoom.users.filter(u => u.id !== mySocket.id);
      if (myRoom.admins.length === 0) myStopRoomTimer(roomName);
      myIo.to(roomName).emit('myAdminUpdate', myRoom.admins.map(a => a.name));
      myIo.to(roomName).emit('myUserUpdate', myRoom.users);
    }
  });
});

// ════════════════════════════════════════════════════════
//  HTML
// ════════════════════════════════════════════════════════
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
    body { font-family: 'Syne', sans-serif; background: var(--paper); color: var(--ink); min-height: 100vh; }

    /* Header */
    #myHeader {
      background: var(--ink); color: white; padding: 16px 24px;
      display: flex; align-items: center; justify-content: space-between;
      position: sticky; top: 0; z-index: 100;
    }
    #myHeader h1 { font-size: 1.2rem; font-weight: 800; letter-spacing: -0.02em; }
    #myHeader h1 span { color: var(--accent); }
    #myRoomBadge { font-family: 'Space Mono', monospace; font-size: 0.75rem; background: rgba(255,255,255,0.1); padding: 4px 10px; border-radius: 20px; display: none; }
    #myAiReadyBadge { font-family: 'Space Mono', monospace; font-size: 0.7rem; padding: 3px 8px; border-radius: 20px; background: #333; color: #888; transition: all 0.3s; }
    #myAiReadyBadge.ready  { background: rgba(63,185,80,0.2);  color: var(--admin-success); }
    #myAiReadyBadge.loading{ background: rgba(88,166,255,0.2); color: var(--admin-accent); }
    #myAiReadyBadge.error  { background: rgba(248,81,73,0.2);  color: #f85149; }

    /* Layout */
    #myMainLayout { display: grid; grid-template-columns: 1fr; max-width: 1200px; margin: 0 auto; padding: 24px 16px; gap: 0; }
    @media (min-width: 960px) { #myMainLayout { grid-template-columns: 1fr 380px; gap: 24px; } }

    /* Cards */
    .my-card { background: white; border: 1px solid var(--border); border-radius: 12px; padding: 20px; margin-bottom: 16px; box-shadow: var(--card-shadow); }
    .my-card-title { font-size: 0.7rem; font-weight: 700; letter-spacing: 0.1em; text-transform: uppercase; color: var(--muted); margin-bottom: 14px; }

    /* Auth tabs */
    #myAuthPanel .my-tabs { display: flex; gap: 4px; margin-bottom: 16px; background: #f0ede6; border-radius: 8px; padding: 4px; }
    .my-tab { flex: 1; padding: 8px; border: none; border-radius: 6px; cursor: pointer; font-family: 'Syne', sans-serif; font-weight: 600; font-size: 0.85rem; background: transparent; color: var(--muted); transition: all 0.2s; }
    .my-tab.active { background: white; color: var(--ink); box-shadow: 0 1px 3px rgba(0,0,0,0.15); }
    #myJoinPanel, #myAdminSetupPanel { display: none; }
    #myJoinPanel.active, #myAdminSetupPanel.active { display: block; }

    /* Inputs */
    .my-input { width: 100%; padding: 10px 14px; border: 1.5px solid var(--border); border-radius: 8px; font-family: 'Syne', sans-serif; font-size: 0.9rem; background: #fafaf8; color: var(--ink); transition: border-color 0.2s; margin-bottom: 10px; }
    .my-input:focus { outline: none; border-color: var(--accent2); background: white; }
    .my-input-row { display: flex; gap: 8px; }
    .my-input-row .my-input { margin-bottom: 0; }

    /* Buttons */
    .my-btn { padding: 10px 18px; border: none; border-radius: 8px; font-family: 'Syne', sans-serif; font-weight: 700; font-size: 0.85rem; cursor: pointer; transition: all 0.15s; white-space: nowrap; }
    .my-btn:active { transform: scale(0.97); }
    .my-btn-primary { background: var(--accent2); color: white; }
    .my-btn-primary:hover { background: #0d5de6; }
    .my-btn-dark { background: var(--ink); color: white; }
    .my-btn-dark:hover { background: #333; }
    .my-btn-ghost { background: transparent; color: var(--ink); border: 1.5px solid var(--border); }
    .my-btn-ghost:hover { border-color: var(--ink); }
    .my-btn-full { width: 100%; }
    .my-btn:disabled { opacity: 0.5; cursor: not-allowed; }

    /* Timer bar */
    #myTimerBar { display: none; margin-bottom: 16px; }
    #myTimerBarInner { height: 6px; background: var(--accent2); border-radius: 3px; transition: width 1s linear, background 0.5s; width: 100%; }
    #myTimerBarInner.urgent { background: var(--accent); }
    #myTimerText { font-family: 'Space Mono', monospace; font-size: 0.75rem; color: var(--muted); text-align: right; margin-top: 4px; }

    /* Chat box */
    #myChatBox { height: 400px; overflow-y: auto; padding: 12px; display: flex; flex-direction: column; gap: 8px; scroll-behavior: smooth; }
    .my-msg-user { background: #f0f0f0; padding: 8px 12px; border-radius: 8px; font-size: 0.85rem; color: #555; font-family: 'Space Mono', monospace; border-left: 3px solid var(--border); }
    .my-msg-user .my-msg-label { font-size: 0.7rem; color: #aaa; margin-bottom: 2px; }
    .my-msg-ai { background: linear-gradient(135deg, #eef4ff 0%, #f0f7ff 100%); padding: 14px 16px; border-radius: 10px; border-left: 4px solid var(--accent2); animation: mySlideIn 0.4s ease; }
    .my-msg-ai-header { font-size: 0.7rem; font-weight: 700; letter-spacing: 0.08em; text-transform: uppercase; color: var(--accent2); margin-bottom: 8px; display: flex; align-items: center; gap: 6px; }
    .my-msg-ai-body { font-size: 0.88rem; line-height: 1.65; color: var(--ink); white-space: pre-wrap; }
    @keyframes mySlideIn { from { opacity: 0; transform: translateY(10px); } to { opacity: 1; transform: translateY(0); } }
    #myEmptyState { display: flex; flex-direction: column; align-items: center; justify-content: center; height: 100%; color: var(--muted); gap: 8px; font-size: 0.85rem; }
    #myEmptyState .my-icon { font-size: 2.5rem; }

    /* Chat input */
    #myInputArea { display: none; margin-top: 12px; }
    #myInputArea .my-input-row { align-items: center; }
    #myMsg { flex: 1; margin-bottom: 0; }

    /* Admin dashboard */
    #myAdminDashboard { display: none; background: var(--admin-bg); color: var(--admin-fg); border: 1px solid #30363d; border-radius: 12px; padding: 20px; margin-bottom: 16px; box-shadow: var(--card-shadow); }
    #myAdminDashboard .my-card-title { color: #586069; }

    .my-admin-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; margin-bottom: 14px; }
    .my-stat-box { background: #161b22; border: 1px solid #30363d; border-radius: 8px; padding: 12px; text-align: center; }
    .my-stat-num { font-family: 'Space Mono', monospace; font-size: 1.8rem; font-weight: 700; color: var(--admin-accent); line-height: 1; }
    .my-stat-label { font-size: 0.68rem; color: #586069; margin-top: 4px; text-transform: uppercase; letter-spacing: 0.06em; }

    .my-admin-input { width: 100%; padding: 9px 13px; border: 1px solid #30363d; border-radius: 8px; font-family: 'Space Mono', monospace; font-size: 0.8rem; background: #161b22; color: var(--admin-fg); margin-bottom: 10px; transition: border-color 0.2s; }
    .my-admin-input:focus { outline: none; border-color: var(--admin-accent); }

    .my-admin-btn { padding: 9px 16px; border: none; border-radius: 7px; font-family: 'Syne', sans-serif; font-weight: 700; font-size: 0.82rem; cursor: pointer; transition: all 0.15s; }
    .my-admin-btn:active { transform: scale(0.97); }
    .my-admin-btn-blue   { background: var(--admin-accent); color: #0d1117; }
    .my-admin-btn-blue:hover   { background: #79c0ff; }
    .my-admin-btn-orange { background: var(--admin-warn); color: #0d1117; }
    .my-admin-btn-orange:hover { background: #ffa657; }
    .my-admin-btn-green  { background: var(--admin-success); color: #0d1117; }
    .my-admin-btn-green:hover  { background: #56d364; }
    .my-admin-btn-red    { background: #da3633; color: white; }
    .my-admin-btn-red:hover    { background: #f85149; }
    .my-admin-btn-full { width: 100%; }
    .my-admin-btn:disabled { opacity: 0.4; cursor: not-allowed; }

    /* Timer controls */
    #myTimerControls { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; background: #161b22; border: 1px solid #30363d; border-radius: 8px; padding: 10px 12px; margin-bottom: 12px; }
    #myTimerControls .my-tc-label { font-size: 0.68rem; text-transform: uppercase; letter-spacing: 0.07em; color: #586069; }
    #myDurationInput { width: 72px; padding: 5px 8px; border: 1px solid #30363d; border-radius: 5px; font-family: 'Space Mono', monospace; font-size: 0.8rem; background: #0d1117; color: var(--admin-fg); text-align: center; }
    #myDurationInput:focus { outline: none; border-color: var(--admin-accent); }
    #myTimerRunningDot { width: 8px; height: 8px; border-radius: 50%; background: #586069; flex-shrink: 0; transition: background 0.3s; }
    #myTimerRunningDot.running { background: var(--admin-success); box-shadow: 0 0 6px var(--admin-success); animation: myPulse 1.4s infinite; }
    @keyframes myPulse { 0%,100%{opacity:1} 50%{opacity:0.4} }

    /* AI status */
    #myAiStatus { font-family: 'Space Mono', monospace; font-size: 0.75rem; color: var(--admin-accent); min-height: 18px; margin: 8px 0; }
    #myAiStatus.error   { color: #f85149; }
    #myAiStatus.success { color: var(--admin-success); }
    #myAiTimer { font-family: 'Space Mono', monospace; font-size: 0.75rem; color: #586069; }

    /* Review area */
    #myReviewArea { display: none; background: #161b22; border: 1px solid #f0883e55; border-radius: 8px; padding: 14px; margin: 12px 0; animation: mySlideIn 0.3s ease; }
    #myReviewArea .my-review-header { font-size: 0.7rem; font-weight: 700; letter-spacing: 0.08em; text-transform: uppercase; color: var(--admin-warn); margin-bottom: 10px; display: flex; align-items: center; gap: 6px; }
    #myAiReviewText { width: 100%; min-height: 120px; padding: 10px; border: 1px solid #30363d; border-radius: 6px; background: #0d1117; color: var(--admin-fg); font-family: 'Space Mono', monospace; font-size: 0.8rem; line-height: 1.5; resize: vertical; margin-bottom: 10px; }
    #myAiReviewText:focus { outline: none; border-color: var(--admin-warn); }

    /* ══════════════════════════════════════════
       MODERATION QUEUE
    ══════════════════════════════════════════ */
    #myModerationPanel { background: #0d1117; border: 1px solid #30363d; border-radius: 10px; overflow: hidden; margin-bottom: 14px; }

    #myModerationToolbar { display: flex; align-items: center; gap: 8px; padding: 10px 14px; background: #161b22; border-bottom: 1px solid #30363d; flex-wrap: wrap; }
    .my-mod-title { font-size: 0.68rem; font-weight: 700; letter-spacing: 0.1em; text-transform: uppercase; color: #586069; white-space: nowrap; }
    .my-mod-count { font-family: 'Space Mono', monospace; font-size: 0.72rem; color: var(--admin-accent); background: #21262d; padding: 2px 8px; border-radius: 10px; margin-right: auto; }

    .my-mod-toolbar-btn { padding: 5px 12px; border: none; border-radius: 6px; font-family: 'Syne', sans-serif; font-weight: 700; font-size: 0.75rem; cursor: pointer; transition: all 0.15s; white-space: nowrap; }
    .my-mod-toolbar-btn:active { transform: scale(0.97); }
    .my-mod-send-all  { background: var(--admin-success); color: #0d1117; }
    .my-mod-send-all:hover  { background: #56d364; }
    .my-mod-ai-all    { background: var(--admin-warn); color: #0d1117; }
    .my-mod-ai-all:hover    { background: #ffa657; }
    .my-mod-clear-all { background: #21262d; color: #8b949e; border: 1px solid #30363d; }
    .my-mod-clear-all:hover { background: #30363d; color: #c9d1d9; }
    .my-mod-toolbar-btn:disabled { opacity: 0.35; cursor: not-allowed; }

    #myModerationQueue { max-height: 380px; overflow-y: auto; }
    #myModerationEmpty { padding: 28px 16px; text-align: center; font-family: 'Space Mono', monospace; font-size: 0.75rem; color: #3d444d; }

    .my-mod-card { display: flex; align-items: flex-start; gap: 10px; padding: 10px 14px; border-bottom: 1px solid #161b22; animation: mySlideIn 0.25s ease; transition: background 0.15s; }
    .my-mod-card:last-child { border-bottom: none; }
    .my-mod-card:hover { background: #111820; }

    .my-mod-avatar { width: 30px; height: 30px; border-radius: 50%; background: #21262d; border: 1px solid #30363d; display: flex; align-items: center; justify-content: center; font-size: 0.62rem; font-weight: 700; color: var(--admin-accent); flex-shrink: 0; font-family: 'Space Mono', monospace; text-transform: uppercase; margin-top: 2px; }

    .my-mod-content { flex: 1; min-width: 0; }
    .my-mod-sender { font-size: 0.68rem; font-weight: 700; color: var(--admin-accent); margin-bottom: 5px; font-family: 'Space Mono', monospace; letter-spacing: 0.04em; }
    .my-mod-text { width: 100%; background: transparent; border: 1px solid transparent; border-radius: 5px; font-family: 'Space Mono', monospace; font-size: 0.78rem; color: var(--admin-fg); line-height: 1.5; padding: 3px 6px; resize: none; overflow: hidden; transition: border-color 0.15s, background 0.15s; }
    .my-mod-text:focus { outline: none; border-color: #30363d; background: #0d1117; }
    .my-mod-text.edited { border-color: #f0883e44; background: #0d1117; }

    .my-mod-actions { display: flex; flex-direction: column; gap: 4px; flex-shrink: 0; padding-top: 2px; }
    .my-mod-btn { padding: 4px 0; border: none; border-radius: 5px; font-family: 'Syne', sans-serif; font-weight: 700; font-size: 0.69rem; cursor: pointer; transition: all 0.12s; width: 48px; text-align: center; }
    .my-mod-btn:active { transform: scale(0.95); }
    .my-mod-btn-send { background: #1a4231; color: var(--admin-success); border: 1px solid #238636; }
    .my-mod-btn-send:hover { background: #238636; color: #0d1117; }
    .my-mod-btn-ai   { background: #2d1f0a; color: var(--admin-warn); border: 1px solid #6e3a0a; }
    .my-mod-btn-ai:hover   { background: var(--admin-warn); color: #0d1117; }
    .my-mod-btn-del  { background: #21262d; color: #8b949e; border: 1px solid #30363d; }
    .my-mod-btn-del:hover  { background: #6e2020; color: #f85149; border-color: #6e2020; }

    /* Toggle */
    .my-toggle-row { display: flex; align-items: center; gap: 10px; padding: 8px 0; }
    .my-toggle { position: relative; width: 36px; height: 20px; flex-shrink: 0; }
    .my-toggle input { opacity: 0; width: 0; height: 0; }
    .my-toggle-slider { position: absolute; inset: 0; background: #30363d; border-radius: 20px; transition: 0.2s; cursor: pointer; }
    .my-toggle-slider::before { content: ''; position: absolute; width: 14px; height: 14px; left: 3px; top: 3px; background: white; border-radius: 50%; transition: 0.2s; }
    .my-toggle input:checked + .my-toggle-slider { background: var(--admin-accent); }
    .my-toggle input:checked + .my-toggle-slider::before { transform: translateX(16px); }

    /* AI notice */
    #myAiNotice { background: #fff8e1; border: 1px solid #ffe082; border-radius: 8px; padding: 12px 14px; font-size: 0.8rem; color: #795548; margin-bottom: 10px; display: none; }
    #myAiNotice a { color: var(--accent2); }

    /* Errors */
    .my-error-msg { background: #ffeaea; border: 1px solid #ffcdd2; color: #b71c1c; padding: 10px 14px; border-radius: 8px; font-size: 0.85rem; margin-bottom: 10px; display: none; }

    /* Log */
    #myLogArea { display: none; background: #0d1117; border: 1px solid #30363d; border-radius: 8px; padding: 10px; max-height: 140px; overflow-y: auto; margin-top: 10px; }
    .my-log-entry { font-family: 'Space Mono', monospace; font-size: 0.7rem; color: #586069; padding: 2px 0; border-bottom: 1px solid #161b22; }
    .my-log-entry:last-child { border-bottom: none; }

    /* Presence */
    #mySidePanel { display: none; }
    .my-presence-list { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 8px; }
    .my-presence-chip { padding: 4px 10px; border-radius: 20px; font-size: 0.75rem; font-weight: 600; background: #f0ede6; color: var(--ink); border: 1px solid var(--border); }
    .my-presence-chip.admin { background: #fff3e0; border-color: #ffcc80; color: #e65100; }
    .my-presence-chip.kickable { cursor: pointer; display: flex; align-items: center; gap: 5px; transition: background 0.15s; }
    .my-presence-chip.kickable:hover { background: #ffeaea; border-color: #ffcdd2; color: #b71c1c; }
    .my-presence-chip.kickable .my-kick-x { font-size: 0.7rem; opacity: 0.5; }

    .my-divider { border: none; border-top: 1px solid var(--border); margin: 14px 0; }
    #myDangerZone { border-top: 1px solid #30363d; margin-top: 12px; padding-top: 12px; }
    #myLeaveBtn { display: none; margin-top: 10px; }

    ::-webkit-scrollbar { width: 5px; }
    ::-webkit-scrollbar-track { background: transparent; }
    ::-webkit-scrollbar-thumb { background: var(--border); border-radius: 3px; }
  </style>
</head>
<body>

<div id="myHeader">
  <h1>🧠 Brainstorm<span>Hub</span></h1>
  <div style="display:flex;align-items:center;gap:10px;">
    <div id="myAiReadyBadge">AI: checking…</div>
    <div id="myRoomBadge">—</div>
  </div>
</div>

<div id="myMainLayout">

  <!-- LEFT COLUMN -->
  <div>

    <!-- Auth -->
    <div id="myAuthPanel" class="my-card">
      <div class="my-card-title">Join a Session</div>
      <div class="my-tabs">
        <button class="my-tab active" id="myTabJoinBtn">Join as Participant</button>
        <button class="my-tab"        id="myTabAdminBtn">Admin / Create Room</button>
      </div>
      <div id="myJoinPanel" class="active">
        <input id="myName" type="text" class="my-input" placeholder="Your name">
        <select id="myTopicDropdown" class="my-input"></select>
        <div id="myJoinError" class="my-error-msg"></div>
        <button class="my-btn my-btn-primary my-btn-full" id="myJoinBtn">Enter Room →</button>
      </div>
      <div id="myAdminSetupPanel">
        <input id="myAdminName"    type="text"     class="my-input" placeholder="Your name">
        <input id="myTop"          type="text"     class="my-input" placeholder="Room name (create or join existing)">
        <input id="myPass"         type="password" class="my-input" placeholder="Room password">
        <input id="myCustomPrompt" type="text"     class="my-input" placeholder="AI prompt (optional)">
        <div id="myAdminError" class="my-error-msg"></div>
        <button class="my-btn my-btn-dark my-btn-full" id="myAdminLoginBtn">Create / Enter Room →</button>
      </div>
    </div>

    <!-- Timer bar -->
    <div id="myTimerBar">
      <div id="myTimerBarInner"></div>
      <div id="myTimerText">—</div>
    </div>

    <!-- Admin Dashboard -->
    <div id="myAdminDashboard">
      <div class="my-card-title">⚡ Admin Dashboard</div>

      <!-- Share URL -->
      <div id="myShareBar" style="display:none;background:#161b22;border:1px solid #30363d;border-radius:8px;padding:10px 12px;margin-bottom:12px;align-items:center;gap:8px;flex-wrap:wrap;">
        <span style="font-size:0.68rem;text-transform:uppercase;letter-spacing:0.08em;color:#586069;white-space:nowrap;">Share URL</span>
        <input id="myShareUrl" type="text" readonly style="flex:1;min-width:120px;font-family:'Space Mono',monospace;font-size:0.75rem;color:#58a6ff;background:#0d1117;border:1px solid #30363d;border-radius:5px;padding:5px 9px;cursor:text;">
        <button id="myCopyUrlBtn" style="padding:5px 12px;background:#30363d;border:none;border-radius:5px;color:#c9d1d9;font-family:'Syne',sans-serif;font-size:0.75rem;font-weight:700;cursor:pointer;white-space:nowrap;">Copy</button>
      </div>

      <!-- Stats -->
      <div class="my-admin-grid">
        <div class="my-stat-box">
          <div class="my-stat-num" id="myIdeasCount">0</div>
          <div class="my-stat-label">Ideas in Queue</div>
        </div>
        <div class="my-stat-box">
          <div class="my-stat-num" id="myTimerDisplay">—</div>
          <div class="my-stat-label">Seconds Left</div>
        </div>
      </div>

      <!-- Timer controls -->
      <div id="myTimerControls">
        <div id="myTimerRunningDot"></div>
        <span class="my-tc-label" id="myMainTimerLabel">Timer</span>
        <button id="myTimerToggleBtn" class="my-admin-btn my-admin-btn-blue" style="padding:5px 12px;font-size:0.78rem;">▶ Start</button>
        <input id="myDurationInput" type="number" min="10" max="3600" placeholder="sec" style="width:72px;padding:5px 8px;border:1px solid #30363d;border-radius:5px;font-family:'Space Mono',monospace;font-size:0.8rem;background:#0d1117;color:#c9d1d9;text-align:center;">
        <button id="mySetDurationBtn" class="my-admin-btn" style="background:#30363d;color:#c9d1d9;padding:5px 12px;font-size:0.78rem;">Set</button>
      </div>

      <!-- AI notice -->
      <div id="myAiNotice">
        ⚠️ Chrome Built-in AI not detected. Enable via
        <a href="javascript:void(0)" id="myFlagsLink">chrome://flags/#prompt-api-for-gemini-nano</a>
        then restart Chrome.
      </div>

      <!-- Prompt + AI controls -->
      <input id="myPrompt" type="text" class="my-admin-input" placeholder="AI System Prompt…">
      <div style="display:flex;gap:8px;flex-wrap:wrap;margin-bottom:10px;">
        <button id="myInitAiBtn" class="my-admin-btn my-admin-btn-blue">↺ Init AI</button>
      </div>
      <div style="display:flex;align-items:center;justify-content:space-between;">
        <div id="myAiStatus">Ready.</div>
        <div id="myAiTimer"></div>
      </div>

      <!-- Review toggle -->
      <div class="my-toggle-row" style="margin-top:8px;">
        <label class="my-toggle">
          <input type="checkbox" id="myReviewToggle" checked>
          <span class="my-toggle-slider"></span>
        </label>
        <label for="myReviewToggle" style="font-size:0.82rem;">Review AI output before broadcasting</label>
      </div>

      <!-- Review area -->
      <div id="myReviewArea">
        <div class="my-review-header">✏️ Review &amp; Edit Output</div>
        <textarea id="myAiReviewText" placeholder="AI output will appear here…"></textarea>
        <div style="display:flex;gap:8px;">
          <button id="myApproveBtn" class="my-admin-btn my-admin-btn-green my-admin-btn-full">📢 Broadcast to Room</button>
          <button id="myDiscardBtn" class="my-admin-btn" style="background:#30363d;color:#c9d1d9;">Discard</button>
        </div>
      </div>

      <hr style="border-color:#30363d;margin:14px 0;">

      <!-- Moderation queue -->
      <div id="myModerationPanel">
        <div id="myModerationToolbar">
          <span class="my-mod-title">Incoming Messages</span>
          <span class="my-mod-count" id="myModCount">0</span>
          <button class="my-mod-toolbar-btn my-mod-send-all"  id="mySendAllBtn"  disabled>📢 Send All</button>
          <button class="my-mod-toolbar-btn my-mod-ai-all"    id="myAiAllBtn"    disabled>🤖 AI All</button>
          <button class="my-mod-toolbar-btn my-mod-clear-all" id="myClearAllBtn" disabled>✕ Clear</button>
        </div>
        <div id="myModerationQueue">
          <div id="myModerationEmpty">No messages yet — waiting for participants…</div>
        </div>
      </div>

      <!-- Log -->
      <div style="display:flex;justify-content:space-between;align-items:center;margin-top:4px;">
        <span style="font-size:0.72rem;color:#586069;text-transform:uppercase;letter-spacing:0.06em;">Server Log</span>
        <button id="myToggleLogBtn" class="my-admin-btn" style="background:#161b22;color:#586069;padding:4px 10px;font-size:0.72rem;">Toggle</button>
      </div>
      <div id="myLogArea"></div>

      <!-- Danger zone -->
      <div id="myDangerZone">
        <button id="myShutdownBtn" class="my-admin-btn my-admin-btn-red my-admin-btn-full">⏻ Shutdown Room &amp; Disconnect Everyone</button>
      </div>
    </div>

    <!-- Chat box -->
    <div class="my-card" style="padding:0;overflow:hidden;">
      <div id="myChatBox">
        <div id="myEmptyState">
          <div class="my-icon">💬</div>
          <div>Join or create a room to start brainstorming</div>
        </div>
      </div>
    </div>

    <!-- Chat input -->
    <div id="myInputArea">
      <div class="my-input-row">
        <input id="myMsg" type="text" class="my-input" placeholder="Share your idea… (Enter to send)">
        <button id="mySendBtn" class="my-btn my-btn-primary">Send 💡</button>
      </div>
    </div>

    <!-- Leave button -->
    <div id="myLeaveBtn">
      <button id="myLeaveBtnInner" class="my-btn my-btn-ghost my-btn-full" style="color:#b71c1c;border-color:#ffcdd2;">← Leave Room</button>
    </div>

  </div><!-- end left column -->

  <!-- RIGHT COLUMN -->
  <div id="mySidePanel">
    <div class="my-card">
      <div class="my-card-title">Participants</div>
      <div style="font-size:0.78rem;color:var(--muted);margin-bottom:6px;">Admins</div>
      <div id="myAdminList" class="my-presence-list"></div>
      <hr class="my-divider">
      <div style="font-size:0.78rem;color:var(--muted);margin-bottom:6px;">Participants</div>
      <div id="myUserList" class="my-presence-list"></div>
    </div>
    <div class="my-card">
      <div class="my-card-title">How It Works</div>
      <div style="font-size:0.82rem;line-height:1.7;color:#555;">
        <p>1. Everyone submits ideas simultaneously.</p>
        <p style="margin-top:6px;">2. Admin sees every message live and can <strong>Send</strong> it directly, run it through <strong>AI</strong>, or <strong>Delete</strong> it.</p>
        <p style="margin-top:6px;">3. <strong>Send All</strong> broadcasts the whole queue as-is. <strong>AI All</strong> sends everything through AI summarisation.</p>
        <p style="margin-top:6px;">4. The countdown timer auto-triggers AI when it hits zero.</p>
      </div>
    </div>
  </div>

</div><!-- end myMainLayout -->

<script src="/socket.io/socket.io.js"></script>
<script>
  const mySocket = io();
  let myLanguageModelSession = null;
  let myCurrentRoom  = '';
  let myUserName     = '';
  let myIsAdmin      = false;
  let myTimerMax     = 240;
  let myIsFirstAdmin = false;
  let myTimerRunning = false;
  let myLocalTimerInterval  = null;
  let myLocalTimerRunning   = false;
  let myLocalTimerCountdown = 0;
  let myAiTimerInterval = null;
  let myAiTimerSeconds  = 0;
  let myModEntries = {}; // id -> { name, msg }

  // ── Tab switching ────────────────────────────────────
  function myShowTab(tab) {
    document.getElementById('myJoinPanel').classList.toggle('active', tab === 'join');
    document.getElementById('myAdminSetupPanel').classList.toggle('active', tab === 'admin');
    document.querySelectorAll('.my-tab').forEach((b, i) =>
      b.classList.toggle('active', (tab === 'join') === (i === 0)));
  }

  // ── AI init ──────────────────────────────────────────
  async function myInitAI() {
    const badge = document.getElementById('myAiReadyBadge');
    badge.textContent = 'AI: loading…'; badge.className = 'loading';
    mySetAiStatus('Initializing AI session…', 'normal');
    const avail = (typeof LanguageModel !== 'undefined') || (window.ai && window.ai.languageModel);
    if (!avail) {
      badge.textContent = 'AI: unavailable'; badge.className = 'error';
      document.getElementById('myAiNotice').style.display = 'block';
      mySetAiStatus('Chrome Built-in AI not found.', 'error');
      return false;
    }
    try {
      const api = (typeof LanguageModel !== 'undefined') ? LanguageModel : window.ai.languageModel;
      myLanguageModelSession = await api.create({ outputLanguage: 'en' });
      badge.textContent = 'AI: ready ✓'; badge.className = 'ready';
      mySetAiStatus('AI session ready.', 'success');
      document.getElementById('myAiNotice').style.display = 'none';
      return true;
    } catch (e) {
      badge.textContent = 'AI: error'; badge.className = 'error';
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

  // ── Run AI ───────────────────────────────────────────
  async function myRunLocalAI(pool, systemPrompt, isAuto) {
    if (pool.length === 0) { mySetAiStatus('Pool is empty.', 'normal'); return; }
    mySetAiStatus('🤖 AI working…', 'normal');
    myStartAiTimer();
    if (!myLanguageModelSession) {
      const ok = await myInitAI();
      if (!ok) { myStopAiTimer(); return; }
    }
    const fullPrompt =
      'System Instructions: ' + systemPrompt +
      '\\n\\nIdeas submitted by participants:\\n' +
      pool.map((idea, i) => (i + 1) + '. ' + idea).join('\\n');
    try {
      const result = await myLanguageModelSession.prompt(fullPrompt);
      myStopAiTimer();
      mySetAiStatus('✅ AI complete (' + myAiTimerSeconds + 's).', 'success');
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
      mySetAiStatus('❌ AI Error: ' + err.message, 'error');
      myLanguageModelSession = null;
      document.getElementById('myAiReadyBadge').textContent = 'AI: error';
      document.getElementById('myAiReadyBadge').className = 'error';
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

  // ── Auth ─────────────────────────────────────────────
  function myLogin() {
    myUserName = document.getElementById('myAdminName').value.trim();
    const topic        = document.getElementById('myTop').value.trim();
    const password     = document.getElementById('myPass').value;
    const customPrompt = document.getElementById('myCustomPrompt').value.trim();
    if (!myUserName || !topic) { myShowError('myAdminError', 'Name and room name are required.'); return; }
    mySocket.emit('myAdminLogin', { topic, password, name: myUserName, customPrompt, duration: 240 });
  }
  function myJoin() {
    myUserName = document.getElementById('myName').value.trim();
    const topic = document.getElementById('myTopicDropdown').value;
    if (!myUserName) { myShowError('myJoinError', 'Please enter your name.'); return; }
    if (!topic)      { myShowError('myJoinError', 'No rooms available yet.'); return; }
    mySocket.emit('myJoinRoom', { topic, name: myUserName });
  }
  function myShowError(id, msg) {
    const el = document.getElementById(id);
    el.textContent = msg; el.style.display = 'block';
    setTimeout(() => el.style.display = 'none', 4000);
  }
  function mySend() {
    const inp = document.getElementById('myMsg');
    if (inp.value.trim()) {
      mySocket.emit('myUserChat', { room: myCurrentRoom, msg: inp.value.trim(), name: myUserName });
      inp.value = '';
    }
  }

  // ── Timers ───────────────────────────────────────────
  function myToggleLocalTimer() {
    if (myLocalTimerRunning) {
      clearInterval(myLocalTimerInterval); myLocalTimerInterval = null;
      myLocalTimerRunning = false; myUpdateTimerRunningUI(false);
    } else {
      myLocalTimerCountdown = myTimerMax; myLocalTimerRunning = true;
      myUpdateTimerRunningUI(true);
      myLocalTimerInterval = setInterval(() => {
        myLocalTimerCountdown--;
        const d = document.getElementById('myTimerDisplay');
        if (d) d.textContent = myLocalTimerCountdown;
        myUpdateTimerBar(myLocalTimerCountdown);
        if (myLocalTimerCountdown <= 0) {
          myLocalTimerCountdown = myTimerMax;
          mySocket.emit('myManualTrigger', myCurrentRoom);
        }
      }, 1000);
    }
  }
  function myToggleTimer() {
    mySocket.emit('myTimerControl', { room: myCurrentRoom, action: myTimerRunning ? 'stop' : 'start' });
  }
  function mySetDuration() {
    const val = parseInt(document.getElementById('myDurationInput').value);
    if (!val || val < 10) { alert('Duration must be at least 10 seconds.'); return; }
    mySocket.emit('myTimerControl', { room: myCurrentRoom, action: 'setDuration', duration: val });
  }
  function myUpdateTimerRunningUI(running) {
    myTimerRunning = running;
    const dot = document.getElementById('myTimerRunningDot');
    const btn = document.getElementById('myTimerToggleBtn');
    if (dot) dot.className = running ? 'running' : '';
    if (btn) {
      btn.textContent = running ? '⏸ Stop' : '▶ Start';
      btn.className = 'my-admin-btn ' + (running ? 'my-admin-btn-orange' : 'my-admin-btn-blue');
    }
  }
  function myUpdateTimerBar(val) {
    const bar = document.getElementById('myTimerBarInner');
    const pct = Math.max(0, (val / myTimerMax) * 100);
    bar.style.width = pct + '%';
    bar.classList.toggle('urgent', val <= 30);
    document.getElementById('myTimerText').textContent = val + 's remaining';
  }

  // ── Misc ─────────────────────────────────────────────
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
  function myToggleLog() {
    const la = document.getElementById('myLogArea');
    la.style.display = la.style.display === 'block' ? 'none' : 'block';
  }
  function myCopyFlagsLink() {
    const url = 'chrome://flags/#prompt-api-for-gemini-nano';
    try { navigator.clipboard.writeText(url); } catch (e) {
      const inp = document.createElement('input'); inp.value = url;
      document.body.appendChild(inp); inp.select(); document.execCommand('copy'); document.body.removeChild(inp);
    }
    window.open('about:blank', '_blank');
  }
  function myResetToLobby() {
    myCurrentRoom = ''; myIsAdmin = false; myTimerRunning = false;
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

  // ── Moderation queue helpers ─────────────────────────
  function myModUpdateToolbar() {
    const count = Object.keys(myModEntries).length;
    document.getElementById('myModCount').textContent = count;
    const any = count > 0;
    document.getElementById('mySendAllBtn').disabled  = !any;
    document.getElementById('myAiAllBtn').disabled    = !any;
    document.getElementById('myClearAllBtn').disabled = !any;
  }

  function myModAddEntry(id, name, msg) {
    myModEntries[id] = { name, msg };
    const queue = document.getElementById('myModerationQueue');
    const empty = document.getElementById('myModerationEmpty');
    if (empty) empty.remove();

    const initials = (name || '??').slice(0, 2).toUpperCase();
    const card = document.createElement('div');
    card.className = 'my-mod-card';
    card.dataset.id = id;
    card.innerHTML =
      '<div class="my-mod-avatar">' + myEsc(initials) + '</div>' +
      '<div class="my-mod-content">' +
        '<div class="my-mod-sender">' + myEsc(name) + '</div>' +
        '<textarea class="my-mod-text" rows="1">' + myEsc(msg) + '</textarea>' +
      '</div>' +
      '<div class="my-mod-actions">' +
        '<button class="my-mod-btn my-mod-btn-send">Send</button>' +
        '<button class="my-mod-btn my-mod-btn-ai">AI</button>' +
        '<button class="my-mod-btn my-mod-btn-del">Del</button>' +
      '</div>';

    const ta = card.querySelector('.my-mod-text');
    const autoResize = () => { ta.style.height = 'auto'; ta.style.height = ta.scrollHeight + 'px'; };
    requestAnimationFrame(autoResize);
    ta.addEventListener('input', () => {
      autoResize();
      ta.classList.add('edited');
      myModEntries[id].msg = ta.value;
      clearTimeout(ta._t);
      ta._t = setTimeout(() =>
        mySocket.emit('myEditPoolEntry', { room: myCurrentRoom, id, newMsg: ta.value }), 600);
    });

    const [sendBtn, aiBtn, delBtn] = card.querySelectorAll('.my-mod-btn');
    sendBtn.addEventListener('click', () => mySocket.emit('mySendPoolEntry',   { room: myCurrentRoom, id }));
    aiBtn.addEventListener('click',   () => mySocket.emit('myAiPoolEntry',     { room: myCurrentRoom, id }));
    delBtn.addEventListener('click',  () => mySocket.emit('myDeletePoolEntry', { room: myCurrentRoom, id }));

    queue.appendChild(card);
    queue.scrollTop = queue.scrollHeight;
    myModUpdateToolbar();
  }

  function myModRemoveEntry(id) {
    delete myModEntries[id];
    const card = document.querySelector('.my-mod-card[data-id="' + id + '"]');
    if (card) card.remove();
    const queue = document.getElementById('myModerationQueue');
    if (queue && !queue.querySelector('.my-mod-card')) {
      const e = document.createElement('div');
      e.id = 'myModerationEmpty';
      e.style.cssText = 'padding:28px 16px;text-align:center;font-family:Space Mono,monospace;font-size:0.75rem;color:#3d444d;';
      e.textContent = 'Queue is empty.';
      queue.appendChild(e);
    }
    myModUpdateToolbar();
  }

  function myModClearAll() {
    myModEntries = {};
    const queue = document.getElementById('myModerationQueue');
    queue.innerHTML = '<div id="myModerationEmpty" style="padding:28px 16px;text-align:center;font-family:Space Mono,monospace;font-size:0.75rem;color:#3d444d;">Queue is empty.</div>';
    myModUpdateToolbar();
  }

  // ── Chat render ──────────────────────────────────────
  function myAppendAiSummary(text) {
    const box = document.getElementById('myChatBox');
    const empty = document.getElementById('myEmptyState');
    if (empty) empty.remove();
    const div = document.createElement('div');
    div.className = 'my-msg-ai';
    div.innerHTML = '<div class="my-msg-ai-header">✨ AI Summary</div><div class="my-msg-ai-body">' + myEsc(text) + '</div>';
    box.appendChild(div); box.scrollTop = box.scrollHeight;
  }
  function myAppendEcho(msg) {
    const box = document.getElementById('myChatBox');
    const empty = document.getElementById('myEmptyState');
    if (empty) empty.remove();
    const div = document.createElement('div');
    div.className = 'my-msg-user';
    div.innerHTML = '<div class="my-msg-label">✓ Submitted</div>' + myEsc(msg);
    box.appendChild(div); box.scrollTop = box.scrollHeight;
  }





  function myEsc(s) {
    return (s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/\\n/g,'<br>');
  }


  // ── Presence ─────────────────────────────────────────
  function myRenderPresence(listId, items, isAdmin) {
    const el = document.getElementById(listId);
    if (!items || !items.length) { el.innerHTML = '<span style="font-size:0.75rem;color:var(--muted);">None</span>'; return; }
    if (isAdmin) {
      el.innerHTML = items.map(u => '<div class="my-presence-chip admin">' + myEsc(u.name||u) + '</div>').join('');
    } else {
      el.innerHTML = items.map(u => {
        if (myIsAdmin) {
          const sid = (u.id||'').replace(/"/g,'');
          const sn  = myEsc(u.name||u);
          return '<div class="my-presence-chip kickable" data-kick-id="'+sid+'" data-kick-name="'+sn+'">'+sn+'<span class="my-kick-x">&#x2715;</span></div>';
        }
        return '<div class="my-presence-chip">' + myEsc(u.name||u) + '</div>';
      }).join('');
      el.querySelectorAll('.kickable').forEach(chip => {
        chip.addEventListener('click', () => {
          if (!confirm('Remove ' + chip.dataset.kickName + ' from the room?')) return;
          mySocket.emit('myKickUser', { room: myCurrentRoom, userId: chip.dataset.kickId });
        });
      });
    }
  }

  // ── Socket events ────────────────────────────────────
  mySocket.on('myTopicList', (list) => {
    const sel = document.getElementById('myTopicDropdown');
    sel.innerHTML = list.length
      ? list.map(t => '<option value="'+t+'">'+t+'</option>').join('')
      : '<option value="">No rooms yet</option>';
  });

  mySocket.on('myAuthError', msg => myShowError('myAdminError', '⚠ ' + msg));

  mySocket.on('myAdminAuthSuccess', async (data) => {
    myIsAdmin = true; myIsFirstAdmin = data.isFirstAdmin;
    myCurrentRoom = data.topic; myTimerMax = data.duration;

    document.getElementById('myAuthPanel').style.display    = 'none';
    document.getElementById('myAdminDashboard').style.display = 'block';
    document.getElementById('myInputArea').style.display    = 'block';
    document.getElementById('myTimerBar').style.display     = 'block';
    document.getElementById('mySidePanel').style.display    = 'block';
    document.getElementById('myRoomBadge').textContent      = '# ' + data.topic;
    document.getElementById('myRoomBadge').style.display    = 'block';
    document.getElementById('myPrompt').value               = data.prompt;
    document.getElementById('myDurationInput').value        = data.duration;

    if (!data.isFirstAdmin) {
      document.getElementById('myMainTimerLabel').textContent = 'My Local Timer';
    }

    const shareBar = document.getElementById('myShareBar');
    shareBar.style.display = 'flex';
    document.getElementById('myShareUrl').value = 'https://ai-chat-brainstorm.onrender.com/';

    myUpdateTimerRunningUI(data.timerRunning);

    if (data.logs && data.logs.length) {
      const la = document.getElementById('myLogArea');
      data.logs.forEach(l => {
        const d = document.createElement('div'); d.className = 'my-log-entry'; d.textContent = l; la.appendChild(d);
      });
    }

    // Restore pool for rejoining admin
    if (data.pool && data.pool.length) {
      data.pool.forEach(e => myModAddEntry(e.id, e.name, e.msg));
    }

    await myInitAI();
  });

  mySocket.on('myJoinedSuccess', (data) => {
    myCurrentRoom = data.topic;
    document.getElementById('myAuthPanel').style.display = 'none';
    document.getElementById('myInputArea').style.display = 'block';
    document.getElementById('myTimerBar').style.display  = 'block';
    document.getElementById('mySidePanel').style.display = 'block';
    document.getElementById('myLeaveBtn').style.display  = 'block';
    document.getElementById('myRoomBadge').textContent   = '# ' + data.topic;
    document.getElementById('myRoomBadge').style.display = 'block';
    const empty = document.getElementById('myEmptyState');
    if (empty) empty.remove();
  });

  mySocket.on('myTimerSync', (val) => {
    const d = document.getElementById('myTimerDisplay');
    if (d) d.textContent = val;
    myUpdateTimerBar(val);
  });

  mySocket.on('myPoolUpdate', (count) => {
    const el = document.getElementById('myIdeasCount');
    if (el) el.textContent = count;
  });

  mySocket.on('myPoolEntry', (data) => {
    if (myIsAdmin) myModAddEntry(data.id, data.name, data.msg);
  });

  mySocket.on('myPoolEntryUpdated', (data) => {
    if (myModEntries[data.id]) myModEntries[data.id].msg = data.newMsg;
    const card = document.querySelector('.my-mod-card[data-id="'+data.id+'"]');
    if (card) {
      const ta = card.querySelector('.my-mod-text');
      if (ta && ta !== document.activeElement) {
        ta.value = data.newMsg; ta.style.height = 'auto'; ta.style.height = ta.scrollHeight + 'px';
      }
    }
  });

  mySocket.on('myPoolEntryDeleted', (data) => myModRemoveEntry(data.id));
  mySocket.on('myPoolCleared',      ()     => myModClearAll());

  mySocket.on('myRequestAdminSummary', (data) => {
    if (myIsAdmin) {
      const prompt = document.getElementById('myPrompt').value || data.prompt;
      myRunLocalAI(data.pool, prompt, data.isAuto);
    }
  });

  mySocket.on('myBroadcastSummary', text => myAppendAiSummary(text));
  mySocket.on('myLocalEcho',        msg  => myAppendEcho(msg));
  mySocket.on('myUserUpdate',  users  => myRenderPresence('myUserList',  users, false));
  mySocket.on('myAdminUpdate', admins => myRenderPresence('myAdminList', admins.map(n=>({name:n})), true));

  mySocket.on('myTimerState', (data) => {
    myTimerMax = data.duration;
    const di = document.getElementById('myDurationInput');
    if (di) di.value = data.duration;
    if (data.secondaryOnly) { myToggleLocalTimer(); return; }
    myUpdateTimerRunningUI(data.running);
  });

  mySocket.on('myRoomShutdown', msg => { alert('⚠️ ' + msg); myResetToLobby(); });
  mySocket.on('myLeftRoom',     ()  => myResetToLobby());

  mySocket.on('myServerLog', entry => {
    const la = document.getElementById('myLogArea');
    const d = document.createElement('div');
    d.className = 'my-log-entry'; d.textContent = entry;
    la.appendChild(d); la.scrollTop = la.scrollHeight;
  });

  // ── Wire up all event listeners ──────────────────────
  window.addEventListener('DOMContentLoaded', () => {
    document.getElementById('myTabJoinBtn').addEventListener('click',  () => myShowTab('join'));
    document.getElementById('myTabAdminBtn').addEventListener('click', () => myShowTab('admin'));

    document.getElementById('myJoinBtn').addEventListener('click',      myJoin);
    document.getElementById('myAdminLoginBtn').addEventListener('click', myLogin);
    document.getElementById('myName').addEventListener('keydown',      e => { if (e.key==='Enter') myJoin(); });
    document.getElementById('myAdminName').addEventListener('keydown', e => { if (e.key==='Enter') myLogin(); });
    document.getElementById('myPass').addEventListener('keydown',      e => { if (e.key==='Enter') myLogin(); });

    document.getElementById('mySendBtn').addEventListener('click', mySend);
    document.getElementById('myMsg').addEventListener('keydown', e => { if (e.key==='Enter' && !e.shiftKey) { e.preventDefault(); mySend(); } });

    document.getElementById('myLeaveBtnInner').addEventListener('click', myLeaveRoom);
    document.getElementById('myCopyUrlBtn').addEventListener('click',    myCopyRoomUrl);
    document.getElementById('myTimerToggleBtn').addEventListener('click', myToggleTimer);
    document.getElementById('mySetDurationBtn').addEventListener('click', mySetDuration);
    document.getElementById('myDurationInput').addEventListener('keydown', e => { if (e.key==='Enter') mySetDuration(); });
    document.getElementById('myFlagsLink').addEventListener('click',    myCopyFlagsLink);
    document.getElementById('myInitAiBtn').addEventListener('click',    myInitAI);
    document.getElementById('myApproveBtn').addEventListener('click',   myApproveSummary);
    document.getElementById('myDiscardBtn').addEventListener('click',   myDismissReview);
    document.getElementById('myToggleLogBtn').addEventListener('click', myToggleLog);
    document.getElementById('myShutdownBtn').addEventListener('click',  myShutdownRoom);

    // Moderation toolbar
    document.getElementById('mySendAllBtn').addEventListener('click', () => {
      mySocket.emit('mySendAllPool', myCurrentRoom);
    });
    document.getElementById('myAiAllBtn').addEventListener('click', () => {
      const pool = Object.values(myModEntries).map(e => e.name + ': ' + e.msg);
      const prompt = document.getElementById('myPrompt').value;
      myRunLocalAI(pool, prompt, false);
    });
    document.getElementById('myClearAllBtn').addEventListener('click', () => {
      if (!confirm('Clear all messages from the queue without broadcasting?')) return;
      mySocket.emit('myClearPool', myCurrentRoom);
    });

    // AI badge on load
    const avail = (typeof LanguageModel !== 'undefined') || (window.ai && window.ai.languageModel);
    const badge = document.getElementById('myAiReadyBadge');
    badge.textContent = avail ? 'AI: available' : 'AI: unavailable';
    badge.className   = avail ? 'loading' : 'error';
  });
</script>
</body>
</html>`;
}

myServer.listen(process.env.PORT || 3000, () => {
  console.log('Server running on port 3000');
});
