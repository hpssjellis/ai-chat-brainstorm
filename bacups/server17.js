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
      // Signal admins to run their local AI
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
        prompt: customPrompt || 'Summarize these brainstorm ideas into clear themes.',
        pool: [],
        timer: parseInt(duration) || 240,
        admins: [],
        users: [],
        intervalId: null,
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

    mySocket.emit('myAdminAuthSuccess', {
      prompt: myRoom.prompt,
      topic: myRoomName,
      duration: myRoom.timer,
      name,
      logs: myRoom.logs
    });
    myIo.to(myRoomName).emit('myUserUpdate', myRoom.users);
    myIo.to(myRoomName).emit('myAdminUpdate', myRoom.admins.map(a => a.name));
    myStartRoomTimer(myRoomName);
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
    myRooms[room].pool.push(`${name}: ${msg}`);
    mySocket.emit('myLocalEcho', msg);
    myIo.to(room).emit('myPoolUpdate', myRooms[room].pool.length);
    myLog(room, `Idea from "${name}".`);
  });

  // Admin manually triggers AI
  mySocket.on('myManualTrigger', (myRoomName) => {
    const myRoom = myRooms[myRoomName];
    if (!myRoom) return;
    myResetRoomCountdown(myRoomName);
    myIo.to(mySocket.id).emit('myRequestAdminSummary', { pool: myRoom.pool, prompt: myRoom.prompt, isAuto: false });
  });

  // Admin finished processing AI locally, now broadcasting to everyone
  mySocket.on('mySubmitFinishedSummary', (myData) => {
    const { room, text } = myData;
    if (!myRooms[room]) return;
    myRooms[room].pool = []; // Clear pool after successful summary
    myIo.to(room).emit('myBroadcastSummary', text);
    myIo.to(room).emit('myPoolUpdate', 0);
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
  <title>Local AI Brainstorm</title>
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <style>
    body { font-family: sans-serif; background: #f4f4f9; padding: 20px; }
    .card { background: white; padding: 15px; border-radius: 8px; box-shadow: 0 2px 5px rgba(0,0,0,0.1); margin-bottom: 10px; }
    .btn-primary { background: #1a73e8; color: white; border: none; padding: 8px 15px; border-radius: 4px; cursor: pointer; }
    .btn-warn { background: #f29900; color: white; border: none; padding: 8px 15px; border-radius: 4px; cursor: pointer; }
    #myChatBox { height: 300px; overflow-y: auto; border: 1px solid #ddd; padding: 10px; background: #fff; }
    .msg-ai { background: #e8f0fe; padding: 10px; margin: 10px 0; border-left: 4px solid #1a73e8; }
    .admin-only { display: none; border: 2px solid #1a73e8; }
  </style>
</head>
<body>
  <h2 id="myTitle">🧠 Brainstorm Hub</h2>

  <div id="myAuthPanel" class="card">
    <input id="myName" type="text" placeholder="Your Name"><br><br>
    <select id="myTopicDropdown"></select> <button onclick="myJoin()">Join Room</button>
    <hr>
    <b>Admin Setup:</b><br>
    <input id="myTop" type="text" placeholder="Room Name">
    <input id="myPass" type="password" placeholder="Password">
    <button onclick="myLogin()">Create/Admin Login</button>
  </div>

  <div id="myAdminDashboard" class="card admin-only">
    <div style="display:flex; justify-content:space-between;">
        <b>ADMIN DASHBOARD</b>
        <span>⏱ <span id="myTimerDisplay">--</span>s</span>
    </div>
    <div style="margin: 10px 0;">
        <label><input type="checkbox" id="myReviewToggle" checked> Review AI summary before broadcasting</label>
    </div>
    <div id="myReviewArea" style="display:none; background:#fff9c4; padding:10px; margin-bottom:10px;">
        <b>Review AI Output:</b><br>
        <textarea id="myAiReviewText" style="width:100%; height:100px;"></textarea><br>
        <button class="btn-primary" onclick="myApproveSummary()">Post to Room</button>
    </div>
    <input id="myPrompt" type="text" placeholder="AI System Prompt" style="width:70%;">
    <button class="btn-warn" onclick="myManualAI()">Manual AI Trigger (<span id="myCount">0</span>)</button>
    <div id="myAiStatus" style="font-size:0.8em; color:blue;"></div>
  </div>

  <div class="card" style="padding:0;">
    <div id="myChatBox"></div>
  </div>

  <div id="myInputArea" style="display:none; margin-top:10px;">
    <input id="myMsg" type="text" style="width:70%;" placeholder="Enter idea..." onkeypress="if(event.key==='Enter') mySend()">
    <button onclick="mySend()">Send 💡</button>
  </div>

  <script src="/socket.io/socket.io.js"></script>
  <script>
    const mySocket = io();
    let myLanguageModelSession = null;
    let myCurrentRoom = '';
    let myUserName = '';
    let myIsAdmin = false;

    // --- Init Local AI ---
    async function myInitAI() {
        if (!window.ai || !window.ai.languageModel) {
            console.error("Chrome Built-in AI not found.");
            return false;
        }
        try {
            myLanguageModelSession = await window.ai.languageModel.create();
            return true;
        } catch (e) {
            console.error("Failed to start AI session", e);
            return false;
        }
    }

    // --- Actions ---
    function myLogin() {
        myUserName = document.getElementById('myName').value;
        mySocket.emit('myAdminLogin', {
            topic: document.getElementById('myTop').value,
            password: document.getElementById('myPass').value,
            name: myUserName,
            duration: 240
        });
    }

    function myJoin() {
        myUserName = document.getElementById('myName').value;
        mySocket.emit('myJoinRoom', { topic: document.getElementById('myTopicDropdown').value, name: myUserName });
    }

    function mySend() {
        const inp = document.getElementById('myMsg');
        if (inp.value) {
            mySocket.emit('myUserChat', { room: myCurrentRoom, msg: inp.value, name: myUserName });
            inp.value = '';
        }
    }

    function myManualAI() {
        mySocket.emit('myManualTrigger', myCurrentRoom);
    }

    async function myRunLocalAI(pool, systemPrompt, isAuto) {
        document.getElementById('myAiStatus').textContent = "🤖 Local AI Working...";
        if (!myLanguageModelSession) await myInitAI();
        
        const fullPrompt = "System Instructions: " + systemPrompt + "\\n\\nData to summarize:\\n" + pool.join("\\n");
        
        try {
            const result = await myLanguageModelSession.prompt(fullPrompt);
            document.getElementById('myAiStatus').textContent = "✅ AI Done.";
            
            const needsReview = document.getElementById('myReviewToggle').checked;
            
            if (needsReview) {
                document.getElementById('myReviewArea').style.display = 'block';
                document.getElementById('myAiReviewText').value = result;
            } else if (isAuto) {
                // Only auto-send if the timer triggered it and review is OFF
                myBroadcastResult(result);
            } else {
                // Manual trigger with review off still shows in review box just in case
                document.getElementById('myReviewArea').style.display = 'block';
                document.getElementById('myAiReviewText').value = result;
            }
        } catch (err) {
            document.getElementById('myAiStatus').textContent = "❌ AI Error: " + err.message;
        }
    }

    function myApproveSummary() {
        const text = document.getElementById('myAiReviewText').value;
        myBroadcastResult(text);
        document.getElementById('myReviewArea').style.display = 'none';
    }

    function myBroadcastResult(text) {
        mySocket.emit('mySubmitFinishedSummary', { room: myCurrentRoom, text: text });
    }

    // --- Socket Events ---
    mySocket.on('myTopicList', (list) => {
        const sel = document.getElementById('myTopicDropdown');
        sel.innerHTML = list.map(t => '<option value="'+t+'">'+t+'</option>').join('');
    });

    mySocket.on('myAdminAuthSuccess', async (data) => {
        myIsAdmin = true;
        myCurrentRoom = data.topic;
        document.getElementById('myAuthPanel').style.display = 'none';
        document.getElementById('myAdminDashboard').style.display = 'block';
        document.getElementById('myInputArea').style.display = 'block';
        document.getElementById('myPrompt').value = data.prompt;
        myInitAI();
    });

    mySocket.on('myJoinedSuccess', (data) => {
        myCurrentRoom = data.topic;
        document.getElementById('myAuthPanel').style.display = 'none';
        document.getElementById('myInputArea').style.display = 'block';
    });

    mySocket.on('myTimerSync', (val) => {
        document.getElementById('myTimerDisplay').textContent = val;
    });

    mySocket.on('myPoolUpdate', (count) => {
        if(document.getElementById('myCount')) document.getElementById('myCount').textContent = count;
    });

    mySocket.on('myRequestAdminSummary', (data) => {
        if (myIsAdmin && data.pool.length > 0) {
            myRunLocalAI(data.pool, data.prompt, data.isAuto);
        }
    });

    mySocket.on('myBroadcastSummary', (text) => {
        const box = document.getElementById('myChatBox');
        box.innerHTML += '<div class="msg-ai"><b>✨ AI Summary</b><br>' + text.replace(/\\n/g, '<br>') + '</div>';
        box.scrollTop = box.scrollHeight;
    });

    mySocket.on('myLocalEcho', (m) => {
        const box = document.getElementById('myChatBox');
        box.innerHTML += '<div style="color:#888; font-size:0.8em;">✓ Submitted: ' + m + '</div>';
        box.scrollTop = box.scrollHeight;
    });
  </script>
</body>
</html>`;
}

myServer.listen(process.env.PORT || 3000, () => {
  console.log('Server running on port 3000');
});
