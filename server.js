const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const myApp = express();
const myServer = http.createServer(myApp);
const myIo = new Server(myServer);

// Storage for rooms: { roomName: { password, prompt, pool[], timer, admins[], users[], intervalId, logs[] } }
let myRooms = {};

function myLog(roomName, message) {
  const myTimestamp = new Date().toLocaleTimeString();
  const myEntry = `[${myTimestamp}] ${message}`;
  console.log(`[${roomName || 'GLOBAL'}] ${myEntry}`);
  if (roomName && myRooms[roomName]) {
    myRooms[roomName].logs.push(myEntry);
    if (myRooms[roomName].logs.length > 100) myRooms[roomName].logs.shift();
    myRooms[roomName].admins.forEach(myAdmin => {
      myIo.to(myAdmin.id).emit('myServerLog', myEntry);
    });
  }
}

function myResetRoomCountdown(roomName) {
  const myRoom = myRooms[roomName];
  if (!myRoom) return;
  myRoom.countdownReset = true;
  myLog(roomName, `Timer reset.`);
}

function myStartRoomTimer(roomName) {
  const myRoom = myRooms[roomName];
  if (!myRoom || myRoom.intervalId) return;

  let myCountdown = myRoom.timer;
  myIo.to(roomName).emit('myTimerSync', myCountdown);

  myRoom.intervalId = setInterval(() => {
    if (myRoom.countdownReset) {
      myRoom.countdownReset = false;
      myCountdown = myRoom.timer;
    }

    myCountdown--;
    myIo.to(roomName).emit('myTimerSync', myCountdown);

    if (myCountdown <= 0) {
      myCountdown = myRoom.timer;
      myLog(roomName, `Timer reached zero. Requesting local AI summary from admins.`);
      // isAuto: true means it can bypass review if the admin has that setting off
      myIo.to(roomName).emit('myRequestLocalAi', { myPool: myRoom.pool, myPrompt: myRoom.prompt, myIsAuto: true });
    }
  }, 1000);
}

myApp.get('/', (req, res) => {
  res.send(myGenerateHTML());
});

myIo.on('connection', (mySocket) => {
  mySocket.emit('myTopicList', Object.keys(myRooms));

  mySocket.on('myAdminLogin', (myData) => {
    const { myTopic, myPassword, myName, myCustomPrompt, myDuration } = myData;
    const myRoomName = myTopic ? myTopic.trim() : '';

    if (!myRooms[myRoomName]) {
      myRooms[myRoomName] = {
        password: myPassword,
        prompt: myCustomPrompt || 'Summarize these ideas into themes.',
        pool: [],
        timer: parseInt(myDuration) || 240,
        admins: [],
        users: [],
        intervalId: null,
        logs: []
      };
      myIo.emit('myTopicList', Object.keys(myRooms));
    }

    const myRoom = myRooms[myRoomName];
    if (myPassword !== myRoom.password) {
      mySocket.emit('myAuthError', 'Incorrect password.');
      return;
    }

    myRoom.admins.push({ id: mySocket.id, name: myName });
    mySocket.join(myRoomName);
    mySocket.emit('myAdminAuthSuccess', { myTopic: myRoomName, myPrompt: myRoom.prompt, myName });
    myStartRoomTimer(myRoomName);
  });

  mySocket.on('myJoinRoom', (myData) => {
    const { myTopic, myName } = myData;
    if (myRooms[myTopic]) {
      myRooms[myTopic].users.push({ id: mySocket.id, name: myName });
      mySocket.join(myTopic);
      mySocket.emit('myJoinedSuccess', { myTopic, myName });
    }
  });

  mySocket.on('myUserChat', (myData) => {
    const { myRoom, myMsg, myName } = myData;
    if (myRooms[myRoom]) {
      myRooms[myRoom].pool.push(`${myName}: ${myMsg}`);
      myIo.to(myRoom).emit('myPoolUpdate', myRooms[myRoom].pool.length);
      mySocket.emit('myLocalEcho', myMsg);
    }
  });

  mySocket.on('myManualAiTrigger', (myRoomName) => {
    const myRoom = myRooms[myRoomName];
    if (myRoom) {
      myResetRoomCountdown(myRoomName);
      // Manually triggered AI always goes to review box
      mySocket.emit('myRequestLocalAi', { myPool: myRoom.pool, myPrompt: myRoom.prompt, myIsAuto: false });
    }
  });

  mySocket.on('myBroadcastPolishedChat', (myData) => {
    const { myRoom, myText } = myData;
    if (myRooms[myRoom]) {
      myRooms[myRoom].pool = []; // Clear pool after a summary is sent
      myIo.to(myRoom).emit('myFinalAiSummary', myText);
      myIo.to(myRoom).emit('myPoolUpdate', 0);
      myLog(myRoom, "AI Summary broadcasted.");
    }
  });

  mySocket.on('disconnect', () => {
    for (const myRoomName in myRooms) {
      myRooms[myRoomName].admins = myRooms[myRoomName].admins.filter(a => a.id !== mySocket.id);
      myRooms[myRoomName].users = myRooms[myRoomName].users.filter(u => u.id !== mySocket.id);
    }
  });
});

