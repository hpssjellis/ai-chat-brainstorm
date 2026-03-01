const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const { GoogleGenerativeAI } = require('@google/generative-ai');

const myApp = express();
const myServer = http.createServer(myApp);
const myIo = new Server(myServer);

// App State
let myAdminId = null;
let myApiKey = null;
let mySessionPassword = null;
let myTopic = "Waiting for Admin...";
let myMessagePool = [];
let myIsProcessing = false;

myApp.get('/', (req, res) => {
  res.send(myGenerateHTML());
});

myIo.on('connection', (mySocket) => {
  mySocket.emit('myUpdateTopic', myTopic);

  // ADMIN LOGIN
  mySocket.on('myAdminLogin', (myData) => {
    if (!mySessionPassword && myData.password && myData.key) {
      myApiKey = myData.key;
      mySessionPassword = myData.password;
      myTopic = myData.topic || "General Brainstorm";
      myAdminId = mySocket.id;
      myIo.emit('myUpdateTopic', myTopic);
      mySocket.emit('myAdminAuthSuccess', true);
    } else if (mySessionPassword && myData.password === mySessionPassword) {
      myAdminId = mySocket.id;
      mySocket.emit('myAdminAuthSuccess', true);
    }
  });

  // USER CHAT - Secret from other users
  mySocket.on('myUserChat', (myMsg) => {
    if (!myMsg.trim()) return;
    myMessagePool.push(myMsg);
    
    // Only show to the sender and the admin
    mySocket.emit('myLocalEcho', myMsg); 
    if (myAdminId) {
      myIo.to(myAdminId).emit('myAdminPreview', myMsg);
      myIo.to(myAdminId).emit('myPoolUpdate', myMessagePool.length);
    }
  });

  mySocket.on('myTriggerSummary', async () => {
    if (mySocket.id !== myAdminId || myIsProcessing) return;
    await myHandleAISummary();
  });
});

async function myHandleAISummary() {
  if (myMessagePool.length === 0) return;
  myIsProcessing = true;
  myIo.emit('myAiStatus', "Gemini is analyzing secret ideas...");

  try {
    const myGenAI = new GoogleGenerativeAI(myApiKey);
    // Updated to 2.0 Flash for 2026 compatibility
    const myModel = myGenAI.getGenerativeModel({ model: "gemini-2.0-flash" });
    
    const myPrompt = `Summarize these private brainstorm ideas into a professional list for the topic: ${myTopic}. Focus on clarity.`;
    const myFullInput = `${myPrompt}\n\nIDEAS:\n${myMessagePool.join('\n')}`;

    const myResult = await myModel.generateContent(myFullInput);
    const myText = myResult.response.text();
    
    myMessagePool = []; // Clear the secret pool
    myIo.emit('myPoolUpdate', 0);
    myIo.emit('myBroadcastSummary', myText);
  } catch (err) {
    if (myAdminId) myIo.to(myAdminId).emit('myAiStatus', "AI Error: " + err.message);
  }
  myIsProcessing = false;
  myIo.emit('myAiStatus', "");
}

