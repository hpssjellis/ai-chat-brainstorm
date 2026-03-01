const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const { GoogleGenerativeAI } = require('@google/generative-ai');

const myApp = express();
const myServer = http.createServer(myApp);
const myIo = new Server(myServer);

// Data structure to hold multiple sessions
// { "TopicName": { apiKey, password, prompt, pool: [], timer: 60, adminId: null } }
let myRooms = {};

myApp.get('/', (req, res) => {
  res.send(myGenerateHTML());
});

myIo.on('connection', (mySocket) => {
  // Send list of active topics to the newcomer
  mySocket.emit('myTopicList', Object.keys(myRooms));

  mySocket.on('myAdminLogin', (myData) => {
    const myRoomName = myData.topic.trim();
    if (!myRoomName) return;

    // Create room if it doesn't exist (Initial Setup)
    if (!myRooms[myRoomName]) {
      if (!myData.key || !myData.password) return;
      myRooms[myRoomName] = {
        apiKey: myData.key,
        password: myData.password,
        prompt: myData.customPrompt || "Summarize these ideas.",
        pool: [],
        timer: parseInt(myData.duration) || 60,
        adminId: mySocket.id
      };
      myIo.emit('myTopicList', Object.keys(myRooms)); // Update everyone's dropdown
    } 
    
    // Auth Check
    const myCurrentRoom = myRooms[myRoomName];
    if (myData.password === myCurrentRoom.password) {
      myCurrentRoom.adminId = mySocket.id;
      mySocket.join(myRoomName);
      mySocket.emit('myAdminAuthSuccess', { 
        prompt: myCurrentRoom.prompt, 
        topic: myRoomName,
        duration: myCurrentRoom.timer 
      });
    }
  });

  // User Joins as a regular participant
  mySocket.on('myJoinRoom', (myRoomName) => {
    if (myRooms[myRoomName]) {
      mySocket.join(myRoomName);
      mySocket.emit('myJoinedSuccess', myRoomName);
    }
  });

  mySocket.on('myUserChat', (myData) => {
    const { room, msg } = myData;
    if (!myRooms[room] || !msg.trim()) return;
    
    myRooms[room].pool.push(msg);
    mySocket.emit('myLocalEcho', msg);
    
    // Only send preview to that room's admin
    myIo.to(myRooms[room].adminId).emit('myAdminPreview', msg);
    myIo.to(myRooms[room].adminId).emit('myPoolUpdate', myRooms[room].pool.length);
  });

  mySocket.on('myAdminUpdateSettings', (myData) => {
    const myRoom = myRooms[myData.room];
    if (myRoom && mySocket.id === myRoom.adminId) {
      myRoom.prompt = myData.prompt;
      myRoom.timer = parseInt(myData.duration);
    }
  });

  mySocket.on('myAutoTrigger', async (myRoomName) => {
    const myRoom = myRooms[myRoomName];
    if (myRoom && mySocket.id === myRoom.adminId) {
      await myHandleAISummary(myRoomName);
    }
  });
});

async function myHandleAISummary(myRoomName) {
  const myRoom = myRooms[myRoomName];
  if (!myRoom || myRoom.pool.length === 0) return;

  try {
    const myGenAI = new GoogleGenerativeAI(myRoom.apiKey);
    const myModel = myGenAI.getGenerativeModel({ model: "gemini-2.0-flash" });
    const myInput = `Instruction: ${myRoom.prompt}\n\nIdeas:\n${myRoom.pool.join('\n')}`;

    const myResult = await myModel.generateContent(myInput);
    const myText = myResult.response.text();
    
    myRoom.pool = []; 
    myIo.to(myRoomName).emit('myBroadcastSummary', myText);
    myIo.to(myRoom.adminId).emit('myPoolUpdate', 0);
  } catch (err) {
    myIo.to(myRoom.adminId).emit('myAiStatus', "AI Error: " + err.message);
  }
}

