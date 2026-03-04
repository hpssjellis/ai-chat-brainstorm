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

    if (myIsFirstAdmin) myStartRoomTimer(myRoomName);

    mySocket.emit('myAdminAuthSuccess', {
      prompt: myRoom.prompt, topic: myRoomName, duration: myRoom.timer, name,
      logs: myRoom.logs, timerRunning: !!myRoom.intervalId,
      isFirstAdmin: myIsFirstAdmin, pool: myRoom.pool
    });
    myIo.to(myRoomName).emit('myUserUpdate', myRoom.users);
    myIo.to(myRoomName).emit('myAdminUpdate', myRoom.admins.map(a => a.name));
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

  // ── Admin: release entry as normal chat to all participants ──
  mySocket.on('myReleasePoolEntry', (myData) => {
    const { room, id, name, msg } = myData;
    const myRoom = myRooms[room];
    if (!myRoom || !myRoom.admins.some(a => a.id === mySocket.id)) return;
    myRoom.pool = myRoom.pool.filter(e => e.id !== id);
    myIo.to(room).emit('myPoolUpdate', myRoom.pool.length);
    myRoom.admins.forEach(admin => {
      if (admin.id !== mySocket.id) myIo.to(admin.id).emit('myPoolEntryDeleted', { id });
    });
    // Broadcast as a normal chat message visible to everyone
    myIo.to(room).emit('myReleasedChat', { name, msg });
    myLog(room, `Admin released entry from "${name}" as normal chat.`);
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
    // Remove from pool so it doesn't get included in future bulk AI calls
    myRoom.pool = myRoom.pool.filter(e => e.id !== id);
    myIo.to(room).emit('myPoolUpdate', myRoom.pool.length);
    myRoom.admins.forEach(admin => {
      if (admin.id !== mySocket.id) myIo.to(admin.id).emit('myPoolEntryDeleted', { id });
    });
    myIo.to(mySocket.id).emit('myRequestAdminSummary', { pool: [entry.text], prompt: myRoom.prompt, isAuto: false, singleEntry: true });
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

  // ── Admin: broadcast a message directly to the room ──
  mySocket.on('myAdminBroadcast', (myData) => {
    const { room, text } = myData;
    const myRoom = myRooms[room];
    if (!myRoom || !myRoom.admins.some(a => a.id === mySocket.id)) return;
    const admin = myRoom.admins.find(a => a.id === mySocket.id);
    myIo.to(room).emit('myAdminDirectMsg', { text, adminName: admin?.name || 'Admin' });
    myLog(room, `Admin "${admin?.name || 'Admin'}" broadcast message directly.`);
  });

  // ── Admin broadcasts AI thinking status to room ──
  mySocket.on('myAiThinking', (myData) => {
    const { room, thinking } = myData;
    const myRoom = myRooms[room];
    if (!myRoom) return;
    const timestamp = new Date().toLocaleTimeString();
    if (thinking) {
      myIo.to(room).emit('myAiThinking', { thinking: true });
      myLog(room, `🤖 AI called at ${timestamp}.`);
    } else {
      myIo.to(room).emit('myAiThinking', { thinking: false });
      myLog(room, `📢 AI result ready at ${timestamp}.`);
    }
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
    const { room, text, singleEntry } = myData;
    if (!myRooms[room]) return;
    myIo.to(room).emit('myBroadcastSummary', text);
    if (!singleEntry) {
      // Full pool AI: clear everything
      myRooms[room].pool = [];
      myIo.to(room).emit('myPoolUpdate', 0);
      myRooms[room].admins.forEach(admin => myIo.to(admin.id).emit('myPoolCleared'));
    } else {
      // Single entry AI: pool entry was already removed; just update the count
      myIo.to(room).emit('myPoolUpdate', myRooms[room].pool.length);
    }
    const broadcastTime = new Date().toLocaleTimeString();
    myLog(room, `📢 AI Summary broadcast to room at ${broadcastTime}.`);
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
  <title>AI and Human in the Loop Brainstorming Chat</title>
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <link href="https://fonts.googleapis.com/css2?family=Space+Mono:wght@400;700&family=Syne:wght@400;600;800&display=swap" rel="stylesheet">
  <style>
    :root {
      --ink: #2a2a2a;
      --paper: #f8f6f1;
      --accent: #e84c1e;
      --accent2: #2d7df5;
      --muted: #8a8a8a;
      --border: #ddd9d0;
      --admin-bg: #1e2430;
      --admin-fg: #dde3ec;
      --admin-accent: #79bfff;
      --admin-warn: #ffaa55;
      --admin-success: #4fd060;
      --card-shadow: 0 1px 3px rgba(0,0,0,0.09), 0 4px 12px rgba(0,0,0,0.06);
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
    .my-msg-admin { background: linear-gradient(135deg, #fff8ee 0%, #fff3e0 100%); padding: 14px 16px; border-radius: 10px; border-left: 4px solid #e8a020; animation: mySlideIn 0.4s ease; }
    .my-msg-admin-header { font-size: 0.7rem; font-weight: 700; letter-spacing: 0.08em; text-transform: uppercase; color: #c47a10; margin-bottom: 8px; display: flex; align-items: center; gap: 6px; }
    .my-msg-admin-body { font-size: 0.88rem; line-height: 1.65; color: var(--ink); white-space: pre-wrap; }
    @keyframes mySlideIn { from { opacity: 0; transform: translateY(10px); } to { opacity: 1; transform: translateY(0); } }
    #myEmptyState { display: flex; flex-direction: column; align-items: center; justify-content: center; height: 100%; color: var(--muted); gap: 8px; font-size: 0.85rem; }
    #myEmptyState .my-icon { font-size: 2.5rem; }

    /* Chat input */
    #myInputArea { display: none; margin-top: 12px; }
    #myInputArea .my-input-row { align-items: center; }
    #myMsg { flex: 1; margin-bottom: 0; }

    /* Admin dashboard */
    #myAdminDashboard { display: none; background: var(--admin-bg); color: var(--admin-fg); border: 1px solid #3a4255; border-radius: 12px; padding: 20px; margin-bottom: 16px; box-shadow: var(--card-shadow); }
    #myAdminDashboard .my-card-title { color: #7a8499; }

    .my-admin-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; margin-bottom: 14px; }
    .my-stat-box { background: #262f3e; border: 1px solid #3a4255; border-radius: 8px; padding: 12px; text-align: center; }
    .my-stat-num { font-family: 'Space Mono', monospace; font-size: 1.8rem; font-weight: 700; color: var(--admin-accent); line-height: 1; }
    .my-stat-label { font-size: 0.68rem; color: #7a8499; margin-top: 4px; text-transform: uppercase; letter-spacing: 0.06em; }

    .my-admin-input { width: 100%; padding: 9px 13px; border: 1px solid #3a4255; border-radius: 8px; font-family: 'Space Mono', monospace; font-size: 0.8rem; background: #262f3e; color: var(--admin-fg); margin-bottom: 10px; transition: border-color 0.2s; }
    .my-admin-input:focus { outline: none; border-color: var(--admin-accent); }

    .my-admin-btn { padding: 9px 16px; border: none; border-radius: 7px; font-family: 'Syne', sans-serif; font-weight: 700; font-size: 0.82rem; cursor: pointer; transition: all 0.15s; }
    .my-admin-btn:active { transform: scale(0.97); }
    .my-admin-btn-blue   { background: var(--admin-accent); color: #1e2430; }
    .my-admin-btn-blue:hover   { background: #9fd0ff; }
    .my-admin-btn-orange { background: var(--admin-warn); color: #1e2430; }
    .my-admin-btn-orange:hover { background: #ffc077; }
    .my-admin-btn-green  { background: var(--admin-success); color: #1e2430; }
    .my-admin-btn-green:hover  { background: #6ddf7e; }
    .my-admin-btn-red    { background: #e04040; color: white; }
    .my-admin-btn-red:hover    { background: #f86060; }
    .my-admin-btn-full { width: 100%; }
    .my-admin-btn:disabled { opacity: 0.4; cursor: not-allowed; }

    /* Timer controls */
    #myTimerControls { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; background: #262f3e; border: 1px solid #3a4255; border-radius: 8px; padding: 10px 12px; margin-bottom: 12px; }
    #myTimerControls .my-tc-label { font-size: 0.68rem; text-transform: uppercase; letter-spacing: 0.07em; color: #7a8499; }
    #myDurationInput { width: 72px; padding: 5px 8px; border: 1px solid #3a4255; border-radius: 5px; font-family: 'Space Mono', monospace; font-size: 0.8rem; background: #1e2430; color: var(--admin-fg); text-align: center; }
    #myDurationInput:focus { outline: none; border-color: var(--admin-accent); }
    #myTimerRunningDot { width: 8px; height: 8px; border-radius: 50%; background: #7a8499; flex-shrink: 0; transition: background 0.3s; }
    #myTimerRunningDot.running { background: var(--admin-success); box-shadow: 0 0 6px var(--admin-success); animation: myPulse 1.4s infinite; }
    @keyframes myPulse { 0%,100%{opacity:1} 50%{opacity:0.4} }

    /* AI status */
    #myAiStatus { font-family: 'Space Mono', monospace; font-size: 0.75rem; color: var(--admin-accent); min-height: 18px; margin: 8px 0; }
    #myAiStatus.error   { color: #f85149; }
    #myAiStatus.success { color: var(--admin-success); }
    #myAiTimer { font-family: 'Space Mono', monospace; font-size: 0.75rem; color: #586069; }

    /* Review area */
    #myReviewArea { display: none; background: #262f3e; border: 1px solid #ffaa5555; border-radius: 8px; padding: 14px; margin: 12px 0; animation: mySlideIn 0.3s ease; }
    #myReviewArea .my-review-header { font-size: 0.7rem; font-weight: 700; letter-spacing: 0.08em; text-transform: uppercase; color: var(--admin-warn); margin-bottom: 10px; display: flex; align-items: center; gap: 6px; }
    #myAiReviewText { width: 100%; min-height: 120px; padding: 10px; border: 1px solid #3a4255; border-radius: 6px; background: #1e2430; color: var(--admin-fg); font-family: 'Space Mono', monospace; font-size: 0.8rem; line-height: 1.5; resize: vertical; margin-bottom: 10px; }
    #myAiReviewText:focus { outline: none; border-color: var(--admin-warn); }

    /* ══════════════════════════════════════════
       MODERATION QUEUE
    ══════════════════════════════════════════ */
    #myModerationPanel { background: #1e2430; border: 1px solid #3a4255; border-radius: 10px; overflow: hidden; margin-bottom: 14px; }

    #myModerationToolbar { display: flex; align-items: center; gap: 8px; padding: 10px 14px; background: #262f3e; border-bottom: 1px solid #3a4255; flex-wrap: wrap; }
    .my-mod-title { font-size: 0.68rem; font-weight: 700; letter-spacing: 0.1em; text-transform: uppercase; color: #7a8499; white-space: nowrap; }
    .my-mod-count { font-family: 'Space Mono', monospace; font-size: 0.72rem; color: var(--admin-accent); background: #2e3a50; padding: 2px 8px; border-radius: 10px; margin-right: auto; }

    .my-mod-toolbar-btn { padding: 5px 12px; border: none; border-radius: 6px; font-family: 'Syne', sans-serif; font-weight: 700; font-size: 0.75rem; cursor: pointer; transition: all 0.15s; white-space: nowrap; }
    .my-mod-toolbar-btn:active { transform: scale(0.97); }
    .my-mod-send-all  { background: var(--admin-success); color: #1e2430; }
    .my-mod-send-all:hover  { background: #6ddf7e; }
    .my-mod-ai-all    { background: var(--admin-warn); color: #1e2430; }
    .my-mod-ai-all:hover    { background: #ffc077; }
    .my-mod-clear-all { background: #2e3a50; color: #9aa3b5; border: 1px solid #3a4255; }
    .my-mod-clear-all:hover { background: #3a4255; color: var(--admin-fg); }
    .my-mod-toolbar-btn:disabled { opacity: 0.35; cursor: not-allowed; }

    #myModerationQueue { max-height: 380px; overflow-y: auto; }
    #myModerationEmpty { padding: 28px 16px; text-align: center; font-family: 'Space Mono', monospace; font-size: 0.75rem; color: #4a5568; }

    .my-mod-card { display: flex; align-items: flex-start; gap: 10px; padding: 10px 14px; border-bottom: 1px solid #262f3e; animation: mySlideIn 0.25s ease; transition: background 0.15s; }
    .my-mod-card:last-child { border-bottom: none; }
    .my-mod-card:hover { background: #222b3a; }

    .my-mod-avatar { width: 30px; height: 30px; border-radius: 50%; background: #2e3a50; border: 1px solid #3a4255; display: flex; align-items: center; justify-content: center; font-size: 0.62rem; font-weight: 700; color: var(--admin-accent); flex-shrink: 0; font-family: 'Space Mono', monospace; text-transform: uppercase; margin-top: 2px; }

    .my-mod-content { flex: 1; min-width: 0; }
    .my-mod-sender { font-size: 0.68rem; font-weight: 700; color: var(--admin-accent); margin-bottom: 5px; font-family: 'Space Mono', monospace; letter-spacing: 0.04em; }
    .my-mod-text { width: 100%; background: transparent; border: 1px solid transparent; border-radius: 5px; font-family: 'Space Mono', monospace; font-size: 0.78rem; color: var(--admin-fg); line-height: 1.5; padding: 3px 6px; resize: none; overflow: hidden; transition: border-color 0.15s, background 0.15s; }
    .my-mod-text:focus { outline: none; border-color: #3a4255; background: #1e2430; }
    .my-mod-text.edited { border-color: #ffaa5544; background: #1e2430; }

    .my-mod-actions { display: flex; flex-direction: column; gap: 4px; flex-shrink: 0; padding-top: 2px; }
    .my-mod-btn { padding: 4px 0; border: none; border-radius: 5px; font-family: 'Syne', sans-serif; font-weight: 700; font-size: 0.69rem; cursor: pointer; transition: all 0.12s; width: 48px; text-align: center; }
    .my-mod-btn:active { transform: scale(0.95); }
    .my-mod-btn-send { background: #1f3d30; color: var(--admin-success); border: 1px solid #2d6e45; }
    .my-mod-btn-send:hover { background: #2d6e45; color: #1e2430; }
    .my-mod-btn-ai   { background: #3a2a0e; color: var(--admin-warn); border: 1px solid #7a4a10; }
    .my-mod-btn-ai:hover   { background: var(--admin-warn); color: #1e2430; }
    .my-mod-btn-del  { background: #2e3a50; color: #9aa3b5; border: 1px solid #3a4255; }
    .my-mod-btn-del:hover  { background: #6e2020; color: #ff8080; border-color: #6e2020; }

    /* Toggle */
    .my-toggle-row { display: flex; align-items: center; gap: 10px; padding: 8px 0; }
    .my-toggle { position: relative; width: 36px; height: 20px; flex-shrink: 0; }
    .my-toggle input { opacity: 0; width: 0; height: 0; }
    .my-toggle-slider { position: absolute; inset: 0; background: #30363d; border-radius: 20px; transition: 0.2s; cursor: pointer; }
    .my-toggle-slider::before { content: ''; position: absolute; width: 14px; height: 14px; left: 3px; top: 3px; background: white; border-radius: 50%; transition: 0.2s; }
    .my-toggle input:checked + .my-toggle-slider { background: var(--admin-accent); }
    .my-toggle input:checked + .my-toggle-slider::before { transform: translateX(16px); }

    /* Released-to-chat message style */
    .my-msg-released { background: linear-gradient(135deg, #f0fff4 0%, #e8f5e9 100%); padding: 12px 16px; border-radius: 10px; border-left: 4px solid #43a047; animation: mySlideIn 0.4s ease; }
    .my-msg-released-header { font-size: 0.7rem; font-weight: 700; letter-spacing: 0.08em; text-transform: uppercase; color: #2e7d32; margin-bottom: 6px; }
    .my-msg-released-body { font-size: 0.88rem; line-height: 1.6; color: var(--ink); white-space: pre-wrap; }

    /* Release button in mod card */
    .my-mod-btn-release { background: #1a3a2a; color: #6ddf7e; border: 1px solid #2d6e45; }
    .my-mod-btn-release:hover { background: #2d6e45; color: #1e2430; }

    /* AI setup guide */
    #myAiNotice { background: #fff8e1; border: 1px solid #ffe082; border-radius: 8px; padding: 14px 16px; font-size: 0.8rem; color: #795548; margin-bottom: 10px; display: none; }
    #myAiNotice a { color: var(--accent2); }
    .my-ai-check { font-size: 0.78rem; padding: 2px 0; }

    /* Errors */
    .my-error-msg { background: #ffeaea; border: 1px solid #ffcdd2; color: #b71c1c; padding: 10px 14px; border-radius: 8px; font-size: 0.85rem; margin-bottom: 10px; display: none; }

    /* Log */
    #myLogArea { display: none; background: #1e2430; border: 1px solid #3a4255; border-radius: 8px; padding: 10px; max-height: 200px; overflow-y: auto; margin-top: 10px; }
    .my-log-entry { font-family: 'Space Mono', monospace; font-size: 0.7rem; color: #8a9ab5; padding: 3px 0; border-bottom: 1px solid #262f3e; }
    .my-log-entry:last-child { border-bottom: none; }
    .my-log-entry.log-ai-call { color: #79bfff; }
    .my-log-entry.log-ai-broadcast { color: #4fd060; }
    .my-log-entry.log-warn { color: #ffaa55; }

    /* Presence */
    #mySidePanel { display: none; }
    .my-presence-list { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 8px; }
    .my-presence-chip { padding: 4px 10px; border-radius: 20px; font-size: 0.75rem; font-weight: 600; background: #f0ede6; color: var(--ink); border: 1px solid var(--border); }
    .my-presence-chip.admin { background: #fff3e0; border-color: #ffcc80; color: #e65100; }
    .my-presence-chip.kickable { cursor: pointer; display: flex; align-items: center; gap: 5px; transition: background 0.15s; }
    .my-presence-chip.kickable:hover { background: #ffeaea; border-color: #ffcdd2; color: #b71c1c; }
    .my-presence-chip.kickable .my-kick-x { font-size: 0.7rem; opacity: 0.5; }

    .my-divider { border: none; border-top: 1px solid var(--border); margin: 14px 0; }
    #myDangerZone { border-top: 1px solid #3a4255; margin-top: 12px; padding-top: 12px; }
    #myLeaveBtn { display: none; margin-top: 10px; }

    /* AI Thinking Banner */
    #myAiThinkingBanner { display: none; background: linear-gradient(135deg, #1e2a45, #1e3040); border: 1px solid #4488cc55; border-radius: 8px; padding: 10px 16px; margin-bottom: 10px; text-align: center; font-family: 'Space Mono', monospace; font-size: 0.82rem; color: #79bfff; animation: myPulse 1.5s infinite; }

    /* Tile size control */
    #myTileSizeBar { display: none; align-items: center; gap: 10px; padding: 8px 12px; background: #f0ede6; border-radius: 8px; margin-bottom: 10px; }
    #myTileSizeBar label { font-size: 0.72rem; font-weight: 600; color: var(--muted); text-transform: uppercase; letter-spacing: 0.06em; white-space: nowrap; }
    #myTileSizeSlider { flex: 1; cursor: pointer; accent-color: var(--accent2); }
    #myTileSizeLabel { font-family: 'Space Mono', monospace; font-size: 0.72rem; color: var(--muted); min-width: 28px; }

    /* Message count on presence chips */
    .my-presence-chip .my-msg-count { font-family: 'Space Mono', monospace; font-size: 0.65rem; background: var(--accent2); color: white; border-radius: 10px; padding: 1px 6px; margin-left: 4px; }

    /* Admin broadcast textarea */
    #myBroadcastArea { display: none; background: #262f3e; border: 1px solid #3a4255; border-radius: 8px; padding: 12px; margin-bottom: 12px; }
    #myBroadcastArea .my-ba-label { font-size: 0.68rem; font-weight: 700; letter-spacing: 0.08em; text-transform: uppercase; color: #79bfff; margin-bottom: 8px; }
    #myBroadcastText { width: 100%; min-height: 80px; padding: 9px; border: 1px solid #3a4255; border-radius: 6px; background: #1e2430; color: var(--admin-fg); font-family: 'Space Mono', monospace; font-size: 0.8rem; line-height: 1.5; resize: vertical; margin-bottom: 8px; }
    #myBroadcastText:focus { outline: none; border-color: var(--admin-accent); }

    /* Prompt preview box */
    #myPromptPreview { display: none; background: #1e2430; border: 1px solid #3a4255; border-radius: 6px; padding: 8px 10px; margin-bottom: 10px; font-family: 'Space Mono', monospace; font-size: 0.72rem; color: #8a9ab5; line-height: 1.5; max-height: 120px; overflow-y: auto; white-space: pre-wrap; }
    #myPromptPreviewToggle { font-size: 0.68rem; color: #7a8499; cursor: pointer; text-decoration: underline; margin-bottom: 6px; display: inline-block; }

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

    <!-- AI Thinking Banner -->
    <div id="myAiThinkingBanner">🤖 AI is thinking… please wait</div>

    <!-- Tile Size Control -->
    <div id="myTileSizeBar">
      <label>Tile Size</label>
      <input type="range" id="myTileSizeSlider" min="280" max="800" value="400" step="20">
      <span id="myTileSizeLabel">400px</span>
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
      <div id="myShareBar" style="display:none;background:#262f3e;border:1px solid #3a4255;border-radius:8px;padding:10px 12px;margin-bottom:12px;align-items:center;gap:8px;flex-wrap:wrap;">
        <span style="font-size:0.68rem;text-transform:uppercase;letter-spacing:0.08em;color:#7a8499;white-space:nowrap;">Share URL</span>
        <input id="myShareUrl" type="text" readonly style="flex:1;min-width:120px;font-family:'Space Mono',monospace;font-size:0.75rem;color:#79bfff;background:#1e2430;border:1px solid #3a4255;border-radius:5px;padding:5px 9px;cursor:text;">
        <button id="myCopyUrlBtn" style="padding:5px 12px;background:#3a4255;border:none;border-radius:5px;color:#dde3ec;font-family:'Syne',sans-serif;font-size:0.75rem;font-weight:700;cursor:pointer;white-space:nowrap;">Copy</button>
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
        <input id="myDurationInput" type="number" min="10" max="3600" placeholder="sec" style="width:72px;padding:5px 8px;border:1px solid #3a4255;border-radius:5px;font-family:'Space Mono',monospace;font-size:0.8rem;background:#1e2430;color:#dde3ec;text-align:center;">
        <button id="mySetDurationBtn" class="my-admin-btn" style="background:#3a4255;color:#dde3ec;padding:5px 12px;font-size:0.78rem;">Set</button>
      </div>

      <!-- AI notice -->
      <div id="myAiNotice">
        <div style="font-weight:700;font-size:0.85rem;color:#795548;margin-bottom:8px;">⚠️ Chrome Built-in AI Not Available</div>
        <div id="myAiNoticeStatus" style="margin-bottom:10px;font-size:0.8rem;"></div>
        <div style="font-size:0.78rem;color:#5d4037;line-height:1.7;">
          <strong>Requirements:</strong>
          <div id="myAiChecklist" style="margin-top:6px;display:flex;flex-direction:column;gap:4px;">
            <div class="my-ai-check" id="myCheckChrome">⬜ Chrome 127+ (check chrome://version)</div>
            <div class="my-ai-check" id="myCheckSpace">⬜ ~22 GB free disk space for model download</div>
            <div class="my-ai-check" id="myCheckFlags">⬜ Chrome flags enabled (see below)</div>
          </div>
        </div>
        <div style="margin-top:10px;font-size:0.78rem;color:#5d4037;">
          <strong>Enable these flags, then restart Chrome:</strong>
        </div>
        <div style="margin-top:6px;display:flex;flex-direction:column;gap:4px;">
          <div style="display:flex;align-items:center;gap:6px;">
            <code style="font-size:0.7rem;background:#fff3e0;padding:3px 6px;border-radius:4px;flex:1;word-break:break-all;">chrome://flags/#prompt-api-for-gemini-nano</code>
            <button onclick="myCopyFlag('chrome://flags/#prompt-api-for-gemini-nano', this)" style="font-size:0.7rem;padding:3px 8px;background:#e0a040;border:none;border-radius:4px;color:#fff;cursor:pointer;white-space:nowrap;">Copy</button>
          </div>
          <div style="display:flex;align-items:center;gap:6px;">
            <code style="font-size:0.7rem;background:#fff3e0;padding:3px 6px;border-radius:4px;flex:1;word-break:break-all;">chrome://flags/#optimization-guide-on-device-model</code>
            <button onclick="myCopyFlag('chrome://flags/#optimization-guide-on-device-model', this)" style="font-size:0.7rem;padding:3px 8px;background:#e0a040;border:none;border-radius:4px;color:#fff;cursor:pointer;white-space:nowrap;">Copy</button>
          </div>
        </div>
        <div style="margin-top:10px;font-size:0.75rem;color:#8d6e63;line-height:1.6;">
          Set both flags to <strong>Enabled</strong>, restart Chrome, then visit <code style="font-size:0.7rem;background:#fff3e0;padding:1px 4px;border-radius:3px;">chrome://components</code> and click <strong>Check for update</strong> on <em>Optimization Guide On Device Model</em> to trigger the model download (~22 GB).
        </div>
        <button onclick="myInitAI()" style="margin-top:10px;padding:7px 14px;background:#e0a040;border:none;border-radius:6px;color:#fff;font-family:Syne,sans-serif;font-weight:700;font-size:0.78rem;cursor:pointer;width:100%;">↺ Re-check AI availability</button>
      </div>

      <!-- Prompt + AI controls -->
      <input id="myPrompt" type="text" class="my-admin-input" placeholder="AI System Prompt…">
      <span id="myPromptPreviewToggle" onclick="myTogglePromptPreview()">▼ Preview full prompt sent to AI</span>
      <div id="myPromptPreview"></div>
      <div style="display:flex;gap:8px;flex-wrap:wrap;margin-bottom:10px;margin-top:6px;">
        <button id="myInitAiBtn" class="my-admin-btn my-admin-btn-blue">↺ Init AI</button>
        <button id="myBroadcastToggleBtn" class="my-admin-btn" style="background:#3a4255;color:#dde3ec;">📢 Broadcast Msg</button>
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

      <!-- Broadcast Message -->
      <div id="myBroadcastArea">
        <div class="my-ba-label">📢 Broadcast Message to Room</div>
        <textarea id="myBroadcastText" placeholder="Type a message to broadcast directly to all participants…"></textarea>
        <div style="display:flex;gap:8px;">
          <button id="myBroadcastSendBtn" class="my-admin-btn my-admin-btn-green my-admin-btn-full">📢 Send to Everyone</button>
          <button id="myBroadcastCancelBtn" class="my-admin-btn" style="background:#3a4255;color:#dde3ec;">Cancel</button>
        </div>
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

      <hr style="border-color:#3a4255;margin:14px 0;">

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
        <span style="font-size:0.72rem;color:#7a8499;text-transform:uppercase;letter-spacing:0.06em;">Server Log</span>
        <button id="myToggleLogBtn" class="my-admin-btn" style="background:#262f3e;color:#7a8499;padding:4px 10px;font-size:0.72rem;">Toggle</button>
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
    mySetAiStatus('Checking AI availability…', 'normal');

    // --- Detection logic ---
    const hasLanguageModel = typeof LanguageModel !== 'undefined';
    const hasWindowAi = !!(window.ai && window.ai.languageModel);
    const avail = hasLanguageModel || hasWindowAi;

    // Update checklist UI
    const setCheck = (id, ok, text) => {
      const el = document.getElementById(id);
      if (el) { el.textContent = (ok ? '✅' : '❌') + ' ' + text; el.style.color = ok ? '#4a7c59' : '#9e3030'; }
    };

    // Chrome version check (best effort)
    const ua = navigator.userAgent;
    const chromeMatch = ua.match(/Chrome\\/([\\d]+)/);
    const chromeVer = chromeMatch ? parseInt(chromeMatch[1]) : 0;
    const isChrome = /Chrome/.test(ua) && !/Edg|OPR|Brave/.test(ua);
    const chromOk = isChrome && chromeVer >= 127;
    setCheck('myCheckChrome', chromOk,
      chromeVer > 0
        ? (chromOk ? 'Chrome ' + chromeVer + ' detected ✓' : 'Chrome ' + chromeVer + ' detected — need 127+')
        : 'Chrome 127+ required (not on Chrome or version unknown)');

    // Flags check: if LanguageModel or window.ai exists, flags are set
    setCheck('myCheckFlags', avail, avail ? 'Chrome flags enabled ✓' : 'Flags not enabled — follow instructions below');

    // We can't check disk space from JS, so just remind
    const spaceEl = document.getElementById('myCheckSpace');
    if (spaceEl) { spaceEl.textContent = 'ℹ️ ~22 GB free disk space required (cannot verify in browser)'; spaceEl.style.color = '#7a6a40'; }

    if (!avail) {
      badge.textContent = 'AI: unavailable'; badge.className = 'error';
      document.getElementById('myAiNotice').style.display = 'block';

      // Try to give more specific diagnosis
      let statusMsg = '';
      if (!isChrome) {
        statusMsg = 'Not running in Chrome — Chrome 127+ is required.';
      } else if (chromeVer > 0 && chromeVer < 127) {
        statusMsg = 'Chrome ' + chromeVer + ' detected — please update to Chrome 127 or later.';
      } else {
        statusMsg = 'Chrome flags not enabled, or model not yet downloaded. Follow the steps below.';
      }
      const noticeStatus = document.getElementById('myAiNoticeStatus');
      if (noticeStatus) noticeStatus.textContent = statusMsg;

      mySetAiStatus('Chrome Built-in AI not found.', 'error');
      return false;
    }

    // Flags present — now try to create a session
    document.getElementById('myAiNotice').style.display = 'none';
    mySetAiStatus('Initializing AI session…', 'normal');
    try {
      const api = hasLanguageModel ? LanguageModel : window.ai.languageModel;

      // Check capabilities first if available
      if (api.capabilities) {
        const caps = await api.capabilities();
        if (caps.available === 'no') {
          badge.textContent = 'AI: unavailable'; badge.className = 'error';
          document.getElementById('myAiNotice').style.display = 'block';
          const noticeStatus = document.getElementById('myAiNoticeStatus');
          if (noticeStatus) noticeStatus.textContent = 'Gemini Nano model not yet downloaded. Visit chrome://components and click "Check for update" on Optimization Guide On Device Model (~22 GB download).';
          setCheck('myCheckSpace', false, '~22 GB model not downloaded yet — visit chrome://components to trigger download');
          setCheck('myCheckFlags', true, 'Flags enabled ✓');
          mySetAiStatus('Model not downloaded yet.', 'error');
          return false;
        }
        if (caps.available === 'after-download') {
          badge.textContent = 'AI: downloading…'; badge.className = 'loading';
          mySetAiStatus('Model is downloading… try again in a few minutes.', 'normal');
          const noticeStatus = document.getElementById('myAiNoticeStatus');
          if (noticeStatus) noticeStatus.textContent = 'Model is currently downloading. Check progress at chrome://components.';
          document.getElementById('myAiNotice').style.display = 'block';
          return false;
        }
      }

      myLanguageModelSession = await api.create({ outputLanguage: 'en' });
      badge.textContent = 'AI: ready ✓'; badge.className = 'ready';
      mySetAiStatus('AI session ready.', 'success');
      document.getElementById('myAiNotice').style.display = 'none';
      return true;
    } catch (e) {
      badge.textContent = 'AI: error'; badge.className = 'error';
      document.getElementById('myAiNotice').style.display = 'block';
      const noticeStatus = document.getElementById('myAiNoticeStatus');
      if (noticeStatus) noticeStatus.textContent = 'Session failed: ' + e.message + '. The model may still be downloading — check chrome://components.';
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

  let myPendingSingleEntry = false; // tracks if current AI job is single-entry

  // ── Run AI ───────────────────────────────────────────
  async function myRunLocalAI(pool, systemPrompt, isAuto, singleEntry) {
    if (pool.length === 0) { mySetAiStatus('Pool is empty.', 'normal'); return; }
    myPendingSingleEntry = !!singleEntry;
    mySetAiStatus('🤖 AI working…', 'normal');
    myStartAiTimer();
    // Notify all participants that AI is thinking
    mySocket.emit('myAiThinking', { room: myCurrentRoom, thinking: true });
    if (!myLanguageModelSession) {
      const ok = await myInitAI();
      if (!ok) { myStopAiTimer(); mySocket.emit('myAiThinking', { room: myCurrentRoom, thinking: false }); return; }
    }
    const topic = myCurrentRoom || 'General';
    const fullPrompt =
      'Topic: ' + topic + '\\n\\n' +
      'System Instructions: ' + systemPrompt +
      '\\n\\nIdeas submitted by participants:\\n' +
      pool.map((idea, i) => (i + 1) + '. ' + idea).join('\\n');

    // Show prompt preview to admin
    const pp = document.getElementById('myPromptPreview');
    if (pp) { pp.textContent = fullPrompt; }

    try {
      const result = await myLanguageModelSession.prompt(fullPrompt);
      myStopAiTimer();
      mySocket.emit('myAiThinking', { room: myCurrentRoom, thinking: false });
      mySetAiStatus('✅ AI complete (' + myAiTimerSeconds + 's).', 'success');
      const needsReview = document.getElementById('myReviewToggle').checked;
      if (needsReview) {
        document.getElementById('myAiReviewText').value = result;
        document.getElementById('myReviewArea').style.display = 'block';
        document.getElementById('myAiReviewText').focus();
      } else {
        myBroadcastResult(result);
      }
    } catch (err) {
      myStopAiTimer();
      mySocket.emit('myAiThinking', { room: myCurrentRoom, thinking: false });
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
    myPendingSingleEntry = false;
  }
  function myBroadcastResult(text) {
    mySocket.emit('mySubmitFinishedSummary', { room: myCurrentRoom, text, singleEntry: myPendingSingleEntry });
    myPendingSingleEntry = false;
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
  function myCopyFlag(url, btn) {
    try { navigator.clipboard.writeText(url); } catch (e) {
      const inp = document.createElement('input'); inp.value = url;
      document.body.appendChild(inp); inp.select(); document.execCommand('copy'); document.body.removeChild(inp);
    }
    const orig = btn.textContent; btn.textContent = '✓ Copied!'; btn.style.background = '#4a7c59';
    setTimeout(() => { btn.textContent = orig; btn.style.background = ''; }, 2000);
    window.open('about:blank', '_blank');
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
    document.getElementById('myTileSizeBar').style.display = 'none';
    document.getElementById('myAiThinkingBanner').style.display = 'none';
    document.getElementById('myChatBox').innerHTML = '<div id="myEmptyState"><div class="my-icon">💬</div><div>Join or create a room to start brainstorming</div></div>';
    document.getElementById('myShareBar').style.display = 'none';
  }

  // ── Broadcast message helper ──────────────────────────
  function myToggleBroadcastArea() {
    const area = document.getElementById('myBroadcastArea');
    area.style.display = area.style.display === 'block' ? 'none' : 'block';
    if (area.style.display === 'block') document.getElementById('myBroadcastText').focus();
  }
  function mySendBroadcast() {
    const text = document.getElementById('myBroadcastText').value.trim();
    if (!text) return;
    mySocket.emit('myAdminBroadcast', { room: myCurrentRoom, text });
    document.getElementById('myBroadcastText').value = '';
    document.getElementById('myBroadcastArea').style.display = 'none';
  }

  // ── Prompt preview ────────────────────────────────────
  function myTogglePromptPreview() {
    const pp = document.getElementById('myPromptPreview');
    const isHidden = pp.style.display !== 'block';
    pp.style.display = isHidden ? 'block' : 'none';
    document.getElementById('myPromptPreviewToggle').textContent = isHidden ? '▲ Hide prompt preview' : '▼ Preview full prompt sent to AI';
    if (isHidden) {
      const topic = myCurrentRoom || 'Room Topic';
      const prompt = document.getElementById('myPrompt').value || '(default prompt)';
      pp.textContent = 'Topic: ' + topic + '\\n\\nSystem Instructions: ' + prompt + '\\n\\nIdeas submitted by participants:\\n1. (idea 1)\\n2. (idea 2) …';
    }
  }

  // ── Message count tracking ────────────────────────────
  let myMsgCounts = {}; // name -> count
  let myCurrentUsers = []; // keep latest user list for re-render
  function myIncrementMsgCount(name) {
    myMsgCounts[name] = (myMsgCounts[name] || 0) + 1;
    // Re-render the participant list so the badge updates immediately
    myRenderPresence('myUserList', myCurrentUsers, false);
  }

  // Moderation queue helpers ─────────────────────────────
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
    myIncrementMsgCount(name);
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
        '<button class="my-mod-btn my-mod-btn-release">Chat</button>' +
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

    const [sendBtn, aiBtn, releaseBtn, delBtn] = card.querySelectorAll('.my-mod-btn');
    sendBtn.addEventListener('click', () => { myModRemoveEntry(id); mySocket.emit('mySendPoolEntry', { room: myCurrentRoom, id }); });
    aiBtn.addEventListener('click',   () => { myModRemoveEntry(id); mySocket.emit('myAiPoolEntry', { room: myCurrentRoom, id }); });
    releaseBtn.addEventListener('click', () => {
      const currentMsg = myModEntries[id] ? myModEntries[id].msg : msg;
      const currentName = myModEntries[id] ? myModEntries[id].name : name;
      myModRemoveEntry(id);
      mySocket.emit('myReleasePoolEntry', { room: myCurrentRoom, id, name: currentName, msg: currentMsg });
    });
    delBtn.addEventListener('click', () => { myModRemoveEntry(id); mySocket.emit('myDeletePoolEntry', { room: myCurrentRoom, id }); });

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
  function myAppendAdminMsg(text, adminName) {
    const box = document.getElementById('myChatBox');
    const empty = document.getElementById('myEmptyState');
    if (empty) empty.remove();
    const div = document.createElement('div');
    div.className = 'my-msg-admin';
    div.innerHTML = '<div class="my-msg-admin-header">📢 ' + myEsc(adminName || 'Admin') + '</div><div class="my-msg-admin-body">' + myEsc(text) + '</div>';
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





  function myAppendReleasedChat(name, msg) {
    const box = document.getElementById('myChatBox');
    const empty = document.getElementById('myEmptyState');
    if (empty) empty.remove();
    const div = document.createElement('div');
    div.className = 'my-msg-released';
    div.innerHTML = '<div class="my-msg-released-header">💬 ' + myEsc(name) + '</div><div class="my-msg-released-body">' + myEsc(msg) + '</div>';
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
          const cnt = myMsgCounts[u.name||u] || 0;
          const badge = cnt > 0 ? '<span class="my-msg-count">' + cnt + '</span>' : '';
          return '<div class="my-presence-chip kickable" data-kick-id="'+sid+'" data-kick-name="'+sn+'">'+sn+badge+'<span class="my-kick-x">&#x2715;</span></div>';
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
    document.getElementById('myTileSizeBar').style.display  = 'flex';
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
        const d = document.createElement('div');
        let cls = 'my-log-entry';
        if (l.includes('🤖 AI called')) cls += ' log-ai-call';
        else if (l.includes('📢 AI Summary') || l.includes('📢 AI result')) cls += ' log-ai-broadcast';
        else if (l.includes('kicked') || l.includes('Shutdown')) cls += ' log-warn';
        d.className = cls; d.textContent = l; la.appendChild(d);
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
    document.getElementById('myTileSizeBar').style.display = 'flex';
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
      myRunLocalAI(data.pool, prompt, data.isAuto, data.singleEntry);
    }
  });

  mySocket.on('myReleasedChat', data => myAppendReleasedChat(data.name, data.msg));
  mySocket.on('myBroadcastSummary', text => myAppendAiSummary(text));
  mySocket.on('myAdminDirectMsg',   data => myAppendAdminMsg(data.text, data.adminName));
  mySocket.on('myLocalEcho',        msg  => myAppendEcho(msg));
  mySocket.on('myAiThinking',       data => {
    const banner = document.getElementById('myAiThinkingBanner');
    if (banner) banner.style.display = data.thinking ? 'block' : 'none';
  });
  mySocket.on('myUserUpdate',  users  => { myCurrentUsers = users || []; myRenderPresence('myUserList',  users, false); });
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
    let cls = 'my-log-entry';
    if (entry.includes('🤖 AI called')) cls += ' log-ai-call';
    else if (entry.includes('📢 AI Summary') || entry.includes('📢 AI result')) cls += ' log-ai-broadcast';
    else if (entry.includes('kicked') || entry.includes('shutdown') || entry.includes('Shutdown')) cls += ' log-warn';
    d.className = cls; d.textContent = entry;
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
    document.getElementById('myInitAiBtn').addEventListener('click',    myInitAI);
    document.getElementById('myApproveBtn').addEventListener('click',   myApproveSummary);
    document.getElementById('myDiscardBtn').addEventListener('click',   myDismissReview);
    document.getElementById('myToggleLogBtn').addEventListener('click', myToggleLog);
    document.getElementById('myShutdownBtn').addEventListener('click',  myShutdownRoom);
    document.getElementById('myBroadcastToggleBtn').addEventListener('click', myToggleBroadcastArea);
    document.getElementById('myBroadcastSendBtn').addEventListener('click', mySendBroadcast);
    document.getElementById('myBroadcastCancelBtn').addEventListener('click', () => { document.getElementById('myBroadcastArea').style.display = 'none'; });
    document.getElementById('myBroadcastText').addEventListener('keydown', e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); mySendBroadcast(); } });

    // Tile size slider
    const slider = document.getElementById('myTileSizeSlider');
    slider.addEventListener('input', () => {
      const val = parseInt(slider.value);
      document.getElementById('myTileSizeLabel').textContent = val + 'px';
      document.getElementById('myChatBox').style.height = val + 'px';
    });

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

    // AI badge on load — run full check
    (async () => {
      const avail = (typeof LanguageModel !== 'undefined') || (window.ai && window.ai.languageModel);
      const badge = document.getElementById('myAiReadyBadge');
      if (avail) {
        badge.textContent = 'AI: available'; badge.className = 'loading';
      } else {
        badge.textContent = 'AI: unavailable'; badge.className = 'error';
      }
    })();
  });
</script>
</body>
</html>`;
}

myServer.listen(process.env.PORT || 3000, () => {
  console.log('Server running on port 3000');
});