function myGenerateHTML() {
  return `
<!DOCTYPE html>
<html>
<head>
    <title>WebAI Brainstorm Hub</title>
    <meta name="viewport" content="width=device-width, initial-scale=1">
</head>
<body style="font-family:sans-serif; background:#f0f2f5; margin:0; padding:20px;">

  <div id="myAuthUI" style="max-width:400px; margin:auto; background:white; padding:20px; border-radius:8px; box-shadow:0 2px 10px rgba(0,0,0,0.1);">
    <h2>🧠 Brainstorm Login</h2>
    <input id="myNameInp" type="text" placeholder="Your Name" style="width:90%; padding:10px; margin-bottom:10px;"><br>
    <select id="myTopicSelect" style="width:95%; padding:10px; margin-bottom:10px;"></select>
    <button onclick="myJoin()" style="width:100%; padding:10px; background:#28a745; color:white; border:none; border-radius:4px;">Join as User</button>
    <hr>
    <h3>Admin Creation</h3>
    <input id="myRoomInp" type="text" placeholder="Room Name" style="width:90%; padding:10px; margin-bottom:10px;">
    <input id="myPassInp" type="password" placeholder="Room Password" style="width:90%; padding:10px; margin-bottom:10px;">
    <button onclick="myLogin()" style="width:100%; padding:10px; background:#007bff; color:white; border:none; border-radius:4px;">Login/Create Admin</button>
  </div>

  <div id="myMainUI" style="display:none; max-width:800px; margin:auto;">
    <div id="myAdminBar" style="display:none; background:#343a40; color:white; padding:15px; border-radius:8px; margin-bottom:15px;">
      <div style="display:flex; justify-content:space-between;">
        <b>ADMIN DASHBOARD</b>
        <span>Timer: <b id="myTimer">--</b>s</span>
      </div>
      <div style="margin-top:10px;">
        <label><input type="checkbox" id="myReviewToggle" checked> Review AI before sending</label>
        <button onclick="myManualTrigger()" style="margin-left:20px; background:#ffc107; border:none; padding:5px 10px; border-radius:3px; cursor:pointer;">Manual AI Polish</button>
      </div>
      <div id="myReviewBox" style="display:none; margin-top:15px; background:#495057; padding:10px; border-radius:5px;">
        <p style="margin:0 0 5px 0; font-size:0.9em;">Edit AI response before broadcasting:</p>
        <textarea id="myPolishedText" style="width:97%; height:100px; border-radius:4px; padding:5px;"></textarea><br>
        <button onclick="mySendPolished()" style="margin-top:5px; background:#28a745; color:white; border:none; padding:8px 15px; border-radius:4px;">Broadcast Polished Chat</button>
      </div>
    </div>

    <div style="background:white; padding:20px; border-radius:8px; box-shadow:0 2px 10px rgba(0,0,0,0.1);">
      <h3 id="myDisplayRoom">Room</h3>
      <div id="myChatBox" style="height:300px; overflow-y:auto; border:1px solid #ddd; padding:10px; margin-bottom:10px; background:#fafafa;"></div>
      <div style="display:flex;">
        <input id="myMsgInp" type="text" placeholder="Type an idea..." style="flex-grow:1; padding:10px; border:1px solid #ccc; border-radius:4px 0 0 4px;" onkeypress="if(event.key==='Enter') mySendMessage()">
        <button onclick="mySendMessage()" style="padding:10px 20px; background:#007bff; color:white; border:none; border-radius:0 4px 4px 0;">Send 💡</button>
      </div>
      <p style="font-size:0.8em; color:#666;">Ideas in pool: <span id="myPoolCount">0</span></p>
    </div>
  </div>

  <script src="/socket.io/socket.io.js"></script>
  <script>
    const mySocket = io();
    let myCurrentRoom = '';
    let myUserName = '';
    let myIsAdmin = false;
    let myAiSession = null;

    async function myInitAi() {
      if (!window.ai || !window.ai.languageModel) {
        console.error("Chrome Built-in AI (Prompt API) not detected.");
        return;
      }
      try {
        const myCapabilities = await window.ai.languageModel.capabilities();
        if (myCapabilities.available !== 'no') {
          myAiSession = await window.ai.languageModel.create();
        }
      } catch (myErr) {
        console.error("AI Session creation failed", myErr);
      }
    }

    function myLogin() {
      myUserName = document.getElementById('myNameInp').value;
      mySocket.emit('myAdminLogin', {
        myTopic: document.getElementById('myRoomInp').value,
        myPassword: document.getElementById('myPassInp').value,
        myName: myUserName
      });
    }

    function myJoin() {
      myUserName = document.getElementById('myNameInp').value;
      myCurrentRoom = document.getElementById('myTopicSelect').value;
      mySocket.emit('myJoinRoom', { myTopic: myCurrentRoom, myName: myUserName });
    }

    function mySendMessage() {
      const myInp = document.getElementById('myMsgInp');
      if (myInp.value) {
        mySocket.emit('myUserChat', { myRoom: myCurrentRoom, myMsg: myInp.value, myName: myUserName });
        myInp.value = '';
      }
    }

    function myManualTrigger() {
      mySocket.emit('myManualAiTrigger', myCurrentRoom);
    }

    async function myProcessLocalAi(myPool, myPrompt, myIsAuto) {
      if (!myAiSession) {
        alert("Chrome AI session not active. Check chrome://flags");
        return;
      }
      const myFullPrompt = myPrompt + "\\n\\nHere are the ideas:\\n" + myPool.join("\\n");
      
      try {
        const myResult = await myAiSession.prompt(myFullPrompt);
        const myReviewRequired = document.getElementById('myReviewToggle').checked;

        if (!myIsAuto || myReviewRequired) {
          document.getElementById('myReviewBox').style.display = 'block';
          document.getElementById('myPolishedText').value = myResult;
        } else {
          // Automatic send (Timer reached 0 and Review is OFF)
          mySocket.emit('myBroadcastPolishedChat', { myRoom: myCurrentRoom, myText: myResult });
        }
      } catch (myErr) {
        console.error("AI Prompt error", myErr);
      }
    }

    function mySendPolished() {
      const myText = document.getElementById('myPolishedText').value;
      mySocket.emit('myBroadcastPolishedChat', { myRoom: myCurrentRoom, myText: myText });
      document.getElementById('myReviewBox').style.display = 'none';
    }

    // --- Socket Listeners ---
    mySocket.on('myTopicList', (myList) => {
      const mySel = document.getElementById('myTopicSelect');
      mySel.innerHTML = myList.map(t => '<option value="'+t+'">'+t+'</option>').join('');
    });

    mySocket.on('myAdminAuthSuccess', (myData) => {
      myIsAdmin = true;
      myCurrentRoom = myData.myTopic;
      document.getElementById('myAuthUI').style.display = 'none';
      document.getElementById('myMainUI').style.display = 'block';
      document.getElementById('myAdminBar').style.display = 'block';
      document.getElementById('myDisplayRoom').innerText = "Admin: " + myCurrentRoom;
      myInitAi();
    });

    mySocket.on('myJoinedSuccess', (myData) => {
      myCurrentRoom = myData.myTopic;
      document.getElementById('myAuthUI').style.display = 'none';
      document.getElementById('myMainUI').style.display = 'block';
      document.getElementById('myDisplayRoom').innerText = "Room: " + myCurrentRoom;
    });

    mySocket.on('myTimerSync', (myVal) => {
      document.getElementById('myTimer').innerText = myVal;
    });

    mySocket.on('myPoolUpdate', (myCount) => {
      document.getElementById('myPoolCount').innerText = myCount;
    });

    mySocket.on('myRequestLocalAi', (myData) => {
      // Only admins process the AI locally
      if (myIsAdmin && myData.myPool.length > 0) {
        myProcessLocalAi(myData.myPool, myData.myPrompt, myData.myIsAuto);
      }
    });

    mySocket.on('myFinalAiSummary', (myText) => {
      const myBox = document.getElementById('myChatBox');
      myBox.innerHTML += '<div style="background:#e7f3ff; padding:10px; border-radius:5px; margin-bottom:10px; border-left:4px solid #007bff;"><b>✨ AI Summary:</b><br>' + myText.replace(/\\n/g, '<br>') + '</div>';
      myBox.scrollTop = myBox.scrollHeight;
    });

    mySocket.on('myLocalEcho', (myMsg) => {
      const myBox = document.getElementById('myChatBox');
      myBox.innerHTML += '<div style="color:#888; font-size:0.85em; margin-bottom:5px;">✓ You submitted: ' + myMsg + '</div>';
      myBox.scrollTop = myBox.scrollHeight;
    });

    mySocket.on('myAuthError', (myMsg) => alert(myMsg));
  </script>
</body>
</html>
  `;
}

myServer.listen(process.env.PORT || 3000, () => {
  console.log('Server running on port 3000');
});
