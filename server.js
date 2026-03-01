const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const { GoogleGenerativeAI } = require('@google/generative-ai');

const myApp = express();
const myServer = http.createServer(myApp);
const myIo = new Server(myServer);

let myRooms = {}; // { roomName: { apiKey, password, prompt, pool: [], timer: 60, admins: [], users: [] } }

myApp.get('/', (req, res) => {
  res.send(myGenerateHTML());
});

myIo.on('connection', (mySocket) => {
  mySocket.emit('myTopicList', Object.keys(myRooms));

  // ADMIN LOGIN/INITIALIZATION
  mySocket.on('myAdminLogin', (myData) => {
    const { topic, password, key, name, customPrompt, duration } = myData;
    const myRoomName = topic.trim();
    if (!myRoomName || !name) return;

    if (!myRooms[myRoomName]) {
      if (!key || !password) return;
      myRooms[myRoomName] = {
        apiKey: key,
        password: password,
        prompt: customPrompt || "Summarize these brainstorm ideas.",
        pool: [],
        timer: parseInt(duration) || 60,
        admins: [],
        users: []
      };
      myIo.emit('myTopicList', Object.keys(myRooms));
    }

    const myRoom = myRooms[myRoomName];
    if (password === myRoom.password) {
      myRoom.admins.push({ id: mySocket.id, name: name });
      mySocket.join(myRoomName);
      mySocket.emit('myAdminAuthSuccess', { 
        prompt: myRoom.prompt, 
        topic: myRoomName, 
        duration: myRoom.timer, 
        name: name 
      });
      myIo.to(myRoomName).emit('myUserUpdate', myRoom.users);
    }
  });

  // USER JOINING
  mySocket.on('myJoinRoom', (myData) => {
    const { topic, name } = myData;
    if (myRooms[topic] && name) {
      myRooms[topic].users.push({ id: mySocket.id, name: name });
      mySocket.join(topic);
      mySocket.emit('myJoinedSuccess', { topic, name });
      // Notify admins of new user
      myIo.to(topic).emit('myUserUpdate', myRooms[topic].users);
    }
  });

  // CHAT HANDLING
  mySocket.on('myUserChat', (myData) => {
    const { room, msg, name } = myData;
    if (!myRooms[room]) return;
    
    myRooms[room].pool.push(`${name}: ${msg}`);
    mySocket.emit('myLocalEcho', msg);
    
    // Broadcast preview to all admins in the room
    myRooms[room].admins.forEach(admin => {
      myIo.to(admin.id).emit('myAdminPreview', `${name}: ${msg}`);
      myIo.to(admin.id).emit('myPoolUpdate', myRooms[room].pool.length);
    });
  });

  // ADMIN ACTIONS
  mySocket.on('myAdminUpdateSettings', (myData) => {
    const myRoom = myRooms[myData.room];
    if (myRoom && myRoom.admins.some(a => a.id === mySocket.id)) {
      myRoom.prompt = myData.prompt;
      myRoom.timer = parseInt(myData.duration);
    }
  });

  mySocket.on('myManualTrigger', async (myRoomName) => {
    await myHandleAISummary(myRoomName);
  });

  mySocket.on('myBanishUser', (myData) => {
    const myRoom = myRooms[myData.room];
    if (myRoom && myRoom.admins.some(a => a.id === mySocket.id)) {
      myIo.to(myData.targetId).emit('myForcedExit', "You have been removed by an admin.");
      myRoom.users = myRoom.users.filter(u => u.id !== myData.targetId);
      myIo.to(myData.room).emit('myUserUpdate', myRoom.users);
    }
  });

  mySocket.on('myShutdownRoom', (myRoomName) => {
    const myRoom = myRooms[myRoomName];
    if (myRoom && myRoom.admins.some(a => a.id === mySocket.id)) {
      myIo.to(myRoomName).emit('myForcedExit', "The session has been ended by an admin.");
      delete myRooms[myRoomName];
      myIo.emit('myTopicList', Object.keys(myRooms));
    }
  });

  mySocket.on('disconnect', () => {
    // Cleanup admin/user lists on disconnect if needed
  });
});