function myGenerateHTML() {
  return `
  <!DOCTYPE html>
  <html>
  <head><title>Blind AI Brainstorm</title><meta name="viewport" content="width=device-width, initial-scale=1"></head>
  <body style="font-family:sans-serif; margin:0; padding:20px; background:#f0f2f5;">
    <div style="max-width:800px; margin:auto; background:white; padding:20px; border-radius:10px; box-shadow:0 4px 10px rgba(0,0,0,0.1);">
      
      <h2 id="myTopicDisplay" style="text-align:center; color:#1a73e8;">Connecting...</h2>

      <div id="myAuthPanel" style="background:#fff3e0; padding:15px; border-radius:8px; margin-bottom:20px; border:1px solid #ffe0b2;">
        <div id="myAuthContent">
          <h4 style="margin:0 0 10px 0;">Admin Entrance (Closes in <span id="myTimerSeconds">60</span>s)</h4>
          <input id="myPass" type="password" placeholder="Password" style="padding:8px; width:100px;">
          <input id="myKey" type="password" placeholder="API Key" style="padding:8px; width:150px;">
          <input id="myTop" type="text" placeholder="Topic" style="padding:8px; width:100px;">
          <button onclick="myLogin()" style="padding:8px; background:#e65100; color:white; border:none; cursor:pointer;">Login</button>
          <div style="font-size:0.7em; margin-top:5px;"><a href="https://aistudio.google.com/" target="_blank">Get API Key Here</a></div>
        </div>
      </div>

      <div id="myAdminDashboard" style="display:none; background:#e8f0fe; padding:15px; border-radius:8px; margin-bottom:20px; border:1px solid #d2e3fc;">
        <b>ADMIN GOD-VIEW</b> | <span id="myPoolCount">Pending: 0</span><br><br>
        <button onclick="myTrigger()" style="background:#1a73e8; color:white; border:none; padding:10px; border-radius:4px; cursor:pointer; font-weight:bold;">PUBLISH AI SUMMARY</button>
        <div id="myAdminFeed" style="height:100px; overflow-y:auto; background:white; padding:5px; border:1px solid #ccc; margin-top:10px; font-size:0.8em;"></div>
      </div>

      <div id="myChatBox" style="height:350px; overflow-y:auto; border:1px solid #ddd; padding:15px; background:#fafafa; border-radius:8px; margin-bottom:10px;">
        <div style="color:#888; text-align:center; font-style:italic;">User ideas are hidden. Only AI summaries will appear here.</div>
      </div>
      
      <div id="myAiStatus" style="height:20px; color:#1a73e8; margin-bottom:10px;"></div>

      <div style="display:flex; gap:10px;">
        <input id="myMsg" type="text" style="flex-grow:1; padding:12px; border:1px solid #ccc; border-radius:5px;" placeholder="Type your secret idea..." onkeypress="if(event.key==='Enter') mySend()">
        <button onclick="mySend()" style="padding:12px 20px; background:#34a853; color:white; border:none; border-radius:5px; cursor:pointer;">Send</button>
      </div>
    </div>

    <script src="/socket.io/socket.io.js"></script>
    <script>
      const mySocket = io();

      // 1-Minute Admin Security
      let mySecondsLeft = 60;
      const myTimerInterval = setInterval(() => {
        mySecondsLeft--;
        document.getElementById('myTimerSeconds').innerText = mySecondsLeft;
        if(mySecondsLeft <= 0) {
          clearInterval(myTimerInterval);
          document.getElementById('myAuthPanel').innerHTML = "<div style='color:#666; font-size:0.8em;'>Admin login window has expired for this session.</div>";
        }
      }, 1000);

      function myLogin() {
        mySocket.emit('myAdminLogin', {
          password: document.getElementById('myPass').value,
          key: document.getElementById('myKey').value,
          topic: document.getElementById('myTop').value
        });
      }

      mySocket.on('myAdminAuthSuccess', () => {
        document.getElementById('myAuthPanel').style.display = 'none';
        document.getElementById('myAdminDashboard').style.display = 'block';
        clearInterval(myTimerInterval);
      });

      mySocket.on('myUpdateTopic', (t) => { document.getElementById('myTopicDisplay').innerText = t; });
      mySocket.on('myAiStatus', (s) => { document.getElementById('myAiStatus').innerText = s; });
      mySocket.on('myPoolUpdate', (c) => { document.getElementById('myPoolCount').innerText = "Pending: " + c; });

      // Local Echo: Only YOU see what you typed
      mySocket.on('myLocalEcho', (m) => {
        const myDiv = document.getElementById('myChatBox');
        myDiv.innerHTML += '<div style="color:#aaa; font-size:0.8em; margin:5px 0;">(Your idea submitted privately)</div>';
        myDiv.scrollTop = myDiv.scrollHeight;
      });

      mySocket.on('myAdminPreview', (m) => {
        const myFeed = document.getElementById('myAdminFeed');
        myFeed.innerHTML += '<div>• ' + m + '</div>';
        myFeed.scrollTop = myFeed.scrollHeight;
      });

      mySocket.on('myBroadcastSummary', (txt) => {
        const myDiv = document.getElementById('myChatBox');
        myDiv.innerHTML += '<div style="background:#e8f0fe; padding:15px; border-left:5px solid #1a73e8; border-radius:5px; margin:15px 0;"><b>✨ AI SUMMARY:</b><br>' + txt.replace(/\\n/g, '<br>') + '</div>';
        myDiv.scrollTop = myDiv.scrollHeight;
      });

      function mySend() {
        const myIn = document.getElementById('myMsg');
        if(myIn.value.trim()){ mySocket.emit('myUserChat', myIn.value); myIn.value = ''; }
      }

      function myTrigger() { mySocket.emit('myTriggerSummary'); }
    </script>
  </body>
  </html>
  `;
}

myServer.listen(process.env.PORT || 3000);