function myGenerateHTML() {
  return `
  <!DOCTYPE html>
  <html>
  <head><title>Multi-Room AI Brainstorm</title><meta name="viewport" content="width=device-width, initial-scale=1"></head>
  <body style="font-family:sans-serif; margin:0; padding:20px; background:#f0f2f5;">
    <div style="max-width:850px; margin:auto; background:white; padding:20px; border-radius:10px; box-shadow:0 4px 10px rgba(0,0,0,0.1);">
      
      <h2 id="myRoomTitle" style="text-align:center; color:#1a73e8;">Select or Create a Brainstorm</h2>

      <div id="myAuthPanel" style="background:#fff3e0; padding:15px; border-radius:8px; margin-bottom:20px;">
        <div id="myAuthContent">
          <h4>Join / Create Session</h4>
          <select id="myTopicDropdown" style="padding:8px; width:200px; margin-bottom:10px;">
             <option value="">-- Select Active Topic --</option>
          </select> 
          <button onclick="myJoin()" style="padding:8px;">Join as User</button>
          <hr>
          <input id="myPass" type="password" placeholder="Password" style="padding:8px; width:100px;">
          <input id="myKey" type="password" placeholder="API Key" style="padding:8px; width:130px;">
          <input id="myTop" type="text" placeholder="New Topic Name" style="padding:8px; width:130px;">
          <input id="myDur" type="number" placeholder="Timer (s)" value="60" style="padding:8px; width:60px;">
          <button onclick="myLogin()" style="padding:8px; background:#e65100; color:white; border:none; cursor:pointer;">Admin Login</button>
        </div>
      </div>

      <div id="myAdminDashboard" style="display:none; background:#e8f0fe; padding:15px; border-radius:8px; margin-bottom:20px;">
        <div style="display:flex; justify-content:space-between;">
            <b>ADMIN: <span id="myActiveRoomName"></span></b>
            <b style="color:#d32f2f;">Sync In: <span id="myAutoTimer">--</span>s</b>
        </div>
        <input id="myActivePrompt" type="text" style="width:70%; padding:5px; margin-top:10px;" onchange="myAdminUpdate()">
        <input id="myActiveDur" type="number" style="width:50px; padding:5px;" onchange="myAdminUpdate()">
        <span id="myPoolCount" style="font-weight:bold; margin-left:10px;">Pool: 0</span>
        <div id="myAdminFeed" style="height:80px; overflow-y:auto; background:white; padding:5px; border:1px solid #ccc; margin-top:10px; font-size:0.8em;"></div>
      </div>

      <div id="myChatBox" style="height:350px; overflow-y:auto; border:1px solid #ddd; padding:15px; background:#fafafa; border-radius:8px; margin-bottom:10px;"></div>
      
      <div id="myInputArea" style="display:none; gap:10px;">
        <input id="myMsg" type="text" style="flex-grow:1; padding:12px; border:1px solid #ccc; border-radius:5px;" placeholder="Type your secret idea..." onkeypress="if(event.key==='Enter') mySend()">
        <button onclick="mySend()" style="padding:12px 20px; background:#34a853; color:white; border:none; border-radius:5px; cursor:pointer;">Send</button>
      </div>
    </div>

    <script src="/socket.io/socket.io.js"></script>
    <script>
      const mySocket = io();
      let myCurrentRoom = null;
      let myTimerVal = 60;
      let myInterval = null;

      mySocket.on('myTopicList', (list) => {
        const myDrop = document.getElementById('myTopicDropdown');
        myDrop.innerHTML = '<option value="">-- Select Active Topic --</option>';
        list.forEach(t => { myDrop.innerHTML += '<option value="'+t+'">'+t+'</option>'; });
      });

      function myLogin() {
        mySocket.emit('myAdminLogin', {
          password: document.getElementById('myPass').value,
          key: document.getElementById('myKey').value,
          topic: document.getElementById('myTop').value || document.getElementById('myTopicDropdown').value,
          duration: document.getElementById('myDur').value
        });
      }

      function myJoin() {
        const t = document.getElementById('myTopicDropdown').value;
        if(t) mySocket.emit('myJoinRoom', t);
      }

      mySocket.on('myAdminAuthSuccess', (data) => {
        myCurrentRoom = data.topic;
        myTimerVal = data.duration;
        document.getElementById('myAuthPanel').style.display = 'none';
        document.getElementById('myAdminDashboard').style.display = 'block';
        document.getElementById('myInputArea').style.display = 'flex';
        document.getElementById('myActivePrompt').value = data.prompt;
        document.getElementById('myActiveDur').value = data.duration;
        document.getElementById('myActiveRoomName').innerText = myCurrentRoom;
        myStartTimer();
      });

      mySocket.on('myJoinedSuccess', (room) => {
        myCurrentRoom = room;
        document.getElementById('myAuthPanel').style.display = 'none';
        document.getElementById('myInputArea').style.display = 'flex';
        document.getElementById('myRoomTitle').innerText = "Brainstorm: " + room;
      });

      function myAdminUpdate() {
        myTimerVal = document.getElementById('myActiveDur').value;
        mySocket.emit('myAdminUpdateSettings', {
          room: myCurrentRoom,
          prompt: document.getElementById('myActivePrompt').value,
          duration: myTimerVal
        });
      }

      function myStartTimer() {
        if(myInterval) clearInterval(myInterval);
        let myCounter = myTimerVal;
        myInterval = setInterval(() => {
          myCounter--;
          document.getElementById('myAutoTimer').innerText = myCounter;
          if(myCounter <= 0) {
            mySocket.emit('myAutoTrigger', myCurrentRoom);
            myCounter = myTimerVal;
          }
        }, 1000);
      }

      mySocket.on('myBroadcastSummary', (txt) => {
        document.getElementById('myChatBox').innerHTML += '<div style="background:#e8f0fe; padding:15px; border-left:5px solid #1a73e8; margin:10px 0;"><b>✨ SUMMARY:</b><br>'+txt.replace(/\\n/g,'<br>')+'</div>';
      });

      mySocket.on('myLocalEcho', (m) => {
        document.getElementById('myChatBox').innerHTML += '<div style="color:#aaa; font-size:0.8em;">(Secret idea logged)</div>';
      });

      mySocket.on('myAdminPreview', (m) => {
        document.getElementById('myAdminFeed').innerHTML += '<div>• '+m+'</div>';
      });

      mySocket.on('myPoolUpdate', (c) => { document.getElementById('myPoolCount').innerText = "Pool: " + c; });

      function mySend() {
        const myIn = document.getElementById('myMsg');
        if(myIn.value.trim()){ 
          mySocket.emit('myUserChat', { room: myCurrentRoom, msg: myIn.value }); 
          myIn.value = ''; 
        }
      }
    </script>
  </body>
  </html>
  `;
}

myServer.listen(process.env.PORT || 3000);