async function myHandleAISummary(myRoomName) {
  const myRoom = myRooms[myRoomName];
  if (!myRoom || myRoom.pool.length === 0) return;

  try {
    const myGenAI = new GoogleGenerativeAI(myRoom.apiKey);
    const myModel = myGenAI.getGenerativeModel({ model: "gemini-2.0-flash" });
    const myInput = `System Prompt: ${myRoom.prompt}\n\nBrainstorm Data:\n${myRoom.pool.join('\n')}`;

    const myResult = await myModel.generateContent(myInput);
    const myText = myResult.response.text();
    
    myRoom.pool = []; 
    myIo.to(myRoomName).emit('myBroadcastSummary', myText);
    myRoom.admins.forEach(admin => myIo.to(admin.id).emit('myPoolUpdate', 0));
  } catch (err) {
    myRoom.admins.forEach(admin => myIo.to(admin.id).emit('myAiStatus', "AI Error: " + err.message));
  }
}

function myGenerateHTML() {
  return `
  <!DOCTYPE html>
  <html>
  <head><title>Admin Controlled AI Hub</title><meta name="viewport" content="width=device-width, initial-scale=1"></head>
  <body style="font-family:sans-serif; margin:0; padding:20px; background:#f0f2f5;">
    <div style="max-width:900px; margin:auto; background:white; padding:20px; border-radius:10px; box-shadow:0 4px 10px rgba(0,0,0,0.1);">
      
      <h2 id="myRoomTitle" style="text-align:center; color:#1a73e8;">Brainstorm Hub</h2>

      <div id="myAuthPanel" style="background:#fff3e0; padding:20px; border-radius:8px; margin-bottom:20px; border:1px solid #ffe0b2;">
        <input id="myName" type="text" placeholder="Your Name" style="padding:10px; width:150px; margin-bottom:10px;"><br>
        <select id="myTopicDropdown" style="padding:10px; width:200px;"></select> 
        <button onclick="myJoin()" style="padding:10px;">Join as User</button>
        <hr>
        <b>Create/Admin Login</b><br>
        <input id="myPass" type="password" placeholder="Room Password" style="padding:8px; width:120px;">
        <input id="myKey" type="password" placeholder="Gemini API Key (New Only)" style="padding:8px; width:150px;">
        <input id="myTop" type="text" placeholder="Room Name" style="padding:8px; width:120px;">
        <button onclick="myLogin()" style="padding:10px; background:#e65100; color:white; border:none; cursor:pointer;">Admin Login</button>
      </div>

      <div id="myAdminDashboard" style="display:none; background:#e8f0fe; padding:20px; border-radius:8px; margin-bottom:20px; border:1px solid #d2e3fc;">
        <div style="display:flex; justify-content:space-between;">
            <b>ADMIN: <span id="myAdminName"></span></b>
            <b style="color:#d32f2f;">Auto-Sync: <span id="myAutoTimer">--</span>s</b>
        </div>
        <div style="margin-top:10px;">
            <label>System Prompt:</label><br>
            <input id="myActivePrompt" type="text" style="width:75%; padding:8px;" onchange="myAdminUpdate()">
            <button onclick="myForceAI()" style="background:#1a73e8; color:white; border:none; padding:8px; cursor:pointer;">SEND NOW</button>
        </div>
        <div style="display:flex; gap:20px; margin-top:15px;">
            <div style="flex:1;">
                <b>Live Feed:</b>
                <div id="myAdminFeed" style="height:100px; overflow-y:auto; background:white; border:1px solid #ccc; font-size:0.8em; padding:5px;"></div>
            </div>
            <div style="width:150px;">
                <b>Users:</b>
                <div id="myUserList" style="height:100px; overflow-y:auto; background:white; border:1px solid #ccc; font-size:0.8em; padding:5px;"></div>
            </div>
        </div>
        <button onclick="myKillRoom()" style="margin-top:10px; background:red; color:white; border:none; padding:5px; cursor:pointer; font-size:0.7em;">SHUTDOWN CONVERSATION</button>
      </div>

      <div id="myChatBox" style="height:350px; overflow-y:auto; border:1px solid #ddd; padding:15px; background:#fafafa; border-radius:8px; margin-bottom:10px;"></div>
      
      <div id="myInputArea" style="display:none; gap:10px;">
        <input id="myMsg" type="text" style="flex-grow:1; padding:12px; border:1px solid #ccc; border-radius:5px;" placeholder="Type your idea..." onkeypress="if(event.key==='Enter') mySend()">
        <button onclick="mySend()" style="padding:12px 20px; background:#34a853; color:white; border:none; border-radius:5px; cursor:pointer;">Send</button>
      </div>
    </div>

    <script src="/socket.io/socket.io.js"></script>
    <script>
      const mySocket = io();
      let myCurrentRoom = null;
      let myName = "";
      let myTimerVal = 60;
      let myCounter = 60;

      mySocket.on('myTopicList', (list) => {
        const myDrop = document.getElementById('myTopicDropdown');
        myDrop.innerHTML = '<option value="">-- Select Room --</option>';
        list.forEach(t => { myDrop.innerHTML += '<option value="'+t+'">'+t+'</option>'; });
      });

      function myLogin() {
        myName = document.getElementById('myName').value;
        if(!myName) return alert("Enter your name");
        mySocket.emit('myAdminLogin', {
          password: document.getElementById('myPass').value,
          key: document.getElementById('myKey').value,
          topic: document.getElementById('myTop').value || document.getElementById('myTopicDropdown').value,
          name: myName,
          duration: 60
        });
      }

      function myJoin() {
        myName = document.getElementById('myName').value;
        const t = document.getElementById('myTopicDropdown').value;
        if(myName && t) mySocket.emit('myJoinRoom', { topic: t, name: myName });
        else alert("Enter name and select room");
      }

      mySocket.on('myAdminAuthSuccess', (data) => {
        myCurrentRoom = data.topic;
        myTimerVal = data.duration;
        document.getElementById('myAuthPanel').style.display = 'none';
        document.getElementById('myAdminDashboard').style.display = 'block';
        document.getElementById('myInputArea').style.display = 'flex';
        document.getElementById('myActivePrompt').value = data.prompt;
        document.getElementById('myAdminName').innerText = data.name;
        document.getElementById('myRoomTitle').innerText = "Admin: " + myCurrentRoom;
        myStartTimer();
      });

      mySocket.on('myJoinedSuccess', (data) => {
        myCurrentRoom = data.topic;
        document.getElementById('myAuthPanel').style.display = 'none';
        document.getElementById('myInputArea').style.display = 'flex';
        document.getElementById('myRoomTitle').innerText = "Brainstorming: " + data.topic;
      });

      function myStartTimer() {
        setInterval(() => {
          myCounter--;
          document.getElementById('myAutoTimer').innerText = myCounter;
          if(myCounter <= 0) {
            mySocket.emit('myAutoTrigger', myCurrentRoom);
            myCounter = myTimerVal;
          }
        }, 1000);
      }

      function myAdminUpdate() {
        mySocket.emit('myAdminUpdateSettings', {
          room: myCurrentRoom,
          prompt: document.getElementById('myActivePrompt').value,
          duration: myTimerVal
        });
      }

      function myForceAI() { 
        mySocket.emit('myManualTrigger', myCurrentRoom); 
        myCounter = myTimerVal;
      }

      function myKillRoom() { if(confirm("End this chat for everyone?")) mySocket.emit('myShutdownRoom', myCurrentRoom); }

      mySocket.on('myUserUpdate', (users) => {
        const myUl = document.getElementById('myUserList');
        if(!myUl) return;
        myUl.innerHTML = "";
        users.forEach(u => {
          myUl.innerHTML += \`<div>\${u.name} <button onclick="myKick('\${u.id}')" style="font-size:0.6em;">X</button></div>\`;
        });
      });

      window.myKick = (id) => { mySocket.emit('myBanishUser', { room: myCurrentRoom, targetId: id }); };

      mySocket.on('myForcedExit', (msg) => { alert(msg); location.reload(); });

      mySocket.on('myBroadcastSummary', (txt) => {
        document.getElementById('myChatBox').innerHTML += '<div style="background:#e8f0fe; padding:15px; border-left:5px solid #1a73e8; margin:10px 0;"><b>✨ AI SUMMARY:</b><br>'+txt.replace(/\\n/g,'<br>')+'</div>';
      });

      mySocket.on('myLocalEcho', (m) => {
        document.getElementById('myChatBox').innerHTML += '<div style="color:#aaa; font-size:0.8em; margin:5px 0;">(Idea sent privately)</div>';
      });

      mySocket.on('myAdminPreview', (m) => {
        document.getElementById('myAdminFeed').innerHTML += '<div>• '+m+'</div>';
      });

      function mySend() {
        const myIn = document.getElementById('myMsg');
        if(myIn.value.trim()){ 
          mySocket.emit('myUserChat', { room: myCurrentRoom, msg: myIn.value, name: myName }); 
          myIn.value = ''; 
        }
      }
    </script>
  </body>
  </html>
  `;
}

myServer.listen(process.env.PORT || 3000);
